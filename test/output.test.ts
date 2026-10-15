import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateTokens, extractSummary, preparePayload } from "../src/output.ts";

describe("estimateTokens", () => {
  it("uses roughly four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("counts each non-ASCII character as one token", () => {
    expect(estimateTokens("中文输出".repeat(100))).toBe(400);
    expect(estimateTokens("ab中文")).toBe(3);
  });
});

describe("extractSummary", () => {
  it("splits a trailing summary tag from the body", () => {
    expect(extractSummary("Findings...\n<summary>Two bugs.</summary>")).toEqual({ body: "Findings...", summary: "Two bugs." });
  });

  it("returns the whole text when there is no tag", () => {
    expect(extractSummary("plain")).toEqual({ body: "plain" });
  });

  it("uses only the last summary tag when the body mentions the tag", () => {
    expect(extractSummary("Agents must wrap in <summary></summary> tags.\nPart B.\n<summary>Real.</summary>")).toEqual({
      body: "Agents must wrap in <summary></summary> tags.\nPart B.",
      summary: "Real.",
    });
  });
});

describe("preparePayload", () => {
  const outputDir = () => mkdtempSync(join(tmpdir(), "out-"));

  it("inlines output at or below the threshold", () => {
    const p = preparePayload({ text: "a".repeat(1200), receiverContextWindow: 1000, ratio: 0.3, outputDir: outputDir(), label: "r" });
    expect(p.filePath).toBeUndefined();
    expect(p.text).toBe("a".repeat(1200));
  });

  it("writes output above the threshold to a file and returns summary + path", () => {
    const dir = outputDir();
    const body = "b".repeat(2000);
    const p = preparePayload({ text: `${body}\n<summary>Short.</summary>`, receiverContextWindow: 1000, ratio: 0.3, outputDir: dir, label: "reviewer#2" });
    expect(p.filePath).toBeDefined();
    expect(p.filePath!.startsWith(dir)).toBe(true);
    expect(readFileSync(p.filePath!, "utf8")).toBe(body);
    expect(p.summary).toBe("Short.");
    expect(p.text).toContain("Short.");
    expect(p.text).toContain(p.filePath!);
    expect(p.text.length).toBeLessThan(400);
  });

  it("falls back to a truncated head when no summary tag exists", () => {
    const p = preparePayload({ text: "c".repeat(5000), receiverContextWindow: 1000, ratio: 0.3, outputDir: outputDir(), label: "x" });
    expect(p.summary).toHaveLength(1200);
  });

  it("moves CJK output above 30% to a file", () => {
    const p = preparePayload({ text: "中".repeat(400), receiverContextWindow: 1000, ratio: 0.3, outputDir: outputDir(), label: "cjk" });
    expect(p.filePath).toBeDefined();
  });

  it("never overwrites an earlier output file", () => {
    const dir = outputDir();
    const bodyA = "d".repeat(2000);
    const bodyB = "e".repeat(2000);
    const a = preparePayload({ text: bodyA, receiverContextWindow: 1000, ratio: 0.3, outputDir: dir, label: "r#1" });
    const b = preparePayload({ text: bodyB, receiverContextWindow: 1000, ratio: 0.3, outputDir: dir, label: "r 1" });
    expect(a.filePath).toBeDefined();
    expect(b.filePath).toBeDefined();
    expect(a.filePath).not.toBe(b.filePath);
    expect(readFileSync(a.filePath!, "utf8")).toBe(bodyA);
    expect(readFileSync(b.filePath!, "utf8")).toBe(bodyB);
  });
});
