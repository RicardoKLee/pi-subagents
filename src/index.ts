import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { type AgentDef, loadAgents } from "./agents.ts";
import { CHAIN_ENTRY_TYPE, ChainStore } from "./chain.ts";
import { childExtension, childRecordId, type DelegationHost, mailboxHost } from "./child.ts";
import { mentionProvider } from "./complete.ts";
import { PRIVATE_ENTRY_TYPE, type PrivateEntryData } from "./delivery.ts";
import { createNameCache, parseEntryRequest, parseSubCommand, SUB_USAGE, skillNames, templateNames, type EntryRequest } from "./entries.ts";
import { handleRoute } from "./input.ts";
import { SubagentManager } from "./manager.ts";
import { routeMention } from "./mention.ts";
import { recordEntryLabel, REGISTRY_ENTRY_TYPE, Registry, writeSnapshot } from "./registry.ts";
import { RpcRunner } from "./runner/rpc.ts";
import { type ModelResolver, SdkRunner, defaultProjectTrust } from "./runner/sdk.ts";
import type { Runner } from "./runner/types.ts";
import { Scheduler } from "./scheduler.ts";
import { loadSettings, limitAllows, type DeliveryMode, type SubagentSettings } from "./settings.ts";
import { executeAction, SubagentsParams, toolCallInput, type SubagentsInput } from "./tool.ts";
import { pendingReminderText, renderTree, TREE_ENTRY_TYPE, type TreeEntryData, type TreeView } from "./tree.ts";

const PRIVATE_PREVIEW_LINES = 20;

interface State {
  manager: SubagentManager;
  registry: Registry;
  chains: ChainStore;
  ctx: ExtensionContext;
  settings: SubagentSettings;
  /** pi's agent dir: where the agent files and the skill / template directories live. */
  agentDir: string;
  /** Explicit resource paths; first version reads none, so these stay empty (future work). */
  skillPaths: string[];
  promptPaths: string[];
  /** The same loader the manager uses, so `/sub` completion and validation see the same agent set. */
  managerAgents: () => Map<string, AgentDef>;
  snapshotFile?: string;
}

