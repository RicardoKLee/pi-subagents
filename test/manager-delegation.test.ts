import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import { SubagentManager } from "../src/manager.ts";
import { Registry } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { executeAction } from "../src/tool.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });

const alpha: AgentDef = { name: "alpha", description: "a", systemPrompt: "A.", source: "user", filePath: "/a/alpha.md" };
const beta: AgentDef = { name: "beta", description: "b", systemPrompt: "B.", source: "user", filePath: "/a/beta.md" };
const gamma: AgentDef = { name: "gamma", description: "g", systemPrompt: "G.", source: "user", filePath: "/a/gamma.md" };
/** A definition that allows no subagent at all: its own delegation gate is always closed. */
const blocked: AgentDef = { name: "blocked", description: "x", systemPrompt: "X.", source: "user", filePath: "/a/blocked.md", allowedSubagents: [] };

function setup(opts: { scripts?: ChildResult[][]; settings?: Partial<SubagentSettings>; hold?: boolean; mailboxDir?: string } = {}) {
  const root = tempDir("ng-");
  const scripts = opts.scripts ?? [];
  let current: SubagentSettings = { ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings };
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
  });
  const manager = new SubagentManager({
    registry: new Registry(() => {}),
    chainStore: new ChainStore(() => {}),
    scheduler: new Scheduler(() => 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([[alpha.name, alpha], [beta.name, beta], [gamma.name, gamma], [blocked.name, blocked]]),
    settings: () => current,
    port: { sendMessage: () => {}, appendEntry: () => {} },
    receiverContextWindow: () => 200000,
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
    ...(opts.mailboxDir ? { mailboxDir: opts.mailboxDir } : {}),
  });
  return {
    manager,
    runner,
    root,
    /** Recompute the delegation gate against a new settings snapshot (REVIEW-021 "now", not at launch time). */
    setSettings: (patch: Partial<SubagentSettings>) => {
      current = { ...current, ...patch };
    },
  };
}

const statusOf = (manager: SubagentManager, id: string) => manager.list().find((r) => r.id === id)?.status;
const recordByTask = (manager: SubagentManager, task: string) => manager.list().find((r) => r.task === task);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "(no error)";
  } catch (error) {
    return (error as Error).message;
  }
};

describe("delegate scope boundary (REVIEW-020)", () => {
  it("should_list_only_its_own_subtree_and_refuse_another_tree_without_leaking_it", async () => {
    const { manager } = setup({ scripts: Array.from({ length: 8 }, () => [ok("done")]) });
    // Two unrelated roots under the same manager; each gets its own child.
    const one = await manager.run({ agent: "alpha", task: "one" });
    const two = await manager.run({ agent: "alpha", task: "two" });
    await manager.delegate(one.record.id, { action: "run", agent: "beta", task: "child-one" });
    await manager.delegate(two.record.id, { action: "run", agent: "beta", task: "child-two" });
    const mine = recordByTask(manager, "child-one")!;
    const theirs = recordByTask(manager, "child-two")!;
    expect([mine.parentId, theirs.parentId]).toEqual([one.record.id, two.record.id]);
    expect(manager.list()).toHaveLength(4);

    // list: only this child's own descendants, never the sibling tree or the parent itself.
    const listed = await manager.delegate(one.record.id, { action: "list" });
    expect(listed.details.count).toBe(1);
    expect(listed.text).toContain(`@${mine.handle}`);
    expect(listed.text).not.toContain(`@${theirs.handle}`);
    expect(listed.text).not.toContain(`@${two.record.handle}`);
    expect(listed.text).not.toContain(`@${one.record.handle}`);

    // The three scoped actions must refuse a handle that exists but belongs to another tree.
    for (const payload of [
      { action: "steer", handle: theirs.handle, message: "m" },
      { action: "resume", handle: theirs.handle, message: "m" },
      { action: "stop", handle: theirs.handle },
    ]) {
      const message = await errorText(manager.delegate(one.record.id, payload as Record<string, unknown>));
      expect(message).toMatch(/is not one of your subagents/);
      // The refusal names the requested handle only: no ancestor, no sibling, no global "Known:" enumeration.
      expect(message).not.toContain(`@${two.record.handle}`);
      expect(message).not.toContain(`@${one.record.handle}`);
      expect(message).not.toMatch(/Known:/);
    }
    // The other tree was not touched by the refused operations.
    expect(statusOf(manager, theirs.id)).toBe("completed");
    expect(statusOf(manager, two.record.id)).toBe("completed");
  });

  it("should_reject_an_unknown_parent_record_id", async () => {
    const { manager } = setup();
    await expect(manager.delegate("no-such-record", { action: "list" })).rejects.toThrow(/unknown parent subagent/);
  });
});

