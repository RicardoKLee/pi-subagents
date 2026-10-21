import { describe, expect, it } from "vitest";
import type { ChainRecord } from "../src/chain.ts";
import type { SubagentRecord } from "../src/registry.ts";
import { renderTree } from "../src/tree.ts";

function rec(partial: Partial<SubagentRecord> & { handle: string; createdAt: number }): SubagentRecord {
  return {
    id: partial.handle,
    agent: partial.handle,
    runner: "sdk",
    depth: 1,
    sessionFile: "/s/x.jsonl",
    runId: 1,
    status: "completed",
    delivery: "auto",
    task: "t",
    updatedAt: partial.createdAt,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ...partial,
  };
}

const usage = (cost: number, input = 0, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost });

describe("renderTree list", () => {
  it("renders roots under main sorted by creation time, status last", () => {
    const text = renderTree(
      [
        rec({ handle: "doc", createdAt: 2, status: "paused", usage: usage(0.004) }),
        rec({ handle: "reviewer", agent: "reviewer", createdAt: 1, runId: 2, usage: usage(0.0213) }),
      ],
      "list",
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("main");
    expect(lines[1]).toMatch(/^├─ @reviewer\s+reviewer\s+run 2\s+\$0\.0213\s+\[completed\]$/);
    expect(lines[2]).toMatch(/^└─ @doc\s+doc\s+run 1\s+\$0\.0040\s+\[paused\]$/);
    expect(lines[1]!.indexOf("[completed]")).toBe(lines[2]!.indexOf("[paused]"));
  });

  it("nests children and shows the subtree total on the parent", () => {
    const text = renderTree(
      [
        rec({ handle: "reviewer", createdAt: 1, usage: usage(0.0213) }),
        rec({ handle: "scout", id: "scout", parentId: "reviewer", depth: 2, createdAt: 2, status: "running", usage: usage(0.0137) }),
        rec({ handle: "doc", createdAt: 3, usage: usage(0.004) }),
      ],
      "list",
    );
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^├─ @reviewer .*\$0\.0213 \(subtree \$0\.0350\)/);
    expect(lines[2]).toMatch(/^│  └─ @scout .*\[running\]$/);
    expect(lines[3]).toMatch(/^└─ @doc /);
  });

  it("shows the first line of an error and treats orphans as roots", () => {
    const text = renderTree(
      [rec({ handle: "test-2", parentId: "gone", createdAt: 1, status: "failed", error: "rate limited\nretry later" })],
      "list",
    );
    expect(text).toMatch(/└─ @test-2 .*rate limited\s+\[failed\]$/);
    expect(text).not.toContain("retry later");
  });

  it("says so when there are no subagents", () => {
    expect(renderTree([], "list")).toBe("No subagents yet.");
  });

  it("shows records whose parents form a cycle as roots instead of dropping them", () => {
    const text = renderTree(
      [
        rec({ handle: "a", parentId: "b", createdAt: 1 }),
        rec({ handle: "b", parentId: "a", createdAt: 2 }),
        rec({ handle: "c", parentId: "a", createdAt: 3 }),
        rec({ handle: "self", parentId: "self", createdAt: 4 }),
      ],
      "list",
    );
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^├─ @a /);
    expect(lines[2]).toMatch(/^│  └─ @c /);
    expect(lines[3]).toMatch(/^├─ @b /);
    expect(lines[4]).toMatch(/^└─ @self /);
  });

  it("shows every member of a longer cycle as a root and keeps children hanging off the cycle", () => {
    // Arrange: a → b → c → a, plus d whose parent c is in the cycle but d itself is not.
    const records = [
      rec({ handle: "a", parentId: "b", createdAt: 1 }),
      rec({ handle: "b", parentId: "c", createdAt: 2 }),
      rec({ handle: "c", parentId: "a", createdAt: 3 }),
      rec({ handle: "d", parentId: "c", createdAt: 4 }),
    ];

    // Act
    const lines = renderTree(records, "list").split("\n");

    // Assert
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(/^├─ @a /);
    expect(lines[2]).toMatch(/^├─ @b /);
    expect(lines[3]).toMatch(/^└─ @c /);
    expect(lines[4]).toMatch(/^\s+└─ @d /);
  });
});

