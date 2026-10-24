import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import { SubagentManager } from "../src/manager.ts";
import { Registry, type SubagentRecord } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { executeAction, type SubagentsInput, toolCallInput } from "../src/tool.ts";
import { FakeRunner, FakeSession } from "./fakes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

// Regression layer for REVIEW-004: the manager-level tests in `manager-nesting.test.ts` call
// `manager.run({... parentId })` directly, so they never exercise `executeAction` — the function the
// extension's tool actually invokes (`src/index.ts`). These cases go through `executeAction(manager, input)`
// with a real `SubagentManager`, which is the path that used to drop the internal `parentId` (REVIEW-001).
afterAll(cleanupTempDirs);

const worker: AgentDef = { name: "worker", description: "w", systemPrompt: "Work.", source: "user", filePath: "/a/worker.md" };
const lead: AgentDef = { name: "lead", description: "l", systemPrompt: "Lead.", source: "user", filePath: "/a/lead.md", allowedSubagents: ["worker"] };
const locked: AgentDef = { name: "locked", description: "x", systemPrompt: "Locked.", source: "user", filePath: "/a/locked.md", allowedSubagents: [] };

function setup(opts: { scripts?: ChildResult[][]; settings?: Partial<SubagentSettings> } = {}) {
  const root = tempDir("nest-");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? []);
  });
  const registry = new Registry(() => {});
  const manager = new SubagentManager({
    registry,
    chainStore: new ChainStore(() => {}),
    scheduler: new Scheduler(() => 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([[worker.name, worker], [lead.name, lead], [locked.name, locked]]),
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

function recordFor(registry: Registry, handle: string): SubagentRecord {
  const record = registry.list().find((r) => r.handle === handle);
  if (!record) throw new Error(`no record for @${handle}`);
  return record;
}

const handlesOf = (out: { details: Record<string, unknown> }): string[] => out.details.handles as string[];

describe("delegation through the real tool entry", () => {
  it("attributes action=run with an internal parentId to that parent", async () => {
    const { manager, registry } = setup();
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    const out = await executeAction(manager, { action: "run", agent: "worker", task: "a", parentId: parent.id });

    const child = recordFor(registry, out.details.handle as string);
    expect(child.parentId).toBe(parent.id);
    expect(child.depth).toBe(parent.depth + 1);
  });

  it("attributes every item of action=parallel to the top-level parentId", async () => {
    const { manager, registry } = setup();
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    const out = await executeAction(manager, {
      action: "parallel",
      tasks: [
        { agent: "worker", task: "a" },
        { agent: "worker", task: "b" },
      ],
      parentId: parent.id,
    });

    const handles = handlesOf(out);
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      const child = recordFor(registry, handle);
      expect(child.parentId).toBe(parent.id);
      expect(child.depth).toBe(parent.depth + 1);
    }
  });

  it("applies maxChildrenPerParent to a parallel batch delegated through the entry", async () => {
    const { manager, registry } = setup({ settings: { maxChildrenPerParent: 1 } });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    await expect(
      executeAction(manager, {
        action: "parallel",
        tasks: [
          { agent: "worker", task: "a" },
          { agent: "worker", task: "b" },
        ],
        parentId: parent.id,
      }),
    ).rejects.toThrow(/already have 1 running or queued subagents \(maxChildrenPerParent=1\)/);

    // The rejected batch must not leave a half-created record behind.
    expect(registry.list().filter((r) => r.parentId === parent.id)).toHaveLength(0);
  });

  it("attributes every step of action=chain to the top-level parentId", async () => {
    const { manager, registry } = setup();
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    const out = await executeAction(manager, {
      action: "chain",
      chain: [
        { agent: "worker", task: "s1" },
        { agent: "worker", task: "s2" },
      ],
      parentId: parent.id,
    });

    const handles = handlesOf(out);
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      const step = recordFor(registry, handle);
      expect(step.parentId).toBe(parent.id);
      expect(step.depth).toBe(parent.depth + 1);
    }
  });
});

describe("depth limit through the real tool entry", () => {
  const DEPTH_MESSAGE = /reached the maximum nesting depth \(maxDepth=1\); you cannot start more subagents/;

  it("rejects action=run beyond maxDepth", async () => {
    const { manager } = setup({ settings: { maxDepth: 1 } });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    await expect(executeAction(manager, { action: "run", agent: "worker", task: "x", parentId: parent.id })).rejects.toThrow(DEPTH_MESSAGE);
  });

  it("rejects action=parallel beyond maxDepth", async () => {
    const { manager } = setup({ settings: { maxDepth: 1 } });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    await expect(
      executeAction(manager, { action: "parallel", tasks: [{ agent: "worker", task: "x" }], parentId: parent.id }),
    ).rejects.toThrow(DEPTH_MESSAGE);
  });

  it("rejects action=chain beyond maxDepth", async () => {
    const { manager } = setup({ settings: { maxDepth: 1 } });
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    await expect(
      executeAction(manager, { action: "chain", chain: [{ agent: "worker", task: "x" }], parentId: parent.id }),
    ).rejects.toThrow(DEPTH_MESSAGE);
  });

  it("rejects action=run for the main session when maxDepth is 0", async () => {
    const { manager } = setup({ settings: { maxDepth: 0 } });

    await expect(executeAction(manager, { action: "run", agent: "worker", task: "x" })).rejects.toThrow(
      /maximum nesting depth \(maxDepth=0\)/,
    );
  });
});

describe("whitelist through the real tool entry", () => {
  const WHITELIST_MESSAGE = /does not allow spawning "locked" \(allowed: worker\)/;

  it("rejects action=run when the delegating ancestor's whitelist forbids the target", async () => {
    const { manager } = setup();
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    await expect(executeAction(manager, { action: "run", agent: "locked", task: "x", parentId: parent.id })).rejects.toThrow(WHITELIST_MESSAGE);
  });

  it("rejects action=parallel when the delegating ancestor's whitelist forbids the target", async () => {
    const { manager } = setup();
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    await expect(
      executeAction(manager, { action: "parallel", tasks: [{ agent: "locked", task: "x" }], parentId: parent.id }),
    ).rejects.toThrow(WHITELIST_MESSAGE);
  });

  it("rejects action=chain when the delegating ancestor's whitelist forbids the target", async () => {
    const { manager } = setup();
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    await expect(
      executeAction(manager, { action: "chain", chain: [{ agent: "locked", task: "x" }], parentId: parent.id }),
    ).rejects.toThrow(WHITELIST_MESSAGE);
  });
});

describe("the main session cannot forge a delegation parent", () => {
  it("strips a model-supplied parentId in toolCallInput", () => {
    const forged = { action: "run", agent: "worker", task: "x", parentId: "rec-forged" } as unknown as SubagentsInput;

    const stripped = toolCallInput(forged);

    expect("parentId" in stripped).toBe(false);
    expect(stripped).not.toHaveProperty("parentId");
    // The original params object is not mutated.
    expect(forged).toHaveProperty("parentId", "rec-forged");
  });

  it("strips a model-supplied detach flag in toolCallInput (LATENT-046-BG)", () => {
    // `detach` is the internal fire-and-forget marker: the model-visible schema declares no such field, so a forged
    // copy must never turn a main-session run into a non-blocking one.
    const forged = { action: "run", agent: "worker", task: "x", background: true, detach: true } as unknown as SubagentsInput;

    const stripped = toolCallInput(forged);

    expect("detach" in stripped).toBe(false);
    expect(stripped).not.toHaveProperty("detach");
    // The original params object is not mutated.
    expect(forged).toHaveProperty("detach", true);
  });

  it("dispatches a forged parentId as a depth-1 root through the entry", async () => {
    const { manager, registry } = setup();
    // `lead` whitelists only `worker`; `locked` would be refused if the forged parentId survived the strip.
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    const forged = { action: "run", agent: "locked", task: "forged", parentId: parent.id } as unknown as SubagentsInput;

    const out = await executeAction(manager, toolCallInput(forged));

    const record = recordFor(registry, out.details.handle as string);
    expect(record.parentId).toBeUndefined();
    expect(record.depth).toBe(1);
  });
});

// Regression layer for REVIEW-011: the cases above fence the main session's own forged `parentId`. This block
// fences the *item-level* copies (`tasks[]` / `chain[]`), pins the trusted top-level parent as the winner, and
// holds the fail-closed behaviour for an explicitly named parent that has no record (REVIEW-010/012).

// A real agent that `lead` does not whitelist, so a whitelist rejection is provably about the whitelist and not
// about a missing agent (the spawn policy is checked before name validation).
const admin: AgentDef = { name: "admin", description: "a", systemPrompt: "Admin.", source: "user", filePath: "/a/admin.md" };

function setupRich(opts: { scripts?: ChildResult[][]; settings?: Partial<SubagentSettings> } = {}) {
  const root = tempDir("nest-");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? []);
  });
  const registry = new Registry(() => {});
  const manager = new SubagentManager({
    registry,
    chainStore: new ChainStore(() => {}),
    scheduler: new Scheduler(() => 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([[worker.name, worker], [lead.name, lead], [locked.name, locked], [admin.name, admin]]),
    settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings }),
    port: { sendMessage: () => {}, appendEntry: () => {} },
    receiverContextWindow: () => 200000,
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
  });
  return { manager, runner, registry };
}