describe("delegate attribution (REVIEW-020)", () => {
  it("should_attribute_run_parallel_and_chain_to_the_trusted_parent_and_ignore_a_forged_parentId", async () => {
    // maxDepth 3 so the child of the depth-2 "mid" can itself spawn (depth 3).
    const { manager } = setup({ settings: { maxDepth: 3 }, scripts: Array.from({ length: 16 }, () => [ok("done")]) });
    const root = await manager.run({ agent: "alpha", task: "root" }); // depth 1
    await manager.delegate(root.record.id, { action: "run", agent: "beta", task: "mid" });
    const mid = recordByTask(manager, "mid")!;
    expect([mid.parentId, mid.depth]).toEqual([root.record.id, 2]);

    // A child of `mid` whose payload forges `parentId: root` (depth 1): the trusted parent must win outright.
    await manager.delegate(mid.id, { action: "run", agent: "gamma", task: "forged-run", parentId: root.record.id });
    const forged = recordByTask(manager, "forged-run")!;
    expect(forged.parentId).toBe(mid.id);
    expect(forged.depth).toBe(3);

    // parallel: each item's parentId is overwritten by the delegating parent too.
    await manager.delegate(mid.id, {
      action: "parallel",
      tasks: [
        { agent: "gamma", task: "forged-p1", parentId: root.record.id },
        { agent: "gamma", task: "forged-p2" },
      ],
      parentId: root.record.id,
    });
    const p1 = recordByTask(manager, "forged-p1")!;
    const p2 = recordByTask(manager, "forged-p2")!;
    for (const r of [p1, p2]) {
      expect(r.parentId).toBe(mid.id);
      expect(r.depth).toBe(3);
    }

    // chain: every step is attributed to the delegating parent, not to the forged id.
    await manager.delegate(mid.id, {
      action: "chain",
      chain: [
        { agent: "gamma", task: "forged-c1", parentId: root.record.id },
        { agent: "gamma", task: "forged-c2" },
      ],
    });
    const c1 = recordByTask(manager, "forged-c1")!;
    const c2 = recordByTask(manager, "forged-c2")!;
    for (const r of [c1, c2]) {
      expect(r.parentId).toBe(mid.id);
      expect(r.depth).toBe(3);
    }
  });
});

