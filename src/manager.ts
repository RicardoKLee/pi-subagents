import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentDef } from "./agents.ts";
import { type ChainRecord, type ChainStatus, ChainStore } from "./chain.ts";
import { type Ask, deliver, type DeliveryPort, deliverBatch, quoteAsk, renderAsks } from "./delivery.ts";
import { estimateTokens, type Payload, preparePayload, SUMMARY_INSTRUCTION, writeOutput } from "./output.ts";
import { type Registry, type RunStatus, type SubagentRecord, type Usage, ZERO_USAGE } from "./registry.ts";
import type { ChildResult, ChildSession, Runner } from "./runner/types.ts";
import { type Scheduler, SubagentsDisabledError } from "./scheduler.ts";
import type { DeliveryMode, RunnerKind, SubagentSettings } from "./settings.ts";
import { limitAllows } from "./settings.ts";

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
  sessionDir: string;
  outputDir: string;
  /** Project trust for a child cwd decided by the caller; the manager never guesses it. */
  trustForCwd?: (cwd: string) => boolean | undefined;
  /** Called when a background result could not be delivered (the error is also recorded on the record). */
  onDeliveryError?: (record: SubagentRecord, message: string) => void;
  /** Called once a new record exists (queued); used to warn about handles that clash with files. */
  onRecordCreated?: (record: SubagentRecord) => void;
}

export interface RunRequest {
  agent: string;
  task: string;
  delivery?: DeliveryMode;
  background?: boolean;
  /** The calling tool's signal: aborting it cancels this run while queued, opening, or (foreground) running. */
  signal?: AbortSignal;
  /** Working directory for the child; relative paths resolve against deps.cwd. Defaults to deps.cwd. */
  cwd?: string;
  /** Receiver window for the 30% rule (chain steps size their output for the next step). Defaults to deps.receiverContextWindow(). */
  receiverContextWindow?: number;
  /** Set for chain steps: the chain this run belongs to and its 0-based position. */
  chainId?: string;
  stepIndex?: number;
}

export interface RunOutcome {
  record: SubagentRecord;
  /** Set for foreground calls. */
  payload?: Payload;
}

export interface BatchItem {
  agent: string;
  task: string;
  cwd?: string;
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
}

/** An item's agent, runner and cwd after validation; computed once so a whole batch can be checked before any record exists. */
interface Resolved {
  agent: AgentDef;
  runner: Runner;
  cwd: string;
  trusted?: boolean;
}

interface LaunchOptions {
  /** "batch" items never return early, never deliver on their own, and size their output by `receiverContextWindow`. */
  mode?: "single" | "batch";
  receiverContextWindow?: number;
}

interface Live {
  session: ChildSession;
  intent?: "interrupt" | "stop";
  /** User messages sent through `@` for this run, quoted with its result. */
  asks: Ask[];
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
  private closed = false;
  /** Aborted on shutdown so queued run/resume calls stop waiting for a slot. */
  private readonly lifetime = new AbortController();

  constructor(private readonly deps: ManagerDeps) {}

  list(): SubagentRecord[] {
    return this.deps.registry.list();
  }

  /** Chains on the current branch, in creation order (for the list tree). */
  listChains(): ChainRecord[] {
    return this.deps.chainStore.list();
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
    const prepared = this.prepare(req);
    return this.launch(prepared, req.task, req.background ?? false, req.signal, {
      ...(req.receiverContextWindow ? { receiverContextWindow: req.receiverContextWindow } : {}),
    });
  }

  /** Validates the request and creates the queued record (so it is listed and cancellable from the start). */
  private prepare(
    req: { agent: string; task: string; delivery?: DeliveryMode; cwd?: string; chainId?: string; stepIndex?: number },
    resolved?: Resolved,
  ): Prepared {
    if (this.closed) throw shutDownError();
    if (this.deps.scheduler.disabled) throw new SubagentsDisabledError();
    const { agent, runner, cwd, trusted } = resolved ?? this.resolveTarget(req);
    // Runs started by the main agent's tool are always auto; `delivery` is only passed by internal callers.
    const delivery = req.delivery ?? "auto";
    // The record exists from the start so a run waiting for a slot is listed and can be cancelled by handle.
    const record = this.deps.registry.create({
      agent: agent.name,
      preferredHandle: agent.handle ?? agent.name,
      runner: runner.kind,
      depth: 1,
      sessionFile: "",
      delivery,
      task: req.task,
      cwd,
      status: "queued",
      ...(req.chainId ? { chainId: req.chainId, stepIndex: req.stepIndex ?? 0 } : {}),
    });
    try {
      this.deps.onRecordCreated?.(record);
    } catch {
      // Informational only.
    }
    const controller = new AbortController();
    this.queued.set(record.id, controller);
    return { record, agent, runner, cwd, trusted, controller };
  }

