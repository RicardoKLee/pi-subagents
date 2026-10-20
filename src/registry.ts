import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { allocateHandle } from "./handles.ts";
import type { DeliveryMode, RunnerKind } from "./settings.ts";

export const REGISTRY_ENTRY_TYPE = "pi-subagents/registry";

export type RunStatus = "queued" | "running" | "paused" | "completed" | "failed" | "stopped";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export const ZERO_USAGE: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export interface SubagentRecord {
  id: string;
  handle: string;
  agent: string;
  runner: RunnerKind;
  parentId?: string;
  depth: number;
  sessionFile: string;
  /** Leaf entry of the child session when its last run ended; resume continues from here. */
  childLeafId?: string;
  /** Increments on every resume. */
  runId: number;
  status: RunStatus;
  delivery: DeliveryMode;
  task: string;
  /** Working directory of the child process; absent means the main session's cwd (records written before M4). */
  cwd?: string;
  /** Set for chain steps: the chain this run belongs to and its 0-based position. */
  chainId?: string;
  stepIndex?: number;
  createdAt: number;
  updatedAt: number;
  usage: Usage;
  lastSummary?: string;
  error?: string;
}

export interface NewRecord {
  agent: string;
  preferredHandle: string;
  runner: RunnerKind;
  parentId?: string;
  depth: number;
  sessionFile: string;
  delivery: DeliveryMode;
  task: string;
  /** Working directory for the child process (already resolved); absent means the main session's cwd. */
  cwd?: string;
  /** Set for chain steps: the chain this run belongs to and its 0-based position. */
  chainId?: string;
  stepIndex?: number;
  /** "queued" while the run waits for a slot and a child session; defaults to "running". */
  status?: "queued" | "running";
}

export type RecordPatch = Partial<
  Pick<SubagentRecord, "status" | "runId" | "lastSummary" | "error" | "delivery" | "task" | "sessionFile" | "childLeafId" | "cwd" | "chainId" | "stepIndex">
>;

function isRecord(value: unknown): value is SubagentRecord {
  const r = value as Partial<SubagentRecord> | null;
  return !!r && typeof r.id === "string" && typeof r.handle === "string" && typeof r.sessionFile === "string";
}

export class Registry {
  private readonly records = new Map<string, SubagentRecord>();

  constructor(
    private readonly persist: (r: SubagentRecord) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Rebuild from session entries: the latest registry entry per id wins. */
  static rebuild(entries: readonly unknown[], persist: (r: SubagentRecord) => void, now?: () => number): Registry {
    const registry = new Registry(persist, now);
    registry.reload(entries);
    return registry;
  }

  /** Replace all records with those on the given branch (same rules as rebuild). Does not persist. */
  reload(entries: readonly unknown[]): void {
    this.records.clear();
    for (const entry of entries) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      if (e?.type !== "custom" || e.customType !== REGISTRY_ENTRY_TYPE || !isRecord(e.data)) continue;
      this.records.set(e.data.id, structuredClone(e.data));
    }
  }

  /** Put a record back (e.g. one still running after a branch switch) and persist it to the current branch. */
  restore(record: SubagentRecord): SubagentRecord {
    return this.save(structuredClone(record));
  }

  create(input: NewRecord): SubagentRecord {
    const taken = new Set([...this.records.values()].map((r) => r.handle));
    const t = this.now();
    const record: SubagentRecord = {
      id: randomUUID(),
      handle: allocateHandle(input.preferredHandle, taken),
      agent: input.agent,
      runner: input.runner,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      depth: input.depth,
      sessionFile: input.sessionFile,
      runId: 1,
      status: input.status ?? "running",
      delivery: input.delivery,
      task: input.task,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.chainId ? { chainId: input.chainId, stepIndex: input.stepIndex ?? 0 } : {}),
      createdAt: t,
      updatedAt: t,
      usage: { ...ZERO_USAGE },
    };
    return this.save(record);
  }

  update(id: string, patch: RecordPatch): SubagentRecord {
    return this.save({ ...this.require(id), ...patch, updatedAt: this.now() });
  }

  addUsage(id: string, usage: Usage): SubagentRecord {
    const current = this.require(id);
    const sum: Usage = {
      input: current.usage.input + usage.input,
      output: current.usage.output + usage.output,
      cacheRead: current.usage.cacheRead + usage.cacheRead,
      cacheWrite: current.usage.cacheWrite + usage.cacheWrite,
      cost: Math.round((current.usage.cost + usage.cost) * 1e6) / 1e6,
    };
    return this.save({ ...current, usage: sum, updatedAt: this.now() });
  }

  get(id: string): SubagentRecord | undefined {
    return this.records.get(id);
  }

  resolve(handleOrId: string): SubagentRecord | undefined {
    const key = handleOrId.toLowerCase();
    for (const r of this.records.values()) if (r.handle === key) return r;
    return this.records.get(handleOrId);
  }

  list(): SubagentRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private require(id: string): SubagentRecord {
    const r = this.records.get(id);
    if (!r) throw new Error(`unknown subagent id: ${id}`);
    return r;
  }

  private save(record: SubagentRecord): SubagentRecord {
    this.records.set(record.id, record);
    this.persist(structuredClone(record));
    return record;
  }
}

/** Read-only snapshot for external inspection. Never used for recovery. */
export function writeSnapshot(file: string, records: readonly SubagentRecord[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, writtenAt: Date.now(), records }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
