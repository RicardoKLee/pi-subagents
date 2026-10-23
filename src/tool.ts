import { type Static, Type } from "typebox";
import { type EntryRequest, parseEntryRequest } from "./entries.ts";
import type { BatchOutcome, SubagentManager } from "./manager.ts";
import { renderTree } from "./tree.ts";

const BatchItem = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name" })),
  skill: Type.Optional(Type.String({ description: "Skill name, run as /skill:<name> in the child" })),
  command: Type.Optional(Type.String({ description: "Prompt template name, run as /<name> in the child" })),
  task: Type.Optional(Type.String({ description: "Task (agent entry) or arguments appended to the skill/template" })),
  cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the main session's)" })),
});

/**
 * Every action the `subagents` tool accepts. The schema union, the delegating session's gate and the dispatcher all
 * read this one list, so adding an action cannot silently miss one of them (REVIEW-040).
 */
export const SUBAGENT_ACTIONS = ["run", "parallel", "chain", "resume", "continue", "steer", "interrupt", "stop", "list"] as const;

// TODO(delivery): background results from the main agent are always delivered with "auto". Add a `delivery`
// parameter back if a use case appears (plan section 6.5 item 4).
export const SubagentsParams = Type.Object({
  action: Type.Union(
    SUBAGENT_ACTIONS.map((action) => Type.Literal(action)),
    { description: "run = new subagent; parallel = many at once; chain = sequential with {previous}; resume = continue a finished/paused one by handle; continue = resume the step that stopped a chain and finish it" },
  ),
  agent: Type.Optional(Type.String({ description: "Agent name (run); give exactly one of agent, skill or command" })),
  skill: Type.Optional(Type.String({ description: "Skill name (run), run as /skill:<name> in the child" })),
  command: Type.Optional(Type.String({ description: "Prompt template name (run), run as /<name> in the child" })),
  task: Type.Optional(Type.String({ description: "Task for an agent entry, or arguments appended to the skill/template (run)" })),
  handle: Type.Optional(Type.String({ description: "Existing subagent handle, e.g. reviewer-2 (resume/steer/interrupt/stop/continue)" })),
  message: Type.Optional(Type.String({ description: "Message for resume, steer or continue" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for a single run (run)" })),
  tasks: Type.Optional(Type.Array(BatchItem, { description: "parallel: tasks to run at the same time" })),
  chain: Type.Optional(Type.Array(BatchItem, { description: "chain: steps to run in order; {previous} is the previous step's output" })),
  background: Type.Optional(Type.Boolean({ description: "Return immediately; the result arrives later" })),
  mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
});

export type SubagentsInput = {
  action: (typeof SUBAGENT_ACTIONS)[number];
} & Partial<Omit<Static<typeof SubagentsParams>, "action">>;

/**
 * Internal delegation scope, threaded only by the child-session path (the `delegate()` host of M6).
 * `SubagentsParams` deliberately knows nothing about it, so the model-visible tool schema never exposes a parent;
 * `toolCallInput()` also drops a stray copy from raw model arguments, keeping the main-session path at requester
 * `undefined` (depth 0, no whitelist).
 */
export interface DelegationScope {
  /** Record id of the subagent that asked for this action; the manager derives the child's depth from that record. */
  parentId?: string;
  /** Informational only: the manager always derives depth from `parentId`, so a caller's claim is ignored. */
  depth?: number;
}

/** A dispatch request: the model-visible input plus the internal delegation scope. */
export type DispatchInput = SubagentsInput & DelegationScope;

/**
 * Strips the internal delegation fields from a tool call. Extra JSON properties are not part of `SubagentsParams`,
 * but a model could still send one; it must never reach the manager as if it came from the internal delegation path.
 * The top-level `parentId` and any `parentId` inside `tasks[]` / `chain[]` items are dropped (the model-visible
 * schema declares the field nowhere).
 */
export function toolCallInput(params: SubagentsInput): SubagentsInput {
  const candidate = params as SubagentsInput & { parentId?: unknown };
  const tasks = stripItemParents(candidate.tasks);
  const chain = stripItemParents(candidate.chain);
  if (candidate.parentId === undefined && tasks === candidate.tasks && chain === candidate.chain) return params;
  const { parentId: _internal, ...rest } = candidate;
  return {
    ...rest,
    ...(tasks !== candidate.tasks ? { tasks } : {}),
    ...(chain !== candidate.chain ? { chain } : {}),
  };
}

/** Drops a stray `parentId` from every batch item; returns the original array when there is nothing to strip. */
function stripItemParents<T>(items: readonly T[] | undefined): T[] | undefined {
  if (!Array.isArray(items)) return undefined;
  let changed = false;
  const out = items.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    if (record.parentId === undefined) return item;
    const { parentId: _internal, ...rest } = record;
    changed = true;
    return rest as T;
  });
  return changed ? out : (items as T[]);
}

function need<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined || value === "") throw new Error(`action "${action}" requires "${name}"`);
  return value;
}

function needList<T>(value: readonly T[] | undefined, name: string, action: string): T[] {
  if (!value || value.length === 0) throw new Error(`action "${action}" requires a non-empty "${name}" array`);
  return [...value];
}

/** The entry fields of a tool call, only present when the caller set them (keeps call signatures stable). */
function entryFields(input: SubagentsInput): EntryRequest {
  return {
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.skill ? { skill: input.skill } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.task ? { task: input.task } : {}),
  };
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
  input: DispatchInput,
  signal?: AbortSignal,
  /**
   * What an aborted tool call means for live children. The main session (the default) pauses every running
   * subagent so Esc / session switch makes the call return. The delegation path overrides it: a child's own
   * interrupt must not cascade (plan 6.9 decision 8), so it passes a scoped no-op.
   */
  onAbort: () => void = () => void manager.interruptAll(),
): Promise<{ text: string; details: Record<string, unknown> }> {
  // Esc / session switch aborts the tool call; pause the children so the call can return.
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
  input: DispatchInput,
  signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
  // `signal` is only added when present so callers without one see the same arguments as before.
  // Background work started by the main agent always comes back with "auto": it started the work to use the result.
  const extra = {
    ...(input.background ? { background: true, delivery: "auto" as const } : {}),
    ...(signal ? { signal } : {}),
  };
  // Internal only: the parent record the delegation path attributes runs to. The main agent's tool call never
  // carries it, so `run`/`parallel`/`chain` keep the depth-0 requester (no whitelist) for the main session.
  const parentId = input.parentId;
  switch (input.action) {
    case "run": {
      const entry = entryFields(input);
      // Structural validation only (exactly one entry kind, agent entries need a task); the manager re-parses and
      // validates the names so nothing is created on a bad target.
      parseEntryRequest(entry, "run");
      const { record, payload } = await manager.run({
        ...entry,
        ...(parentId ? { parentId } : {}),
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
        ...(parentId ? { parentId } : {}),
        background: input.background ?? false,
        ...(signal ? { signal } : {}),
      });
      return batchResult(out, "parallel");
    }
    case "chain": {
      const out = await manager.runChain({
        steps: needList(input.chain, "chain", "chain"),
        ...(parentId ? { parentId } : {}),
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
      return { text: renderTree(records, "list", manager.listChains()), details: { count: records.length } };
    }
    default:
      // Every `SubagentsParams` action has a branch above; this is unreachable through the tool schema. It turns a
      // future action added only to the schema into a clear error instead of a silent `undefined` result (REVIEW-040).
      throw new Error("unsupported subagents action");
  }
}