  /** Waits for a slot, opens the child, then runs one turn. */
  private async launch(prepared: Prepared, text: string, background: boolean, signal: AbortSignal | undefined, options: LaunchOptions = {}): Promise<RunOutcome> {
    const { record, agent, runner, cwd, trusted, controller } = prepared;
    const cancel = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    let release: () => void;
    try {
      release = await this.deps.scheduler.acquire(cancel);
    } catch (error) {
      this.queued.delete(record.id);
      throw this.settleQueued(record.id, error, signal);
    }
    let session: ChildSession;
    try {
      session = await runner.open({
        agent,
        cwd,
        sessionDir: this.deps.sessionDir,
        ...(trusted !== undefined ? { projectTrusted: trusted } : {}),
        appendSystemPrompt: [agent.systemPrompt, SUMMARY_INSTRUCTION].filter(Boolean),
      });
    } catch (error) {
      this.queued.delete(record.id);
      release();
      throw this.settleQueued(record.id, error, signal);
    }
    this.queued.delete(record.id);
    if (this.closed || controller.signal.aborted || signal?.aborted) {
      // Shutdown, a cancel by handle, or the calling tool's abort happened while the session was opening.
      release();
      await this.close(record.id, session);
      throw this.settleQueued(record.id, this.closed ? shutDownError() : runInterruptedError(), signal);
    }
    const running = this.deps.registry.update(record.id, { status: "running", sessionFile: session.sessionFile });
    return this.execute(running, session, text, release, background, signal, [], options);
  }

