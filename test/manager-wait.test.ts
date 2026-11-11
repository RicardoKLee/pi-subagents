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
  const root = tempDir("wait-");
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
  return { manager, registry, runner, root };
}

describe("waitMinutes (the caller's own waiting budget)", () => {
  it("returns within the budget and pauses the child", async () => {
    const { manager, registry } = setup({ hold: true, settings: { interruptGraceSeconds: 1 } });
    const started = Date.now();
    const out = await manager.run({ agent: "reviewer", task: "slow", waitMinutes: 0.001 }); // ~60ms
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.record.status).toBe("paused");
    expect(out.payload?.text).toMatch(/paused/);
    expect(registry.list()[0]!.error).toMatch(/waited/);
  });

  it("applies to a foreground batch too", async () => {
    const { manager, registry } = setup({ hold: true, settings: { interruptGraceSeconds: 1 } });
    const started = Date.now();
    const out = await manager.runParallel({
      items: [
        { agent: "reviewer", task: "a" },
        { agent: "reviewer", task: "b" },
      ],
      waitMinutes: 0.001,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(out.records.map((r) => r.status)).toEqual(["paused", "paused"]);
    expect(registry.list().map((r) => r.error ?? "")).toEqual([expect.stringMatching(/waited/), expect.stringMatching(/waited/)]);
  });

  it("a background run ignores it", async () => {
    const { manager, registry } = setup({ hold: true, settings: { interruptGraceSeconds: 1 } });
    const out = await manager.run({ agent: "reviewer", task: "b", background: true, waitMinutes: 0.001 });
    await new Promise((resolve) => setTimeout(resolve, 150)); // well past the budget
    expect(registry.get(out.record.id)!.status).toBe("running");
    await manager.interruptAll();
    await manager.whenIdle();
  });

  it("a run that finishes inside the budget keeps its own status", async () => {
    const { manager } = setup({ scripts: [[ok("done")]] });
    const out = await manager.run({ agent: "reviewer", task: "fast", waitMinutes: 5 });
    expect(out.record.status).toBe("completed");
    expect(out.payload?.text).toBe("done");
  });

  it("transfers the budget to a resumed run", async () => {
    const { manager, registry, runner } = setup({ hold: true, settings: { interruptGraceSeconds: 1 } });
    const first = await manager.run({ agent: "reviewer", task: "x", background: true });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    await manager.interrupt(first.record.handle);
    await vi.waitFor(() => expect(registry.get(first.record.id)!.status).toBe("paused"));

    const out = await manager.resume(first.record.handle, "keep going", { waitMinutes: 0.001 });

    expect(out.record.status).toBe("paused");
    expect(registry.get(first.record.id)!.error).toMatch(/waited/);
  });
});