const chain = (overrides: Partial<ChainRecord> = {}): ChainRecord => ({
  id: "c1",
  steps: [{ agent: "test-agent", task: "one" }, { agent: "debug-agent", task: "two {previous}" }],
  stepRecordIds: ["s1", "s2"],
  currentStep: 1,
  status: "failed",
  usage: usage(0.018),
  createdAt: 5,
  updatedAt: 5,
  ...overrides,
});

describe("renderTree with chains", () => {
  it("groups the steps under a chain header in creation order", () => {
    const text = renderTree(
      [
        rec({ handle: "reviewer", createdAt: 1, usage: usage(0.0213) }),
        rec({ handle: "test-agent", id: "s1", chainId: "c1", stepIndex: 0, createdAt: 6, usage: usage(0.009) }),
        rec({ handle: "debug-agent", id: "s2", chainId: "c1", stepIndex: 1, createdAt: 7, status: "failed", error: "rate limited", usage: usage(0.009) }),
      ],
      "list",
      [chain()],
    );
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^├─ @reviewer /);
    expect(lines[2]).toMatch(/^└─ chain 1\s+2 steps\s+step 2\/2\s+\$0\.0180\s+rate limited\s+\[failed\]$/);
    expect(lines[3]).toMatch(/^   ├─ @test-agent /);
    expect(lines[4]).toMatch(/^   └─ @debug-agent /);
  });

  it("shows the chain sums in the cost view", () => {
    const text = renderTree(
      [rec({ handle: "test-agent", id: "s1", chainId: "c1", stepIndex: 0, createdAt: 6, usage: usage(0.01, 100, 20) })],
      "cost",
      [chain({ usage: usage(0.01, 100, 20), currentStep: 0, status: "completed" })],
    );
    expect(text.split("\n")[1]).toMatch(/^└─ chain 1\s+in 100\s+out 20\s+cache r0 w0\s+\$0\.0100$/);
  });

  it("numbers chains by creation time, not by the order the caller passes them", () => {
    const later = chain({ id: "c2", createdAt: 20, steps: [{ agent: "b", task: "x" }] });
    const earlier = chain({ id: "c1", createdAt: 5, steps: [{ agent: "a", task: "y" }] });
    const text = renderTree(
      [rec({ handle: "a", id: "s1", chainId: "c1", stepIndex: 0, createdAt: 6 }), rec({ handle: "b", id: "s2", chainId: "c2", stepIndex: 0, createdAt: 21 })],
      "list",
      [later, earlier],
    );
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^├─ chain 1 /);
    expect(lines[3]).toMatch(/^└─ chain 2 /);
  });

  it("still shows a step whose chain is missing as a root", () => {
    const text = renderTree([rec({ handle: "orphan", chainId: "gone", stepIndex: 0, createdAt: 1 })], "list", []);
    expect(text).toMatch(/└─ @orphan /);
  });

  it("numbers the chains in creation order and indents each chain's steps", () => {
    // Arrange: two chains, the second created later, each with one step record.
    const text = renderTree(
      [
        rec({ handle: "a1", id: "a1", chainId: "c1", stepIndex: 0, createdAt: 6 }),
        rec({ handle: "b1", id: "b1", chainId: "c2", stepIndex: 0, createdAt: 8 }),
      ],
      "list",
      [chain({ id: "c1", createdAt: 5, currentStep: 0, status: "completed" }), chain({ id: "c2", createdAt: 7, currentStep: 0, status: "completed" })],
    );

    // Assert: chain 1/2 by createdAt, and the first chain's step keeps the vertical guide.
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^├─ chain 1\s+2 steps\s+step 1\/2\s/);
    expect(lines[2]).toMatch(/^│  └─ @a1 /);
    expect(lines[3]).toMatch(/^└─ chain 2\s+2 steps\s+step 1\/2\s/);
    expect(lines[4]).toMatch(/^   └─ @b1 /);
  });

  it("sorts a chain against ordinary records by creation time", () => {
    // Arrange: the chain was created before the plain record.
    const text = renderTree([rec({ handle: "reviewer", createdAt: 10 })], "list", [chain({ createdAt: 2, currentStep: 0, status: "completed" })]);

    // Assert
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^├─ chain 1 /);
    expect(lines[2]).toMatch(/^└─ @reviewer /);
  });

  it("keeps an orphan step as a root beside a chain", () => {
    // Arrange: "orphan" belongs to a chain that is not on this branch; "step" belongs to one that is.
    const text = renderTree(
      [
        rec({ handle: "orphan", chainId: "gone", stepIndex: 0, createdAt: 1 }),
        rec({ handle: "step", id: "c1s1", chainId: "c1", stepIndex: 0, createdAt: 6 }),
      ],
      "list",
      [chain({ id: "c1", createdAt: 5, currentStep: 0, status: "completed" })],
    );

    // Assert: both are roots, ordered by createdAt; only the grouped step is indented.
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^├─ @orphan /);
    expect(lines[2]).toMatch(/^└─ chain 1 /);
    expect(lines[3]).toMatch(/^   └─ @step /);
  });

  it("truncates the chain error to the first line and 60 characters", () => {
    // Arrange
    const long = `${"e".repeat(80)}\nsecond line`;
    const text = renderTree(
      [rec({ handle: "s1", id: "c1s1", chainId: "c1", stepIndex: 0, createdAt: 6, status: "failed", error: long })],
      "list",
      [chain({ id: "c1", createdAt: 5, currentStep: 0, status: "failed" })],
    );

    // Assert
    const header = text.split("\n")[1]!;
    expect(header).toMatch(/chain 1/);
    expect(header).toContain("e".repeat(60));
    expect(header).not.toContain("e".repeat(61));
    expect(text).not.toContain("second line");
  });

  it("aligns the chain header columns with ordinary rows", () => {
    // Arrange: a wide ordinary handle forces the first column wider than the chain header.
    const text = renderTree(
      [
        rec({ handle: "longer-handle", agent: "reviewer", createdAt: 1, usage: usage(0.02) }),
        rec({ handle: "s1", id: "c1s1", chainId: "c1", stepIndex: 0, createdAt: 6, usage: usage(0.01) }),
      ],
      "list",
      [chain({ id: "c1", createdAt: 5, currentStep: 0, status: "completed" })],
    );

    // Assert: the cost and status columns start at the same offset on every row.
    const points = text
      .split("\n")
      .slice(1)
      .map((line) => [line.indexOf("$"), line.lastIndexOf("[")]);
    expect(points).toHaveLength(3);
    expect(points.every((p) => p[0] === points[0]![0])).toBe(true);
    expect(points.every((p) => p[1] === points[0]![1])).toBe(true);
  });

  it("shows a chain that has no step records yet", () => {
    // Arrange / Act
    const text = renderTree([], "list", [chain({ currentStep: 0, status: "completed" })]);

    // Assert: the header alone, with the empty error column dropped.
    expect(text).toBe(["main", "└─ chain 1  2 steps  step 1/2  $0.0000  [completed]"].join("\n"));
  });

  it("uses the sum of the steps, not the chain's stored usage, in the cost view", () => {
    // Arrange: the chain carries a deliberately different stored usage.
    const text = renderTree(
      [
        rec({ handle: "s1", id: "c1s1", chainId: "c1", stepIndex: 0, createdAt: 6, usage: usage(0.01, 100, 10) }),
        rec({ handle: "s2", id: "c1s2", chainId: "c1", stepIndex: 1, createdAt: 7, usage: usage(0.02, 200, 20) }),
      ],
      "cost",
      [chain({ id: "c1", createdAt: 5, usage: usage(9.99, 9999, 9999), currentStep: 1 })],
    );

    // Assert: the chain line and the total both equal 100+200 in, 10+20 out, $0.03.
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^└─ chain 1\s+in 300\s+out 30\s+cache r0 w0\s+\$0\.0300$/);
    expect(lines.at(-1)).toMatch(/^total\s+in 300\s+out 30\s+cache r0 w0\s+\$0\.0300$/);
  });
});

describe("renderTree cost", () => {
  it("shows token columns and a total", () => {
    const text = renderTree(
      [rec({ handle: "a", createdAt: 1, usage: usage(0.01, 100, 20) }), rec({ handle: "b", createdAt: 2, usage: usage(0.02, 300, 40) })],
      "cost",
    );
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/@a\s+in 100\s+out 20\s+cache r0 w0\s+\$0\.0100/);
    expect(lines.at(-1)).toMatch(/^total\s+in 400\s+out 60\s+cache r0 w0\s+\$0\.0300$/);
  });
});
