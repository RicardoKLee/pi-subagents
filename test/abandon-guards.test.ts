import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import { SubagentManager } from "../src/manager.ts";
import { Registry, type SubagentRecord } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const reviewer: AgentDef = { name: "reviewer", description: "r", systemPrompt: "Review.", source: "user", filePath: "/a/reviewer.md" };
const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });

/** The parts of a live run these tests read or drive directly (the manager keeps `Live` private). */
interface LiveLike {
  intent?: string;
  abandoned?: boolean;
  /** The grant `execute` currently holds; `undefined` while a delegation has yielded it (REVIEW-046). */
  release?: () => void;
}

function setup(opts: { scripts?: ChildResult[][]; hold?: boolean; limit?: number; settings?: Partial<SubagentSettings>; now?: () => number } = {}) {
  const root = tempDir("abandon-");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
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
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { manager, registry, runner, scheduler, root };
}

const liveMap = (manager: SubagentManager): Map<string, LiveLike> =>
  (manager as unknown as { live: Map<string, LiveLike> }).live;
const onlyLive = (manager: SubagentManager): LiveLike => [...liveMap(manager).values()][0]!;
/** Drives the manager's abandonment directly, the way the stall watchdog does when the grace window expires. */
const abandon = (manager: SubagentManager, record: SubagentRecord, live: LiveLike, reason: string): void =>
  (manager as unknown as { abandon: (r: SubagentRecord, l: LiveLike, why: string) => void }).abandon.call(manager, record, live, reason);

describe("REVIEW-001: an abandoned run releases its scheduler grant", () => {
  it("gives the slot back so the next foreground call can start", async () => {
    const clock = { t: 1_000_000 };
    const { manager, registry, runner, scheduler } = setup({
      limit: 1,
      hold: true,
      now: () => clock.t,
      settings: { toolIdleTimeoutMinutes: 10, interruptGraceSeconds: 1 },
    });
    const first = await manager.run({ agent: "reviewer", task: "stuck", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    expect(scheduler.running).toBe(1);
    // The tool ignores the abort signal: the run never settles, so the watchdog has to abandon it.
    runner.sessions[0]!.abortNeverSettles = true;
    runner.sessions[0]!.emitActivity({ phase: "tool", toolCallId: "c1", toolName: "bash", progress: false });
    clock.t += 11 * 60_000;
    expect(manager.checkStalls()).toBe(1);
    await vi.waitFor(() => expect(registry.get(first.record.id)!.status).toBe("paused"), { timeout: 5_000 });
    // The abandoned job's `finally` never runs, so `abandon()` itself must hand the grant back.
    expect(scheduler.running).toBe(0);

    // With maxConcurrent 1 a leaked grant would hang this call forever instead of opening run 2.
    const restarted = manager.restart(first.record.handle, {});
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2), { timeout: 2_000 });
    expect(scheduler.running).toBe(1);
    runner.sessions[1]!.finish();
    const out = await restarted;
    expect(out.record.runId).toBe(2);
    expect(scheduler.running).toBe(0);
    await manager.whenIdle();
  });
});

describe("REVIEW-002: a late settle of an abandoned run leaves the new run alone", () => {
  it("keeps the new live entry, its status and its abortability", async () => {
    const { manager, registry, runner } = setup({ hold: true, settings: { interruptGraceSeconds: 1 } });
    const first = await manager.run({ agent: "reviewer", task: "stuck", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    const wedged = runner.sessions[0]!;
    wedged.abortNeverSettles = true;
    abandon(manager, registry.get(first.record.id)!, onlyLive(manager), "stalled: bash produced no progress for 45m");
    await vi.waitFor(() => expect(registry.get(first.record.id)!.status).toBe("paused"));

    await manager.restart(first.record.handle, { background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2));
    const second = runner.sessions[1]!;
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));

    // The wedged tool finally returns, long after the record moved on to run 2.
    wedged.finish();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The old run's teardown must not remove the new run's bookkeeping.
    expect(manager.activitySnapshot().size).toBe(1);
    expect(registry.get(first.record.id)!.status).toBe("running");
    expect(registry.get(first.record.id)!.runId).toBe(2);

    // A mass stop still reaches the live run: it looks the record up in the live map.
    expect(second.aborted).toBe(0);
    await manager.stopAll();
    expect(second.aborted).toBe(1);
    expect(registry.get(first.record.id)!.status).toBe("stopped");
    await manager.whenIdle();
  });
});