  /** Starts every task at once (the scheduler still caps concurrency) and summarizes the group afterwards. */
  async runParallel(req: { items: readonly BatchItem[]; background?: boolean; signal?: AbortSignal }): Promise<BatchOutcome> {
    if (this.closed) throw shutDownError();
    if (req.items.length === 0) throw new Error("a parallel batch needs at least one item");
    const max = this.deps.settings().maxParallelTasks;
    if (max === 0) throw new SubagentsDisabledError("parallel is disabled (maxParallelTasks is 0)");
    // The n-th task is allowed exactly when the previous n - 1 are within the limit (max -1 = unlimited).
    if (!limitAllows(max, req.items.length - 1)) throw new Error(`too many parallel tasks (${req.items.length}); max is ${max}`);
    // Validate every agent, runner and cwd up front, before any record exists: a bad item must not leave a half-created
    // batch behind (a queued record whose launch() is never reached would stay queued forever).
    const resolved = req.items.map((item) => this.resolveTarget({ agent: item.agent, cwd: item.cwd }));
    const prepared = req.items.map((item, i) => this.prepare({ agent: item.agent, task: item.task, cwd: item.cwd }, resolved[i]!));
    // One item failing to start (runner.open, a cancel while queued/opening, shutdown) must not drop the others' results.
    const settled = Promise.allSettled(prepared.map((p, i) => this.launch(p, req.items[i]!.task, true, req.signal, { mode: "batch" })));
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
  async runChain(req: { steps: readonly BatchItem[]; background?: boolean; signal?: AbortSignal }): Promise<BatchOutcome> {
    if (this.closed) throw shutDownError();
    if (req.steps.length === 0) throw new Error("a chain needs at least one step");
    const max = this.deps.settings().maxChainSteps;
    if (max === 0) throw new SubagentsDisabledError("chains are disabled (maxChainSteps is 0)");
    if (!limitAllows(max, req.steps.length - 1)) throw new Error(`too many chain steps (${req.steps.length}); max is ${max}`);
    // Refuse before the chain exists when the scheduler is disabled (maxConcurrent 0): prepare() would throw
    // afterwards and leave a chain stuck in "running" with no step records and no way to continue it.
    if (this.deps.scheduler.disabled) throw new SubagentsDisabledError();
    // Validate every step's agent, runner and cwd before the chain exists, so a typo cannot leave a half-run chain behind.
    const targets = req.steps.map((step) => this.resolveTarget({ agent: step.agent, cwd: step.cwd }));
    const chain = this.deps.chainStore.create({
      steps: req.steps.map((s) => ({ agent: s.agent, task: s.task, ...(s.cwd ? { cwd: s.cwd } : {}) })),
    });
    if (!req.background) return this.runChainLoop(chain, 0, "", req.signal, targets);
    this.track(
      this.runChainLoop(chain, 0, "", req.signal, targets).then((outcome) => {
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
    const targets = chain.steps.map((step, i) => (i > index ? this.resolveTarget({ agent: step.agent, cwd: step.cwd }) : undefined));
    if (!opts.background) return this.continueChainLoop(chain, record, index, message, opts.signal, targets);
    this.track(
      this.continueChainLoop(chain, record, index, message, opts.signal, targets).then((outcome) => {
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
    targets: readonly (Resolved | undefined)[],
  ): Promise<BatchOutcome> {
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
    const rest = await this.runChainLoop(current, index + 1, resumed.payload?.text ?? "", signal, targets, [resumed]);
    // `runChainLoop` already carries the resumed outcome, so its records and payload span the whole chain.
    return { records: rest.records, payload: rest.payload, chain: rest.chain };
  }

  private async runChainLoop(
    chain: ChainRecord,
    from: number,
    previous: string,
    signal: AbortSignal | undefined,
    targets: readonly (Resolved | undefined)[],
    outcomes: RunOutcome[] = [],
  ): Promise<BatchOutcome> {
    let current = chain;
    for (let i = from; i < chain.steps.length; i++) {
      const step = chain.steps[i]!;
      const task = substitutePrevious(step.task, previous);
      let prepared: Prepared;
      try {
        prepared = this.prepare({ agent: step.agent, task, cwd: step.cwd, chainId: chain.id, stepIndex: i }, targets[i]);
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
        outcome = await this.launch(prepared, task, true, signal, { mode: "batch", ...(receiver ? { receiverContextWindow: receiver } : {}) });
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
    const next = chain.steps[index + 1] ? this.deps.agents().get(chain.steps[index + 1]!.agent) : undefined;
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
      return `### [@${r.handle}] (${r.agent}) ${step} ${r.status}${r.error ? `: ${r.error}` : ""}\n${r.lastSummary ?? ""}\nSession: ${r.sessionFile}`;
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
      const head = `### [@${r.handle}] (${r.agent}) ${r.status}${r.error ? `: ${r.error}` : ""}`;
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
    deliverBatch(this.deps.port, {
      text: payload.text,
      details: { kind, ...(chain ? { chainId: chain.id, status: chain.status } : {}), handles: records.map((r) => r.handle) },
    });
  }

  /** Resolves a run's agent, runner and cwd without creating a record, so a caller can validate it first. */
  private resolveTarget(req: { agent: string; cwd?: string }): Resolved {
    const agent = this.requireAgent(req.agent);
    const runner = this.requireRunner(agent.runner ?? this.deps.settings().defaultRunner);
    const cwd = this.resolveCwd(req.cwd);
    return { agent, runner, cwd, trusted: this.deps.trustForCwd?.(cwd) };
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
    message: string,
    opts: { delivery?: DeliveryMode; background?: boolean; signal?: AbortSignal; mention?: boolean; receiverContextWindow?: number; mode?: "single" | "batch" } = {},
  ): Promise<RunOutcome> {
    const { record, agent, runner, cwd } = this.preflight(handle);
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
    let release: () => void;
    let session: ChildSession;
    try {
      release = await this.deps.scheduler.acquire(claim.controller.signal);
      try {
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
      if (claim.intent === "stop") throw stoppedWhileWaiting();
      this.deps.registry.update(record.id, previous);
      if (!this.closed && signal?.aborted) throw interruptedWhileWaiting();
      throw error;
    }
    unlinkClaim();
    this.claims.delete(record.id);
    if (claim.intent === "stop") {
      release();
      await this.close(record.id, session);
      throw stoppedWhileWaiting();
    }
    return this.execute(claimed, session, message, release, opts.background ?? false, signal, opts.mention ? [this.ask("ask", message)] : [], {
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.receiverContextWindow ? { receiverContextWindow: opts.receiverContextWindow } : {}),
    });
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

  async stop(handle: string): Promise<void> {
    const record = this.requireRecord(handle);
    if (this.cancelQueued(record)) return;
    // Start closing the idle child synchronously (before any await), and return only once it has finished closing.
    const closingIdle = this.closeIdle(record.id);
    try {
      const claim = this.claims.get(record.id);
      if (claim) {
        // A resume is still waiting for a slot or a session; cancel it.
        claim.intent = "stop";
        claim.controller.abort();
        this.markStopped(record.id);
        return;
      }
      const live = this.live.get(record.id);
      if (live) {
        live.intent = "stop";
        await live.session.abort();
        return;
      }
      if (record.status !== "stopped") this.deps.registry.update(record.id, { status: "stopped" });
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
    for (const claim of this.claims.values()) claim.controller.abort();
    await this.interruptAll();
    for (const id of [...this.idle.keys()]) void this.closeIdle(id);
    // Idle children and children already closing (evicted, pruned, stopped); interrupted live children close as their
    // runs end, which whenIdle() waits for.
    await Promise.all([...this.closing.values()]);
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
    const live: Live = { session, asks };
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
        release();
        // A child that is not kept has finished closing before the run ends, as in M2.
        await this.park(record.id, session, live);
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
        ...(batch ? { style: "path" as const } : {}),
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
      // Only a private run's own private entry may quote private instructions.
      const quoted = record.delivery === "private" ? live.asks : shown;
      try {
        deliver(this.deps.port, record.delivery, {
          handle: record.handle,
          agent: record.agent,
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
    return { record, payload };
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
    const agent = this.requireAgent(record.agent);
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

  private requireRecord(handle: string): SubagentRecord {
    const record = this.deps.registry.resolve(handle.replace(/^@/, ""));
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
