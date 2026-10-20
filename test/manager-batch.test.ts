import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import type { DeliveryPort } from "../src/delivery.ts";
import { SubagentManager } from "../src/manager.ts";
import { Registry, type SubagentRecord } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";

const reviewer: AgentDef = { name: "reviewer", description: "r", systemPrompt: "Review.", source: "user", filePath: "/a/reviewer.md" };
const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });
const err = (message: string): ChildResult => ({ text: "", stopReason: "error", errorMessage: message, usage: usage(0) });
const items = [{ agent: "reviewer", task: "one" }, { agent: "reviewer", task: "two" }];
// A second agent wired to the rpc runner, which this setup leaves unregistered, so validating it fails.
const rpcOnly: AgentDef = { name: "rpc-only", description: "r", systemPrompt: "R.", source: "user", filePath: "/a/rpc.md", runner: "rpc" };

function setup(
  opts: {
    scripts?: ChildResult[][];
    hold?: boolean;
    limit?: number;
    contextWindow?: number;
    settings?: Partial<SubagentSettings>;
    extraAgents?: AgentDef[];
    /** FakeRunner.open rejects when the resolved child cwd equals this path (regression injection for open failures). */
    openFailsForCwd?: string;
    port?: DeliveryPort;
    onDeliveryError?: (record: SubagentRecord, message: string) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "batch-"));
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    if (opts.openFailsForCwd && spec.cwd === opts.openFailsForCwd) throw new Error(`runner.open failed for cwd ${spec.cwd}`);
    return new FakeSession(spec.resumeFile ?? join(root, `child-${n}.jsonl`), scripts[n] ?? [], opts.hold ?? false);
  });
  const sent: Parameters<DeliveryPort["sendMessage"]>[] = [];
  const manager = new SubagentManager({
    registry: new Registry(() => {}),
    chainStore: new ChainStore(() => {}),
    scheduler: new Scheduler(() => opts.limit ?? 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([["reviewer", reviewer], ...(opts.extraAgents ?? []).map((a) => [a.name, a] as const)]),
    settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings }),
    port: opts.port ?? { sendMessage: (...args) => sent.push(args), appendEntry: () => {} },
    receiverContextWindow: () => opts.contextWindow ?? 200000,
    cwd: root,
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
    ...(opts.onDeliveryError ? { onDeliveryError: opts.onDeliveryError } : {}),
  });
  return { manager, runner, sent, root };
}

