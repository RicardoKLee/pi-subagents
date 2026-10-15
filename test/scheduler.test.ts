import { describe, expect, it } from "vitest";
import { Scheduler, SubagentsDisabledError } from "../src/scheduler.ts";

describe("Scheduler", () => {
  it("runs up to the limit and queues the rest in order", async () => {
    const s = new Scheduler(() => 2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    const order: number[] = [];
    const p3 = s.acquire().then((r) => (order.push(3), r));
    const p4 = s.acquire().then((r) => (order.push(4), r));
    expect([s.running, s.queued]).toEqual([2, 2]);
    r1();
    const r3 = await p3;
    r2();
    await p4;
    expect(order).toEqual([3, 4]);
    r3();
    expect(s.running).toBe(1);
  });

  it("rejects immediately when the limit is 0", async () => {
    const s = new Scheduler(() => 0);
    await expect(s.acquire()).rejects.toBeInstanceOf(SubagentsDisabledError);
  });

  it("never queues when the limit is -1", async () => {
    const s = new Scheduler(() => -1);
    await Promise.all(Array.from({ length: 20 }, () => s.acquire()));
    expect([s.running, s.queued]).toEqual([20, 0]);
  });

  it("release is idempotent", async () => {
    const s = new Scheduler(() => 1);
    const r = await s.acquire();
    r();
    r();
    expect(s.running).toBe(0);
  });

  it("removes an aborted waiter from the queue", async () => {
    const s = new Scheduler(() => 1);
    const r1 = await s.acquire();
    const controller = new AbortController();
    const waiting = s.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    expect(s.queued).toBe(0);
    r1();
    expect(s.running).toBe(0);
  });
});
