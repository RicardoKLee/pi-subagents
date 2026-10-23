import { describe, expect, it, vi } from "vitest";
import { childExtension, type DelegationHost } from "../src/child.ts";

interface FakeTool {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

/** Collects the tools the child extension registers. */
function toolsOf(canDelegate: boolean, host: DelegationHost): Map<string, FakeTool> {
  const tools = new Map<string, FakeTool>();
  const pi = {
    registerTool: (tool: FakeTool) => void tools.set(tool.name, tool),
    on: () => () => {},
  };
  childExtension({ canDelegate, host })(pi as never);
  return tools;
}

/** The extension reads PI_SUBAGENTS_CHILD when it is built, so the test sets it for the duration of `fn`. */
async function withChildRecord<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.PI_SUBAGENTS_CHILD;
  process.env.PI_SUBAGENTS_CHILD = id;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_CHILD;
    else process.env.PI_SUBAGENTS_CHILD = previous;
  }
}

const okHost = (): DelegationHost & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    async request(parentRecordId, payload) {
      calls.push({ parentRecordId, payload });
      return { text: "child result", details: { action: "run" } };
    },
  };
};

describe("child delegation tool", () => {
  it("registers a subagents tool that forwards to the host", async () => {
    const host = okHost();
    const result = await withChildRecord("rec-1", () => {
      const tools = toolsOf(true, host);
      const tool = tools.get("subagents")!;
      expect(tool.description).toMatch(/belong to you/i);
      return tool.execute("call-1", { action: "run", agent: "worker", task: "x" }, undefined, undefined, {});
    });
    expect(result).toMatchObject({ content: [{ type: "text", text: "child result" }], details: { action: "run" } });
    expect(host.calls).toEqual([{ parentRecordId: "rec-1", payload: { action: "run", agent: "worker", task: "x" } }]);
  });

  it("registers no tool when delegation is forbidden", () => {
    expect(toolsOf(false, okHost()).size).toBe(0);
  });

  it("surfaces a host rejection as a tool error", async () => {
    const host: DelegationHost = {
      request: vi.fn(async () => {
        throw new Error("@x is not one of your subagents");
      }),
    };
    await withChildRecord("rec-1", async () => {
      const tool = toolsOf(true, host).get("subagents")!;
      await expect(tool.execute("call-1", { action: "steer", handle: "x", message: "m" }, undefined, undefined, {})).rejects.toThrow(/not one of your subagents/);
    });
  });
});