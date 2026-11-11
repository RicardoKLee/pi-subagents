import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { callViaMailbox } from "./mailbox.ts";
import { ACTION_GUIDANCE, SubagentsParams } from "./tool.ts";

export interface DelegationHost {
  /** Runs one delegation request in the owning session (in-process for SDK children, the mailbox for RPC). */
  request(parentRecordId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; details?: unknown }>;
}

export interface ChildDelegationOptions {
  host: DelegationHost;
  /** False when depth or the agent's allowance forbid spawning: no tool is registered then. */
  canDelegate: boolean;
  /**
   * Record id of this child. Defaults to `PI_SUBAGENTS_CHILD`, which an RPC child inherits from the parent's spawn;
   * an in-process SDK child writes nothing to the environment, so its runner passes the id from the spec instead.
   */
  recordId?: string;
}

/** Record id of this session when it was started as a subagent (set by the parent's spawn). */
export function childRecordId(): string | undefined {
  return process.env.PI_SUBAGENTS_CHILD || undefined;
}

/**
 * The extension a child session loads: a single `subagents` tool that forwards to the owning session.
 * No manager, no commands, no input hook — the child owns no registry of its own, so the parent's manager stays the
 * single scheduler and the single registry (plan 6.9 item 1). The tool is not registered at all when depth or the
 * agent's allowance forbid spawning (item 2).
 */
export function childExtension(opts: ChildDelegationOptions): ExtensionFactory {
  const parentRecordId = opts.recordId ?? childRecordId() ?? "";
  return (pi: ExtensionAPI) => {
    if (!opts.canDelegate) return;
    pi.registerTool({
      name: "subagents",
      label: "Subagents",
      description:
        "Delegate work to subagents that belong to you: results come back into this session, and you can only reach your own subagents (never your parent's or your siblings'). " +
        "action=run starts one; parallel/chain run several; resume/continue/restart/steer/interrupt/stop act on your own subagents; list shows your subtree. " +
        `${ACTION_GUIDANCE} The mass actions are reserved for the main agent: you cannot stop-all or interrupt-all.`,
      parameters: SubagentsParams,
      // One delegation at a time with the other calls of the assistant message. The tool forwards to the owning
      // session's manager, which yields the delegating run's scheduler slot while it waits for a child; running two
      // of these at once used to race that yield/re-acquire and deadlock under maxConcurrent 1 (REVIEW-046). This is
      // hardening only: the manager coordinates concurrent in-flight delegations itself, so a caller that still runs
      // them in parallel stays correct.
      executionMode: "sequential",
      async execute(_toolCallId, params, signal) {
        const out = await opts.host.request(parentRecordId, params as Record<string, unknown>, signal);
        return { content: [{ type: "text" as const, text: out.text }], details: out.details ?? {} };
      },
    });
  };
}

/**
 * The RPC child's host: it hands one delegation request to the owning session through the file mailbox
 * (`callViaMailbox`) and waits for that session's manager to answer.
 */
export function mailboxHost(dir: string, parentRecordId: string): DelegationHost {
  return {
    async request(_parentRecordId, payload, signal) {
      let response;
      try {
        response = await callViaMailbox(dir, { id: randomUUID(), parentRecordId, payload }, { ...(signal ? { signal } : {}) });
      } catch (error) {
        // REVIEW-023: the child's model must never see the internal mailbox path. A filesystem error (ENOTDIR and so
        // on) embeds it, so strip every occurrence before it becomes a tool error the model can read.
        throw new Error(withoutMailboxPath(error instanceof Error ? error.message : String(error), dir));
      }
      if (!response.ok) throw new Error(withoutMailboxPath(response.error ?? "delegation failed", dir));
      return { text: response.text ?? "", details: response.details };
    },
  };
}

/** Removes the mailbox directory from an error message so a child never learns an internal path (REVIEW-023). */
function withoutMailboxPath(message: string, dir: string): string {
  if (!dir) return message;
  return message.split(dir).join("<mailbox>");
}
