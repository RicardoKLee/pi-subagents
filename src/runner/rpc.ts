import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Usage } from "../registry.ts";
import { turnResult, type TurnMessage } from "./result.ts";
import { ABORT_TIMEOUT_MS, READY_TIMEOUT_MS, RpcProcess } from "./rpc-process.ts";
import type { ChildResult, ChildSession, ChildSpec, Runner } from "./types.ts";

export const LEAF_PIN_ENTRY_TYPE = "pi-subagents/leaf-pin";
const CLI_SUFFIX = join("@earendil-works", "pi-coding-agent", "dist", "cli.js");
/** This extension's entry point, loaded by a nested child with `-ne -e <entry>` (plan 6.9 item 12). `rpc.ts` lives in `src/runner/`, so the entry is one directory up. */
const EXTENSION_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));

/** pi's CLI entry point for child processes (prefer the pi that is running this extension). */
export function piCliPath(): string {
  const override = process.env.PI_SUBAGENTS_PI_CLI;
  if (override) return override;
  try {
    const running = process.argv[1] ? realpathSync(process.argv[1]) : "";
    if (running.endsWith(CLI_SUFFIX)) return running;
  } catch {
    // argv[1] may not be a file (e.g. a test runner)
  }
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const cli = join(dirname(entry), "cli.js");
    if (existsSync(cli)) return cli;
  } catch {
    // import.meta.resolve is unavailable under some loaders
  }
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const cli = join(dir, "node_modules", CLI_SUFFIX);
    if (existsSync(cli)) return cli;
    if (dirname(dir) === dir) break;
  }
  throw new Error("cannot find pi's cli.js for the RPC runner; set PI_SUBAGENTS_PI_CLI to its path");
}

/** CLI arguments for one RPC child (see 6.6 item 4). */
export function buildRpcArgs(spec: ChildSpec, model: string, opts: { trusted?: boolean; extraArgs?: string[] }): string[] {
  const args = [
    "--mode",
    "rpc",
    ...(spec.resumeFile ? ["--session", spec.resumeFile] : ["--session-dir", spec.sessionDir]),
    "-ne",
    // `-ne` disables automatic discovery; an explicit `-e` still loads (docs/cli.md:196), which is how a nested
    // child gets the proxy tool without the parent's other extensions.
    ...(spec.delegation ? ["-e", EXTENSION_ENTRY] : []),
    "--model",
    model,
  ];
  if (spec.agent.thinking) args.push("--thinking", spec.agent.thinking);
  if (spec.agent.tools) args.push(...(spec.agent.tools.length ? ["--tools", spec.agent.tools.join(",")] : ["--no-tools"]));
  for (const text of spec.appendSystemPrompt) args.push("--append-system-prompt", text);
  if (opts.trusted !== undefined) args.push(opts.trusted ? "-a" : "-na");
  return [...args, ...(opts.extraArgs ?? [])];
}

/**
 * The environment a nested RPC child needs to know who it is: its record id, depth, whether it may spawn, and the
 * parent session's mailbox. Empty for a child that cannot delegate, so an ordinary child keeps the parent's env.
 */
export function buildRpcEnv(spec: ChildSpec): Record<string, string> {
  if (!spec.delegation) return {};
  return {
    PI_SUBAGENTS_CHILD: spec.delegation.recordId,
    PI_SUBAGENTS_DEPTH: String(spec.delegation.depth),
    PI_SUBAGENTS_DELEGATE: spec.delegation.canDelegate ? "1" : "0",
    ...(spec.delegation.mailboxDir ? { PI_SUBAGENTS_MAILBOX: spec.delegation.mailboxDir } : {}),
  };
}

/**
 * Makes `leafId` the point a child process continues from: pi opens a session at its last entry, so append a
 * custom entry (never sent to the model) under the pinned leaf. No-op when the leaf is already last.
 * Only call it while no process has the file open.
 */
export function pinLeaf(sessionFile: string, leafId: string): boolean {
  const sm = SessionManager.open(sessionFile);
  if (sm.getLeafId() === leafId) return false;
  sm.branch(leafId);
  sm.appendCustomEntry(LEAF_PIN_ENTRY_TYPE, { leafId });
  return true;
}

interface RpcStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
}

class RpcChildSession implements ChildSession {
  private disposed = false;
  private leaf: string | undefined;

  constructor(
    private readonly proc: RpcProcess,
    readonly sessionFile: string,
    initialLeaf: string | undefined,
  ) {
    this.leaf = initialLeaf;
  }

  get alive(): boolean {
    return !this.disposed && this.proc.alive;
  }

  get leafId(): string | undefined {
    return this.leaf;
  }

  onExit(listener: (reason: string) => void): () => void {
    return this.proc.onExit(listener);
  }

