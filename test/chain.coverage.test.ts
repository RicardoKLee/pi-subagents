import { describe, expect, it } from "vitest";
import { CHAIN_ENTRY_TYPE, type ChainRecord, ChainStore } from "../src/chain.ts";

const baseSteps = [
  { agent: "reviewer", task: "one" },
  { agent: "reviewer", task: "two {previous}" },
];

function chainRecord(overrides: Partial<ChainRecord> = {}): ChainRecord {
  return {
    id: "c1",
    steps: baseSteps.map((s) => ({ ...s })),
    stepRecordIds: [],
    currentStep: 0,
    status: "running",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const entry = (data: unknown) => ({ type: "custom", customType: CHAIN_ENTRY_TYPE, data });

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function strip(record: ChainRecord, ...keys: Array<keyof ChainRecord>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

describe("ChainStore (coverage)", () => {
  it("reload replaces the branch with real entries and persists none of them", () => {
    const source = new ChainStore(() => {});
    const branchChain = source.create({ steps: baseSteps });

    const persisted: ChainRecord[] = [];
    const s = new ChainStore((c) => persisted.push(structuredClone(c)));
    const own = s.create({ steps: baseSteps }); // one persist

    s.reload([entry(branchChain)]);

    expect(s.list()).toEqual([branchChain]);
    expect(s.get(own.id)).toBeUndefined();
    // reload with a non-empty branch must not write anything back.
    expect(persisted).toHaveLength(1);
  });

  it("reload ignores entries whose data is not a valid chain", () => {
    const valid = chainRecord({ id: "valid" });
    const foreign = [
      { type: "message", customType: CHAIN_ENTRY_TYPE, data: valid },
      { type: "custom", customType: "other", data: valid },
      { type: "custom", customType: CHAIN_ENTRY_TYPE, data: null },
      { type: "custom", customType: CHAIN_ENTRY_TYPE, data: undefined },
      { type: "custom", customType: CHAIN_ENTRY_TYPE, data: { id: "x" } },
      { type: "custom", customType: CHAIN_ENTRY_TYPE, data: { id: "x", steps: "nope" } },
      { type: "custom", customType: CHAIN_ENTRY_TYPE, data: { id: "x", steps: [{ agent: 1, task: "t" }] } },
      { type: "custom", customType: CHAIN_ENTRY_TYPE, data: { id: "x", steps: [{ agent: "a" }] } },
      { type: "custom", customType: CHAIN_ENTRY_TYPE, data: { id: 5, steps: [] } },
    ];

    const s = ChainStore.rebuild([...foreign, entry(valid)], () => {});

    expect(s.list()).toEqual([valid]);
  });

  it("restore clones the input chain and persists it once", () => {
    const persisted: ChainRecord[] = [];
    const s = new ChainStore((c) => persisted.push(c));
    const external = chainRecord({ id: "restored" });

    const restored = s.restore(external);

    expect(restored).toEqual(external);
    expect(s.get("restored")).toEqual(external);
    expect(persisted).toHaveLength(1);

    // later mutations of the caller's object must not leak into the store.
    external.steps[0]!.task = "changed-input";
    expect(s.get("restored")!.steps[0]!.task).toBe("one");

    // the persisted snapshot is independent of the stored record.
    persisted[0]!.steps[0]!.task = "changed-snapshot";
    expect(s.get("restored")!.steps[0]!.task).toBe("one");
  });

  it("list returns chains ordered by createdAt ascending", () => {
    let t = 100;
    const s = new ChainStore(() => {}, () => t);
    const first = s.create({ steps: baseSteps });
    t = 300;
    const third = s.create({ steps: baseSteps });
    t = 200;
    const second = s.create({ steps: baseSteps });

    expect(s.list().map((c) => c.id)).toEqual([first.id, second.id, third.id]);
  });

  it("update only changes the patched fields and bumps updatedAt", () => {
    let t = 1000;
    const s = new ChainStore(() => {}, () => t);
    const chain = s.create({ steps: baseSteps });
    t = 2000;

    const updated = s.update(chain.id, {
      usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 9 },
    });
    expect(updated).toMatchObject({
      id: chain.id,
      createdAt: 1000,
      updatedAt: 2000,
      status: "running",
      currentStep: 0,
      stepRecordIds: [],
      usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 9 },
    });
    expect(updated.steps).toEqual(chain.steps);

    t = 3000;
    const paused = s.update(chain.id, { status: "paused", currentStep: 2 });
    expect(paused.steps).toEqual(chain.steps);
    expect(paused.usage.cost).toBe(9);
    expect(paused.stepRecordIds).toEqual([]);
    expect(paused.createdAt).toBe(1000);
    expect(paused.updatedAt).toBe(3000);
  });

  it("create clones the step definitions from the input", () => {
    const input = [{ agent: "reviewer", task: "one", cwd: "/tmp/x" }];
    const s = new ChainStore(() => {});

    const chain = s.create({ steps: input });
    input[0]!.task = "changed";
    input[0]!.cwd = "/tmp/y";

    expect(chain.steps).toEqual([{ agent: "reviewer", task: "one", cwd: "/tmp/x" }]);
  });

  it("rebuild does not persist and get returns undefined for an unknown id", () => {
    const valid = chainRecord({ id: "known" });
    const persisted: ChainRecord[] = [];

    const s = ChainStore.rebuild([entry(valid)], (c) => persisted.push(c));

    expect(persisted).toHaveLength(0);
    expect(s.get("missing")).toBeUndefined();
    expect(s.get("known")).toEqual(valid);
  });

  it("reload rejects entries with malformed status, currentStep, or stepRecordIds", () => {
    const created = new ChainStore(() => {}).create({ steps: baseSteps });
    const malformed = [
      strip(chainRecord({ id: "missing-status" }), "status"),
      chainRecord({ id: "unknown-status", status: "bogus" as ChainRecord["status"] }),
      chainRecord({ id: "nan-current-step", currentStep: Number.NaN }),
      chainRecord({ id: "string-current-step", currentStep: "1" as unknown as number }),
      chainRecord({ id: "string-step-record-ids", stepRecordIds: "nope" as unknown as string[] }),
    ];

    const s = ChainStore.rebuild([...malformed.map(entry), entry(created)], () => {});

    expect(s.list()).toEqual([created]);
  });

  it("reload rejects entries with malformed usage or timestamps", () => {
    const created = new ChainStore(() => {}).create({ steps: baseSteps });
    const malformed = [
      strip(chainRecord({ id: "missing-usage" }), "usage"),
      chainRecord({
        id: "usage-missing-field",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as unknown as ChainRecord["usage"],
      }),
      chainRecord({
        id: "usage-undefined-field",
        usage: { ...zeroUsage, cost: undefined } as unknown as ChainRecord["usage"],
      }),
      chainRecord({
        id: "usage-string-field",
        usage: { ...zeroUsage, input: "0" } as unknown as ChainRecord["usage"],
      }),
      strip(chainRecord({ id: "missing-created-at" }), "createdAt"),
      chainRecord({ id: "nan-created-at", createdAt: Number.NaN }),
      strip(chainRecord({ id: "missing-updated-at" }), "updatedAt"),
      chainRecord({ id: "nan-updated-at", updatedAt: Number.NaN }),
    ];

    const s = ChainStore.rebuild([entry(created), ...malformed.map(entry)], () => {});

    expect(s.list()).toEqual([created]);
  });
});