// `lead` allows only `worker`; `admin` is a real agent outside that whitelist.
const ADMIN_WHITELIST_MESSAGE = /does not allow spawning "admin" \(allowed: worker\)/;

describe("item-level delegation parents through the real tool entry", () => {
  it("ignores a forged tasks[] parentId and refuses the target via the top-level parent's whitelist", async () => {
    const { manager, registry, runner } = setupRich();
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    const input = { action: "parallel", tasks: [{ agent: "admin", task: "forged", parentId: "rec-forged" }], parentId: parent.id } as never;
    await expect(executeAction(manager, input)).rejects.toThrow(ADMIN_WHITELIST_MESSAGE);

    // The forged id must neither become a parent nor a depth-1 root: nothing was created, no session opened.
    expect(registry.list()).toHaveLength(1);
    expect(registry.list().some((r) => r.agent === "admin")).toBe(false);
    expect(runner.opened).toHaveLength(1); // only the trusted `lead` root
  });

  it("ignores a forged chain[] step parentId and refuses the target via the top-level parent's whitelist", async () => {
    const { manager, registry } = setupRich();
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });

    const input = { action: "chain", chain: [{ agent: "admin", task: "forged", parentId: "rec-forged" }], parentId: parent.id } as never;
    await expect(executeAction(manager, input)).rejects.toThrow(ADMIN_WHITELIST_MESSAGE);

    expect(registry.list()).toHaveLength(1);
    expect(registry.list().some((r) => r.agent === "admin")).toBe(false);
  });

  it("keeps the top-level parent when an item names a real, more permissive parent", async () => {
    const { manager, registry } = setupRich();
    const { record: permissive } = await manager.run({ agent: "worker", task: "free" }); // no whitelist: could spawn admin
    const { record: restricted } = await manager.run({ agent: "lead", task: "plan" }); // whitelist: worker only

    const input = { action: "parallel", tasks: [{ agent: "admin", task: "x", parentId: permissive.id }], parentId: restricted.id } as never;
    await expect(executeAction(manager, input)).rejects.toThrow(ADMIN_WHITELIST_MESSAGE);

    // If the item's own parent had won, `admin` would have been created under `permissive`.
    expect(registry.list().some((r) => r.agent === "admin")).toBe(false);
    expect(registry.list().filter((r) => r.parentId === permissive.id)).toHaveLength(0);
  });

  it("attributes to the top-level parent even when an item names a deeper real parent", async () => {
    const { manager, registry } = setupRich({ settings: { maxDepth: 5 } });
    const { record: top } = await manager.run({ agent: "lead", task: "p" }); // depth 1
    const { record: deeper } = await manager.run({ agent: "worker", task: "w", parentId: top.id }); // depth 2

    // Both parents allow `worker`; only the attribution differs (top -> depth 2, deeper -> depth 3).
    const out = await executeAction(manager, {
      action: "parallel",
      tasks: [{ agent: "worker", task: "x", parentId: deeper.id }],
      parentId: top.id,
    } as never);

    const child = recordFor(registry, handlesOf(out)[0]!);
    expect(child.parentId).toBe(top.id);
    expect(child.depth).toBe(2);
  });
});

