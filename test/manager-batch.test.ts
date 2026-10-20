import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
// Non-zero usage, for regression tests that must not lean on the all-zero `err` helper.
const okUsage = (text: string, cost: number): ChildResult => ({ text, stopReason: "stop", usage: usage(cost) });
const errUsage = (message: string, cost: number): ChildResult => ({ text: "", stopReason: "error", errorMessage: message, usage: usage(cost) });
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
    /** Context window of a given agent's model; used by chain steps to size `{previous}`. */
    agentWindow?: (agent: AgentDef) => number | undefined;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "batch-"));
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    if (opts.openFailsForCwd && spec.cwd === opts.openFailsForCwd) throw new Error(`runner.open failed for cwd ${spec.cwd}`);
    // Mirror test/manager.test.ts: the session file must exist on disk so a later `continue`/resume passes preflight.
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
  });
  const sent: Parameters<DeliveryPort["sendMessage"]>[] = [];
  const chainStore = new ChainStore(() => {});
  const manager = new SubagentManager({
    registry: new Registry(() => {}),
    chainStore,
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
    ...(opts.agentWindow ? { receiverContextWindowFor: opts.agentWindow } : {}),
  });
  return { manager, runner, sent, chainStore, root };
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

const step1 = { agent: "reviewer", task: "first" };
const step2 = { agent: "reviewer", task: "second got {previous}" };
const step3 = { agent: "reviewer", task: "third got {previous}" };

