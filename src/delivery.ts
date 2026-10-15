import type { RunStatus } from "./registry.ts";
import type { DeliveryMode } from "./settings.ts";

export const RESULT_MESSAGE_TYPE = "pi-subagents/result";
export const PRIVATE_MESSAGE_TYPE = "pi-subagents/private";

export interface DeliveryPort {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
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
    port.sendMessage({ customType: PRIVATE_MESSAGE_TYPE, content: render(env), display: true, details }, { triggerTurn: false });
    return;
  }
  const options = mode === "auto" ? { triggerTurn: true, deliverAs: "followUp" as const } : { triggerTurn: false };
  port.sendMessage({ customType: RESULT_MESSAGE_TYPE, content: render(env), display: true, details }, options);
}

/** Used by the `context` handler so private results never reach the model. */
export function stripPrivateMessages<T>(messages: T[]): T[] {
  return messages.filter((m) => {
    const msg = m as { role?: string; customType?: string };
    return !(msg.role === "custom" && msg.customType === PRIVATE_MESSAGE_TYPE);
  });
}
