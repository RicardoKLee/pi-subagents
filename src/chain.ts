import { randomUUID } from "node:crypto";
import { type Usage, ZERO_USAGE } from "./registry.ts";

export const CHAIN_ENTRY_TYPE = "pi-subagents/chain";

export type ChainStatus = "running" | "paused" | "completed" | "failed" | "stopped";

export interface ChainStep {
  agent: string;
  task: string;
  cwd?: string;
}

export interface ChainRecord {
  id: string;
  steps: ChainStep[];
  /** Records of the steps that have started, in order. */
  stepRecordIds: string[];
  /**
   * 0-based index of the active/stopping step. When `status` is `running` this is the
   * current step; when `status` is `failed`, `paused`, or `stopped` it is the index of
   * the step the chain stopped/paused on. There is intentionally no separate
   * `failedStep` field, so `currentStep` is the single source of truth.
   */
  currentStep: number;
  status: ChainStatus;
  /** Sum of the finished steps' usage (display only; each step record keeps its own). */
  usage: Usage;
  createdAt: number;
  updatedAt: number;
}

export type ChainPatch = Partial<Pick<ChainRecord, "stepRecordIds" | "currentStep" | "status" | "usage">>;

const CHAIN_STATUSES: readonly string[] = ["running", "paused", "completed", "failed", "stopped"];

function isStep(value: unknown): value is ChainStep {
  const s = value as Partial<ChainStep> | null;
  return !!s && typeof s.agent === "string" && typeof s.task === "string";
}

function isUsage(value: unknown): value is Usage {
  const u = value as Partial<Usage> | null;
  return (
    !!u &&
    typeof u === "object" &&
    Number.isFinite(u.input) &&
    Number.isFinite(u.output) &&
    Number.isFinite(u.cacheRead) &&
    Number.isFinite(u.cacheWrite) &&
    Number.isFinite(u.cost)
  );
}

/**
 * Structural validation for a persisted chain entry. Every field the store later reads
 * must be present and well-typed: a malformed entry must be rejected at reload time rather
 * than surfacing as an uncaught `TypeError` (e.g. `addUsage`) or a broken render.
 */
function isChain(value: unknown): value is ChainRecord {
  const c = value as Partial<ChainRecord> | null;
  return (
    !!c &&
    typeof c.id === "string" &&
    Array.isArray(c.steps) &&
    c.steps.every(isStep) &&
    typeof c.status === "string" &&
    CHAIN_STATUSES.includes(c.status) &&
    Number.isFinite(c.currentStep) &&
    Array.isArray(c.stepRecordIds) &&
    isUsage(c.usage) &&
    Number.isFinite(c.createdAt) &&
    Number.isFinite(c.updatedAt)
  );
}

/** Chain definitions and progress, persisted as `pi-subagents/chain` entries (rebuilt like the record registry). */
export class ChainStore {
  private readonly chains = new Map<string, ChainRecord>();

  constructor(
    private readonly persist: (chain: ChainRecord) => void,
    private readonly now: () => number = Date.now,
  ) {}

  static rebuild(entries: readonly unknown[], persist: (chain: ChainRecord) => void, now?: () => number): ChainStore {
    const store = new ChainStore(persist, now);
    store.reload(entries);
    return store;
  }

  /** Replaces all chains with those on the given branch: the latest entry per id wins. Does not persist. */
  reload(entries: readonly unknown[]): void {
    this.chains.clear();
    for (const entry of entries) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e?.type !== "custom" || e.customType !== CHAIN_ENTRY_TYPE || !isChain(e.data)) continue;
      this.chains.set(e.data.id, structuredClone(e.data));
    }
  }

  /** Put a chain back (e.g. one still running after a branch switch) and persist it to the current branch. */
  restore(chain: ChainRecord): ChainRecord {
    return this.save(structuredClone(chain));
  }

  create(input: { steps: ChainStep[] }): ChainRecord {
    const t = this.now();
    return this.save({
      id: randomUUID(),
      steps: input.steps.map((s) => ({ ...s })),
      stepRecordIds: [],
      currentStep: 0,
      status: "running",
      usage: { ...ZERO_USAGE },
      createdAt: t,
      updatedAt: t,
    });
  }

  update(id: string, patch: ChainPatch): ChainRecord {
    const chain = this.chains.get(id);
    if (!chain) throw new Error(`unknown chain id: ${id}`);
    return this.save({ ...chain, ...patch, updatedAt: this.now() });
  }

  /**
   * Returns the live internal record (not a copy) so callers can read it cheaply. The only
   * supported mutation path is `update()`; do not mutate the returned object in place. Note
   * that `reload()` stores copies, whereas `create`/`update`/`restore` return live references —
   * this asymmetry is intentional for now.
   */
  get(id: string): ChainRecord | undefined {
    return this.chains.get(id);
  }

  list(): ChainRecord[] {
    return [...this.chains.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private save(chain: ChainRecord): ChainRecord {
    this.chains.set(chain.id, chain);
    this.persist(structuredClone(chain));
    return chain;
  }
}