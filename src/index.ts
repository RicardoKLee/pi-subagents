import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadAgents } from "./agents.ts";
import { stripPrivateMessages } from "./delivery.ts";
import { SubagentManager } from "./manager.ts";
import { REGISTRY_ENTRY_TYPE, Registry, writeSnapshot } from "./registry.ts";
import { SdkRunner } from "./runner/sdk.ts";
import { Scheduler } from "./scheduler.ts";
import { loadSettings, type SubagentSettings } from "./settings.ts";
import { executeAction, SubagentsParams, type SubagentsInput } from "./tool.ts";

interface State {
  manager: SubagentManager;
  registry: Registry;
  ctx: ExtensionContext;
  settings: SubagentSettings;
}

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  let state: State | undefined;

  function resolveModel(ctx: ExtensionContext, spec: string | undefined) {
    if (!spec) return ctx.model;
    const slash = spec.indexOf("/");
    if (slash > 0) return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
    return ctx.model ? ctx.modelRegistry.find(ctx.model.provider, spec) : undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    const { settings, warnings } = loadSettings(join(agentDir, "subagents.json"));
    const sessionDir = ctx.sessionManager.getSessionDir();
    const snapshotFile = join(sessionDir, `${ctx.sessionManager.getSessionId()}.subagents.json`);
    const registry = Registry.rebuild(ctx.sessionManager.getBranch(), (record) => {
      pi.appendEntry(REGISTRY_ENTRY_TYPE, record);
      try {
        writeSnapshot(snapshotFile, registry.list());
      } catch {
        // Snapshot is best-effort; the session entries are authoritative.
      }
    });
    const manager = new SubagentManager({
      registry,
      scheduler: new Scheduler(() => settings.maxConcurrent),
      runners: { sdk: new SdkRunner({ agentDir, resolveModel: (spec) => resolveModel(state!.ctx, spec) }), rpc: undefined },
      agents: () => {
        const loaded = loadAgents({ userDir: join(agentDir, "agents"), projectDir: join(ctx.cwd, ".pi", "agents"), scope: "user" });
        for (const w of loaded.warnings) console.error(`[pi-subagents] ${w}`);
        return loaded.agents;
      },
      settings: () => settings,
      port: { sendMessage: (message, options) => pi.sendMessage(message, options) },
      receiverContextWindow: () => state?.ctx.model?.contextWindow ?? 200000,
      cwd: ctx.cwd,
      sessionDir: join(sessionDir, "subagents"),
      outputDir: join(sessionDir, "subagents", "outputs"),
    });
    state = { manager, registry, ctx, settings };
    const recovered = manager.recoverInterrupted();
    const notes = [...warnings, ...(recovered ? [`${recovered} subagent(s) were cut off by reload/restart and are now paused`] : [])];
    if (ctx.hasUI) for (const n of notes) ctx.ui.notify(`pi-subagents: ${n}`, "warning");
  });

  // Private results stay visible in the transcript but never reach the model.
  pi.on("context", (event) => ({ messages: stripPrivateMessages(event.messages) }));

  pi.on("session_shutdown", async () => {
    await state?.manager.interruptAll();
    await state?.manager.whenIdle();
  });

  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description:
      "Delegate work to named, persistent subagents. action=run starts a new one (agent + task) and returns its @handle. " +
      "action=resume continues an existing one in its own context (handle + message); prefer it when the user wants the same subagent to revise its work. " +
      "action=steer guides a running one; interrupt pauses; stop ends it permanently; list shows all.",
    parameters: SubagentsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) throw new Error("pi-subagents is not initialised for this session yet");
      state.ctx = ctx;
      const out = await executeAction(state.manager, params as SubagentsInput);
      return { content: [{ type: "text", text: out.text }], details: out.details };
    },
  });
}
