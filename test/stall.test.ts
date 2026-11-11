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
  settle?: (outcome: unknown) => void;
  stallRequested?: boolean;
  stallReason?: string;
}

function setup(opts: { scripts?: ChildResult[][]; hold?: boolean; limit?: number; settings?: Partial<SubagentSettings>; now?: () => number } = {}) {
  const root = tempDir("stall-");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
  });
  const registry = new Registry(() => {});
  const stalls: { handle: string; reason: string }[] = [];
  const manager = new SubagentManager({
    registry,
    chainStore: new ChainStore(() => {}),
    scheduler: new Scheduler(() => opts.limit ?? 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([["reviewer", reviewer]]),
    settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings }),
    port: { sendMessage: () => {}, appendEntry: () => {} },
    receiverContextWindow: () => 200000,
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
    onStall: (record, reason) => stalls.push({ handle: record.handle, reason }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { manager, registry, runner, root, stalls };
}

const liveMap = (manager: SubagentManager): Map<string, LiveLike> =>
  (manager as unknown as { live: Map<string, LiveLike> }).live;
const onlyLive = (manager: SubagentManager): LiveLike => [...liveMap(manager).values()][0]!;
/** Drives the manager's abandonment directly, the way the stall watchdog does when the grace window expires. */
const abandon = (manager: SubagentManager, record: SubagentRecord, live: LiveLike, reason: string): void =>
  (manager as unknown as { abandon: (r: SubagentRecord, l: LiveLike, why: string) => void }).abandon.call(manager, record, live, reason);

describe("abandonment (case-01a0c29f)", () => {
  it("abandons a child whose abort never settles and lets the foreground call return", async () => {
    const { manager, registry, runner } = setup({ hold: true, settings: { interruptGraceSeconds: 1 } });
    const pending = manager.run({ agent: "reviewer", task: "stuck in bash" });
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));
    const session = runner.sessions[0]!;
    // The tool ignores the abort signal: `abort()` resolves, `prompt()` stays pending forever.
    session.abortNeverSettles = true;
    session.emitActivity({ phase: "tool", toolCallId: "call_8699", toolName: "bash", progress: false });

    abandon(manager, registry.list()[0]!, onlyLive(manager), "stalled: bash produced no progress for 45m");

    const out = await pending; // must resolve, not hang
    expect(out.record.status).toBe("paused");
    expect(registry.list()[0]!.error).toMatch(/did not settle after abort/);
    expect(liveMap(manager).size).toBe(0);
    // The wedged job is out of `work`, so whenIdle() cannot be dragged on by it.
    await manager.whenIdle();
  });

  it("a late settle after abandonment does not overwrite the status", async () => {
    const { manager, registry, runner } = setup({ hold: true });
    const pending = manager.run({ agent: "reviewer", task: "late" });
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));
    const session = runner.sessions[0]!;
    session.abortNeverSettles = true;
    abandon(manager, registry.list()[0]!, onlyLive(manager), "stalled: bash produced no progress for 45m");
    await pending;
    const before = registry.list()[0]!.usage.input;

    session.finish(); // the wedged tool finally returns

    await vi.waitFor(() => expect(registry.list()[0]!.usage.input).toBeGreaterThan(before));
    expect(registry.list()[0]!.status).toBe("paused"); // the status is not rewritten
    expect(session.disposed).toBe(true); // the wedged session was closed
  });
});

