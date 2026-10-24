import { Value } from "typebox/value";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentDef } from "./agents.ts";
import { type ChainRecord, type ChainStatus, ChainStore } from "./chain.ts";
import { type Ask, deliver, type DeliveryPort, deliverBatch, quoteAsk, renderAsks } from "./delivery.ts";
import { BUILTIN_ENTRY_AGENT_DEF, type EntryRequest, parseEntryRequest, type ResolvedEntry, validateEntryTarget } from "./entries.ts";
import { type MailboxErrorInfo, MailboxServer } from "./mailbox.ts";
import { estimateTokens, type Payload, preparePayload, SUMMARY_INSTRUCTION, writeOutput } from "./output.ts";
import { type PendingResult, recordEntryLabel, type Registry, type RunStatus, type SubagentRecord, type Usage, ZERO_USAGE } from "./registry.ts";
import type { ChildDelegation, ChildResult, ChildSession, Runner } from "./runner/types.ts";
import { type Scheduler, SubagentsDisabledError } from "./scheduler.ts";
import type { DeliveryMode, RunnerKind, SubagentSettings } from "./settings.ts";
import { limitAllows } from "./settings.ts";
import { executeAction, SUBAGENT_ACTIONS, SubagentsParams, type DispatchInput, type SubagentsInput } from "./tool.ts";
import { renderTree } from "./tree.ts";

export type SubagentErrorCode =
  | "unknown_agent"
  | "unknown_handle"
  | "stopped"
  | "busy"
  | "not_running"
  | "missing_session"
  | "missing_cwd"
  | "interrupted";

export class SubagentError extends Error {
  constructor(readonly code: SubagentErrorCode, message: string) {
    super(message);
    this.name = "SubagentError";
  }
}

/**
 * The actions a delegation request may carry, taken from the one action list the tool schema is built from (REVIEW-040).
 * The mailbox hands the manager arbitrary JSON, so the action is checked here (REVIEW-033) instead of trusting that
 * every request came from the model-validated tool schema.
 */
const DELEGATION_ACTIONS = new Set<string>(SUBAGENT_ACTIONS);

/**
 * The delegation actions that wait for a child run and therefore hand the parent's scheduler slot over for the wait
 * (REVIEW-046). `list`, `steer`, `interrupt` and `stop` only touch records that already exist and return without
 * starting a run, so they must never release and re-acquire the parent's slot (REVIEW-049).
 */
const YIELDING_DELEGATION_ACTIONS = new Set<string>(["run", "resume", "continue", "parallel", "chain"]);

export interface ManagerDeps {
  registry: Registry;
  chainStore: ChainStore;
  scheduler: Scheduler;
  runners: Record<RunnerKind, Runner | undefined>;
  agents: () => Map<string, AgentDef>;
  settings: () => SubagentSettings;
  port: DeliveryPort;
  /** Context window of whoever receives the result (main model in M1). */
  receiverContextWindow: () => number;
  /** Context window of a given agent's model, for the 30% rule between chain steps. */
  receiverContextWindowFor?: (agent: AgentDef) => number | undefined;
  cwd: string;
  /** Agent directory used to validate skill and prompt template names. */
  agentDir: string;
  sessionDir: string;
  outputDir: string;
  /** Project trust for a child cwd decided by the caller; the manager never guesses it. */
  trustForCwd?: (cwd: string) => boolean | undefined;
  /** Called when a background result could not be delivered (the error is also recorded on the record). */
  onDeliveryError?: (record: SubagentRecord, message: string) => void;
  /** Called once a new record exists (queued); used to warn about handles that clash with files. */
  onRecordCreated?: (record: SubagentRecord) => void;
  /** Directory of the file mailbox a nested child uses to delegate (M6). Absent disables nesting. */
  mailboxDir?: string;
  /** Called once when a pending child-result batch has waited longer than `pendingResultTimeoutMinutes` (M6). */
  onPendingReminder?: (record: SubagentRecord, count: number, oldestMinutes: number) => void;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

export interface RunRequest extends EntryRequest {
  delivery?: DeliveryMode;
  background?: boolean;
  /**
   * Set only by the delegation path for a background action: return the queued handle without waiting for a scheduler
   * slot, so a subagent's own tool call never blocks on the slot that subagent holds (LATENT-046-BG). The wait moves
   * into a detached task, so the child still starts as soon as a slot frees. Honored only when no slot is free now.
   */
  detach?: boolean;
  /** The calling tool's signal: aborting it cancels this run while queued, opening, or (foreground) running. */
  signal?: AbortSignal;
  /** Working directory for the child; relative paths resolve against deps.cwd. Defaults to deps.cwd. */
  cwd?: string;
  /** Receiver window for the 30% rule (chain steps size their output for the next step). Defaults to deps.receiverContextWindow(). */
  receiverContextWindow?: number;
  /** Set for chain steps: the chain this run belongs to and its 0-based position. */
  chainId?: string;
  stepIndex?: number;
  /** The user's own message, quoted with the delivered result (used by `/sub`). */
  ask?: string;
  /** Set by the delegation path: the subagent that asked for this run becomes its parent. */
  parentId?: string;
  /** Informational only: a record's depth is always derived from its parent (root subagents are depth 1). */
  depth?: number;
}

export interface RunOutcome {
  record: SubagentRecord;
  /** Set for foreground calls. */
  payload?: Payload;
}

export interface BatchItem extends EntryRequest {
  cwd?: string;
  /** Set by the delegation path: the subagent that asked for this item becomes its parent. */
  parentId?: string;
  /** Informational only: a record's depth is always derived from its parent (root subagents are depth 1). */
  depth?: number;
}

export interface BatchOutcome {
  /**
   * Records for the batch, in item order. A foreground batch resolves with each record's final state; a background
   * parallel batch returns the queued snapshots taken when the records were created, and a background chain returns an
   * empty list (the tool only needs the chain id). Callers must read the current status from the registry, never from
   * these snapshots.
   */
  records: SubagentRecord[];
  /** Foreground batches: the summary the tool returns. */
  payload?: Payload;
  /** Chains only: the chain this batch belongs to. */
  chain?: ChainRecord;
}

interface Prepared {
  record: SubagentRecord;
  agent: AgentDef;
  runner: Runner;
  cwd: string;
  trusted?: boolean;
  controller: AbortController;
  /** The text handed to the child session (already built from the entry). */
  prompt: string;
}

/** An item's entry, agent, runner and cwd after validation; computed once so a whole batch can be checked before any record exists. */
interface Resolved {
  entry: ResolvedEntry;
  agent: AgentDef;
  runner: Runner;
  cwd: string;
  trusted?: boolean;
}

interface LaunchOptions {
  /** "batch" items never return early, never deliver on their own, and size their output by `receiverContextWindow`. */
  mode?: "single" | "batch";
  receiverContextWindow?: number;
  /** User messages to quote with the delivered result. */
  asks?: Ask[];
  /** Delegation-path background run: return the queued handle and wait for a slot in a detached task (LATENT-046-BG). */
  detach?: boolean;
}

interface Live {
  session: ChildSession;
  intent?: "interrupt" | "stop";
  /** User messages sent through `@` for this run, quoted with its result. */
  asks: Ask[];
  /**
   * The scheduler grant this run currently holds. `execute` sets it on entry; a foreground delegation swaps it while
   * the parent waits for a child (REVIEW point 5), so `execute` must release whatever grant is current there.
   */
  release?: () => void;
  /**
   * How many foreground delegations have given up this run's slot and are still waiting on a child. The first one
   * releases the slot (0 -> 1) and the last one to finish re-acquires it (1 -> 0); concurrent delegations from one
   * parent therefore share a single yielded grant instead of each releasing and re-acquiring its own, which deadlocked
   * two parallel calls under maxConcurrent 1 (REVIEW-046).
   */
  yielding?: number;
}

export class SubagentManager {
  private readonly live = new Map<string, Live>();
  private readonly work = new Set<Promise<unknown>>();
  /** Resumes that claimed a record but have not reached execute() yet. */
  private readonly claims = new Map<string, { intent?: "stop"; controller: AbortController }>();
  /** Runs that have a record but no child session yet (waiting for a slot or opening); aborting cancels them. */
  private readonly queued = new Map<string, AbortController>();
  /** Queued runs cancelled by interrupt/stop; checked even if persisting the cancel failed. */
  private readonly cancelled = new Set<string>();
  /** Children kept open between turns, keyed by record id; insertion order = least recently used first. */
  private readonly idle = new Map<string, ChildSession>();
  /** Children being disposed, keyed by record id; a reopen of the same session file waits for this first. */
  private readonly closing = new Map<string, Promise<void>>();
  /** Sessions whose onExit is already wired (a session is parked many times). */
  private readonly watched = new WeakSet<ChildSession>();
  /** The file mailbox that serves delegations from RPC children while at least one can ask (M6). */
  private mailbox?: MailboxServer;
  private closed = false;
  /** Reminder watch for queued child results (M6); started only while something is waiting. */
  private pendingTimer?: NodeJS.Timeout;
  /** Aborted on shutdown so queued run/resume calls stop waiting for a slot. */
  private readonly lifetime = new AbortController();

  constructor(private readonly deps: ManagerDeps) {}

  /** Injectable clock so reminder timing is testable. */
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  list(): SubagentRecord[] {
    return this.deps.registry.list();
  }

  /** Chains on the current branch, in creation order (for the list tree). */
  listChains(): ChainRecord[] {
    return this.deps.chainStore.list();
  }

  /**
   * The `父/子` path of a record: the handle of every ancestor from the root down, then its own handle. A root record's
   * path is just its handle. Used by the `@` completion description and by path addressing, so a nested handle can be
   * told apart from a root one.
   */
  recordPath(record: SubagentRecord): string {
    const parts = [record.handle];
    // `seen` guards a corrupt registry (a parentId cycle), exactly like `ancestorChain`.
    const seen = new Set<string>([record.id]);
    for (let current = record.parentId ? this.deps.registry.get(record.parentId) : undefined; current; ) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      parts.unshift(current.handle);
      current = current.parentId ? this.deps.registry.get(current.parentId) : undefined;
    }
    return parts.join("/");
  }

  /** The effective spawn policy for a record: depth plus the intersection of its ancestors' whitelists. */
  private requesterPolicy(record: SubagentRecord): { depth: number; allowed: Set<string> | null } {
    let allowed: Set<string> | null = null;
    for (const ancestor of [...this.ancestorChain(record), record]) {
      const agent = this.deps.agents().get(ancestor.agent);
      const list = agent?.allowedSubagents;
      // An empty list is a whitelist that allows nothing, so only `undefined` means "no restriction".
      if (!list) continue;
      if (!allowed) {
        allowed = new Set<string>(list);
        continue;
      }
      // Intersect: a level may only narrow what its ancestors allowed, never widen it.
      const narrowed = new Set<string>();
      for (const name of allowed) if (list.includes(name)) narrowed.add(name);
      allowed = narrowed;
    }
    return { depth: record.depth, allowed };
  }