describe("delegate abort scope (REVIEW-019)", () => {
  it("should_leave_unrelated_trees_running_when_a_delegated_call_is_aborted", async () => {
    const { manager } = setup({ hold: true });
    const a = await manager.run({ agent: "alpha", task: "tree-a", background: true });
    const b = await manager.run({ agent: "beta", task: "tree-b", background: true });
    await vi.waitFor(() => expect(statusOf(manager, a.record.id)).toBe("running"));
    await vi.waitFor(() => expect(statusOf(manager, b.record.id)).toBe("running"));

    // A delegated tool call already aborted (the child session itself was interrupted/stopped): its onAbort must be a
    // no-op, never the global interruptAll() that would pause every live subagent of the manager.
    const aborted = AbortSignal.abort();
    await expect(manager.delegate(a.record.id, { action: "run", agent: "gamma", task: "grandchild", background: true }, aborted)).rejects.toThrow(
      /interrupted|aborted/i,
    );

    await delay(50);
    expect(statusOf(manager, a.record.id)).toBe("running");
    expect(statusOf(manager, b.record.id)).toBe("running");

    await manager.shutdown();
    await manager.whenIdle();
  });

  it("should_keep_the_global_interruptAll_for_the_main_session_path", async () => {
    const { manager } = setup();
    const spy = vi.spyOn(manager, "interruptAll").mockResolvedValue(undefined);
    // The main session's tool call passes no onAbort: the default still pauses every live child.
    await executeAction(manager, { action: "list" }, AbortSignal.abort());
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("delegate resume keeps delegation (REVIEW-021)", () => {
  it("should_pass_the_delegation_to_runner_open_on_resume", async () => {
    const root = tempDir("ng-mail-");
    const { manager, runner } = setup({ mailboxDir: join(root, "mailbox"), scripts: Array.from({ length: 6 }, () => [ok("done")]) });
    const { record } = await manager.run({ agent: "alpha", task: "plan" });
    const launched = runner.opened.at(-1)!;
    expect(launched.delegation).toMatchObject({ recordId: record.id, depth: 1, canDelegate: true, mailboxDir: join(root, "mailbox") });

    await manager.resume(record.handle, "again");
    const resumed = runner.opened.at(-1)!;
    expect(resumed.delegation).toEqual(launched.delegation);
    expect(resumed.delegation!.recordId).toBe(record.id);
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("should_recompute_canDelegate_at_the_depth_limit_when_resuming", async () => {
    const root = tempDir("ng-mail-");
    const { manager, runner, setSettings } = setup({ mailboxDir: join(root, "mailbox"), scripts: Array.from({ length: 6 }, () => [ok("done")]) });
    const { record } = await manager.run({ agent: "alpha", task: "plan" }); // depth 1, maxDepth 2 -> allowed
    expect(runner.opened.at(-1)!.delegation).toMatchObject({ depth: 1, canDelegate: true });

    // The gate is recomputed against the current settings, not the value captured when the child launched.
    setSettings({ maxDepth: 1 });
    await manager.resume(record.handle, "again");
    expect(runner.opened.at(-1)!.delegation).toMatchObject({ recordId: record.id, depth: 1, canDelegate: false });
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("should_recompute_canDelegate_for_a_whitelist_limited_record", async () => {
    const root = tempDir("ng-mail-");
    const { manager, runner } = setup({ mailboxDir: join(root, "mailbox"), scripts: Array.from({ length: 6 }, () => [ok("done")]) });
    const { record } = await manager.run({ agent: "blocked", task: "plan" });
    expect(runner.opened.at(-1)!.delegation).toMatchObject({ recordId: record.id, depth: 1, canDelegate: false });
    await manager.resume(record.handle, "again");
    expect(runner.opened.at(-1)!.delegation).toMatchObject({ recordId: record.id, depth: 1, canDelegate: false });
    await manager.shutdown();
    await manager.whenIdle();
  });

  it("should_keep_delegation_when_continueChain_resumes_the_stopped_step", async () => {
    const root = tempDir("ng-mail-");
    const { manager, runner } = setup({ hold: true, mailboxDir: join(root, "mailbox"), scripts: Array.from({ length: 8 }, () => [ok("done")]) });
    const out = await manager.runChain({ steps: [{ agent: "beta", task: "one" }, { agent: "beta", task: "two" }], background: true });
    const chainId = out.chain!.id;
    await vi.waitFor(() => expect(manager.list().find((r) => r.chainId === chainId && r.stepIndex === 0)?.status).toBe("running"));
    const step1 = manager.list().find((r) => r.chainId === chainId && r.stepIndex === 0)!;

    await manager.interrupt(step1.handle);
    await vi.waitFor(() => expect(statusOf(manager, step1.id)).toBe("paused"));

    const before = runner.opened.length;
    void manager.continueChain(step1.handle, undefined, { background: true });
    await vi.waitFor(() => expect(runner.opened.length).toBeGreaterThan(before));
    const resumed = runner.opened.slice(before).find((s) => s.delegation?.recordId === step1.id);
    expect(resumed?.delegation).toMatchObject({ recordId: step1.id, depth: 1, canDelegate: true });

    await manager.shutdown();
    await manager.whenIdle();
  });
});

describe("delegate unknown handle (REVIEW-027)", () => {
  /**
   * Builds two unrelated trees under one manager: `tree-a-root -> a-child -> a-grandchild` and
   * `tree-b-root -> b-child`. Returns the two roots, the delegating node `a-child` and every handle the manager holds,
   * so a single refusal can be checked against ancestors, siblings, the other tree and its own descendants alike.
   */
  async function twoTrees(manager: SubagentManager) {
    const treeA = await manager.run({ agent: "alpha", task: "tree-a-root" });
    const treeB = await manager.run({ agent: "alpha", task: "tree-b-root" });
    await manager.delegate(treeA.record.id, { action: "run", agent: "beta", task: "a-child" });
    const aChild = recordByTask(manager, "a-child")!;
    await manager.delegate(aChild.id, { action: "run", agent: "gamma", task: "a-grandchild" });
    await manager.delegate(treeB.record.id, { action: "run", agent: "beta", task: "b-child" });
    return { treeA: treeA.record, treeB: treeB.record, aChild, handles: manager.list().map((r) => r.handle) };
  }

  it("should_refuse_an_unknown_handle_without_leaking_any_other_handle", async () => {
    const { manager } = setup({ settings: { maxDepth: 3 }, scripts: Array.from({ length: 16 }, () => [ok("done")]) });
    const { aChild, handles } = await twoTrees(manager);
    // The fixture really holds two unrelated trees and several handles to leak.
    expect(handles.length).toBeGreaterThanOrEqual(5);
    expect(new Set(handles).size).toBe(handles.length);

    // The three scoped actions must all take the same narrow path for a handle that does not exist at all.
    for (const action of ["steer", "resume", "stop"] as const) {
      const payload: Record<string, unknown> = { action, handle: "no-such-handle" };
      if (action !== "stop") payload.message = "m";
      const message = await errorText(manager.delegate(aChild.id, payload));

      // The scoped refusal, never the global `requireRecord` text.
      expect(message).toMatch(/is not one of your subagents/);
      expect(message).not.toMatch(/Known:/);
      // Exactly one `@...` token may appear: the requested handle. Nothing about any ancestor, sibling, own descendant
      // or the other tree.
      expect(message.match(/@[A-Za-z0-9_-]+/g) ?? []).toEqual(["@no-such-handle"]);
      for (const handle of handles) expect(message).not.toContain(`@${handle}`);
    }

    // The refused calls touched nothing: every record keeps its own status.
    expect(manager.list().every((r) => r.status === "completed")).toBe(true);
  });

  it("should_pass_a_descendant_handle_through_but_still_refuse_a_foreign_one", async () => {
    const { manager } = setup({ settings: { maxDepth: 3 }, scripts: Array.from({ length: 16 }, () => [ok("done")]) });
    const { treeB, aChild } = await twoTrees(manager);
    const grandchild = recordByTask(manager, "a-grandchild")!;
    expect(grandchild.parentId).toBe(aChild.id);

    // A handle from the delegating record's own subtree resolves and the action is applied.
    await manager.delegate(aChild.id, { action: "stop", handle: grandchild.handle });
    expect(statusOf(manager, grandchild.id)).toBe("stopped");

    // A handle that exists but belongs to another tree is still refused, and the refusal names only that handle:
    // no `Known:` inventory even though the record does exist globally.
    const message = await errorText(manager.delegate(aChild.id, { action: "stop", handle: treeB.handle }));
    expect(message).toMatch(/is not one of your subagents/);
    expect(message).not.toMatch(/Known:/);
    expect(message.match(/@[A-Za-z0-9_-]+/g) ?? []).toEqual([`@${treeB.handle}`]);
    expect(statusOf(manager, treeB.id)).toBe("completed");
  });
});