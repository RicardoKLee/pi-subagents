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

/** A finished child's result that could not be delivered yet (its parent was paused). */
export interface PendingResult {
  fromId: string;
  handle: string;
  summary: string;
  sessionFile: string;
  filePath?: string;
  at: number;
}

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
  /** Set for skill and command entries; absent means an agent entry (records written before M5 keep working). */
  entry?: { kind: "skill" | "command"; name: string };
  /** Working directory of the child process; absent means the main session's cwd (records written before M4). */
  cwd?: string;
  /**
   * Model and thinking level this run was created with (already resolved: the call's own choice, else the agent
   * file's, else the settings default). Absent = inherit, which is also every record written before this field.
   * Pinned like `runner`, so resuming a subagent keeps the model it was started with.
   */
  model?: string;
  thinking?: string;
  /** Set for chain steps: the chain this run belongs to and its 0-based position. */
  chainId?: string;
  stepIndex?: number;
  createdAt: number;
  updatedAt: number;
  usage: Usage;
  lastSummary?: string;
  error?: string;
  /** Results from direct children waiting for this parent to resume. */
  pending?: PendingResult[];
  /** When the current pending batch was last reported to the user (reminder dedupe). */
  pendingNotifiedAt?: number;
}

/** The entry an existing record was started from: `skill:<name>` / `command:<name>` for skill and command entries, the base agent name otherwise. */
export function recordEntryLabel(record: Pick<SubagentRecord, "agent" | "entry">): string {
  return record.entry ? `${record.entry.kind}:${record.entry.name}` : record.agent;
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
  /** Set for skill and command entries; absent means an agent entry. */
  entry?: { kind: "skill" | "command"; name: string };
  /** Working directory for the child process (already resolved); absent means the main session's cwd. */
  cwd?: string;
  /** Effective model and thinking level of the run; see `SubagentRecord.model`. */
  model?: string;
  thinking?: string;
  /** Set for chain steps: the chain this run belongs to and its 0-based position. */
  chainId?: string;
  stepIndex?: number;
  /** "queued" while the run waits for a slot and a child session; defaults to "running". */
  status?: "queued" | "running";
  /** Child results that are already waiting when the record is created (rare; used by rebuild/restore paths). */
  pending?: PendingResult[];
}

export type RecordPatch = Partial<
  Pick<
    SubagentRecord,
    "status" | "runId" | "lastSummary" | "error" | "delivery" | "task" | "entry" | "sessionFile" | "childLeafId" | "cwd" | "model" | "thinking" | "chainId" | "stepIndex" | "pending" | "pendingNotifiedAt"
  >
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
      ...(input.entry ? { entry: { ...input.entry } } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.chainId ? { chainId: input.chainId, stepIndex: input.stepIndex ?? 0 } : {}),
      ...(input.pending ? { pending: input.pending.map((p) => ({ ...p })) } : {}),
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
