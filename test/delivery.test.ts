import { describe, expect, it } from "vitest";
import { deliver, PRIVATE_ENTRY_TYPE, RESULT_MESSAGE_TYPE, type DeliveryPort } from "../src/delivery.ts";

function port() {
  const calls: { message: Parameters<DeliveryPort["sendMessage"]>[0]; options?: Parameters<DeliveryPort["sendMessage"]>[1] }[] = [];
  const entries: { customType: string; data: unknown }[] = [];
  return {
    calls,
    entries,
    port: {
      sendMessage: (message, options) => calls.push({ message, options }),
      appendEntry: (customType, data) => entries.push({ customType, data }),
    } as DeliveryPort,
  };
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
    const { calls, entries, port: p } = port();
    deliver(p, "private", env);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.customType).toBe(PRIVATE_ENTRY_TYPE);
    expect(PRIVATE_ENTRY_TYPE).toBe("pi-subagents/private");
    expect(entries[0]!.data).toMatchObject({ handle: "reviewer", agent: "reviewer", status: "completed", sessionFile: "/s/child.jsonl" });
    expect((entries[0]!.data as { text: string }).text).toContain("Looks good.");
    expect(calls).toHaveLength(0);
  });

  it("includes the file path when the output was moved to a file", () => {
    const { calls, port: p } = port();
    deliver(p, "share", { ...env, filePath: "/tmp/out.md" });
    expect(calls[0]!.message.details).toMatchObject({ filePath: "/tmp/out.md" });
  });
});
