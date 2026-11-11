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
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { manager, registry, runner, root };
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