describe("REVIEW-001: the release stays safe around a delegation yield", () => {
  it("never takes the waiting child's slot, and a late release is a no-op", async () => {
    const { manager, registry, runner, scheduler } = setup({ limit: 1, hold: true, settings: { interruptGraceSeconds: 1 } });
    const parent = await manager.run({ agent: "reviewer", task: "parent", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    expect(scheduler.running).toBe(1);

    // A foreground delegation gives the parent's slot up while it waits (REVIEW-046); the child takes it.
    const delegating = manager.delegate(parent.record.id, { action: "run", agent: "reviewer", task: "kid" });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2));
    expect(scheduler.running).toBe(1);
    const live = liveMap(manager).get(parent.record.id)!;
    expect(live.release).toBeUndefined(); // the yield swapped the parent's own release closure out

    // The parent is abandoned while it is yielded: its own grant is already back, so this must not touch the child's.
    abandon(manager, registry.get(parent.record.id)!, live, "stalled: the turn exceeded 10m");
    expect(scheduler.running).toBe(1);
    expect(registry.get(parent.record.id)!.status).toBe("paused");

    // The child finishes and hands its slot back; the delegation then re-acquires for a parent that no longer exists.
    runner.sessions[1]!.finish();
    await delegating;
    expect(scheduler.running).toBe(0);

    // The abandoned parent's own job finally settles: one more release, which must not go negative.
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
  });
});

describe("REVIEW-003: one tool ending keeps the other calls' budget", () => {
  it("judges the still-silent call of the same message", async () => {
    const clock = { t: 1_000_000 };
    const { manager, registry, runner } = setup({
      hold: true,
      now: () => clock.t,
      settings: { toolIdleTimeoutMinutes: 10, interruptGraceSeconds: 1 },
    });
    const out = manager.run({ agent: "reviewer", task: "two tools" });
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));
    const session = runner.sessions[0]!;
    session.emitActivity({ phase: "tool", toolCallId: "a", toolName: "read", progress: false });
    session.emitActivity({ phase: "tool", toolCallId: "b", toolName: "bash", progress: false });
    clock.t += 9 * 60_000;
    // The read finished; bash is still in flight and silent (the F10 shape of case-01a0c29f).
    session.emitActivity({ phase: "tool-end", toolCallId: "a" });
    clock.t += 2 * 60_000;

    expect(manager.checkStalls()).toBe(1);
    await vi.waitFor(() => expect(registry.list()[0]!.status).toBe("paused"));
    expect(registry.list()[0]!.error).toMatch(/bash/);
    expect(registry.list()[0]!.error).not.toMatch(/read/);
    await out;
  });

  it("ignores a tool-end for a call it never saw", async () => {
    const clock = { t: 1_000_000 };
    const { manager, registry, runner } = setup({ hold: true, now: () => clock.t, settings: { toolIdleTimeoutMinutes: 10, interruptGraceSeconds: 1 } });
    const out = manager.run({ agent: "reviewer", task: "ghost end" });
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));
    const session = runner.sessions[0]!;
    session.emitActivity({ phase: "tool", toolCallId: "b", toolName: "bash", progress: false });
    clock.t += 2 * 60_000;
    session.emitActivity({ phase: "tool", toolCallId: "a", toolName: "read", progress: false });
    clock.t += 9 * 60_000; // bash is 11m old, read 9m

    session.emitActivity({ phase: "tool-end", toolCallId: "ghost" });

    // A stale id deletes nothing: the phase stays a tool phase and neither call loses its deadline.
    expect([...manager.activitySnapshot().values()][0]?.label).not.toBe("model");
    expect(manager.checkStalls()).toBe(1);
    await vi.waitFor(() => expect(registry.list()[0]!.status).toBe("paused"));
    expect(registry.list()[0]!.error).toMatch(/bash/);
    await out;
  });

  it("gives the next call its own clock once the table is empty", async () => {
    const clock = { t: 1_000_000 };
    const { manager, registry, runner } = setup({ hold: true, now: () => clock.t, settings: { toolIdleTimeoutMinutes: 10, interruptGraceSeconds: 1 } });
    const out = manager.run({ agent: "reviewer", task: "sequential tools" });
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));
    const session = runner.sessions[0]!;
    session.emitActivity({ phase: "tool", toolCallId: "first", toolName: "bash", progress: false });
    clock.t += 9 * 60_000;
    session.emitActivity({ phase: "tool-end", toolCallId: "first" });
    expect([...manager.activitySnapshot().values()][0]?.label).toBe("model");

    session.emitActivity({ phase: "tool", toolCallId: "second", toolName: "read", progress: false });
    clock.t += 2 * 60_000; // 11m since the first call began, 2m since this one
    expect(manager.checkStalls()).toBe(0); // the finished call left no deadline behind

    clock.t += 9 * 60_000; // 11m since this call began
    expect(manager.checkStalls()).toBe(1);
    await vi.waitFor(() => expect(registry.list()[0]!.status).toBe("paused"));
    expect(registry.list()[0]!.error).toMatch(/read/);
    expect(registry.list()[0]!.error).not.toMatch(/bash/);
    await out;
  });

  it("returns to the model phase once the last call ends", async () => {
    const clock = { t: 1_000_000 };
    const { manager, runner } = setup({ hold: true, now: () => clock.t, settings: { toolIdleTimeoutMinutes: 10, interruptGraceSeconds: 1 } });
    const out = manager.run({ agent: "reviewer", task: "one tool" });
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));
    const session = runner.sessions[0]!;
    session.emitActivity({ phase: "tool", toolCallId: "a", toolName: "read", progress: false });
    session.emitActivity({ phase: "tool-end", toolCallId: "a" });
    expect([...manager.activitySnapshot().values()][0]?.label).toBe("model");
    clock.t += 60 * 60_000;
    expect(manager.checkStalls()).toBe(0);
    await manager.interruptAll();
    await out;
  });
});

