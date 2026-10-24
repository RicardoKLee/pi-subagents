import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import { mailboxHost } from "../src/child.ts";
import { callViaMailbox, DELEGATION_TIMEOUT_MS, ensureMailbox, MailboxServer, mailboxPaths, type MailboxErrorInfo, type MailboxRequest } from "../src/mailbox.ts";
import { SubagentManager } from "../src/manager.ts";
import { Registry } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { executeAction, SUBAGENT_ACTIONS, SubagentsParams } from "../src/tool.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const request = (id: string): MailboxRequest => ({ id, parentRecordId: "rec-1", payload: { action: "run", agent: "worker", task: "x" } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mailboxPaths", () => {
  it("places requests and responses under the mailbox directory", () => {
    expect(mailboxPaths("/m")).toEqual({ requests: "/m/requests", responses: "/m/responses" });
  });
});

describe("MailboxServer", () => {
  it("handles a request, writes the response and removes both files", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    const seen: MailboxRequest[] = [];
    const server = new MailboxServer(dir, async (req) => {
      seen.push(req);
      return { id: req.id, ok: true, text: "done" };
    });
    writeFileSync(join(paths.requests, "r1.json"), JSON.stringify(request("r1")));
    expect(await server.tick()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(readdirSync(paths.requests)).toHaveLength(0);
    expect(existsSync(join(paths.responses, "r1.json"))).toBe(true);
  });

  it("turns a handler error into an error response and skips unrelated files", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    writeFileSync(join(paths.requests, "junk.txt"), "not json");
    writeFileSync(join(paths.requests, "r2.json"), JSON.stringify(request("r2")));
    const server = new MailboxServer(dir, async (req) => {
      if (req.id === "r2") throw new Error("boom");
      return { id: req.id, ok: true, text: "x" };
    });
    expect(await server.tick()).toBe(2);
    expect(readdirSync(paths.requests)).toHaveLength(0);
    const written = JSON.parse(readFileSync(join(paths.responses, "r2.json"), "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({ id: "r2", ok: false, error: "boom" });
  });

  it("stops polling when stopped", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    const server = new MailboxServer(dir, async (req) => ({ id: req.id, ok: true, text: "x" }), { pollMs: 5 });
    server.start();
    expect(server.running).toBe(true);
    server.stop();
    expect(server.running).toBe(false);
    // Nothing scans the directory any more: a request written after stop stays untouched.
    writeFileSync(join(paths.requests, "after-stop.json"), JSON.stringify(request("after-stop")));
    await sleep(40);
    expect(existsSync(join(paths.requests, "after-stop.json"))).toBe(true);
  });

  it("is idempotent and processes a request exactly once even when ticks overlap", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    let seen = 0;
    const server = new MailboxServer(dir, async (req) => {
      seen++;
      // Hold the scan open so the second tick starts while the first one is still handling the request.
      await sleep(20);
      return { id: req.id, ok: true, text: "x" };
    });
    writeFileSync(join(paths.requests, "same.json"), JSON.stringify(request("same")));
    const [first, second] = await Promise.all([server.tick(), server.tick()]);
    expect(first + second).toBe(1);
    expect(seen).toBe(1);
    // A later pass over the now-empty directory has nothing left to consume.
    expect(await server.tick()).toBe(0);
    expect(seen).toBe(1);
  });

  it("drops a corrupt request and removes junk without escaping the mailbox", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    writeFileSync(join(paths.requests, "broken.json"), "{not json");
    writeFileSync(join(paths.requests, "traversal.json"), JSON.stringify({ id: "../escape", parentRecordId: "rec-1", payload: {} }));
    writeFileSync(join(paths.requests, "notes.txt"), "junk");
    const server = new MailboxServer(dir, async (req) => ({ id: req.id, ok: true }));
    expect(await server.tick()).toBe(3);
    expect(readdirSync(paths.requests)).toHaveLength(0);
    // A "../escape" id must not write a response outside the responses directory.
    expect(readdirSync(paths.responses)).toHaveLength(0);
    expect(existsSync(join(dir, "escape.json"))).toBe(false);
  });
});

