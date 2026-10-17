import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import type { DeliveryPort } from "../src/delivery.ts";
import { SubagentError, SubagentManager } from "../src/manager.ts";
import { REGISTRY_ENTRY_TYPE, Registry, type SubagentRecord } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";

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
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "mgr-"));
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    if (n === opts.failOpenAt) throw new Error("open failed");
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], opts.hold ?? false);
  });
  const sent: Parameters<DeliveryPort["sendMessage"]>[] = [];
  const entries: Parameters<DeliveryPort["appendEntry"]>[] = [];
  const manager = new SubagentManager({
    registry: opts.registry ?? new Registry(() => {}),
    scheduler: new Scheduler(() => opts.limit ?? 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([["reviewer", reviewer]]),
    settings: () => ({ ...DEFAULT_SETTINGS, ...opts.settings }),
    port: opts.port ?? { sendMessage: (...args) => sent.push(args), appendEntry: (...args) => entries.push(args) },
    receiverContextWindow: () => opts.contextWindow ?? 200000,
    cwd: root,
    sessionDir: join(root, "sessions"),
    outputDir: opts.outputDir ?? join(root, "out"),
  });
  return { manager, runner, sent, entries, root };
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
    const root = mkdtempSync(join(tmpdir(), "mgr-file-"));
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
    const blocker = join(mkdtempSync(join(tmpdir(), "mgr-leaf-")), "blocker");
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
