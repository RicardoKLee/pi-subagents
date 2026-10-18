import { describe, expect, it } from "vitest";
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
