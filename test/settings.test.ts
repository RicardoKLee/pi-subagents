import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, limitAllows, loadSettings, parseSettings } from "../src/settings.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

describe("parseSettings", () => {
  it("returns defaults for an empty object", () => {
    expect(parseSettings({})).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
  });

  it("accepts 0 and -1 for limits", () => {
    const { settings, warnings } = parseSettings({ maxConcurrent: -1, maxChildrenPerParent: 0, maxDepth: 3 });
    expect(warnings).toEqual([]);
    expect(settings.maxConcurrent).toBe(-1);
    expect(settings.maxChildrenPerParent).toBe(0);
    expect(settings.maxDepth).toBe(3);
  });

  it("rejects -2 and decimals with a warning and keeps the default", () => {
    const { settings, warnings } = parseSettings({ maxConcurrent: -2, maxDepth: 1.5 });
    expect(settings.maxConcurrent).toBe(4);
    expect(settings.maxDepth).toBe(2);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("maxConcurrent");
  });

  it("rejects an unknown delivery mode", () => {
    const { settings, warnings } = parseSettings({ defaultDelivery: "loud" });
    expect(settings.defaultDelivery).toBe("auto");
    expect(warnings[0]).toContain("defaultDelivery");
  });

  it("rejects contextRatio outside (0, 1]", () => {
    expect(parseSettings({ contextRatio: 0 }).settings.contextRatio).toBe(0.3);
    expect(parseSettings({ contextRatio: 1 }).settings.contextRatio).toBe(1);
  });

  it("defaults delivery to auto and the mention quote limit to 2000", () => {
    expect(DEFAULT_SETTINGS.defaultDelivery).toBe("auto");
    expect(DEFAULT_SETTINGS.mentionQuoteMaxChars).toBe(2000);
  });

  it("rejects a non-positive mentionQuoteMaxChars", () => {
    const { settings, warnings } = parseSettings({ mentionQuoteMaxChars: 0 });
    expect(settings.mentionQuoteMaxChars).toBe(2000);
    expect(warnings[0]).toContain("mentionQuoteMaxChars");
  });

  it("accepts a positive integer mentionQuoteMaxChars", () => {
    expect(parseSettings({ mentionQuoteMaxChars: 500 }).settings.mentionQuoteMaxChars).toBe(500);
  });

  it("warns when the root is not an object", () => {
    const { settings, warnings } = parseSettings([1, 2]);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toHaveLength(1);
  });

  it("defaults maxResident to 8 and accepts 0 and -1", () => {
    expect(DEFAULT_SETTINGS.maxResident).toBe(8);
    expect(parseSettings({ maxResident: 0 }).settings.maxResident).toBe(0);
    expect(parseSettings({ maxResident: -1 }).settings.maxResident).toBe(-1);
  });

  it("rejects an invalid maxResident", () => {
    const { settings, warnings } = parseSettings({ maxResident: -2 });
    expect(settings.maxResident).toBe(8);
    expect(warnings[0]).toContain("maxResident");
  });

  it("defaults the batch limits to 8 and accepts 0 and -1", () => {
    expect(DEFAULT_SETTINGS.maxParallelTasks).toBe(8);
    expect(DEFAULT_SETTINGS.maxChainSteps).toBe(8);
    expect(parseSettings({ maxParallelTasks: 0, maxChainSteps: -1 }).settings).toMatchObject({ maxParallelTasks: 0, maxChainSteps: -1 });
  });

  it("rejects invalid batch limits", () => {
    const { settings, warnings } = parseSettings({ maxParallelTasks: -2, maxChainSteps: 1.5 });
    expect(settings.maxParallelTasks).toBe(8);
    expect(settings.maxChainSteps).toBe(8);
    expect(warnings.join(" ")).toContain("maxParallelTasks");
    expect(warnings.join(" ")).toContain("maxChainSteps");
  });
});

describe("loadSettings", () => {
  it("returns defaults without warnings when the file is missing", () => {
    const dir = tempDir("subagents-");
    expect(loadSettings(join(dir, "missing.json"))).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
  });

  it("warns on malformed JSON", () => {
    const dir = tempDir("subagents-");
    const file = join(dir, "subagents.json");
    writeFileSync(file, "{ not json");
    const { settings, warnings } = loadSettings(file);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings[0]).toContain("subagents.json");
  });
});

describe("limitAllows", () => {
  it("interprets 0, -1 and positive limits", () => {
    expect(limitAllows(0, 0)).toBe(false);
    expect(limitAllows(-1, 999)).toBe(true);
    expect(limitAllows(2, 1)).toBe(true);
    expect(limitAllows(2, 2)).toBe(false);
  });
});
