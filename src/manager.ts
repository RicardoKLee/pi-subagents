import { existsSync } from "node:fs";
import type { AgentDef } from "./agents.ts";
import { deliver, type DeliveryPort } from "./delivery.ts";
import { type Payload, preparePayload, SUMMARY_INSTRUCTION } from "./output.ts";
import type { Registry, RunStatus, SubagentRecord } from "./registry.ts";
import type { ChildResult, ChildSession, Runner } from "./runner/types.ts";
import type { Scheduler } from "./scheduler.ts";
import type { DeliveryMode, RunnerKind, SubagentSettings } from "./settings.ts";

export type SubagentErrorCode = "unknown_agent" | "unknown_handle" | "stopped" | "busy" | "not_running" | "missing_session" | "interrupted";

export class SubagentError extends Error {
  constructor(readonly code: SubagentErrorCode, message: string) {
    super(message);
    this.name = "SubagentError";
  }
}

export interface ManagerDeps {
  registry: Registry;
  scheduler: Scheduler;
  runners: Record<RunnerKind, Runner | undefined>;
  agents: () => Map<string, AgentDef>;
  settings: () => SubagentSettings;
  port: DeliveryPort;
  /** Context window of whoever receives the result (main model in M1). */
  receiverContextWindow: () => number;
  cwd: string;
  sessionDir: string;
  outputDir: string;
  /** Called when a background result could not be delivered (the error is also recorded on the record). */
  onDeliveryError?: (record: SubagentRecord, message: string) => void;
}

export interface RunRequest {
  agent: string;
  task: string;
  delivery?: DeliveryMode;
  background?: boolean;
  /** The calling tool's signal: aborting it cancels this run while queued, opening, or (foreground) running. */
  signal?: AbortSignal;
}

export interface RunOutcome {
  record: SubagentRecord;
  /** Set for foreground calls. */
  payload?: Payload;
}

interface Live {
  session: ChildSession;
  intent?: "interrupt" | "stop";
}

export class SubagentManager {
  private readonly live = new Map<string, Live>();
  private readonly work = new Set<Promise<unknown>>();
  /** Resumes that claimed a record but have not reached execute() yet. */
  private readonly claims = new Map<string, { intent?: "stop"; controller: AbortController }>();
  private closed = false;
  /** Aborted on shutdown so queued run/resume calls stop waiting for a slot. */
  private readonly lifetime = new AbortController();

  constructor(private readonly deps: ManagerDeps) {}

  list(): SubagentRecord[] {
    return this.deps.registry.list();
  }

  /** Records with a live child or a pending resume claim; these must survive a branch switch. */
  activeRecords(): SubagentRecord[] {
    const ids = new Set([...this.live.keys(), ...this.claims.keys()]);
    return [...ids].map((id) => this.deps.registry.get(id)).filter((r): r is SubagentRecord => r !== undefined);
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    if (this.closed) throw shutDownError();
    const agent = this.requireAgent(req.agent);
    const runner = this.requireRunner(agent.runner ?? this.deps.settings().defaultRunner);
    // Runs started by the main agent's tool are always auto; `delivery` is only passed by internal callers.
    const delivery = req.delivery ?? "auto";
    const signal = req.signal;
    let release: () => void;
    try {
      release = await this.deps.scheduler.acquire(signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal);
    } catch (error) {
      if (!this.closed && signal?.aborted) throw runInterruptedError();
      throw error;
    }
    let session: ChildSession;
    try {
      session = await runner.open({
        agent,
        cwd: this.deps.cwd,
        sessionDir: this.deps.sessionDir,
        appendSystemPrompt: [agent.systemPrompt, SUMMARY_INSTRUCTION].filter(Boolean),
      });
    } catch (error) {
      release();
      throw error;
    }
    if (this.closed) {
      // Shutdown happened while the session was opening; do not register a record on a dead session.
      release();
      await session.dispose().catch(() => {});
      throw shutDownError();
    }
    if (signal?.aborted) {
      // The calling tool was aborted while the session was opening.
      release();
      await session.dispose().catch(() => {});
      throw runInterruptedError();
    }
    const record = this.deps.registry.create({
      agent: agent.name,
      preferredHandle: agent.handle ?? agent.name,
      runner: runner.kind,
      depth: 1,
      sessionFile: session.sessionFile,
      delivery,
      task: req.task,
    });
    return this.execute(record, session, req.task, release, req.background ?? false, signal);
  }

