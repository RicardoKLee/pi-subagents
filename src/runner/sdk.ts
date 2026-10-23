import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import { childExtension, type DelegationHost } from "../child.ts";
import type { Usage } from "../registry.ts";
import { type TurnMessage, turnResult } from "./result.ts";
import type { ChildResult, ChildSession, ChildSpec, Runner } from "./types.ts";

export type ModelResolver = (spec: string | undefined) => Model<any> | undefined;

export interface SdkRunnerOptions {
  agentDir: string;
  resolveModel: ModelResolver;
  modelRuntime?: ModelRuntime;
  /** The main session's project trust; undefined decides the way a `pi --mode rpc` child without -a/-na would. */
  projectTrusted?: () => boolean | undefined;
  /** Where a child's delegation requests go (the main manager, in-process). Absent disables delegation for SDK children. */
  delegationHost?: DelegationHost;
}

/**
 * The `DefaultResourceLoader` options for one child. Extracted so tests can assert the inline proxy extension is
 * injected only when the spec carries delegation; `noExtensions` only disables automatic discovery, explicit
 * `extensionFactories` still load (plan 6.9 item 12).
 */
export function buildLoaderOptions(
  spec: ChildSpec,
  opts: { agentDir: string; settingsManager: SettingsManager; host?: DelegationHost },
): ConstructorParameters<typeof DefaultResourceLoader>[0] {
  return {
    cwd: spec.cwd,
    agentDir: opts.agentDir,
    settingsManager: opts.settingsManager,
    noExtensions: true,
    appendSystemPrompt: spec.appendSystemPrompt,
    ...(spec.delegation
      ? {
          extensionFactories: [
            childExtension({
              canDelegate: spec.delegation.canDelegate,
              // In-process SDK children have no PI_SUBAGENTS_CHILD of their own, so the spec is the only source of
              // the record id the host needs to attribute the delegation.
              recordId: spec.delegation.recordId,
              host: opts.host ?? {
                request: async () => {
                  throw new Error("no delegation host is configured for this child session");
                },
              },
            }),
          ],
        }
      : {}),
  };
}

/**
 * Project trust for a child pi starts without -a/-na and without a UI (pi's resolveProjectTrusted is not exported,
 * so this repeats its non-interactive path from the exported pieces): nothing to gate = trusted; otherwise the saved
 * trust.json decision; otherwise the user's defaultProjectTrust, where "ask" cannot be asked and means untrusted.
 */
export function defaultProjectTrust(cwd: string, agentDir: string): boolean {
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const saved = new ProjectTrustStore(agentDir).get(cwd);
  if (saved !== null) return saved;
  // Only the user's (global) settings can set defaultProjectTrust; keep the untrusted project's file out of this read.
  return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
}

function totals(session: AgentSession): Usage {
  const s = session.getSessionStats();
  return { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead, cacheWrite: s.tokens.cacheWrite, cost: s.cost };
}

function delta(after: Usage, before: Usage): Usage {
  return {
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    cost: after.cost - before.cost,
  };
}

/** Exported for tests (driven by a fake AgentSession); production code opens sessions through SdkRunner. */
export class SdkChildSession implements ChildSession {
  private disposed = false;

  constructor(private readonly session: AgentSession) {}

  get alive(): boolean {
    return !this.disposed;
  }

  /** An in-process session never ends on its own. */
  onExit(): () => void {
    return () => {};
  }

  get sessionFile(): string {
    const file = this.session.sessionFile;
    if (!file) throw new Error("child session is not persisted");
    return file;
  }

  get leafId(): string | undefined {
    return this.session.sessionManager.getLeafId() ?? undefined;
  }

  async prompt(text: string): Promise<ChildResult> {
    const before = totals(this.session);
    // This turn's messages come from its own events, not from a slice of `messages`: compaction during the
    // turn rewrites the history, so an index taken before the prompt says nothing afterwards (same as the RPC runner).
    const turn: TurnMessage[] = [];
    let aborted = false;
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") turn.push(event.message);
      else if (event.type === "agent_settled") aborted = event.aborted;
    });
    try {
      await this.session.prompt(text, { source: "extension" });
      await this.session.waitForIdle();
    } finally {
      unsubscribe();
    }
    return { ...turnResult(turn, aborted), usage: delta(totals(this.session), before) };
  }

  async deliver(text: string, mode: "start" | "queue"): Promise<void> {
    // A custom message enters the child's model context as `pi-subagents/child-results`; `start` opens a new turn,
    // `queue` waits for the running one (agent-session.d.ts:607).
    await this.session.sendCustomMessage(
      { customType: "pi-subagents/child-results", content: text, display: true },
      mode === "start" ? { triggerTurn: true } : { deliverAs: "followUp" },
    );
  }

  async steer(text: string, mode: "steer" | "followUp"): Promise<void> {
    if (mode === "steer") await this.session.steer(text);
    else await this.session.followUp(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.session.dispose();
  }
}

export class SdkRunner implements Runner {
  readonly kind = "sdk" as const;

  constructor(private readonly opts: SdkRunnerOptions) {}

  async open(spec: ChildSpec): Promise<ChildSession> {
    const model = this.opts.resolveModel(spec.agent.model);
    if (!model) throw new Error(`cannot resolve model "${spec.agent.model ?? "(inherit)"}" for agent ${spec.agent.name}`);
    // Project settings (shellCommandPrefix, npmCommand, packages, ...) and project resources only load for a trusted
    // project, as in the main session; SettingsManager.create would otherwise trust every project.
    const projectTrusted = spec.projectTrusted ?? this.opts.projectTrusted?.() ?? defaultProjectTrust(spec.cwd, this.opts.agentDir);
    // Same user settings as a normal pi run (and as the RPC runner's child process).
    const settingsManager = SettingsManager.create(spec.cwd, this.opts.agentDir, { projectTrusted });
    const resourceLoader = new DefaultResourceLoader(
      buildLoaderOptions(spec, {
        agentDir: this.opts.agentDir,
        settingsManager,
        ...(this.opts.delegationHost ? { host: this.opts.delegationHost } : {}),
      }),
    );
    await resourceLoader.reload();
    const sessionManager = spec.resumeFile ? SessionManager.open(spec.resumeFile) : SessionManager.create(spec.cwd, spec.sessionDir);
    // Continue from the entry this record last ended on, not from whatever another branch appended later.
    if (spec.resumeLeafId) sessionManager.branch(spec.resumeLeafId);
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: this.opts.agentDir,
      model,
      ...(spec.agent.thinking ? { thinkingLevel: spec.agent.thinking as never } : {}),
      ...(spec.agent.tools ? { tools: spec.agent.tools } : {}),
      sessionManager,
      resourceLoader,
      settingsManager,
      ...(this.opts.modelRuntime ? { modelRuntime: this.opts.modelRuntime } : {}),
    });
    return new SdkChildSession(session);
  }
}