export interface ExtensionOptions {
  /** Defaults to pi's agent dir (~/.pi/agent). Tests point it at a temp dir. */
  agentDir?: string;
  /** Defaults to the in-process SDK runner. Tests inject a fake runner. */
  createRunner?: (resolveModel: ModelResolver) => Runner;
  /** Defaults to the RPC runner (resident `pi --mode rpc` children). Tests inject a fake. */
  createRpcRunner?: (resolveModel: ModelResolver) => Runner;
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
 * Reload the registry (and, when given, the chain store) from a new branch after /tree: keep children that are still
 * running, then pause records the branch left as "running" but that have no live child (e.g. /tree back to a point
 * mid-run). Chains whose steps are still live are restored onto the new branch; the others are dropped. Returns how
 * many records were paused.
 */
export function rebuildForBranch(manager: SubagentManager, registry: Registry, branch: readonly unknown[], chains?: ChainStore): number {
  const active = manager.activeRecords();
  const activeChains = chains ? manager.activeChains() : [];
  registry.reload(branch);
  for (const r of active) registry.restore(r);
  if (chains) {
    chains.reload(branch);
    for (const c of activeChains) chains.restore(c);
  }
  manager.pruneIdle();
  const paused = manager.recoverInterrupted("left running on another branch");
  // The chain entries the branch restored may still say "running" while their steps were just settled; align them so
  // continueChain can resume the stopping step instead of rejecting the chain as busy forever.
  manager.reconcileChains();
  return paused;
}

function writeSnapshotSafely(file: string | undefined, registry: Registry): void {
  if (!file) return;
  try {
    writeSnapshot(file, registry.list());
  } catch {
    // Snapshot is best-effort; the session entries are authoritative.
  }
}

/** Set when this process was started as a subagent: it then loads only the proxy tool (plan 6.9 item 1). */
const CHILD_RECORD = childRecordId();

export function createExtension(opts: ExtensionOptions = {}): (pi: ExtensionAPI) => void {
  if (CHILD_RECORD) {
    // This process was started as a subagent: only the proxy tool, no manager of its own. The host writes into the
    // parent session's mailbox; the parent's manager stays the only scheduler and registry.
    return childExtension({
      canDelegate: process.env.PI_SUBAGENTS_DELEGATE === "1",
      host: mailboxHost(process.env.PI_SUBAGENTS_MAILBOX ?? "", CHILD_RECORD),
    });
  }
  return (pi: ExtensionAPI): void => {
    const agentDir = opts.agentDir ?? getAgentDir();
    let state: State | undefined;
    /** The tool and commands are registered once, at load when enabled or on the first enabled `session_start` otherwise. */
    let capabilitiesRegistered = false;
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
      // A nested child's mailbox lives beside its sibling sessions; without a session dir it follows the temp layout
      // subagentPaths already chose, so a sessionless run still gets an isolated mailbox.
      const mailboxDir = join(childDir, "mailbox");
      const registry = Registry.rebuild(ctx.sessionManager.getBranch(), (record) => {
        pi.appendEntry(REGISTRY_ENTRY_TYPE, record);
        writeSnapshotSafely(snapshotFile, registry);
      });
      const chains = ChainStore.rebuild(ctx.sessionManager.getBranch(), (chain) => pi.appendEntry(CHAIN_ENTRY_TYPE, chain));
      // Normalized once so a non-canonical ctx.cwd still matches the resolved cwd the manager compares against.
      const mainCwd = resolvePath(ctx.cwd);
      const modelWindow = (spec: string | undefined) => resolveModel(state?.ctx ?? ctx, spec)?.contextWindow;
      const modelResolver: ModelResolver = (spec) => resolveModel(state?.ctx ?? ctx, spec);
      // An SDK child runs in this process: its delegation requests go straight to this session's manager. `state` is
      // assigned below, before any child can call; a call that somehow arrives earlier fails loudly instead of
      // silently spawning nothing.
      const delegationHost: DelegationHost = {
        request: (parentRecordId, payload, signal) => {
          const manager = state?.manager;
          if (!manager) throw new Error("pi-subagents is not initialised for this session yet");
          return manager.delegate(parentRecordId, payload, signal);
        },
      };
      const sdk = opts.createRunner
        ? opts.createRunner(modelResolver)
        : new SdkRunner({ agentDir, resolveModel: modelResolver, projectTrusted: () => (state?.ctx ?? ctx).isProjectTrusted?.(), delegationHost });
      const rpc = opts.createRpcRunner
        ? opts.createRpcRunner(modelResolver)
        : new RpcRunner({
            resolveModel: (spec) => {
              const model = modelResolver(spec);
              return model ? { provider: model.provider, id: model.id } : undefined;
            },
            projectTrusted: () => (state?.ctx ?? ctx).isProjectTrusted?.(),
          });
      // Agent files are re-read on every run; the manager and the /sub completion list share one loader.
      const agents = (): Map<string, AgentDef> => {
        const loaded = loadAgents({ userDir: join(agentDir, "agents"), projectDir: join(ctx.cwd, ".pi", "agents"), scope: "user" });
        for (const w of loaded.warnings) warnOnce(w);
        return loaded.agents;
      };
      const manager = new SubagentManager({
        registry,
        chainStore: chains,
        scheduler: new Scheduler(() => settings.maxConcurrent),
        runners: { sdk, rpc },
        agents,
        settings: () => settings,
        port: {
          sendMessage: (message, options) => pi.sendMessage(message, options),
          appendEntry: (type, data) => pi.appendEntry(type, data),
        },
        receiverContextWindow: () => state?.ctx.model?.contextWindow ?? 200000,
        receiverContextWindowFor: (agent) => modelWindow(agent.model),
        cwd: ctx.cwd,
        agentDir,
        sessionDir: childDir,
        outputDir,
        mailboxDir,
        // Trust follows the resolved cwd: the main session's decision only applies to the main cwd. Any other
        // directory gets its own non-interactive decision (never the main session's trust). Both sides are
        // normalized so equivalent spellings of the same directory match without letting a different one through.
        trustForCwd: (cwd) => (resolvePath(cwd) === mainCwd ? (state?.ctx ?? ctx).isProjectTrusted?.() : defaultProjectTrust(cwd, agentDir)),
        onDeliveryError: (record, message) => notify(`result of @${record.handle} was not delivered: ${message}`, "warning"),
        onPendingReminder: (record, count, minutes) =>
          notify(pendingReminderText(record, count, minutes, state?.manager.recordPath(record) ?? record.handle), "warning"),
        onRecordCreated: (record) => {
          if (existsSync(join(ctx.cwd, record.handle))) {
            warnOnce(`@${record.handle} has the same name as a file in ${ctx.cwd}; use @sub:${record.handle} to reach the subagent`);
          }
        },
      });
      state = {
        manager,
        registry,
        chains,
        ctx,
        settings,
        agentDir,
        // Explicit skill / prompt paths from the settings are not read yet (future work); only the default directories.
        skillPaths: [],
        promptPaths: [],
        managerAgents: agents,
        ...(snapshotFile ? { snapshotFile } : {}),
      };
      for (const w of warnings) warnOnce(w);
      const recovered = manager.recoverInterrupted();
      // Reload/restart settled the running steps; bring any chain entry left "running" back in line so it can be continued.
      manager.reconcileChains();
      if (recovered) {
        notify(`${recovered} subagent(s) were cut off by reload/restart: running ones are paused, queued ones were cancelled`, "warning");
      }
      if (ctx.hasUI && completionUi !== ctx.ui) {
        completionUi = ctx.ui;
        ctx.ui.addAutocompleteProvider((current) =>
          mentionProvider(current, () => {
            const manager = state?.manager;
            if (!manager) return [];
            return manager
              .list()
              .map((r) => ({ handle: r.handle, agent: recordEntryLabel(r), status: r.status, clash: fileExists(r.handle), path: r.parentId ? manager.recordPath(r) : undefined }));
          }),
        );
      }
      // A disabled session (maxDepth 0) must not advertise the tool or the `/sub*` commands: they could only fail.
      if (!manager.canStartSubagents()) {
        notify("subagents are disabled (maxDepth is 0)", "warning");
        return;
      }
      if (!capabilitiesRegistered) {
        capabilitiesRegistered = true;
        registerSubagentCapabilities();
      }
    });