  async resume(
    handle: string,
    message: string,
    opts: { delivery?: DeliveryMode; background?: boolean; signal?: AbortSignal } = {},
  ): Promise<RunOutcome> {
    if (this.closed) throw shutDownError();
    const record = this.requireRecord(handle);
    if (record.status === "stopped") throw new SubagentError("stopped", `@${record.handle} was stopped and cannot be resumed; start a new subagent instead`);
    if (record.status === "running" || this.live.has(record.id)) {
      throw new SubagentError("busy", `@${record.handle} is still running; use steer to guide it`);
    }
    if (!existsSync(record.sessionFile)) {
      throw new SubagentError("missing_session", `session file for @${record.handle} is missing: ${record.sessionFile}`);
    }
    const agent = this.requireAgent(record.agent);
    const runner = this.requireRunner(record.runner);
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
        session = await runner.open({
          agent,
          cwd: this.deps.cwd,
          sessionDir: this.deps.sessionDir,
          resumeFile: record.sessionFile,
          appendSystemPrompt: [agent.systemPrompt, SUMMARY_INSTRUCTION].filter(Boolean),
        });
        if (this.closed) {
          // Shutdown during open: dispose here; release and rollback run in the handlers below.
          await session.dispose().catch(() => {});
          throw shutDownError();
        }
        if (signal?.aborted && claim.intent !== "stop") {
          // The calling tool was aborted while the session was opening; release and rollback run below.
          await session.dispose().catch(() => {});
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
      await session.dispose().catch(() => {});
      throw stoppedWhileWaiting();
    }
    return this.execute(claimed, session, message, release, opts.background ?? false, signal);
  }

  async steer(handle: string, message: string, mode: "steer" | "followUp" = "steer"): Promise<void> {
    const record = this.requireRecord(handle);
    const live = this.live.get(record.id);
    if (!live) throw new SubagentError("not_running", `@${record.handle} is ${record.status}; use resume to continue it`);
    await live.session.steer(message, mode);
  }

  async interrupt(handle: string): Promise<void> {
    const record = this.requireRecord(handle);
    const live = this.live.get(record.id);
    if (!live) throw new SubagentError("not_running", `@${record.handle} is ${record.status}`);
    live.intent = "interrupt";
    await live.session.abort();
  }

  async stop(handle: string): Promise<void> {
    const record = this.requireRecord(handle);
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
  }

  /** After /reload, restart or a branch switch no child is live for these records; any "running" one was cut off. */
  recoverInterrupted(reason = "interrupted by reload or restart"): number {
    let count = 0;
    for (const r of this.deps.registry.list()) {
      if (r.status === "running" && !this.live.has(r.id) && !this.claims.has(r.id)) {
        this.deps.registry.update(r.id, { status: "paused", error: reason });
        count++;
      }
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
  ): Promise<RunOutcome> {
    const live: Live = { session };
    this.live.set(record.id, live);
    // Only a foreground call is still waiting on its tool signal; a background call has already returned.
    const callSignal = background ? undefined : signal;
    const onCallAbort = () => {
      live.intent = "interrupt";
      void session.abort().catch(() => {});
    };
    const job = (async (): Promise<RunOutcome> => {
      let result: ChildResult;
      try {
        if (callSignal?.aborted) onCallAbort();
        else callSignal?.addEventListener("abort", onCallAbort, { once: true });
        result = await session.prompt(text);
      } catch (error) {
        result = { text: "", stopReason: "error", errorMessage: (error as Error).message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
      } finally {
        callSignal?.removeEventListener("abort", onCallAbort);
        this.live.delete(record.id);
        release();
        await session.dispose().catch(() => {});
      }
      try {
        return this.finish(record.id, result, live, background);
      } catch (error) {
        // Never leave the record stuck in "running" or let a background job reject.
        const message = `result handling failed: ${(error as Error).message}`;
        const failed = this.deps.registry.update(record.id, { status: "failed", error: message, lastSummary: message });
        const note = `@${failed.handle} failed: ${message}`;
        return { record: failed, payload: { text: note, summary: note } };
      }
    })();
    this.work.add(job);
    void job.catch(() => {}).finally(() => this.work.delete(job));
    if (background) return { record };
    return job;
  }

  private finish(id: string, result: ChildResult, live: Live, background: boolean): RunOutcome {
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
    let payload: Payload;
    if (status === "completed") {
      // share/auto background results are delivered into the main LLM context: always move the full text to a file
      // and send only the summary + paths (ratio 0). Private results never enter the LLM context, so they keep the
      // contextRatio rule like foreground returns. One file per run at most.
      payload = preparePayload({
        text: result.text,
        receiverContextWindow: this.deps.receiverContextWindow(),
        ratio: background && current.delivery !== "private" ? 0 : this.deps.settings().contextRatio,
        outputDir: this.deps.outputDir,
        label: `${current.handle}-run${current.runId}`,
      });
    } else {
      const note = `@${current.handle} ${status}${error ? `: ${error}` : ""}`;
      payload = { text: note, summary: note };
    }
    let record = registry.update(id, { status, error, lastSummary: payload.summary });
    if (background && status !== "stopped" && status !== "paused") {
      try {
        deliver(this.deps.port, record.delivery, {
          handle: record.handle,
          agent: record.agent,
          status,
          text: payload.text,
          sessionFile: record.sessionFile,
          ...(payload.filePath ? { filePath: payload.filePath } : {}),
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

function shutDownError(): Error {
  return new Error("subagent manager is shut down");
}
