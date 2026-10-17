import { describe, expect, it, vi } from "vitest";
import { SubagentError, type SubagentManager } from "../src/manager.ts";
import { executeAction, SubagentsParams } from "../src/tool.ts";

const record = { id: "1", handle: "reviewer", agent: "reviewer", status: "completed", runId: 1, usage: { cost: 0.01 } };

function fakeManager(overrides: Partial<Record<keyof SubagentManager, unknown>> = {}) {
  return {
    run: vi.fn(async () => ({ record, payload: { text: "LGTM", summary: "LGTM" } })),
    resume: vi.fn(async () => ({ record: { ...record, runId: 2 }, payload: { text: "again", summary: "again" } })),
    steer: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    list: vi.fn(() => [record]),
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
    expect(out.text).toMatch(/@reviewer\s+reviewer\s+completed/);
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

  it("background resume from the tool always uses auto", async () => {
    const m = fakeManager();
    await executeAction(m, { action: "resume", handle: "reviewer", message: "again", background: true });
    expect(m.resume).toHaveBeenCalledWith("reviewer", "again", { background: true, delivery: "auto" });
  });
});
