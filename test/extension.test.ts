import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_ENTRY_TYPE } from "../src/delivery.ts";
import { createExtension } from "../src/index.ts";
import type { ChildResult, ChildSpec, Runner } from "../src/runner/types.ts";
import { FakePi, fakeCtx } from "./fake-pi.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { writeSkill, writeTemplate } from "./fixtures/skill-fixtures.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const REVIEWER = "---\nname: reviewer\ndescription: Reviews code\n---\nReview.";

/** Boots the extension against a FakePi with a FakeRunner; one held or scripted child per open. */
export async function boot(
  opts: {
    hold?: boolean;
    scripts?: ChildResult[][];
    extraAgents?: Record<string, string>;
    extraSkills?: Record<string, string>;
    extraTemplates?: Record<string, string>;
    hasUI?: boolean;
    branch?: unknown[];
    settings?: Record<string, unknown>;
    rpcRunner?: Runner;
    /** Main-session model and what `modelRegistry.find` returns; used by the model resolver assertion. */
    model?: { provider: string; id: string };
    find?: (provider: string, id: string) => unknown;
  } = {},
) {
  const root = tempDir("ext-");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "reviewer.md"), REVIEWER);
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ maxResident: 0, ...opts.settings }));
  for (const [name, content] of Object.entries(opts.extraAgents ?? {})) writeFileSync(join(agentDir, "agents", name), content);
  for (const [name, body] of Object.entries(opts.extraSkills ?? {})) writeSkill(agentDir, name, body);
  for (const [name, content] of Object.entries(opts.extraTemplates ?? {})) writeTemplate(agentDir, name, content);
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, opts.scripts?.[n] ?? [], opts.hold ?? false);
  });
  const pi = new FakePi();
  const rpcResolvers: ((spec: string | undefined) => unknown)[] = [];
  createExtension({
    agentDir,
    createRunner: () => runner,
    ...(opts.rpcRunner
      ? {
          createRpcRunner: (resolveModel: (spec: string | undefined) => unknown) => {
            rpcResolvers.push(resolveModel);
            return opts.rpcRunner!;
          },
        }
      : {}),
  })(pi.asApi());
  pi.branch.push(...(opts.branch ?? []));
  const { ctx, notes, providers } = fakeCtx(pi, {
    cwd,
    sessionDir,
    hasUI: opts.hasUI ?? true,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.find ? { find: opts.find } : {}),
  });
  await pi.emit("session_start", { type: "session_start" }, ctx);
  const tool = pi.tools.get("subagents");
  const callTool = (params: Record<string, unknown>) => tool.execute("call-1", params, undefined, undefined, ctx);
  return { pi, ctx, notes, providers, sent: pi.sent, runner, callTool, root, cwd, agentDir, rpcRunner: opts.rpcRunner, rpcResolvers };
}

const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });

afterEach(() => vi.restoreAllMocks());

