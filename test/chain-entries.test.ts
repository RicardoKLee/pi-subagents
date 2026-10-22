import { describe, expect, it } from "vitest";
import { CHAIN_ENTRY_TYPE, ChainStore } from "../src/chain.ts";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

const entry = (data: unknown) => ({ type: "custom", customType: CHAIN_ENTRY_TYPE, data });

/** A structurally valid chain whose only variable is the step definitions under test. */
function chainWith(steps: unknown[]) {
  return { id: "c1", steps, stepRecordIds: [], currentStep: 0, status: "running", usage: { ...zeroUsage }, createdAt: 1, updatedAt: 1 };
}

/** The steps the store keeps after reload; undefined means the whole chain was rejected. */
function keptSteps(steps: unknown[]): unknown[] | undefined {
  return ChainStore.rebuild([entry(chainWith(steps))], () => {}).list()[0]?.steps;
}

// `isStep` (src/chain.ts) is the compatibility boundary for chains persisted by earlier milestones and for the
// new skill / command entries: exactly one non-empty string entry kind plus a string task.
describe("chain step entry validation", () => {
  it.each([
    [{ agent: "reviewer", task: "t" }],
    [{ skill: "pdf-tools", task: "t" }],
    [{ command: "review", task: "t" }],
    [{ agent: "reviewer", task: "t", cwd: "/tmp/x" }],
    [{ skill: "pdf-tools", task: "" }],
  ])("keeps a chain with the valid step %j", (step) => {
    expect(keptSteps([step])).toEqual([step]);
  });

  it.each([
    [{}],
    [{ task: "t" }],
    [{ agent: "reviewer" }],
    [{ agent: 1, task: "t" }],
    [{ agent: "a", skill: "s", task: "t" }],
    [{ skill: "s", command: "c", task: "t" }],
    [{ agent: "a", skill: "s", command: "c", task: "t" }],
    [{ agent: "", task: "t" }],
    [{ agent: "a", task: 1 }],
  ])("rejects a chain whose step is %j", (step) => {
    expect(keptSteps([step])).toBeUndefined();
  });
});