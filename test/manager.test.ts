import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import type { DeliveryPort } from "../src/delivery.ts";
import { ChainStore } from "../src/chain.ts";
import { SubagentError, type SettledInfo, SubagentManager } from "../src/manager.ts";
import { REGISTRY_ENTRY_TYPE, Registry, type SubagentRecord } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const reviewer: AgentDef = { name: "reviewer", description: "r", systemPrompt: "Review.", source: "user", filePath: "/a/reviewer.md" };

function setup(
  opts: {
    scripts?: ChildResult[][];
    hold?: boolean;
    contextWindow?: number;
    registry?: Registry;
    limit?: number;
    outputDir?: string;
    port?: DeliveryPort;
    /** Zero-based open index at which FakeRunner.open rejects with "open failed". */
    failOpenAt?: number;
    settings?: Partial<SubagentSettings>;
    /** How long each FakeSession.dispose() takes. */
    disposeDelayMs?: number;
    /** Project trust for a child cwd; the manager never guesses it. */
    trustForCwd?: (cwd: string) => boolean | undefined;
    /** Context window of a given agent's model; used by chain steps to size `{previous}`. */
    agentWindow?: (agent: AgentDef) => number | undefined;
  } = {},
) {
  const root = tempDir("mgr-");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    if (n === opts.failOpenAt) throw new Error("open failed");
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    const session = new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
    session.disposeDelayMs = opts.disposeDelayMs ?? 0;
    return session;
  });
  const sent: Parameters<DeliveryPort["sendMessage"]>[] = [];
  const entries: Parameters<DeliveryPort["appendEntry"]>[] = [];
  const settled: SettledInfo[] = [];
  const manager = new SubagentManager({
    registry: opts.registry ?? new Registry(() => {}),
    chainStore: new ChainStore(() => {}),
    scheduler: new Scheduler(() => opts.limit ?? 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([["reviewer", reviewer]]),
    settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings }),
    port: opts.port ?? { sendMessage: (...args) => sent.push(args), appendEntry: (...args) => entries.push(args) },
    receiverContextWindow: () => opts.contextWindow ?? 200000,
    cwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    outputDir: opts.outputDir ?? join(root, "out"),
    ...(opts.trustForCwd ? { trustForCwd: opts.trustForCwd } : {}),
    ...(opts.agentWindow ? { receiverContextWindowFor: opts.agentWindow } : {}),
    onSettled: (info) => settled.push(info),
  });
  return { manager, runner, sent, entries, settled, root };
}

const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });

