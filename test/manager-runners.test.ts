import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ChainStore } from "../src/chain.ts";
import { SubagentManager } from "../src/manager.ts";
import { REGISTRY_ENTRY_TYPE, Registry, type SubagentRecord } from "../src/registry.ts";
import type { ChildSession, ChildSpec, Runner } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { echoAgent, harness } from "./harness.ts";
import { childPids } from "./proc.ts";
import { cleanupTempDirs } from "./tmp.ts";

afterAll(cleanupTempDirs);
afterAll(async () => {
  // REVIEW-001: every manager close path must reap its `pi --mode rpc` child; `childPids` is scoped to this worker.
  await vi.waitFor(() => expect(childPids(["pi"])).toEqual([]), { timeout: 10_000 });
});

/** Counts how often the real runner starts a child. */
class CountingRunner implements Runner {
  readonly opened: ChildSpec[] = [];
  constructor(private readonly inner: Runner) {}
  get kind() {
    return this.inner.kind;
  }
  open(spec: ChildSpec): Promise<ChildSession> {
    this.opened.push(spec);
    return this.inner.open(spec);
  }
}

const managers: SubagentManager[] = [];

// The manager's own afterEach: shutdown() + whenIdle() so no rpc case can leak a child.
afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.shutdown();
    await m.whenIdle();
  }
});

async function setup(kind: "sdk" | "rpc", settings: Partial<SubagentSettings> = {}) {
  const h = await harness(kind);
  const runner = new CountingRunner(h.runner);
  const persisted: SubagentRecord[] = [];
  const registry = new Registry((r) => persisted.push(r));
  const manager = new SubagentManager({
    registry,
    chainStore: new ChainStore(() => {}),
    scheduler: new Scheduler(() => 4),
    runners: { sdk: kind === "sdk" ? runner : undefined, rpc: kind === "rpc" ? runner : undefined },
    agents: () => new Map([["echo", { ...echoAgent, runner: kind }]]),
    settings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    port: { sendMessage: () => {}, appendEntry: () => {} },
    receiverContextWindow: () => 200000,
    cwd: h.spec.cwd,
    agentDir: join(h.spec.cwd, "..", "agent"),
    sessionDir: h.spec.sessionDir,
    outputDir: `${h.spec.sessionDir}-out`,
  });
  managers.push(manager);
  return { h, runner, registry, persisted, manager };
}

describe.each(["sdk", "rpc"] as const)("manager with a real %s runner", (kind) => {
  it("resume reuses the resident child", async () => {
    const { h, runner, manager } = await setup(kind);
    h.script([{ text: "noted" }, { text: "kiwi" }]);
    await manager.run({ agent: "echo", task: "remember kiwi" });
    const { record, payload } = await manager.resume("echo", "which word?");
    expect(record.status).toBe("completed");
    expect(payload!.text).toContain("kiwi");
    expect(runner.opened).toHaveLength(1);
  });

  it("maxResident 0 restarts the child and keeps the context", async () => {
    const { h, runner, manager } = await setup(kind, { maxResident: 0 });
    h.script([{ text: "noted" }, { text: "kiwi" }]);
    await manager.run({ agent: "echo", task: "remember kiwi" });
    await manager.resume("echo", "which word?");
    expect(runner.opened).toHaveLength(2);
    expect(h.seen()[1]).toContain("remember kiwi");
  });

  it("a branch switch restarts the child at the pinned leaf", async () => {
    const { h, runner, registry, persisted, manager } = await setup(kind);
    h.script([{ text: "noted kiwi" }, { text: "noted mango" }, { text: "kiwi" }]);
    await manager.run({ agent: "echo", task: "remember the word kiwi" });
    const branchA = persisted.map((data) => ({ type: "custom", customType: REGISTRY_ENTRY_TYPE, data }));
    await manager.resume("echo", "remember the word mango");
    registry.reload(branchA);
    await manager.resume("echo", "which word?");
    expect(runner.opened).toHaveLength(2);
    expect(h.seen()[2]).toContain("kiwi");
    expect(h.seen()[2]).not.toContain("mango");
  });
});

describe("manager with a real rpc runner: close paths (REVIEW-001)", () => {
  const rpcChildren = () => childPids(["pi"]);
  const started = (before: number[]) => rpcChildren().filter((pid) => !before.includes(pid));

  it("stop ends the resident child", async () => {
    const before = rpcChildren();
    const { h, manager } = await setup("rpc");
    h.script([{ text: "ok" }]);
    await manager.run({ agent: "echo", task: "x" });
    const [pid] = started(before);
    expect(pid).toBeDefined();
    await manager.stop("echo");
    await vi.waitFor(() => expect(rpcChildren()).not.toContain(pid));
  });

  it("shutdown ends the resident child", async () => {
    const before = rpcChildren();
    const { h, manager } = await setup("rpc");
    h.script([{ text: "ok" }]);
    await manager.run({ agent: "echo", task: "x" });
    const [pid] = started(before);
    expect(pid).toBeDefined();
    await manager.shutdown();
    await vi.waitFor(() => expect(rpcChildren()).not.toContain(pid));
  });

  it("maxResident eviction ends the evicted child and keeps the new one", async () => {
    const before = rpcChildren();
    const { h, manager } = await setup("rpc", { maxResident: 1 });
    h.script([{ text: "a" }, { text: "b" }]);
    await manager.run({ agent: "echo", task: "x" });
    const [first] = started(before);
    expect(first).toBeDefined();
    await manager.run({ agent: "echo", task: "y" });
    await vi.waitFor(() => expect(rpcChildren()).not.toContain(first));
    expect(started(before)).toHaveLength(1);
    await manager.shutdown();
  });

  it("a mid-turn crash is recorded failed with the exit reason", async () => {
    const before = rpcChildren();
    const { h, manager } = await setup("rpc");
    // The provider delays, so the child is reliably busy when it is killed.
    h.script([{ text: "never", delayMs: 10_000 }]);
    const pending = manager.run({ agent: "echo", task: "start" });
    await vi.waitFor(() => expect(h.seen()).toHaveLength(1), { timeout: 15_000 });
    const [pid] = started(before);
    expect(pid).toBeDefined();
    process.kill(pid!, "SIGKILL");
    const { record, payload } = await pending;
    expect(record.status).toBe("failed");
    expect(record.error ?? "").toMatch(/signal SIGKILL/);
    expect(payload!.text).toMatch(/signal SIGKILL/);
  });
});