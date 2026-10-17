import type { Usage } from "../src/registry.ts";
import type { ChildResult, ChildSession, ChildSpec, Runner } from "../src/runner/types.ts";

export const usage = (cost = 0.01): Usage => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost });

export class FakeSession implements ChildSession {
  readonly prompts: string[] = [];
  readonly steers: { text: string; mode: string }[] = [];
  aborted = 0;
  disposed = false;
  private pending?: (r: ChildResult) => void;
  private held?: ChildResult;

  /** `hold`: prompt() stays pending until finish() or abort(). */
  constructor(readonly sessionFile: string, private readonly script: ChildResult[], private readonly hold = false) {}

  prompt(text: string): Promise<ChildResult> {
    if (this.pending) return Promise.reject(new Error("FakeSession: prompt while busy"));
    this.prompts.push(text);
    const next = this.script.shift() ?? { text: "done", stopReason: "stop" as const, usage: usage() };
    if (!this.hold) return Promise.resolve(next);
    this.held = next;
    return new Promise((resolve) => (this.pending = resolve));
  }

  /** Completes a held prompt with its scripted result. */
  finish(): void {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.(this.held!);
  }

  async steer(text: string, mode: "steer" | "followUp"): Promise<void> {
    this.steers.push({ text, mode });
  }

  /** Mirrors pi: an aborted prompt resolves with stopReason "aborted". */
  async abort(): Promise<void> {
    this.aborted++;
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.({ text: "", stopReason: "aborted", usage: usage(0) });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export class FakeRunner implements Runner {
  readonly kind = "sdk" as const;
  readonly opened: ChildSpec[] = [];
  readonly sessions: FakeSession[] = [];
  constructor(private readonly factory: (spec: ChildSpec, n: number) => FakeSession) {}

  async open(spec: ChildSpec): Promise<ChildSession> {
    this.opened.push(spec);
    const s = this.factory(spec, this.sessions.length);
    this.sessions.push(s);
    return s;
  }
}
