import { afterAll, describe, expect, it } from "vitest";
import { writeSkill, writeTemplate } from "./fixtures/skill-fixtures.ts";
import { harness, type Harness } from "./harness.ts";
import { cleanupTempDirs } from "./tmp.ts";

afterAll(cleanupTempDirs);

/**
 * The raw text the model was sent: `seen()` stores one JSON array of messages per request, so decode it and
 * concatenate every message's text (string content or text parts).
 */
function modelText(h: Harness): string {
  return h
    .seen()
    .map((line) => JSON.parse(line) as { content?: unknown }[])
    .flat()
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) return message.content.map((part) => (part as { text?: string }).text ?? "").join("");
      return "";
    })
    .join("\n");
}

describe.each(["sdk", "rpc"] as const)("prompt expansion: %s", (kind) => {
  it("expands a skill command with its arguments before the model sees it", async () => {
    const h = await harness(kind);
    writeSkill(h.agentDir, "pdf-tools", "PDF-TOOLS-BODY");
    h.script([{ text: "done" }]);
    const session = await h.runner.open(h.spec);
    await session.prompt("/skill:pdf-tools extract a.pdf");
    await session.dispose();
    const sent = modelText(h);
    expect(sent).toContain('<skill name="pdf-tools"');
    expect(sent).toContain("PDF-TOOLS-BODY");
    expect(sent).toContain("extract a.pdf");
  });

  it("expands a prompt template and substitutes its arguments", async () => {
    const h = await harness(kind);
    writeTemplate(h.agentDir, "review", "REVIEW-BODY: $ARGUMENTS");
    h.script([{ text: "done" }]);
    const session = await h.runner.open(h.spec);
    await session.prompt("/review src/x.ts");
    await session.dispose();
    const sent = modelText(h);
    expect(sent).toContain("REVIEW-BODY: src/x.ts");
    expect(sent).not.toContain("/review src/x.ts");
  });

  it("passes an unknown skill through as plain text (pi behaviour behind a known limit)", async () => {
    const h = await harness(kind);
    h.script([{ text: "done" }]);
    const session = await h.runner.open(h.spec);
    await session.prompt("/skill:nope do it");
    await session.dispose();
    expect(modelText(h)).toContain("/skill:nope do it");
  });
});