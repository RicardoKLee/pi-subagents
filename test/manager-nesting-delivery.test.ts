import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import { SubagentManager, type SettledInfo } from "../src/manager.ts";
import { type PendingResult, Registry, type SubagentRecord } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });

/** Fake clock in minutes; reminder tests advance it. Reset before every test. */
let clockMinutes = 0;
beforeEach(() => {
  clockMinutes = 0;
});

const worker: AgentDef = { name: "worker", description: "w", systemPrompt: "Work.", source: "user", filePath: "/a/worker.md" };
const lead: AgentDef = { name: "lead", description: "l", systemPrompt: "Lead.", source: "user", filePath: "/a/lead.md" };

function setup(
  opts: {
    scripts?: ChildResult[][];
    hold?: boolean;
    settings?: Partial<SubagentSettings>;
    contextWindow?: number;
    leadWindow?: number;
    limit?: number;
  } = {},
) {
  const root = tempDir("deliver-");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
  });
  const registry = new Registry(() => {});
  const scheduler = new Scheduler(() => opts.limit ?? 4);
  const reminders: { handle: string; count: number; minutes: number }[] = [];
  const errors: { handle: string; message: string }[] = [];
  const settled: SettledInfo[] = [];
  /** Everything delivered to the *main* session port; a nested group must never show up here. */
  const sent: { message: { customType: string; content: string }; options?: unknown }[] = [];
  const manager = new SubagentManager({
    registry,
    chainStore: new ChainStore(() => {}),
    scheduler,
    runners: { sdk: runner, rpc: undefined },
    agents: () =>
      new Map([
        [worker.name, worker],
        [lead.name, lead],
      ]),
    settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings }),
    port: { sendMessage: (message, options) => sent.push({ message, options }), appendEntry: () => {} },
    receiverContextWindow: () => opts.contextWindow ?? 200000,
    ...(opts.leadWindow !== undefined
      ? { receiverContextWindowFor: (agent: AgentDef) => (agent.name === "lead" ? opts.leadWindow : undefined) }
      : {}),
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
    onPendingReminder: (r, count, minutes) => reminders.push({ handle: r.handle, count, minutes }),
    onDeliveryError: (r, message) => errors.push({ handle: r.handle, message }),
    onSettled: (info) => settled.push(info),
    now: () => clockMinutes * 60_000,
  });
  return { manager, runner, registry, scheduler, reminders, errors, settled, sent, root };
}

/** A nested run: the parent record id and depth are passed the way the delegation path does it. */
const nested = (parent: { id: string; depth: number }, req: Record<string, unknown>) => ({
  ...req,
  parentId: parent.id,
  depth: parent.depth + 1,
});

