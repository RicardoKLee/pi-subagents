import type { RunStatus } from "./registry.ts";
import type { DeliveryMode } from "./settings.ts";

export const RESULT_MESSAGE_TYPE = "pi-subagents/result";
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

export interface ResultEnvelope {
  handle: string;
  agent: string;
  status: RunStatus;
  /** Already sized by preparePayload. */
  text: string;
  /** Child session file, so the full transcript stays reachable from the main session. */
  sessionFile: string;
  filePath?: string;
}

function render(env: ResultEnvelope): string {
  return `[subagent @${env.handle} (${env.agent}) ${env.status}]\n${env.text}\n\nSession: ${env.sessionFile}`;
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
