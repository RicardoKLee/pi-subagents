import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_ENTRY_TYPE } from "../src/delivery.ts";
import { createExtension } from "../src/index.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { FakePi, fakeCtx } from "./fake-pi.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const REVIEWER = "---\nname: reviewer\ndescription: Reviews code\n---\nReview.";

/** Boots the extension against a FakePi with a FakeRunner; one held or scripted child per open. */
export async function boot(
  opts: { hold?: boolean; scripts?: ChildResult[][]; extraAgents?: Record<string, string>; hasUI?: boolean; branch?: unknown[] } = {},
) {
  const root = tempDir("ext-");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "reviewer.md"), REVIEWER);
  for (const [name, content] of Object.entries(opts.extraAgents ?? {})) writeFileSync(join(agentDir, "agents", name), content);
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
  createExtension({ agentDir, createRunner: () => runner })(pi.asApi());
  pi.branch.push(...(opts.branch ?? []));
  const { ctx, notes, providers } = fakeCtx(pi, { cwd, sessionDir, hasUI: opts.hasUI ?? true });
  await pi.emit("session_start", { type: "session_start" }, ctx);
  const tool = pi.tools.get("subagents");
  const callTool = (params: Record<string, unknown>) => tool.execute("call-1", params, undefined, undefined, ctx);
  return { pi, ctx, notes, providers, runner, callTool, root, cwd, agentDir };
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
});
