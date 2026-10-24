import { limitAllows } from "./settings.ts";

export class SubagentsDisabledError extends Error {
  constructor(message = "subagents are disabled (maxConcurrent is 0)") {
    super(message);
    this.name = "SubagentsDisabledError";
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}

export class Scheduler {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly getLimit: () => number) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** True when the limit is 0 (subagents disabled). */
  get disabled(): boolean {
    return this.getLimit() === 0;
  }

  /**
   * Whether a slot is free right now. A fire-and-forget background run checks this before waiting: if no slot is
   * available it returns its handle at once and waits in a detached task instead of blocking its own parent
   * (LATENT-046-BG). The check and the following `acquire` are synchronous back to back, so no other run can slip in.
   */
  hasCapacity(): boolean {
    return limitAllows(this.getLimit(), this.active);
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.getLimit() === 0) return Promise.reject(new SubagentsDisabledError());
    if (signal?.aborted) return Promise.reject(new Error("aborted while waiting for a slot"));
    if (limitAllows(this.getLimit(), this.active)) return Promise.resolve(this.grant());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      this.waiters.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("aborted while waiting for a slot"));
        },
        { once: true },
      );
    });
  }

  private grant(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length && limitAllows(this.getLimit(), this.active)) {
      this.waiters.shift()!.resolve(this.grant());
    }
  }
}