  async prompt(text: string): Promise<ChildResult> {
    const before = await this.stats();
    const messages: TurnMessage[] = [];
    let unsubscribe = () => {};
    const settled = new Promise<boolean>((resolve) => {
      unsubscribe = this.proc.onEvent((event) => {
        if (event.type === "message_end") messages.push(event.message as TurnMessage);
        if (event.type === "agent_settled") resolve(event.aborted === true);
      });
    });
    try {
      const response = await this.proc.request<{ disposition?: string }>({ type: "prompt", message: text });
      if (response?.disposition === "handled") {
        return { text: "", stopReason: "error", errorMessage: "prompt was handled without a run", usage: zero() };
      }
      // A child that dies mid-turn never settles; surface its exit reason instead of waiting forever.
      const aborted = await Promise.race([
        settled,
        this.proc.exited.then(() => {
          throw new Error(this.proc.exitReason ?? "child process exited");
        }),
      ]);
      const usage = diff(await this.stats(), before);
      await this.refreshLeaf();
      return { ...turnResult(messages, aborted), usage };
    } finally {
      unsubscribe();
    }
  }

  async deliver(text: string, mode: "start" | "queue"): Promise<void> {
    // The parent direction never uses the mailbox: pi's own RPC commands inject the result (plan 6.9 item 1).
    // An idle parent starts a turn with `prompt`; a running one queues the message with `follow_up`.
    if (mode === "start") await this.proc.request({ type: "prompt", message: text });
    else await this.proc.request({ type: "follow_up", message: text });
  }

  async steer(text: string, mode: "steer" | "followUp"): Promise<void> {
    await this.proc.request({ type: mode === "steer" ? "steer" : "follow_up", message: text });
  }

  async abort(): Promise<void> {
    await this.proc.request({ type: "abort" }, ABORT_TIMEOUT_MS);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.proc.close();
  }

  private async stats(): Promise<Usage> {
    const s = await this.proc.request<RpcStats>({ type: "get_session_stats" });
    return { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead, cacheWrite: s.tokens.cacheWrite, cost: s.cost };
  }

  /**
   * The child's leaf after a turn. If it cannot be read the last known value is kept: a slightly stale pin is far
   * better than an unknown one, which would silently drop this turn on the next restart.
   */
  private async refreshLeaf(): Promise<void> {
    try {
      const since = this.leaf ? { since: this.leaf } : {};
      this.leaf = (await this.proc.request<{ leafId: string | null }>({ type: "get_entries", ...since })).leafId ?? this.leaf;
    } catch {
      try {
        this.leaf = (await this.proc.request<{ leafId: string | null }>({ type: "get_entries" })).leafId ?? this.leaf;
      } catch {
        // Keep the previous leaf.
      }
    }
  }
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

function diff(after: Usage, before: Usage): Usage {
  return {
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    cost: after.cost - before.cost,
  };
}

export interface RpcRunnerOptions {
  /** Resolves an agent's model spec (undefined = inherit the main session's) to provider and id. */
  resolveModel: (spec: string | undefined) => { provider: string; id: string } | undefined;
  /** Defaults to piCliPath(). */
  cliPath?: string;
  /** Sets PI_CODING_AGENT_DIR for the child (tests); production children inherit the parent's environment. */
  agentDir?: string;
  env?: Record<string, string>;
  /** Appended after the regular arguments (tests load the scripted provider here). */
  extraArgs?: string[];
  /** The main session's project trust; undefined lets the child decide. */
  projectTrusted?: () => boolean | undefined;
  commandTimeoutMs?: number;
}

/** Children run as resident `pi --mode rpc` processes (see 6.6). */
export class RpcRunner implements Runner {
  readonly kind = "rpc" as const;

  constructor(private readonly opts: RpcRunnerOptions) {}

  async open(spec: ChildSpec): Promise<ChildSession> {
    const model = this.opts.resolveModel(spec.agent.model);
    if (!model) throw new Error(`cannot resolve model "${spec.agent.model ?? "(inherit)"}" for agent ${spec.agent.name}`);
    if (spec.resumeFile && spec.resumeLeafId) pinLeaf(spec.resumeFile, spec.resumeLeafId);
    const trusted = spec.projectTrusted ?? this.opts.projectTrusted?.();
    const proc = new RpcProcess({
      cliPath: this.opts.cliPath ?? piCliPath(),
      args: buildRpcArgs(spec, `${model.provider}/${model.id}`, { ...(trusted !== undefined ? { trusted } : {}), ...(this.opts.extraArgs ? { extraArgs: this.opts.extraArgs } : {}) }),
      cwd: spec.cwd,
      env: { ...this.opts.env, ...(this.opts.agentDir ? { PI_CODING_AGENT_DIR: this.opts.agentDir } : {}), ...buildRpcEnv(spec) },
      ...(this.opts.commandTimeoutMs ? { commandTimeoutMs: this.opts.commandTimeoutMs } : {}),
    });
    try {
      // Readiness probe; also tells us where the child writes its session.
      const state = await proc.request<{ sessionFile?: string }>({ type: "get_state" }, READY_TIMEOUT_MS);
      if (!state?.sessionFile) throw new Error("child session is not persisted");
      return new RpcChildSession(proc, state.sessionFile, spec.resumeLeafId);
    } catch (error) {
      await proc.close();
      throw error;
    }
  }
}
