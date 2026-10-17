import { describe, expect, it } from "vitest";
import { parseMention, type RouteContext, routeMention } from "../src/mention.ts";
import type { RunStatus, SubagentRecord } from "../src/registry.ts";

describe("parseMention", () => {
  it.each([
    ["@reviewer look again", { form: "bare", handle: "reviewer", raw: "reviewer", message: "look again" }],
    ["@reviewer? what is RAII", { form: "bare", handle: "reviewer", raw: "reviewer", delivery: "private", message: "what is RAII" }],
    ["@reviewer! go on", { form: "bare", handle: "reviewer", raw: "reviewer", delivery: "auto", message: "go on" }],
    ["@reviewer~ think about it", { form: "bare", handle: "reviewer", raw: "reviewer", delivery: "share", message: "think about it" }],
    ["@sub:reviewer-2 hi", { form: "ns", handle: "reviewer-2", raw: "reviewer-2", message: "hi" }],
    ["@sub:reviewer? hi", { form: "ns", handle: "reviewer", raw: "reviewer", delivery: "private", message: "hi" }],
    ["@Reviewer hi", { form: "bare", handle: "reviewer", raw: "Reviewer", message: "hi" }],
    ["@reviewer", { form: "bare", handle: "reviewer", raw: "reviewer", message: "" }],
    ["@reviewer\nline two", { form: "bare", handle: "reviewer", raw: "reviewer", message: "line two" }],
  ])("parses %j", (text, expected) => {
    expect(parseMention(text)).toEqual(expected);
  });

  it.each(["hello @reviewer", " @reviewer hi", "@src/index.ts explain", "@README.md read", "@reviewer?? hi", "plain text", "@ hi"])(
    "ignores %j",
    (text) => {
      expect(parseMention(text)).toBeUndefined();
    },
  );

  it.each(["@sub: hi", "@sub:Bad_Name hi", "@sub:a/b hi"])("reports a malformed @sub: reference in %j", (text) => {
    expect(parseMention(text)).toMatchObject({ error: expect.stringContaining("@sub:") });
  });
});

function record(handle: string, status: RunStatus): SubagentRecord {
  return {
    id: `id-${handle}`,
    handle,
    agent: "reviewer",
    runner: "sdk",
    depth: 1,
    sessionFile: `/s/${handle}.jsonl`,
    runId: 1,
    status,
    delivery: "auto",
    task: "t",
    createdAt: 0,
    updatedAt: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };
}

function ctx(records: SubagentRecord[], files: string[] = [], defaultDelivery: RouteContext["defaultDelivery"] = "auto"): RouteContext {
  return {
    resolve: (h) => records.find((r) => r.handle === h),
    known: () => records.map((r) => r.handle),
    fileExists: (raw) => files.includes(raw),
    defaultDelivery,
  };
}

describe("routeMention", () => {
  it("resumes a finished subagent with the default delivery", () => {
    expect(routeMention("@reviewer again", ctx([record("reviewer", "completed")]))).toEqual({
      action: "resume",
      handle: "reviewer",
      message: "again",
      delivery: "auto",
    });
  });

  it("uses the configured default when there is no symbol", () => {
    expect(routeMention("@reviewer again", ctx([record("reviewer", "paused")], [], "share"))).toMatchObject({ action: "resume", delivery: "share" });
  });

  it("a symbol overrides the default", () => {
    expect(routeMention("@reviewer? again", ctx([record("reviewer", "failed")], [], "share"))).toMatchObject({ action: "resume", delivery: "private" });
  });

  it("steers a running subagent and keeps the symbol only when given", () => {
    const c = ctx([record("reviewer", "running")]);
    expect(routeMention("@reviewer focus", c)).toEqual({ action: "steer", handle: "reviewer", message: "focus" });
    expect(routeMention("@reviewer? focus", c)).toEqual({ action: "steer", handle: "reviewer", message: "focus", delivery: "private" });
  });

  it("reports stopped and queued subagents", () => {
    expect(routeMention("@reviewer x", ctx([record("reviewer", "stopped")]))).toMatchObject({ action: "error", message: expect.stringContaining("stopped") });
    expect(routeMention("@reviewer x", ctx([record("reviewer", "queued")]))).toMatchObject({ action: "error", message: expect.stringContaining("queued") });
  });

  it("passes unknown bare handles to the main session", () => {
    expect(routeMention("@nobody hi", ctx([record("reviewer", "completed")]))).toEqual({ action: "pass" });
  });

  it("reports unknown @sub: handles with the known ones", () => {
    expect(routeMention("@sub:nobody hi", ctx([record("reviewer", "completed")]))).toEqual({
      action: "error",
      message: "no subagent @nobody. Known: @reviewer",
    });
  });

  it("file wins over a bare handle, @sub: still reaches the subagent", () => {
    const c = ctx([record("test", "completed")], ["test"]);
    expect(routeMention("@test run it", c)).toEqual({ action: "pass" });
    expect(routeMention("@sub:test run it", c)).toMatchObject({ action: "resume", handle: "test" });
  });

  it("checks the file with the original casing", () => {
    const c = ctx([record("readme", "completed")], ["README"]);
    expect(routeMention("@README hi", c)).toEqual({ action: "pass" });
  });

  it("asks for a message after the handle", () => {
    for (const text of ["@reviewer", "@reviewer   ", "@sub:reviewer"]) {
      expect(routeMention(text, ctx([record("reviewer", "completed")]))).toEqual({
        action: "error",
        message: "write a message after @reviewer",
      });
    }
  });

  it("@main strips the prefix and @sub:main is rejected", () => {
    expect(routeMention("@main hello", ctx([]))).toEqual({ action: "main", text: "hello" });
    expect(routeMention("@main", ctx([]))).toEqual({ action: "pass" });
    expect(routeMention("@main hello", ctx([], ["main"]))).toEqual({ action: "pass" });
    expect(routeMention("@sub:main hi", ctx([]))).toMatchObject({ action: "error", message: expect.stringContaining("reserved") });
  });

  it("reports a malformed @sub: reference", () => {
    expect(routeMention("@sub: hi", ctx([]))).toMatchObject({ action: "error" });
  });

  it("ignores text that is not a mention", () => {
    expect(routeMention("please check @reviewer", ctx([record("reviewer", "completed")]))).toEqual({ action: "pass" });
  });
});