describe("callViaMailbox", () => {
  it("resolves with the server's response", async () => {
    const dir = tempDir("mbox-");
    ensureMailbox(dir);
    const server = new MailboxServer(dir, async (req) => ({ id: req.id, ok: true, text: `handled ${req.payload.action}` }));
    server.start();
    const response = await callViaMailbox(dir, request("c1"), { timeoutMs: 2_000, pollMs: 10 });
    server.stop();
    expect(response).toMatchObject({ ok: true, text: "handled run" });
  });

  it("leaves both mailbox directories empty after a successful call", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    const server = new MailboxServer(dir, async (req) => ({ id: req.id, ok: true, text: "ok" }));
    server.start();
    const response = await callViaMailbox(dir, request("c1b"), { timeoutMs: 2_000, pollMs: 10 });
    server.stop();
    expect(response.ok).toBe(true);
    // The client removes the request it wrote and the response it consumed: nothing is left behind.
    expect(readdirSync(paths.requests)).toHaveLength(0);
    expect(readdirSync(paths.responses)).toHaveLength(0);
  });

  it("waits far longer than a control command for a delegation answer", () => {
    expect(DELEGATION_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("times out when nobody answers", async () => {
    const dir = tempDir("mbox-");
    ensureMailbox(dir);
    await expect(callViaMailbox(dir, request("c2"), { timeoutMs: 50, pollMs: 10 })).rejects.toThrow(/timed out/);
  });

  it("leaves no request file behind when it times out", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    await expect(callViaMailbox(dir, request("c2b"), { timeoutMs: 50, pollMs: 10 })).rejects.toThrow(/timed out/);
    // An unanswered request must not sit in the mailbox for the parent to pick up and answer late.
    expect(readdirSync(paths.requests)).toHaveLength(0);
    expect(readdirSync(paths.responses)).toHaveLength(0);
  });

  it("clamps a zero poll interval to at least 1ms (REVIEW-041)", async () => {
    const dir = tempDir("mbox-");
    ensureMailbox(dir);
    const timer = vi.spyOn(globalThis, "setTimeout");
    let pollDelays: number[] = [];
    try {
      await expect(callViaMailbox(dir, request("clamp"), { timeoutMs: 30, pollMs: 0 })).rejects.toThrow(/timed out/);
      // The polling sleeps are the only sub-second timers this call schedules: none may ask for 0ms (a busy loop).
      pollDelays = timer.mock.calls.map((call) => call[1]).filter((ms): ms is number => typeof ms === "number" && ms < 1_000);
    } finally {
      timer.mockRestore();
    }
    expect(pollDelays.length).toBeGreaterThan(0);
    expect(Math.min(...pollDelays)).toBeGreaterThanOrEqual(1);
  });

  it("fails fast when the signal is already aborted and leaves no files behind", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    const controller = new AbortController();
    controller.abort();
    await expect(callViaMailbox(dir, request("c3"), { timeoutMs: 5_000, pollMs: 5, signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(readdirSync(paths.requests)).toHaveLength(0);
    expect(readdirSync(paths.responses)).toHaveLength(0);
  });

  it("aborts while waiting for the answer and still cleans the request file up", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    const controller = new AbortController();
    const pending = callViaMailbox(dir, request("c3b"), { timeoutMs: 5_000, pollMs: 5, signal: controller.signal });
    // The request is written synchronously before the first await, so it is on disk while we abort.
    expect(readdirSync(paths.requests)).toHaveLength(1);
    await sleep(30);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(readdirSync(paths.requests)).toHaveLength(0);
    expect(readdirSync(paths.responses)).toHaveLength(0);
  });
});

describe("mailboxHost", () => {
  it("does not leak the mailbox path to the child session when the transport fails (REVIEW-023)", async () => {
    const root = tempDir("mbox-");
    const blocked = join(root, "mailbox");
    // A plain file where the mailbox directory should be makes the first mkdir fail with a path-bearing error.
    writeFileSync(blocked, "not a directory");
    const host = mailboxHost(blocked, "rec-1");
    const error = await host.request("rec-1", { action: "list" }).then(
      () => undefined,
      (thrown: Error) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain(root);
    expect(error!.message).not.toContain(blocked);
  });

  it("surfaces the server's error text without the mailbox path when the answer is not ok (REVIEW-023)", async () => {
    const dir = tempDir("mbox-");
    ensureMailbox(dir);
    const server = new MailboxServer(dir, async (req) => ({ id: req.id, ok: false, error: `delegation refused for ${dir}` }));
    server.start();
    const host = mailboxHost(dir, "rec-1");
    const error = await host.request("rec-1", { action: "list" }).then(
      () => undefined,
      (thrown: Error) => thrown,
    );
    server.stop();
    expect(error).toBeInstanceOf(Error);
    // The error text is preserved, but every occurrence of the internal mailbox directory is scrubbed.
    expect(error!.message).toMatch(/delegation refused for/);
    expect(error!.message).not.toContain(dir);
    expect(error!.message).toContain("<mailbox>");
  });
});

describe("delegation payload validation (REVIEW-033)", () => {
  it("rejects an unknown action before it reaches the manager", async () => {
    // The check runs before any dependency is touched, so an empty bag of deps is enough to observe it.
    const manager = new SubagentManager({} as never);
    await expect(manager.delegate("rec-1", { action: "bogus" })).rejects.toThrow(/unknown action "bogus"/);
  });

  it("rejects a missing or non-string action", async () => {
    const manager = new SubagentManager({} as never);
    await expect(manager.delegate("rec-1", {})).rejects.toThrow(/unknown action undefined/);
    await expect(manager.delegate("rec-1", { action: null })).rejects.toThrow(/unknown action null/);
    await expect(manager.delegate("rec-1", { action: 123 })).rejects.toThrow(/unknown action 123/);
    await expect(manager.delegate("rec-1", { action: { nested: true } })).rejects.toThrow(/unknown action/);
  });
});

describe("manager mailbox wiring", () => {
  const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });
  const alpha: AgentDef = { name: "alpha", description: "a", systemPrompt: "A.", source: "user", filePath: "/a/alpha.md" };

  it("serves a request while a delegating child is live and stops after it finishes", async () => {
    const root = tempDir("mbox-wire-");
    const mailboxDir = join(root, "mailbox");
    let n = 0;
    const runner = new FakeRunner((spec) => {
      const file = spec.resumeFile ?? join(root, `child-${n++}.jsonl`);
      writeFileSync(file, "", { flag: "a" });
      return new FakeSession(file, [ok("done")], true);
    });
    const manager = new SubagentManager({
      registry: new Registry(() => {}),
      chainStore: new ChainStore(() => {}),
      scheduler: new Scheduler(() => 4),
      runners: { sdk: runner, rpc: undefined },
      agents: () => new Map([[alpha.name, alpha]]),
      settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0 }),
      port: { sendMessage: () => {}, appendEntry: () => {} },
      receiverContextWindow: () => 200000,
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      outputDir: join(root, "out"),
      mailboxDir,
    });
    // A held background child: it is live and may delegate while the test pokes the mailbox itself.
    const { record } = await manager.run({ agent: "alpha", task: "plan", background: true });
    expect(record.status).toBe("running");

    writeFileSync(join(mailboxDir, "requests", "probe.json"), JSON.stringify({ id: "probe", parentRecordId: record.id, payload: { action: "list" } }));
    await vi.waitFor(() => expect(existsSync(join(mailboxDir, "responses", "probe.json"))).toBe(true), { timeout: 2000, interval: 10 });
    const answer = JSON.parse(readFileSync(join(mailboxDir, "responses", "probe.json"), "utf8")) as { ok: boolean };
    expect(answer.ok).toBe(true);

    runner.sessions[0]!.finish();
    await manager.whenIdle();
    // After the only delegating child is gone the poller must stop: a new request is left untouched.
    writeFileSync(join(mailboxDir, "requests", "late.json"), JSON.stringify({ id: "late", parentRecordId: record.id, payload: { action: "list" } }));
    await sleep(400);
    expect(existsSync(join(mailboxDir, "requests", "late.json"))).toBe(true);
    await manager.shutdown();
  });
});

