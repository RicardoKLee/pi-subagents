import { type Static, Type } from "typebox";
import type { SubagentManager } from "./manager.ts";
import { renderTree } from "./tree.ts";

// TODO(delivery): background results from the main agent are always delivered with "auto". Add a `delivery`
// parameter back if a use case appears (plan section 6.5 item 4).
export const SubagentsParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("run"),
      Type.Literal("resume"),
      Type.Literal("steer"),
      Type.Literal("interrupt"),
      Type.Literal("stop"),
      Type.Literal("list"),
    ],
    { description: "run = new subagent; resume = continue a finished/paused one by handle; steer = guide a running one" },
  ),
  agent: Type.Optional(Type.String({ description: "Agent name (run)" })),
  task: Type.Optional(Type.String({ description: "Task for a new subagent (run)" })),
  handle: Type.Optional(Type.String({ description: "Existing subagent handle, e.g. reviewer-2 (resume/steer/interrupt/stop)" })),
  message: Type.Optional(Type.String({ description: "Message for resume or steer" })),
  background: Type.Optional(Type.Boolean({ description: "Return immediately; the result arrives later" })),
  mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
});

export type SubagentsInput = {
  action: "run" | "resume" | "steer" | "interrupt" | "stop" | "list";
} & Partial<Omit<Static<typeof SubagentsParams>, "action">>;

function need<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined || value === "") throw new Error(`action "${action}" requires "${name}"`);
  return value;
}

export async function executeAction(
  manager: SubagentManager,
  input: SubagentsInput,
  signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
  // Esc / session switch aborts the tool call; pause the children so the call can return.
  const onAbort = () => void manager.interruptAll();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await dispatch(manager, input, signal);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function dispatch(
  manager: SubagentManager,
  input: SubagentsInput,
  signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
  // `signal` is only added when present so callers without one see the same arguments as before.
  // Background work started by the main agent always comes back with "auto": it started the work to use the result.
  const extra = {
    ...(input.background ? { background: true, delivery: "auto" as const } : {}),
    ...(signal ? { signal } : {}),
  };
  switch (input.action) {
    case "run": {
      const { record, payload } = await manager.run({
        agent: need(input.agent, "agent", "run"),
        task: need(input.task, "task", "run"),
        ...(input.background ? { background: true } : {}),
        ...(signal ? { signal } : {}),
      });
      const body = payload ? payload.text : "Started in the background; the result will be delivered when it finishes.";
      return { text: `@${record.handle} (${record.status}). Reuse it with action "resume".\n\n${body}`, details: { handle: record.handle, status: record.status } };
    }
    case "resume": {
      const { record, payload } = await manager.resume(need(input.handle, "handle", "resume"), need(input.message, "message", "resume"), extra);
      return { text: `@${record.handle} run ${record.runId} (${record.status}).\n\n${payload?.text ?? "Resumed in the background."}`, details: { handle: record.handle, runId: record.runId } };
    }
    case "steer":
      await manager.steer(need(input.handle, "handle", "steer"), need(input.message, "message", "steer"), input.mode ?? "steer");
      return { text: `Steering message delivered to ${input.handle}.`, details: {} };
    case "interrupt":
      await manager.interrupt(need(input.handle, "handle", "interrupt"));
      return { text: `${input.handle} interrupted; it is paused and can be resumed.`, details: {} };
    case "stop":
      await manager.stop(need(input.handle, "handle", "stop"));
      return { text: `${input.handle} stopped; it cannot be resumed.`, details: {} };
    case "list": {
      const records = manager.list();
      return { text: renderTree(records, "list"), details: { count: records.length } };
    }
  }
}
