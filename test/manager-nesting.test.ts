import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });

const worker: AgentDef = { name: "worker", description: "w", systemPrompt: "Work.", source: "user", filePath: "/a/worker.md" };
const lead: AgentDef = { name: "lead", description: "l", systemPrompt: "Lead.", source: "user", filePath: "/a/lead.md", allowedSubagents: ["worker"] };
const locked: AgentDef = { name: "locked", description: "x", systemPrompt: "Locked.", source: "user", filePath: "/a/locked.md", allowedSubagents: [] };
// `top` and `mid` have different whitelists so a two-level intersection has something to narrow.
const top: AgentDef = { name: "top", description: "t", systemPrompt: "Top.", source: "user", filePath: "/a/top.md", allowedSubagents: ["mid", "worker"] };
const mid: AgentDef = { name: "mid", description: "m", systemPrompt: "Mid.", source: "user", filePath: "/a/mid.md", allowedSubagents: ["helper", "worker"] };
const helper: AgentDef = { name: "helper", description: "h", systemPrompt: "Help.", source: "user", filePath: "/a/helper.md" };

function setup(opts: { scripts?: ChildResult[][]; settings?: Partial<SubagentSettings>; hold?: boolean; limit?: number } = {}) {
  const root = tempDir("nest-");
  const scripts = opts.scripts ?? [];
  let open = 0;
  const runner = new FakeRunner((spec, n) => {
    void open++;
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
    agents: () => new Map([[worker.name, worker], [lead.name, lead], [locked.name, locked], [top.name, top], [mid.name, mid], [helper.name, helper]]),
    settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings }),
    port: { sendMessage: () => {}, appendEntry: () => {} },
    receiverContextWindow: () => 200000,
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
  });
  return { manager, runner, registry, root };
}

/** A nested run: the parent record id and depth are passed the way the delegation path does it. */
const nested = (parent: { id: string; depth: number }, req: Record<string, unknown>) => ({ ...req, parentId: parent.id, depth: parent.depth + 1 });

