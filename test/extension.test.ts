import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_ENTRY_TYPE } from "../src/delivery.ts";
import { createExtension } from "../src/index.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { FakePi, fakeCtx } from "./fake-pi.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";

const REVIEWER = "---\nname: reviewer\ndescription: Reviews code\n---\nReview.";

/** Boots the extension against a FakePi with a FakeRunner; one held or scripted child per open. */
export async function boot(opts: { hold?: boolean; scripts?: ChildResult[][]; extraAgents?: Record<string, string>; hasUI?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ext-"));
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
});
