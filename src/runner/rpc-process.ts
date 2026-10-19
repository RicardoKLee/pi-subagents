import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";

export const COMMAND_TIMEOUT_MS = 30_000;
export const ABORT_TIMEOUT_MS = 60_000;
export const READY_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUTS_MS = { stdin: 3_000, term: 2_000 };
/** After the process has exited, wait this long for "close" to drain stderr before forcing it. */
const CLOSE_DRAIN_GRACE_MS = 500;
const STDERR_TAIL_CHARS = 2_048;

export interface RpcProcessOptions {
  /** Script run with the current node (process.execPath), normally pi's dist/cli.js. */
  cliPath: string;
  args: string[];
  cwd: string;
  /** Added to process.env. */
  env?: Record<string, string>;
  commandTimeoutMs?: number;
  closeTimeoutsMs?: { stdin: number; term: number };
}

type RpcEvent = { type: string; [key: string]: unknown };
/** pi's RpcCommand (its id is assigned here), or any other command a test server or a newer pi understands. */
type RpcRequest = RpcCommand | { type: string; [key: string]: unknown };
export type CloseStage = "exited" | "stdin" | "sigterm" | "sigkill";

interface Pending {
  type: string;
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * One `pi --mode rpc` child: strict LF-delimited JSONL (never readline, which also splits on U+2028/U+2029),
 * responses correlated by id, events forwarded, stderr kept as a short tail for error messages.
 */
export class RpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(event: RpcEvent) => void>();
  private readonly exitListeners = new Set<(reason: string) => void>();
  private nextId = 0;
  private stderrTail = "";
  private reason?: string;
  private exitStatus?: { code: number | null; signal: NodeJS.Signals | null };
  private closing?: Promise<CloseStage>;
  private drainTimer?: NodeJS.Timeout;
  /** Resolves once the child has gone (exit, start failure, or close). */
  readonly exited: Promise<void>;

  constructor(private readonly opts: RpcProcessOptions) {
    this.child = spawn(process.execPath, [opts.cliPath, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // StringDecoder holds back a multi-byte character cut across chunks instead of emitting U+FFFD.
    const stdoutDecoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += stdoutDecoder.write(chunk);
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (line) this.handleLine(line);
      }
    });
    const stderrDecoder = new StringDecoder("utf8");
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + stderrDecoder.write(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    // Writing to a child that already died raises EPIPE on stdin; the exit handler reports it.
    this.child.stdin.on("error", () => {});
    this.exited = new Promise<void>((resolve) => {
      this.child.on("error", (error) => {
        // Only a spawn failure ends the child here (no pid); other errors (e.g. a failed kill) are followed by "close".
        if (this.child.pid !== undefined) return;
        this.markExited(`child process failed to start: ${error.message}`);
        resolve();
      });
      // "exit" is the death signal; "close" waits for every inherited stdio fd, so a live descendant
      // holding stdout or stderr must not keep exited pending.
      this.child.once("exit", (code, signal) => {
        this.exitStatus = { code, signal };
        const grace = CLOSE_DRAIN_GRACE_MS;
        this.drainTimer = setTimeout(() => {
          this.child.stdout.destroy();
          this.child.stderr.destroy();
          this.markExited(this.exitBase());
          resolve();
        }, grace);
        this.drainTimer.unref();
      });
      // "close" fires after stdio is drained, so the stderr tail is complete.
      this.child.once("close", () => {
        if (this.drainTimer) clearTimeout(this.drainTimer);
        this.markExited(this.exitBase());
        resolve();
      });
    });
  }

  get alive(): boolean {
    return this.reason === undefined;
  }

  get exitReason(): string | undefined {
    return this.reason;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Called when the child ends on its own; not called for an exit caused by close(). */
  onExit(listener: (reason: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Sends one command and resolves with the response's data; rejects on failure, timeout or exit. */
  request<T = unknown>(command: RpcRequest, timeoutMs = this.opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS): Promise<T> {
    if (this.reason !== undefined) return Promise.reject(new Error(this.reason));
    const id = `r${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${command.type} timed out after ${timeoutMs}ms`));
        // A child that stops answering is treated as hung: kill it; the exit handler reports the rest.
        this.child.kill("SIGKILL");
      }, timeoutMs);
      this.pending.set(id, { type: command.type, resolve: resolve as (data: unknown) => void, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  /**
   * Orderly shutdown: close stdin, then SIGTERM, then SIGKILL. Returns the stage that ended the child.
   * Idempotent: calls while a shutdown is in flight share it; once the child is gone it returns "exited" at once.
   */
  close(): Promise<CloseStage> {
    if (this.reason !== undefined) return Promise.resolve("exited");
    if (this.closing) return this.closing;
    this.closing = this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<CloseStage> {
    const timeouts = this.opts.closeTimeoutsMs ?? CLOSE_TIMEOUTS_MS;
    const waitFor = (ms: number) => {
      let timer: NodeJS.Timeout;
      return Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), ms);
          timer.unref();
        }),
      ]).finally(() => clearTimeout(timer));
    };
    this.child.stdin.end();
    if (await waitFor(timeouts.stdin)) return "stdin";
    // A descendant can keep the stdio pipe open after the child is already dead; don't signal a corpse.
    if (this.exitStatus) return "stdin";
    this.child.kill("SIGTERM");
    if (await waitFor(timeouts.term)) return "sigterm";
    if (this.exitStatus) return "sigterm";
    this.child.kill("SIGKILL");
    // The post-exit drain grace is the bound; never wait on an inherited stdio fd forever.
    await waitFor((CLOSE_DRAIN_GRACE_MS) + 1_000);
    return "sigkill";
  }

  private handleLine(line: string): void {
    let record: RpcResponse | RpcEvent;
    try {
      record = JSON.parse(line);
    } catch {
      return; // stdout is protocol-only; ignore anything that is not a record
    }
    // null, numbers, strings and arrays parse but are not records; drop them instead of throwing.
    if (typeof record !== "object" || record === null || Array.isArray(record) || typeof record.type !== "string") return;
    if (record.type === "response") {
      const response = record as RpcResponse;
      const p = response.id === undefined ? undefined : this.pending.get(response.id);
      if (p && response.id !== undefined) {
        this.pending.delete(response.id);
        clearTimeout(p.timer);
        if (response.success) p.resolve("data" in response ? response.data : undefined);
        else p.reject(new Error(`${p.type}: ${response.error ?? "failed"}`));
        return;
      }
    }
    for (const l of [...this.eventListeners]) l(record as RpcEvent);
  }

  private exitBase(): string {
    const status = this.exitStatus;
    if (!status) return "child process exited";
    return status.code !== null ? `child process exited (code ${status.code})` : `child process exited (signal ${status.signal})`;
  }

  private markExited(base: string): void {
    if (this.reason !== undefined) return;
    const tail = this.stderrTail.trim();
    this.reason = tail ? `${base}: ${tail}` : base;
    const error = new Error(this.reason);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (!this.closing) for (const l of [...this.exitListeners]) l(this.reason);
  }
}