describe("REVIEW-005: an abandonment tells the caller what to do next", () => {
  it("says to restart and keeps the did-not-settle warning", async () => {
    const { manager, registry, runner } = setup({ hold: true, settings: { interruptGraceSeconds: 1 } });
    const pending = manager.run({ agent: "reviewer", task: "stuck in bash" });
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));
    runner.sessions[0]!.abortNeverSettles = true;
    abandon(manager, registry.list()[0]!, onlyLive(manager), "stalled: bash produced no progress for 45m");

    const out = await pending;

    expect(out.record.status).toBe("paused");
    expect(out.payload?.text).toMatch(/did not settle after abort/);
    expect(out.payload?.text).toMatch(/use restart/);
    expect(out.payload?.text).toMatch(/@reviewer/);
    await manager.whenIdle();
  });
});
describe("REVIEW-004: a manual interrupt/stop arms the same abandonment window", () => {
  /** A live run whose child never answers the abort (an in-process SDK child that cannot be killed). */
  async function wedged(opts: { settings?: Partial<SubagentSettings> } = {}) {
    const ctx = setup({ hold: true, settings: { interruptGraceSeconds: 1, ...opts.settings } });
    const run = await ctx.manager.run({ agent: "reviewer", task: "t", background: true });
    await vi.waitFor(() => expect(liveMap(ctx.manager).size).toBe(1));
    ctx.runner.sessions[0]!.abortNeverSettles = true;
    return { ...ctx, record: ctx.registry.get(run.record.id)! };
  }

  it("ends a stop as stopped, releases the caller and lets shutdown finish", async () => {
    const { manager, registry, record } = await wedged();
    const started = Date.now();
    await manager.stop(record.handle);
    expect(Date.now() - started).toBeLessThan(5_000);
    // `stop` marks the record at once; the abandonment window only adds the reason once it expires.
    await vi.waitFor(() => expect(registry.get(record.id)!.error ?? "").toMatch(/did not settle after abort/), { timeout: 5_000 });
    const after = registry.get(record.id)!;
    expect(after.status).toBe("stopped");
    expect(liveMap(manager).size).toBe(0);
    await manager.whenIdle();
    await manager.shutdown();
  });

  it("drops pending child results when an abandoned stop ends the record", async () => {
    const { manager, registry, record } = await wedged();
    registry.update(record.id, { pending: [{ fromId: "x", handle: "kid", summary: "s", sessionFile: "/x", at: 1 }] });
    await manager.stop(record.handle);
    expect(registry.get(record.id)!.pending ?? []).toHaveLength(0);
  });

  it("ends an interrupt as paused and keeps it resumable", async () => {
    const { manager, registry, record } = await wedged();
    const started = Date.now();
    await expect(manager.interrupt(record.handle)).resolves.toBe("paused");
    expect(Date.now() - started).toBeLessThan(5_000);
    await vi.waitFor(() => expect(registry.get(record.id)!.status).toBe("paused"), { timeout: 5_000 });
    expect(registry.get(record.id)!.sessionFile).toBeTruthy();
  });

  it("bounds interruptAll instead of waiting on a child that ignores abort", async () => {
    const { manager, registry, record } = await wedged();
    const started = Date.now();
    await expect(manager.interruptAll()).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    await vi.waitFor(() => expect(registry.get(record.id)!.status).toBe("paused"), { timeout: 5_000 });
  });

  it("never downgrades a stop that ran before an interrupt", async () => {
    const { manager, registry, record } = await wedged();
    await manager.stop(record.handle);
    await manager.interruptAll();
    await vi.waitFor(() => expect(registry.get(record.id)!.status).toBe("stopped"), { timeout: 5_000 });
    expect(registry.get(record.id)!.status).toBe("stopped");
  });

  it("does not wait the grace window when the child does settle", async () => {
    const { manager, registry, runner } = setup({ hold: true, settings: { interruptGraceSeconds: 30 } });
    const run = await manager.run({ agent: "reviewer", task: "t", background: true });
    await vi.waitFor(() => expect(liveMap(manager).size).toBe(1));
    expect(runner.sessions[0]!.abortNeverSettles).toBe(false);
    const started = Date.now();
    await manager.stop(run.record.handle);
    expect(Date.now() - started).toBeLessThan(1_000);
    const after = registry.get(run.record.id)!;
    expect(after.status).toBe("stopped");
    expect(after.error ?? "").not.toMatch(/did not settle/);
  });
});