describe("orphan response cleanup (REVIEW-034)", () => {
  it("discards a response whose client already timed out and reports it once without a mailbox path", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    const errors: MailboxErrorInfo[] = [];
    let releaseHandler: () => void = () => {};
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    // A handler slower than the client's timeout: the client gives up, but the response is written afterwards.
    const server = new MailboxServer(
      dir,
      async (req) => {
        await handlerGate;
        return { id: req.id, parentRecordId: req.parentRecordId, ok: true, text: "late" };
      },
      { responseTtlMs: 25, onError: (info) => errors.push(info) },
    );
    const call = callViaMailbox(dir, request("orphan"), { timeoutMs: 40, pollMs: 5 });
    const tick = server.tick();
    await expect(call).rejects.toThrow(/timed out/);
    // The client removed its request, yet the slow handler still delivers an answer nobody can claim.
    releaseHandler();
    await tick;
    const responseFile = join(paths.responses, "orphan.json");
    expect(existsSync(responseFile)).toBe(true);
    expect(errors).toHaveLength(0);

    // Past the TTL one more scan discards it and reports the orphan exactly once.
    await sleep(40);
    await server.tick();
    expect(existsSync(responseFile)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ id: "orphan", parentRecordId: "rec-1" });
    expect(errors[0]!.message).not.toContain(dir);
    await server.tick();
    expect(errors).toHaveLength(1);
  });
});

