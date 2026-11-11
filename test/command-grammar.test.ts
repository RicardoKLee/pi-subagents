import { describe, expect, it } from "vitest";
import { parseSubagentsCommand, SUBAGENT_VERBS, subagentsCompletions } from "../src/commands.ts";
import { SUBAGENT_ACTIONS } from "../src/tool.ts";

describe("parseSubagentsCommand", () => {
  it("parses verbs with an optional handle", () => {
    expect(parseSubagentsCommand("stop @worker")).toEqual({ kind: "stop", handle: "worker" });
    expect(parseSubagentsCommand("stop worker")).toEqual({ kind: "stop", handle: "worker" });
    expect(parseSubagentsCommand("stop @sub:worker")).toEqual({ kind: "stop", handle: "worker" });
    expect(parseSubagentsCommand("stop @lead/worker")).toEqual({ kind: "stop", handle: "lead/worker" });
    expect(parseSubagentsCommand("interrupt @worker")).toEqual({ kind: "interrupt", handle: "worker" });
    expect(parseSubagentsCommand("stop-all")).toEqual({ kind: "stop-all" });
    expect(parseSubagentsCommand("interrupt-all")).toEqual({ kind: "interrupt-all" });
    expect(parseSubagentsCommand("  STOP  @Worker  ")).toEqual({ kind: "stop", handle: "Worker" });
  });

  it("views are the default and ignore case", () => {
    expect(parseSubagentsCommand("")).toEqual({ kind: "view", view: "list" });
    expect(parseSubagentsCommand("   ")).toEqual({ kind: "view", view: "list" });
    expect(parseSubagentsCommand("list")).toEqual({ kind: "view", view: "list" });
    expect(parseSubagentsCommand("cost")).toEqual({ kind: "view", view: "cost" });
    expect(parseSubagentsCommand("LIST")).toEqual({ kind: "view", view: "list" });
    expect(parseSubagentsCommand("help")).toEqual({ kind: "help" });
  });

  it("treats the rest of a restart line as the optional message", () => {
    expect(parseSubagentsCommand("restart @worker 换个思路重跑")).toEqual({ kind: "restart", handle: "worker", message: "换个思路重跑" });
    expect(parseSubagentsCommand("restart @worker")).toEqual({ kind: "restart", handle: "worker" });
    expect(parseSubagentsCommand("restart worker   spaced   message ")).toEqual({ kind: "restart", handle: "worker", message: "spaced   message" });
  });

  it("refuses a missing handle and never widens the scope", () => {
    for (const raw of ["stop", "interrupt", "restart"]) {
      const parsed = parseSubagentsCommand(raw);
      expect(parsed).toMatchObject({ kind: "error" });
      expect((parsed as { message: string }).message).toContain("handle");
    }
  });

  it("refuses mass-action handles and unknown verbs", () => {
    for (const raw of ["stop-all @worker", "interrupt-all worker"]) {
      expect(parseSubagentsCommand(raw)).toMatchObject({ kind: "error" });
    }
    const unknown = parseSubagentsCommand("nope @worker");
    expect(unknown).toMatchObject({ kind: "error" });
    expect((unknown as { message: string }).message).toContain("stop-all");
    // A leading `@handle` is a message to that subagent, not a command: it must never be read as "control it".
    expect(parseSubagentsCommand("@worker stop")).toMatchObject({ kind: "error" });
  });

  it("refuses trailing text on stop and interrupt", () => {
    for (const raw of ["stop @worker now", "interrupt @worker please"]) {
      expect(parseSubagentsCommand(raw)).toMatchObject({ kind: "error" });
    }
  });

  it("completes verbs first and handles second", () => {
    expect(subagentsCompletions("st", () => ["worker"]).map((i) => i.value)).toEqual(expect.arrayContaining(["stop", "stop-all"]));
    expect(subagentsCompletions("", () => ["worker"]).map((i) => i.value)).toEqual(expect.arrayContaining(["list", "cost", "help", "stop"]));
    expect(subagentsCompletions("stop @", () => ["worker", "reviewer"]).map((i) => i.value)).toEqual(["@worker", "@reviewer"]);
    expect(subagentsCompletions("restart wo", () => ["worker", "reviewer"]).map((i) => i.value)).toEqual(["@worker"]);
    // A verb that takes no handle offers nothing more.
    expect(subagentsCompletions("stop-all ", () => ["worker"])).toEqual([]);
  });

  it("keeps one verb list, derived from the tool's actions", () => {
    expect(SUBAGENT_VERBS).toEqual(expect.arrayContaining(["list", "cost", "help", "stop", "stop-all", "interrupt", "interrupt-all", "restart"]));
    for (const verb of SUBAGENT_VERBS) {
      if (verb === "list" || verb === "cost" || verb === "help") continue;
      expect(SUBAGENT_ACTIONS).toContain(verb);
    }
  });
});