  /** The record's ancestors, nearest first. */
  private ancestorChain(record: SubagentRecord): SubagentRecord[] {
    const chain: SubagentRecord[] = [];
    // `seen` closes a corrupt registry (a parentId cycle): without it a bad record would loop forever. `record`
    // itself is seeded so a record that points back at itself also terminates.
    const seen = new Set<string>([record.id]);
    for (let current = record.parentId ? this.deps.registry.get(record.parentId) : undefined; current; ) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      chain.push(current);
      current = current.parentId ? this.deps.registry.get(current.parentId) : undefined;
    }
    return chain;
  }

  /** The main session acts as a requester with depth 0 and no whitelist. */
  private policyFor(record: SubagentRecord | undefined): { depth: number; allowed: Set<string> | null } {
    return record ? this.requesterPolicy(record) : { depth: 0, allowed: null };
  }

  /** Whether this session may start subagents at all (depth 0 against maxDepth). */
  canStartSubagents(): boolean {
    return limitAllows(this.deps.settings().maxDepth, 0);
  }

  /** May this record start subagents at all? */
  delegationFor(record: SubagentRecord): { canDelegate: boolean; reason?: string } {
    const max = this.deps.settings().maxDepth;
    if (!limitAllows(max, record.depth)) {
      return { canDelegate: false, reason: `reached the maximum nesting depth (maxDepth=${max}); you cannot start more subagents` };
    }
    const { allowed } = this.policyFor(record);
    if (allowed && allowed.size === 0) return { canDelegate: false, reason: "your agent definition does not allow spawning any subagent" };
    return { canDelegate: true };
  }

  /** Throws unless `requester` (undefined = the main session) may spawn the resolved entry right now. */
  private assertCanSpawn(requester: SubagentRecord | undefined, entry: ResolvedEntry, reserved = 0): void {
    const { depth, allowed } = this.policyFor(requester);
    const max = this.deps.settings().maxDepth;
    if (!limitAllows(max, depth)) throw new Error(`reached the maximum nesting depth (maxDepth=${max}); you cannot start more subagents`);
    if (allowed && (!allowed.size || entry.kind !== "agent" || !allowed.has(entry.name))) {
      const name = entry.kind === "agent" ? entry.name : `${entry.kind}:${entry.name}`;
      throw new Error(`your agent definition does not allow spawning "${name}" (allowed: ${[...allowed].join(", ") || "none"})`);
    }
    if (requester) {
      // `reserved` counts items already accepted earlier in the same batch: their records do not exist yet, so the
      // batch would otherwise validate every item against the same stale registry count and start past the cap.
      // The `<n>` in the fixed message below therefore counts running/queued children plus those already accepted
      // in this batch; the wording is a fixed contract (tests and model self-correction) and must not change.
      const running = this.countChildren(requester.id) + reserved;
      const cap = this.deps.settings().maxChildrenPerParent;
      if (!limitAllows(cap, running)) throw new Error(`you already have ${running} running or queued subagents (maxChildrenPerParent=${cap})`);
    }
  }

  /** Direct children that hold or wait for a slot. */
  private countChildren(id: string): number {
    return this.deps.registry.list().filter((r) => r.parentId === id && (r.status === "running" || r.status === "queued")).length;
  }

  /**
   * Gives every item/step its effective parent. The top-level `parentId` only ever comes from the trusted delegation
   * path, so when it is present it wins outright over a `parentId` the item itself carries: `SubagentsParams` never
   * declares the field, and a stray copy must neither re-attribute the run nor lift the delegating agent's
   * depth/whitelist/child-cap policy. Without a top-level parent the item's own id is kept (internal callers may
   * declare one) and validated fail-closed by `requesterFor()` before anything is created.
   */
  private inheritParent<T extends { parentId?: string }>(items: readonly T[], parentId: string | undefined): T[] {
    if (!parentId) return [...items];
    return items.map((item) => ({ ...item, parentId }));
  }

  /** Fail closed: an explicitly named parent with no record must never fall back to the main-session policy. */
  private requireParent(id: string): SubagentRecord {
    const record = this.deps.registry.get(id);
    if (!record) throw new Error(`unknown parent subagent "${id}"`);
    return record;
  }

  /** The record a request is attributed to, or undefined for the main session (depth 0, no whitelist). */
  private requesterFor(parentId: string | undefined): SubagentRecord | undefined {
    return parentId === undefined ? undefined : this.requireParent(parentId);
  }

  /** The direct children of a record, in creation order. */
  private directChildren(id: string): SubagentRecord[] {
    return this.deps.registry.list().filter((r) => r.parentId === id);
  }

  /** One segment of a `父/子` path below a known parent: a direct child matched by handle or by record id. */
  // TODO(addressing): wildcard paths like @*/scout and cross-parent fuzzy matching are explicitly out of scope
  // (plan 6.9 decision 7).
  private childBySegment(parent: SubagentRecord, segment: string): SubagentRecord | undefined {
    return this.directChildren(parent.id).find((r) => r.id === segment || r.handle === segment.toLowerCase());
  }

  /** Every descendant of a record, nearest first. */
  descendants(id: string): SubagentRecord[] {
    const out: SubagentRecord[] = [];
    // `visited` guards a corrupt registry (a parentId cycle): a cycle would otherwise recurse until the stack blows.
    const visited = new Set<string>([id]);
    const walk = (parentId: string) => {
      for (const r of this.deps.registry.list()) {
        if (r.parentId !== parentId || visited.has(r.id)) continue;
        visited.add(r.id);
        out.push(r);
        walk(r.id);
      }
    };
    walk(id);
    return out;
  }

  /** Usage of every descendant, recursively (the record's own usage is not included). */
  subtreeUsage(id: string): Usage {
    return this.descendants(id).reduce((acc, r) => addUsage(acc, r.usage), { ...ZERO_USAGE });
  }

  /**
   * Resolves a delegated `handle` against the delegating record's own subtree. This is deliberately narrower than
   * `requireRecord`: a handle or path that does not exist and one that exists in another tree are refused with the
   * same text, which names only the requested value and never the global inventory (plan 6.9 item 7, REVIEW-026).
   * A single segment resolves anywhere in the subtree, matching `Registry.resolve`; a `父/子` path is relative to the
   * delegating record, so every segment must be a direct child of the previous one and the subtree gate stays the
   * only gate. The refusal text must not change: it must never list parents, siblings or the global `Known:` set.
   */
  private resolveOwnedRecord(parent: SubagentRecord, handle: string): SubagentRecord {
    const cleaned = handle.replace(/^@/, "");
    const segments = cleaned.split("/").filter((segment) => segment.length > 0);
    let target: SubagentRecord | undefined;
    if (segments.length > 1) {
      let current: SubagentRecord | undefined = parent;
      for (const segment of segments) {
        current = current ? this.childBySegment(current, segment) : undefined;
        if (!current) break;
      }
      target = current;
    } else {
      target = this.descendants(parent.id).find((r) => r.id === cleaned || r.handle === cleaned.toLowerCase());
    }
    if (!target) throw new Error(`@${cleaned} is not one of your subagents`);
    return target;
  }

  /**
   * Runs one delegation request coming from a child session: scope-checked against that child, and attributed to it.
   * `payload` is the raw tool input (`action`, `agent`, `task`, `handle`, ...). Called in-process by an SDK child and
   * through the mailbox by an RPC child (plan 6.9 items 1 and 2).
   */
  async delegate(parentRecordId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; details: Record<string, unknown> }> {
    // REVIEW-033: the mailbox can hand the manager arbitrary JSON, so validate the action before it reaches the
    // dispatcher (an unknown one would otherwise fall through its switch and yield a confusing TypeError).
    const action = payload?.action;
    if (typeof action !== "string" || !DELEGATION_ACTIONS.has(action)) {
      throw new Error(`unknown action ${JSON.stringify(action)}; valid actions are ${[...DELEGATION_ACTIONS].join(", ")}`);
    }
    if (!Value.Check(SubagentsParams, payload)) {
      // The mailbox can deliver any JSON, and the model-visible schema is the only shape the dispatcher understands.
      // A malformed request is refused with one controlled sentence instead of leaking a TypeError (REVIEW-037).
      throw new Error("invalid delegation request");
    }
    const parent = this.deps.registry.get(parentRecordId);
    if (!parent) throw new Error(`unknown parent subagent ${parentRecordId}`);
    // A foreground delegation of a spawning action blocks the parent until its child returns, so the parent gives up
    // its scheduler slot for the wait: with maxConcurrent 1 the child (or a parallel/chain item) could otherwise never
    // start, because the only slot would stay with the parent that is waiting for it. A background delegation never
    // blocks, and so do `list`/`steer`/`interrupt`/`stop`, which return without a child run (REVIEW-049).
    const live = this.live.get(parent.id);
    const yields = live !== undefined && payload.background !== true && YIELDING_DELEGATION_ACTIONS.has(action);
    if (yields && live) {
      // Concurrent delegations share one yielded grant: only the first releases it (0 -> 1 in flight) and only the
      // last takes it back (1 -> 0). Each one releasing and re-acquiring its own grant would queue the losers behind
      // a sibling that only the parent's own `execute` finally can release, deadlocking both (REVIEW-046).
      if ((live.yielding ?? 0) === 0) {
        live.release?.();
        live.release = undefined;
        this.evictIdle();
      }
      live.yielding = (live.yielding ?? 0) + 1;
    }
    try {
      return await this.delegateInner(parent, payload, signal);
    } finally {
      if (yields && live) {
        const remaining = (live.yielding ?? 1) - 1;
        live.yielding = remaining;
        // Only the last in-flight delegation re-acquires the shared grant; an earlier one leaves it to the child that
        // holds it, so it can never queue behind its own sibling.
        if (remaining === 0) {
          let again: (() => void) | undefined;
          try {
            again = await this.deps.scheduler.acquire(signal);
          } catch {
            // The run was aborted or the manager shut down while waiting; `execute` owns the original release and the
            // scheduler makes releasing an already-released slot a no-op.
          }
          if (again) {
            // The parent may have finished while this delegation was in flight (its own `finally` already released);
            // never keep the slot we just took for a run that no longer exists.
            if (this.live.get(parent.id) === live) live.release = again;
            else again();
          }
        }
      }
    }
  }

  /** Dispatches one validated delegation request for `parent`; `delegate` owns the parent's scheduler slot around it. */
  private async delegateInner(parent: SubagentRecord, payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; details: Record<string, unknown> }> {
    // `SubagentsParams` never declares the internal delegation fields, so a stray copy must not reach the dispatcher
    // as if the trusted path had set it: these methods apply the real parent themselves (see `inheritParent`).
    const rest: Record<string, unknown> = { ...payload };
    delete rest.parentId;
    delete rest.depth;
    // A stray `detach` from the mailbox must not be trusted: the flag is derived below from the validated background
    // field so only the real delegation path can turn a run into fire-and-forget (LATENT-046-BG).
    delete rest.detach;
    const input = rest as SubagentsInput;
    // A background action a child asked for is fire-and-forget: mark it so run/resume never block on a scheduler slot
    // their own parent holds. Derived from the validated `background` field, never taken from the mailbox payload.
    const detach = payload.background === true;
    if (input.action === "list") {
      // A child sees only its own subtree: never its parent, its siblings, or its parent's other branches.
      const records = this.descendants(parent.id);
      const ids = new Set(records.map((r) => r.id));
      const chains = this.listChains().filter((c) => c.stepRecordIds.some((id) => ids.has(id)));
      return { text: renderTree(records, "list", chains), details: { count: records.length } };
    }
    const scoped: DispatchInput = { ...input };
    if (input.handle) {
      // Resolve inside the delegating child's own subtree only. `requireRecord` must NOT be used here: its miss text
      // enumerates every global handle, which would hand a child its ancestors' and siblings' handles (REVIEW-026,
      // plan 6.9 item 7). Existence and ownership collapse into one refusal so a foreign handle leaks nothing.
      const target = this.resolveOwnedRecord(parent, input.handle);
      // Carry the record id on: it resolves back to the same record, and a later record cannot take the name over.
      scoped.handle = target.id;
    }
    if (input.action === "run" || input.action === "parallel" || input.action === "chain") {
      // Only spawning actions create records, so only they need the parent; resume/continue/steer/interrupt/stop act
      // on a record that already exists.
      return executeAction(this, { ...scoped, parentId: parent.id, depth: parent.depth + 1, ...(detach ? { detach: true } : {}) }, signal, noCascade);
    }
    return executeAction(this, { ...scoped, ...(detach ? { detach: true } : {}) }, signal, noCascade);
  }

  /**
   * The delegation a child session of this record gets (M6 nesting), or undefined when the session has no mailbox
   * (nesting is gated on `deps.mailboxDir`). `recordId` becomes the parent of anything the child spawns, `depth` is
   * the child's own depth, and `canDelegate` is recomputed now so a resume after a settings change never keeps a
   * stale answer. Every path that opens a child session (launch, and resume — which `continueChainLoop` uses to
   * reopen the stopped step) must pass this, or a resumed child silently loses its proxy tool.
   */
  private delegationSpecFor(record: SubagentRecord): ChildDelegation | undefined {
    const mailboxDir = this.deps.mailboxDir;
    if (!mailboxDir) return undefined;
    return { recordId: record.id, depth: record.depth, canDelegate: this.delegationFor(record).canDelegate, mailboxDir };
  }

  /** Starts the mailbox poller while at least one child session may delegate. */
  private ensureMailbox(): void {
    const dir = this.deps.mailboxDir;
    if (!dir || this.mailbox) return;
    // The handler is the same `delegate` the in-process SDK host calls, so both transports enforce identical scope.
    this.mailbox = new MailboxServer(dir, (req) => this.delegate(req.parentRecordId, req.payload).then((out) => ({ id: req.id, parentRecordId: req.parentRecordId, ok: true, text: out.text, details: out.details })), {
      // Mailbox failures (a response that could not be written, an unreadable directory) are surfaced through the
      // manager's existing delivery-error channel instead of disappearing (REVIEW-038).
      onError: (info) => this.reportMailboxError(info),
    });
    this.mailbox.start();
  }

  /** Maps a mailbox failure onto the child that asked for it, with the manager's existing notifier (REVIEW-038). */
  private reportMailboxError(info: MailboxErrorInfo): void {
    const record = info.parentRecordId ? this.deps.registry.get(info.parentRecordId) : undefined;
    if (!record) return;
    try {
      this.deps.onDeliveryError?.(record, `mailbox: ${info.message}`);
    } catch {
      // The notifier must never turn a mailbox failure into an unhandled rejection.
    }
  }

  /** Stops the mailbox poller once no child can ask any more (or the manager shut down). */
  private maybeStopMailbox(): void {
    if (!this.mailbox) return;
    // A closed manager can never serve another request; otherwise keep polling while any child is live, claiming or queued.
    if (!this.closed && (this.live.size || this.claims.size || this.queued.size)) return;
    this.mailbox.stop();
    this.mailbox = undefined;
  }

  /** Resolves a run's working directory; the main cwd when omitted. Absolute inputs are normalized too, so equivalent paths compare equal. */
  resolveCwd(cwd: string | undefined): string {
    if (!cwd) return this.deps.cwd;
    const resolved = resolve(this.deps.cwd, cwd);
    try {
      if (statSync(resolved).isDirectory()) return resolved;
    } catch (error) {
      // Only a missing path is "does not exist"; surface other causes (permissions and so on) with their reason.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new SubagentError("missing_cwd", `cannot access working directory ${resolved}: ${code ?? String(error)}`);
      }
    }
    throw new SubagentError("missing_cwd", `working directory does not exist: ${resolved}`);
  }

  /** Records with a live child or a pending resume claim; these must survive a branch switch. */
  activeRecords(): SubagentRecord[] {
    const ids = new Set([...this.live.keys(), ...this.claims.keys(), ...this.queued.keys()]);
    return [...ids].map((id) => this.deps.registry.get(id)).filter((r): r is SubagentRecord => r !== undefined);
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const requester = this.requesterFor(req.parentId);
    const resolved = this.resolveTarget(req, "run", requester);
    const prepared = this.prepare(resolved, req);
    return this.launch(prepared, req.background ?? false, req.signal, {
      ...(req.receiverContextWindow ? { receiverContextWindow: req.receiverContextWindow } : {}),
      ...(req.ask ? { asks: [this.ask("ask", req.ask)] } : {}),
      ...(req.detach ? { detach: true } : {}),
    });
  }

  /** Validates the request and creates the queued record (so it is listed and cancellable from the start). */
  private prepare(
    resolved: Resolved,
    req: { delivery?: DeliveryMode; chainId?: string; stepIndex?: number; parentId?: string },
  ): Prepared {
    if (this.closed) throw shutDownError();
    if (this.deps.scheduler.disabled) throw new SubagentsDisabledError();
    const { agent, runner, cwd, trusted, entry } = resolved;
    // A record's depth is always derived from its parent: the main session's subagents are depth 1. A `depth` passed
    // by the caller is informational only (a node with no parent is a root, whatever the caller claimed).
    // Fail closed again here (the callers already validated it): a parent that vanished between validation and
    // creation must not silently turn into a root run under the main session's policy.
    const parent = req.parentId ? this.requireParent(req.parentId) : undefined;
    const depth = parent ? parent.depth + 1 : 1;
    // Runs started by the main agent's tool are always auto; `delivery` is only passed by internal callers.
    const delivery = req.delivery ?? "auto";
    // The record exists from the start so a run waiting for a slot is listed and can be cancelled by handle.
    const record = this.deps.registry.create({
      agent: agent.name,
      preferredHandle: entry.kind === "agent" ? agent.handle ?? agent.name : entry.name,
      runner: runner.kind,
      depth,
      ...(parent ? { parentId: parent.id } : {}),
      sessionFile: "",
      delivery,
      task: entry.prompt,
      cwd,
      status: "queued",
      ...(entry.kind === "agent" ? {} : { entry: { kind: entry.kind, name: entry.name } }),
      ...(req.chainId ? { chainId: req.chainId, stepIndex: req.stepIndex ?? 0 } : {}),
    });
    try {
      this.deps.onRecordCreated?.(record);
    } catch {
      // Informational only.
    }
    const controller = new AbortController();
    this.queued.set(record.id, controller);
    return { record, agent, runner, cwd, trusted, controller, prompt: entry.prompt };
  }

  /**
   * Starts a run: waits for a slot, opens the child, then runs one turn. A background run that a subagent asked for
   * (options.detach) returns its queued handle at once when no slot is free and finishes starting in a detached task:
   * the delegating tool call would otherwise block the very slot its parent holds, and with maxConcurrent 1 the child
   * could never take it (LATENT-046-BG). The parent keeps its slot (plan 6.9 decision 6: a background delegation never
   * yields); the child simply queues behind it, exactly as decision 6 intends.
   */
  private async launch(prepared: Prepared, background: boolean, signal: AbortSignal | undefined, options: LaunchOptions = {}): Promise<RunOutcome> {
    if (background && options.detach && !this.deps.scheduler.hasCapacity()) {
      // `launchWithSlot` registers its waiter synchronously, so by the time this returns the record is queued and
      // `scheduler.queued` already reflects it. `track` keeps whenIdle() and shutdown() aware of the detached start.
      this.track(this.launchWithSlot(prepared, background, signal, options));
      return { record: prepared.record };
    }
    return this.launchWithSlot(prepared, background, signal, options);
  }

  /** The launch body after the detach decision: waits for a slot, opens the child, then runs one turn. */
  private async launchWithSlot(prepared: Prepared, background: boolean, signal: AbortSignal | undefined, options: LaunchOptions = {}): Promise<RunOutcome> {
    const { record, agent, runner, cwd, trusted, controller } = prepared;
    const cancel = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    let release: () => void;
    try {
      release = await this.deps.scheduler.acquire(cancel);
    } catch (error) {
      this.queued.delete(record.id);
      // This run never started a poller of its own, but it was keeping an earlier run's poller alive: with it gone,
      // the mailbox must stop once nothing else can ask (REVIEW-043).
      this.maybeStopMailbox();
      throw this.settleQueued(record.id, error, signal);
    }
    let delegation: ChildDelegation | undefined;
    let session: ChildSession;
    try {
      // A child of a session that has a mailbox may delegate: the runner turns this into the in-process proxy
      // extension (SDK) or `-ne -e <this extension>` plus the PI_SUBAGENTS_* env (RPC). `delegationFor` decides
      // whether the child gets the tool at all (depth/permission); the manager remains the only authority.
      delegation = this.delegationSpecFor(record);
      session = await runner.open({
        agent,
        cwd,
        sessionDir: this.deps.sessionDir,
        ...(trusted !== undefined ? { projectTrusted: trusted } : {}),
        appendSystemPrompt: [agent.systemPrompt, SUMMARY_INSTRUCTION].filter(Boolean),
        ...(delegation ? { delegation } : {}),
      });
    } catch (error) {
      this.queued.delete(record.id);
      release();
      this.maybeStopMailbox();
      throw this.settleQueued(record.id, error, signal);
    }
    this.queued.delete(record.id);
    if (this.closed || controller.signal.aborted || signal?.aborted) {
      // Shutdown, a cancel by handle, or the calling tool's abort happened while the session was opening.
      release();
      this.maybeStopMailbox();
      await this.close(record.id, session);
      throw this.settleQueued(record.id, this.closed ? shutDownError() : runInterruptedError(), signal);
    }
    // Started only once the session is genuinely opening a turn: a failed open above must not leave a poller behind.
    if (delegation?.canDelegate) {
      try {
        this.ensureMailbox();
      } catch (error) {
        // `mailboxDir` could not be created (a plain file, permissions). Failing through the normal path releases the
        // scheduler slot, closes the child session and settles the record, so nothing stays queued (REVIEW-036).
        this.maybeStopMailbox();
        release();
        await this.close(record.id, session);
        throw this.settleQueued(record.id, error, signal);
      }
    }
    const running = this.deps.registry.update(record.id, { status: "running", sessionFile: session.sessionFile });
    return this.execute(running, session, prepared.prompt, release, background, signal, options.asks ?? [], options);
  }

  /** Starts every task at once (the scheduler still caps concurrency) and summarizes the group afterwards. */
  async runParallel(req: { items: readonly BatchItem[]; parentId?: string; background?: boolean; signal?: AbortSignal }): Promise<BatchOutcome> {
    if (this.closed) throw shutDownError();
    // A nested batch names its parent once at the top; each item inherits it unless it names one itself.
    const items = this.inheritParent(req.items, req.parentId);
    if (items.length === 0) throw new Error("a parallel batch needs at least one item");
    const max = this.deps.settings().maxParallelTasks;
    if (max === 0) throw new SubagentsDisabledError("parallel is disabled (maxParallelTasks is 0)");
    // The n-th task is allowed exactly when the previous n - 1 are within the limit (max -1 = unlimited).
    if (!limitAllows(max, items.length - 1)) throw new Error(`too many parallel tasks (${items.length}); max is ${max}`);
    // Validate every entry, runner and cwd up front, before any record exists: a bad item must not leave a half-created
    // batch behind (a queued record whose launch() is never reached would stay queued forever). Items targeting the
    // same parent also count against maxChildrenPerParent as a group, not one at a time (see `assertCanSpawn`).
    const reserved = new Map<string, number>();
    const targets = items.map((item) => {
      const requester = this.requesterFor(item.parentId);
      const held = requester ? reserved.get(requester.id) ?? 0 : 0;
      const resolved = this.resolveTarget(item, "parallel", requester, held);
      // Only an accepted item reserves a slot, so a rejected batch never counts toward the next one.
      if (requester) reserved.set(requester.id, held + 1);
      return resolved;
    });
    const prepared = items.map((item, i) => this.prepare(targets[i]!, { ...(item.parentId ? { parentId: item.parentId } : {}) }));
    // One item failing to start (runner.open, a cancel while queued/opening, shutdown) must not drop the others' results.
    const settled = Promise.allSettled(prepared.map((p) => this.launch(p, true, req.signal, { mode: "batch" })));
    const outcomes = settled.then((results) => results.map((result, i) => (result.status === "fulfilled" ? result.value : this.failureOutcome(prepared[i]!.record))));
    if (!req.background) {
      const done = await outcomes;
      return { records: done.map((o) => o.record), payload: this.parallelPayload(done) };
    }
    // The records already exist, so the tool can report the handles now; one summary is delivered when all finish.
    this.track(
      outcomes.then((done) => this.sendBatch("parallel", this.parallelPayload(done), done.map((o) => o.record))),
      (error) => this.reportBatchError(prepared[0]?.record, error),
    );
    return { records: prepared.map((p) => p.record) };
  }

  /** Runs the steps one after another; a failing, interrupted or stopped step stops the chain and can be continued later. */
  async runChain(req: { steps: readonly BatchItem[]; parentId?: string; background?: boolean; signal?: AbortSignal }): Promise<BatchOutcome> {
    if (this.closed) throw shutDownError();
    // A nested chain names its parent once at the top; each step inherits it unless it names one itself.
    const steps = this.inheritParent(req.steps, req.parentId);
    if (steps.length === 0) throw new Error("a chain needs at least one step");
    const max = this.deps.settings().maxChainSteps;
    if (max === 0) throw new SubagentsDisabledError("chains are disabled (maxChainSteps is 0)");
    if (!limitAllows(max, steps.length - 1)) throw new Error(`too many chain steps (${steps.length}); max is ${max}`);
    // Refuse before the chain exists when the scheduler is disabled (maxConcurrent 0): prepare() would throw
    // afterwards and leave a chain stuck in "running" with no step records and no way to continue it.
    if (this.deps.scheduler.disabled) throw new SubagentsDisabledError();
    // Validate every step's entry, runner and cwd before the chain exists, so a typo cannot leave a half-run chain behind.
    // Only the first step's task is fully known up front (`{previous}` is empty there); the rest are validated as they
    // run, and a later step that becomes empty after substitution fails the chain as usual.
    steps.forEach((step, i) => {
      const task = i === 0 ? substitutePrevious(step.task ?? "", "") : step.task;
      this.resolveTarget({ ...entryFields(step), ...(task === undefined ? {} : { task }) }, "chain", this.requesterFor(step.parentId));
    });
    const chain = this.deps.chainStore.create({
      // Keep the entry kind of every step (skill / command steps have no base agent) so reload and continue can replay it.
      steps: steps.map((s) => ({ ...entryFields(s), task: s.task ?? "" })),
    });
    // Each step keeps its own effective parent (a top-level delegation parent wins; otherwise the step's own id),
    // matching `runParallel`'s per-item attribution instead of pinning the whole chain to the first step's parent.
    // `chainStore` does not persist `parentId`, so the original `steps` array is the only source here; a continued
    // chain falls back to the resumed record's parent instead (see `continueChainLoop`).
    const parentOf = (index: number): string | undefined => steps[index]?.parentId;
    if (!req.background) return this.runChainLoop(chain, 0, "", req.signal, [], parentOf);
    this.track(
      this.runChainLoop(chain, 0, "", req.signal, [], parentOf).then((outcome) => {
        this.sendBatch("chain", outcome.payload!, outcome.records, outcome.chain);
      }),
      (error) => this.reportBatchError(this.firstChainRecord(chain.id), error),
    );
    return { records: [], chain };
  }

  /** Continues the chain that stopped at the step behind `handle`: resumes that step, then runs the remaining ones. */
  async continueChain(handle: string, message?: string, opts: { background?: boolean; signal?: AbortSignal } = {}): Promise<BatchOutcome> {
    if (this.closed) throw shutDownError();
    const record = this.requireRecord(handle);
    const chain = record.chainId ? this.deps.chainStore.get(record.chainId) : undefined;
    if (!chain) throw new SubagentError("unknown_handle", `@${record.handle} is not part of a chain`);
    if (chain.status === "stopped") throw new SubagentError("stopped", `chain ${chain.id} was stopped and cannot be continued`);
    if (chain.status === "running") throw new SubagentError("busy", `chain ${chain.id} is still running`);
    if (chain.status === "completed") throw new SubagentError("not_running", `chain ${chain.id} already finished`);
    const index = record.stepIndex ?? chain.currentStep;
    if (index !== chain.currentStep) {
      throw new SubagentError(
        "not_running",
        `@${record.handle} is step ${index + 1} of chain ${chain.id}, which stopped at step ${chain.currentStep + 1}`,
      );
    }
    // Validate the remaining steps before resuming, so a bad step cannot leave the chain half-advanced.
    // `chainStore` does not persist a step's `parentId`, so the steps left in a continued chain can only inherit the
    // resumed record's parent (the chain's original requester); an unknown one fails closed instead of becoming root.
    for (let i = index + 1; i < chain.steps.length; i++) {
      this.resolveTarget(chain.steps[i]!, "chain", this.requesterFor(record.parentId));
    }
    if (!opts.background) return this.continueChainLoop(chain, record, index, message, opts.signal, record.parentId);
    this.track(
      this.continueChainLoop(chain, record, index, message, opts.signal, record.parentId).then((outcome) => {
        this.sendBatch("chain", outcome.payload!, outcome.records, outcome.chain);
      }),
      (error) => this.reportBatchError(this.firstChainRecord(chain.id), error),
    );
    return { records: [], chain };
  }

  /** Chains that still have a live or queued run (those must survive a branch switch). */
  activeChains(): ChainRecord[] {
    const ids = new Set<string>();
    for (const r of this.activeRecords()) if (r.chainId) ids.add(r.chainId);
    return [...ids].map((id) => this.deps.chainStore.get(id)).filter((c): c is ChainRecord => !!c);
  }

  private async continueChainLoop(
    chain: ChainRecord,
    record: SubagentRecord,
    index: number,
    message: string | undefined,
    signal: AbortSignal | undefined,
    parentId?: string,
  ): Promise<BatchOutcome> {
    // The process can die between a step finishing and the chain advancing: that step must not run a second time.
    if (record.status === "completed") {
      const current = this.deps.chainStore.update(chain.id, { status: "running", usage: this.chainUsage(chain) });
      const rest = await this.runChainLoop(current, index + 1, record.lastSummary ?? "", signal, [{ record }], () => parentId);
      return { records: rest.records, payload: rest.payload, chain: rest.chain };
    }
    // Resume the step that stopped the chain so it keeps its own session, then run the remaining steps.
    const receiver = this.chainReceiverWindow(chain, index);
    const resumed = await this.resume(record.handle, message ?? record.task, {
      background: true,
      ...(signal ? { signal } : {}),
      mode: "batch",
      ...(receiver ? { receiverContextWindow: receiver } : {}),
    });
    if (resumed.record.status !== "completed") {
      const stopped = this.deps.chainStore.update(chain.id, { status: chainStatusOf(resumed.record.status), usage: this.chainUsage(chain) });
      return { records: [resumed.record], payload: this.chainPayload(stopped, [resumed]), chain: stopped };
    }
    // The resumed step keeps its record id, so the chain usage stays the sum of every started step's record.
    const current = this.deps.chainStore.update(chain.id, { status: "running", usage: this.chainUsage(chain) });
    const rest = await this.runChainLoop(current, index + 1, resumed.payload?.text ?? "", signal, [resumed], () => parentId);
    // `runChainLoop` already carries the resumed outcome, so its records and payload span the whole chain.
    return { records: rest.records, payload: rest.payload, chain: rest.chain };
  }

  private async runChainLoop(
    chain: ChainRecord,
    from: number,
    previous: string,
    signal: AbortSignal | undefined,
    outcomes: RunOutcome[] = [],
    parentOf: (index: number) => string | undefined = () => undefined,
  ): Promise<BatchOutcome> {
    let current = chain;
    for (let i = from; i < chain.steps.length; i++) {
      const step = chain.steps[i]!;
      // `{previous}` only affects the task text; the entry kind and name were already validated before the chain existed.
      const task = substitutePrevious(step.task ?? "", previous);
      let prepared: Prepared;
      try {
        // Re-resolve with the substituted task: the chain stores the original template, but the child must get the
        // substituted text. Name validation repeats here; a skill removed mid-chain settles the chain instead of
        // leaving it running (the catch below).
        // Each step resolves its own effective parent so nested chain steps stay attributed to the delegating
        // subagent; `parentOf` wins the trusted top-level parent over a step's own id (REVIEW-010) and fails closed
        // on an unknown id. The chain's own `chain.steps` cannot carry it (not persisted), so `parentOf` indexes the
        // original in-memory step list.
        const parentId = parentOf(i);
        const requester = this.requesterFor(parentId);
        prepared = this.prepare(this.resolveTarget({ ...entryFields(step), task }, "chain", requester), {
          chainId: chain.id,
          stepIndex: i,
          ...(parentId ? { parentId } : {}),
        });
      } catch (error) {
        // prepare() can only fail before the step's record exists (shutdown or disabled between steps). Never leave
        // the chain stuck in "running": settle it to stopped/failed and let the caller or the background error path
        // surface the failure (firstChainRecord is then defined whenever any earlier step had started).
        this.deps.chainStore.update(chain.id, { status: this.closed ? "stopped" : "failed", usage: this.chainUsage(current) });
        throw error;
      }
      current = this.deps.chainStore.update(chain.id, { currentStep: i, status: "running", stepRecordIds: [...current.stepRecordIds, prepared.record.id] });
      const receiver = this.chainReceiverWindow(chain, i);
      let outcome: RunOutcome;
      try {
        outcome = await this.launch(prepared, true, signal, { mode: "batch", ...(receiver ? { receiverContextWindow: receiver } : {}) });
      } catch (error) {
        // The run was cancelled or its session could not open; the record already says why.
        const failed = this.deps.registry.get(prepared.record.id) ?? prepared.record;
        outcomes.push({ record: failed });
        const stopped = this.deps.chainStore.update(chain.id, { status: chainStatusOf(failed.status), usage: this.chainUsage(current) });
        return { records: outcomes.map((o) => o.record), payload: this.chainPayload(stopped, outcomes), chain: stopped };
      }
      outcomes.push(outcome);
      current = this.deps.chainStore.update(chain.id, { usage: this.chainUsage(current) });
      if (outcome.record.status !== "completed") {
        const stopped = this.deps.chainStore.update(chain.id, { status: chainStatusOf(outcome.record.status) });
        return { records: outcomes.map((o) => o.record), payload: this.chainPayload(stopped, outcomes), chain: stopped };
      }
      previous = outcome.payload?.text ?? "";
    }
    const done = this.deps.chainStore.update(chain.id, { status: "completed", usage: this.chainUsage(current) });
    return { records: outcomes.map((o) => o.record), payload: this.chainPayload(done, outcomes), chain: done };
  }

  /** The window of whoever receives a step's output: the next step's agent, or the main session for the last step. */
  private chainReceiverWindow(chain: ChainRecord, index: number): number | undefined {
    // A skill or command step has no base agent, so it falls back to the main session's window.
    const name = chain.steps[index + 1]?.agent;
    const next = name ? this.deps.agents().get(name) : undefined;
    return next ? this.deps.receiverContextWindowFor?.(next) : undefined;
  }

  /** The first step record of a chain, for reporting a detached failure; undefined before the first step starts. */
  private firstChainRecord(chainId: string): SubagentRecord | undefined {
    const first = this.deps.chainStore.get(chainId)?.stepRecordIds[0];
    return first ? this.deps.registry.get(first) : undefined;
  }

  /**
   * The chain's total usage, recomputed from its started step records. A resumed step keeps its record id and its
   * usage is cumulative, so summing `chain.usage` again would double-count it; deriving the total from the registry
   * keeps `chain.usage` equal to the sum of every started step's record usage.
   */
  private chainUsage(chain: ChainRecord): Usage {
    let total: Usage = { ...ZERO_USAGE };
    for (const id of chain.stepRecordIds) {
      const record = this.deps.registry.get(id);
      if (record) total = addUsage(total, record.usage);
    }
    return total;
  }

  /** One summary for a chain: a head line, a section per step, then the last step's output. */
  private chainPayload(chain: ChainRecord, outcomes: readonly RunOutcome[]): Payload {
    // Count every step the chain has started (not just this call's outcomes), so a continued chain still reports 3/3.
    const head = `Chain ${chain.status} (${chain.stepRecordIds.length}/${chain.steps.length} steps)`;
    const sections = outcomes.map((o) => {
      const r = o.record;
      const step = `step ${(r.stepIndex ?? 0) + 1}`;
      return `### [@${r.handle}] (${recordEntryLabel(r)}) ${step} ${r.status}${r.error ? `: ${r.error}` : ""}\n${r.lastSummary ?? ""}\nSession: ${r.sessionFile}`;
    });
    const last = outcomes.at(-1)?.payload?.text ?? "";
    return { text: `${head}\n\n${sections.join("\n\n")}${last ? `\n\n${last}` : ""}`, summary: head };
  }

  /** A rejected batch item is reported like finish() reports a failed run, using the status settleQueued already stored. */
  private failureOutcome(record: SubagentRecord): RunOutcome {
    const current = this.deps.registry.get(record.id) ?? record;
    const note = `@${current.handle} ${current.status}${current.error ? `: ${current.error}` : ""}`;
    return { record: current, payload: { text: note, summary: note } };
  }

  /** One summary for a whole group: `Parallel: X/N succeeded` plus a section per item. */
  private parallelPayload(outcomes: readonly RunOutcome[]): Payload {
    const window = this.deps.receiverContextWindow();
    const ratio = this.deps.settings().contextRatio;
    const texts = outcomes.map((o) => o.payload?.text ?? "");
    const inline = texts.reduce((n, t) => n + estimateTokens(t), 0) <= window * ratio;
    const sections = outcomes.map((o, i) => {
      const r = o.record;
      const head = `### [@${r.handle}] (${recordEntryLabel(r)}) ${r.status}${r.error ? `: ${r.error}` : ""}`;
      let body = texts[i] ?? "";
      if (!inline && body && !o.payload?.filePath) {
        const file = writeOutput(body, { outputDir: this.deps.outputDir, label: `${r.handle}-run${r.runId}` });
        body = `Summary:\n${r.lastSummary ?? ""}\n\nFull output: ${file}`;
      }
      return `${head}\n${body}${body ? "\n" : ""}Session: ${r.sessionFile}`;
    });
    const succeeded = outcomes.filter((o) => o.record.status === "completed").length;
    const head = `Parallel: ${succeeded}/${outcomes.length} succeeded`;
    return { text: `${head}\n\n${sections.join("\n\n---\n\n")}`, summary: head };
  }

  /** One auto message per batch, only when it carries something the main agent can use. */
  private sendBatch(kind: "parallel" | "chain", payload: Payload, records: readonly SubagentRecord[], chain?: ChainRecord): void {
    if (this.closed) return;
    if (!records.some((r) => r.status === "completed" || r.status === "failed")) return;
    // A nested background group belongs to the delegating subagent, never to the main session (plan 6.9 decision 9:
    // a result only ever goes to the direct parent). Only a group whose records all share one existing parent is
    // rerouted; a mixed or parentless batch keeps the existing main-session delivery. A batch record never delivers
    // on its own (`finish` skips batch mode), so this group summary is the single delivery.
    const parent = this.sharedParent(records);
    if (parent) {
      const head = records.find((r) => r.status === "completed") ?? records[0]!;
      this.routeToParent(parent, {
        fromId: head.id,
        handle: head.handle,
        summary: payload.text,
        sessionFile: head.sessionFile,
        ...(payload.filePath ? { filePath: payload.filePath } : {}),
        at: this.now(),
      });
      return;
    }
    deliverBatch(this.deps.port, {
      text: payload.text,
      details: { kind, ...(chain ? { chainId: chain.id, status: chain.status } : {}), handles: records.map((r) => r.handle) },
    });
  }

  /** The one parent every record belongs to, or undefined (no parent, mixed parents, or a parent that vanished). */
  private sharedParent(records: readonly SubagentRecord[]): SubagentRecord | undefined {
    const parentId = records[0]?.parentId;
    if (!parentId || !records.every((r) => r.parentId === parentId)) return undefined;
    return this.deps.registry.get(parentId);
  }

  /** Resolves a run's entry, agent, runner and cwd without creating a record, so a whole batch can be validated first. */
  private resolveTarget(req: EntryRequest & { cwd?: string }, action: string, requester?: SubagentRecord, reserved = 0): Resolved {
    const entry = parseEntryRequest(req, action);
    const cwd = this.resolveCwd(req.cwd);
    // The spawn policy is checked before name validation: a whitelist rejection must not depend on whether the target
    // exists, and a restricted child must not get discovery results it is not allowed to use.
    this.assertCanSpawn(requester, entry, reserved);
    if (entry.kind !== "agent") {
      validateEntryTarget(entry, { cwd, agentDir: this.deps.agentDir, agents: this.deps.agents() });
    }
    const agent = entry.kind === "agent" ? this.requireAgent(entry.name) : BUILTIN_ENTRY_AGENT_DEF;
    const runner = this.requireRunner(agent.runner ?? this.deps.settings().defaultRunner);
    return { entry, agent, runner, cwd, trusted: this.deps.trustForCwd?.(cwd) };
  }

  /** Runs a promise in the background and keeps whenIdle()/shutdown() waiting for it. `onError` makes a detached failure visible. */
  private track(job: Promise<unknown>, onError?: (error: unknown) => void): void {
    this.work.add(job);
    void job
      .catch((error) => {
        try {
          onError?.(error);
        } catch {
          // Reporting must never surface as an unhandled rejection.
        }
      })
      .finally(() => this.work.delete(job));
  }

  /** A background batch failing after its handles were returned must not disappear: surface it like a delivery failure. */
  private reportBatchError(record: SubagentRecord | undefined, error: unknown): void {
    if (!record) return;
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.deps.onDeliveryError?.(this.deps.registry.get(record.id) ?? record, message);
    } catch {
      // The notifier must never turn a finished batch into a rejected background job.
    }
  }

  async resume(
    handle: string,
    userMessage: string,
    opts: { delivery?: DeliveryMode; background?: boolean; signal?: AbortSignal; mention?: boolean; receiverContextWindow?: number; mode?: "single" | "batch"; detach?: boolean } = {},
  ): Promise<RunOutcome> {
    const { record, agent, runner, cwd } = this.preflight(handle);
    // Child results that arrived while this record was paused are handed to the model before the user's message.
    const pendingResults = record.pending ?? [];
    const message = pendingResults.length ? `${this.childResultsText(record, pendingResults)}\n\n${userMessage}` : userMessage;
    const trusted = this.deps.trustForCwd?.(cwd);
    // Snapshot taken before the claim so a failed resume can be rolled back fully.
    const previous: { status: RunStatus; runId: number; delivery: DeliveryMode; error: string | undefined } = {
      status: record.status,
      runId: record.runId,
      delivery: record.delivery,
      error: record.error,
    };
    // Claim the record synchronously so a second resume sees "running".
    const claimed = this.deps.registry.update(record.id, {
      status: "running",
      runId: record.runId + 1,
      delivery: opts.delivery ?? record.delivery,
      error: undefined,
    });
    const claim: { intent?: "stop"; controller: AbortController } = { controller: new AbortController() };
    this.claims.set(record.id, claim);
    const signal = opts.signal;
    const abortClaim = () => claim.controller.abort();
    if (this.lifetime.signal.aborted || signal?.aborted) abortClaim();
    else {
      this.lifetime.signal.addEventListener("abort", abortClaim, { once: true });
      signal?.addEventListener("abort", abortClaim, { once: true });
    }
    const unlinkClaim = () => {
      this.lifetime.signal.removeEventListener("abort", abortClaim);
      signal?.removeEventListener("abort", abortClaim);
    };
    const interruptedWhileWaiting = () => new SubagentError("interrupted", `@${record.handle} was interrupted before it resumed`);
    const stoppedWhileWaiting = () => {
      this.markStopped(record.id);
      return new SubagentError("stopped", `@${record.handle} was stopped while waiting to resume`);
    };
    const proceed = async (): Promise<RunOutcome> => {
      let release: () => void;
      let delegation: ChildDelegation | undefined;
      let session: ChildSession;
      try {
        release = await this.deps.scheduler.acquire(claim.controller.signal);
        try {
          // A resumed child that may delegate must get its proxy tool back (REVIEW-021): recompute the delegation for
          // this record instead of dropping it, exactly as launch() does.
          delegation = this.delegationSpecFor(record);
          session =
            (await this.takeIdle(record)) ??
            // takeIdle has waited for any close of this record still in flight, so the file has no other writer.
            (await runner.open({
              agent,
              cwd,
              sessionDir: this.deps.sessionDir,
              resumeFile: record.sessionFile,
              ...(record.childLeafId ? { resumeLeafId: record.childLeafId } : {}),
              ...(trusted !== undefined ? { projectTrusted: trusted } : {}),
              appendSystemPrompt: [agent.systemPrompt, SUMMARY_INSTRUCTION].filter(Boolean),
              ...(delegation ? { delegation } : {}),
            }));
          if (this.closed) {
            // Shutdown during open: dispose here; release and rollback run in the handlers below.
            await this.close(record.id, session);
            throw shutDownError();
          }
          if (signal?.aborted && claim.intent !== "stop") {
            // The calling tool was aborted while the session was opening; release and rollback run below.
            await this.close(record.id, session);
            throw interruptedWhileWaiting();
          }
        } catch (error) {
          release();
          throw error;
        }
      } catch (error) {
        unlinkClaim();
        this.claims.delete(record.id);
        // The claim is gone and no session was opened: stop the mailbox if this was the last thing keeping it alive
        // (REVIEW-043).
        this.maybeStopMailbox();
        if (claim.intent === "stop") throw stoppedWhileWaiting();
        this.deps.registry.update(record.id, previous);
        if (!this.closed && signal?.aborted) throw interruptedWhileWaiting();
        throw error;
      }
      unlinkClaim();
      this.claims.delete(record.id);
      if (claim.intent === "stop") {
        release();
        this.maybeStopMailbox();
        await this.close(record.id, session);
        throw stoppedWhileWaiting();
      }
      if (delegation?.canDelegate) {
        try {
          this.ensureMailbox();
        } catch (error) {
          // As in launch(): a mailbox that cannot be created must release the slot, close the session and roll the
          // record back to the status it had before this resume, never leaving it stuck running (REVIEW-036).
          this.maybeStopMailbox();
          release();
          await this.close(record.id, session);
          this.deps.registry.update(record.id, previous);
          throw error;
        }
      }
      const outcome = await this.execute(claimed, session, message, release, opts.background ?? false, signal, opts.mention ? [this.ask("ask", message)] : [], {
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.receiverContextWindow ? { receiverContextWindow: opts.receiverContextWindow } : {}),
      });
      // The queued results reached the model with this message; drop exactly those entries (a child that finished
      // while this resume waited for a slot may have queued another one, which must stay).
      if (pendingResults.length) {
        const remaining = (this.deps.registry.get(record.id)?.pending ?? []).filter((p) => !pendingResults.includes(p));
        this.deps.registry.update(record.id, { pending: remaining, pendingNotifiedAt: undefined });
      }
      return outcome;
    };
    // A background resume a subagent asked for (detach) returns the claimed handle at once when no slot is free: the
    // delegating tool call would otherwise block the very slot that parent holds (LATENT-046-BG). The synchronous
    // claim above is already visible, and the detached task waits for a slot, opens the child and settles it exactly
    // as a normal resume.
    if (opts.background && opts.detach && !this.deps.scheduler.hasCapacity()) {
      this.track(proceed());
      return { record: claimed };
    }
    return proceed();
  }

  /** The error resume() would reject with right away, if any; lets fire-and-forget callers report it immediately. */
  checkResumable(handle: string): Error | undefined {
    try {
      this.preflight(handle);
      return undefined;
    } catch (error) {
      return error as Error;
    }
  }

  async steer(
    handle: string,
    message: string,
    mode: "steer" | "followUp" = "steer",
    opts: { mention?: boolean; delivery?: DeliveryMode } = {},
  ): Promise<void> {
    const record = this.requireRecord(handle);
    if (record.status === "queued") throw new SubagentError("not_running", `@${record.handle} is queued and has not started yet`);
    const live = this.live.get(record.id);
    if (!live && this.claims.has(record.id)) {
      throw new SubagentError("busy", `@${record.handle} is waiting to resume; send the message again once it is running`);
    }
    if (!live) throw new SubagentError("not_running", `@${record.handle} is ${record.status}; use resume to continue it`);
    // Record the instruction first so a run that finishes right after the steer still quotes it.
    // The symbol applies to this instruction only: `?` keeps it out of anything the main model sees.
    const ask = opts.mention ? { ...this.ask("steer", message), ...(opts.delivery === "private" ? { private: true } : {}) } : undefined;
    if (ask) live.asks.push(ask);
    try {
      await live.session.steer(message, mode);
    } catch (error) {
      if (ask) live.asks.splice(live.asks.indexOf(ask), 1);
      throw error;
    }
  }

  /** "cancelled" when the run had not started (nothing to resume), "paused" when a running child was interrupted. */
  async interrupt(handle: string): Promise<"paused" | "cancelled"> {
    const record = this.requireRecord(handle);
    if (this.cancelQueued(record)) return "cancelled";
    const live = this.live.get(record.id);
    if (!live) throw new SubagentError("not_running", `@${record.handle} is ${record.status}`);
    live.intent = "interrupt";
    await live.session.abort();
    return "paused";
  }

  /**
   * Stops a record and every descendant. The target is marked first (which also drops the child results waiting for it,
   * plan 6.9 decision 9), then the descendant snapshot taken before any marking is stopped top-down. Every state is
   * covered (queued, claiming a resume, live, paused, completed) and stopping twice is a no-op. Unlike `interrupt`,
   * which only aborts the target's current turn, a stop ends the whole subtree.
   */
  async stop(handle: string): Promise<void> {
    const record = this.requireRecord(handle);
    // Take the snapshot before anything is marked: the cascade must still reach a descendant whose record the stop of
    // its parent could otherwise make unreachable.
    const descendants = this.descendants(record.id);
    const persistErrors: unknown[] = [];
    // A failed persist must not stop the cascade: the record is still stopped in memory and the queued/claiming run is
    // cancelled below by `stopRecord`. The first error is rethrown at the end, so a stop that could not be persisted
    // still rejects (and a cancelled run never starts, as `cancelQueued` guarantees).
    const mark = (id: string): void => {
      try {
        this.markStoppedAndDiscardPending(id);
      } catch (error) {
        persistErrors.push(error);
      }
    };
    mark(record.id);
    await this.stopRecord(record);
    for (const descendant of descendants) {
      mark(descendant.id);
      await this.stopRecord(descendant);
    }
    if (persistErrors.length) throw persistErrors[0];
  }

  /** Stops one record's own run; its descendants are the caller's concern (see `stop`). */
  private async stopRecord(record: SubagentRecord): Promise<void> {
    if (this.cancelQueued(record)) return;
    // Start closing the idle child synchronously (before any await), and return only once it has finished closing.
    const closingIdle = this.closeIdle(record.id);
    try {
      const claim = this.claims.get(record.id);
      if (claim) {
        // A resume is still waiting for a slot or a session; cancel it.
        claim.intent = "stop";
        claim.controller.abort();
        return;
      }
      const live = this.live.get(record.id);
      if (live) {
        live.intent = "stop";
        await live.session.abort();
      }
    } finally {
      await closingIdle;
    }
  }

  /** Called when the main session is shutting down or the user aborts. */
  async interruptAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((live) => ((live.intent = "interrupt"), live.session.abort())));
  }

  /** Main session is going away: cancel queued/opening run and resume calls, then interrupt live children. */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.stopPendingWatch();
    for (const claim of this.claims.values()) claim.controller.abort();
    await this.interruptAll();
    for (const id of [...this.idle.keys()]) void this.closeIdle(id);
    // Idle children and children already closing (evicted, pruned, stopped); interrupted live children close as their
    // runs end, which whenIdle() waits for.
    await Promise.all([...this.closing.values()]);
    // Shutdown is terminal: no child may ask again, so the poller stops even if a live run has not unwound yet.
    this.maybeStopMailbox();
  }

  /** After a branch switch: close idle children whose record is no longer on this branch (tracked by whenIdle/shutdown). */
  pruneIdle(): void {
    for (const id of [...this.idle.keys()]) if (!this.deps.registry.get(id)) void this.closeIdle(id);
  }

  /** After /reload, restart or a branch switch no child is live for these records; settle the ones that were cut off. */
  recoverInterrupted(reason = "interrupted by reload or restart"): number {
    let count = 0;
    for (const r of this.deps.registry.list()) {
      if (this.live.has(r.id) || this.claims.has(r.id) || this.queued.has(r.id)) continue;
      if (r.status === "running") {
        this.deps.registry.update(r.id, { status: "paused", error: reason });
        count++;
      } else if (r.status === "queued") {
        // It never got a child session, so there is nothing to resume.
        this.deps.registry.update(r.id, { status: "stopped", error: `${reason} before it started` });
        count++;
      }
    }
    return count;
  }

  /**
   * Align chain status with its step records after a reload, restart or branch switch. A chain left "running"
   * with no live, queued or claimed step (recoverInterrupted settled those) would otherwise reject `continueChain`
   * with "busy" forever, losing "continue from the stopped step". Such a chain is normalized to what its stopping
   * step left behind; chains that still have an active step are untouched. Returns how many chains were changed.
   */
  reconcileChains(): number {
    const active = new Set(this.activeRecords().map((r) => r.id));
    let count = 0;
    for (const chain of this.deps.chainStore.list()) {
      if (chain.status !== "running") continue;
      if (chain.stepRecordIds.some((id) => active.has(id))) continue;
      const records = chain.stepRecordIds.map((id) => this.deps.registry.get(id)).filter((r): r is SubagentRecord => !!r);
      // Only a chain whose every step finished is "completed". A stopping step that is itself completed (the process
      // died between steps) must not mark the whole chain finished, so it falls through to the continuable "paused".
      const stop = records.find((r) => r.stepIndex === chain.currentStep) ?? records.at(-1);
      let status: ChainStatus;
      if (records.length === chain.steps.length && records.every((r) => r.status === "completed")) status = "completed";
      else if (stop?.status === "stopped") status = "stopped";
      else if (stop?.status === "failed") status = "failed";
      else status = "paused";
      this.deps.chainStore.update(chain.id, { status, usage: this.chainUsage(chain) });
      count++;
    }
    return count;
  }

  async whenIdle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  private async execute(
    record: SubagentRecord,
    session: ChildSession,
    text: string,
    release: () => void,
    background: boolean,
    signal?: AbortSignal,
    asks: Ask[] = [],
    options: LaunchOptions = {},
  ): Promise<RunOutcome> {
    const live: Live = { session, asks: options.asks ?? asks, release };
    this.live.set(record.id, live);
    this.evictIdle();
    const batch = options.mode === "batch";
    // Only a foreground single call is still waiting on its tool signal; a background or batch call runs detached.
    const callSignal = background || batch ? undefined : signal;
    const onCallAbort = () => {
      live.intent = "interrupt";
      void session.abort().catch(() => {});
    };
    const job = (async (): Promise<RunOutcome> => {
      let result: ChildResult;
      let leafId: string | undefined;
      try {
        if (callSignal?.aborted) onCallAbort();
        else callSignal?.addEventListener("abort", onCallAbort, { once: true });
        result = await session.prompt(text);
      } catch (error) {
        result = { text: "", stopReason: "error", errorMessage: (error as Error).message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
      } finally {
        callSignal?.removeEventListener("abort", onCallAbort);
        try {
          leafId = session.leafId;
        } catch {
          // A broken session simply leaves the previous leaf in place.
        }
        this.live.delete(record.id);
        // A foreground delegation may have swapped the grant while it waited for a child (REVIEW point 5); release
        // whichever grant the parent currently holds. The scheduler makes a repeated release a no-op.
        (live.release ?? release)();
        // A child that is not kept has finished closing before the run ends, as in M2.
        await this.park(record.id, session, live);
        // The last live child of a delegating session just ended: stop polling an empty mailbox (review point 4).
        this.maybeStopMailbox();
      }
      try {
        return this.finish(record.id, result, live, background, leafId, options);
      } catch (error) {
        // Never leave the record stuck in "running" or let a background job reject.
        const message = `result handling failed: ${(error as Error).message}`;
        const failed = this.deps.registry.update(record.id, {
          status: "failed",
          error: message,
          lastSummary: message,
          ...(leafId ? { childLeafId: leafId } : {}),
        });
        const note = `@${failed.handle} failed: ${message}`;
        return { record: failed, payload: { text: note, summary: note } };
      }
    })();
    this.work.add(job);
    void job.catch(() => {}).finally(() => this.work.delete(job));
    if (background && !batch) return { record };
    return job;
  }

  private finish(id: string, result: ChildResult, live: Live, background: boolean, leafId?: string, options: LaunchOptions = {}): RunOutcome {
    const registry = this.deps.registry;
    registry.addUsage(id, result.usage);
    let status: RunStatus;
    let error: string | undefined;
    if (live.intent === "stop") status = "stopped";
    else if (live.intent === "interrupt" || result.stopReason === "aborted") status = "paused";
    else if (result.stopReason === "error") (status = "failed"), (error = result.errorMessage ?? "child reported an error");
    else if (!result.text.trim()) (status = "failed"), (error = "child returned an empty answer");
    else status = "completed";

    const current = registry.get(id)!;
    const batch = options.mode === "batch";
    let payload: Payload;
    if (status === "completed") {
      // share/auto background results are delivered into the main LLM context: always move the full text to a file
      // and send only the summary + paths (ratio 0). Private results never enter the LLM context, so they keep the
      // contextRatio rule like foreground returns. One file per run at most. A batch run is never delivered on its
      // own: it is sized for its consumer (the next chain step, or the group summary) in the summary + path form.
      const receiverWindow = options.receiverContextWindow ?? this.deps.receiverContextWindow();
      const label =
        batch && current.stepIndex !== undefined ? `${current.handle}-step${current.stepIndex + 1}-run${current.runId}` : `${current.handle}-run${current.runId}`;
      payload = preparePayload({
        text: result.text,
        receiverContextWindow: receiverWindow,
        ratio: background && !batch && current.delivery !== "private" ? 0 : this.deps.settings().contextRatio,
        outputDir: this.deps.outputDir,
        label,
        ...(batch ? { style: "path" as const, sessionFile: current.sessionFile } : {}),
      });
    } else {
      const note = `@${current.handle} ${status}${error ? `: ${error}` : ""}`;
      payload = { text: note, summary: note };
    }
    let record = registry.update(id, { status, error, lastSummary: payload.summary, ...(leafId ? { childLeafId: leafId } : {}) });
    // A foreground caller (the main agent) gets the instructions that were added while it waited.
    // Private instructions are never shown to it.
    const shown = live.asks.filter((a) => !a.private);
    if (!background && shown.length) payload = { ...payload, text: `${renderAsks(current.handle, shown)}\n\n${payload.text}` };
    if (background && !batch && status !== "stopped" && status !== "paused") {
      if (record.parentId) {
        // A nested run hands its result to its own parent, never to the main session.
        if (status === "completed") this.routeChildResult(record, payload);
      } else {
        // Only a private run's own private entry may quote private instructions.
        const quoted = record.delivery === "private" ? live.asks : shown;
        try {
          deliver(this.deps.port, record.delivery, {
            handle: record.handle,
            agent: recordEntryLabel(record),
            status,
            text: payload.text,
            sessionFile: record.sessionFile,
            ...(payload.filePath ? { filePath: payload.filePath } : {}),
            ...(quoted.length ? { asks: quoted } : {}),
          });
        } catch (deliveryError) {
          // Delivery is a side channel: keep the run's status, record why it was not delivered.
          // Keep the run's own error (e.g. why it failed) in front of the delivery error.
          const message = (deliveryError as Error).message;
          record = registry.update(id, { error: `${error ? `${error}; ` : ""}delivery failed: ${message}` });
          try {
            this.deps.onDeliveryError?.(record, message);
          } catch {
            // The notifier must never turn a finished run into a failed one.
          }
        }
      }
    }
    return { record, payload };
  }

  /** Hands a finished child's result to its parent: continue it, queue into it, or wait for its resume. */
  private routeChildResult(child: SubagentRecord, payload: Payload): void {
    const parent = this.deps.registry.get(child.parentId!);
    if (!parent) return;
    this.routeToParent(parent, {
      fromId: child.id,
      handle: child.handle,
      summary: payload.summary,
      sessionFile: child.sessionFile,
      ...(payload.filePath ? { filePath: payload.filePath } : {}),
      at: this.now(),
    });
  }

  /**
   * Delivers one pending entry to a parent: inject it if the parent is live, resume an idle one, and otherwise queue
   * it. Used by both a single finished child and a nested background group summary, so both reach the direct parent
   * by exactly one path.
   */
  private routeToParent(parent: SubagentRecord, entry: PendingResult): void {
    if (parent.status === "stopped") return; // discarded with the parent
    // Delivery failure must not lose the result: it stays queued for a later resume/drain.
    const fail = (error: unknown) => {
      this.queuePending(parent, entry);
      this.reportDeliveryError(parent, error);
    };
    if (parent.status === "paused") {
      this.queuePending(parent, entry);
      return;
    }
    const live = this.live.get(parent.id);
    if (live) {
      // Tracked so whenIdle()/shutdown() observe the injection: this hand-off is still work even though the run that
      // produced the result already ended.
      this.track(live.session.deliver(this.childResultsText(parent, [entry]), "queue"), fail);
      return;
    }
    // An idle parent is one whose session is still resident: continue it in place. A parent whose session was
    // closed is not silently reopened for a grandchild's result; the result waits for an explicit resume or drain.
    if (!this.idle.has(parent.id)) {
      this.queuePending(parent, entry);
      return;
    }
    // Tracked for the same reason: the parent's continued turn must be part of whenIdle(), or a caller that awaits it
    // could observe the child result before the parent ever receives it.
    this.track(this.resume(parent.handle, this.childResultsText(parent, [entry]), { background: true, mode: "batch" }), fail);
  }

  /** Appends one child result to the parent's pending queue and makes sure the reminder watch runs. */
  private queuePending(parent: SubagentRecord, entry: PendingResult): void {
    const current = this.deps.registry.get(parent.id) ?? parent;
    this.deps.registry.update(parent.id, { pending: [...(current.pending ?? []), entry], pendingNotifiedAt: undefined });
    this.ensurePendingWatch();
  }

  /** Surfaces a delivery failure through the existing notifier, never throwing from a finished run. */
  private reportDeliveryError(parent: SubagentRecord, error: unknown): void {
    const message = (error as Error).message;
    // Decision 9: the result stays queued *and* the parent records why the hand-off failed, in the same style as a
    // child record ("delivery failed: ..."). Persisting can fail once the main session is gone, so it is guarded
    // separately: the notifier must still report the failure.
    try {
      const current = this.deps.registry.get(parent.id) ?? parent;
      this.deps.registry.update(parent.id, { error: `${current.error ? `${current.error}; ` : ""}delivery failed: ${message}` });
    } catch {
      // The notifier below still surfaces the failure.
    }
    try {
      this.deps.onDeliveryError?.(parent, `child result not delivered: ${message}`);
    } catch {
      // Reporting must not throw.
    }
  }

  /** The merged message for pending child results, sized for the parent's model window (30% rule). */
  childResultsText(parent: SubagentRecord, entries: readonly PendingResult[]): string {
    const sections = entries.map((e) => `### [@${e.handle}] completed\n${e.summary}\nSession: ${e.sessionFile}${e.filePath ? `\nFull output: ${e.filePath}` : ""}`);
    const text = sections.join("\n\n");
    const agent = this.deps.agents().get(parent.agent);
    const receiverContextWindow = (agent ? this.deps.receiverContextWindowFor?.(agent) : undefined) ?? this.deps.receiverContextWindow();
    return preparePayload({
      text,
      receiverContextWindow,
      ratio: this.deps.settings().contextRatio,
      outputDir: this.deps.outputDir,
      label: `${parent.handle}-child-results`,
    }).text;
  }

  /** Starts the 60s reminder watch (only while something is queued). */
  private ensurePendingWatch(): void {
    if (this.pendingTimer) return;
    this.pendingTimer = setInterval(() => void this.checkPendingReminders(), 60_000);
    this.pendingTimer.unref?.();
  }

  private stopPendingWatch(): void {
    if (this.pendingTimer) clearInterval(this.pendingTimer);
    this.pendingTimer = undefined;
  }

  /** One reminder pass; returns how many parents were reported. Testable without timers. */
  checkPendingReminders(): number {
    const timeoutMs = this.deps.settings().pendingResultTimeoutMinutes * 60_000;
    let reported = 0;
    for (const record of this.deps.registry.list()) {
      const pending = record.pending ?? [];
      if (!pending.length) continue;
      const oldest = Math.min(...pending.map((p) => p.at));
      if (this.now() - oldest < timeoutMs) continue;
      if ((record.pendingNotifiedAt ?? 0) >= oldest) continue;
      this.deps.registry.update(record.id, { pendingNotifiedAt: this.now() });
      try {
        this.deps.onPendingReminder?.(record, pending.length, Math.round((this.now() - oldest) / 60_000));
      } catch {
        // Notification must not throw.
      }
      reported++;
    }
    if (!reported && !this.deps.registry.list().some((r) => (r.pending ?? []).length)) this.stopPendingWatch();
    return reported;
  }

  /** Hands the queued child results to the caller (the main session) and clears them. */
  async drainPending(handle: string): Promise<{ text: string; count: number }> {
    const record = this.requireRecord(handle);
    const pending = record.pending ?? [];
    if (!pending.length) return { text: "no child results are waiting", count: 0 };
    const text = this.childResultsText(record, pending);
    this.deps.registry.update(record.id, { pending: [], pendingNotifiedAt: undefined });
    return { text, count: pending.length };
  }

  /** Drops the queued child results and returns how many were discarded. */
  dropPending(handle: string): number {
    const record = this.requireRecord(handle);
    const count = (record.pending ?? []).length;
    if (count) this.deps.registry.update(record.id, { pending: [], pendingNotifiedAt: undefined });
    return count;
  }

  /** After a turn: keep the child for the next resume, or close it (stopped, shut down, dead, or maxResident 0). */
  private async park(id: string, session: ChildSession, live: Live): Promise<void> {
    const keep = live.intent !== "stop" && !this.closed && session.alive && this.deps.settings().maxResident !== 0;
    if (!keep) {
      await this.close(id, session);
      return;
    }
    if (!this.watched.has(session)) {
      this.watched.add(session);
      // A child that dies while idle is dropped and still disposed (dispose is idempotent and allowed after exit);
      // the next resume opens a new one from the session file. A running child that dies is closed by park().
      session.onExit(() => {
        if (this.idle.get(id) !== session) return;
        this.idle.delete(id);
        void this.close(id, session);
      });
    }
    this.idle.delete(id);
    this.idle.set(id, session);
    this.evictIdle();
  }

  /**
   * Closes least recently used idle children while live + idle exceeds maxResident. Running children are never evicted.
   * The closes are not awaited here (a run need not wait for another record's child); whenIdle/shutdown and a resume of
   * the evicted record wait for them.
   */
  private evictIdle(): void {
    const limit = this.deps.settings().maxResident;
    for (const [id, session] of this.idle) {
      if (limitAllows(limit, this.live.size + this.idle.size - 1)) break;
      this.idle.delete(id);
      void this.close(id, session);
    }
  }

  /**
   * The idle child for a resume if it is alive and still at the record's leaf; otherwise it is closed. Before returning
   * undefined it waits for every close of this record still in flight (this one, or an earlier eviction/stop/exit),
   * so the session file has no other writer when the runner reopens (and possibly pins) it.
   */
  private async takeIdle(record: SubagentRecord): Promise<ChildSession | undefined> {
    const session = this.idle.get(record.id);
    if (session) {
      this.idle.delete(record.id);
      let sameLeaf = false;
      try {
        sameLeaf = session.alive && record.childLeafId !== undefined && session.leafId === record.childLeafId;
      } catch {
        // An unreadable leaf counts as a mismatch: close the child and reopen from the session file.
      }
      if (sameLeaf) return session;
      void this.close(record.id, session);
    }
    await this.closing.get(record.id);
    return undefined;
  }

  /** Closes the idle child of a record, if any; resolves once every close of that record has finished. */
  private closeIdle(id: string): Promise<void> {
    const session = this.idle.get(id);
    if (session) {
      this.idle.delete(id);
      return this.close(id, session);
    }
    return this.closing.get(id) ?? Promise.resolve();
  }

  /**
   * The only way a child session is disposed. The close is tracked in `work` (whenIdle/shutdown wait for it) and in
   * `closing` by record id (a reopen of the same session file waits for it). Never rejects.
   */
  private close(id: string, session: ChildSession): Promise<void> {
    const previous = this.closing.get(id);
    let disposing: Promise<void>;
    try {
      disposing = session.dispose().catch(() => {});
    } catch {
      disposing = Promise.resolve();
    }
    const done: Promise<void> = (previous ? Promise.all([previous, disposing]).then(() => {}) : disposing).finally(() => {
      if (this.closing.get(id) === done) this.closing.delete(id);
      this.work.delete(done);
    });
    this.closing.set(id, done);
    this.work.add(done);
    return done;
  }

  /** Synchronous checks shared by resume and checkResumable, including resolving the recorded cwd; throws the error resume would reject with. */
  private preflight(handle: string): { record: SubagentRecord; agent: AgentDef; runner: Runner; cwd: string } {
    if (this.closed) throw shutDownError();
    const record = this.requireRecord(handle);
    if (record.status === "stopped") throw new SubagentError("stopped", `@${record.handle} was stopped and cannot be resumed; start a new subagent instead`);
    if (record.status === "queued") throw new SubagentError("busy", `@${record.handle} is queued and has not started yet`);
    if (record.status === "running" || this.live.has(record.id)) {
      throw new SubagentError("busy", `@${record.handle} is still running; use steer to guide it`);
    }
    if (!record.sessionFile) throw new SubagentError("missing_session", `@${record.handle} never started, so there is no session to resume`);
    if (!existsSync(record.sessionFile)) {
      throw new SubagentError("missing_session", `session file for @${record.handle} is missing: ${record.sessionFile}`);
    }
    const agent = record.entry ? BUILTIN_ENTRY_AGENT_DEF : this.requireAgent(record.agent);
    const runner = this.requireRunner(record.runner);
    // Resolve last so a missing cwd is reported exactly like resume() does, after the other preflight errors.
    return { record, agent, runner, cwd: this.resolveCwd(record.cwd) };
  }

  private ask(kind: Ask["kind"], text: string): Ask {
    return { kind, text: quoteAsk(text, this.deps.settings().mentionQuoteMaxChars) };
  }

  /** Interrupt or stop on a run still waiting for a slot or a session: nothing has started, so it is cancelled for good. */
  private cancelQueued(record: SubagentRecord): boolean {
    const controller = this.queued.get(record.id);
    if (!controller) return false;
    this.cancelled.add(record.id);
    try {
      this.deps.registry.update(record.id, { status: "stopped", error: "cancelled before it started" });
    } finally {
      // Cancel even when persisting the status failed, so the run never starts.
      controller.abort();
    }
    return true;
  }

  /** Records why a run never reached its child session and returns the error the caller should see. */
  private settleQueued(id: string, cause: unknown, signal?: AbortSignal): unknown {
    const record = this.deps.registry.get(id);
    const wasCancelled = this.cancelled.delete(id);
    try {
      if (wasCancelled || record?.status === "stopped") return new SubagentError("stopped", `@${record?.handle ?? id} was cancelled before it started`);
      if (this.closed) {
        this.deps.registry.update(id, { status: "failed", error: "cut off by shutdown before it started" });
        return cause;
      }
      if (signal?.aborted) {
        this.deps.registry.update(id, { status: "stopped", error: "cancelled before it started" });
        return runInterruptedError();
      }
      this.deps.registry.update(id, { status: "failed", error: cause instanceof Error ? cause.message : String(cause) });
    } catch {
      // Persisting can fail once the main session is gone; the caller still gets the original error.
    }
    return cause;
  }

  private markStopped(id: string): void {
    if (this.deps.registry.get(id)?.status !== "stopped") this.deps.registry.update(id, { status: "stopped" });
  }

  /**
   * Marks a record stopped and drops the child results waiting for it (plan 6.9 decision 9: a stopped parent discards
   * them). Idempotent: a record already stopped with nothing queued is left untouched.
   */
  private markStoppedAndDiscardPending(id: string): void {
    const record = this.deps.registry.get(id);
    if (!record) return;
    const queued = (record.pending ?? []).length > 0 || record.pendingNotifiedAt !== undefined;
    if (record.status === "stopped" && !queued) return;
    this.deps.registry.update(id, { status: "stopped", ...(queued ? { pending: [], pendingNotifiedAt: undefined } : {}) });
  }

  private requireAgent(name: string): AgentDef {
    const agents = this.deps.agents();
    const agent = agents.get(name);
    if (!agent) throw new SubagentError("unknown_agent", `unknown agent "${name}". Available: ${[...agents.keys()].join(", ") || "(none)"}`);
    return agent;
  }

  private requireRunner(kind: RunnerKind): Runner {
    const runner = this.deps.runners[kind];
    if (!runner) throw new Error(`runner "${kind}" is not available in this version`);
    return runner;
  }

  /**
   * Resolves a `父/子` path: the first segment is any record and every later segment must be a direct child of the
   * previous one. Returns undefined when the first segment does not resolve at all (the caller then reports the
   * existing global miss); a miss below a resolved parent names that parent's direct children instead.
   */
  private resolvePath(cleaned: string): SubagentRecord | undefined {
    let current: SubagentRecord | undefined;
    for (const segment of cleaned.split("/").filter((s) => s.length > 0)) {
      const next = current ? this.childBySegment(current, segment) : this.deps.registry.resolve(segment);
      if (!next) {
        if (!current) return undefined;
        const children = this.directChildren(current.id).map((r) => `@${r.handle}`).join(", ") || "(none)";
        throw new SubagentError("unknown_handle", `no subagent "${cleaned}"; children of @${current.handle}: ${children}`);
      }
      current = next;
    }
    return current;
  }

  private requireRecord(handle: string): SubagentRecord {
    const cleaned = handle.replace(/^@/, "");
    // The existing handle/id lookup stays first; the `父/子` path branch is only tried when that misses.
    const record = this.deps.registry.resolve(cleaned) ?? this.resolvePath(cleaned);
    if (!record) {
      const known = this.deps.registry.list().map((r) => `@${r.handle}`).join(", ") || "(none)";
      throw new SubagentError("unknown_handle", `no subagent "${handle}". Known: ${known}`);
    }
    return record;
  }
}

