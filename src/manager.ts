import { existsSync } from "node:fs";
import type { AgentDef } from "./agents.ts";
import { deliver, type DeliveryPort } from "./delivery.ts";
import { type Payload, preparePayload, SUMMARY_INSTRUCTION } from "./output.ts";
import type { Registry, RunStatus, SubagentRecord } from "./registry.ts";
import type { ChildResult, ChildSession, Runner } from "./runner/types.ts";
import type { Scheduler } from "./scheduler.ts";
import type { DeliveryMode, RunnerKind, SubagentSettings } from "./settings.ts";

export type SubagentErrorCode = "unknown_agent" | "unknown_handle" | "stopped" | "busy" | "not_running" | "missing_session";

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
}

export interface RunRequest {
  agent: string;
  task: string;
  delivery?: DeliveryMode;
  background?: boolean;
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

  constructor(private readonly deps: ManagerDeps) {}

  list(): SubagentRecord[] {
    return this.deps.registry.list();
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const agent = this.requireAgent(req.agent);
    const runner = this.requireRunner(agent.runner ?? this.deps.settings().defaultRunner);
    const delivery = req.delivery ?? agent.delivery ?? this.deps.settings().defaultDelivery;
    const release = await this.deps.scheduler.acquire();
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
    const record = this.deps.registry.create({
      agent: agent.name,
      preferredHandle: agent.handle ?? agent.name,
      runner: runner.kind,
      depth: 1,
      sessionFile: session.sessionFile,
      delivery,
      task: req.task,
    });
    return this.execute(record, session, req.task, release, req.background ?? false);
  }

  async resume(handle: string, message: string, opts: { delivery?: DeliveryMode; background?: boolean } = {}): Promise<RunOutcome> {
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
    const previous: RunStatus = record.status;
    // Claim the record synchronously so a second resume sees "running".
    const claimed = this.deps.registry.update(record.id, {
      status: "running",
      runId: record.runId + 1,
      delivery: opts.delivery ?? record.delivery,
      error: undefined,
    });
    let release: () => void;
    let session: ChildSession;
    try {
      release = await this.deps.scheduler.acquire();
      try {
        session = await runner.open({
          agent,
          cwd: this.deps.cwd,
          sessionDir: this.deps.sessionDir,
          resumeFile: record.sessionFile,
          appendSystemPrompt: [agent.systemPrompt, SUMMARY_INSTRUCTION].filter(Boolean),
        });
      } catch (error) {
        release();
        throw error;
      }
    } catch (error) {
      this.deps.registry.update(record.id, { status: previous, runId: record.runId });
      throw error;
    }
    return this.execute(claimed, session, message, release, opts.background ?? false);
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

  /** After /reload or restart no child is live; any "running" record was cut off. */
  recoverInterrupted(): number {
    let count = 0;
    for (const r of this.deps.registry.list()) {
      if (r.status === "running" && !this.live.has(r.id)) {
        this.deps.registry.update(r.id, { status: "paused", error: "interrupted by reload or restart" });
        count++;
      }
    }
    return count;
  }

  async whenIdle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  private async execute(record: SubagentRecord, session: ChildSession, text: string, release: () => void, background: boolean): Promise<RunOutcome> {
    const live: Live = { session };
    this.live.set(record.id, live);
    const job = (async (): Promise<RunOutcome> => {
      let result: ChildResult;
      try {
        result = await session.prompt(text);
      } catch (error) {
        result = { text: "", stopReason: "error", errorMessage: (error as Error).message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
      } finally {
        this.live.delete(record.id);
        release();
        await session.dispose().catch(() => {});
      }
      return this.finish(record.id, result, live, background);
    })();
    this.work.add(job);
    void job.finally(() => this.work.delete(job));
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
      payload = preparePayload({
        text: result.text,
        receiverContextWindow: this.deps.receiverContextWindow(),
        ratio: this.deps.settings().contextRatio,
        outputDir: this.deps.outputDir,
        label: `${current.handle}-run${current.runId}`,
      });
    } else {
      const note = `@${current.handle} ${status}${error ? `: ${error}` : ""}`;
      payload = { text: note, summary: note };
    }
    const record = registry.update(id, { status, error, lastSummary: payload.summary });
    if (background && status !== "stopped" && status !== "paused") {
      deliver(this.deps.port, record.delivery, {
        handle: record.handle,
        agent: record.agent,
        status,
        text: payload.text,
        sessionFile: record.sessionFile,
        ...(payload.filePath ? { filePath: payload.filePath } : {}),
      });
    }
    return { record, payload };
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
