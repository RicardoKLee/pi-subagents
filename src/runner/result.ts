import { type StopReason, toStopReason } from "./types.ts";

export interface TurnMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

function textOf(message: TurnMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((c): c is { type: "text"; text: string } => !!c && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => c.text)
    .join("")
    .trim();
}

/**
 * The answer of one turn, from the messages produced by that turn only (never an earlier turn's answer).
 * Mirrors AgentSession.getLastAssistantText: an aborted assistant message without content is skipped for the text.
 */
export function turnResult(messages: readonly TurnMessage[], aborted = false): { text: string; stopReason: StopReason; errorMessage?: string } {
  const assistants = messages.filter((m) => m.role === "assistant");
  const last = assistants.at(-1);
  const answer = [...assistants].reverse().find((m) => !(m.stopReason === "aborted" && Array.isArray(m.content) && m.content.length === 0));
  const stopReason = aborted ? "aborted" : toStopReason(last?.stopReason);
  return {
    text: answer ? textOf(answer) : "",
    stopReason,
    ...(last?.errorMessage ? { errorMessage: last.errorMessage } : {}),
  };
}
