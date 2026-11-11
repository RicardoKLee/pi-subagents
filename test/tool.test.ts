import { describe, expect, it, vi } from "vitest";
import { SubagentError, type SubagentManager } from "../src/manager.ts";
import { executeAction, SubagentsParams } from "../src/tool.ts";

const record = { id: "1", handle: "reviewer", agent: "reviewer", status: "completed", runId: 1, usage: { cost: 0.01 } };

function fakeManager(overrides: Partial<Record<keyof SubagentManager, unknown>> = {}) {
  return {
    run: vi.fn(async () => ({ record, payload: { text: "LGTM", summary: "LGTM" } })),
    resume: vi.fn(async () => ({ record: { ...record, runId: 2 }, payload: { text: "again", summary: "again" } })),
    steer: vi.fn(async () => {}),
    restart: vi.fn(async () => ({ record: { ...record, runId: 2, status: "running" }, payload: { text: "fresh", summary: "fresh" } })),
    interrupt: vi.fn(async () => {}),
    interruptAll: vi.fn(async () => 0),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => ({ stopped: 0, cancelled: 0, handles: [] })),
    list: vi.fn(() => [record]),
    listChains: vi.fn(() => []),
    ...overrides,
  } as unknown as SubagentManager;
}

describe("executeAction", () => {
  it("run returns the payload and the handle to reuse", async () => {
    const m = fakeManager();
    const out = await executeAction(m, { action: "run", agent: "reviewer", task: "review" });
    expect(out.text).toContain("LGTM");
    expect(out.text).toContain("@reviewer");
    expect(m.run).toHaveBeenCalledWith({ agent: "reviewer", task: "review" });
  });

  it("run requires agent and task", async () => {
    await expect(executeAction(fakeManager(), { action: "run", agent: "reviewer" })).rejects.toThrow(/task/);
  });

  it("resume passes handle and message", async () => {
    const m = fakeManager();
    const out = await executeAction(m, { action: "resume", handle: "@reviewer", message: "look again" });
    expect(m.resume).toHaveBeenCalledWith("@reviewer", "look again", {});
    expect(out.text).toContain("again");
  });

  it("steer defaults to steer mode", async () => {
    const m = fakeManager();
    await executeAction(m, { action: "steer", handle: "reviewer", message: "focus" });
    expect(m.steer).toHaveBeenCalledWith("reviewer", "focus", "steer");
  });

  it("list renders one line per record", async () => {
    const out = await executeAction(fakeManager(), { action: "list" });
    expect(out.text).toMatch(/^main\n└─ @reviewer\s+reviewer\s+run 1\s+\$0\.0100\s+\[completed\]$/);
  });

  it("aborting the tool signal interrupts running subagents", async () => {
    let finish!: (v: unknown) => void;
    const m = fakeManager({
      interruptAll: vi.fn(async () => {}),
      run: vi.fn(() => new Promise((resolve) => (finish = resolve))),
    });
    const controller = new AbortController();
    const pending = executeAction(m, { action: "run", agent: "reviewer", task: "x" }, controller.signal);
    controller.abort();
    expect(m.interruptAll).toHaveBeenCalledTimes(1);
    finish({ record, payload: { text: "paused", summary: "paused" } });
    await pending;
  });

  it("does not interrupt when the signal is not aborted", async () => {
    const m = fakeManager({ interruptAll: vi.fn(async () => {}) });
    const controller = new AbortController();
    await executeAction(m, { action: "run", agent: "reviewer", task: "x" }, controller.signal);
    controller.abort();
    expect(m.interruptAll).toHaveBeenCalledTimes(0);
  });

  it("passes the tool signal to run and resume", async () => {
    const m = fakeManager({ interruptAll: vi.fn(async () => {}) });
    const controller = new AbortController();
    await executeAction(m, { action: "run", agent: "reviewer", task: "x" }, controller.signal);
    await executeAction(m, { action: "resume", handle: "@reviewer", message: "y" }, controller.signal);
    expect(m.run).toHaveBeenCalledWith({ agent: "reviewer", task: "x", signal: controller.signal });
    expect(m.resume).toHaveBeenCalledWith("@reviewer", "y", { signal: controller.signal });
  });

  it("surfaces SubagentError messages unchanged", async () => {
    const m = fakeManager({ resume: vi.fn(async () => { throw new SubagentError("stopped", "@reviewer was stopped"); }) });
    await expect(executeAction(m, { action: "resume", handle: "reviewer", message: "x" })).rejects.toThrow("@reviewer was stopped");
  });

  it("does not expose a delivery parameter", () => {
    expect(Object.keys(SubagentsParams.properties)).not.toContain("delivery");
  });

  it("interrupt on a queued run says it was cancelled", async () => {
    const m = fakeManager({ interrupt: vi.fn(async () => "cancelled") });
    const out = await executeAction(m, { action: "interrupt", handle: "reviewer-2" });
    expect(out.text).toContain("cancelled and cannot be resumed");
  });

  it("background resume from the tool always uses auto", async () => {
    const m = fakeManager();
    await executeAction(m, { action: "resume", handle: "reviewer", message: "again", background: true });
    expect(m.resume).toHaveBeenCalledWith("reviewer", "again", { background: true, delivery: "auto" });
  });

  it("exposes skill and command in the item schema", () => {
    const item = (SubagentsParams.properties.tasks as { items: { properties: Record<string, unknown> } }).items.properties;
    expect(Object.keys(item)).toEqual(expect.arrayContaining(["agent", "skill", "command", "task", "cwd"]));
    const actions = (SubagentsParams.properties.action as { anyOf: { const: string }[] }).anyOf.map((a) => a.const);
    expect(actions).toEqual(expect.arrayContaining(["run", "parallel", "chain", "continue", "list"]));
  });

  it("drain hands the waiting child results to the caller", async () => {
    const m = fakeManager({ drainPending: vi.fn(async () => ({ text: "child result body", count: 2 })) });
    const out = await executeAction(m, { action: "drain", handle: "@reviewer" });
    expect(m.drainPending).toHaveBeenCalledWith("@reviewer");
    expect(out.text).toBe("child result body");
    expect(out.details).toEqual({ count: 2 });
  });

  it("drop discards the waiting child results and reports the count", async () => {
    const m = fakeManager({ dropPending: vi.fn(() => 3) });
    const out = await executeAction(m, { action: "drop", handle: "reviewer" });
    expect(m.dropPending).toHaveBeenCalledWith("reviewer");
    expect(out.text).toBe("dropped 3 waiting child result(s)");
    expect(out.details).toEqual({ count: 3 });
  });

  it("drain and drop require a handle", async () => {
    await expect(executeAction(fakeManager(), { action: "drain" })).rejects.toThrow(/requires "handle"/);
    await expect(executeAction(fakeManager(), { action: "drop" })).rejects.toThrow(/requires "handle"/);
  });

  it("passes a skill entry through to run", async () => {
    const m = fakeManager();
    await executeAction(m, { action: "run", skill: "pdf-tools", task: "extract" });
    expect(m.run).toHaveBeenCalledWith({ skill: "pdf-tools", task: "extract" });
  });

  it("rejects two entry kinds without calling the manager", async () => {
    const m = fakeManager();
    await expect(executeAction(m, { action: "run", agent: "reviewer", skill: "pdf-tools", task: "x" })).rejects.toThrow(/exactly one of/);
    expect(m.run).not.toHaveBeenCalled();
  });

  it("stop-all reports what it stopped and what it left resumable", async () => {
    const m = fakeManager({
      stopAll: vi.fn(async () => ({ stopped: 2, cancelled: 1, handles: [{ handle: "reviewer", wasQueued: false }, { handle: "reviewer-2", wasQueued: true }] })),
    });
    const out = await executeAction(m, { action: "stop-all" });
    expect(out.text).toContain("Stopped 2 subagent(s)");
    expect(out.text).toContain("@reviewer (running→stopped)");
    expect(out.text).toContain("@reviewer-2 (queued→cancelled)");
    expect(out.text).toContain("Paused subagents were left resumable");
    expect(out.details).toMatchObject({ stopped: 2, cancelled: 1 });
  });

  it("stop-all with nothing active says so", async () => {
    const out = await executeAction(fakeManager(), { action: "stop-all" });
    expect(out.text).toMatch(/No subagent was running/);
  });

  it("interrupt-all reports the paused count", async () => {
    const m = fakeManager({ interruptAll: vi.fn(async () => 3) });
    const out = await executeAction(m, { action: "interrupt-all" });
    expect(out.text).toContain("Paused 3 subagent(s)");
    expect(out.details).toEqual({ count: 3 });
  });

  it("mass actions take no handle", async () => {
    for (const action of ["stop-all", "interrupt-all"] as const) {
      const m = fakeManager();
      await expect(executeAction(m, { action, handle: "reviewer" })).rejects.toThrow(/takes no handle/);
    }
    expect(fakeManager().stopAll).not.toHaveBeenCalled();
  });
});

describe("restart action", () => {
  it("requires a handle and reports the new run", async () => {
    const m = fakeManager();
    const out = await executeAction(m, { action: "restart", handle: "@reviewer", message: "retry differently" });
    expect(m.restart).toHaveBeenCalledWith("@reviewer", { message: "retry differently", background: false });
    expect(out.text).toContain("restarted as run 2");
    expect(out.text).toContain("fresh");
    expect(out.details).toEqual({ handle: "reviewer", runId: 2 });
  });

  it("restarts in the background when asked, and says the result arrives later", async () => {
    const m = fakeManager({ restart: vi.fn(async () => ({ record: { ...record, runId: 2, status: "running" } })) });
    const out = await executeAction(m, { action: "restart", handle: "reviewer", background: true });
    expect(m.restart).toHaveBeenCalledWith("reviewer", { background: true });
    expect(out.text).toContain("Restarted in the background");
  });

  it("without a handle it refuses instead of restarting something", async () => {
    await expect(executeAction(fakeManager(), { action: "restart" })).rejects.toThrow(/requires "handle"/);
  });
});