describe("mailbox scan resilience (REVIEW-035)", () => {
  it("keeps scanning past a junk directory and still serves the valid request behind it", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    // A non-empty directory named to sort before r1.json: removing it aborts the whole pass without per-entry isolation.
    mkdirSync(join(paths.requests, "0junk"));
    writeFileSync(join(paths.requests, "0junk", "child"), "not a request");
    writeFileSync(join(paths.requests, "r1.json"), JSON.stringify(request("r1")));
    const seen: MailboxRequest[] = [];
    const server = new MailboxServer(dir, async (req) => {
      seen.push(req);
      return { id: req.id, ok: true, text: "done" };
    });
    await expect(server.tick()).resolves.toBe(2);
    expect(seen.map((entry) => entry.id)).toEqual(["r1"]);
    expect(readdirSync(paths.requests)).toHaveLength(0);
    expect(existsSync(join(paths.requests, "0junk"))).toBe(false);
    expect(existsSync(join(paths.responses, "r1.json"))).toBe(true);
  });
});

describe("mailbox setup failure (REVIEW-036)", () => {
  it("releases the slot, closes the child and leaves no queued record when the mailbox cannot be created", async () => {
    const root = tempDir("mbox-");
    const blocked = join(root, "mailbox-file");
    writeFileSync(blocked, "not a directory");
    const solo: AgentDef = { name: "solo", description: "s", systemPrompt: "S.", source: "user", filePath: "/a/solo.md" };
    let n = 0;
    const runner = new FakeRunner((spec) => {
      const file = spec.resumeFile ?? join(root, `child-${n++}.jsonl`);
      writeFileSync(file, "", { flag: "a" });
      return new FakeSession(file, [{ text: "done", stopReason: "stop", usage: usage() }], false);
    });
    const manager = new SubagentManager({
      registry: new Registry(() => {}),
      chainStore: new ChainStore(() => {}),
      scheduler: new Scheduler(() => 1),
      runners: { sdk: runner, rpc: undefined },
      agents: () => new Map([[solo.name, solo]]),
      settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, maxConcurrent: 1 }),
      port: { sendMessage: () => {}, appendEntry: () => {} },
      receiverContextWindow: () => 200000,
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      outputDir: join(root, "out"),
      mailboxDir: blocked,
    });
    await expect(manager.run({ agent: "solo", task: "blocked" })).rejects.toThrow();
    // Nothing may stay queued or running once the mailbox setup failed.
    expect(manager.list().filter((r) => r.status === "queued" || r.status === "running")).toHaveLength(0);
    // The session that had already opened must be disposed, not leaked.
    expect(runner.sessions).toHaveLength(1);
    expect(runner.sessions[0]!.disposed).toBe(true);
    // Make the mailbox creatable again: the slot must already be free, so this run must complete.
    rmSync(blocked, { force: true });
    // maxConcurrent is 1: if the failed run had kept its slot, this second run would never return.
    const second = await Promise.race([
      manager.run({ agent: "solo", task: "second" }),
      sleep(1_000).then(() => {
        throw new Error("the scheduler slot was not released after the mailbox failure");
      }),
    ]);
    expect(second.record.status).toBe("completed");
    await manager.whenIdle();
  });
});