describe("unknown explicit parents fail closed through the real tool entry", () => {
  it("rejects a top-level parentId with no record without creating anything", async () => {
    const { manager, registry, runner } = setupRich();

    await expect(
      executeAction(manager, { action: "run", agent: "worker", task: "x", parentId: "rec-missing" } as never),
    ).rejects.toThrow(/unknown parent subagent "rec-missing"/);

    expect(registry.list()).toHaveLength(0);
    expect(runner.opened).toHaveLength(0);
  });

  it("rejects a tasks[] item parentId with no record without creating anything", async () => {
    const { manager, registry, runner } = setupRich();

    await expect(
      executeAction(manager, { action: "parallel", tasks: [{ agent: "worker", task: "x", parentId: "rec-missing" }] } as never),
    ).rejects.toThrow(/unknown parent subagent "rec-missing"/);

    expect(registry.list()).toHaveLength(0);
    expect(runner.opened).toHaveLength(0);
  });

  it("rejects a chain[] step parentId with no record without creating anything", async () => {
    const { manager, registry, runner } = setupRich();

    await expect(
      executeAction(manager, { action: "chain", chain: [{ agent: "worker", task: "x", parentId: "rec-missing" }] } as never),
    ).rejects.toThrow(/unknown parent subagent "rec-missing"/);

    expect(registry.list()).toHaveLength(0);
    expect(runner.opened).toHaveLength(0);
  });
});

