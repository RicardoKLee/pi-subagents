import { describe, expect, it } from "vitest";
import { CHAIN_ENTRY_TYPE, type ChainRecord, ChainStore } from "../src/chain.ts";

const steps = [{ agent: "reviewer", task: "one" }, { agent: "reviewer", task: "two {previous}" }];

function store() {
  const persisted: ChainRecord[] = [];
  return { persisted, store: new ChainStore((c) => persisted.push(structuredClone(c))) };
}

const entry = (chain: ChainRecord) => ({ type: "custom", customType: CHAIN_ENTRY_TYPE, data: chain });

describe("ChainStore", () => {
  it("creates a chain with running status and persists it", () => {
    const { store: s, persisted } = store();
    const chain = s.create({ steps });
    expect(chain).toMatchObject({ status: "running", currentStep: 0, stepRecordIds: [], usage: { cost: 0 } });
    expect(chain.id).toBeTruthy();
    expect(persisted).toHaveLength(1);
    expect(s.list()).toHaveLength(1);
  });

  it("update patches the chain and persists", () => {
    const { store: s, persisted } = store();
    const chain = s.create({ steps });
    const updated = s.update(chain.id, { currentStep: 1, status: "failed", stepRecordIds: ["r1", "r2"] });
    expect(updated).toMatchObject({ currentStep: 1, status: "failed", stepRecordIds: ["r1", "r2"] });
    expect(persisted).toHaveLength(2);
    expect(s.get(chain.id)!.status).toBe("failed");
  });

  it("rebuild keeps the latest entry per chain and ignores foreign entries", () => {
    const { store: s } = store();
    const chain = s.create({ steps });
    const older = structuredClone(chain);
    s.update(chain.id, { status: "completed", currentStep: 1 });
    const latest = s.get(chain.id)!;
    const rebuilt = ChainStore.rebuild([entry(older), { type: "custom", customType: "other", data: {} }, entry(latest)], () => {});
    expect(rebuilt.list()).toEqual([latest]);
  });

  it("reload replaces the chains of the branch without persisting", () => {
    const { store: s, persisted } = store();
    const chain = s.create({ steps });
    const before = persisted.length;
    s.reload([]);
    expect(s.list()).toEqual([]);
    expect(persisted).toHaveLength(before);
    s.restore(chain);
    expect(s.list()).toEqual([chain]);
    expect(persisted).toHaveLength(before + 1);
  });

  it("update on an unknown chain throws", () => {
    expect(() => store().store.update("nope", { status: "completed" })).toThrow(/unknown chain/);
  });
});