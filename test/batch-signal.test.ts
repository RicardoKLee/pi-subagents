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

function setup(opts: { scripts?: ChildResult[][]; hold?: boolean; settings?: Partial<SubagentSettings> } = {}) {
  const root = tempDir("batch-signal-");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
  });
  const registry = new Registry(() => {});
  const chainStore = new ChainStore(() => {});
  const manager = new SubagentManager({
    registry,
    chainStore,
    scheduler: new Scheduler(() => 4),
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
  return { manager, registry, chainStore, runner };
}

const statuses = (registry: Registry) => registry.list().map((r) => r.status);
const step = (task: string) => ({ agent: "reviewer", task });

describe("a foreground batch takes the caller's signal", () => {
  it("pauses every parallel item when the caller aborts", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const controller = new AbortController();
    const batch = manager.runParallel({ items: [step("a"), step("b")], signal: controller.signal });
    await vi.waitFor(() => expect(runner.sessions.length).toBe(2));
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(2));

    controller.abort();
    const out = await batch;

    expect(out.records.map((r) => r.status)).toEqual(["paused", "paused"]);
    expect(statuses(registry)).toEqual(["paused", "paused"]);
    expect(runner.sessions.every((s) => s.aborted === 1)).toBe(true);
  });

  it("pauses the running chain step and starts no further step", async () => {
    const { manager, registry, runner, chainStore } = setup({ hold: true, scripts: [[], [], []] });
    const controller = new AbortController();
    const running = manager.runChain({ steps: [step("one"), step("two"), step("three")], signal: controller.signal });
    await vi.waitFor(() => expect(runner.sessions.length).toBe(1));
    runner.sessions[0]!.finish(); // step 1 completes
    await vi.waitFor(() => expect(runner.sessions.length).toBe(2)); // step 2 is live

    controller.abort();
    const out = await running;

    expect(out.records.map((r) => r.status)).toEqual(["completed", "paused"]);
    expect(out.chain!.status).toBe("paused");
    expect(out.chain!.stepRecordIds).toHaveLength(2); // step 3 was never created
    expect(statuses(registry)).toEqual(["completed", "paused"]);
    expect(chainStore.list()).toHaveLength(1);
  });

  it("settles as paused when the caller aborted between steps", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[], []] });
    const controller = new AbortController();
    const running = manager.runChain({ steps: [step("one"), step("two")], signal: controller.signal });
    await vi.waitFor(() => expect(runner.sessions.length).toBe(1));
    // Abort while step 1 is still the active step: the loop must not prepare step 2 afterwards.
    controller.abort();
    runner.sessions[0]!.finish();
    const out = await running;
    expect(out.chain!.status).toBe("paused");
    expect(out.chain!.stepRecordIds).toHaveLength(1);
  });

  it("pauses a resume the caller is still waiting on", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const first = await manager.run({ agent: "reviewer", task: "a", background: true });
    await vi.waitFor(() => expect(runner.sessions.length).toBe(1));
    await manager.interrupt(first.record.handle);
    await vi.waitFor(() => expect(registry.get(first.record.id)!.status).toBe("paused"));

    const controller = new AbortController();
    const resumed = manager.resume(first.record.handle, "keep going", { waiting: true, signal: controller.signal });
    await vi.waitFor(() => expect(runner.sessions.length).toBe(2));
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(1));
    controller.abort();
    const out = await resumed;
    expect(out.record.status).toBe("paused");
  });

  it("ignores the caller's signal for background batches", async () => {
    const { manager, registry, runner } = setup({ hold: true, scripts: [[], []] });
    const controller = new AbortController();
    await manager.runParallel({ items: [step("a"), step("b")], background: true, signal: controller.signal });
    await vi.waitFor(() => expect(manager.activitySnapshot().size).toBe(2));

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(statuses(registry)).toEqual(["running", "running"]);
    for (const session of runner.sessions) session.finish();
    await manager.whenIdle();
    expect(statuses(registry)).toEqual(["completed", "completed"]);
  });

  it("keeps a batch item's own scripted result when nothing aborts it", async () => {
    const { manager, registry } = setup({ scripts: [[ok("first")], [ok("second")]] });
    const out = await manager.runParallel({ items: [step("a"), step("b")], signal: new AbortController().signal });
    expect(out.records.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(statuses(registry)).toEqual(["completed", "completed"]);
  });
});