describe("interruptAll and a stopping run", () => {
  it("does not downgrade a run that is already stopping", async () => {
    const { manager, registry, runner } = setup({ hold: true });
    const r = await manager.run({ agent: "reviewer", task: "x", background: true });
    await vi.waitFor(() => expect(runner.sessions[0]!.prompts).toHaveLength(1));
    // An abort that does not settle the child keeps the run live while its stop is in flight.
    runner.sessions[0]!.abort = async () => {
      runner.sessions[0]!.aborted++;
    };
    const stopping = manager.stop(r.record.handle);

    expect(await manager.interruptAll()).toBe(0);
    expect(onlyLive(manager).intent).toBe("stop");
    await stopping;
    expect(registry.list()[0]!.status).toBe("stopped");

    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(registry.list()[0]!.status).toBe("stopped");
  });
});
describe("stall budgets", () => {
  /** One held run with a single tool call in flight; the clock is the only thing that moves. */
  async function started(settings: Partial<SubagentSettings>, clock: { t: number }) {
    const ctx = setup({ hold: true, now: () => clock.t, settings: { interruptGraceSeconds: 1, ...settings } });
    const out = ctx.manager.run({ agent: "reviewer", task: "go" });
    await vi.waitFor(() => expect(ctx.manager.activitySnapshot().size).toBe(1));
    return { ...ctx, out, session: ctx.runner.sessions[0]! };
  }

  it("pauses a run whose tool call shows no progress past the budget", async () => {
    const clock = { t: 1_000_000 };
    const { manager, registry, session, stalls, out } = await started({ toolIdleTimeoutMinutes: 10 }, clock);
    session.emitActivity({ phase: "tool", toolCallId: "c1", toolName: "bash", progress: false });
    clock.t += 11 * 60_000;

    expect(manager.checkStalls()).toBe(1);
    // Only an interrupt: the run is paused (resumable), never stopped, and abort is asked for exactly once.
    expect(onlyLive(manager).intent).toBe("interrupt");
    expect(session.aborted).toBe(1);
    await vi.waitFor(() => expect(registry.list()[0]!.status).toBe("paused"));
    expect(registry.list()[0]!.error).toMatch(/bash/);
    expect(registry.list()[0]!.error).toMatch(/c1/);
    expect(stalls.map((s) => s.handle)).toEqual(["reviewer"]);
    expect(stalls[0]!.reason).toMatch(/bash/);
    await out;
  });

  it("a non-empty update keeps the call alive; an empty one does not", async () => {
    const clock = { t: 1_000_000 };
    const first = await started({ toolIdleTimeoutMinutes: 10 }, clock);
    first.session.emitActivity({ phase: "tool", toolCallId: "c1", toolName: "bash", progress: false });
    clock.t += 8 * 60_000;
    first.session.emitActivity({ phase: "tool", toolCallId: "c1", toolName: "bash", progress: true }); // real output
    clock.t += 8 * 60_000;
    expect(first.manager.checkStalls()).toBe(0); // refreshed by the progress update
    clock.t += 3 * 60_000;
    expect(first.manager.checkStalls()).toBe(1); // 11m since the last real output
    await first.out;

    // bash announces the call with an empty update the moment it starts: that must not count as progress (F7).
    const second = await started({ toolIdleTimeoutMinutes: 10 }, clock);
    second.session.emitActivity({ phase: "tool", toolCallId: "c1", toolName: "bash", progress: false });
    clock.t += 11 * 60_000;
    second.session.emitActivity({ phase: "tool", toolCallId: "c1", toolName: "bash", progress: false });
    expect(second.manager.checkStalls()).toBe(1);
    await second.out;
  });

  it("judges parallel calls per toolCallId: A progressing, B stalled -> B fires", async () => {
    const clock = { t: 1_000_000 };
    const { manager, registry, session, out } = await started({ toolIdleTimeoutMinutes: 10 }, clock);
    session.emitActivity({ phase: "tool", toolCallId: "a", toolName: "grep", progress: false });
    session.emitActivity({ phase: "tool", toolCallId: "b", toolName: "bash", progress: false });
    clock.t += 9 * 60_000;
    session.emitActivity({ phase: "tool", toolCallId: "a", toolName: "grep", progress: true }); // A is alive
    clock.t += 2 * 60_000; // B: 11m, A: 2m

    expect(manager.checkStalls()).toBe(1);
    await vi.waitFor(() => expect(registry.list()[0]!.status).toBe("paused"));
    expect(registry.list()[0]!.error).toMatch(/bash/); // the stalled call, not the busy one
    expect(registry.list()[0]!.error).not.toMatch(/grep/);
    await out;
  });

  it("returns to the model phase when the tool call ends", async () => {
    const clock = { t: 1_000_000 };
    const { manager, session, out } = await started({ toolIdleTimeoutMinutes: 10 }, clock);
    session.emitActivity({ phase: "tool", toolCallId: "c1", toolName: "bash", progress: false });
    session.emitActivity({ phase: "model" }); // tool_execution_end
    clock.t += 60 * 60_000;
    expect(manager.checkStalls()).toBe(0);
    await manager.interruptAll();
    await out;
  });

  it("the hard turn budget never refreshes on activity", async () => {
    const clock = { t: 1_000_000 };
    const { manager, session, out } = await started({ toolIdleTimeoutMinutes: 0, turnHardTimeoutMinutes: 10 }, clock);
    for (let minute = 1; minute <= 10; minute++) {
      session.emitActivity({ phase: "tool", toolCallId: `t${minute}`, toolName: "bash", progress: true });
      clock.t += 60_000;
      // Ten minutes of tool activity do not buy a single extra minute: the budget is counted from the turn start.
      expect(manager.checkStalls()).toBe(minute === 10 ? 1 : 0);
    }
    await out;
  });

  it("both budgets 0 disables the watchdog", async () => {
    const clock = { t: 1_000_000 };
    const { manager, out } = await started({ toolIdleTimeoutMinutes: 0, turnHardTimeoutMinutes: 0 }, clock);
    clock.t += 24 * 60 * 60_000;
    expect(manager.checkStalls()).toBe(0);
    await manager.interruptAll();
    await out;
  });

  it("does not touch a run that is stopping", async () => {
    const clock = { t: 1_000_000 };
    const { manager, registry, runner } = setup({ hold: true, now: () => clock.t, settings: { toolIdleTimeoutMinutes: 10, interruptGraceSeconds: 1 } });
    const r = await manager.run({ agent: "reviewer", task: "x", background: true });
    await vi.waitFor(() => expect(runner.sessions[0]!.prompts).toHaveLength(1));
    // Keep the run live after its stop was requested: an abort the child ignores.
    runner.sessions[0]!.abort = async () => {
      runner.sessions[0]!.aborted++;
    };
    const stopping = manager.stop(r.record.handle);

    clock.t += 60 * 60_000;
    expect(manager.checkStalls()).toBe(0);
    expect(onlyLive(manager).intent).toBe("stop");
    await stopping;
    expect(registry.list()[0]!.status).toBe("stopped");
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(registry.list()[0]!.status).toBe("stopped");
  });
});
