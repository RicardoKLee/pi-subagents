import { type Static, Type } from "typebox";
import type { BatchOutcome, SubagentManager } from "./manager.ts";
import { renderTree } from "./tree.ts";

const BatchItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task for this subagent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the main session's)" })),
});

// TODO(delivery): background results from the main agent are always delivered with "auto". Add a `delivery`
// parameter back if a use case appears (plan section 6.5 item 4).
export const SubagentsParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("run"),
      Type.Literal("parallel"),
      Type.Literal("chain"),
      Type.Literal("resume"),
      Type.Literal("continue"),
      Type.Literal("steer"),
      Type.Literal("interrupt"),
      Type.Literal("stop"),
      Type.Literal("list"),
    ],
    { description: "run = new subagent; parallel = many at once; chain = sequential with {previous}; resume = continue a finished/paused one by handle; continue = resume the step that stopped a chain and finish it" },
  ),
  agent: Type.Optional(Type.String({ description: "Agent name (run)" })),
  task: Type.Optional(Type.String({ description: "Task for a new subagent (run)" })),
  handle: Type.Optional(Type.String({ description: "Existing subagent handle, e.g. reviewer-2 (resume/steer/interrupt/stop/continue)" })),
  message: Type.Optional(Type.String({ description: "Message for resume, steer or continue" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for a single run (run)" })),
  tasks: Type.Optional(Type.Array(BatchItem, { description: "parallel: tasks to run at the same time" })),
  chain: Type.Optional(Type.Array(BatchItem, { description: "chain: steps to run in order; {previous} is the previous step's output" })),
  background: Type.Optional(Type.Boolean({ description: "Return immediately; the result arrives later" })),
  mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
});

export type SubagentsInput = {
  action: "run" | "parallel" | "chain" | "resume" | "continue" | "steer" | "interrupt" | "stop" | "list";
} & Partial<Omit<Static<typeof SubagentsParams>, "action">>;

function need<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined || value === "") throw new Error(`action "${action}" requires "${name}"`);
  return value;
}

function needList<T>(value: readonly T[] | undefined, name: string, action: string): T[] {
  if (!value || value.length === 0) throw new Error(`action "${action}" requires a non-empty "${name}" array`);
  return [...value];
}

/**
 * A batch returns either its finished summary or, for a background group/chain, just the handles and the chain id.
 * Background records are creation-time snapshots, so their status is never reported here (the registry is authoritative).
 */
function batchResult(out: BatchOutcome, action: string): { text: string; details: Record<string, unknown> } {
  const handles = out.records.map((r) => `@${r.handle}`);
  if (!out.payload) {
    const started = out.chain ? `Started chain ${out.chain.id} with ${out.chain.steps.length} steps` : `Started ${out.records.length} parallel subagents`;
    return {
      text: `${started}; a summary will be delivered when it finishes.${handles.length ? ` Handles: ${handles.join(", ")}` : ""}`,
      details: { action, chainId: out.chain?.id, handles: out.records.map((r) => r.handle) },
    };
  }
  return {
    text: out.payload.text,
    details: { action, chainId: out.chain?.id, handles: out.records.map((r) => r.handle), statuses: out.records.map((r) => r.status) },
  };
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
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.background ? { background: true } : {}),
        ...(signal ? { signal } : {}),
      });
      const body = payload ? payload.text : "Started in the background; the result will be delivered when it finishes.";
      return { text: `@${record.handle} (${record.status}). Reuse it with action "resume".\n\n${body}`, details: { handle: record.handle, status: record.status } };
    }
    case "parallel": {
      const out = await manager.runParallel({
        items: needList(input.tasks, "tasks", "parallel"),
        background: input.background ?? false,
        ...(signal ? { signal } : {}),
      });
      return batchResult(out, "parallel");
    }
    case "chain": {
      const out = await manager.runChain({
        steps: needList(input.chain, "chain", "chain"),
        background: input.background ?? false,
        ...(signal ? { signal } : {}),
      });
      return batchResult(out, "chain");
    }
    case "continue": {
      const out = await manager.continueChain(need(input.handle, "handle", "continue"), input.message, {
        background: input.background ?? false,
        ...(signal ? { signal } : {}),
      });
      return batchResult(out, "continue");
    }
    case "resume": {
      const { record, payload } = await manager.resume(need(input.handle, "handle", "resume"), need(input.message, "message", "resume"), extra);
      return { text: `@${record.handle} run ${record.runId} (${record.status}).\n\n${payload?.text ?? "Resumed in the background."}`, details: { handle: record.handle, runId: record.runId } };
    }
    case "steer":
      await manager.steer(need(input.handle, "handle", "steer"), need(input.message, "message", "steer"), input.mode ?? "steer");
      return { text: `Steering message delivered to ${input.handle}.`, details: {} };
    case "interrupt": {
      const outcome = await manager.interrupt(need(input.handle, "handle", "interrupt"));
      const text =
        outcome === "cancelled"
          ? `${input.handle} had not started yet; it is cancelled and cannot be resumed.`
          : `${input.handle} interrupted; it is paused and can be resumed.`;
      return { text, details: {} };
    }
    case "stop":
      await manager.stop(need(input.handle, "handle", "stop"));
      return { text: `${input.handle} stopped; it cannot be resumed.`, details: {} };
    case "list": {
      const records = manager.list();
      return { text: renderTree(records, "list"), details: { count: records.length } };
    }
  }
}
