import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ScriptStep {
  text?: string;
  stopReason?: "stop" | "error" | "aborted";
  errorMessage?: string;
  /** Wait this long before answering (lets a test steer while the turn is running). */
  delayMs?: number;
  /** Never answer until the request is aborted, then return an aborted message. */
  waitForAbort?: boolean;
}

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL = "faux-1";

/** A faux provider whose answers come from `scriptFile` (JSON ScriptStep[]); every request's messages go to `seenFile`. */
export function scriptedProvider(scriptFile: string, seenFile: string) {
  const handle = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL, contextWindow: 100_000 }] });
  const cursorFile = `${scriptFile}.cursor`;
  const step = async (context: { messages: unknown[] }, options?: { signal?: AbortSignal }) => {
    const n = existsSync(cursorFile) ? Number(readFileSync(cursorFile, "utf8")) : 0;
    writeFileSync(cursorFile, String(n + 1));
    appendFileSync(seenFile, `${JSON.stringify(context.messages)}\n`);
    const steps = JSON.parse(readFileSync(scriptFile, "utf8")) as ScriptStep[];
    const s = steps[n] ?? { text: "done" };
    if (s.waitForAbort) {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" });
    }
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    return fauxAssistantMessage(s.text ?? "", { ...(s.stopReason ? { stopReason: s.stopReason } : {}), ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}) });
  };
  handle.setResponses(Array.from({ length: 50 }, () => step));
  return handle;
}

/** Loaded into `pi --mode rpc -ne -e <this file>` by the RPC contract tests. */
export default function (pi: ExtensionAPI): void {
  pi.registerProvider(scriptedProvider(process.env.SCRIPTED_PROVIDER_SCRIPT!, process.env.SCRIPTED_PROVIDER_SEEN!).provider);
}