    // /tree only fires session_tree: rebuild the registry for the new branch (see rebuildForBranch).
    pi.on("session_tree", (_event, ctx) => {
      if (!state) return;
      const paused = rebuildForBranch(state.manager, state.registry, ctx.sessionManager.getBranch(), state.chains);
      if (paused > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `pi-subagents: ${paused} subagent(s) from another branch were not running: running ones are paused, queued ones were cancelled`,
          "warning",
        );
      }
      writeSnapshotSafely(state.snapshotFile, state.registry);
    });

    // `@handle message` in the TUI goes straight to the subagent; everything else (and other sources) passes through.
    pi.on("input", async (event, ctx) => {
      if (!state || event.source !== "interactive" || !ctx.hasUI) return { action: "continue" };
      // The session context is captured once, but `/model` changes the current model: refresh it before routing.
      state.ctx = ctx;
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

    // /subagents list|cost: a display-only tree entry; custom entries never enter the LLM context.
    pi.registerEntryRenderer<TreeEntryData>(TREE_ENTRY_TYPE, (entry, _options, theme) => {
      const data = entry.data;
      if (!data) return undefined;
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(theme.fg("accent", data.view === "cost" ? "[subagents cost]" : "[subagents]"), 0, 0));
      box.addChild(new Text(data.text, 0, 0));
      return box;
    });

    pi.on("session_shutdown", async () => {
      await state?.manager.shutdown();
      await state?.manager.whenIdle();
    });

    /**
     * Registers the `subagents` tool and the `/sub*` commands. Called at load time and, when load-time settings were
     * disabled, from an enabled `session_start`; a disabled session (`maxDepth: 0`) advertises neither.
     */
    function registerSubagentCapabilities(): void {
      const VIEWS: TreeView[] = ["list", "cost"];
      pi.registerCommand("subagents", {
        description: "Show subagents as a tree: /subagents [list|cost]",
        getArgumentCompletions: (prefix) =>
          VIEWS.filter((v) => v.startsWith(prefix.trim().toLowerCase())).map((v) => ({ value: v, label: v, description: v === "list" ? "status and cost" : "tokens and cost" })),
        handler: async (args, ctx) => {
          if (state) state.ctx = ctx;
          const raw = args.trim();
          const view = (raw.toLowerCase() || "list") as TreeView;
          if (!VIEWS.includes(view)) {
            // A leading "/" usually means two commands were typed on one line (e.g. "/subagents /debug-agent").
            const hint = raw.includes("/") ? `${raw} was not run; type it on its own line` : "use /subagents list or /subagents cost";
            ctx.ui.notify(`pi-subagents: unknown view "${raw}"; ${hint}`, "error");
            return;
          }
          pi.appendEntry<TreeEntryData>(TREE_ENTRY_TYPE, { view, text: renderTree(state?.registry.list() ?? [], view, state?.manager.listChains() ?? []) });
        },
      });
      // `/sub` creates a subagent without going through the main model; the symbol in the command name picks the delivery.
      const SUB_COMMANDS: { name: string; delivery?: DeliveryMode }[] = [
        { name: "sub" },
        { name: "sub!", delivery: "auto" },
        { name: "sub~", delivery: "share" },
        { name: "sub?", delivery: "private" },
      ];
      for (const command of SUB_COMMANDS) {
        pi.registerCommand(command.name, {
          description: `Create a subagent (${command.delivery ?? "settings defaultDelivery"}): /${command.name} [--cwd <dir>] <agent> | /skill:<name> | /<template> [args]`,
          getArgumentCompletions: (prefix) => subCompletions(prefix, state),
          handler: async (args, ctx) => {
            const current = state;
            if (!current) {
              ctx.ui.notify("pi-subagents: not initialised for this session yet", "error");
              return;
            }
            // Refresh the captured context so a `/model` switch made just before `/sub` reaches the child.
            current.ctx = ctx;
            const parsed = parseSubCommand(args);
            if ("error" in parsed) {
              ctx.ui.notify(`pi-subagents: ${parsed.error}`, "error");
              return;
            }
            const delivery = command.delivery ?? current.settings.defaultDelivery;
            try {
              const request: EntryRequest =
                parsed.target.kind === "agent"
                  ? { agent: parsed.target.name }
                  : parsed.target.kind === "skill"
                    ? { skill: parsed.target.name }
                    : { command: parsed.target.name };
              if (parsed.rest) request.task = parsed.rest;
              const entry = parseEntryRequest(request, command.name);
              const { record } = await current.manager.run({
                ...request,
                ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
                delivery,
                background: true,
                ask: entry.prompt,
              });
              const label = entry.kind === "agent" ? entry.name : `${entry.kind}:${entry.name}`;
              ctx.ui.notify(`pi-subagents: 已创建 @${record.handle}（${label} · ${delivery}）；结果会自动送达`, "info");
            } catch (error) {
              ctx.ui.notify(`pi-subagents: ${(error as Error).message}`, "error");
            }
          },
        });
      }

      pi.registerTool({
        name: "subagents",
        label: "Subagents",
        description:
          "Delegate work to named, persistent subagents. action=run starts a new one from exactly one entry — agent (needs task), skill or command — and returns its @handle. " +
          "action=parallel runs many at once; chain runs steps in order, where {previous} is the previous step's output; continue resumes the step that stopped a chain and finishes it. " +
          "action=resume continues an existing one in its own context (handle + message); prefer it when the user wants the same subagent to revise its work. " +
          "action=steer guides a running one; interrupt pauses; stop ends it (and every descendant); list shows all; " +
          "action=drain hands a paused parent's waiting child results to the caller; action=drop discards them.",
        parameters: SubagentsParams,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          if (!state) throw new Error("pi-subagents is not initialised for this session yet");
          state.ctx = ctx;
          // The model's arguments never carry the internal delegation parent: `toolCallInput` drops a stray copy so
          // the main session always dispatches as the depth-0 requester with no whitelist.
          const out = await executeAction(state.manager, toolCallInput(params as SubagentsInput), signal);
          return { content: [{ type: "text", text: out.text }], details: out.details };
        },
      });
    }

    // Register at load time so a freshly loaded extension is usable without waiting for `session_start`; the settings
    // file is the same one `session_start` reloads, so `maxDepth: 0` hides the surface from the start. A session that
    // turns out enabled later (the file was fixed between load and start) registers on `session_start` instead.
    if (limitAllows(loadSettings(join(agentDir, "subagents.json")).settings.maxDepth, 0)) {
      capabilitiesRegistered = true;
      registerSubagentCapabilities();
    }
  };
}

export default createExtension();

/** Directory scans behind the completions run on every keystroke; cache them per cwd and agent dir. */
const completionNames = createNameCache();

/** Agents, skills and templates the current session can start. */
function subCompletions(prefix: string, state: State | undefined): AutocompleteItem[] {
  if (!state) return [];
  const ctx = {
    cwd: state.ctx.cwd,
    agentDir: state.agentDir,
    agents: state.managerAgents(),
    skillPaths: state.skillPaths,
    promptPaths: state.promptPaths,
  };
  const startable = completionNames.names(`${ctx.agentDir}\u0000${ctx.cwd}`, () => [
    ...skillNames(ctx).map((name) => `/skill:${name}`),
    ...templateNames(ctx).map((name) => `/${name}`),
  ]);
  const items: AutocompleteItem[] = [
    ...[...ctx.agents.keys()].map((name) => ({ value: name, label: name, description: "agent" })),
    ...startable.map((value) => ({ value, label: value, description: value.startsWith("/skill:") ? "skill" : "prompt template" })),
  ];
  const token = prefix.trim();
  return items.filter((item) => item.value.startsWith(token)).slice(0, 50);
}
