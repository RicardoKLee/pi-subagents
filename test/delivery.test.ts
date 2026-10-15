import { describe, expect, it } from "vitest";
import { deliver, PRIVATE_MESSAGE_TYPE, RESULT_MESSAGE_TYPE, stripPrivateMessages, type DeliveryPort } from "../src/delivery.ts";

function port() {
  const calls: { message: Parameters<DeliveryPort["sendMessage"]>[0]; options?: Parameters<DeliveryPort["sendMessage"]>[1] }[] = [];
  return { calls, port: { sendMessage: (message, options) => calls.push({ message, options }) } as DeliveryPort };
}

const env = { handle: "reviewer", agent: "reviewer", status: "completed" as const, text: "Looks good.", sessionFile: "/s/child.jsonl" };

describe("deliver", () => {
  it("share writes a visible result without starting a turn", () => {
    const { calls, port: p } = port();
    deliver(p, "share", env);
    expect(calls[0]!.message.customType).toBe(RESULT_MESSAGE_TYPE);
    expect(calls[0]!.message.display).toBe(true);
    expect(calls[0]!.message.content).toContain("@reviewer");
    expect(calls[0]!.message.content).toContain("Looks good.");
    expect(calls[0]!.options).toEqual({ triggerTurn: false });
    expect(calls[0]!.message.content).toContain("/s/child.jsonl");
    expect(calls[0]!.message.details).toMatchObject({ sessionFile: "/s/child.jsonl" });
  });

  it("auto writes the result and triggers a turn", () => {
    const { calls, port: p } = port();
    deliver(p, "auto", env);
    expect(calls[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("private uses the private type and never triggers a turn", () => {
    const { calls, port: p } = port();
    deliver(p, "private", env);
    expect(calls[0]!.message.customType).toBe(PRIVATE_MESSAGE_TYPE);
    expect(calls[0]!.options).toEqual({ triggerTurn: false });
  });

  it("includes the file path when the output was moved to a file", () => {
    const { calls, port: p } = port();
    deliver(p, "share", { ...env, filePath: "/tmp/out.md" });
    expect(calls[0]!.message.details).toMatchObject({ filePath: "/tmp/out.md" });
  });
});

describe("stripPrivateMessages", () => {
  it("removes private custom messages and keeps everything else", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "custom", customType: PRIVATE_MESSAGE_TYPE, content: "secret" },
      { role: "custom", customType: RESULT_MESSAGE_TYPE, content: "shared" },
    ];
    expect(stripPrivateMessages(messages).map((m) => m.content)).toEqual(["hi", "shared"]);
  });
});
