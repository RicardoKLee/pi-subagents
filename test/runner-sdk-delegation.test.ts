import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import { SubagentManager } from "../src/manager.ts";
import { Registry } from "../src/registry.ts";
import { buildLoaderOptions } from "../src/runner/sdk.ts";
import type { ChildResult, ChildSpec } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { echoAgent } from "./harness.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const base: ChildSpec = { agent: echoAgent, cwd: "/w", sessionDir: "/s", appendSystemPrompt: ["Be brief."] };

interface FakeTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

/** The tool names a spec's inline proxy extension would register in the child session. */
function toolsRegisteredBy(spec: ChildSpec): string[] {
  const opts = buildLoaderOptions(spec, { agentDir: "/a", settingsManager: undefined as never });
  const names = new Set<string>();
  for (const factory of opts.extensionFactories ?? []) {
    (factory as ExtensionFactory)({ registerTool: (tool: FakeTool) => void names.add(tool.name), on: () => () => {} } as never);
  }
  return [...names];
}

describe("delegation plumbing", () => {
  it("passes extensionFactories to the SDK loader only when delegation is present", () => {
    const withDelegation = buildLoaderOptions({ ...base, delegation: { recordId: "rec-1", depth: 1, canDelegate: true } } as ChildSpec, {
      agentDir: "/a",
      settingsManager: undefined as never,
    });
    expect(withDelegation.extensionFactories).toHaveLength(1);
    expect(withDelegation.noExtensions).toBe(true);
    const without = buildLoaderOptions(base, { agentDir: "/a", settingsManager: undefined as never });
    expect(without.extensionFactories ?? []).toHaveLength(0);
  });

  it("binds the SDK child's record id from the spec, not the environment", async () => {
    const calls: unknown[] = [];
    const spec: ChildSpec = { ...base, delegation: { recordId: "rec-9", depth: 2, canDelegate: true } };
    const opts = buildLoaderOptions(spec, {
      agentDir: "/a",
      settingsManager: undefined as never,
      host: {
        async request(parentRecordId, payload) {
          calls.push({ parentRecordId, payload });
          return { text: "ok" };
        },
      },
    });
    const factory = opts.extensionFactories![0] as ExtensionFactory;
    const tools = new Map<string, FakeTool>();
    factory({ registerTool: (tool: FakeTool) => void tools.set(tool.name, tool), on: () => () => {} } as never);
    await tools.get("subagents")!.execute("call-1", { action: "list" }, undefined, undefined, {});
    expect(calls).toEqual([{ parentRecordId: "rec-9", payload: { action: "list" } }]);
  });
});

/**
 * Review point #2 end to end: the depth the manager stores on a record must reach the runner spec, and a child at
 * the depth limit must load no delegation tool at all (plan 6.9 items 2 and 3). Real manager + FakeRunner, no model.
 */
describe("delegation depth through the manager", () => {
  const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });
  const lead: AgentDef = { name: "lead", description: "l", systemPrompt: "Lead.", source: "user", filePath: "/a/lead.md" };
  const worker: AgentDef = { name: "worker", description: "w", systemPrompt: "Work.", source: "user", filePath: "/a/worker.md" };

  function setup() {
    const root = tempDir("nest-");
    const scripts: ChildResult[][] = [[ok("root")], [ok("child")]];
    const runner = new FakeRunner((spec, n) => {
      const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
      writeFileSync(file, "", { flag: "a" });
      return new FakeSession(file, scripts[n] ?? []);
    });
    const manager = new SubagentManager({
      registry: new Registry(() => {}),
      chainStore: new ChainStore(() => {}),
      scheduler: new Scheduler(() => 4),
      runners: { sdk: runner, rpc: undefined },
      agents: () => new Map([[lead.name, lead], [worker.name, worker]]),
      settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, maxDepth: 2 }),
      port: { sendMessage: () => {}, appendEntry: () => {} },
      receiverContextWindow: () => 200000,
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      outputDir: join(root, "out"),
      mailboxDir: join(root, "mailbox"),
    });
    return { manager, runner };
  }

  it("should_load_no_delegation_tool_in_a_child_at_the_depth_limit", async () => {
    // Arrange: maxDepth 2 means depth 1 may spawn, the depth-2 child may not.
    const { manager, runner } = setup();
    // Act: the main session (depth 0) starts the root (depth 1), which starts a child (depth 2).
    const { record: parent } = await manager.run({ agent: "lead", task: "plan" });
    const { record: child } = await manager.run({ agent: "worker", task: "work", parentId: parent.id } as never);

    // Assert: the spec handed to the runner carries the gate, for both depths.
    expect([parent.depth, child.depth]).toEqual([1, 2]);
    const parentSpec = runner.opened.find((s) => s.delegation?.recordId === parent.id)!;
    const childSpec = runner.opened.find((s) => s.delegation?.recordId === child.id)!;
    expect(parentSpec.delegation).toMatchObject({ depth: 1, canDelegate: true });
    expect(childSpec.delegation).toMatchObject({ depth: 2, canDelegate: false });

    // Assert: loading the child's spec registers no tool; the parent's spec does register the proxy tool.
    expect(toolsRegisteredBy(parentSpec)).toEqual(["subagents"]);
    expect(toolsRegisteredBy(childSpec)).toEqual([]);
  });
});