describe("nesting attribution", () => {
  it("records parentId and depth for children, parallel items and chain steps", async () => {
    const { manager, runner } = setup({ scripts: [[ok("parent")], [ok("c1")], [ok("c2")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    const one = await manager.run(nested(parent, { agent: "worker", task: "a" }) as never);
    expect(one.record.parentId).toBe(parent.id);
    // The main session is depth 0, so its direct subagent is depth 1 and this child is depth 2.
    expect(one.record.depth).toBe(2);
    const batch = await manager.runParallel({ items: [nested(parent, { agent: "worker", task: "b" })] as never });
    expect(batch.records[0]!.parentId).toBe(parent.id);
    expect(batch.records[0]!.depth).toBe(2);
    expect(runner.opened).toHaveLength(3);
  });

  it("records a root subagent at depth 1 under the depth-0 main session", async () => {
    const { manager } = setup({ scripts: [[ok("r")]] });
    const { record: root } = await manager.run({ agent: "worker", task: "r" });
    expect(root.parentId).toBeUndefined();
    expect(root.depth).toBe(1);
  });

  it("allows a whitelist-free agent to spawn any agent", async () => {
    const { manager } = setup({ scripts: [[ok("r")], [ok("h")]] });
    // `worker` has no allowed_subagents list, so it inherits the unrestricted default from the main session.
    const { record: root } = await manager.run({ agent: "worker", task: "r" });
    const { record: child } = await manager.run(nested(root, { agent: "helper", task: "h" }) as never);
    expect(child.parentId).toBe(root.id);
    expect(child.depth).toBe(2);
  });

  it("counts the subtree usage of all descendants", async () => {
    // maxDepth 3 lets the grandchild start: this test is about subtree usage, not the depth gate.
    const { manager } = setup({ settings: { maxDepth: 3 }, scripts: [[ok("parent")], [ok("a")], [ok("b")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    const child = await manager.run(nested(parent, { agent: "worker", task: "a" }) as never);
    await manager.run(nested(child.record, { agent: "worker", task: "b" }) as never);
    expect(manager.descendants(parent.id).map((r) => r.depth)).toEqual([2, 3]);
    // usage() from the fakes is 0.01 per run
    expect(manager.subtreeUsage(parent.id).cost).toBeCloseTo(0.02);
  });

  it("attributes every chain step to the delegating parent", async () => {
    const { manager } = setup({ scripts: [[ok("p")], [ok("s1")], [ok("s2")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "p" });
    const out = await manager.runChain({
      steps: [nested(parent, { agent: "worker", task: "s1" }), nested(parent, { agent: "worker", task: "s2" })] as never,
    });
    // Both steps belong to the parent that started the chain, not to the main session.
    expect(out.records.map((r) => r.parentId)).toEqual([parent.id, parent.id]);
    expect(out.records.map((r) => r.depth)).toEqual([2, 2]);
  });
});

describe("nesting limits", () => {
  it("allows one nesting level by default and stops at the depth limit", async () => {
    const { manager } = setup({ scripts: [[ok("p")], [ok("c")]] });
    const { record: root } = await manager.run({ agent: "lead", task: "p" }); // depth 1
    const child = await manager.run(nested(root, { agent: "worker", task: "c" }) as never); // depth 2
    expect(child.record.depth).toBe(2);
    expect(manager.delegationFor(root).canDelegate).toBe(true);
    expect(manager.delegationFor(child.record).canDelegate).toBe(false); // default maxDepth is 2
    await expect(manager.run(nested(child.record, { agent: "worker", task: "g" }) as never)).rejects.toThrow(/maximum nesting depth \(maxDepth=2\)/);
  });

  it("refuses delegation when maxDepth is 1 and everything when it is 0", async () => {
    const one = setup({ settings: { maxDepth: 1 }, scripts: [[ok("p")]] });
    const { record: root } = await one.manager.run({ agent: "lead", task: "p" }); // depth 1 is the limit
    expect(one.manager.delegationFor(root).canDelegate).toBe(false);
    await expect(one.manager.run(nested(root, { agent: "worker", task: "x" }) as never)).rejects.toThrow(/maximum nesting depth \(maxDepth=1\)/);

    const zero = setup({ settings: { maxDepth: 0 } });
    expect(zero.manager.canStartSubagents()).toBe(false);
    await expect(zero.manager.run({ agent: "lead", task: "p" })).rejects.toThrow(/maximum nesting depth \(maxDepth=0\)/);
  });

  it("treats maxDepth -1 as unlimited nesting", async () => {
    const { manager } = setup({ settings: { maxDepth: -1 }, scripts: [[ok("top")], [ok("mid")], [ok("w")]] });
    const { record: ancestor } = await manager.run({ agent: "top", task: "top" });
    const { record: middle } = await manager.run(nested(ancestor, { agent: "mid", task: "mid" }) as never);
    const { record: grandchild } = await manager.run(nested(middle, { agent: "worker", task: "w" }) as never);
    expect(grandchild.depth).toBe(3);
    expect(manager.delegationFor(grandchild).canDelegate).toBe(true);
  });

  it("enforces allowed_subagents and narrows permissions down the tree", async () => {
    // maxDepth 3 keeps the depth gate out of the way: this test is about the inherited whitelist.
    const { manager } = setup({ settings: { maxDepth: 3 }, scripts: [[ok("p")], [ok("c")]] });
    const { record: root } = await manager.run({ agent: "lead", task: "p" });
    await expect(manager.run(nested(root, { agent: "locked", task: "x" }) as never)).rejects.toThrow(/does not allow spawning "locked" \(allowed: worker\)/);
    const child = await manager.run(nested(root, { agent: "worker", task: "c" }) as never);
    // `worker` has no list of its own, but its ancestor `lead` does: the restriction is inherited.
    expect(manager.delegationFor(child.record).canDelegate).toBe(true);
    await expect(manager.run(nested(child.record, { agent: "lead", task: "y" }) as never)).rejects.toThrow(/does not allow spawning "lead"/);
  });

  it("rejects skill entries when a whitelist is set and blocks agents with an empty list", async () => {
    const { manager } = setup({ scripts: [[ok("p")]] });
    const { record: root } = await manager.run({ agent: "lead", task: "p" });
    await expect(manager.run(nested(root, { skill: "pdf-tools", task: "x" }) as never)).rejects.toThrow(/does not allow spawning "skill:pdf-tools"/);
    const lockedRecord = { ...root, agent: "locked" };
    expect(manager.delegationFor(lockedRecord)).toMatchObject({ canDelegate: false });
    expect(manager.delegationFor(lockedRecord).reason).toMatch(/does not allow spawning any subagent/);
  });

  it("blocks an agent with an empty whitelist from spawning anything", async () => {
    const { manager } = setup({ scripts: [[ok("locked")]] });
    // The main session has no whitelist, so it may start `locked`; `locked` itself allows no subagent.
    const { record: lockedRecord } = await manager.run({ agent: "locked", task: "x" });
    expect(manager.delegationFor(lockedRecord).canDelegate).toBe(false);
    // The run path rejects through assertCanSpawn, whose message is bound to the empty list (allowed: none).
    await expect(manager.run(nested(lockedRecord, { agent: "worker", task: "y" }) as never)).rejects.toThrow(
      /does not allow spawning "worker" \(allowed: none\)/,
    );
  });

  it("intersects the whitelists of the whole ancestor chain", async () => {
    const { manager } = setup({ settings: { maxDepth: 3 }, scripts: [[ok("top")], [ok("mid")], [ok("w")]] });
    const { record: ancestor } = await manager.run({ agent: "top", task: "top" }); // top allows mid + worker
    const { record: middle } = await manager.run(nested(ancestor, { agent: "mid", task: "mid" }) as never); // mid allows helper + worker
    // `helper` is on `mid`'s own list but not on its ancestor `top`'s, so the intersection (worker) rejects it.
    await expect(manager.run(nested(middle, { agent: "helper", task: "x" }) as never)).rejects.toThrow(
      /does not allow spawning "helper" \(allowed: worker\)/,
    );
    const child = await manager.run(nested(middle, { agent: "worker", task: "w" }) as never);
    expect(child.record.parentId).toBe(middle.id);
    expect(child.record.depth).toBe(3);
  });

  it("rejects command entries when a whitelist is set", async () => {
    const { manager } = setup({ scripts: [[ok("p")]] });
    const { record: root } = await manager.run({ agent: "lead", task: "p" });
    await expect(manager.run(nested(root, { command: "deploy", task: "x" }) as never)).rejects.toThrow(
      /does not allow spawning "command:deploy" \(allowed: worker\)/,
    );
  });

  it("refuses a child beyond maxChildrenPerParent but not after they finish", async () => {
    const { manager, runner } = setup({ hold: true, settings: { maxChildrenPerParent: 1 }, scripts: [[ok("p")], [ok("a")], [ok("b")]] });
    // The parent runs in the background so its held prompt can be finished explicitly (the fakes hold every prompt).
    const { record: parent } = await manager.run({ agent: "lead", task: "p", background: true });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    await manager.run(nested(parent, { agent: "worker", task: "a", background: true }) as never);
    await expect(manager.run(nested(parent, { agent: "worker", task: "b", background: true }) as never)).rejects.toThrow(/already have 1 running or queued subagents \(maxChildrenPerParent=1\)/);
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    const again = await manager.run(nested(parent, { agent: "worker", task: "b", background: true }) as never);
    expect(again.record.status).toBe("running");
    runner.sessions[2]!.finish();
    await manager.whenIdle();
  });

  it("counts a queued direct child against maxChildrenPerParent", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true, settings: { maxChildrenPerParent: 1 }, scripts: [[ok("p")], [ok("a")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "p", background: true });
    // The only scheduler slot is held by the parent, so this child's record stays queued instead of running.
    const queuedChild = manager.run(nested(parent, { agent: "worker", task: "a", background: true }) as never);
    expect(manager.list().find((r) => r.parentId === parent.id)?.status).toBe("queued");
    // A queued direct child already occupies the parent's budget: the next one is refused, not queued behind it.
    await expect(manager.run(nested(parent, { agent: "worker", task: "b", background: true }) as never)).rejects.toThrow(
      /already have 1 running or queued subagents \(maxChildrenPerParent=1\)/,
    );
    // Free the slot so the queued child starts, then let it finish and settle.
    runner.sessions[0]!.finish();
    await queuedChild;
    runner.sessions[1]!.finish();
    await manager.whenIdle();
  });

  it("counts the whole parallel batch against maxChildrenPerParent and leaves no orphan records", async () => {
    const { manager, registry } = setup({ settings: { maxChildrenPerParent: 1 }, scripts: [[ok("p")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "p" });
    // Both items of one batch target the same parent; the first must be counted while the second is validated,
    // so cap=1 rejects the batch instead of starting two children from the same stale count of 0.
    await expect(
      manager.runParallel({
        items: [nested(parent, { agent: "worker", task: "a" }), nested(parent, { agent: "worker", task: "b" })] as never,
      }),
    ).rejects.toThrow(/maxChildrenPerParent=1/);
    // A rejected batch must not leave a queued record whose launch() is never reached.
    expect(registry.list().filter((r) => r.parentId === parent.id)).toHaveLength(0);
  });

  it("starts no session and leaks no reservation when a parallel batch is rejected by maxChildrenPerParent", async () => {
    const { manager, registry, runner } = setup({ settings: { maxChildrenPerParent: 1 }, scripts: [[ok("p")], [ok("a")]] });
    const { record: parent } = await manager.run({ agent: "lead", task: "p" });
    const items = [nested(parent, { agent: "worker", task: "a" }), nested(parent, { agent: "worker", task: "b" })] as never;
    await expect(manager.runParallel({ items })).rejects.toThrow(/maxChildrenPerParent=1/);
    // The rejection happens before any record or session exists: only the parent was ever started, and nothing is
    // left queued or running (a record whose launch() is never reached would sit queued forever).
    expect(runner.opened).toHaveLength(1);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list().filter((r) => r.status === "queued" || r.status === "running")).toHaveLength(0);
    expect(manager.descendants(parent.id)).toEqual([]);
    // The reservation lives in the batch, not on the manager: a later single run is not blocked by the rejected batch.
    const single = await manager.run(nested(parent, { agent: "worker", task: "a" }) as never);
    expect(single.record.parentId).toBe(parent.id);
    expect(single.record.status).toBe("completed");
    expect(runner.opened).toHaveLength(2);
    // A fresh batch validates from the current registry count again, not from a stale reservation.
    await expect(manager.runParallel({ items })).rejects.toThrow(/maxChildrenPerParent=1/);
    expect(runner.opened).toHaveLength(2);
    expect(registry.list().filter((r) => r.parentId === parent.id && (r.status === "running" || r.status === "queued"))).toHaveLength(0);
  });

  it("keeps the batch reservation per parent instead of sharing one counter", async () => {
    const { manager, runner } = setup({ settings: { maxChildrenPerParent: 1 }, scripts: [[ok("p1")], [ok("p2")], [ok("c1")], [ok("c2")]] });
    const a = await manager.run({ agent: "lead", task: "p1" });
    const b = await manager.run({ agent: "lead", task: "p2" });
    // Each parent has cap=1 and no children: both accepted items belong to different parents, so both must start.
    const out = await manager.runParallel({
      items: [nested(a.record, { agent: "worker", task: "c1" }), nested(b.record, { agent: "worker", task: "c2" })] as never,
    });
    expect(out.records.map((r) => r.parentId)).toEqual([a.record.id, b.record.id]);
    expect(runner.opened).toHaveLength(4);
  });

  it("does not apply the per-parent cap to the main session's own parallel batch", async () => {
    const { manager, runner } = setup({ settings: { maxChildrenPerParent: 1 }, scripts: [[ok("1")], [ok("2")], [ok("3")]] });
    // Root subagents have no parent record, so a global reservation counter must not leak onto them either.
    const out = await manager.runParallel({
      items: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }, { agent: "worker", task: "c" }] as never,
    });
    expect(out.records).toHaveLength(3);
    expect(out.records.every((r) => r.parentId === undefined)).toBe(true);
    expect(runner.opened).toHaveLength(3);
  });
});

describe("nesting addressing and cascade stop", () => {
  const statuses = (registry: Registry, ids: readonly string[]): string[] => ids.map((id) => registry.get(id)!.status);

  it("stops every descendant", async () => {
    const { manager, runner, registry } = setup({ hold: true, settings: { maxDepth: 3 } });
    const { record: root } = await manager.run({ agent: "top", task: "root", background: true });
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child", background: true }) as never);
    const { record: grand } = await manager.run(nested(child, { agent: "worker", task: "grand", background: true }) as never);
    expect(statuses(registry, [root.id, child.id, grand.id])).toEqual(["running", "running", "running"]);
    // The path spells out the whole ancestor chain, root first.
    expect(manager.recordPath(grand)).toBe("top/mid/worker");

    await manager.stop(root.handle);
    await manager.whenIdle();

    expect(statuses(registry, [root.id, child.id, grand.id])).toEqual(["stopped", "stopped", "stopped"]);
    // A cascade stop aborts and disposes every child session, not just the target's.
    expect(runner.sessions.map((s) => s.disposed)).toEqual([true, true, true]);
  });

  it("interrupt leaves descendants running", async () => {
    const { manager, registry } = setup({ hold: true, settings: { maxDepth: 3 } });
    const { record: root } = await manager.run({ agent: "top", task: "root", background: true });
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child", background: true }) as never);

    await manager.interrupt(root.handle);
    await expect.poll(() => registry.get(root.id)!.status).toBe("paused");
    // Decision 8: an interrupt never cascades, so the child keeps running.
    expect(registry.get(child.id)!.status).toBe("running");

    // Cleanup, explicitly per record: this test must not depend on the cascade it is checking the absence of.
    await manager.stop(child.handle);
    await manager.stop(root.handle);
    await manager.whenIdle();
  });

  it("resolves a parent/child path and reports the children when it fails", async () => {
    const { manager, registry } = setup({ settings: { maxDepth: 3 }, scripts: [[ok("root")], [ok("child")], [ok("resumed")]] });
    const { record: root } = await manager.run({ agent: "top", task: "root" });
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child" }) as never);

    // The path resolves to the same record as the bare child handle.
    const resumed = await manager.resume(`${root.handle}/${child.handle}`, "again");
    expect(resumed.record.id).toBe(child.id);
    expect(registry.get(child.id)!.runId).toBe(2);

    // A miss under a resolved parent names that parent and its direct children.
    const message = await manager.resume(`${root.handle}/nope`, "again").then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).toMatch(/no subagent ".*nope".*children of @/s);
    expect(message).toContain(`@${child.handle}`);
  });

  it("stops idempotently and discards the child results waiting for the parent", async () => {
    const { manager, runner, registry } = setup({ hold: true, settings: { maxDepth: 3 }, scripts: [[ok("lead")], [ok("child")]] });
    const { record: parent } = await manager.run({ agent: "top", task: "lead", background: true });
    await manager.interrupt(parent.handle);
    await expect.poll(() => registry.get(parent.id)!.status).toBe("paused");

    const child = manager.run(nested(parent, { agent: "mid", task: "child", background: true }) as never);
    await expect.poll(() => runner.sessions.length).toBe(2);
    runner.sessions[1]!.finish();
    await child;
    await manager.whenIdle();
    expect(registry.get(parent.id)!.pending ?? []).toHaveLength(1);

    // Decision 9: stopping the parent drops the queued child results.
    await manager.stop(parent.handle);
    expect(registry.get(parent.id)!.status).toBe("stopped");
    expect(registry.get(parent.id)!.pending ?? []).toEqual([]);
    expect(registry.get(parent.id)!.pendingNotifiedAt).toBeUndefined();

    // A second stop is a no-op: it neither throws nor changes the record.
    await expect(manager.stop(parent.handle)).resolves.toBeUndefined();
    expect(registry.get(parent.id)!.status).toBe("stopped");
  });

  it("resolves a path inside a child's own subtree but never another branch", async () => {
    const { manager, registry } = setup({ settings: { maxDepth: 4 } });
    const { record: root } = await manager.run({ agent: "top", task: "root" });
    const { record: childA } = await manager.run(nested(root, { agent: "mid", task: "childA" }) as never);
    const { record: childB } = await manager.run(nested(root, { agent: "mid", task: "childB" }) as never);
    const { record: grandA } = await manager.run(nested(childA, { agent: "worker", task: "grandA" }) as never);
    const { record: greatA } = await manager.run(nested(grandA, { agent: "worker", task: "greatA" }) as never);
    const { record: grandB } = await manager.run(nested(childB, { agent: "worker", task: "grandB" }) as never);

    // A path relative to the delegating child's own subtree resolves and addresses that record.
    const stopped = await manager.delegate(childA.id, { action: "stop", handle: `${grandA.handle}/${greatA.handle}` });
    expect(stopped.text).toContain("stopped");
    expect(registry.get(greatA.id)!.status).toBe("stopped");

    // A path that leaves that subtree is refused with the scope-only message: no parent, no sibling, no `Known:`.
    const message = await manager.delegate(childA.id, { action: "stop", handle: `${childB.handle}/${grandB.handle}` }).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).toMatch(/is not one of your subagents/);
    // The refusal names only the requested value: no global `Known:` inventory, no parent and no sibling.
    expect(message).toBe(`@${childB.handle}/${grandB.handle} is not one of your subagents`);
    expect(message).not.toMatch(/Known:/);
    expect(registry.get(childB.id)!.status).toBe("completed");
    expect(registry.get(grandB.id)!.status).toBe("completed");
  });

  it("stops queued descendants without opening their sessions", async () => {
    const { manager, runner, registry } = setup({ limit: 1, hold: true, settings: { maxDepth: 3 }, scripts: [[ok("root")], [ok("holder")]] });
    const { record: root } = await manager.run({ agent: "top", task: "root", background: true });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(registry.get(root.id)!.status).toBe("completed");

    // An unrelated live run holds the only slot, so both descendants stay queued with no child session.
    await manager.run({ agent: "top", task: "holder", background: true });
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child", background: true, detach: true }) as never);
    const { record: grand } = await manager.run(nested(child, { agent: "worker", task: "grand", background: true, detach: true }) as never);
    expect(statuses(registry, [root.id, child.id, grand.id])).toEqual(["completed", "queued", "queued"]);
    expect(runner.sessions).toHaveLength(2);

    await manager.stop(root.handle);
    // The queued descendants are cancelled for the cascade too, even under a completed root.
    expect(statuses(registry, [root.id, child.id, grand.id])).toEqual(["stopped", "stopped", "stopped"]);

    await manager.shutdown();
    await manager.whenIdle();
    // The slot stayed held by the unrelated run, so the cancelled descendants never opened a session.
    expect(runner.sessions).toHaveLength(2);
  });

  it("never opens a queued descendant when stopping the parent that holds its slot (CR-5-1)", async () => {
    // Only one slot exists and the parent holds it, so its child waits in the queue with no session.
    const { manager, runner, registry } = setup({ limit: 1, hold: true, settings: { maxDepth: 3 }, scripts: [[ok("root")], [ok("child")]] });
    const { record: root } = await manager.run({ agent: "top", task: "root", background: true });
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child", background: true, detach: true }) as never);
    expect(child.status).toBe("queued");
    expect(runner.sessions).toHaveLength(1);

    await manager.stop(root.handle);
    await manager.whenIdle();

    // Stopping the parent releases the slot mid-cascade; the child was cancelled synchronously first, so no
    // session was ever opened for it.
    expect(registry.get(child.id)!.status).toBe("stopped");
    expect(runner.sessions).toHaveLength(1);
  });

  it("stops every descendant even when an abort throws (CR-5-2)", async () => {
    const { manager, runner, registry } = setup({ limit: 2, hold: true, settings: { maxDepth: 3 }, scripts: [[ok("root")], [ok("child")]] });
    const { record: root } = await manager.run({ agent: "top", task: "root", background: true });
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child", background: true }) as never);
    expect(runner.sessions).toHaveLength(2);
    runner.sessions[0]!.abort = async () => {
      throw new Error("abort failed");
    };

    // The first failure still rejects the stop, but must not cut the cascade short.
    await expect(manager.stop(root.handle)).rejects.toThrow("abort failed");
    // Let the root's own run unwind now that its abort failed, so the test can wait for idle.
    runner.sessions[0]!.finish();
    await manager.whenIdle();

    expect(registry.get(root.id)!.status).toBe("stopped");
    expect(registry.get(child.id)!.status).toBe("stopped");
    expect(runner.sessions[1]!.disposed).toBe(true);
  });

  it("stops paused and completed descendants in the same cascade", async () => {
    const { manager, runner, registry } = setup({ limit: 2, hold: true, settings: { maxDepth: 3 }, scripts: [[ok("root")], [ok("child")], [ok("grand")]] });
    const { record: root } = await manager.run({ agent: "top", task: "root", background: true });
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child", background: true }) as never);
    expect(statuses(registry, [root.id, child.id])).toEqual(["running", "running"]);

    // Pause the child: its run ends, but the record is neither queued nor live when the cascade reaches it.
    await manager.interrupt(child.handle);
    await expect.poll(() => registry.get(child.id)!.status).toBe("paused");

    // A grandchild that finished its own turn before the cascade: a completed record is still marked stopped.
    const { record: grand } = await manager.run(nested(child, { agent: "worker", task: "grand", background: true }) as never);
    runner.sessions[2]!.finish();
    await expect.poll(() => registry.get(grand.id)!.status).toBe("completed");

    await manager.stop(root.handle);
    await manager.whenIdle();

    expect(statuses(registry, [root.id, child.id, grand.id])).toEqual(["stopped", "stopped", "stopped"]);
  });

  it("cancels a descendant's pending resume claim", async () => {
    // Two slots let the tree run and finish; both are then held by unrelated runs, so a resume of the completed
    // descendant claims the record but cannot start until a slot frees (the claim `stopRecord` must cancel).
    const { manager, runner, registry } = setup({ limit: 2, hold: true, settings: { maxDepth: 3 }, scripts: [[ok("root")], [ok("child")], [ok("grand")], [ok("h1")], [ok("h2")]] });
    const { record: root } = await manager.run({ agent: "top", task: "root", background: true });
    runner.sessions[0]!.finish();
    await expect.poll(() => registry.get(root.id)!.status).toBe("completed");
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child", background: true }) as never);
    runner.sessions[1]!.finish();
    await expect.poll(() => registry.get(child.id)!.status).toBe("completed");
    const { record: grand } = await manager.run(nested(child, { agent: "worker", task: "grand", background: true }) as never);
    runner.sessions[2]!.finish();
    await expect.poll(() => registry.get(grand.id)!.status).toBe("completed");

    // Hold both slots with runs that are not part of the subtree, so stopping the completed root frees nothing.
    await manager.run({ agent: "top", task: "h1", background: true });
    await manager.run({ agent: "top", task: "h2", background: true });
    const claimed = await manager.resume(grand.handle, "again", { background: true, detach: true });
    expect(claimed.record.status).toBe("running");
    expect(runner.opened).toHaveLength(5);

    await manager.stop(root.handle);
    expect(registry.get(grand.id)!.status).toBe("stopped");

    await manager.shutdown();
    await manager.whenIdle();
    // The claimed resume was aborted by the cascade before it could open a session.
    expect(runner.opened).toHaveLength(5);
  });

  it("prefers a handle or id lookup and never resolves a later path segment globally", async () => {
    const { manager, registry } = setup({ settings: { maxDepth: 3 }, scripts: [[ok("root")], [ok("child")], [ok("other")], [ok("again")], [ok("again")]] });
    const { record: root } = await manager.run({ agent: "top", task: "root" });
    const { record: child } = await manager.run(nested(root, { agent: "mid", task: "child" }) as never);
    const { record: other } = await manager.run({ agent: "top", task: "other" });

    // A bare record id still resolves through the whole-string handle/id lookup.
    const byId = await manager.resume(child.id, "again");
    expect(byId.record.id).toBe(child.id);

    // Every path segment may also be a record id, not only a handle.
    const byPathIds = await manager.resume(`${root.id}/${child.id}`, "again");
    expect(byPathIds.record.id).toBe(child.id);

    // `other` is a known global handle but not a direct child of `root`: a later segment must never fall back to it.
    const message = await manager.resume(`${root.handle}/${other.handle}`, "again").then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).toMatch(new RegExp(`no subagent ".*"; children of @${root.handle}`));
    expect(message).toContain(`@${child.handle}`);
    expect(message).not.toContain(`@${other.handle}`);
    expect(registry.get(other.id)!.runId).toBe(1);
  });
});