describe("delegation payload shape validation (REVIEW-037)", () => {
  it("refuses a malformed payload with one controlled sentence and no implementation detail", async () => {
    const manager = new SubagentManager({} as never);
    const malformed: Record<string, unknown>[] = [
      { action: "resume", handle: {} },
      { action: "run", agent: 5 },
      { action: "steer", handle: "x", message: 7 },
      { action: "parallel", tasks: "not-an-array" },
      { action: "chain", chain: [{ agent: "worker", task: 9 }] },
    ];
    for (const payload of malformed) {
      const message = await manager.delegate("rec-1", payload).then(
        () => "(no error)",
        (error: Error) => error.message,
      );
      expect(message).toMatch(/invalid delegation request/);
      expect(message).not.toMatch(/replace|is not a function|TypeError|Cannot read/);
    }
  });

  it("keeps the unknown action refusal for an action outside the tool schema", async () => {
    const manager = new SubagentManager({} as never);
    await expect(manager.delegate("rec-1", { action: "bogus" })).rejects.toThrow(/unknown action "bogus"/);
  });
});

describe("mailbox error reporting (REVIEW-038)", () => {
  it("reports each distinct failure once and never includes the mailbox path", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    const errors: MailboxErrorInfo[] = [];
    const server = new MailboxServer(dir, async (req) => ({ id: req.id, ok: true, text: "x" }), { onError: (info) => errors.push(info) });
    // Break the request directory: every scan fails the same way and must report it only once.
    rmSync(paths.requests, { recursive: true, force: true });
    await server.tick();
    await server.tick();
    await server.tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/could not read the mailbox request directory/);

    // A different failure kind is reported on its own terms, and still only once.
    rmSync(paths.responses, { recursive: true, force: true });
    await server.tick();
    await server.tick();
    expect(errors).toHaveLength(2);
    expect(errors.map((info) => info.message).join(" | ")).toMatch(/could not read the mailbox response directory/);
    for (const info of errors) {
      expect(info.message).not.toContain(dir);
      expect(JSON.stringify(info)).not.toContain(dir);
    }
  });
});

describe("delegation action set (REVIEW-040)", () => {
  it("builds the tool schema union and the delegation gate from the same action list", async () => {
    const actionSchema = SubagentsParams.properties.action as unknown as { anyOf?: { const?: string }[] };
    expect(actionSchema.anyOf?.map((entry) => entry.const)).toEqual([...SUBAGENT_ACTIONS]);
    expect(new Set(SUBAGENT_ACTIONS).size).toBe(SUBAGENT_ACTIONS.length);
    expect(SUBAGENT_ACTIONS.every((action) => typeof action === "string" && action.length > 0)).toBe(true);

    // A registry that never resolves a parent isolates the action gate: a known action gets past it (and then fails
    // on the missing parent), while anything outside the single-source list is refused as an unknown action.
    const manager = new SubagentManager({ registry: { get: () => undefined, list: () => [] } } as never);
    for (const action of SUBAGENT_ACTIONS) {
      const message = await manager.delegate("rec-1", { action }).then(
        () => "(accepted)",
        (error: Error) => error.message,
      );
      expect(message).not.toMatch(/unknown action/);
    }
    for (const action of ["future-action", "RUN", "", "run "]) {
      await expect(manager.delegate("rec-1", { action })).rejects.toThrow(/unknown action/);
    }
  });

  it("turns an action the dispatcher has no branch for into a clear error", async () => {
    const manager = new SubagentManager({} as never);
    await expect(executeAction(manager, { action: "future-action" } as never)).rejects.toThrow(/unsupported subagents action/);
  });
});

