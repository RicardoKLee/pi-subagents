import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { loadAgents } from "./agents.ts";
import { PRIVATE_ENTRY_TYPE, type PrivateEntryData } from "./delivery.ts";
import { SubagentManager } from "./manager.ts";
import { REGISTRY_ENTRY_TYPE, Registry, writeSnapshot } from "./registry.ts";
import { SdkRunner } from "./runner/sdk.ts";
import { Scheduler } from "./scheduler.ts";
import { loadSettings, type SubagentSettings } from "./settings.ts";
import { executeAction, SubagentsParams, type SubagentsInput } from "./tool.ts";

const PRIVATE_PREVIEW_LINES = 20;

interface State {
  manager: SubagentManager;
  registry: Registry;
  ctx: ExtensionContext;
  settings: SubagentSettings;
  snapshotFile?: string;
}

/** Where child sessions, large outputs and the snapshot live; sessionless (in-memory) sessions use a temp dir and no snapshot. */
export function subagentPaths(sessionDir: string, sessionId: string): { childDir: string; outputDir: string; snapshotFile?: string } {
  if (sessionDir) {
    return {
      childDir: join(sessionDir, "subagents"),
      outputDir: join(sessionDir, "subagents", "outputs"),
      snapshotFile: join(sessionDir, `${sessionId}.subagents.json`),
    };
  }
  const base = join(tmpdir(), "pi-subagents", sessionId);
  return { childDir: join(base, "sessions"), outputDir: join(base, "outputs") };
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
    const { childDir, outputDir, snapshotFile } = subagentPaths(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
    const registry = Registry.rebuild(ctx.sessionManager.getBranch(), (record) => {
      pi.appendEntry(REGISTRY_ENTRY_TYPE, record);
      if (!snapshotFile) return;
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
      port: {
        sendMessage: (message, options) => pi.sendMessage(message, options),
        appendEntry: (type, data) => pi.appendEntry(type, data),
      },
      receiverContextWindow: () => state?.ctx.model?.contextWindow ?? 200000,
      cwd: ctx.cwd,
      sessionDir: childDir,
      outputDir,
    });
    state = { manager, registry, ctx, settings, ...(snapshotFile ? { snapshotFile } : {}) };
    const recovered = manager.recoverInterrupted();
    const notes = [...warnings, ...(recovered ? [`${recovered} subagent(s) were cut off by reload/restart and are now paused`] : [])];
    if (ctx.hasUI) for (const n of notes) ctx.ui.notify(`pi-subagents: ${n}`, "warning");
  });

  // /tree only fires session_tree: reload the registry from the new branch, keeping children that are still running.
  pi.on("session_tree", (_event, ctx) => {
    if (!state) return;
    const active = state.manager.activeRecords();
    state.registry.reload(ctx.sessionManager.getBranch());
    for (const r of active) state.registry.restore(r);
    if (!state.snapshotFile) return;
    try {
      writeSnapshot(state.snapshotFile, state.registry.list());
    } catch {
      // Snapshot is best-effort; the session entries are authoritative.
    }
  });

  // Private results are custom entries: shown in the TUI only, never part of the LLM context.
  pi.registerEntryRenderer<PrivateEntryData>(PRIVATE_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const lines = data.text.split("\n");
    const shown = expanded || lines.length <= PRIVATE_PREVIEW_LINES ? lines : lines.slice(0, PRIVATE_PREVIEW_LINES);
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${theme.fg("accent", "[subagent private]")} @${data.handle} ${data.status}`, 0, 0));
    box.addChild(new Text(shown.join("\n"), 0, 0));
    if (shown.length < lines.length) box.addChild(new Text(theme.fg("dim", `… ${lines.length - shown.length} more lines (expand to show)`), 0, 0));
    return box;
  });

  pi.on("session_shutdown", async () => {
    await state?.manager.shutdown();
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!state) throw new Error("pi-subagents is not initialised for this session yet");
      state.ctx = ctx;
      const out = await executeAction(state.manager, params as SubagentsInput, signal);
      return { content: [{ type: "text", text: out.text }], details: out.details };
    },
  });
}