describe("SubagentManager.run", () => {
  it("runs in the foreground and returns the payload", async () => {
    const { manager, runner } = setup({ scripts: [[ok("LGTM")]] });
    const { record, payload } = await manager.run({ agent: "reviewer", task: "review diff" });
    expect(payload?.text).toBe("LGTM");
    expect(record).toMatchObject({ handle: "reviewer", status: "completed", runId: 1 });
    expect(record.usage.cost).toBeCloseTo(0.01);
    expect(runner.opened[0]!.appendSystemPrompt.join("\n")).toContain("<summary>");
    expect(runner.sessions[0]!.disposed).toBe(true);
  });

  it("rejects an unknown agent with the available names", async () => {
    const { manager } = setup();
    await expect(manager.run({ agent: "nobody", task: "x" })).rejects.toThrow(/reviewer/);
  });

  it("marks a run failed on error stop reason", async () => {
    const { manager } = setup({ scripts: [[{ text: "", stopReason: "error", errorMessage: "rate limited", usage: usage(0) }]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x" });
    expect(record.status).toBe("failed");
    expect(record.error).toBe("rate limited");
  });

  it("marks a run failed on an empty answer", async () => {
    const { manager } = setup({ scripts: [[ok("   ")]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x" });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/empty/);
  });

  it("moves large output to a file for the receiver", async () => {
    const { manager } = setup({ scripts: [[ok("z".repeat(4000))]], contextWindow: 1000 });
    const { payload } = await manager.run({ agent: "reviewer", task: "x" });
    expect(payload?.filePath).toBeDefined();
  });
});

describe("SubagentManager.resume", () => {
  it("continues the same session and accumulates usage", async () => {
    const { manager, runner } = setup({ scripts: [[ok("first")], [ok("second")]] });
    const first = await manager.run({ agent: "reviewer", task: "x" });
    const second = await manager.resume("reviewer", "look again");
    expect(second.payload?.text).toBe("second");
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.runId).toBe(2);
    expect(second.record.usage.cost).toBeCloseTo(0.02);
    expect(runner.opened[1]!.resumeFile).toBe(first.record.sessionFile);
    expect(runner.sessions[1]!.prompts).toEqual(["look again"]);
  });

  it("resume unknown handle lists known handles", async () => {
    const { manager } = setup({ scripts: [[ok("a")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await expect(manager.resume("ghost", "hi")).rejects.toMatchObject({ code: "unknown_handle", message: expect.stringContaining("reviewer") });
  });

  it("resume stopped is rejected", async () => {
    const { manager } = setup({ scripts: [[ok("a")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.stop("reviewer");
    await expect(manager.resume("reviewer", "hi")).rejects.toMatchObject({ code: "stopped" });
  });

  it("resume missing session file is rejected", async () => {
    const { manager } = setup({ scripts: [[ok("a")]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x" });
    rmSync(record.sessionFile);
    await expect(manager.resume("reviewer", "hi")).rejects.toMatchObject({ code: "missing_session" });
  });

  it("concurrent resume rejected while running", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await expect(manager.resume("reviewer", "again")).rejects.toMatchObject({ code: "busy" });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
  });
});

describe("steer / interrupt / stop / background", () => {
  it("steers a running child", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.steer("reviewer", "focus on tests");
    expect(runner.sessions[0]!.steers).toEqual([{ text: "focus on tests", mode: "steer" }]);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
  });

  it("steer on a finished child says not_running", async () => {
    const { manager } = setup({ scripts: [[ok("a")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await expect(manager.steer("reviewer", "hi")).rejects.toMatchObject({ code: "not_running" });
  });

  it("interrupt pauses and the record can be resumed", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.interrupt("reviewer");
    await manager.whenIdle();
    expect(manager.list()[0]!.status).toBe("paused");
    expect(runner.sessions[0]!.aborted).toBe(1);
    const resumed = manager.resume("reviewer", "continue", { background: true });
    await resumed;
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    expect(manager.list()[0]!.status).toBe("completed");
  });

  it("stop marks a running child stopped, not paused", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.stop("reviewer");
    await manager.whenIdle();
    expect(manager.list()[0]!.status).toBe("stopped");
    expect(runner.sessions[0]!.disposed).toBe(true);
  });

  it("recoverInterrupted marks orphaned running records paused", () => {
    const registry = new Registry(() => {});
    registry.create({ agent: "reviewer", preferredHandle: "reviewer", runner: "sdk", depth: 1, sessionFile: "/x.jsonl", delivery: "share", task: "x" });
    const { manager } = setup({ registry });
    expect(manager.recoverInterrupted()).toBe(1);
    expect(manager.list()[0]!.status).toBe("paused");
  });

  it("background run delivers through the record's mode", async () => {
    const { manager, sent, entries } = setup({ scripts: [[ok("done!")]] });
    const { payload } = await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "private" });
    expect(payload).toBeUndefined();
    await manager.whenIdle();
    expect(sent).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]![0]).toBe("pi-subagents/private");
    expect((entries[0]![1] as { text: string }).text).toContain("done!");
  });

  it("background private entries carry the conclusion beside the full result", async () => {
    const { manager, entries } = setup({ scripts: [[ok("FULLTEXT\n<summary>brief</summary>")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "private" });
    await manager.whenIdle();
    expect(entries[0]![1]).toMatchObject({ summary: "brief" });
    expect((entries[0]![1] as { text: string }).text).toContain("FULLTEXT");
  });
});

describe("non-auto completion signal", () => {
  it("reports a background share result once with its conclusion and paths", async () => {
    const { manager, settled } = setup({ scripts: [[ok("FULLTEXT\n<summary>brief</summary>")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "share" });
    await manager.whenIdle();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ handle: "reviewer", agent: "reviewer", status: "completed", delivery: "share", summary: "brief" });
    expect(settled[0]!.filePath).toBeDefined();
    expect(settled[0]!.sessionFile).toContain("child-");
  });

  it("reports a background private result", async () => {
    const { manager, settled } = setup({ scripts: [[ok("done!\n<summary>brief</summary>")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "private" });
    await manager.whenIdle();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ status: "completed", delivery: "private", summary: "brief" });
  });

  it("reports a failed background result", async () => {
    const { manager, settled } = setup({ scripts: [[{ text: "", stopReason: "error", errorMessage: "rate limited", usage: usage(0) }]] });
    await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "share" });
    await manager.whenIdle();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ status: "failed", delivery: "share" });
    expect(settled[0]!.summary).toContain("rate limited");
  });

  it("stays silent for auto, which already starts a turn", async () => {
    const { manager, settled } = setup({ scripts: [[ok("done!")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.whenIdle();
    expect(settled).toEqual([]);
  });

  it("stays silent for a foreground result", async () => {
    const { manager, settled } = setup({ scripts: [[ok("done!")]] });
    await manager.run({ agent: "reviewer", task: "x", delivery: "share" });
    expect(settled).toEqual([]);
  });
});

describe("fix round 1", () => {
  it("stop while resume waits for a slot keeps the record stopped", async () => {
    const registry = new Registry(() => {});
    const { manager, runner } = setup({ limit: 1, hold: true, registry });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.interrupt("reviewer");
    await manager.whenIdle();
    expect(registry.resolve("reviewer")!.status).toBe("paused");
    await manager.run({ agent: "reviewer", task: "y", background: true });
    const p = manager.resume("reviewer", "again", { background: true });
    await manager.stop("reviewer");
    await expect(p).rejects.toMatchObject({ code: "stopped" });
    expect(registry.resolve("reviewer")!.status).toBe("stopped");
    expect(runner.opened).toHaveLength(2);
    runner.sessions[1]!.finish();
    await manager.whenIdle();
  });

  it("marks the run failed when result handling throws", async () => {
    const root = tempDir("mgr-file-");
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "");
    const { manager } = setup({ scripts: [[ok("z".repeat(4000))]], contextWindow: 1000, outputDir: join(blocker, "out") });
    const { record } = await manager.run({ agent: "reviewer", task: "x" });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/result handling failed/);
  });

  it("keeps the status and records the error when delivery fails", async () => {
    const port: DeliveryPort = {
      sendMessage: () => {
        throw new Error("port down");
      },
      appendEntry: () => {},
    };
    const { manager } = setup({ scripts: [[ok("done!")]], port });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.whenIdle();
    const record = manager.list()[0]!;
    expect(record.status).toBe("completed");
    expect(record.error).toMatch(/delivery failed: port down/);
  });

  it("failed resume restores delivery and error", async () => {
    const { manager } = setup({ failOpenAt: 1, scripts: [[{ text: "", stopReason: "error", errorMessage: "rate limited", usage: usage(0) }]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x" });
    expect(record.status).toBe("failed");
    await expect(manager.resume("reviewer", "x", { delivery: "private" })).rejects.toThrow("open failed");
    expect(manager.list()[0]).toMatchObject({ status: "failed", runId: 1, delivery: "auto", error: "rate limited" });
  });
});

describe("task 9 fix round 1", () => {
  it("shutdown cancels a run waiting for a slot", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const second = manager.run({ agent: "reviewer", task: "y", background: true });
    const rejected = expect(second).rejects.toThrow();
    await manager.shutdown();
    await rejected;
    expect(runner.opened).toHaveLength(1);
    expect(runner.sessions[0]!.aborted).toBe(1);
    await manager.whenIdle();
  });

  it("rejects new runs after shutdown", async () => {
    const { manager } = setup();
    await manager.shutdown();
    await expect(manager.run({ agent: "reviewer", task: "x" })).rejects.toThrow(/shut down/);
  });
});

describe("task 9 fix round 2", () => {
  it("aborting a queued foreground run rejects it without opening a session", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const c = new AbortController();
    const p = manager.run({ agent: "reviewer", task: "y", signal: c.signal });
    c.abort();
    await expect(p).rejects.toMatchObject({ code: "interrupted" });
    expect(runner.opened).toHaveLength(1);
    expect(manager.list()).toHaveLength(2);
    expect(manager.list()[1]).toMatchObject({ status: "stopped", error: "cancelled before it started" });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
  });

  it("aborting a running foreground run pauses only that run", async () => {
    const { manager, runner } = setup({ hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const c = new AbortController();
    const b = manager.run({ agent: "reviewer", task: "y", signal: c.signal });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(2));
    c.abort();
    const { record } = await b;
    expect(record.status).toBe("paused");
    expect(runner.sessions[0]!.aborted).toBe(0);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
  });

  it("aborting a queued resume rolls the record back", async () => {
    const registry = new Registry(() => {});
    const { manager, runner } = setup({ limit: 1, hold: true, registry });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.interrupt("reviewer");
    await manager.whenIdle();
    expect(registry.resolve("reviewer")!.status).toBe("paused");
    await manager.run({ agent: "reviewer", task: "y", background: true });
    const c = new AbortController();
    const p = manager.resume("reviewer", "again", { background: true, signal: c.signal });
    c.abort();
    await expect(p).rejects.toMatchObject({ code: "interrupted" });
    expect(registry.resolve("reviewer")).toMatchObject({ status: "paused", runId: 1 });
    runner.sessions[1]!.finish();
    await manager.whenIdle();
  });
});

describe("final fix wave", () => {
  it("activeRecords returns running and resuming records", async () => {
    const { manager, runner } = setup({ hold: true });
    const { record } = await manager.run({ agent: "reviewer", task: "x", background: true });
    const active = manager.activeRecords();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(record.id);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(manager.activeRecords()).toHaveLength(0);
  });

  it("background share delivers summary and file path, not the full text", async () => {
    const { manager, sent, root } = setup({ scripts: [[ok("FULLTEXT-" + "x".repeat(50) + "\n<summary>short</summary>")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "share" });
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    const message = sent[0]![0];
    expect(message.content).toContain("short");
    expect(message.content).not.toContain("FULLTEXT-");
    const filePath = (message.details as { filePath?: string }).filePath;
    expect(filePath).toBeDefined();
    expect(readFileSync(filePath!, "utf8").startsWith("FULLTEXT-")).toBe(true);
    expect(readdirSync(join(root, "out"))).toHaveLength(1);
  });

  it("keeps the root cause when delivery of a failed run fails", async () => {
    const port: DeliveryPort = {
      sendMessage: () => {
        throw new Error("port down");
      },
      appendEntry: () => {},
    };
    const { manager } = setup({ scripts: [[{ text: "", stopReason: "error", errorMessage: "rate limited", usage: usage(0) }]], port });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.whenIdle();
    const record = manager.list()[0]!;
    expect(record.status).toBe("failed");
    expect(record.error).toBe("rate limited; delivery failed: port down");
  });
});

describe("delivery defaults", () => {
  it("background runs started without a delivery mode use auto", async () => {
    const { manager, sent } = setup({ scripts: [[ok("done!")]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x", background: true });
    expect(record.delivery).toBe("auto");
    await manager.whenIdle();
    expect(sent[0]![1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });
});

describe("final fix wave round 2", () => {
  it("background private keeps short results inline", async () => {
    const { manager, entries, root } = setup({ scripts: [[ok("FULLTEXT-" + "x".repeat(50))]] });
    await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "private" });
    await manager.whenIdle();
    expect(entries).toHaveLength(1);
    expect((entries[0]![1] as { text: string }).text).toContain("FULLTEXT-");
    const outDir = join(root, "out");
    expect(existsSync(outDir) ? readdirSync(outDir) : []).toHaveLength(0);
  });
});

describe("queued runs", () => {
  it("a run waiting for a slot is listed as queued", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const second = manager.run({ agent: "reviewer", task: "y", background: true });
    expect(manager.list().map((r) => r.status)).toEqual(["running", "queued"]);
    expect(manager.list()[1]!.handle).toBe("reviewer-2");
    runner.sessions[0]!.finish();
    const { record } = await second;
    expect(record.status).toBe("running");
    expect(record.sessionFile).toBe(runner.sessions[1]!.sessionFile);
    runner.sessions[1]!.finish();
    await manager.whenIdle();
  });

  it.each(["interrupt", "stop"] as const)("%s cancels a queued run before it starts", async (action) => {
    const { manager, runner } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const second = manager.run({ agent: "reviewer", task: "y", background: true });
    const rejected = expect(second).rejects.toMatchObject({ code: "stopped" });
    await manager[action]("reviewer-2");
    await rejected;
    expect(manager.list()[1]).toMatchObject({ status: "stopped", error: "cancelled before it started" });
    expect(runner.opened).toHaveLength(1);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
  });

  it("resume and steer refuse a queued run", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const second = manager.run({ agent: "reviewer", task: "y", background: true });
    await expect(manager.resume("reviewer-2", "again")).rejects.toMatchObject({ code: "busy" });
    await expect(manager.steer("reviewer-2", "hint")).rejects.toMatchObject({ code: "not_running" });
    runner.sessions[0]!.finish();
    await second;
    runner.sessions[1]!.finish();
    await manager.whenIdle();
  });

  it("recoverInterrupted settles orphaned queued records", () => {
    const registry = new Registry(() => {});
    const { manager } = setup({ registry });
    registry.create({ agent: "reviewer", preferredHandle: "reviewer", runner: "sdk", depth: 1, sessionFile: "", delivery: "auto", task: "x", status: "queued" });
    expect(manager.recoverInterrupted()).toBe(1);
    expect(registry.resolve("reviewer")).toMatchObject({ status: "stopped", error: "interrupted by reload or restart before it started" });
  });

  it("shutdown settles a queued run as failed", async () => {
    const { manager } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const second = manager.run({ agent: "reviewer", task: "y", background: true });
    const rejected = expect(second).rejects.toThrow();
    await manager.shutdown();
    await rejected;
    expect(manager.list()[1]).toMatchObject({ status: "failed", error: "cut off by shutdown before it started" });
    await manager.whenIdle();
  });

  it("a run whose session fails to open is recorded as failed", async () => {
    const { manager } = setup({ failOpenAt: 0 });
    await expect(manager.run({ agent: "reviewer", task: "x" })).rejects.toThrow("open failed");
    expect(manager.list()[0]).toMatchObject({ status: "failed", error: "open failed", sessionFile: "" });
    await expect(manager.resume("reviewer", "again")).rejects.toMatchObject({ code: "missing_session" });
  });

  it("does not create a record when subagents are disabled", async () => {
    const { manager } = setup({ limit: 0 });
    await expect(manager.run({ agent: "reviewer", task: "x" })).rejects.toThrow(/disabled/);
    expect(manager.list()).toHaveLength(0);
  });

  it("activeRecords includes queued runs", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const second = manager.run({ agent: "reviewer", task: "y", background: true });
    expect(manager.activeRecords().map((r) => r.status).sort()).toEqual(["queued", "running"]);
    runner.sessions[0]!.finish();
    await second;
    runner.sessions[1]!.finish();
    await manager.whenIdle();
  });
});

describe("leaf pinning", () => {
  it("records the child leaf and resumes from it on every branch", async () => {
    const persisted: SubagentRecord[] = [];
    const registry = new Registry((r) => persisted.push(r));
    const { manager, runner } = setup({ registry, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(registry.resolve("reviewer")!.childLeafId).toBe("leaf-a");
    const branchA = persisted.map((data) => ({ type: "custom", customType: REGISTRY_ENTRY_TYPE, data }));

    await manager.resume("reviewer", "again", { background: true });
    expect(runner.opened[1]!.resumeLeafId).toBe("leaf-a");
    runner.sessions[1]!.leafId = "leaf-b";
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    expect(registry.resolve("reviewer")!.childLeafId).toBe("leaf-b");

    // Back on branch A (e.g. after /tree): the record there still points at leaf-a.
    registry.reload(branchA);
    await manager.resume("reviewer", "from branch a", { background: true });
    expect(runner.opened[2]!.resumeLeafId).toBe("leaf-a");
    runner.sessions[2]!.finish();
    await manager.whenIdle();
  });

  it("does not pass a leaf when the record has none", async () => {
    const { manager, runner } = setup({ scripts: [[ok("first")], [ok("second")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.resume("reviewer", "again");
    expect(runner.opened[1]).not.toHaveProperty("resumeLeafId");
  });
});

describe("mention asks", () => {
  it("quotes the question of a mention resume in the delivered result", async () => {
    const { manager, sent } = setup({ scripts: [[ok("first")], [ok("yes, it is")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.resume("reviewer", "is the null check right?", { background: true, delivery: "auto", mention: true });
    await manager.whenIdle();
    const content = sent[0]![0].content;
    expect(content).toContain("[user asked @reviewer]\nis the null check right?");
    expect(content).toContain("yes, it is");
  });

  it("does not quote a resume started by the tool", async () => {
    const { manager, sent } = setup({ scripts: [[ok("first")], [ok("second")]] });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.resume("reviewer", "again", { background: true, delivery: "auto" });
    await manager.whenIdle();
    expect(sent[0]![0].content).not.toContain("[user asked");
  });

  it("quotes a mention steer in the result of the running run", async () => {
    const { manager, runner, sent } = setup({ hold: true, scripts: [[ok("done with tests")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.steer("reviewer", "focus on tests", "steer", { mention: true });
    expect(runner.sessions[0]!.steers).toEqual([{ text: "focus on tests", mode: "steer" }]);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(sent[0]![0].content).toContain("[user added while it was running @reviewer]\nfocus on tests");
  });

  it("a private mention steer is not quoted in a shared result and does not change the run's delivery", async () => {
    const { manager, runner, sent } = setup({ hold: true, scripts: [[ok("done")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.steer("reviewer", "keep it to me", "steer", { mention: true, delivery: "private" });
    await manager.steer("reviewer", "also check tests", "steer", { mention: true, delivery: "auto" });
    expect(manager.list()[0]!.delivery).toBe("auto");
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]![0].content).not.toContain("keep it to me");
    expect(sent[0]![0].content).toContain("also check tests");
  });

  it("truncates a long mention question", async () => {
    const { manager, sent } = setup({ scripts: [[ok("first")], [ok("second")]], settings: { mentionQuoteMaxChars: 5 } });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.resume("reviewer", "abcdefghij", { background: true, delivery: "auto", mention: true });
    await manager.whenIdle();
    expect(sent[0]![0].content).toContain("abcde\n[... 5 more characters not shown]");
  });

  it("a foreground run returns the instructions added while it ran", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("final")]] });
    const pending = manager.run({ agent: "reviewer", task: "x" });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    await manager.steer("reviewer", "add a test", "steer", { mention: true });
    runner.sessions[0]!.finish();
    const { payload } = await pending;
    expect(payload!.text).toContain("[user added while it was running @reviewer]\nadd a test");
    expect(payload!.text).toContain("final");
  });
});

describe("fix round", () => {
  it("a private run quotes its private steers in its own private entry", async () => {
    const { manager, runner, entries } = setup({ hold: true, scripts: [[ok("done")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "private" });
    await manager.steer("reviewer", "keep it to me", "steer", { mention: true, delivery: "private" });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect((entries[0]![1] as { text: string }).text).toContain("keep it to me");
  });

  it("a shared run does not quote private steers and keeps its share delivery", async () => {
    // Arrange
    const { manager, runner, sent, entries } = setup({ hold: true, scripts: [[ok("done")]] });
    await manager.run({ agent: "reviewer", task: "x", background: true, delivery: "share" });
    // Act
    await manager.steer("reviewer", "keep it to me", "steer", { mention: true, delivery: "private" });
    await manager.steer("reviewer", "also check tests", "steer", { mention: true, delivery: "auto" });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    // Assert
    expect(manager.list()[0]!.delivery).toBe("share");
    expect(entries).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toEqual({ triggerTurn: false });
    expect(sent[0]![0].content).not.toContain("keep it to me");
    expect(sent[0]![0].content).toContain("also check tests");
  });

  it("a foreground result never quotes private steers", async () => {
    const { manager, runner } = setup({ hold: true, scripts: [[ok("final")]] });
    const pending = manager.run({ agent: "reviewer", task: "x" });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    await manager.steer("reviewer", "secret", "steer", { mention: true, delivery: "private" });
    runner.sessions[0]!.finish();
    const { payload } = await pending;
    expect(payload!.text).not.toContain("secret");
    expect(payload!.text).toContain("final");
  });

  it("steer on a resume that has not started yet says it is waiting", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.interrupt("reviewer");
    await manager.whenIdle();
    await manager.run({ agent: "reviewer", task: "y", background: true });
    const p = manager.resume("reviewer", "again", { background: true });
    await expect(manager.steer("reviewer", "hint")).rejects.toMatchObject({ code: "busy", message: expect.stringContaining("waiting to resume") });
    runner.sessions[1]!.finish();
    await p;
    runner.sessions[2]!.finish();
    await manager.whenIdle();
  });

  it("keeps the child leaf when result handling fails", async () => {
    const blocker = join(tempDir("mgr-leaf-"), "blocker");
    writeFileSync(blocker, "");
    const { manager, runner } = setup({ hold: true, scripts: [[ok("z".repeat(4000))]], contextWindow: 1000, outputDir: join(blocker, "out") });
    const pending = manager.run({ agent: "reviewer", task: "x" });
    await vi.waitFor(() => expect(runner.sessions).toHaveLength(1));
    runner.sessions[0]!.leafId = "leaf-x";
    runner.sessions[0]!.finish();
    const { record } = await pending;
    expect(record.status).toBe("failed");
    expect(record.childLeafId).toBe("leaf-x");
  });

  it("a cancel whose status cannot be persisted still keeps the run from starting", async () => {
    let failPersist = false;
    const registry = new Registry(() => {
      if (failPersist) throw new Error("persist failed");
    });
    const { manager, runner } = setup({ limit: 1, hold: true, registry });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const second = manager.run({ agent: "reviewer", task: "y", background: true });
    const rejected = expect(second).rejects.toMatchObject({ code: "stopped" });
    failPersist = true;
    await expect(manager.stop("reviewer-2")).rejects.toThrow("persist failed");
    failPersist = false;
    runner.sessions[0]!.finish();
    await rejected;
    await manager.whenIdle();
    expect(runner.opened).toHaveLength(1);
  });

  it("interrupt reports whether it paused or cancelled", async () => {
    const { manager, runner } = setup({ limit: 1, hold: true });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const second = manager.run({ agent: "reviewer", task: "y", background: true });
    const rejected = expect(second).rejects.toMatchObject({ code: "stopped" });
    expect(await manager.interrupt("reviewer-2")).toBe("cancelled");
    await rejected;
    expect(await manager.interrupt("reviewer")).toBe("paused");
    await manager.whenIdle();
    expect(runner.opened).toHaveLength(1);
  });
});

describe("checkResumable", () => {
  it("reports the reason a resume would fail without starting anything", async () => {
    const { manager, runner } = setup({ scripts: [[ok("first")]] });
    expect(manager.checkResumable("nobody")).toMatchObject({ code: "unknown_handle" });
    await manager.run({ agent: "reviewer", task: "x" });
    expect(manager.checkResumable("reviewer")).toBeUndefined();
    rmSync(runner.sessions[0]!.sessionFile);
    expect(manager.checkResumable("reviewer")).toMatchObject({ code: "missing_session" });
    await manager.stop("reviewer");
    expect(manager.checkResumable("reviewer")).toMatchObject({ code: "stopped" });
    expect(runner.opened).toHaveLength(1);
  });
});

describe("cwd and trust", () => {
  it("runs in the given cwd and records it", async () => {
    const dir = tempDir("cwd-");
    const { manager, runner } = setup({ scripts: [[ok("hi")]] });
    const { record } = await manager.run({ agent: "reviewer", task: "x", cwd: dir });
    expect(record.cwd).toBe(dir);
    expect(runner.opened[0]!.cwd).toBe(dir);
  });

  it("resolves a relative cwd against the main cwd and rejects a missing one", async () => {
    const { manager, runner, root } = setup({ scripts: [[ok("hi")]] });
    mkdirSync(join(root, "sub"), { recursive: true });
    await manager.run({ agent: "reviewer", task: "x", cwd: "sub" });
    expect(runner.opened[0]!.cwd).toBe(join(root, "sub"));
    await expect(manager.run({ agent: "reviewer", task: "y", cwd: "nope" })).rejects.toMatchObject({ code: "missing_cwd" });
  });

  it("uses the main session's trust only for the main cwd", async () => {
    const other = tempDir("other-");
    const { manager, runner, root } = setup({ scripts: [[ok("a")], [ok("b")]], trustForCwd: (cwd) => (cwd === root ? true : false) });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.run({ agent: "reviewer", task: "y", cwd: other });
    expect(runner.opened[0]!.projectTrusted).toBe(true);
    expect(runner.opened[1]!.projectTrusted).toBe(false);
  });

  it("resume runs in the recorded cwd", async () => {
    const dir = tempDir("cwd-resume-");
    const { manager, runner } = setup({ scripts: [[ok("a")], [ok("b")]] });
    await manager.run({ agent: "reviewer", task: "x", cwd: dir });
    await manager.resume("reviewer", "again");
    expect(runner.opened[1]!.cwd).toBe(dir);
  });

  it("resume reports a missing cwd", async () => {
    const dir = tempDir("cwd-gone-");
    const { manager } = setup({ scripts: [[ok("a")]] });
    await manager.run({ agent: "reviewer", task: "x", cwd: dir });
    rmSync(dir, { recursive: true, force: true });
    await expect(manager.resume("reviewer", "again")).rejects.toMatchObject({ code: "missing_cwd" });
  });

  it("checkResumable reports a missing cwd like resume does", async () => {
    // Arrange: a completed run whose recorded cwd still exists.
    const dir = tempDir("cwd-check-");
    const { manager, runner } = setup({ scripts: [[ok("a")]] });
    await manager.run({ agent: "reviewer", task: "x", cwd: dir });
    expect(manager.checkResumable("reviewer")).toBeUndefined();

    // Act: the recorded cwd disappears.
    rmSync(dir, { recursive: true, force: true });

    // Assert: checkResumable reports the same error resume would reject with, without opening anything.
    expect(manager.checkResumable("reviewer")).toMatchObject({ code: "missing_cwd" });
    expect(runner.opened).toHaveLength(1);
  });

  it("rejects a cwd that points at a file instead of a directory", async () => {
    // Arrange: a regular file where the child would run.
    const { manager, root } = setup();
    const file = join(root, "not-a-dir");
    writeFileSync(file, "");

    // Act / Assert: resolveCwd only accepts directories, and no record is created.
    await expect(manager.run({ agent: "reviewer", task: "x", cwd: file })).rejects.toMatchObject({ code: "missing_cwd" });
    expect(manager.list()).toHaveLength(0);
  });

  it("resume of a legacy record without a cwd falls back to the manager cwd", async () => {
    // Arrange: a record persisted before M4 (no cwd field) is rebuilt from its session entry.
    const dir = tempDir("legacy-");
    const sessionFile = join(dir, "legacy.jsonl");
    writeFileSync(sessionFile, "");
    const legacy = {
      id: "legacy-1",
      handle: "reviewer",
      agent: "reviewer",
      runner: "sdk",
      depth: 1,
      sessionFile,
      runId: 1,
      status: "completed",
      delivery: "auto",
      task: "x",
      createdAt: 1,
      updatedAt: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    const registry = Registry.rebuild([{ type: "custom", customType: REGISTRY_ENTRY_TYPE, data: legacy }], () => {});
    const { manager, runner, root } = setup({ registry, scripts: [[ok("resumed")]] });
    expect(registry.resolve("reviewer")!.cwd).toBeUndefined();

    // Act
    const { payload } = await manager.resume("reviewer", "again");

    // Assert: the child opens in the manager's cwd, exactly as a pre-M4 record was expected to.
    expect(payload!.text).toBe("resumed");
    expect(runner.opened[0]!.cwd).toBe(root);
  });
});

describe("receiver context window override", () => {
  it("uses the run's receiverContextWindow instead of the manager default", async () => {
    // Arrange: the receiver window is tiny, so a long answer would normally be written to a file.
    const long = "z".repeat(4000);
    const { manager } = setup({ scripts: [[ok(long)], [ok(long)]], contextWindow: 1000 });

    // Act: the caller sizes the output for a larger receiver (e.g. the next chain step).
    const overridden = await manager.run({ agent: "reviewer", task: "x", receiverContextWindow: 100000 });
    const defaulted = await manager.run({ agent: "reviewer", task: "y" });

    // Assert: only the defaulted run spills to a file.
    expect(overridden.payload!.filePath).toBeUndefined();
    expect(overridden.payload!.text).toContain(long);
    expect(defaulted.payload!.filePath).toBeDefined();
    expect(defaulted.payload!.text).toContain("Full output (");
  });

  it("uses the resume's receiverContextWindow override", async () => {
    // Arrange: same tiny receiver window, and a long answer for the resumed turn.
    const long = "y".repeat(4000);
    const { manager } = setup({ scripts: [[ok("first")], [ok(long)], [ok(long)]], contextWindow: 1000 });
    await manager.run({ agent: "reviewer", task: "x" });

    // Act
    const overridden = await manager.resume("reviewer", "again", { receiverContextWindow: 100000 });
    const defaulted = await manager.resume("reviewer", "once more");

    // Assert
    expect(overridden.payload!.filePath).toBeUndefined();
    expect(overridden.payload!.text).toContain(long);
    expect(defaulted.payload!.filePath).toBeDefined();
    expect(defaulted.payload!.text).toContain("Full output (");
  });
});

describe("resident children", () => {
  it("resume reuses an idle child instead of opening a new one", async () => {
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(runner.sessions[0]!.disposed).toBe(false);
    await manager.resume("reviewer", "again", { background: true });
    expect(runner.opened).toHaveLength(1);
    expect(runner.sessions[0]!.prompts).toEqual(["x", "again"]);
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    await manager.shutdown();
    expect(runner.sessions[0]!.disposed).toBe(true);
  });

  it("maxResident 0 closes the child after every turn", async () => {
    const { manager, runner } = setup({ scripts: [[ok("first")], [ok("second")]], settings: { maxResident: 0 } });
    await manager.run({ agent: "reviewer", task: "x" });
    expect(runner.sessions[0]!.disposed).toBe(true);
    await manager.resume("reviewer", "again");
    expect(runner.opened).toHaveLength(2);
  });

  it("restarts a resident child whose leaf no longer matches the record", async () => {
    const persisted: SubagentRecord[] = [];
    const registry = new Registry((r) => persisted.push(r));
    const { manager, runner } = setup({ hold: true, registry, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    const branchA = persisted.map((data) => ({ type: "custom", customType: REGISTRY_ENTRY_TYPE, data }));
    await manager.resume("reviewer", "on branch b", { background: true });
    runner.sessions[0]!.leafId = "leaf-b";
    runner.sessions[0]!.finish();
    await manager.whenIdle();

    // Back on branch A: the record says leaf-a, the resident child is at leaf-b.
    registry.reload(branchA);
    await manager.resume("reviewer", "on branch a", { background: true });
    expect(runner.sessions[0]!.disposed).toBe(true);
    expect(runner.opened).toHaveLength(2);
    expect(runner.opened[1]!.resumeLeafId).toBe("leaf-a");
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    await manager.shutdown();
  });

  it("evicts the least recently used idle child above maxResident", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [ok("b")]], settings: { maxResident: 1 } });
    await manager.run({ agent: "reviewer", task: "x" });
    expect(runner.sessions[0]!.disposed).toBe(false);
    await manager.run({ agent: "reviewer", task: "y" });
    expect(runner.sessions[0]!.disposed).toBe(true);
    expect(runner.sessions[1]!.disposed).toBe(false);
    await manager.shutdown();
  });

  it("never evicts running children, even above maxResident", async () => {
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 1 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.run({ agent: "reviewer", task: "y", background: true });
    expect(runner.sessions.map((s) => s.disposed)).toEqual([false, false]);
    runner.sessions[0]!.finish();
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    expect(runner.sessions.filter((s) => !s.disposed)).toHaveLength(1);
    await manager.shutdown();
  });

  it("a child that exited while idle is replaced on resume", async () => {
    // Arrange: the record and the idle child agree on the leaf, so only the exit can make resume restart it.
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(manager.list()[0]!.childLeafId).toBe("leaf-a");
    expect(runner.sessions[0]!.disposed).toBe(false);

    // Act
    runner.sessions[0]!.exit("killed");
    await manager.resume("reviewer", "again", { background: true });
    runner.sessions[1]!.finish();
    await manager.whenIdle();

    // Assert: a new child resumes the session file at the recorded leaf; the dead one gets no prompt.
    expect(runner.opened).toHaveLength(2);
    expect(runner.opened[1]!.resumeFile).toBe(runner.sessions[0]!.sessionFile);
    expect(runner.opened[1]!.resumeLeafId).toBe("leaf-a");
    expect(runner.sessions[0]!.prompts).toEqual(["x"]);
    expect(runner.sessions[1]!.prompts).toEqual(["again"]);
    expect(manager.list()[0]!.status).toBe("completed");
    await manager.shutdown();
  });

  it("stop and shutdown close idle children", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [ok("b")]], settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.run({ agent: "reviewer", task: "y" });
    await manager.stop("reviewer");
    expect(runner.sessions[0]!.disposed).toBe(true);
    expect(runner.sessions[1]!.disposed).toBe(false);
    await manager.shutdown();
    expect(runner.sessions[1]!.disposed).toBe(true);
  });

  it("a resume refreshes recency so the other idle child is evicted first", async () => {
    // Arrange: two idle children A (older) and B (newer); resuming A makes B the least recently used.
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 2 } });
    await manager.run({ agent: "reviewer", task: "a", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    await manager.run({ agent: "reviewer", task: "b", background: true });
    runner.sessions[1]!.leafId = "leaf-b";
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    await manager.resume("reviewer", "a again", { background: true });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(runner.opened).toHaveLength(2);

    // Act: a third child starts running, so live + idle exceeds the limit.
    await manager.run({ agent: "reviewer", task: "c", background: true });

    // Assert: B (least recently used) is evicted, A stays resident.
    expect(runner.sessions[1]!.disposed).toBe(true);
    expect(runner.sessions[0]!.disposed).toBe(false);
    runner.sessions[2]!.finish();
    await manager.whenIdle();
    await manager.shutdown();
  });

  it("maxResident -1 keeps every idle child open", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [ok("b")], [ok("c")]], settings: { maxResident: -1 } });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.run({ agent: "reviewer", task: "y" });
    await manager.run({ agent: "reviewer", task: "z" });
    expect(runner.sessions.map((s) => s.disposed)).toEqual([false, false, false]);
    await manager.shutdown();
    expect(runner.sessions.every((s) => s.disposed)).toBe(true);
  });

  it("stopping a running resident child closes it instead of parking it", async () => {
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    await manager.stop("reviewer");
    await manager.whenIdle();
    await vi.waitFor(() => expect(runner.sessions[0]!.disposed).toBe(true));
    await manager.shutdown();
  });

  it("with maxResident 0 the child has finished closing when run() returns", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")]], disposeDelayMs: 50, settings: { maxResident: 0 } });
    await manager.run({ agent: "reviewer", task: "x" });
    expect(runner.sessions[0]!.disposeDone).toBe(true);
  });

  it("an evicted child has finished closing before resume reopens its session file", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [ok("b")], [ok("a2")]], disposeDelayMs: 50, settings: { maxResident: 1 } });
    await manager.run({ agent: "reviewer", task: "x" });
    // Starting a second child evicts the first (idle) one.
    await manager.run({ agent: "reviewer", task: "y" });
    expect(runner.sessions[0]!.disposed).toBe(true);
    const open = runner.open.bind(runner);
    const closedAtOpen: boolean[] = [];
    runner.open = async (spec) => {
      closedAtOpen.push(runner.sessions[0]!.disposeDone);
      return open(spec);
    };
    await manager.resume("reviewer", "again");
    expect(runner.opened[2]!.resumeFile).toBe(runner.sessions[0]!.sessionFile);
    expect(closedAtOpen).toEqual([true]);
    await manager.shutdown();
  });

  it("stop on an idle child returns once the child has finished closing", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")]], disposeDelayMs: 50, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.stop("reviewer");
    expect(runner.sessions[0]!.disposeDone).toBe(true);
    await manager.shutdown();
  });

  it("whenIdle waits for an evicted child to finish closing", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [ok("b")]], disposeDelayMs: 50, settings: { maxResident: 1 } });
    await manager.run({ agent: "reviewer", task: "x" });
    await manager.run({ agent: "reviewer", task: "y" });
    await manager.whenIdle();
    expect(runner.sessions[0]!.disposeDone).toBe(true);
    await manager.shutdown();
  });

  it("shutdown waits for idle children and children still closing", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")], [ok("b")]], disposeDelayMs: 50, settings: { maxResident: 1 } });
    await manager.run({ agent: "reviewer", task: "x" });
    // The evicted child takes longer to close than the idle one shutdown closes itself.
    runner.sessions[0]!.disposeDelayMs = 150;
    await manager.run({ agent: "reviewer", task: "y" });
    await manager.shutdown();
    expect(runner.sessions.map((s) => s.disposeDone)).toEqual([true, true]);
  });

  it("a resident child whose leaf cannot be read is closed and reopened on resume", async () => {
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    Object.defineProperty(runner.sessions[0]!, "leafId", {
      get() {
        throw new Error("leaf unreadable");
      },
    });
    await manager.resume("reviewer", "again", { background: true });
    expect(runner.sessions[0]!.disposed).toBe(true);
    expect(runner.opened).toHaveLength(2);
    expect(runner.opened[1]!.resumeLeafId).toBe("leaf-a");
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    await manager.shutdown();
  });

  it("a child that exits while idle is still disposed", async () => {
    const { manager, runner } = setup({ scripts: [[ok("a")]], settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x" });
    runner.sessions[0]!.exit("killed");
    await manager.whenIdle();
    expect(runner.sessions[0]!.disposed).toBe(true);
    await manager.shutdown();
  });

  it("with maxResident 1 a child that exited while idle no longer holds the slot", async () => {
    // Arrange: A is the only resident child, then it exits while idle.
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 1 } });
    await manager.run({ agent: "reviewer", task: "a", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    runner.sessions[0]!.exit("killed");
    await manager.whenIdle();
    expect(runner.sessions[0]!.disposed).toBe(true);

    // Act: a new child B runs and becomes idle.
    await manager.run({ agent: "reviewer", task: "b", background: true });
    runner.sessions[1]!.leafId = "leaf-b";
    runner.sessions[1]!.finish();
    await manager.whenIdle();

    // Assert: B keeps the single slot and a resume of B reuses it.
    expect(runner.sessions[1]!.disposed).toBe(false);
    const b = manager.list().find((r) => r.sessionFile === runner.sessions[1]!.sessionFile)!;
    await manager.resume(b.handle, "b again", { background: true });
    expect(runner.opened).toHaveLength(2);
    expect(runner.sessions[1]!.prompts).toEqual(["b", "b again"]);
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    await manager.shutdown();
  });

  it("a child that exited while idle does not make a live idle child get evicted", async () => {
    // Arrange: A (older) and B (newer) are idle with maxResident 2; then B exits.
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 2 } });
    await manager.run({ agent: "reviewer", task: "a", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    await manager.run({ agent: "reviewer", task: "b", background: true });
    runner.sessions[1]!.leafId = "leaf-b";
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    runner.sessions[1]!.exit("killed");

    // Act: C starts running; live C + idle A fit in the limit only if the dead B is gone.
    await manager.run({ agent: "reviewer", task: "c", background: true });

    // Assert
    expect(runner.sessions[0]!.disposed).toBe(false);
    expect(runner.sessions[1]!.disposed).toBe(true);
    runner.sessions[2]!.finish();
    await manager.whenIdle();
    await manager.shutdown();
  });

  it("a dead idle child is not reused even before its exit is reported", async () => {
    // Arrange: the idle child is at the recorded leaf but no longer alive (exit not reported yet).
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    runner.sessions[0]!.exited = true;

    // Act
    await manager.resume("reviewer", "again", { background: true });

    // Assert
    expect(runner.opened).toHaveLength(2);
    expect(runner.opened[1]!.resumeLeafId).toBe("leaf-a");
    expect(runner.sessions[0]!.prompts).toEqual(["x"]);
    expect(runner.sessions[0]!.disposed).toBe(true);
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    await manager.shutdown();
  });

  it("a child that dies during a run is closed instead of parked", async () => {
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.exit("killed");
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    expect(runner.sessions[0]!.disposed).toBe(true);
    await manager.resume("reviewer", "again", { background: true });
    expect(runner.opened).toHaveLength(2);
    runner.sessions[1]!.finish();
    await manager.whenIdle();
    await manager.shutdown();
  });

  it("shutdown closes a running resident child instead of parking it", async () => {
    // Arrange: the child's prompt settles only after shutdown has closed the idle children it knew about.
    const { manager, runner } = setup({ hold: true, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    const session = runner.sessions[0]!;
    session.leafId = "leaf-a";
    const abort = session.abort.bind(session);
    session.abort = async () => {
      setTimeout(() => void abort(), 10);
    };

    // Act
    await manager.shutdown();
    await vi.waitFor(() => expect(session.aborted).toBe(1));
    await manager.whenIdle();

    // Assert
    expect(session.disposed).toBe(true);
    expect(manager.list()[0]!.status).toBe("paused");
  });

  it("stop while resume waits for a mismatched child to close leaves nothing open", async () => {
    // Arrange: the idle child is at leaf-b while the record says leaf-a, and its dispose takes 50 ms.
    const { manager, runner } = setup({ hold: true, disposeDelayMs: 50, settings: { maxResident: 4 } });
    await manager.run({ agent: "reviewer", task: "x", background: true });
    runner.sessions[0]!.leafId = "leaf-a";
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    runner.sessions[0]!.leafId = "leaf-b";
    const resumed = manager.resume("reviewer", "again", { background: true });
    const settled = resumed.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(runner.sessions[0]!.disposed).toBe(true));
    expect(runner.sessions[0]!.disposeDone).toBe(false);

    // Act
    await manager.stop("reviewer");

    // Assert
    expect(runner.sessions[0]!.disposeDone).toBe(true);
    const error = await settled;
    expect(error).toBeInstanceOf(SubagentError);
    expect((error as SubagentError).code).toBe("stopped");
    await manager.whenIdle();
    expect(manager.list()[0]!.status).toBe("stopped");
    // Current behaviour: resume may still open a new child after the stop, but it closes it without prompting it.
    expect(runner.sessions.every((s) => s.disposeDone)).toBe(true);
    expect(runner.sessions.slice(1).every((s) => s.prompts.length === 0)).toBe(true);
    expect(runner.sessions[0]!.prompts).toEqual(["x"]);
    await manager.shutdown();
  });

  it("with maxResident 1 only one of three concurrent children stays open", async () => {
    const { manager, runner } = setup({ hold: true, limit: 3, settings: { maxResident: 1 } });
    await manager.run({ agent: "reviewer", task: "a", background: true });
    await manager.run({ agent: "reviewer", task: "b", background: true });
    await manager.run({ agent: "reviewer", task: "c", background: true });
    expect(runner.sessions.map((s) => s.disposed)).toEqual([false, false, false]);
    for (const s of runner.sessions) s.finish();
    await manager.whenIdle();
    expect(manager.list().map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
    expect(runner.sessions.filter((s) => !s.disposed)).toHaveLength(1);
    expect(runner.sessions.filter((s) => s.disposed).every((s) => s.disposeDone)).toBe(true);
    await manager.shutdown();
  });
});
