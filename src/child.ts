import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { SubagentsParams } from "./tool.ts";

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
        "action=run starts one; parallel/chain run several; resume/continue/steer/interrupt/stop act on your own subagents; list shows your subtree.",
      parameters: SubagentsParams,
      async execute(_toolCallId, params, signal) {
        const out = await opts.host.request(parentRecordId, params as Record<string, unknown>, signal);
        return { content: [{ type: "text" as const, text: out.text }], details: out.details ?? {} };
      },
    });
  };
}

/**
 * The RPC child's host: it hands one delegation request to the owning session through the file mailbox.
 * TODO(mailbox): milestone 6 task 3 replaces this placeholder with `callViaMailbox()` from `./mailbox.ts`; the tool
 * contract (`DelegationHost`) and the wiring in `index.ts` are already final, so only the transport changes.
 */
export function mailboxHost(dir: string, parentRecordId: string): DelegationHost {
  return {
    async request(_parentRecordId, _payload, _signal) {
      throw new Error(`delegation from an RPC child is not wired up yet (mailbox ${dir || "(none)"}, parent ${parentRecordId || "(none)"})`);
    },
  };
}