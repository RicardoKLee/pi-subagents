import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import type { DeliveryPort } from "../src/delivery.ts";
import { SubagentError, SubagentManager } from "../src/manager.ts";
import { Registry } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";

const reviewer: AgentDef = { name: "reviewer", description: "r", systemPrompt: "Review.", source: "user", filePath: "/a/reviewer.md" };

function setup(opts: { scripts?: ChildResult[][]; hold?: boolean; contextWindow?: number; registry?: Registry } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mgr-"));
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
  });
  const sent: Parameters<DeliveryPort["sendMessage"]>[] = [];
  const manager = new SubagentManager({
    registry: opts.registry ?? new Registry(() => {}),
    scheduler: new Scheduler(() => 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([["reviewer", reviewer]]),
    settings: () => DEFAULT_SETTINGS,
    port: { sendMessage: (...args) => sent.push(args) },
    receiverContextWindow: () => opts.contextWindow ?? 200000,
    cwd: root,
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
  });
  return { manager, runner, sent, root };
}

const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });

describe("SubagentManager.run", () => {
  it("runs in the foreground and returns the payload", async () => {
    const { manager, runner } = setup({ scripts: [[ok("LGTM")]] });
    const { record, payload } = await manager.run({ agent: "reviewer", task: "review diff" });
    expect(payload?.text).toBe("LGTM");
    expect(record).toMatchObject({ handle: "reviewer", status: "completed", runId: 1 });
    expect(record.usage.cost).toBeCloseTo(0.01);
    expect(runner.opened[0]!.appendSystemPrompt.join("\n")).toContain("<summary>");
    expect(runner.sessions[0]!.disposed).toBe(true);
  });

  it("rejects an unknown agent with the available names", async () => {
    const { manager } = setup();
    await expect(manager.run({ agent: "nobody", task: "x" })).rejects.toThrow(/reviewer/);
  });

  it("marks a run failed on error stop reason", async () => {
    const { manager } = setup({ scripts: [[{ text: "", stopReason: "error", errorMessage: "rate limited", usage: usage(0) }]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x" });
    expect(record.status).toBe("failed");
    expect(record.error).toBe("rate limited");
  });

  it("marks a run failed on an empty answer", async () => {
    const { manager } = setup({ scripts: [[ok("   ")]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x" });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/empty/);
  });

  it("moves large output to a file for the receiver", async () => {
    const { manager } = setup({ scripts: [[ok("z".repeat(4000))]], contextWindow: 1000 });
    const { payload } = await manager.run({ agent: "reviewer", task: "x" });
    expect(payload?.filePath).toBeDefined();
  });
});

describe("SubagentManager.resume", () => {
  it("continues the same session and accumulates usage", async () => {
    const { manager, runner } = setup({ scripts: [[ok("first")], [ok("second")]] });
    const first = await manager.run({ agent: "reviewer", task: "x" });
    const second = await manager.resume("reviewer", "look again");
    expect(second.payload?.text).toBe("second");
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.runId).toBe(2);
    expect(second.record.usage.cost).toBeCloseTo(0.02);
    expect(runner.opened[1]!.resumeFile).toBe(first.record.sessionFile);
    expect(runner.sessions[1]!.prompts).toEqual(["look again"]);
  });

  it("resume unknown handle lists known handles", async () => {
    const { manager } = setup({ scripts: [[ok("a")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await expect(manager.resume("ghost", "hi")).rejects.toMatchObject({ code: "unknown_handle", message: expect.stringContaining("reviewer") });
  });

  it("resume stopped is rejected", async () => {
    const { manager } = setup({ scripts: [[ok("a")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.stop("reviewer");
    await expect(manager.resume("reviewer", "hi")).rejects.toMatchObject({ code: "stopped" });
  });

  it("resume missing session file is rejected", async () => {
    const { manager } = setup({ scripts: [[ok("a")]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x" });
    rmSync(record.sessionFile);
    await expect(manager.resume("reviewer", "hi")).rejects.toMatchObject({ code: "missing_session" });
  });

  it("concurrent resume rejected while running", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await expect(manager.resume("reviewer", "again")).rejects.toMatchObject({ code: "busy" });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
  });
});

describe("steer / interrupt / stop / background", () => {
  it("steers a running child", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.steer("reviewer", "focus on tests");
    expect(runner.sessions[0]!.steers).toEqual([{ text: "focus on tests", mode: "steer" }]);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
  });

  it("steer on a finished child says not_running", async () => {
    const { manager } = setup({ scripts: [[ok("a")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await expect(manager.steer("reviewer", "hi")).rejects.toMatchObject({ code: "not_running" });
  });

  it("interrupt pauses and the record can be resumed", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.interrupt("reviewer");
    await manager.whenIdle();
    expect(manager.list()[0]!.status).toBe("paused");
    expect(runner.sessions[0]!.aborted).toBe(1);
    const resumed = manager.resume("reviewer", "continue", { background: true });
    await resumed;
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    expect(manager.list()[0]!.status).toBe("completed");
  });

  it("stop marks a running child stopped, not paused", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.stop("reviewer");
    await manager.whenIdle();
    expect(manager.list()[0]!.status).toBe("stopped");
    expect(runner.sessions[0]!.disposed).toBe(true);
  });

  it("recoverInterrupted marks orphaned running records paused", () => {
    const registry = new Registry(() => {});
    registry.create({ agent: "reviewer", preferredHandle: "reviewer", runner: "sdk", depth: 1, sessionFile: "/x.jsonl", delivery: "share", task: "x" });
    const { manager } = setup({ registry });
    expect(manager.recoverInterrupted()).toBe(1);
    expect(manager.list()[0]!.status).toBe("paused");
  });

  it("background run delivers through the record's mode", async () => {
    const { manager, sent } = setup({ scripts: [[ok("done!")]] });
    const { payload } = await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "private" });
    expect(payload).toBeUndefined();
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].customType).toBe("pi-subagents/private");
    expect(sent[0]![0].content).toContain("done!");
  });
});
