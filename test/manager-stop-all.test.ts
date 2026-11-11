import { writeFileSync } from "node:fs";
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

function setup(opts: { scripts?: ChildResult[][]; hold?: boolean; limit?: number; settings?: Partial<SubagentSettings> } = {}) {
  const root = tempDir("stop-all-");
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
  });
  return { manager, registry, runner, root };
}

const statusOf = (registry: Registry, handle: string): string | undefined => registry.resolve(handle)?.status;
/** The live run of a record, for asserting the intent a mass action must not downgrade. */
const liveOf = (manager: SubagentManager, id: string): { intent?: string } | undefined =>
  (manager as unknown as { live: Map<string, { intent?: string }> }).live.get(id);

describe("SubagentManager.stopAll", () => {
  it("stops every active record and leaves paused ones resumable", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], [], [], []] });
    const pending = manager.run({ agent: "reviewer", task: "a" });
    await vi.waitFor(() => expect(registry.list().find((r) => r.task === "a")?.status).toBe("running"));
    const b = await manager.run({ agent: "reviewer", task: "b", background: true });
    const c = await manager.run({ agent: "reviewer", task: "c", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(3));
    await manager.interrupt(b.record.handle);
    await manager.interrupt(c.record.handle);
    await vi.waitFor(() => expect(statusOf(registry, b.record.handle)).toBe("paused"));
    await vi.waitFor(() => expect(statusOf(registry, c.record.handle)).toBe("paused"));

    // Only `a` is still active; the two paused records must keep their resumable status.
    const out = await manager.stopAll();
    expect(out.stopped).toBe(1);
    expect(out.cancelled).toBe(0);
    expect(out.handles).toHaveLength(1);
    expect(out.handles[0]!.wasQueued).toBe(false);
    expect((await pending).record.status).toBe("stopped");
    expect(statusOf(registry, b.record.handle)).toBe("paused");
    expect(statusOf(registry, c.record.handle)).toBe("paused");

    // Idempotent: nothing is active any more.
    expect(await manager.stopAll()).toEqual({ stopped: 0, cancelled: 0, handles: [] });
    expect(statusOf(registry, c.record.handle)).toBe("paused");
  });

  it("cascades once through a parent and its live child", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], [], []] });
    const parent = await manager.run({ agent: "reviewer", task: "p", background: true });
    await manager.delegate(parent.record.id, { action: "run", agent: "reviewer", task: "kid", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2));
    const kid = registry.list().find((r) => r.task === "kid")!;
    expect(kid.parentId).toBe(parent.record.id);
    expect(kid.status).toBe("running");

    const out = await manager.stopAll();
    expect(out.handles.map((h) => h.handle).sort()).toEqual([kid.handle, parent.record.handle].sort());
    expect(statusOf(registry, parent.record.handle)).toBe("stopped");
    expect(statusOf(registry, kid.handle)).toBe("stopped");
    // The child is aborted by its own stop only: the parent's cascade must not abort it a second time.
    expect(runner.sessions[1]!.aborted).toBe(1);
  });

  it("counts a queued record as cancelled", async () => {
    const { manager, registry, runner } = setup({ hold: true, limit: 1, scripts: [[], []] });
    const holder = await manager.run({ agent: "reviewer", task: "holds", background: true });
    // A background run waits for the only slot, so it is queued; the call itself has not returned yet.
    const waiting = manager.run({ agent: "reviewer", task: "waits", background: true });
    await vi.waitFor(() => expect(registry.list().find((r) => r.task === "waits")?.status).toBe("queued"));
    const queued = registry.list().find((r) => r.task === "waits")!;

    const out = await manager.stopAll();
    expect(out.cancelled).toBe(1);
    expect(out.handles.find((h) => h.handle === queued.handle)).toEqual({ handle: queued.handle, wasQueued: true });
    expect(statusOf(registry, queued.handle)).toBe("stopped");
    expect(statusOf(registry, holder.record.handle)).toBe("stopped");
    await expect(waiting).rejects.toThrow(/cancelled before it started/);
    // The queued run never opened a child session.
    expect(runner.sessions).toHaveLength(1);
  });

  it("ignores completed and stopped records", async () => {
    const { manager, registry } = setup({ scripts: [[ok("done")], [ok("gone")]] });
    await manager.run({ agent: "reviewer", task: "finished" });
    const gone = await manager.run({ agent: "reviewer", task: "ended" });
    await manager.stop(gone.record.handle);

    expect(await manager.stopAll()).toEqual({ stopped: 0, cancelled: 0, handles: [] });
    expect(registry.list().map((r) => r.status)).toEqual(["completed", "stopped"]);
  });

  it("cancels a restart that is still claiming a record, so nothing starts mid-stop", async () => {
    const { manager, registry, runner } = setup({ hold: true, limit: 1, scripts: [[], [], []] });
    // One paused record, then a live run that holds the only slot.
    const earlier = await manager.run({ agent: "reviewer", task: "paused one", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    await manager.interrupt(earlier.record.handle);
    await vi.waitFor(() => expect(statusOf(registry, earlier.record.handle)).toBe("paused"));
    const holder = await manager.run({ agent: "reviewer", task: "holds the only slot", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2));

    // No slot is free, so this restart only claims its record: it is "running" without a child session yet.
    const claiming = await manager.restart(earlier.record.handle, { background: true });
    expect(claiming.record.status).toBe("running");
    expect(runner.sessions).toHaveLength(2);

    const out = await manager.stopAll();

    expect(out.stopped).toBe(2); // the claim is a target too, not only the live run
    expect(statusOf(registry, earlier.record.handle)).toBe("stopped");
    expect(statusOf(registry, holder.record.handle)).toBe("stopped");
    // The claim was aborted before it opened anything: no third session, no "running" leak.
    await manager.whenIdle();
    expect(runner.sessions).toHaveLength(2);
    expect(registry.list().map((r) => r.status)).toEqual(["stopped", "stopped"]);
  });

  it("settles a chain whose running step it stopped", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const chain = await manager.runChain({ steps: [{ agent: "reviewer", task: "one" }, { agent: "reviewer", task: "two" }], background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    const chainId = chain.chain!.id;
    const step = registry.get(manager.listChains().find((c) => c.id === chainId)!.stepRecordIds[0]!)!;
    expect(step.status).toBe("running");

    const out = await manager.stopAll();
    expect(out.stopped).toBe(1);
    await manager.whenIdle();
    expect(registry.get(step.id)!.status).toBe("stopped");
    expect(manager.listChains().find((c) => c.id === chainId)!.status).toBe("stopped");
    // The chain did not start its second step.
    expect(runner.sessions).toHaveLength(1);
  });

  it("stops the rest and rethrows the first failure", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    await manager.run({ agent: "reviewer", task: "a", background: true });
    await manager.run({ agent: "reviewer", task: "b", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2));
    const failing = runner.sessions[0]!;
    const finish = failing.finish.bind(failing);
    failing.abort = async () => {
      failing.aborted++;
      finish();
      throw new Error("abort failed");
    };

    await expect(manager.stopAll()).rejects.toThrow(/abort failed/);
    expect(registry.list().map((r) => r.status)).toEqual(["stopped", "stopped"]);
  });

  it("does not double-mark when stop-all races a stop", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const a = await manager.run({ agent: "reviewer", task: "a", background: true });
    await manager.run({ agent: "reviewer", task: "b", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2));

    const results = await Promise.allSettled([manager.stopAll(), manager.stop(a.record.handle)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(registry.list().map((r) => r.status)).toEqual(["stopped", "stopped"]);
  });
});

describe("SubagentManager.interruptAll", () => {
  it("leaves a run that is already stopping alone and returns the paused count", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[]] });
    const r = await manager.run({ agent: "reviewer", task: "x", background: true });
    await vi.waitFor(() => expect(runner.sessions[0]!.prompts).toHaveLength(1));
    // An abort that does not settle the child keeps the run live while its stop is in flight.
    runner.sessions[0]!.abort = async () => {
      runner.sessions[0]!.aborted++;
    };
    const stopping = manager.stop(r.record.handle);

    expect(await manager.interruptAll()).toBe(0);
    expect(liveOf(manager, r.record.id)?.intent).toBe("stop");
    await stopping;
    expect(statusOf(registry, r.record.handle)).toBe("stopped");

    // Let the wedged run finish so nothing keeps the manager busy.
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(statusOf(registry, r.record.handle)).toBe("stopped");
  });

  it("pauses live runs and reports how many", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    await manager.run({ agent: "reviewer", task: "a", background: true });
    await manager.run({ agent: "reviewer", task: "b", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2));

    expect(await manager.interruptAll()).toBe(2);
    await vi.waitFor(() => expect(registry.list().map((r) => r.status)).toEqual(["paused", "paused"]));
  });
});

describe("mass actions from a delegating subagent", () => {
  it("refuses stop-all and interrupt-all without touching any record", async () => {
    const { manager, registry } = setup({ hold: true, scripts: [[]] });
    const parent = await manager.run({ agent: "reviewer", task: "p", background: true });
    await expect(manager.delegate(parent.record.id, { action: "stop-all" })).rejects.toThrow(/only the main agent can stop all subagents/);
    await expect(manager.delegate(parent.record.id, { action: "interrupt-all" })).rejects.toThrow(/only the main agent can stop all subagents/);
    expect(statusOf(registry, parent.record.handle)).toBe("running");
  });
});