describe("parallel", () => {
  it("runs every task and returns one summary with the handle of each", async () => {
    const { manager, runner } = setup({ scripts: [[ok("first done")], [ok("second done")]] });
    const out = await manager.runParallel({ items });
    expect(runner.opened).toHaveLength(2);
    expect(out.records.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(out.records.map((r) => r.handle)).toEqual(["reviewer", "reviewer-2"]);
    expect(out.payload!.text).toContain("Parallel: 2/2 succeeded");
    expect(out.payload!.text).toContain("### [@reviewer] (reviewer) completed");
    expect(out.payload!.text).toContain("first done");
    expect(out.payload!.text).toContain("second done");
  });

  it("respects the global concurrency limit", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true, scripts: [[ok("a")], [ok("b")]] });
    const pending = manager.runParallel({ items });
    await expect.poll(() => manager.list().map((r) => r.status).sort()).toEqual(["queued", "running"]);
    expect(runner.opened).toHaveLength(1);
    runner.sessions[0]!.finish();
    // The next task only opens its session once the first released its slot.
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    expect((await pending).records.map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("keeps going after a failure and reports it", async () => {
    const { manager } = setup({ scripts: [[err("rate limited")], [ok("fine")]] });
    const out = await manager.runParallel({ items });
    expect(out.payload!.text).toContain("Parallel: 1/2 succeeded");
    expect(out.payload!.text).toContain("failed: rate limited");
    expect(out.payload!.text).toContain("fine");
  });

  it("moves every item to a file when the whole batch is too large, and keeps small ones inline", async () => {
    const big = "z".repeat(4000);
    const large = await setup({ scripts: [[ok(big)], [ok(big)]], contextWindow: 1000 }).manager.runParallel({ items });
    expect(large.payload!.text).not.toContain(big);
    expect(large.payload!.text.match(/Full output: /g) ?? []).toHaveLength(2);
    const small = await setup({ scripts: [[ok("small one")], [ok("small two")]] }).manager.runParallel({ items });
    expect(small.payload!.text).toContain("small one");
    expect(small.payload!.text).not.toContain("Full output:");
  });

  it("background parallel delivers exactly one summary", async () => {
    const { manager, sent } = setup({ scripts: [[ok("a")], [ok("b")]] });
    const out = await manager.runParallel({ items, background: true });
    expect(out.records).toHaveLength(2);
    expect(sent).toHaveLength(0);
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].customType).toBe("pi-subagents/batch");
    expect(sent[0]![1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(sent[0]![0].content).toContain("Parallel: 2/2 succeeded");
  });

  it("background parallel does not deliver when everything was paused", async () => {
    const { manager, runner, sent } = setup({ hold: true, scripts: [[ok("a")], [ok("b")]] });
    const out = await manager.runParallel({ items, background: true });
    expect(out.records).toHaveLength(2);
    await expect.poll(() => runner.sessions.filter((s) => s.prompts.length > 0)).toHaveLength(2);
    await manager.interrupt("reviewer");
    await manager.interrupt("reviewer-2");
    await manager.whenIdle();
    // The records returned at start time are queued snapshots; the registry holds the final status.
    expect(manager.list().map((r) => r.status)).toEqual(["paused", "paused"]);
    expect(sent).toHaveLength(0);
  });

  it("rejects too many tasks, a disabled parallel and an unknown agent without creating records", async () => {
    await expect(setup({ settings: { maxParallelTasks: 1 } }).manager.runParallel({ items })).rejects.toThrow(/max is 1/);
    await expect(setup({ settings: { maxParallelTasks: 0 } }).manager.runParallel({ items })).rejects.toThrow(/disabled/);
    const { manager } = setup();
    await expect(manager.runParallel({ items: [{ agent: "nope", task: "x" }] })).rejects.toMatchObject({ code: "unknown_agent" });
    expect(manager.list()).toHaveLength(0);
  });

  it("allows a batch exactly at the limit (8) and rejects one more", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ agent: "reviewer", task: `t${i}` }));
    const { manager, runner } = setup({ settings: { maxParallelTasks: 8 }, scripts: eight.map((_, i) => [ok(`r${i}`)]) });
    const out = await manager.runParallel({ items: eight });
    expect(runner.opened).toHaveLength(8);
    expect(out.records.map((r) => r.status)).toEqual(Array.from({ length: 8 }, () => "completed"));
    const nine = [...eight, { agent: "reviewer", task: "t8" }];
    await expect(setup({ settings: { maxParallelTasks: 8 } }).manager.runParallel({ items: nine })).rejects.toThrow(/max is 8/);
  });

  it("allows a single task when the limit is 1 and rejects two", async () => {
    const { manager } = setup({ settings: { maxParallelTasks: 1 }, scripts: [[ok("only")]] });
    const out = await manager.runParallel({ items: [items[0]!] });
    expect(out.records.map((r) => r.status)).toEqual(["completed"]);
    await expect(setup({ settings: { maxParallelTasks: 1 } }).manager.runParallel({ items })).rejects.toThrow(/max is 1/);
  });

  it("moves the whole group to files when only the total is too large", async () => {
    // Each item is under the 30% limit on its own (251 <= 300 at a 1000-token window), so neither moves to a file first;
    // the group summary then exceeds the threshold and takes the group-level fallback for both items.
    const chunk = "z".repeat(1000);
    const { manager } = setup({
      scripts: [[ok(`one ${chunk}\n<summary>short one</summary>`)], [ok(`two ${chunk}\n<summary>short two</summary>`)]],
      contextWindow: 1000,
    });
    const out = await manager.runParallel({ items });
    expect(out.payload!.text).not.toContain(chunk);
    expect(out.payload!.text).toContain("short one");
    expect(out.payload!.text).toContain("short two");
    expect(out.payload!.text.match(/Full output: /g) ?? []).toHaveLength(2);
  });

  it("background parallel does not deliver when everything was stopped", async () => {
    const { manager, runner, sent } = setup({ hold: true, scripts: [[ok("a")], [ok("b")]] });
    const out = await manager.runParallel({ items, background: true });
    expect(out.records).toHaveLength(2);
    await expect.poll(() => runner.sessions.filter((s) => s.prompts.length > 0)).toHaveLength(2);
    await manager.stop("reviewer");
    await manager.stop("reviewer-2");
    await manager.whenIdle();
    expect(manager.list().map((r) => r.status)).toEqual(["stopped", "stopped"]);
    expect(sent).toHaveLength(0);
  });

  it("background parallel reports the kind and handles in the delivered details", async () => {
    const { manager, sent } = setup({ scripts: [[ok("a")], [ok("b")]] });
    await manager.runParallel({ items, background: true });
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].details).toEqual({ kind: "parallel", handles: ["reviewer", "reviewer-2"] });
  });
});