describe("chain step attribution through the real tool entry", () => {
  it("attributes each step to its own declared parent and derives each depth", async () => {
    const { manager, registry } = setupRich({ settings: { maxDepth: 5 } });
    const { record: firstParent } = await manager.run({ agent: "lead", task: "p1" }); // depth 1
    const { record: secondParent } = await manager.run({ agent: "worker", task: "p2", parentId: firstParent.id }); // depth 2

    const out = await executeAction(manager, {
      action: "chain",
      chain: [
        { agent: "worker", task: "s1", parentId: firstParent.id },
        { agent: "worker", task: "s2", parentId: secondParent.id },
      ],
    } as never);

    const [step1, step2] = handlesOf(out).map((handle) => recordFor(registry, handle));
    expect(step1!.parentId).toBe(firstParent.id);
    expect(step1!.depth).toBe(2);
    expect(step2!.parentId).toBe(secondParent.id);
    expect(step2!.depth).toBe(3);
  });

  it("treats an undeclared first step as a root and only the declared second step as nested", async () => {
    const { manager, registry } = setupRich({ settings: { maxDepth: 5 } });
    const { record: parent } = await manager.run({ agent: "lead", task: "p" }); // depth 1
    const { record: nestedParent } = await manager.run({ agent: "worker", task: "n", parentId: parent.id }); // depth 2

    const out = await executeAction(manager, {
      action: "chain",
      chain: [{ agent: "worker", task: "s1" }, { agent: "worker", task: "s2", parentId: nestedParent.id }],
    } as never);

    const [step1, step2] = handlesOf(out).map((handle) => recordFor(registry, handle));
    // Semantics under review (REVIEW-012): a step with no declaration is a depth-1 root, a declared step keeps its
    // own parent. Attribution is per step; there is no chain-wide inheritance from the first step.
    expect(step1!.parentId).toBeUndefined();
    expect(step1!.depth).toBe(1);
    expect(step2!.parentId).toBe(nestedParent.id);
    expect(step2!.depth).toBe(3);
  });
});

describe("the tool entry strips item-level delegation parents", () => {
  it("drops parentId from tasks[] and chain[] items without mutating the input", () => {
    const forged = {
      action: "parallel",
      tasks: [{ agent: "worker", task: "a", parentId: "rec-a" }],
      chain: [{ agent: "worker", task: "b", parentId: "rec-b" }],
      parentId: "rec-top",
    } as unknown as SubagentsInput;

    const stripped = toolCallInput(forged);

    expect(stripped).not.toHaveProperty("parentId");
    expect(stripped.tasks?.[0]).not.toHaveProperty("parentId");
    expect(stripped.chain?.[0]).not.toHaveProperty("parentId");
    // The original params object keeps the forged fields: nothing is mutated in place.
    expect(forged).toHaveProperty("parentId", "rec-top");
    expect((forged.tasks as { parentId?: string }[])[0]).toHaveProperty("parentId", "rec-a");
    expect((forged.chain as { parentId?: string }[])[0]).toHaveProperty("parentId", "rec-b");
  });
});