function runInterruptedError(): SubagentError {
  return new SubagentError("interrupted", "subagent run was interrupted before it started");
}

/**
 * The abort scope for a delegated tool call: nothing (REVIEW-019). A child's tool call is aborted when the child
 * itself is interrupted or stopped; plan 6.9 decision 8 says an interrupt never cascades, so the child's own
 * descendants keep running and queue their results. The record this very call starts is already cancelled by the same
 * `signal` that is threaded into manager.run/runParallel/runChain/resume, so no global `interruptAll()` may fire here
 * (that would pause unrelated siblings and other trees). Only the main session's Esc keeps the default callback.
 */
const noCascade = (): void => {};

/** The entry fields of a batch item or chain step, present only when set (keeps empty strings out of the stored entry). */
function entryFields(item: EntryRequest & { cwd?: string }): EntryRequest & { cwd?: string } {
  return {
    ...(item.agent ? { agent: item.agent } : {}),
    ...(item.skill ? { skill: item.skill } : {}),
    ...(item.command ? { command: item.command } : {}),
    ...(item.task !== undefined ? { task: item.task } : {}),
    ...(item.cwd ? { cwd: item.cwd } : {}),
  };
}

/** The only placeholder a chain task may use: the previous step's final output. */
function substitutePrevious(task: string, previous: string): string {
  // Use a function replacement: `$&`, `` $` ``, `$'`, `$1` and `$$` in the previous output must stay literal.
  return task.replace(/\{previous\}/g, () => previous);
}

/** Maps a finished step's run status to the chain status it leaves behind. */
function chainStatusOf(status: RunStatus): ChainStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "paused":
      return "paused";
    case "stopped":
      return "stopped";
    default:
      return "failed";
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: Math.round((a.cost + b.cost) * 1e6) / 1e6,
  };
}

function shutDownError(): Error {
  return new Error("subagent manager is shut down");
}
