import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import { SubagentManager } from "../src/manager.ts";
import { Registry } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const reviewer: AgentDef = { name: "reviewer", description: "r", systemPrompt: "Review.", source: "user", filePath: "/a/reviewer.md" };
const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });

function setup(opts: { scripts?: ChildResult[][]; hold?: boolean; limit?: number; settings?: Partial<SubagentSettings>; failOpenAt?: number } = {}) {
  const root = tempDir("restart-");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    if (n === opts.failOpenAt) throw new Error("open failed");
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
  });
  const registry = new Registry(() => {});
  const scheduler = new Scheduler(() => opts.limit ?? 4);
  const manager = new SubagentManager({
    registry,
    chainStore: new ChainStore(() => {}),
    scheduler,
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([["reviewer", reviewer]]),
    settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings }),
    port: { sendMessage: () => {}, appendEntry: () => {} },
    receiverContextWindow: () => 200000,
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
  });
  return { manager, registry, runner, root, scheduler };
}

const statusOf = (registry: Registry, id: string) => registry.get(id)!.status;

describe("SubagentManager.restart", () => {
  it("restarts a paused record in a fresh session and keeps the old file", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const r = await manager.run({ agent: "reviewer", task: "original task", background: true });
    await vi.waitFor(() => expect(runner.sessions[0]!.prompts).toHaveLength(1));
    await manager.interrupt(r.record.handle);
    await vi.waitFor(() => expect(statusOf(registry, r.record.id)).toBe("paused"));
    const oldFile = registry.get(r.record.id)!.sessionFile;

    const out = await manager.restart(r.record.handle, { background: true });

    expect(out.record.runId).toBe(2);
    const restarted = registry.get(r.record.id)!;
    expect(restarted.sessionFile).not.toBe(oldFile);
    expect(restarted.sessionFile).toBe(runner.sessions[1]!.sessionFile);
    expect(existsSync(oldFile)).toBe(true);
    expect(runner.sessions[1]!.prompts[0]).toBe("original task");
    // A restart never resumes the old context: the new child is opened without any resume pointer.
    expect(runner.opened[1]!.resumeFile).toBeUndefined();
    expect(runner.opened[1]!.resumeLeafId).toBeUndefined();
    expect(restarted.childLeafId).toBeUndefined();
  });

  it("restarts a stopped record", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const r = await manager.run({ agent: "reviewer", task: "t", background: true });
    await vi.waitFor(() => expect(runner.sessions[0]!.prompts).toHaveLength(1));
    await manager.stop(r.record.handle);
    await vi.waitFor(() => expect(statusOf(registry, r.record.id)).toBe("stopped"));

    const out = await manager.restart(r.record.handle, { background: true });
    expect(out.record.status).not.toBe("stopped");
    expect(out.record.runId).toBe(2);
    expect(statusOf(registry, r.record.id)).toBe("running");
  });

  it("halts a running record first, then starts run 2", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const r = await manager.run({ agent: "reviewer", task: "t", background: true });
    await vi.waitFor(() => expect(runner.sessions[0]!.prompts).toHaveLength(1));

    const out = await manager.restart(r.record.handle, { background: true });

    expect(runner.sessions[0]!.aborted).toBe(1); // interrupted, not left running
    expect(out.record.runId).toBe(2);
    expect(runner.opened).toHaveLength(2);
    expect(runner.sessions[1]!.prompts[0]).toBe("t");
    expect(statusOf(registry, r.record.id)).toBe("running");
  });

  it("restarts even when the old run ignores abort", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []], settings: { interruptGraceSeconds: 1 } });
    const r = await manager.run({ agent: "reviewer", task: "t", background: true });
    await vi.waitFor(() => expect(runner.sessions[0]!.prompts).toHaveLength(1));
    runner.sessions[0]!.abortNeverSettles = true;

    const started = Date.now();
    const out = await manager.restart(r.record.handle, { background: true });

    expect(Date.now() - started).toBeLessThan(5_000); // bounded by the grace window
    expect(out.record.runId).toBe(2);
    expect(runner.opened).toHaveLength(2);
    expect(statusOf(registry, r.record.id)).toBe("running");
  });

  it("rejects queued records and chain steps", async () => {
    const { manager, registry, runner } = setup({ hold: true, limit: 1, scripts: [[], [], []] });
    await manager.run({ agent: "reviewer", task: "holds the only slot", background: true });
    const waiting = manager.run({ agent: "reviewer", task: "waits for a slot", background: true });
    await vi.waitFor(() => expect(registry.list().find((rec) => rec.task === "waits for a slot")?.status).toBe("queued"));
    const queued = registry.list().find((rec) => rec.task === "waits for a slot")!;
    await expect(manager.restart(queued.handle, { background: true })).rejects.toThrow(/queued/);
    expect(statusOf(registry, queued.id)).toBe("queued"); // nothing was touched

    const chain = await manager.runChain({ steps: [{ agent: "reviewer", task: "step" }], background: true });
    await vi.waitFor(() => expect(manager.listChains().find((c) => c.id === chain.chain!.id)!.stepRecordIds).toHaveLength(1));
    const stepHandle = registry.get(manager.listChains().find((c) => c.id === chain.chain!.id)!.stepRecordIds[0]!)!.handle;
    await expect(manager.restart(stepHandle, { background: true })).rejects.toThrow(/action=continue/);

    // Let the queued run and the chain step settle so nothing is left live.
    const holder = registry.list().find((rec) => rec.task === "holds the only slot")!;
    await manager.stopAll();
    await expect(waiting).rejects.toThrow(/cancelled before it started/);
    expect(statusOf(registry, holder.id)).toBe("stopped");
    expect(runner.sessions.length).toBeGreaterThan(0);
    await manager.whenIdle();
  });

  it("closes the parked idle session before opening a new one", async () => {
    const { manager, registry, runner } = setup({ scripts: [[ok("one")], [ok("two")]], settings: { maxResident: 2 } });
    const r = await manager.run({ agent: "reviewer", task: "t" });
    expect(runner.sessions[0]!.disposed).toBe(false); // parked for the next resume

    const out = await manager.restart(r.record.handle, { background: true });

    expect(runner.sessions[0]!.disposed).toBe(true);
    expect(out.record.runId).toBe(2);
    expect(runner.opened).toHaveLength(2);
    expect(runner.opened[1]!.resumeFile).toBeUndefined();
    await manager.whenIdle();
    expect(statusOf(registry, r.record.id)).toBe("completed");
  });

  it("keeps pending child results for a later drain", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const parent = await manager.run({ agent: "reviewer", task: "p", background: true });
    await vi.waitFor(() => expect(runner.sessions[0]!.prompts).toHaveLength(1));
    await manager.interrupt(parent.record.handle);
    await vi.waitFor(() => expect(statusOf(registry, parent.record.id)).toBe("paused"));
    registry.update(parent.record.id, { pending: [{ fromId: "x", handle: "kid", summary: "s", sessionFile: "/x", at: 1 }] });

    await manager.restart(parent.record.handle, { background: true });

    expect(registry.get(parent.record.id)!.pending).toHaveLength(1);
    expect((await manager.drainPending(parent.record.handle)).count).toBe(1);
  });

  it("rolls the record back when the new session cannot open", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []], failOpenAt: 1 });
    const r = await manager.run({ agent: "reviewer", task: "t", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    await manager.interrupt(r.record.handle);
    await vi.waitFor(() => expect(statusOf(registry, r.record.id)).toBe("paused"));
    const before = registry.get(r.record.id)!;

    await expect(manager.restart(r.record.handle, { background: true })).rejects.toThrow(/open failed/);

    // No "running" leak and no cleared sessionFile: the record looks exactly like it did before the restart.
    expect(registry.get(r.record.id)).toMatchObject({ status: before.status, runId: before.runId, sessionFile: before.sessionFile });
    expect(statusOf(registry, r.record.id)).toBe("paused");
  });

  it("appends an optional message to the original task", async () => {
    const { manager, registry, runner } = setup({ scripts: [[ok("one")], [ok("two")]] });
    const r = await manager.run({ agent: "reviewer", task: "original" });
    const out = await manager.restart(r.record.handle, { background: true, message: "try again differently" });
    expect(out.record.runId).toBe(2);
    expect(runner.sessions[1]!.prompts[0]).toBe("original\n\ntry again differently");
    expect(statusOf(registry, r.record.id)).toBe("running");
  });
});
describe("restart through a delegation", () => {
  it("yields the delegating parent's slot while the restarted run holds it", async () => {
    const { manager, registry, runner, scheduler } = setup({ limit: 1, hold: true, scripts: [[], []] });
    // A finished child: nothing is live, so its restart can be requested.
    const child = await manager.run({ agent: "reviewer", task: "kid", background: true });
    runner.sessions[0]!.finish();
    await vi.waitFor(() => expect(statusOf(registry, child.record.id)).toBe("completed"));
    // A live parent holding the only slot, with the finished child in its subtree.
    const parent = await manager.run({ agent: "reviewer", task: "plan", background: true });
    expect(scheduler.running).toBe(1);
    registry.restore({ ...registry.get(child.record.id)!, parentId: parent.record.id, depth: 2 });

    const delegating = manager.delegate(parent.record.id, { action: "restart", handle: child.record.handle });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(3));
    // The parent gave up its slot for the wait; the restarted run takes it, so maxConcurrent 1 does not self-lock.
    expect(scheduler.running).toBe(1);
    expect(runner.sessions[2]!.prompts).toEqual(["kid"]);
    expect(runner.opened[2]!.resumeFile).toBeUndefined();

    runner.sessions[2]!.finish();
    await delegating;
    expect(scheduler.running).toBe(1); // the parent took the single grant back
    runner.sessions[1]!.finish(); // the parent's own run
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
  });
});
