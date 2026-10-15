import { type Api, createProvider, type Model } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { Usage } from "../registry.ts";
import type { ChildResult, ChildSession, ChildSpec, Runner, StopReason } from "./types.ts";

export type ModelResolver = (spec: string | undefined) => Model<any> | undefined;

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

class SdkChildSession implements ChildSession {
  constructor(private readonly session: AgentSession) {}

  get sessionFile(): string {
    const file = this.session.sessionFile;
    if (!file) throw new Error("child session is not persisted");
    return file;
  }

  async prompt(text: string): Promise<ChildResult> {
    const before = totals(this.session);
    await this.session.prompt(text, { source: "extension" });
    await this.session.waitForIdle();
    const last = [...this.session.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
      | { stopReason?: string; errorMessage?: string }
      | undefined;
    const stopReason = (last?.stopReason ?? "stop") as StopReason;
    return {
      text: this.session.getLastAssistantText() ?? "",
      stopReason,
      ...(last?.errorMessage ? { errorMessage: last.errorMessage } : {}),
      usage: delta(totals(this.session), before),
    };
  }

  async steer(text: string, mode: "steer" | "followUp"): Promise<void> {
    if (mode === "steer") await this.session.steer(text);
    else await this.session.followUp(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async dispose(): Promise<void> {
    this.session.dispose();
  }
}

export class SdkRunner implements Runner {
  readonly kind = "sdk" as const;

  private runtime: ModelRuntime | undefined;

  constructor(private readonly opts: { agentDir: string; resolveModel: ModelResolver; modelRuntime?: ModelRuntime }) {}

  async open(spec: ChildSpec): Promise<ChildSession> {
    const model = this.opts.resolveModel(spec.agent.model);
    if (!model) throw new Error(`cannot resolve model "${spec.agent.model ?? "(inherit)"}" for agent ${spec.agent.name}`);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir: this.opts.agentDir,
      settingsManager,
      noExtensions: true,
      appendSystemPrompt: spec.appendSystemPrompt,
    });
    await resourceLoader.reload();
    const modelRuntime = await this.modelRuntime();
    this.ensureModel(modelRuntime, model);
    const sessionManager = spec.resumeFile ? SessionManager.open(spec.resumeFile) : SessionManager.create(spec.cwd, spec.sessionDir);
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: this.opts.agentDir,
      model,
      ...(spec.agent.thinking ? { thinkingLevel: spec.agent.thinking as never } : {}),
      ...(spec.agent.tools ? { tools: spec.agent.tools } : {}),
      sessionManager,
      resourceLoader,
      settingsManager,
      modelRuntime,
    });
    return new SdkChildSession(session);
  }

  private async modelRuntime(): Promise<ModelRuntime> {
    if (this.opts.modelRuntime) return this.opts.modelRuntime;
    this.runtime ??= await ModelRuntime.create({
      authPath: join(this.opts.agentDir, "auth.json"),
      modelsPath: join(this.opts.agentDir, "models.json"),
    });
    return this.runtime;
  }

  /**
   * A model the runtime does not know (such as a faux provider injected by a test) still needs a
   * provider entry so auth preflight and request dispatch can find it. Bridging to the registered
   * API implementation keeps the model's own transport. Known providers are left untouched.
   */
  private ensureModel(runtime: ModelRuntime, model: Model<any>): void {
    if (runtime.getProvider(model.provider)) return;
    const api = getApiProvider(model.api as Api);
    if (!api) throw new Error(`no API implementation registered for "${String(model.api)}"`);
    runtime.registerNativeProvider(
      createProvider({
        id: model.provider,
        name: model.provider,
        auth: { apiKey: { name: model.provider, resolve: async () => ({ auth: {} }) } },
        models: [model],
        api: { stream: api.stream, streamSimple: api.streamSimple },
      }),
    );
  }
}