describe("extension wiring", () => {
  it("registers the tool, session handlers and the private renderer", async () => {
    const { pi } = await boot();
    expect(pi.tools.has("subagents")).toBe(true);
    for (const event of ["session_start", "session_tree", "session_shutdown"]) expect(pi.handlers.get(event)?.length).toBe(1);
    expect(pi.entryRenderers.has(PRIVATE_ENTRY_TYPE)).toBe(true);
  });

  it("does not register the tool or the /sub commands when maxDepth is 0", async () => {
    const { pi, notes } = await boot({ settings: { maxDepth: 0 } });
    expect(pi.tools.has("subagents")).toBe(false);
    expect(pi.commands.has("subagents")).toBe(false);
    expect(pi.commands.has("sub")).toBe(false);
    expect(notes.some((n) => n.type === "warning" && n.message.includes("subagents are disabled (maxDepth is 0)"))).toBe(true);
  });

  it("rebuilds the registry from the branch on session_start", async () => {
    const { pi, ctx, callTool } = await boot({ scripts: [[ok("LGTM")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    await pi.emit("session_start", { type: "session_start" }, ctx);
    const out = await callTool({ action: "list" });
    expect(out.content[0].text).toContain("@reviewer");
  });

  it("reports agent file warnings once per session through notify", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { notes, callTool } = await boot({ scripts: [[ok("a")], [ok("b")]], extraAgents: { "broken.md": "---\nname: broken\n---\nx" } });
    await callTool({ action: "run", agent: "reviewer", task: "x" });
    await callTool({ action: "run", agent: "reviewer", task: "y" });
    const warnings = notes.filter((n) => n.message.includes("broken.md"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.type).toBe("warning");
    expect(error).not.toHaveBeenCalled();
  });

  it("notifies when a background result cannot be delivered", async () => {
    const { pi, notes, callTool } = await boot({ scripts: [[ok("done!")]] });
    pi.failSend = new Error("port down");
    await callTool({ action: "run", agent: "reviewer", task: "x", background: true });
    await vi.waitFor(() => expect(notes.some((n) => n.message.includes("port down"))).toBe(true));
    const note = notes.find((n) => n.message.includes("port down"))!;
    expect(note.message).toContain("@reviewer");
    expect(note.type).toBe("warning");
  });

  it("the reload notice does not call cancelled queued runs paused", async () => {
    const queued = {
      type: "custom",
      customType: "pi-subagents/registry",
      data: {
        id: "q1", handle: "reviewer", agent: "reviewer", runner: "sdk", depth: 1, sessionFile: "", runId: 1,
        status: "queued", delivery: "auto", task: "t", createdAt: 1, updatedAt: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      },
    };
    const { notes, callTool } = await boot({ branch: [queued] });
    const note = notes.find((n) => n.message.includes("reload/restart"))!;
    expect(note.message).toContain("queued ones were cancelled");
    expect(note.message).not.toMatch(/are now paused$/);
    expect((await callTool({ action: "list" })).content[0].text).toContain("[stopped]");
  });

  it("the /tree notice says running records are paused and queued ones cancelled", async () => {
    // Arrange: a booted session, then a branch switch that brings in a stale running and a stale queued record.
    const { pi, ctx, notes, callTool } = await boot();
    const entry = (id: string, handle: string, status: string) => ({
      type: "custom",
      customType: "pi-subagents/registry",
      data: {
        id, handle, agent: "reviewer", runner: "sdk", depth: 1, sessionFile: "", runId: 1,
        status, delivery: "auto", task: "t", createdAt: 1, updatedAt: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      },
    });
    pi.branch.push(entry("r1", "runner", "running"), entry("q1", "waiter", "queued"));

    // Act
    await pi.emit("session_tree", { type: "session_tree" }, ctx);

    // Assert
    const note = notes.find((n) => n.message.includes("from another branch"))!;
    expect(note.message).toBe(
      "pi-subagents: 2 subagent(s) from another branch were not running: running ones are paused, queued ones were cancelled",
    );
    expect(note.type).toBe("warning");
    const list = (await callTool({ action: "list" })).content[0].text;
    expect(list).toMatch(/@runner .*\[paused\]/);
    expect(list).toMatch(/@waiter .*\[stopped\]/);
  });

  it("gives the injected rpc runner the model resolver and the run spec", async () => {
    const rpcOpened: ChildSpec[] = [];
    const fakeModel = { provider: "p", id: "m", contextWindow: 1000 };
    const inner = new FakeRunner((_spec, n) => new FakeSession(join(tempDir("rpc-"), `child-${n}.jsonl`), [{ text: "rpc answer", stopReason: "stop", usage: usage() }], false));
    const rpcRunner: Runner = {
      kind: "rpc",
      open: (spec) => {
        rpcOpened.push(spec);
        return inner.open(spec);
      },
    };
    const { callTool, rpcResolvers, cwd } = await boot({
      rpcRunner,
      model: { provider: "p", id: "main" },
      find: () => fakeModel,
      extraAgents: { "rpcer.md": "---\nname: rpcer\ndescription: Runs over rpc\nrunner: rpc\nmodel: m\n---\nYou are rpcer." },
    });
    await callTool({ action: "run", agent: "rpcer", task: "x" });
    expect(rpcResolvers).toHaveLength(1);
    // The resolver the extension handed to the runner resolves the agent's model spec.
    expect(rpcResolvers[0]!("m")).toBe(fakeModel);
    expect(rpcOpened).toHaveLength(1);
    expect(rpcOpened[0]!.agent.name).toBe("rpcer");
    expect(rpcOpened[0]!.cwd).toBe(cwd);
    expect(rpcOpened[0]!.appendSystemPrompt[0]).toContain("You are rpcer.");
  });

  it("uses the injected rpc runner for agents with runner: rpc", async () => {
    const rpcOpened: ChildSpec[] = [];
    const inner = new FakeRunner((_spec, n) => {
      const file = join(tempDir("rpc-"), `child-${n}.jsonl`);
      writeFileSync(file, "", { flag: "a" });
      return new FakeSession(file, [{ text: "rpc answer", stopReason: "stop", usage: usage() }], false);
    });
    const rpcRunner: Runner = {
      kind: "rpc",
      open: (spec) => {
        rpcOpened.push(spec);
        return inner.open(spec);
      },
    };
    const { runner, callTool } = await boot({
      rpcRunner,
      extraAgents: { "rpcer.md": "---\nname: rpcer\ndescription: Runs over rpc\nrunner: rpc\n---\nRpc." },
    });
    const out = await callTool({ action: "run", agent: "rpcer", task: "x" });
    expect(out.content[0].text).toContain("rpc answer");
    expect(rpcOpened).toHaveLength(1);
    expect(runner.opened).toHaveLength(0);
  });
});

// REVIEW-013: the main session reaches the manager through `pi.tools.get("subagents").execute`, which must pass the
// raw model arguments through `src/index.ts`'s `toolCallInput()` before dispatching. These cases keep a forged
// `parentId` from re-attributing a run: they assert on the record the entry actually persisted, not on a helper.
describe("the tool entry strips a forged delegation parent (REVIEW-013)", () => {
  /** The last persisted registry entry for a handle, exactly as the manager left it on the session branch. */
  const recordFor = (pi: FakePi, handle: string) =>
    pi.branch
      .filter((e: any) => e.customType === "pi-subagents/registry")
      .map((e: any) => e.data as { id: string; handle: string; parentId?: string; depth: number })
      .filter((r) => r.handle === handle)
      .at(-1);

  it("keeps a forged top-level parentId from re-attributing a run through pi.tools", async () => {
    const { pi, callTool } = await boot({ scripts: [[ok("root")], [ok("forged")]] });
    await callTool({ action: "run", agent: "reviewer", task: "root" });
    const parent = recordFor(pi, "reviewer")!;

    // Act: the forged id names a real record, so it would make this run a depth-2 child if it survived.
    const out = await callTool({ action: "run", agent: "reviewer", task: "forged", parentId: parent.id });

    // Assert: the main session dispatched it as a depth-1 root under the main session, not under the forged parent.
    const record = recordFor(pi, out.details.handle as string)!;
    expect(record.parentId).toBeUndefined();
    expect(record.depth).toBe(1);
  });

  it("strips a forged parentId inside tasks[] items through pi.tools", async () => {
    const { pi, callTool } = await boot({ scripts: [[ok("root")], [ok("forged")]] });
    await callTool({ action: "run", agent: "reviewer", task: "root" });
    const parent = recordFor(pi, "reviewer")!;

    const out = await callTool({ action: "parallel", tasks: [{ agent: "reviewer", task: "forged", parentId: parent.id }] });

    const record = recordFor(pi, out.details.handles[0] as string)!;
    expect(record.parentId).toBeUndefined();
    expect(record.depth).toBe(1);
  });

  it("strips a forged parentId inside chain[] steps through pi.tools", async () => {
    const { pi, callTool } = await boot({ scripts: [[ok("root")], [ok("forged")]] });
    await callTool({ action: "run", agent: "reviewer", task: "root" });
    const parent = recordFor(pi, "reviewer")!;

    const out = await callTool({ action: "chain", chain: [{ agent: "reviewer", task: "forged", parentId: parent.id }] });

    const record = recordFor(pi, out.details.handles[0] as string)!;
    expect(record.parentId).toBeUndefined();
    expect(record.depth).toBe(1);
  });
});

describe("batch wiring", () => {
  it("runs a chain through the tool and persists the chain entry", async () => {
    const { pi, callTool } = await boot({ scripts: [[ok("alpha")], [ok("beta")]] });
    const out = await callTool({ action: "chain", chain: [{ agent: "reviewer", task: "first" }, { agent: "reviewer", task: "second got {previous}" }] });
    expect(out.content[0].text).toContain("Chain completed (2/2 steps)");
    expect(pi.branch.some((e: any) => e.customType === "pi-subagents/chain")).toBe(true);
  });

  it("runs parallel tasks through the tool and reports their handles", async () => {
    const { callTool } = await boot({ scripts: [[ok("a")], [ok("b")]] });
    const out = await callTool({ action: "parallel", tasks: [{ agent: "reviewer", task: "one" }, { agent: "reviewer", task: "two" }] });
    expect(out.content[0].text).toContain("Parallel: 2/2 succeeded");
    expect(JSON.stringify(out.details)).toContain("reviewer-2");
  });

  it("shows a chain in the tool's list output", async () => {
    const { callTool } = await boot({ scripts: [[ok("alpha")], [ok("beta")]] });
    await callTool({ action: "chain", chain: [{ agent: "reviewer", task: "first" }, { agent: "reviewer", task: "second got {previous}" }] });
    const list = await callTool({ action: "list" });
    expect(list.content[0].text).toContain("chain 1");
    expect(list.content[0].text).toContain("2 steps");
    expect(list.content[0].text).toContain("step 2/2");
  });
});

// Chain/registry entries exactly as they are persisted on a session branch; used to simulate /tree and reload.
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const step = (agent: string, task: string) => ({ agent, task });
const chainEntry = (over: Record<string, unknown> = {}) => ({
  type: "custom",
  customType: "pi-subagents/chain",
  data: {
    id: "chain-1",
    steps: [step("reviewer", "first"), step("reviewer", "second"), step("reviewer", "third")],
    stepRecordIds: ["rec-0", "rec-1"],
    currentStep: 1,
    status: "running",
    usage: ZERO,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  },
});
const recordEntry = (over: Record<string, unknown> = {}) => ({
  type: "custom",
  customType: "pi-subagents/registry",
  data: {
    id: "rec-0",
    handle: "reviewer",
    agent: "reviewer",
    runner: "sdk",
    depth: 1,
    sessionFile: "",
    runId: 1,
    status: "completed",
    delivery: "auto",
    task: "first",
    chainId: "chain-1",
    stepIndex: 0,
    createdAt: 1,
    updatedAt: 1,
    usage: ZERO,
    ...over,
  },
});
/** The latest persisted chain entry on the branch, as the extension's ChainStore would have written it. */
const latestChain = (pi: FakePi, id = "chain-1") =>
  pi.branch.filter((e: any) => e.customType === "pi-subagents/chain" && e.data.id === id).at(-1) as any;

describe("chain state after a branch reload (REVIEW-001/REVIEW-002)", () => {
  it("reconciles a running chain after session_tree and continues from the stopped step without replaying finished steps", async () => {
    // Arrange: /tree switches to a branch taken mid-chain, while no child is live in this manager. recoverInterrupted
    // settles the branch's "running" step; the chain entry left "running" must not make continue reject it as busy forever.
    const { pi, ctx, runner, callTool, root } = await boot();
    const firstFile = join(root, "step-0.jsonl");
    const stoppedFile = join(root, "step-1.jsonl");
    writeFileSync(firstFile, "");
    writeFileSync(stoppedFile, "");
    pi.branch.push(
      recordEntry({ sessionFile: firstFile }),
      recordEntry({ id: "rec-1", handle: "reviewer-2", task: "second", status: "running", stepIndex: 1, sessionFile: stoppedFile }),
      chainEntry(),
    );

    // Act
    await pi.emit("session_tree", { type: "session_tree" }, ctx);

    // Assert: the chain entry is no longer "running" and agrees with the settled step record.
    expect(latestChain(pi).data.status).toBe("paused");
    expect((await callTool({ action: "list" })).content[0].text).toMatch(/@reviewer-2 .*\[paused\]/);

    // Act: continue from the step that stopped.
    const out = await callTool({ action: "continue", handle: "reviewer-2" });

    // Assert: the stopped step was reused (same session file), the remaining step ran, and step 0 was never replayed.
    expect(out.content[0].text).toContain("Chain completed (3/3 steps)");
    expect(runner.opened.map((s) => s.resumeFile)).toEqual([stoppedFile, undefined]);
    expect(runner.sessions.map((s) => s.prompts)).toEqual([["second"], ["third"]]);
    expect(latestChain(pi).data.status).toBe("completed");
  });

  it("keeps a chain stopped after session_tree when its stopping step was stopped", async () => {
    // Arrange
    const { pi, ctx, callTool, root } = await boot();
    const stoppedFile = join(root, "stopped.jsonl");
    writeFileSync(stoppedFile, "");
    pi.branch.push(
      recordEntry(),
      recordEntry({ id: "rec-1", handle: "reviewer-2", task: "second", status: "stopped", stepIndex: 1, sessionFile: stoppedFile }),
      chainEntry({ steps: [step("reviewer", "first"), step("reviewer", "second")] }),
    );

    // Act
    await pi.emit("session_tree", { type: "session_tree" }, ctx);

    // Assert: the chain never becomes continuable just because its entry said "running" before the reload.
    expect(latestChain(pi).data.status).toBe("stopped");
    await expect(callTool({ action: "continue", handle: "reviewer-2" })).rejects.toMatchObject({ code: "stopped" });
  });

  it("normalizes a fully completed chain to completed after session_tree", async () => {
    // Arrange: every step finished, but the chain entry still says "running" (the process died before marking it completed).
    const { pi, ctx, callTool } = await boot();
    pi.branch.push(
      recordEntry(),
      recordEntry({ id: "rec-1", handle: "reviewer-2", task: "second", status: "completed", stepIndex: 1 }),
      chainEntry({ steps: [step("reviewer", "first"), step("reviewer", "second")] }),
    );

    // Act
    await pi.emit("session_tree", { type: "session_tree" }, ctx);

    // Assert
    expect(latestChain(pi).data.status).toBe("completed");
    await expect(callTool({ action: "continue", handle: "reviewer-2" })).rejects.toMatchObject({ code: "not_running" });
  });

  it("reconciles a running chain restored on session_start (reload/restart)", async () => {
    // Arrange: the reloaded branch carries a chain whose step was still running when the process died.
    const stoppedFile = join(tempDir("chain-reload-"), "step-1.jsonl");
    writeFileSync(stoppedFile, "");
    const { pi, callTool } = await boot({
      branch: [
        recordEntry(),
        recordEntry({ id: "rec-1", handle: "reviewer-2", task: "second", status: "running", stepIndex: 1, sessionFile: stoppedFile }),
        chainEntry({ steps: [step("reviewer", "first"), step("reviewer", "second")] }),
      ],
    });

    // Assert: session_start settled the step and reconciled the chain, so continue can finish it.
    expect(latestChain(pi).data.status).toBe("paused");
    expect((await callTool({ action: "continue", handle: "reviewer-2" })).content[0].text).toContain("Chain completed (2/2 steps)");
  });
});

describe("pending child result reminders (REVIEW-053)", () => {
  it("reminds once with the three ways to handle waiting child results", async () => {
    vi.useFakeTimers();
    try {
      // Boot with a branch whose paused parent already has one child result waiting; the wait is one minute old when
      // the first tick fires. `at` is a real timestamp, never 0, which is the reminder-dedupe sentinel.
      vi.setSystemTime(1_000_000);
      const entry = recordEntry({
        status: "paused",
        pending: [{ fromId: "c1", handle: "scout", summary: "done", sessionFile: "/s", at: 1_000_000 }],
      });
      const { notes } = await boot({ branch: [entry], settings: { pendingResultTimeoutMinutes: 0.5 } });

      // The rebuilt session restarts the reminder watch; the first tick is one minute later.
      await vi.advanceTimersByTimeAsync(60_000);
      const reminder = notes.find((n) => n.message.includes("action=drain"));
      expect(reminder).toBeDefined();
      expect(reminder!.type).toBe("warning");
      expect(reminder!.message).toBe(
        'pi-subagents: @reviewer is paused with 1 child result(s) waiting (1m). Resume it with "@reviewer …", hand them over with subagents action=drain handle=reviewer, or discard them with action=drop handle=reviewer.',
      );

      // Once per batch: a later tick does not repeat it.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(notes.filter((n) => n.message.includes("action=drain"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

const input = (pi: FakePi, ctx: ExtensionContext, text: string, extra: Record<string, unknown> = {}) =>
  pi.emit("input", { type: "input", text, source: "interactive", ...extra }, ctx).then((r) => r[0]);

describe("@ mentions", () => {
  it("@handle resumes a finished subagent in the background and quotes the question", async () => {
    const { pi, ctx, notes, callTool } = await boot({ scripts: [[ok("first")], [ok("yes, it is")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    expect(await input(pi, ctx, "@reviewer is the null check right?")).toEqual({ action: "handled" });
    expect(notes.some((n) => n.message.includes("sent to @reviewer (auto)"))).toBe(true);
    await vi.waitFor(() => expect(pi.sent).toHaveLength(1));
    expect(pi.sent[0]!.message.content).toContain("[user asked @reviewer]\nis the null check right?");
    expect(pi.sent[0]!.message.content).toContain("yes, it is");
    expect(pi.sent[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("~ shares without a turn and ? keeps the result private", async () => {
    const { pi, ctx, callTool } = await boot({ scripts: [[ok("first")], [ok("shared")], [ok("private one")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    await input(pi, ctx, "@reviewer~ think");
    await vi.waitFor(() => expect(pi.sent).toHaveLength(1));
    expect(pi.sent[0]!.options).toEqual({ triggerTurn: false });
    await input(pi, ctx, "@reviewer? what is RAII");
    await vi.waitFor(() => expect(pi.branch.some((e: any) => e.customType === "pi-subagents/private")).toBe(true));
    const entry = pi.branch.find((e: any) => e.customType === "pi-subagents/private") as any;
    expect(entry.data.text).toContain("what is RAII");
    expect(pi.sent).toHaveLength(1);
  });

  it("@handle steers a running subagent", async () => {
    const { pi, ctx, notes, runner, callTool } = await boot({ hold: true, scripts: [[ok("done")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review", background: true });
    expect(await input(pi, ctx, "@reviewer also check tests")).toEqual({ action: "handled" });
    expect(runner.sessions[0]!.steers).toEqual([{ text: "also check tests", mode: "steer" }]);
    expect(notes.some((n) => n.message.includes("added to @reviewer"))).toBe(true);
    runner.sessions[0]!.finish();
    await vi.waitFor(() => expect(pi.sent).toHaveLength(1));
    expect(pi.sent[0]!.message.content).toContain("[user added while it was running @reviewer]\nalso check tests");
  });

  it("@handle? on a running subagent keeps the question out of the main session", async () => {
    const { pi, ctx, notes, runner, callTool } = await boot({ hold: true, scripts: [[ok("done")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review", background: true });
    await input(pi, ctx, "@reviewer? what does this flag mean");
    expect(notes.some((n) => n.message.includes("privately"))).toBe(true);
    runner.sessions[0]!.finish();
    await vi.waitFor(() => expect(pi.sent).toHaveLength(1));
    expect(pi.sent[0]!.message.content).not.toContain("what does this flag mean");
  });

  it("@handle~ on a running subagent quotes the instruction but keeps the run's own delivery", async () => {
    // Arrange
    const { pi, ctx, notes, runner, callTool } = await boot({ hold: true, scripts: [[ok("done")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review", background: true });
    // Act
    await input(pi, ctx, "@reviewer~ also check tests");
    runner.sessions[0]!.finish();
    await vi.waitFor(() => expect(pi.sent).toHaveLength(1));
    // Assert
    expect(notes.some((n) => n.message.includes("the run keeps its own delivery"))).toBe(true);
    expect(pi.sent[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(pi.sent[0]!.message.content).toContain("also check tests");
  });

  it("passes unknown bare handles through and reports unknown @sub: handles", async () => {
    const { pi, ctx, notes, callTool } = await boot({ scripts: [[ok("first")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    expect(await input(pi, ctx, "@nobody hi")).toEqual({ action: "continue" });
    expect(await input(pi, ctx, "@sub:nobody hi")).toEqual({ action: "handled" });
    expect(notes.at(-1)).toMatchObject({ message: expect.stringContaining("Known: @reviewer"), type: "error" });
  });

  it("file wins over a bare handle", async () => {
    const { pi, ctx, cwd, callTool } = await boot({ scripts: [[ok("first")], [ok("second")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    mkdirSync(join(cwd, "reviewer"));
    expect(await input(pi, ctx, "@reviewer hi")).toEqual({ action: "continue" });
    expect(await input(pi, ctx, "@sub:reviewer hi")).toEqual({ action: "handled" });
  });

  it("@main strips the prefix", async () => {
    const { pi, ctx } = await boot();
    expect(await input(pi, ctx, "@main hello there")).toEqual({ action: "transform", text: "hello there" });
  });

  it("ignores rpc and extension input and sessions without a UI", async () => {
    const { pi, ctx, runner, callTool, cwd, root } = await boot({ scripts: [[ok("first")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    expect(await input(pi, ctx, "@reviewer again", { source: "rpc" })).toEqual({ action: "continue" });
    expect(await input(pi, ctx, "@reviewer again", { source: "extension" })).toEqual({ action: "continue" });
    const { ctx: noUi } = fakeCtx(pi, { cwd, sessionDir: join(root, "sessions"), hasUI: false });
    expect(await input(pi, noUi, "@reviewer again")).toEqual({ action: "continue" });
    expect(runner.opened).toHaveLength(1);
  });

  it("reports a missing session or a stopped subagent without starting a run", async () => {
    const { pi, ctx, notes, runner, callTool } = await boot({ scripts: [[ok("first")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    rmSync(runner.sessions[0]!.sessionFile);
    expect(await input(pi, ctx, "@reviewer again")).toEqual({ action: "handled" });
    expect(notes.at(-1)).toMatchObject({ message: expect.stringContaining("missing"), type: "error" });
    await callTool({ action: "stop", handle: "reviewer" });
    await input(pi, ctx, "@reviewer again");
    expect(notes.at(-1)).toMatchObject({ message: expect.stringContaining("stopped"), type: "error" });
    expect(runner.opened).toHaveLength(1);
  });

  it("warns that images are not forwarded", async () => {
    const { pi, ctx, notes, callTool } = await boot({ scripts: [[ok("first")], [ok("second")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    await input(pi, ctx, "@reviewer look", { images: [{ type: "image", data: "x", mimeType: "image/png" }] });
    expect(notes.some((n) => n.message.includes("images") && n.type === "warning")).toBe(true);
  });

  it("asks for a message after the handle", async () => {
    const { pi, ctx, notes, callTool } = await boot({ scripts: [[ok("first")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    expect(await input(pi, ctx, "@reviewer")).toEqual({ action: "handled" });
    expect(notes.at(-1)).toMatchObject({ message: expect.stringContaining("write a message after @reviewer"), type: "error" });
  });

  it("warns once when a new handle clashes with a file in the cwd", async () => {
    const { ctx, notes, cwd, callTool } = await boot({ scripts: [[ok("first")]] });
    mkdirSync(join(cwd, "reviewer"));
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    const clash = notes.filter((n) => n.message.includes("@sub:reviewer"));
    expect(clash).toHaveLength(1);
    expect(ctx).toBeDefined();
  });

  it("installs the autocomplete provider once per UI", async () => {
    const { pi, ctx, providers } = await boot();
    await pi.emit("session_start", { type: "session_start" }, ctx);
    expect(providers).toHaveLength(1);
  });

  it("keeps a root completion description unchanged (CR-5-3)", async () => {
    const { providers, callTool } = await boot({ scripts: [[ok("first")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    const base: AutocompleteProvider = {
      getSuggestions: async () => null,
      applyCompletion: (lines, line, col) => ({ lines, cursorLine: line, cursorCol: col }),
    };
    const provider = (providers[0] as (current: AutocompleteProvider) => AutocompleteProvider)(base);
    const result = await provider.getSuggestions(["@rev"], 0, 4, { signal: new AbortController().signal });
    // A root record has no path to add: the description must not repeat its own handle as "reviewer · completed · reviewer".
    expect(result?.items).toEqual([{ value: "@reviewer", label: "@reviewer", description: "reviewer · completed" }]);
  });
});

describe("/subagents command", () => {
  it("list and cost append a display-only tree entry", async () => {
    const { pi, ctx, callTool } = await boot({ scripts: [[ok("first")]] });
    await callTool({ action: "run", agent: "reviewer", task: "review" });
    const command = pi.commands.get("subagents");
    await command.handler("", ctx);
    await command.handler("cost", ctx);
    const trees = pi.branch.filter((e: any) => e.customType === "pi-subagents/tree") as any[];
    expect(trees.map((t) => t.data.view)).toEqual(["list", "cost"]);
    expect(trees[0].data.text).toContain("@reviewer");
    expect(trees[1].data.text).toMatch(/total/);
    expect(pi.sent).toHaveLength(0);
    expect(pi.entryRenderers.has("pi-subagents/tree")).toBe(true);
  });

  it("rejects an unknown view and completes the known ones", async () => {
    const { pi, ctx, notes } = await boot();
    const command = pi.commands.get("subagents");
    await command.handler("bogus", ctx);
    expect(notes.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("list") });
    expect(pi.branch.some((e: any) => e.customType === "pi-subagents/tree")).toBe(false);
    expect(command.getArgumentCompletions("c").map((i: { value: string }) => i.value)).toEqual(["cost"]);
  });

  it("accepts a view name in any case", async () => {
    const { pi, ctx } = await boot();
    await pi.commands.get("subagents").handler("COST", ctx);
    const trees = pi.branch.filter((e: any) => e.customType === "pi-subagents/tree") as any[];
    expect(trees.map((t) => t.data.view)).toEqual(["cost"]);
  });

  it("says a stray slash argument was not run", async () => {
    const { pi, ctx, notes } = await boot();
    const command = pi.commands.get("subagents");
    await command.handler("/debug-agent", ctx);
    expect(notes.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("was not run") });
    expect(pi.branch.some((e: any) => e.customType === "pi-subagents/tree")).toBe(false);
  });

  it("shows a chain in the tree entry appended by the command", async () => {
    // Arrange
    const { pi, ctx, callTool } = await boot({ scripts: [[ok("alpha")], [ok("beta")]] });
    await callTool({ action: "chain", chain: [{ agent: "reviewer", task: "first" }, { agent: "reviewer", task: "second got {previous}" }] });

    // Act
    await pi.commands.get("subagents").handler("", ctx);

    // Assert
    const trees = pi.branch.filter((e: any) => e.customType === "pi-subagents/tree") as any[];
    expect(trees.at(-1)!.data.text).toContain("chain 1");
    expect(trees.at(-1)!.data.text).toContain("step 2/2");
  });
});

describe("/sub command", () => {
  it("creates a subagent for an agent entry and reports the handle", async () => {
    const { pi, ctx, notes, runner } = await boot({ scripts: [[ok("done")]] });
    await pi.commands.get("sub").handler("reviewer 请审查这一段", ctx);
    expect(notes.at(-1)!.message).toContain("已创建 @reviewer");
    expect(runner.opened).toHaveLength(1);
    expect(runner.sessions[0]!.prompts).toEqual(["请审查这一段"]);
  });

  it("runs a skill entry with the slash prompt and records the entry", async () => {
    const { pi, ctx, runner, callTool } = await boot({ scripts: [[ok("done")]], extraSkills: { "pdf-tools": "BODY" } });
    await pi.commands.get("sub").handler("/skill:pdf-tools extract a.pdf", ctx);
    expect(runner.sessions[0]!.prompts).toEqual(["/skill:pdf-tools extract a.pdf"]);
    const list = await callTool({ action: "list" });
    expect(list.content[0].text).toMatch(/@pdf-tools\s+skill:pdf-tools/);
  });

  it("maps the symbol variants to their delivery modes and quotes the ask", async () => {
    const { pi, ctx, sent } = await boot({ scripts: [[ok("a")], [ok("b")], [ok("c")]] });
    await pi.commands.get("sub!").handler("reviewer one", ctx);
    await pi.commands.get("sub~").handler("reviewer two", ctx);
    await pi.commands.get("sub?").handler("reviewer three", ctx);
    await vi.waitFor(() => expect(pi.branch.some((e: any) => e.customType === "pi-subagents/private")).toBe(true));
    expect(sent.map((call) => call.options)).toEqual([{ triggerTurn: true, deliverAs: "followUp" }, { triggerTurn: false }]);
    expect(sent[0]!.message.content).toContain("[user asked @reviewer]");
    expect((pi.branch.find((e: any) => e.customType === "pi-subagents/private") as any).data.text).toContain("three");
  });

  it("uses the settings defaultDelivery when no symbol is given", async () => {
    const { pi, ctx, sent } = await boot({ scripts: [[ok("done")]], settings: { defaultDelivery: "share" } });
    await pi.commands.get("sub").handler("reviewer 任务", ctx);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.options).toEqual({ triggerTurn: false });
  });

  it("passes --cwd to the child", async () => {
    const dir = tempDir("sub-cwd-");
    const { pi, ctx, runner } = await boot({ scripts: [[ok("done")]] });
    await pi.commands.get("sub").handler(`--cwd ${dir} reviewer x`, ctx);
    expect(runner.opened[0]!.cwd).toBe(dir);
  });

  it("rejects an unknown skill without creating a record", async () => {
    const { pi, ctx, notes, callTool } = await boot({ extraSkills: { "pdf-tools": "BODY" } });
    await pi.commands.get("sub").handler("/skill:nope do it", ctx);
    expect(notes.at(-1)!.message).toMatch(/unknown skill "nope"/);
    expect((await callTool({ action: "list" })).content[0].text).toContain("No subagents yet.");
  });

  it("prints the usage text when nothing usable was given", async () => {
    const { pi, ctx, notes } = await boot();
    await pi.commands.get("sub").handler("", ctx);
    expect(notes.at(-1)!.message).toContain("/sub [--cwd");
    await pi.commands.get("sub").handler("reviewer", ctx);
    expect(notes.at(-1)!.message).toMatch(/a task is required for agent "reviewer"/);
  });

  it("picks up the current model after a /model switch", async () => {
    const mainModel = { provider: "p", id: "main", contextWindow: 1 };
    const switchedModel = { provider: "p", id: "switched", contextWindow: 2 };
    const find = (_provider: string, id: string) => (id === mainModel.id ? mainModel : switchedModel);
    const inner = new FakeRunner((_spec, n) => new FakeSession(join(tempDir("rpc-"), `child-${n}.jsonl`), [ok("rpc answer")], false));
    const rpcRunner: Runner = {
      kind: "rpc",
      open: (spec) => inner.open(spec),
    };
    const { pi, root, cwd, rpcResolvers } = await boot({ rpcRunner, scripts: [[ok("a")], [ok("b")]], model: mainModel, find });
    expect(rpcResolvers[0]!(undefined)).toBe(mainModel);

    // `/sub` sees the context of the command, so a model switched just before reaches the child.
    const switched = fakeCtx(pi, { cwd, sessionDir: join(root, "sessions"), model: switchedModel, find }).ctx;
    await pi.commands.get("sub").handler("reviewer 任务", switched);
    expect(rpcResolvers[0]!(undefined)).toBe(switchedModel);

    // The same applies to an `@` mention routed by the input hook.
    const back = fakeCtx(pi, { cwd, sessionDir: join(root, "sessions"), model: mainModel, find }).ctx;
    await input(pi, back, "@reviewer 再来一次");
    expect(rpcResolvers[0]!(undefined)).toBe(mainModel);
  });

  it("completes agents, skills and templates", async () => {
    const { pi } = await boot({ extraSkills: { "pdf-tools": "BODY" }, extraTemplates: { review: "T" } });
    const values = (pi.commands.get("sub").getArgumentCompletions("") as { value: string }[]).map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(["reviewer", "/skill:pdf-tools", "/review"]));
  });
});

describe("default SDK runner", () => {
  for (const trusted of [true, false]) {
    it(`should_open_children_with_projectTrusted_${trusted}_when_the_main_session_ctx_reports_${trusted}`, async () => {
      // Arrange: the real SdkRunner (no createRunner); capture the trust it hands to SettingsManager, then stop the open there.
      const root = tempDir("ext-trust-");
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      mkdirSync(join(agentDir, "agents"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(agentDir, "agents", "reviewer.md"), REVIEWER);
      const seen: unknown[] = [];
      vi.spyOn(SettingsManager, "create").mockImplementation((_cwd, _agentDir, options) => {
        seen.push(options?.projectTrusted);
        throw new Error("stop after settings");
      });
      const pi = new FakePi();
      createExtension({ agentDir })(pi.asApi());
      const { ctx } = fakeCtx(pi, { cwd, sessionDir: join(root, "sessions") });
      Object.assign(ctx, { model: { provider: "p", id: "m", contextWindow: 1000 }, isProjectTrusted: () => trusted });
      await pi.emit("session_start", { type: "session_start" }, ctx);

      // Act: the run fails at the stubbed SettingsManager.create, after the trust was handed over
      await expect(
        pi.tools.get("subagents").execute("call-1", { action: "run", agent: "reviewer", task: "x" }, undefined, undefined, ctx),
      ).rejects.toThrow("stop after settings");

      // Assert
      expect(seen).toEqual([trusted]);
      await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
    });
  }

  it("does not inherit the main session's trust for a run in another cwd", async () => {
    // Arrange: an untrusted main session, and a different cwd with its own saved "trusted" decision.
    const root = tempDir("ext-cwd-trust-");
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const other = join(root, "other");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(other, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "reviewer.md"), REVIEWER);
    writeFileSync(join(other, ".pi", "settings.json"), "{}");
    new ProjectTrustStore(agentDir).set(other, true);
    const seen: unknown[] = [];
    vi.spyOn(SettingsManager, "create").mockImplementation((_cwd, _agentDir, options) => {
      seen.push(options?.projectTrusted);
      throw new Error("stop after settings");
    });
    const pi = new FakePi();
    createExtension({ agentDir })(pi.asApi());
    const { ctx } = fakeCtx(pi, { cwd, sessionDir: join(root, "sessions") });
    Object.assign(ctx, { model: { provider: "p", id: "m", contextWindow: 1000 }, isProjectTrusted: () => false });
    await pi.emit("session_start", { type: "session_start" }, ctx);

    // Act
    await expect(
      pi.tools.get("subagents").execute("call-1", { action: "run", agent: "reviewer", task: "x", cwd: other }, undefined, undefined, ctx),
    ).rejects.toThrow("stop after settings");

    // Assert: the child gets the other cwd's own decision, never the main session's `false`.
    expect(seen).toEqual([true]);
    await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  });
});
