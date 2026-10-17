import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { rebuildForBranch, subagentPaths } from "../src/index.ts";
import { SubagentManager } from "../src/manager.ts";
import { REGISTRY_ENTRY_TYPE, Registry, type SubagentRecord } from "../src/registry.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { FakeRunner, FakeSession } from "./fakes.ts";

describe("subagentPaths", () => {
  it("keeps everything under the session directory when there is one", () => {
    expect(subagentPaths("/s/dir", "abc")).toEqual({
      childDir: join("/s/dir", "subagents"),
      outputDir: join("/s/dir", "subagents", "outputs"),
      snapshotFile: join("/s/dir", "abc.subagents.json"),
    });
  });

  it("uses a temp directory and no snapshot when the session has no directory", () => {
    const base = join(tmpdir(), "pi-subagents", "abc");
    const paths = subagentPaths("", "abc");
    expect(paths.childDir.startsWith(base)).toBe(true);
    expect(paths.outputDir.startsWith(base)).toBe(true);
    expect(paths.snapshotFile).toBeUndefined();
    expect(paths).toEqual({ childDir: join(base, "sessions"), outputDir: join(base, "outputs") });
  });
});

const reviewer: AgentDef = { name: "reviewer", description: "r", systemPrompt: "Review.", source: "user", filePath: "/a/reviewer.md" };

/** Real Registry + SubagentManager with held fake children; persisted records are collected as session entries. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "idx-"));
  const persisted: { type: "custom"; customType: string; data: SubagentRecord }[] = [];
  const registry = new Registry((record) => persisted.push({ type: "custom", customType: REGISTRY_ENTRY_TYPE, data: record }));
  const runner = new FakeRunner((_spec, n) => {
    const file = join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, [], true);
  });
  const manager = new SubagentManager({
    registry,
    scheduler: new Scheduler(() => 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([["reviewer", reviewer]]),
    settings: () => DEFAULT_SETTINGS,
    port: { sendMessage: () => {}, appendEntry: () => {} },
    receiverContextWindow: () => 200000,
    cwd: root,
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
  });
  return { manager, registry, runner, persisted };
}

describe("rebuildForBranch", () => {
  it("rebuildForBranch pauses records left running on the new branch", async () => {
    const { manager, registry, runner, persisted } = setup();
    const { record } = await manager.run({ agent: "reviewer", task: "x", background: true });
    const runningEntry = persisted[0]!;
    expect(runningEntry.data.status).toBe("running");
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(registry.resolve(record.handle)!.status).toBe("completed");

    expect(rebuildForBranch(manager, registry, [runningEntry])).toBe(1);
    expect(registry.resolve(record.handle)!.status).toBe("paused");
  });

  it("rebuildForBranch keeps a still-running child", async () => {
    const { manager, registry, runner } = setup();
    const { record } = await manager.run({ agent: "reviewer", task: "x", background: true });

    expect(rebuildForBranch(manager, registry, [])).toBe(0);
    const listed = registry.list().find((r) => r.id === record.id);
    expect(listed?.status).toBe("running");

    runner.sessions[0]!.finish();
    await manager.whenIdle();
  });
});