describe("chain", () => {
  it("runs steps in order, substitutes {previous} and records the chain", async () => {
    const { manager, chainStore, runner } = setup({ scripts: [[ok("alpha")], [ok("beta")], [ok("gamma")]] });
    const out = await manager.runChain({ steps: [step1, step2, step3] });
    expect(runner.sessions.map((s) => s.prompts)).toEqual([["first"], ["second got alpha"], ["third got beta"]]);
    expect(out.chain!.status).toBe("completed");
    expect(out.records.map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
    expect(out.records.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
    expect(out.records.every((r) => r.chainId === out.chain!.id)).toBe(true);
    expect(out.chain!.stepRecordIds).toEqual(out.records.map((r) => r.id));
    expect(out.chain!.usage.cost).toBeCloseTo(0.03);
    expect(chainStore.get(out.chain!.id)!.status).toBe("completed");
    expect(out.payload!.text).toContain("Chain completed (3/3 steps)");
  });

  it("sizes a step's output for the next step's model", async () => {
    const big = "z".repeat(2000);
    const { manager, runner } = setup({ scripts: [[ok(big)], [ok("done")]], agentWindow: () => 100 });
    await manager.runChain({ steps: [step1, step2] });
    expect(runner.sessions[1]!.prompts[0]).toContain("Full output: ");
    expect(runner.sessions[1]!.prompts[0]).not.toContain(big);
  });

  it("stops at the failing step and keeps the state for continue", async () => {
    const { manager } = setup({ scripts: [[ok("a")], [err("rate limited")], [ok("never")]] });
    const out = await manager.runChain({ steps: [step1, step2, step3] });
    expect(out.chain!.status).toBe("failed");
    expect(out.chain!.currentStep).toBe(1);
    expect(out.records.map((r) => r.status)).toEqual(["completed", "failed"]);
    expect(out.payload!.text).toContain("Chain failed (2/3 steps)");
    expect(out.payload!.text).toContain("step 2 failed: rate limited");
  });

  it("continue resumes the failing step and runs the rest", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [err("rate limited")], [ok("b2")], [ok("c")]] });
    const out = await manager.runChain({ steps: [step1, step2, step3] });
    const failed = out.records.at(-1)!;
    const cont = await manager.continueChain(failed.handle, "try again");
    expect(cont.chain!.status).toBe("completed");
    expect(cont.records.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(runner.sessions[1]!.prompts).toEqual(["second got a"]);
    expect(runner.sessions[2]!.prompts).toEqual(["try again"]);
    expect(runner.sessions[3]!.prompts).toEqual(["third got b2"]);
  });

  it("interrupt pauses the chain and continue resumes the same step", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("a")], [ok("a2")], [ok("b")]] });
    const pending = manager.runChain({ steps: [step1, step2] });
    await expect.poll(() => runner.sessions.length).toBe(1);
    await manager.interrupt("reviewer");
    const out = await pending;
    expect(out.chain!.status).toBe("paused");
    expect(out.records.map((r) => r.status)).toEqual(["paused"]);
    const cont = manager.continueChain("reviewer");
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();
    expect((await cont).chain!.status).toBe("completed");
    expect(runner.sessions[1]!.prompts).toEqual(["first"]);
    expect(runner.sessions[2]!.prompts).toEqual(["second got a2"]);
  });

  it("stop on a step stops the chain and it cannot be continued", async () => {
    const { manager } = setup({ hold: true, scripts: [[ok("a")], [ok("b")]] });
    const pending = manager.runChain({ steps: [step1, step2] });
    await expect.poll(() => manager.list().length).toBe(1);
    await manager.stop("reviewer");
    expect((await pending).chain!.status).toBe("stopped");
    await expect(manager.continueChain("reviewer")).rejects.toMatchObject({ code: "stopped" });
  });

  it("a finished chain and a plain subagent refuse continue", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [ok("b")], [ok("c")]] });
    const chain = await manager.runChain({ steps: [step1] });
    await expect(manager.continueChain(chain.records[0]!.handle)).rejects.toMatchObject({ code: "not_running" });
    await manager.run({ agent: "reviewer", task: "plain" });
    await expect(manager.continueChain("reviewer-2")).rejects.toMatchObject({ code: "unknown_handle" });
    expect(runner.opened).toHaveLength(2);
  });

  it("rejects too many steps and chains when disabled", async () => {
    await expect(setup({ settings: { maxChainSteps: 1 } }).manager.runChain({ steps: [step1, step2] })).rejects.toThrow(/max is 1/);
    await expect(setup({ settings: { maxChainSteps: 0 } }).manager.runChain({ steps: [step1] })).rejects.toThrow(/disabled/);
  });

  it("background chain delivers one summary and returns the chain id", async () => {
    const { manager, sent } = setup({ scripts: [[ok("a")], [ok("b")]] });
    const out = await manager.runChain({ steps: [step1, step2], background: true });
    expect(out.chain!.id).toBeTruthy();
    expect(out.records).toHaveLength(0);
    expect(sent).toHaveLength(0);
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].content).toContain("Chain completed (2/2 steps)");
    expect((sent[0]![0].details as { chainId: string }).chainId).toBe(out.chain!.id);
  });

  it("activeChains lists the chains of live runs", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("a")], [ok("b")]] });
    const pending = manager.runChain({ steps: [step1, step2] });
    await expect.poll(() => runner.sessions.length).toBe(1);
    expect(manager.activeChains()).toHaveLength(1);
    runner.sessions[0]!.finish();
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await pending;
    expect(manager.activeChains()).toHaveLength(0);
  });

  it("substitutes {previous} inline when it fits the next step's window", async () => {
    const fits = "y".repeat(1000);
    const { manager, runner } = setup({ scripts: [[ok(fits)], [ok("done")]], agentWindow: () => 4000 });
    await manager.runChain({ steps: [step1, step2] });
    expect(runner.sessions[1]!.prompts).toEqual([`second got ${fits}`]);
    expect(runner.sessions[1]!.prompts[0]).not.toContain("Full output:");
  });

  it("sizes the last step's output for the main session window", async () => {
    const big = "z".repeat(2000);
    // The next step's model is huge, but the last step has no next step: it must be measured against the main window.
    const { manager, runner } = setup({ scripts: [[ok("small")], [ok(big)]], contextWindow: 200, agentWindow: () => 100000 });
    const out = await manager.runChain({ steps: [step1, step2] });
    expect(out.payload!.text).toContain("Full output: ");
    expect(out.payload!.text).not.toContain(big);
    expect(runner.sessions[1]!.prompts).toEqual(["second got small"]);
  });

  it("continue refuses a handle that is not the step the chain stopped at", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [err("rate limited")], [ok("never")]] });
    const out = await manager.runChain({ steps: [step1, step2, step3] });
    expect(out.chain!.currentStep).toBe(1);
    const opened = runner.opened.length;
    // "reviewer" is step 1; the chain stopped at step 2, so step 1 cannot be resumed as the chain's continuation.
    await expect(manager.continueChain("reviewer")).rejects.toMatchObject({ code: "not_running" });
    expect(runner.opened).toHaveLength(opened);
  });

  it("continue refuses while the chain is still running", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("a")], [ok("b")]] });
    const pending = manager.runChain({ steps: [step1, step2] });
    await expect.poll(() => runner.sessions.length).toBe(1);
    await expect(manager.continueChain("reviewer")).rejects.toMatchObject({ code: "busy" });
    await manager.stop("reviewer");
    await pending;
  });

  it("fails the chain and keeps the earlier steps when a step cannot open", async () => {
    const failCwd = mkdtempSync(join(tmpdir(), "chain-fail-"));
    const { manager } = setup({ scripts: [[ok("a")]], openFailsForCwd: failCwd });
    const out = await manager.runChain({ steps: [step1, { agent: "reviewer", task: "second got {previous}", cwd: failCwd }, step3] });
    expect(out.chain!.status).toBe("failed");
    expect(out.chain!.currentStep).toBe(1);
    expect(out.records.map((r) => r.status)).toEqual(["completed", "failed"]);
    expect(out.payload!.text).toContain("Chain failed (2/3 steps)");
    expect(out.payload!.text).toContain("runner.open failed");
  });

  it("accumulates chain usage across a pause and its resumed steps", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("a")], [ok("a2")], [ok("b")]] });
    const pending = manager.runChain({ steps: [step1, step2] });
    await expect.poll(() => runner.sessions.length).toBe(1);
    await manager.interrupt("reviewer");
    const paused = await pending;
    expect(paused.chain!.usage.cost).toBe(0);
    const cont = manager.continueChain("reviewer");
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();
    const done = await cont;
    expect(done.chain!.status).toBe("completed");
    // 0 (aborted step 1) + 0.01 (resumed step 1) + 0.01 (step 2)
    expect(done.chain!.usage.cost).toBeCloseTo(0.02);
  });

  it("activeChains drops a chain once it is stopped", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("a")], [ok("b")]] });
    const pending = manager.runChain({ steps: [step1, step2] });
    await expect.poll(() => runner.sessions.length).toBe(1);
    expect(manager.activeChains()).toHaveLength(1);
    await manager.stop("reviewer");
    await pending;
    expect(manager.activeChains()).toHaveLength(0);
  });

  it("allows exactly the configured number of steps", async () => {
    // A positive limit is inclusive: maxChainSteps 1 must allow a one-step chain (not reject it).
    const { manager } = setup({ scripts: [[ok("only")]], settings: { maxChainSteps: 1 } });
    const out = await manager.runChain({ steps: [step1] });
    expect(out.chain!.status).toBe("completed");
    expect(out.records.map((r) => r.status)).toEqual(["completed"]);
  });

  // Regression tests for the M4 chain review findings. They pin the fixes code-agent made in src/manager.ts:
  // the functional `{previous}` replacement, the whole-chain continue summary, the recomputed chain usage and the
  // "refuse before the chain exists" guards.
  const specials = "$& $` $' $1 $$";

  it("keeps $-patterns in {previous} literal when the previous output is inline", async () => {
    const { manager, runner } = setup({ scripts: [[ok(specials)], [ok("done")]], agentWindow: () => 4000 });
    await manager.runChain({ steps: [step1, step2] });
    // A string replacement would expand `$&`, `` $` ``, `$'`, `$1` and `$$` inside the previous output.
    expect(runner.sessions[1]!.prompts).toEqual([`second got ${specials}`]);
    expect(runner.sessions[1]!.prompts[0]).not.toContain("{previous}");
  });

  it("keeps $-patterns in {previous} literal when the previous output is written to a file", async () => {
    const body = `${specials}\n${"z".repeat(400)}`;
    // A 100-token window (ratio 0.3 = 30-token threshold) forces step 1's output to a file, so the summary and the
    // file path carry the special sequences into step 2's prompt.
    const { manager, runner } = setup({ scripts: [[ok(body)], [ok("done")]], agentWindow: () => 100 });
    await manager.runChain({ steps: [step1, step2] });
    const prompt = runner.sessions[1]!.prompts[0]!;
    expect(prompt).toContain(specials);
    expect(prompt).not.toContain("{previous}");
    expect(prompt).toContain("Full output: ");
    const file = /Full output: (\S+)/.exec(prompt)![1]!;
    expect(readFileSync(file, "utf8")).toContain(specials);
  });

  it("reports a continued chain as 3/3 and keeps the resumed step in the summary", async () => {
    const { manager } = setup({ scripts: [[ok("a")], [err("rate limited")], [ok("b2")], [ok("c")]] });
    const out = await manager.runChain({ steps: [step1, step2, step3] });
    expect(out.chain!.stepRecordIds).toHaveLength(2);
    const cont = await manager.continueChain(out.records.at(-1)!.handle, "try again");
    expect(cont.chain!.status).toBe("completed");
    expect(cont.chain!.stepRecordIds).toHaveLength(3);
    expect(cont.payload!.text).toContain("Chain completed (3/3 steps)");
    expect(cont.payload!.text).not.toContain("(1/3 steps)");
    // The two sections span the resumed step and the newly-run step; the head counts every started step, not just these.
    expect(cont.payload!.text).toContain("### [@reviewer-2] (reviewer) step 2 completed");
    expect(cont.payload!.text).toContain("### [@reviewer-3] (reviewer) step 3 completed");
  });

  it("delivers exactly one 3/3 summary for a background continue", async () => {
    const { manager, sent } = setup({ scripts: [[ok("a")], [err("rate limited")], [ok("b2")], [ok("c")]] });
    const out = await manager.runChain({ steps: [step1, step2, step3] });
    await manager.continueChain(out.records.at(-1)!.handle, "try again", { background: true });
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].content).toContain("Chain completed (3/3 steps)");
    expect((sent[0]![0].details as { chainId: string }).chainId).toBe(out.chain!.id);
  });

  it("recomputes chain.usage from every step record after a continue", async () => {
    // Non-zero usage on the failed step and its resume: an accumulate-as-you-go total would double-count the resume.
    const { manager } = setup({ scripts: [[okUsage("a", 0.01)], [errUsage("boom", 0.05)], [okUsage("b2", 0.02)], [okUsage("c", 0.03)]] });
    const out = await manager.runChain({ steps: [step1, step2, step3] });
    expect(out.chain!.usage.cost).toBeCloseTo(0.06);
    const cont = await manager.continueChain(out.records.at(-1)!.handle, "try again");
    expect(cont.chain!.status).toBe("completed");
    const records = manager.list().filter((r) => r.chainId === cont.chain!.id);
    expect(records).toHaveLength(3);
    // 0.01 (step 1) + 0.07 (step 2 failed 0.05 + resumed 0.02) + 0.03 (step 3).
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
      const sum = records.reduce((n, r) => n + r.usage[key], 0);
      expect(cont.chain!.usage[key]).toBeCloseTo(sum);
    }
    expect(cont.chain!.usage.cost).toBeCloseTo(0.11);
  });

  it("refuses the chain before creating it when the scheduler is disabled", async () => {
    const { manager, chainStore } = setup({ limit: 0 });
    await expect(manager.runChain({ steps: [step1] })).rejects.toThrow(/disabled/);
    // No orphan chain left behind in "running" with no step records.
    expect(chainStore.list()).toHaveLength(0);
  });

  it("refuses the chain before creating it when a step names an unknown agent", async () => {
    const { manager, chainStore } = setup();
    await expect(manager.runChain({ steps: [{ agent: "nope", task: "x" }] })).rejects.toMatchObject({ code: "unknown_agent" });
    expect(chainStore.list()).toHaveLength(0);
  });
});
