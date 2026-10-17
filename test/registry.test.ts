import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocateHandle } from "../src/handles.ts";
import { REGISTRY_ENTRY_TYPE, Registry, type SubagentRecord, writeSnapshot } from "../src/registry.ts";

const base = { agent: "reviewer", runner: "sdk" as const, depth: 1, sessionFile: "/s/a.jsonl", delivery: "share" as const, task: "review" };

describe("allocateHandle", () => {
  it("slugifies and numbers collisions", () => {
    expect(allocateHandle("Code Reviewer", new Set())).toBe("code-reviewer");
    expect(allocateHandle("reviewer", new Set(["reviewer"]))).toBe("reviewer-2");
    expect(allocateHandle("reviewer", new Set(["reviewer", "reviewer-2"]))).toBe("reviewer-3");
  });

  it("never allocates the reserved name main", () => {
    expect(allocateHandle("main", new Set())).toBe("main-2");
  });

  it("falls back to agent for an empty slug", () => {
    expect(allocateHandle("中文", new Set())).toBe("agent");
  });
});

describe("Registry", () => {
  function make() {
    const persisted: SubagentRecord[] = [];
    let t = 1000;
    const registry = new Registry((r) => persisted.push(structuredClone(r)), () => t++);
    return { registry, persisted };
  }

  it("creates records with unique handles and persists each mutation", () => {
    const { registry, persisted } = make();
    const a = registry.create({ ...base, preferredHandle: "reviewer" });
    const b = registry.create({ ...base, preferredHandle: "reviewer" });
    expect([a.handle, b.handle]).toEqual(["reviewer", "reviewer-2"]);
    expect(a.status).toBe("running");
    expect(a.runId).toBe(1);
    registry.update(a.id, { status: "completed", lastSummary: "ok" });
    expect(persisted).toHaveLength(3);
    expect(persisted[2]).toMatchObject({ id: a.id, status: "completed", lastSummary: "ok" });
  });

  it("resolves by handle or id", () => {
    const { registry } = make();
    const a = registry.create({ ...base, preferredHandle: "reviewer" });
    expect(registry.resolve("reviewer")?.id).toBe(a.id);
    expect(registry.resolve(a.id)?.handle).toBe("reviewer");
    expect(registry.resolve("nobody")).toBeUndefined();
  });

  it("accumulates usage across runs", () => {
    const { registry } = make();
    const a = registry.create({ ...base, preferredHandle: "reviewer" });
    registry.addUsage(a.id, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
    const r = registry.addUsage(a.id, { input: 1, output: 1, cacheRead: 2, cacheWrite: 3, cost: 0.02 });
    expect(r.usage).toEqual({ input: 11, output: 6, cacheRead: 2, cacheWrite: 3, cost: 0.03 });
  });

  it("throws on update of an unknown id", () => {
    const { registry } = make();
    expect(() => registry.update("missing", { status: "failed" })).toThrow(/missing/);
  });

  it("rebuild uses latest entry per id and ignores foreign entries", () => {
    const { registry, persisted } = make();
    const a = registry.create({ ...base, preferredHandle: "reviewer" });
    registry.update(a.id, { status: "paused" });
    const entries = [
      { type: "message", role: "user" },
      ...persisted.map((data) => ({ type: "custom", customType: REGISTRY_ENTRY_TYPE, data })),
      { type: "custom", customType: "other/ext", data: { id: a.id, status: "stopped" } },
      { type: "custom", customType: REGISTRY_ENTRY_TYPE, data: { broken: true } },
    ];
    const rebuilt = Registry.rebuild(entries, () => {});
    expect(rebuilt.list()).toHaveLength(1);
    expect(rebuilt.resolve("reviewer")?.status).toBe("paused");
    expect(rebuilt.create({ ...base, preferredHandle: "reviewer" }).handle).toBe("reviewer-2");
  });

  it("reload replaces records with the given branch", () => {
    const { registry, persisted } = make();
    const a = registry.create({ ...base, preferredHandle: "a" });
    const entriesA = persisted.map((data) => ({ type: "custom", customType: REGISTRY_ENTRY_TYPE, data }));
    const b = registry.create({ ...base, preferredHandle: "b" });
    const before = persisted.length;
    registry.reload(entriesA);
    expect(persisted).toHaveLength(before);
    expect(registry.list().map((r) => r.id)).toEqual([a.id]);
    registry.restore(b);
    expect(registry.list().map((r) => r.id)).toEqual([a.id, b.id]);
    expect(persisted).toHaveLength(before + 1);
    expect(persisted.at(-1)).toMatchObject({ id: b.id, handle: "b" });
  });
});

describe("writeSnapshot", () => {
  it("writes the records atomically as JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-"));
    const file = join(dir, "s.subagents.json");
    const { registry } = (() => {
      const registry = new Registry(() => {});
      registry.create({ ...base, preferredHandle: "reviewer" });
      return { registry };
    })();
    writeSnapshot(file, registry.list());
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.records[0].handle).toBe("reviewer");
    expect(readdirSync(dir)).toEqual(["s.subagents.json"]);
  });
});
