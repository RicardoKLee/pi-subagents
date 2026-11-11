import type { AgentDef } from "../agents.ts";
import type { Usage } from "../registry.ts";
import type { RunnerKind } from "../settings.ts";

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

const STOP_REASONS: readonly StopReason[] = ["stop", "length", "toolUse", "error", "aborted"];

/** pi-ai also has "pending" and "deferred"; anything unknown counts as a normal stop. */
export function toStopReason(value: unknown): StopReason {
  return STOP_REASONS.includes(value as StopReason) ? (value as StopReason) : "stop";
}

export interface ChildDelegation {
  /** Record id of the child itself; it becomes the parent of anything the child spawns. */
  recordId: string;
  depth: number;
  /** False when the child may not spawn (depth/permission): the proxy tool is then not registered. */
  canDelegate: boolean;
  /** Mailbox of the owning session (RPC children only). */
  mailboxDir?: string;
}

export interface ChildSpec {
  agent: AgentDef;
  cwd: string;
  /** Directory for child session files. */
  sessionDir: string;
  /** Existing child session file to continue (resume). */
  resumeFile?: string;
  /** Entry in `resumeFile` to continue from; without it the session continues from its last entry. */
  resumeLeafId?: string;
  appendSystemPrompt: string[];
  /** Project trust decided by the caller for this cwd; runners fall back to their own resolution when absent. */
  projectTrusted?: boolean;
  /** Set when this child may delegate to subagents of its own (M6 nesting). */
  delegation?: ChildDelegation;
}

/**
 * A phase change of one child turn: `model` while a model request or the turn itself is in flight, `tool` while a
 * tool call runs, `idle` once the turn settled. `progress` is false when the tool reported nothing new (bash's
 * start-only empty update), so a caller never mistakes a start announcement for real output.
 */
export type ChildActivity =
  | { phase: "model" }
  | { phase: "idle" }
  | { phase: "tool"; toolCallId: string; toolName: string; progress: boolean };

export interface ChildResult {
  text: string;
  stopReason: StopReason;
  errorMessage?: string;
  /** Usage of this prompt only (delta), not the whole session. */
  usage: Usage;
}

export interface ChildSession {
  readonly sessionFile: string;
  /** Current leaf entry of the child session (where the next turn attaches), if any. */
  readonly leafId: string | undefined;
  /** False once disposed or once the child ended on its own; a dead session is never reused. */
  readonly alive: boolean;
  /**
   * Called if the child ends on its own (crash, killed process); not called for dispose(). Returns an unsubscribe function.
   * The owner still calls dispose() after an exit to release whatever is left (listeners, pipes, a process to reap).
   */
  onExit(listener: (reason: string) => void): () => void;
  /** Optional: reports phase changes and tool progress. Returns an unsubscribe function. */
  onActivity?(listener: (activity: ChildActivity) => void): () => void;
  /** Resolves when the child is idle after handling `text`. */
  prompt(text: string): Promise<ChildResult>;
  /**
   * Injects a result produced elsewhere into this child session (M6 nesting).
   * `start` opens a new turn (idle child); `queue` waits for the current turn to finish (running child).
   */
  deliver(text: string, mode: "start" | "queue"): Promise<void>;
  steer(text: string, mode: "steer" | "followUp"): Promise<void>;
  abort(): Promise<void>;
  /**
   * Closes the child and resolves once it is gone (process exited, session file no longer written).
   * Must be idempotent and must work after the child has exited on its own (see onExit).
   */
  dispose(): Promise<void>;
}

export interface Runner {
  readonly kind: RunnerKind;
  open(spec: ChildSpec): Promise<ChildSession>;
}