describe("polling stops deterministically (REVIEW-039)", () => {
  it("ignores requests written after stop across many poll intervals", async () => {
    const dir = tempDir("mbox-");
    const paths = ensureMailbox(dir);
    const pollMs = 5;
    let handled = 0;
    const server = new MailboxServer(dir, async (req) => {
      handled++;
      return { id: req.id, ok: true, text: "x" };
    }, { pollMs });
    server.start();
    // Control: while running, the directory is definitely being scanned.
    writeFileSync(join(paths.requests, "live.json"), JSON.stringify(request("live")));
    await vi.waitFor(() => expect(handled).toBe(1), { timeout: 2_000, interval: 2 });
    server.stop();
    expect(server.running).toBe(false);
    const stopAt = handled;
    writeFileSync(join(paths.requests, "after-stop.json"), JSON.stringify(request("after-stop")));
    // Far more than three poll intervals: a still-running poller would have consumed it many times over.
    await sleep(pollMs * 20);
    expect(handled).toBe(stopAt);
    expect(existsSync(join(paths.requests, "after-stop.json"))).toBe(true);
    expect(existsSync(join(paths.responses, "after-stop.json"))).toBe(false);
  });

  it("leaves late requests untouched across several poll intervals once no child can ask", async () => {
    const root = tempDir("mbox-");
    const mailboxDir = join(root, "mailbox");
    const solo: AgentDef = { name: "solo", description: "s", systemPrompt: "S.", source: "user", filePath: "/a/solo.md" };
    let n = 0;
    const runner = new FakeRunner((spec) => {
      const file = spec.resumeFile ?? join(root, `child-${n++}.jsonl`);
      writeFileSync(file, "", { flag: "a" });
      return new FakeSession(file, [{ text: "done", stopReason: "stop", usage: usage() }], true);
    });
    const manager = new SubagentManager({
      registry: new Registry(() => {}),
      chainStore: new ChainStore(() => {}),
      scheduler: new Scheduler(() => 4),
      runners: { sdk: runner, rpc: undefined },
      agents: () => new Map([[solo.name, solo]]),
      settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0 }),
      port: { sendMessage: () => {}, appendEntry: () => {} },
      receiverContextWindow: () => 200000,
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      outputDir: join(root, "out"),
      mailboxDir,
    });
    const { record } = await manager.run({ agent: "solo", task: "plan", background: true });
    // Control: while the child is live the poller answers a probe.
    writeFileSync(join(mailboxDir, "requests", "probe.json"), JSON.stringify({ id: "probe", parentRecordId: record.id, payload: { action: "list" } }));
    await vi.waitFor(() => expect(existsSync(join(mailboxDir, "responses", "probe.json"))).toBe(true), { timeout: 2_000, interval: 10 });
    runner.sessions[0]!.finish();
    await manager.whenIdle();
    // One late request per ~1.25 default poll intervals (200ms), none of which may ever be answered.
    const late = ["late-1", "late-2", "late-3"];
    for (const id of late) {
      writeFileSync(join(mailboxDir, "requests", `${id}.json`), JSON.stringify({ id, parentRecordId: record.id, payload: { action: "list" } }));
      await sleep(250);
    }
    for (const id of late) {
      expect(existsSync(join(mailboxDir, "requests", `${id}.json`))).toBe(true);
      expect(existsSync(join(mailboxDir, "responses", `${id}.json`))).toBe(false);
    }
    await manager.shutdown();
  });
});