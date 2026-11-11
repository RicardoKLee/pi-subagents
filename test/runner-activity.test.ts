import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { RpcRunner } from "../src/runner/rpc.ts";
import { hasPartialText, SdkChildSession } from "../src/runner/sdk.ts";
import type { ChildActivity, ChildSession } from "../src/runner/types.ts";
import { echoAgent, harness } from "./harness.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const SERVER = fileURLToPath(new URL("./fixtures/fake-rpc-server.mjs", import.meta.url));

describe("hasPartialText", () => {
  it("counts only non-empty text blocks as progress", () => {
    expect(hasPartialText({ content: [{ type: "text", text: "out" }] })).toBe(true);
    // bash announces the call with an empty update the moment it starts; that is not progress.
    expect(hasPartialText({ content: [{ type: "text", text: "" }] })).toBe(false);
    expect(hasPartialText({ content: [] })).toBe(false);
    expect(hasPartialText({})).toBe(false);
    expect(hasPartialText(undefined)).toBe(false);
    expect(hasPartialText({ content: [{ type: "image", data: "x" }] })).toBe(false);
  });
});

describe("runner activity (sdk)", () => {
  it("maps child events to phases", async () => {
    const h = await harness("sdk");
    h.script([{ text: "done" }]);
    const session = await h.runner.open(h.spec);
    const seen: ChildActivity[] = [];
    const off = session.onActivity?.((a) => seen.push(a));
    expect(off, "runner must expose onActivity").toBeTypeOf("function");
    await session.prompt("hi");
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ phase: "idle" }));
    off?.();
    expect(seen.some((a) => a.phase === "model")).toBe(true);
    await session.dispose();
  });
});

describe("runner activity (sdk events)", () => {
  /** Only the AgentSession member `onActivity` touches: `subscribe`, captured so the test can emit events. */
  function subscribingSession() {
    const listeners: ((event: unknown) => void)[] = [];
    return {
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      emit: (event: unknown) => {
        for (const listener of [...listeners]) listener(event);
      },
    };
  }

  it("names the call that ended instead of claiming the whole message is done", () => {
    const fake = subscribingSession();
    const session = new SdkChildSession(fake as never);
    const seen: ChildActivity[] = [];
    const off = session.onActivity((a) => seen.push(a));
    fake.emit({ type: "message_start" });
    fake.emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash" });
    fake.emit({ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", partialResult: { content: [{ type: "text", text: "out" }] } });
    // bash announces the call with an empty update the moment it starts: not progress (F7).
    fake.emit({ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", partialResult: { content: [] } });
    fake.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash" });
    off?.();
    fake.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash" }); // unsubscribed

    expect(seen).toEqual([
      { phase: "model" },
      { phase: "tool", toolCallId: "call_1", toolName: "bash", progress: false },
      { phase: "tool", toolCallId: "call_1", toolName: "bash", progress: true },
      { phase: "tool", toolCallId: "call_1", toolName: "bash", progress: false },
      { phase: "tool-end", toolCallId: "call_1" },
    ]);
  });
});

describe("runner activity (rpc)", () => {
  const sessions: ChildSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.dispose().catch(() => {})));
  });

  it("maps the child's tool events to phases and progress flags", async () => {
    const runner = new RpcRunner({ resolveModel: () => ({ provider: "p", id: "m" }), cliPath: SERVER, env: { FAKE_RPC_MODE: "activity" } });
    const session = await runner.open({ agent: echoAgent, cwd: process.cwd(), sessionDir: tempDir("act-"), appendSystemPrompt: [] });
    sessions.push(session);
    const seen: ChildActivity[] = [];
    const off = session.onActivity?.((a) => seen.push(a));
    expect(off, "runner must expose onActivity").toBeTypeOf("function");
    await session.prompt("hi");
    off?.();
    const tools = seen.filter((a): a is Extract<ChildActivity, { phase: "tool" }> => a.phase === "tool");
    expect(tools.map((a) => [a.toolCallId, a.toolName, a.progress])).toEqual([
      ["call_1", "bash", false],
      ["call_1", "bash", true],
      ["call_1", "bash", false],
    ]);
    // The child announced the assistant message that carries the call before the tool events (message_start).
    expect(seen.some((a) => a.phase === "model")).toBe(true);
    // tool_execution_end names the call that finished (other calls of the same message may still run), and the settled
    // turn ends idle.
    expect(seen.filter((a) => a.phase === "tool-end")).toEqual([{ phase: "tool-end", toolCallId: "call_1" }]);
    expect(seen.at(-1)).toEqual({ phase: "idle" });
  });
});