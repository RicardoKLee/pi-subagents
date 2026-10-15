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
});

describe("extractSummary", () => {
  it("splits a trailing summary tag from the body", () => {
    expect(extractSummary("Findings...\n<summary>Two bugs.</summary>")).toEqual({ body: "Findings...", summary: "Two bugs." });
  });

  it("returns the whole text when there is no tag", () => {
    expect(extractSummary("plain")).toEqual({ body: "plain" });
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
});
