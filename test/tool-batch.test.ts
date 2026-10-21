import { describe, expect, it, vi } from "vitest";
import type { SubagentManager } from "../src/manager.ts";
import { SubagentsParams, executeAction } from "../src/tool.ts";

const record = { id: "1", handle: "reviewer", agent: "reviewer", status: "completed", runId: 1, usage: { cost: 0.01 } };
const chain = { id: "c1", steps: [{ agent: "reviewer", task: "one" }], status: "completed" };

function fakeManager(overrides: Partial<Record<keyof SubagentManager, unknown>> = {}) {
  return {
    run: vi.fn(async () => ({ record, payload: { text: "LGTM", summary: "LGTM" } })),
    resume: vi.fn(async () => ({ record, payload: { text: "again", summary: "again" } })),
    steer: vi.fn(async () => {}),
    interrupt: vi.fn(async () => "paused"),
    stop: vi.fn(async () => {}),
    list: vi.fn(() => [record]),
    runParallel: vi.fn(async () => ({ records: [record, { ...record, handle: "reviewer-2" }], payload: { text: "Parallel: 2/2 succeeded", summary: "ok" } })),
    runChain: vi.fn(async () => ({ records: [record], payload: { text: "Chain completed (1/1 steps)", summary: "ok" }, chain })),
    continueChain: vi.fn(async () => ({ records: [record], payload: { text: "Chain completed (2/2 steps)", summary: "ok" }, chain })),
    ...overrides,
  } as unknown as SubagentManager;
}

const items = [{ agent: "reviewer", task: "one" }, { agent: "reviewer", task: "two" }];

describe("batch actions", () => {
  it("exposes the three new actions in the schema", () => {
    const actions = (SubagentsParams.properties.action as { anyOf: { const: string }[] }).anyOf.map((a) => a.const);
    expect(actions).toEqual(expect.arrayContaining(["parallel", "chain", "continue"]));
  });

  it("parallel returns the summary, the handles and the items it was given", async () => {
    const m = fakeManager();
    const out = await executeAction(m, { action: "parallel", tasks: items });
    expect(out.text).toContain("Parallel: 2/2 succeeded");
    expect(out.details).toMatchObject({ handles: ["reviewer", "reviewer-2"] });
    expect(m.runParallel).toHaveBeenCalledWith({ items, background: false });
  });

  it("background parallel reports the handles immediately", async () => {
    const m = fakeManager({ runParallel: vi.fn(async () => ({ records: [record] })) });
    const out = await executeAction(m, { action: "parallel", tasks: items, background: true });
    expect(out.text).toContain("Started 1 parallel subagents");
    expect(out.text).toContain("@reviewer");
    expect(out.text).toContain("summary will be delivered");
    expect(m.runParallel).toHaveBeenCalledWith({ items, background: true });
  });

  it("background parallel does not report the stale snapshot status of its records", async () => {
    // Background records are creation-time snapshots (the registry is authoritative), so the tool must not
    // present their status as if the batch had finished.
    const queued = { ...record, status: "queued" };
    const m = fakeManager({ runParallel: vi.fn(async () => ({ records: [queued] })) });
    const out = await executeAction(m, { action: "parallel", tasks: items, background: true });
    expect(out.details).not.toHaveProperty("statuses");
    expect(out.text).not.toContain("queued");
  });

  it("chain returns the summary and a background chain reports its id", async () => {
    const m = fakeManager();
    expect((await executeAction(m, { action: "chain", chain: items })).text).toContain("Chain completed (1/1 steps)");
    expect(m.runChain).toHaveBeenCalledWith({ steps: items, background: false });
    const background = fakeManager({ runChain: vi.fn(async () => ({ records: [], chain: { ...chain, steps: items } })) });
    const out = await executeAction(background, { action: "chain", chain: items, background: true });
    expect(out.text).toContain("Started chain c1 with 2 steps");
    expect(out.details).toMatchObject({ chainId: "c1" });
    expect(background.runChain).toHaveBeenCalledWith({ steps: items, background: true });
  });

  it("continue passes the handle and an optional message", async () => {
    const m = fakeManager();
    await executeAction(m, { action: "continue", handle: "reviewer", message: "try again" });
    expect(m.continueChain).toHaveBeenCalledWith("reviewer", "try again", { background: false });
    await executeAction(m, { action: "continue", handle: "reviewer" });
    expect(m.continueChain).toHaveBeenLastCalledWith("reviewer", undefined, { background: false });
  });

  it("run passes cwd through", async () => {
    const m = fakeManager();
    await executeAction(m, { action: "run", agent: "reviewer", task: "x", cwd: "/tmp/other" });
    expect(m.run).toHaveBeenCalledWith({ agent: "reviewer", task: "x", cwd: "/tmp/other" });
  });

  it("requires a non-empty array", async () => {
    await expect(executeAction(fakeManager(), { action: "parallel", tasks: [] })).rejects.toThrow(/non-empty "tasks"/);
    await expect(executeAction(fakeManager(), { action: "chain" })).rejects.toThrow(/non-empty "chain"/);
    await expect(executeAction(fakeManager(), { action: "continue" })).rejects.toThrow(/requires "handle"/);
  });
});