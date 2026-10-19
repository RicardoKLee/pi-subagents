import { describe, expect, it } from "vitest";
import { turnResult } from "../src/runner/result.ts";
import { toStopReason } from "../src/runner/types.ts";

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra });

describe("turnResult", () => {
  it("takes the last assistant answer of the turn", () => {
    expect(turnResult([{ role: "user", content: "q" }, assistant("draft", { stopReason: "toolUse" }), { role: "toolResult" }, assistant(" final ")])).toEqual({
      text: "final",
      stopReason: "stop",
    });
  });

  it("joins text blocks and ignores other blocks", () => {
    const msg = { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "a" }, { type: "text", text: "b" }] };
    expect(turnResult([msg]).text).toBe("ab");
  });

  it("an empty turn has no answer", () => {
    expect(turnResult([])).toEqual({ text: "", stopReason: "stop" });
    expect(turnResult([{ role: "user", content: "q" }])).toEqual({ text: "", stopReason: "stop" });
  });

  it("skips an empty aborted message but reports the abort", () => {
    expect(turnResult([assistant("partial", { stopReason: "toolUse" }), { role: "assistant", content: [], stopReason: "aborted" }])).toEqual({
      text: "partial",
      stopReason: "aborted",
    });
  });

  it("reports errors with their message and honours the aborted flag", () => {
    expect(turnResult([{ role: "assistant", content: [], stopReason: "error", errorMessage: "boom" }])).toEqual({ text: "", stopReason: "error", errorMessage: "boom" });
    expect(turnResult([assistant("x")], true).stopReason).toBe("aborted");
  });
});

describe("turnResult boundaries", () => {
  it("has no answer when the turn has no assistant message", () => {
    // Arrange: a turn that only holds non-assistant messages
    const turn = [{ role: "user", content: "q" }, { role: "toolResult", content: [{ type: "text", text: "tool output" }] }];
    // Act + Assert: tool output is never reported as the answer
    expect(turnResult(turn)).toEqual({ text: "", stopReason: "stop" });
  });

  it("reports toolUse when the turn ends on a tool call", () => {
    const turn = [{ role: "user", content: "q" }, assistant("calling a tool", { stopReason: "toolUse" })];
    expect(turnResult(turn)).toEqual({ text: "calling a tool", stopReason: "toolUse" });
  });

  it("an empty aborted message alone gives no text but keeps the abort and its message", () => {
    const turn = [{ role: "user", content: "q" }, { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" }];
    expect(turnResult(turn)).toEqual({ text: "", stopReason: "aborted", errorMessage: "Request was aborted" });
  });

  it("keeps the partial text of an aborted message that has content", () => {
    const turn = [assistant("older", { stopReason: "toolUse" }), assistant("partial", { stopReason: "aborted" })];
    expect(turnResult(turn)).toEqual({ text: "partial", stopReason: "aborted" });
  });

  it("takes errorMessage from the last assistant message only", () => {
    // Arrange: an earlier failed attempt followed by a successful answer in the same turn
    const turn = [{ role: "assistant", content: [], stopReason: "error", errorMessage: "transient" }, assistant("ok")];
    // Act + Assert: the earlier error does not leak into a successful result
    expect(turnResult(turn)).toEqual({ text: "ok", stopReason: "stop" });
  });

  it("maps unknown stop reasons of the last message to stop", () => {
    for (const stopReason of ["pending", "deferred", undefined]) {
      expect(turnResult([assistant("x", { stopReason })])).toEqual({ text: "x", stopReason: "stop" });
    }
  });

  it("ignores non-array content", () => {
    expect(turnResult([{ role: "assistant", content: "plain string", stopReason: "stop" }])).toEqual({ text: "", stopReason: "stop" });
  });
});

describe("toStopReason", () => {
  it("keeps known reasons and maps the rest to stop", () => {
    for (const r of ["stop", "length", "toolUse", "error", "aborted"]) expect(toStopReason(r)).toBe(r);
    for (const r of ["pending", "deferred", undefined, 3]) expect(toStopReason(r)).toBe("stop");
  });
});