describe("parallel regressions", () => {
  it("rejects the whole batch before creating records when a later item's cwd is invalid", async () => {
    const { manager, runner } = setup({ scripts: [[ok("one")], [ok("two")]] });
    await expect(
      manager.runParallel({ items: [{ agent: "reviewer", task: "one" }, { agent: "reviewer", task: "two", cwd: "/definitely/not/here" }] }),
    ).rejects.toMatchObject({ code: "missing_cwd" });
    // REVIEW-001: validating before any registry.create leaves no queued record, not even for the valid first item.
    expect(runner.opened).toHaveLength(0);
    expect(manager.list()).toHaveLength(0);
    expect(manager.list().filter((r) => r.status === "queued")).toHaveLength(0);
  });

  it("rejects the whole batch before creating records when a later item's runner is unavailable", async () => {
    const { manager, runner } = setup({ scripts: [[ok("one")], [ok("two")]], extraAgents: [rpcOnly] });
    await expect(
      manager.runParallel({ items: [{ agent: "reviewer", task: "one" }, { agent: "rpc-only", task: "two" }] }),
    ).rejects.toThrow(/runner "rpc" is not available/);
    expect(runner.opened).toHaveLength(0);
    expect(manager.list()).toHaveLength(0);
  });

  it("aggregates a failed open as one failed item instead of rejecting the batch", async () => {
    const failCwd = mkdtempSync(join(tmpdir(), "batch-fail-"));
    const { manager, runner } = setup({ scripts: [[ok("first done")]], openFailsForCwd: failCwd });
    const out = await manager.runParallel({
      items: [{ agent: "reviewer", task: "one" }, { agent: "reviewer", task: "two", cwd: failCwd }],
    });
    // REVIEW-002: allSettled keeps the sibling result; the failed open becomes a failed item in item order.
    expect(runner.opened).toHaveLength(2);
    expect(out.records.map((r) => r.status)).toEqual(["completed", "failed"]);
    expect(manager.list().map((r) => r.status)).toEqual(["completed", "failed"]);
    expect(out.payload!.text).toContain("Parallel: 1/2 succeeded");
    expect(out.payload!.text).toContain("### [@reviewer] (reviewer) completed");
    expect(out.payload!.text).toContain("first done");
    expect(out.payload!.text).toContain("### [@reviewer-2] (reviewer) failed: runner.open failed");
  });

  it("background parallel still delivers one summary when one item fails to open", async () => {
    const failCwd = mkdtempSync(join(tmpdir(), "batch-fail-"));
    const { manager, sent } = setup({ scripts: [[ok("first done")]], openFailsForCwd: failCwd });
    await manager.runParallel({
      items: [{ agent: "reviewer", task: "one" }, { agent: "reviewer", task: "two", cwd: failCwd }],
      background: true,
    });
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].customType).toBe("pi-subagents/batch");
    expect(sent[0]![0].content).toContain("Parallel: 1/2 succeeded");
  });

  it("rejects an empty item list without creating records", async () => {
    const { manager, runner } = setup();
    await expect(manager.runParallel({ items: [] })).rejects.toThrow(/at least one item/);
    expect(runner.opened).toHaveLength(0);
    expect(manager.list()).toHaveLength(0);
  });

  it("reports a background batch delivery failure through onDeliveryError", async () => {
    const errors: { handle: string; message: string }[] = [];
    const { manager } = setup({
      scripts: [[ok("a")], [ok("b")]],
      port: {
        sendMessage: () => {
          throw new Error("transport down");
        },
        appendEntry: () => {},
      },
      onDeliveryError: (record, message) => errors.push({ handle: record.handle, message }),
    });
    await manager.runParallel({ items, background: true });
    await manager.whenIdle();
    expect(errors).toEqual([{ handle: "reviewer", message: "transport down" }]);
  });

  it("treats maxParallelTasks -1 as unlimited for a large batch", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ agent: "reviewer", task: `t${i}` }));
    const { manager, runner } = setup({ settings: { maxParallelTasks: -1 }, scripts: ten.map((_, i) => [ok(`r${i}`)]) });
    const out = await manager.runParallel({ items: ten });
    expect(runner.opened).toHaveLength(10);
    expect(out.records.map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => "completed"));
    expect(out.payload!.text).toContain("Parallel: 10/10 succeeded");
  });

  it("background parallel over 8 items delivers exactly one 8/8 summary", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ agent: "reviewer", task: `t${i}` }));
    const { manager, sent } = setup({ scripts: eight.map((_, i) => [ok(`r${i}`)]) });
    const out = await manager.runParallel({ items: eight, background: true });
    expect(out.records).toHaveLength(8);
    expect(sent).toHaveLength(0);
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].customType).toBe("pi-subagents/batch");
    expect(sent[0]![0].content).toContain("Parallel: 8/8 succeeded");
    expect((sent[0]![0].details as { handles: string[] }).handles).toHaveLength(8);
  });
});