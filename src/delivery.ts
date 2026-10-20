import type { RunStatus } from "./registry.ts";
import type { DeliveryMode } from "./settings.ts";

export const RESULT_MESSAGE_TYPE = "pi-subagents/result";
/** Results of a whole batch (parallel group, chain) are delivered as one message per call. */
export const BATCH_MESSAGE_TYPE = "pi-subagents/batch";
/** Private results are stored as custom entries, which never enter the LLM context (incl. compaction and branch summaries). */
export const PRIVATE_ENTRY_TYPE = "pi-subagents/private";

export interface DeliveryPort {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  appendEntry(customType: string, data: unknown): void;
}

/** Data of a `pi-subagents/private` custom entry. */
export interface PrivateEntryData {
  handle: string;
  agent: string;
  status: RunStatus;
  text: string;
  sessionFile: string;
  filePath?: string;
}

/** A user message that reached this run through `@`: the question that started it, or an instruction added while it ran. */
export interface Ask {
  kind: "ask" | "steer";
  /** Already truncated by quoteAsk. */
  text: string;
  /** Sent with `?` while the run was going: only for the user; never quoted where the main model can see it. */
  private?: boolean;
}

/** Keeps at most `maxChars` characters of a quoted user message and notes how much was cut. */
export function quoteAsk(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} more characters not shown]`;
}

export function renderAsks(handle: string, asks: readonly Ask[]): string {
  return asks
    .map((a) => `${a.kind === "ask" ? `[user asked @${handle}]` : `[user added while it was running @${handle}]`}\n${a.text}`)
    .join("\n\n");
}

export interface ResultEnvelope {
  handle: string;
  agent: string;
  status: RunStatus;
  /** Already sized by preparePayload. */
  text: string;
  /** Child session file, so the full transcript stays reachable from the main session. */
  sessionFile: string;
  filePath?: string;
  /** User messages sent through `@` for this run; quoted before the result so the receiver knows what was asked. */
  asks?: Ask[];
}

function render(env: ResultEnvelope): string {
  const result = `[subagent @${env.handle} (${env.agent}) ${env.status}]\n${env.text}\n\nSession: ${env.sessionFile}`;
  return env.asks?.length ? `${renderAsks(env.handle, env.asks)}\n\n${result}` : result;
}

export function deliver(port: DeliveryPort, mode: DeliveryMode, env: ResultEnvelope): void {
  const details = { handle: env.handle, agent: env.agent, status: env.status, sessionFile: env.sessionFile, ...(env.filePath ? { filePath: env.filePath } : {}) };
  if (mode === "private") {
    const data: PrivateEntryData = { ...details, text: render(env) };
    port.appendEntry(PRIVATE_ENTRY_TYPE, data);
    return;
  }
  const options = mode === "auto" ? { triggerTurn: true, deliverAs: "followUp" as const } : { triggerTurn: false };
  port.sendMessage({ customType: RESULT_MESSAGE_TYPE, content: render(env), display: true, details }, options);
}

/** One auto message for a batch: the main agent starts a turn when the group or chain finishes. */
export function deliverBatch(port: DeliveryPort, env: { text: string; details?: unknown }): void {
  port.sendMessage(
    { customType: BATCH_MESSAGE_TYPE, content: env.text, display: true, ...(env.details ? { details: env.details } : {}) },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}
