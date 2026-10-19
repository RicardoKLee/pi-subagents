import { readFileSync } from "node:fs";

export type DeliveryMode = "private" | "share" | "auto";
export type RunnerKind = "sdk" | "rpc";

export interface SubagentSettings {
  /** Global running-child limit. Positive = limit, 0 = disallowed, -1 = unlimited. */
  maxConcurrent: number;
  /** Per-parent running-child limit (used from M6). Same value rules. */
  maxChildrenPerParent: number;
  /** Maximum nesting depth (used from M6). Same value rules. */
  maxDepth: number;
  /** Child sessions kept open between turns (running ones included). Positive = limit, 0 = close after every turn, -1 = unlimited. */
  maxResident: number;
  /** Delivery for `@handle` messages without a symbol. Background runs started by the main agent are always auto. */
  defaultDelivery: DeliveryMode;
  defaultRunner: RunnerKind;
  /** Fraction of the receiver's context window above which output goes to a file. */
  contextRatio: number;
  /** Minutes a queued child result may wait before the user is reminded (used from M6). */
  pendingResultTimeoutMinutes: number;
  /** Longest user message quoted with an `@` result; longer messages are truncated with a note. */
  mentionQuoteMaxChars: number;
}

export const DEFAULT_SETTINGS: SubagentSettings = Object.freeze({
  maxConcurrent: 4,
  maxChildrenPerParent: 4,
  maxDepth: 2,
  maxResident: 8,
  defaultDelivery: "auto",
  defaultRunner: "sdk",
  contextRatio: 0.3,
  pendingResultTimeoutMinutes: 30,
  mentionQuoteMaxChars: 2000,
});

const LIMIT_KEYS = ["maxConcurrent", "maxChildrenPerParent", "maxDepth", "maxResident"] as const;

function isLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -1;
}

export function parseSettings(raw: unknown): { settings: SubagentSettings; warnings: string[] } {
  const settings: SubagentSettings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push("subagents settings must be a JSON object; using defaults");
    return { settings, warnings };
  }
  const input = raw as Record<string, unknown>;

  for (const key of LIMIT_KEYS) {
    if (input[key] === undefined) continue;
    if (isLimit(input[key])) settings[key] = input[key];
    else warnings.push(`${key} must be a positive integer, 0 or -1; using ${DEFAULT_SETTINGS[key]}`);
  }

  if (input.defaultDelivery !== undefined) {
    const value = input.defaultDelivery;
    if (value === "private" || value === "share" || value === "auto") settings.defaultDelivery = value;
    else warnings.push(`defaultDelivery must be private, share or auto; using ${DEFAULT_SETTINGS.defaultDelivery}`);
  }

  if (input.defaultRunner !== undefined) {
    const value = input.defaultRunner;
    if (value === "sdk" || value === "rpc") settings.defaultRunner = value;
    else warnings.push(`defaultRunner must be sdk or rpc; using ${DEFAULT_SETTINGS.defaultRunner}`);
  }

  if (input.contextRatio !== undefined) {
    const value = input.contextRatio;
    if (typeof value === "number" && value > 0 && value <= 1) settings.contextRatio = value;
    else warnings.push(`contextRatio must be in (0, 1]; using ${DEFAULT_SETTINGS.contextRatio}`);
  }

  if (input.pendingResultTimeoutMinutes !== undefined) {
    const value = input.pendingResultTimeoutMinutes;
    if (typeof value === "number" && value > 0) settings.pendingResultTimeoutMinutes = value;
    else warnings.push(`pendingResultTimeoutMinutes must be > 0; using ${DEFAULT_SETTINGS.pendingResultTimeoutMinutes}`);
  }

  if (input.mentionQuoteMaxChars !== undefined) {
    const value = input.mentionQuoteMaxChars;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) settings.mentionQuoteMaxChars = value;
    else warnings.push(`mentionQuoteMaxChars must be a positive integer; using ${DEFAULT_SETTINGS.mentionQuoteMaxChars}`);
  }

  return { settings, warnings };
}

export function loadSettings(file: string): { settings: SubagentSettings; warnings: string[] } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: { ...DEFAULT_SETTINGS }, warnings: [] };
    return { settings: { ...DEFAULT_SETTINGS }, warnings: [`cannot read ${file}: ${(error as Error).message}`] };
  }
  try {
    return parseSettings(JSON.parse(text));
  } catch (error) {
    return { settings: { ...DEFAULT_SETTINGS }, warnings: [`invalid JSON in ${file}: ${(error as Error).message}`] };
  }
}

/** True when one more item may start given `current` already running under `limit`. */
export function limitAllows(limit: number, current: number): boolean {
  if (limit === -1) return true;
  return current < limit;
}
