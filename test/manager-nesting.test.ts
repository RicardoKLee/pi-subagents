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