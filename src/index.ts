import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { loadAgents } from "./agents.ts";
import { mentionProvider } from "./complete.ts";
import { PRIVATE_ENTRY_TYPE, type PrivateEntryData } from "./delivery.ts";
import { handleRoute } from "./input.ts";
import { SubagentManager } from "./manager.ts";
import { routeMention } from "./mention.ts";
import { REGISTRY_ENTRY_TYPE, Registry, writeSnapshot } from "./registry.ts";
import { type ModelResolver, SdkRunner } from "./runner/sdk.ts";
import type { Runner } from "./runner/types.ts";
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

export interface ExtensionOptions {
  /** Defaults to pi's agent dir (~/.pi/agent). Tests point it at a temp dir. */
  agentDir?: string;
  /** Defaults to the in-process SDK runner. Tests inject a fake runner. */
  createRunner?: (resolveModel: ModelResolver) => Runner;
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

/**
 * Reload the registry from a new branch after /tree: keep children that are still running, then pause records the
 * branch left as "running" but that have no live child (e.g. /tree back to a point mid-run). Returns how many were paused.
 */
export function rebuildForBranch(manager: SubagentManager, registry: Registry, branch: readonly unknown[]): number {
  const active = manager.activeRecords();
  registry.reload(branch);
  for (const r of active) registry.restore(r);
  return manager.recoverInterrupted("left running on another branch");
}

function writeSnapshotSafely(file: string | undefined, registry: Registry): void {
  if (!file) return;
  try {
    writeSnapshot(file, registry.list());
  } catch {
    // Snapshot is best-effort; the session entries are authoritative.
  }
}

export function createExtension(opts: ExtensionOptions = {}): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    const agentDir = opts.agentDir ?? getAgentDir();
    let state: State | undefined;
    /** The UI the autocomplete wrapper was installed on; pi resets wrappers when it rebuilds the extension UI. */
    let completionUi: unknown;
    const fileExists = (raw: string) => {
      const cwd = state?.ctx.cwd;
      return !!cwd && !isAbsolute(raw) && existsSync(resolvePath(cwd, raw));
    };

    function resolveModel(ctx: ExtensionContext, spec: string | undefined) {
      if (!spec) return ctx.model;
      const slash = spec.indexOf("/");
      if (slash > 0) return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
      return ctx.model ? ctx.modelRegistry.find(ctx.model.provider, spec) : undefined;
    }

    pi.on("session_start", async (_event, ctx) => {
      // Notify through the TUI when there is one; print/RPC modes have no UI, so fall back to stderr there.
      const notify = (message: string, type: "info" | "warning" | "error" = "warning") => {
        const text = `pi-subagents: ${message}`;
        try {
          if (ctx.hasUI) ctx.ui.notify(text, type);
          else console.error(text);
        } catch {
          // A stale context after shutdown must not break the caller.
        }
      };
      // Agent files are re-read on every run; report each distinct problem once per session.
      const shown = new Set<string>();
      const warnOnce = (message: string) => {
        if (shown.has(message)) return;
        shown.add(message);
        notify(message, "warning");
      };

      const { settings, warnings } = loadSettings(join(agentDir, "subagents.json"));
      const { childDir, outputDir, snapshotFile } = subagentPaths(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
      const registry = Registry.rebuild(ctx.sessionManager.getBranch(), (record) => {
        pi.appendEntry(REGISTRY_ENTRY_TYPE, record);
        writeSnapshotSafely(snapshotFile, registry);
      });
      const modelResolver: ModelResolver = (spec) => resolveModel(state?.ctx ?? ctx, spec);
      const sdk = opts.createRunner ? opts.createRunner(modelResolver) : new SdkRunner({ agentDir, resolveModel: modelResolver });
      const manager = new SubagentManager({
        registry,
        scheduler: new Scheduler(() => settings.maxConcurrent),
        runners: { sdk, rpc: undefined },
        agents: () => {
          const loaded = loadAgents({ userDir: join(agentDir, "agents"), projectDir: join(ctx.cwd, ".pi", "agents"), scope: "user" });
          for (const w of loaded.warnings) warnOnce(w);
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
        onDeliveryError: (record, message) => notify(`result of @${record.handle} was not delivered: ${message}`, "warning"),
        onRecordCreated: (record) => {
          if (existsSync(join(ctx.cwd, record.handle))) {
            warnOnce(`@${record.handle} has the same name as a file in ${ctx.cwd}; use @sub:${record.handle} to reach the subagent`);
          }
        },
      });
      state = { manager, registry, ctx, settings, ...(snapshotFile ? { snapshotFile } : {}) };
      for (const w of warnings) warnOnce(w);
      const recovered = manager.recoverInterrupted();
      if (recovered) notify(`${recovered} subagent(s) were cut off by reload/restart and are now paused`, "warning");
      if (ctx.hasUI && completionUi !== ctx.ui) {
        completionUi = ctx.ui;
        ctx.ui.addAutocompleteProvider((current) =>
          mentionProvider(current, () =>
            (state?.registry.list() ?? []).map((r) => ({ handle: r.handle, agent: r.agent, status: r.status, clash: fileExists(r.handle) })),
          ),
        );
      }
    });

    // /tree only fires session_tree: rebuild the registry for the new branch (see rebuildForBranch).
    pi.on("session_tree", (_event, ctx) => {
      if (!state) return;
      const paused = rebuildForBranch(state.manager, state.registry, ctx.sessionManager.getBranch());
      if (paused > 0 && ctx.hasUI) {
        ctx.ui.notify(`pi-subagents: ${paused} subagent(s) from another branch were not running and are now paused`, "warning");
      }
      writeSnapshotSafely(state.snapshotFile, state.registry);
    });

    // `@handle message` in the TUI goes straight to the subagent; everything else (and other sources) passes through.
    pi.on("input", async (event, ctx) => {
      if (!state || event.source !== "interactive" || !ctx.hasUI) return { action: "continue" };
      const current = state;
      const route = routeMention(event.text, {
        resolve: (handle) => current.registry.resolve(handle),
        known: () => current.registry.list().map((r) => r.handle),
        fileExists,
        defaultDelivery: current.settings.defaultDelivery,
      });
      const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
        try {
          ctx.ui.notify(`pi-subagents: ${message}`, type);
        } catch {
          // A stale context after shutdown must not break a background callback.
        }
      };
      return handleRoute(route, { manager: current.manager, notify, images: Boolean(event.images?.length) });
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
  };
}

export default createExtension();