describe("child result delivery", () => {
  it("continues an idle parent with the child's result in context", async () => {
    // maxResident > 0 keeps the completed parent's session parked, so "idle" can be continued in place.
    const { manager, runner } = setup({ settings: { maxResident: 2 }, scripts: [[ok("lead done")], [ok("child done")], [ok("parent continued")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    await manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await manager.whenIdle();
    const resumed = runner.sessions.find((s) => s.prompts.some((p) => p.includes("child done")));
    expect(resumed).toBeDefined();
    expect(resumed!.prompts[0]).toContain("child done");
    expect(resumed!.prompts[0]).toMatch(/@worker/);
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("never reports a nested child result to the main session", async () => {
    // maxResident keeps the parent resident, so the child result is injected into the parent instead of the main port.
    const { manager, settled } = setup({ settings: { maxResident: 2 }, scripts: [[ok("lead done")], [ok("child done")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    await manager.run(nested(parent, { agent: "worker", task: "x", background: true, delivery: "share" }) as never);
    await manager.whenIdle();
    expect(settled).toEqual([]);
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("queues a finished child while the parent is paused and delivers on resume", async () => {
    const { manager, runner, registry } = setup({ hold: true, scripts: [[ok("lead")], [ok("child")], [ok("resumed")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.interrupt(parent.handle);
    await manager.whenIdle();
    await manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    const pending = registry.get(parent.id)!.pending!;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ handle: "worker" });
    expect(runner.sessions[1]!.delivered).toEqual([]); // nothing injected while paused

    const resuming = manager.resume(parent.handle, "keep going");
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();
    await resuming;
    expect(runner.sessions[2]!.prompts[0]).toContain("child");
    expect(runner.sessions[2]!.prompts[0]).toContain("keep going");
    expect(registry.get(parent.id)!.pending ?? []).toHaveLength(0);
  });

  it("queues a foreground child when the parent was interrupted while it ran", async () => {
    const { manager, runner, registry } = setup({ hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.interrupt(parent.handle);
    await manager.whenIdle();

    // A foreground nested run (the parent's tool call is not awaiting any more: it was interrupted).
    const pendingChild = manager.run(nested(parent, { agent: "worker", task: "x" }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    const child = await pendingChild;
    expect(child.record.status).toBe("completed");
    expect(runner.sessions[1]!.delivered).toEqual([]);
    expect(registry.get(parent.id)!.pending?.map((p) => p.handle)).toEqual(["worker"]);
  });

  it("queues into a running parent instead of starting a turn", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const child = manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await child;
    // The parent is still running (held), so the result must be injected into it rather than opening a turn.
    await expect.poll(() => runner.sessions[0]!.delivered.length).toBe(1);
    expect(runner.sessions[0]!.delivered).toEqual([{ text: expect.stringContaining("child"), mode: "queue" }]);
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("moves a long result into a file for the parent", async () => {
    const big = `CHILD-${"z".repeat(3000)}`;
    const { manager, runner } = setup({ settings: { maxResident: 2 }, scripts: [[ok("lead")], [ok(big)], [ok("after")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    await manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await manager.whenIdle();
    const resumed = runner.sessions.find((s) => s.prompts.some((p) => p.includes("Full output")));
    expect(resumed).toBeDefined();
    const prompt = resumed!.prompts[0]!;
    expect(prompt).not.toContain(big);
    const file = /Full output: (\S+)/.exec(prompt)?.[1];
    expect(file).toBeTruthy();
    expect(readFileSync(file!, "utf8")).toContain("CHILD-");
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("reminds once per pending batch and can drain or drop", async () => {
    clockMinutes = 10;
    const { manager, runner, registry, reminders } = setup({ hold: true, settings: { pendingResultTimeoutMinutes: 1 }, scripts: [[ok("lead")], [ok("a")], [ok("b")], [ok("c")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.interrupt(parent.handle);
    await manager.whenIdle();
    const a = manager.run(nested(parent, { agent: "worker", task: "a", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await a;
    const b = manager.run(nested(parent, { agent: "worker", task: "b", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();
    await b;
    await manager.whenIdle();
    expect(registry.get(parent.id)!.pending).toHaveLength(2);

    clockMinutes = 15;
    expect(manager.checkPendingReminders()).toBe(1);
    expect(manager.checkPendingReminders()).toBe(0); // same batch is not repeated
    expect(reminders[0]).toMatchObject({ handle: parent.handle, count: 2 });

    const drained = await manager.drainPending(parent.handle);
    expect(drained.count).toBe(2);
    expect(drained.text).toContain("worker");
    expect(registry.get(parent.id)!.pending ?? []).toHaveLength(0);

    const c = manager.run(nested(parent, { agent: "worker", task: "c", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(4);
    runner.sessions[3]!.finish();
    await c;
    await manager.whenIdle();
    expect(manager.dropPending(parent.handle)).toBe(1);
    expect(registry.get(parent.id)!.pending ?? []).toHaveLength(0);
  });
});

describe("pending edge cases", () => {
  it("drops a child's result when the parent was stopped", async () => {
    const { manager, runner, registry } = setup({ hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.stop(parent.handle);
    await manager.whenIdle();
    const child = manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await child;
    await manager.whenIdle();
    expect(registry.get(parent.id)!.pending ?? []).toHaveLength(0);
  });

  it("keeps the result queued and reports a delivery failure", async () => {
    const { manager, runner, registry, errors } = setup({ hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const child = manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    // The parent is live; make the injection fail.
    runner.sessions[0]!.deliver = async () => {
      throw new Error("inject failed");
    };
    runner.sessions[1]!.finish();
    await child;
    await expect.poll(() => registry.get(parent.id)!.pending?.length ?? 0).toBe(1);
    expect(errors).toEqual([{ handle: parent.handle, message: expect.stringContaining("child result not delivered: inject failed") }]);
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("records the delivery failure on the parent record (REVIEW-050)", async () => {
    const { manager, runner, registry, errors } = setup({ hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const child = manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    // The parent is live; make the injection fail.
    runner.sessions[0]!.deliver = async () => {
      throw new Error("inject failed");
    };
    runner.sessions[1]!.finish();
    await child;
    await expect.poll(() => registry.get(parent.id)!.pending?.length ?? 0).toBe(1);
    // Decision 9: the failure must be recorded on the parent record too, in the same style as a child record.
    expect(registry.get(parent.id)!.error).toBe("delivery failed: inject failed");
    expect(errors).toEqual([{ handle: parent.handle, message: expect.stringContaining("child result not delivered: inject failed") }]);
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("still reports the failure when queueing the result throws (F3)", async () => {
    const { manager, runner, registry, errors } = setup({ hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const child = manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    // The parent is live; make the injection fail.
    runner.sessions[0]!.deliver = async () => {
      throw new Error("inject failed");
    };
    // Make only the queue write fail, so the failure notification is the only path left (the child's own
    // status updates and the error record must still be written through).
    const original = registry.update.bind(registry);
    const update = vi.spyOn(registry, "update").mockImplementation((id, patch) => {
      if (patch && typeof patch === "object" && "pending" in patch) throw new Error("persist failed");
      return original(id, patch);
    });
    try {
      runner.sessions[1]!.finish();
      await child;
      // The parent stays held (live), so wait for the failure report rather than for idle.
      await expect.poll(() => errors.length).toBe(1);
    } finally {
      update.mockRestore();
    }
    expect(errors).toEqual([{ handle: parent.handle, message: expect.stringContaining("child result not delivered: inject failed") }]);
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("does not remind before the timeout", async () => {
    clockMinutes = 100;
    const { manager, runner, reminders } = setup({ hold: true, settings: { pendingResultTimeoutMinutes: 30 }, scripts: [[ok("lead")], [ok("a")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.interrupt(parent.handle);
    await manager.whenIdle();
    const a = manager.run(nested(parent, { agent: "worker", task: "a", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await a;
    await manager.whenIdle();
    clockMinutes = 105; // 5 minutes later, still under the 30 minute threshold
    expect(manager.checkPendingReminders()).toBe(0);
    expect(reminders).toEqual([]);
  });

  it("returns the empty text when nothing is waiting", async () => {
    const { manager } = setup({ scripts: [[ok("lead")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    expect(await manager.drainPending(parent.handle)).toEqual({ text: "no child results are waiting", count: 0 });
    expect(manager.dropPending(parent.handle)).toBe(0);
  });

  it("leaves the parent's status unchanged when its waiting results are drained or dropped", async () => {
    const { manager, runner, registry } = setup({ hold: true, scripts: [[ok("lead")], [ok("a")], [ok("b")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.interrupt(parent.handle);
    await manager.whenIdle();
    const a = manager.run(nested(parent, { agent: "worker", task: "a", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await a;
    await manager.whenIdle();
    expect(registry.get(parent.id)!.status).toBe("paused");

    // drain only clears the queue: it must not resume (or otherwise settle) the paused parent.
    expect((await manager.drainPending(parent.handle)).count).toBe(1);
    expect(registry.get(parent.id)!.status).toBe("paused");

    // A second waiting result, dropped rather than drained, leaves the status untouched as well.
    const b = manager.run(nested(parent, { agent: "worker", task: "b", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();
    await b;
    await manager.whenIdle();
    expect(registry.get(parent.id)!.status).toBe("paused");
    expect(manager.dropPending(parent.handle)).toBe(1);
    expect(registry.get(parent.id)!.status).toBe("paused");
  });

  it("sizes a child result by the parent agent's own window", async () => {
    const summary = "s".repeat(2000);
    const entry = { fromId: "x", handle: "worker", summary, sessionFile: "/s", at: 0 };

    const small = setup({ leadWindow: 1000, scripts: [[ok("lead")]] });
    const { record: smallParent } = await small.manager.run({ agent: "lead", task: "plan" });
    const smallText = small.manager.childResultsText(smallParent, [entry]);
    const file = /Full output \(\d+ tokens\) saved to (\S+)\./.exec(smallText)?.[1];
    expect(file).toBeTruthy();
    expect(readFileSync(file!, "utf8")).toContain(summary);

    // Without a per-agent window the fallback (200000) is used, so the same summary stays inline.
    const wide = setup({ scripts: [[ok("lead")]] });
    const { record: wideParent } = await wide.manager.run({ agent: "lead", task: "plan" });
    const wideText = wide.manager.childResultsText(wideParent, [entry]);
    expect(wideText).toContain(summary);
    expect(wideText).not.toContain("Full output");
  });

  it("queues a child result when the parent's session was closed instead of reopening it", async () => {
    // maxResident 0 (the default here) closes the parent's session once its run ends: there is no resident session to
    // continue, so the result must wait for an explicit resume/drain rather than silently reopen the parent.
    const { manager, runner, registry } = setup({ scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    await manager.whenIdle();
    expect(runner.sessions).toHaveLength(1);

    const child = manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await child;
    await manager.whenIdle();

    expect(registry.get(parent.id)!.pending).toHaveLength(1);
    expect(registry.get(parent.id)!.pending![0]!.handle).toBe("worker");
    expect(runner.sessions).toHaveLength(2); // the parent was not silently reopened
  });
});

describe("foreground delegation yields the scheduler slot", () => {
  it("sizes drained results for the caller while internal delivery uses the parent's window", async () => {
    const big = `CHILD-${"z".repeat(3000)}`;
    // The caller (main session) has a small window, the parent agent's model window is large, the parent stays resident.
    const { manager, runner, registry } = setup({ hold: true, settings: { maxResident: 4 }, contextWindow: 500, leadWindow: 200_000, scripts: [[ok("lead")], [ok(big)], [ok(big)]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    // The parked session must look like it is still at the record's leaf, or delivery would open a fresh session.
    runner.sessions[0]!.leafId = "leaf-parent";
    runner.sessions[0]!.finish();
    await expect.poll(() => runner.sessions[0]!.prompts.length).toBe(1);

    await manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    runner.sessions[1]!.finish();
    // Delivery resumes the resident parent: its large window keeps the merged text inline (no extra file).
    await expect.poll(() => runner.sessions[0]!.prompts.length).toBe(2);
    expect(runner.sessions[0]!.prompts[1]).toContain("worker-run1");
    expect(runner.sessions[0]!.prompts[1]).not.toContain("lead-child-results");

    // Pause that delivered turn, then let another child finish: it must queue instead of injecting.
    await manager.interrupt(parent.handle);
    await manager.whenIdle();
    await manager.run(nested(parent, { agent: "worker", task: "b", background: true }) as never);
    runner.sessions[2]!.finish();
    await expect.poll(() => (registry.get(parent.id)!.pending ?? []).length).toBe(1);
    // A caller with a small window gets the merged text moved to a file instead.
    const drained = await manager.drainPending(parent.handle);
    expect(drained.text).toContain("lead-child-results");
    expect(registry.get(parent.id)!.pending ?? []).toHaveLength(0);
  });

  it("yields the parent's slot while it waits for a child", async () => {
    const { manager, runner, scheduler } = setup({ limit: 1, hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    expect(scheduler.running).toBe(1); // the parent holds the only slot

    const delegating = manager.delegate(parent.id, { action: "run", agent: "worker", task: "x" });
    // The parent gave up its slot before waiting, so the child is the one holding it (maxConcurrent 1).
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(runner.sessions[1]!.prompts).toEqual(["x"]);
    expect(scheduler.running).toBe(1);

    runner.sessions[1]!.finish();
    await delegating;
    // The child released its slot and the parent re-acquired it: exactly one holder again, no deadlock.
    expect(scheduler.running).toBe(1);

    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
  });

  it("lets two concurrent foreground delegations from one parent both resolve (REVIEW-046)", async () => {
    const { manager, runner, scheduler } = setup({ limit: 1, hold: true, scripts: [[ok("lead")], [ok("a")], [ok("b")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    expect(scheduler.running).toBe(1);

    // pi runs the calls of one assistant message in parallel: two foreground delegations race for one slot.
    const first = manager.delegate(parent.id, { action: "run", agent: "worker", task: "a" });
    const second = manager.delegate(parent.id, { action: "run", agent: "worker", task: "b" });

    // Both share the parent's one yielded slot, so the children open one at a time.
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(scheduler.running).toBe(1);
    runner.sessions[1]!.finish();
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ text: expect.stringContaining("@worker") }),
      expect.objectContaining({ text: expect.stringContaining("@worker") }),
    ]);
    // The last delegation handed the single grant back to the still-live parent: exactly one holder, no leaked grant.
    expect(scheduler.running).toBe(1);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
  });

  it("releases the yielded slot instead of rebinding it after the parent finished (REVIEW-046)", async () => {
    const { manager, runner, scheduler, registry } = setup({ limit: 1, hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const delegating = manager.delegate(parent.id, { action: "run", agent: "worker", task: "x" });
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(scheduler.running).toBe(1); // the child holds the parent's yielded slot

    // The parent's turn ends while its child is still running: its live object is gone when the child finishes.
    runner.sessions[0]!.finish();
    await expect.poll(() => registry.get(parent.id)!.status).toBe("completed");
    runner.sessions[1]!.finish();
    await expect(delegating).resolves.toMatchObject({ text: expect.stringContaining("@worker") });
    // The re-acquired grant was immediately released: a finished parent must not keep (or leak) a slot.
    expect(scheduler.running).toBe(0);
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
  });

  it("never yields for list, steer, interrupt or stop (REVIEW-049)", async () => {
    const { manager, runner, scheduler } = setup({ limit: 3, hold: true, scripts: [[ok("lead")], [ok("a")], [ok("b")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const a = await manager.run(nested(parent, { agent: "worker", task: "a", background: true }) as never);
    const b = await manager.run(nested(parent, { agent: "worker", task: "b", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(3);

    // These actions act on an existing record and never wait for a child run, so the parent keeps its slot.
    const acquire = vi.spyOn(scheduler, "acquire");
    try {
      await manager.delegate(parent.id, { action: "list" });
      await manager.delegate(parent.id, { action: "steer", handle: a.record.handle, message: "hurry" });
      await manager.delegate(parent.id, { action: "interrupt", handle: a.record.handle });
      await manager.delegate(parent.id, { action: "stop", handle: b.record.handle });
      expect(acquire).not.toHaveBeenCalled();
      // Both children settled from the interrupt/stop, so only the parent's original grant is left and it was
      // never released and re-acquired.
      expect(scheduler.running).toBe(1);
    } finally {
      acquire.mockRestore();
    }
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
  });

  it("resolves two concurrent foreground delegations before a deadline and drains the queue (REVIEW-046)", async () => {
    const { manager, runner, scheduler } = setup({ limit: 1, hold: true, scripts: [[ok("lead")], [ok("a")], [ok("b")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    expect(scheduler.running).toBe(1); // the parent holds the only slot

    const first = manager.delegate(parent.id, { action: "run", agent: "worker", task: "a" });
    const second = manager.delegate(parent.id, { action: "run", agent: "worker", task: "b" });
    // Both share the parent's one yielded grant: child a takes it, child b waits without a second release.
    expect(scheduler.queued).toBe(1);
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(scheduler.running).toBe(1);
    runner.sessions[1]!.finish();
    await expect.poll(() => runner.sessions.length).toBe(3);
    expect(scheduler.queued).toBe(0);
    runner.sessions[2]!.finish();

    // An uncoordinated release/re-acquire per delegation deadlocks here: the loser queues behind the winner's own
    // re-acquired grant, which only the parent's finished turn can release. The deadline turns that hang into a
    // failing assertion instead of a stalled worker.
    const settled = await Promise.race([
      Promise.all([first, second]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("concurrent foreground delegations deadlocked")), 2000)),
    ]);
    expect(settled).toEqual([
      expect.objectContaining({ text: expect.stringContaining("@worker") }),
      expect.objectContaining({ text: expect.stringContaining("@worker") }),
    ]);
    // The last delegation handed the single grant back to the still-live parent: no leaked and no extra holder.
    expect(scheduler.running).toBe(1);
    expect(scheduler.queued).toBe(0);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
    expect(scheduler.queued).toBe(0);
  });

  it("bounds three concurrent foreground delegations and hands the shared slot back exactly once", async () => {
    const { manager, runner, scheduler } = setup({ limit: 1, hold: true, scripts: [[ok("lead")], [ok("a")], [ok("b")], [ok("c")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    // Count only what the delegations do: the parent's own grant is acquired before the spy is installed.
    const acquire = vi.spyOn(scheduler, "acquire");
    const delegations = ["a", "b", "c"].map((task) => manager.delegate(parent.id, { action: "run", agent: "worker", task }));
    // Three in-flight delegations share one yielded grant (0 -> 1 -> 1 -> 1), so the children open one at a time
    // and the other two wait rather than each queueing behind a sibling.
    expect(scheduler.queued).toBe(2);
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(scheduler.running).toBe(1);
    for (let i = 1; i <= 3; i++) {
      runner.sessions[i]!.finish();
      if (i < 3) await expect.poll(() => runner.sessions.length).toBe(i + 2);
    }

    await expect(Promise.all(delegations)).resolves.toHaveLength(3);
    // 1 -> 0 only on the first in-flight delegation and 1 -> 0 only on the last: three children plus one re-acquire.
    expect(acquire).toHaveBeenCalledTimes(4);
    expect(scheduler.running).toBe(1);
    expect(scheduler.queued).toBe(0);
    acquire.mockRestore();
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
  });

  it("shares no yield with a background delegation running alongside a foreground one", async () => {
    const { manager, runner, scheduler } = setup({ limit: 2, hold: true, scripts: [[ok("lead")], [ok("bg")], [ok("fg")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    expect(scheduler.running).toBe(1);

    // A background delegation returns once its child is detached and never gives the parent's slot up: the only
    // acquire is the child's own grant, where a yielded delegation would add a release and a second acquire.
    const bgAcquire = vi.spyOn(scheduler, "acquire");
    const background = manager.delegate(parent.id, { action: "run", agent: "worker", task: "bg", background: true });
    await background;
    expect(bgAcquire).toHaveBeenCalledTimes(1);
    bgAcquire.mockRestore();
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(scheduler.running).toBe(2); // the parent kept its grant and the detached child took the second one
    expect(scheduler.queued).toBe(0);

    // The foreground delegation does yield the parent's grant and re-acquires it exactly once when its child is done.
    const fgAcquire = vi.spyOn(scheduler, "acquire");
    const foreground = manager.delegate(parent.id, { action: "run", agent: "worker", task: "fg" });
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();
    await expect(foreground).resolves.toMatchObject({ text: expect.stringContaining("@worker") });
    expect(fgAcquire).toHaveBeenCalledTimes(2); // the child's grant plus the single re-acquire
    fgAcquire.mockRestore();
    expect(scheduler.running).toBe(2); // the parent re-acquired its grant; the background child still holds one

    runner.sessions[1]!.finish();
    await expect.poll(() => scheduler.running).toBe(1); // the detached child released its grant; only the parent is left
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
  });

  it("releases the re-acquired slot when the parent is stopped while its child is in flight", async () => {
    const { manager, runner, scheduler, registry } = setup({ limit: 1, hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const delegating = manager.delegate(parent.id, { action: "run", agent: "worker", task: "x" });
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(scheduler.running).toBe(1); // the child holds the parent's yielded slot

    // The parent's turn ends before the child returns: the original grant is already released, so only the child's
    // own release and the last delegation's re-acquire decide the final count.
    await manager.stop(parent.handle);
    await expect.poll(() => registry.get(parent.id)!.status).toBe("stopped");
    runner.sessions[1]!.finish();
    await expect(delegating).resolves.toMatchObject({ text: expect.stringContaining("@worker") });
    await manager.whenIdle();

    // The re-acquired grant found no live run and was released at once: no leaked and no queued slot.
    expect(scheduler.running).toBe(0);
    expect(scheduler.queued).toBe(0);
  });
});

describe("background delegation is fire-and-forget", () => {
  it("returns a queued handle instead of deadlocking under maxConcurrent 1 (LATENT-046-BG)", async () => {
    const { manager, runner, registry, scheduler } = setup({ limit: 1, hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    expect(scheduler.running).toBe(1); // the parent holds the only slot

    // The parent's own turn is blocked on this tool call, so the call must not wait for a slot the parent holds.
    const started = await Promise.race([
      manager.delegate(parent.id, { action: "run", agent: "worker", task: "x", background: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("background delegation deadlocked under maxConcurrent 1")), 2000)),
    ]);
    expect(started.text).toContain("@worker");
    // The child queues behind the parent's slot instead of starting, and the parent keeps its single grant.
    expect(scheduler.running).toBe(1);
    expect(scheduler.queued).toBe(1);
    expect(runner.sessions).toHaveLength(1);
    const child = manager.descendants(parent.id)[0]!;
    expect(child.status).toBe("queued");

    // The parent's turn ends, freeing the slot: the detached child starts, opens its session and settles.
    runner.sessions[0]!.finish();
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(runner.sessions[1]!.prompts).toEqual(["x"]);
    expect(scheduler.running).toBe(1);
    expect(scheduler.queued).toBe(0);
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    expect(registry.get(child.id)!.status).toBe("completed");
    expect(scheduler.running).toBe(0);
    expect(scheduler.queued).toBe(0);
  });

  it("returns a background resume handle instead of deadlocking under maxConcurrent 1", async () => {
    const opts = { limit: 2, hold: true, scripts: [[ok("lead")], [ok("child")], [ok("again")]] };
    const { manager, runner, registry, scheduler } = setup(opts);
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.delegate(parent.id, { action: "run", agent: "worker", task: "x", background: true });
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish(); // the child finishes and becomes resumable
    const child = manager.descendants(parent.id)[0]!;
    await expect.poll(() => registry.get(child.id)!.status).toBe("completed");

    // Drop the limit to 1 while the parent still holds its slot: resuming must not wait for that slot.
    opts.limit = 1;
    expect(scheduler.running).toBe(1);
    const resumed = await Promise.race([
      manager.delegate(parent.id, { action: "resume", handle: child.handle, message: "again", background: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("background resume deadlocked under maxConcurrent 1")), 2000)),
    ]);
    expect(resumed.text).toContain(`@${child.handle}`);
    expect(runner.sessions).toHaveLength(2); // the resumed child is queued behind the parent, not opened

    runner.sessions[0]!.finish();
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
    expect(scheduler.queued).toBe(0);
  });

  it("returns the run already started when a background delegation has a free slot", async () => {
    const { manager, runner, scheduler } = setup({ limit: 2, hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    expect(scheduler.running).toBe(1); // the parent holds one of the two slots

    const started = await manager.delegate(parent.id, { action: "run", agent: "worker", task: "x", background: true });

    // With a free slot the background run keeps its normal semantics: it starts synchronously and comes back running.
    // The queued-handle shortcut applies only when no slot is free (LATENT-046-BG).
    expect(started.details.status).toBe("running");
    expect(scheduler.running).toBe(2);
    expect(scheduler.queued).toBe(0);
    expect(runner.sessions).toHaveLength(2);

    runner.sessions[1]!.finish();
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
    expect(scheduler.queued).toBe(0);
  });

  it("derives detach from background and drops a forged copy in a delegation payload (LATENT-046-BG)", async () => {
    const { manager, runner, scheduler } = setup({ limit: 2, hold: true, scripts: [[ok("lead")], [ok("child")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const run = vi.spyOn(manager, "run");

    // A forged `detach` without `background` must never reach the manager's request: the flag is derived from the
    // validated `background` field only, so the run stays an ordinary foreground delegation.
    const foreground = manager.delegate(parent.id, { action: "run", agent: "worker", task: "x", detach: true } as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    expect(run.mock.calls[0]![0]).not.toHaveProperty("detach");
    runner.sessions[1]!.finish();
    await expect(foreground).resolves.toMatchObject({ text: expect.stringContaining("@worker") });

    // The same field, honestly derived from `background: true`, is the one that reaches the manager.
    await manager.delegate(parent.id, { action: "run", agent: "worker", task: "y", background: true });
    expect(run.mock.calls[1]![0]).toMatchObject({ background: true, detach: true });
    run.mockRestore();

    runner.sessions[2]!.finish();
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(scheduler.running).toBe(0);
    expect(scheduler.queued).toBe(0);
  });
});

describe("nested batch result routing", () => {
  it("routes a nested background group summary to its parent, not the main session", async () => {
    const { manager, runner, sent } = setup({ hold: true, scripts: [[ok("lead")], [ok("a")], [ok("b")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    const group = manager.runParallel({
      items: [
        { agent: "worker", task: "a" },
        { agent: "worker", task: "b" },
      ],
      parentId: parent.id,
      background: true,
    });
    await group;
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[1]!.finish();
    runner.sessions[2]!.finish();
    // The parent stays held; wait for the group to arrive in its context rather than for whenIdle (which would wait
    // for the parent's own turn too).
    await expect.poll(() => runner.sessions[0]!.delivered.length).toBe(1);

    // The group summary reaches the live parent's own context; the main session port stays untouched.
    expect(runner.sessions[0]!.delivered[0]!.text).toContain("Parallel: 2/2 succeeded");
    expect(sent).toEqual([]);
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("routes a nested background chain summary to its parent, not the main session", async () => {
    const { manager, runner, sent } = setup({ hold: true, scripts: [[ok("lead")], [ok("a")], [ok("b")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.runChain({
      steps: [
        { agent: "worker", task: "a" },
        { agent: "worker", task: "b {previous}" },
      ],
      parentId: parent.id,
      background: true,
    });
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await expect.poll(() => runner.sessions.length).toBe(3);
    runner.sessions[2]!.finish();
    await expect.poll(() => runner.sessions[0]!.delivered.length).toBe(1);

    expect(runner.sessions[0]!.delivered[0]!.text).toContain("Chain completed (2/2 steps)");
    expect(sent).toEqual([]);
    await manager.shutdown();
    await manager.whenIdle();
  });
});

describe("pending reminder watch", () => {
  it("starts the watch unref'd once and stops it when the queue empties", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan", background: true });
    await manager.interrupt(parent.handle);
    await manager.whenIdle();
    const child = manager.run(nested(parent, { agent: "worker", task: "x", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);

    // Capture the timer the watch installs: it must be unref'd so it never keeps the process alive on its own.
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeTimer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    try {
      runner.sessions[1]!.finish();
      await child;
      await manager.whenIdle();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);

      // With nothing left queued, the next pass stops the watch (no timer keeps ticking for an empty queue).
      await manager.drainPending(parent.handle);
      expect(manager.checkPendingReminders()).toBe(0);
      expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      await manager.shutdown();
      await manager.whenIdle();
    }
  });
});

describe("registry pending persistence (REVIEW-018)", () => {
  const newRecord = (pending?: PendingResult[]) => ({
    agent: "worker",
    preferredHandle: "worker",
    runner: "sdk" as const,
    depth: 0,
    sessionFile: "/f",
    delivery: "auto" as const,
    task: "t",
    ...(pending ? { pending } : {}),
  });
  const entry = (): PendingResult => ({ fromId: "x", handle: "worker", summary: "orig", sessionFile: "/s", at: 1 });

  it("deep-copies pending results on create", () => {
    const registry = new Registry(() => {});
    const input = entry();
    const record = registry.create(newRecord([input]));
    // Mutating the caller's array element must not reach the stored record.
    input.summary = "mutated";
    expect(registry.get(record.id)!.pending).toEqual([{ ...input, summary: "orig" }]);
  });

  it("persists pendingNotifiedAt without overwriting the pending queue", () => {
    const persisted: SubagentRecord[] = [];
    const registry = new Registry((r) => persisted.push(structuredClone(r)));
    const record = registry.create(newRecord());
    registry.update(record.id, { pending: [entry()] });
    registry.update(record.id, { pendingNotifiedAt: 123 });

    const got = registry.get(record.id)!;
    expect(got.pending).toHaveLength(1);
    expect(got.pending![0]!.summary).toBe("orig");
    expect(got.pendingNotifiedAt).toBe(123);

    // The last persisted snapshot carries both fields, so a reload keeps the queue and the reminder dedupe marker.
    const last = persisted.at(-1)!;
    expect(last.pending).toHaveLength(1);
    expect(last.pendingNotifiedAt).toBe(123);
  });
});