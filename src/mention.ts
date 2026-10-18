import type { SubagentRecord } from "./registry.ts";
import type { DeliveryMode } from "./settings.ts";

export const MAIN_HANDLE = "main";

/** Delivery symbols written right after the handle: `@reviewer? ...`. */
const SYMBOLS: Record<string, DeliveryMode> = { "?": "private", "!": "auto", "~": "share" };

/** `@` or `@sub:`, a handle-like token, an optional delivery symbol, then whitespace or the end of the text. */
const MENTION = /^@(sub:)?([^\s?!~]*)([?!~])?(?=\s|$)([\s\S]*)$/;
/** Handles are slugs (see handles.ts); bare mentions accept any casing, @sub: requires the slug form. */
const BARE_HANDLE = /^[a-z0-9][a-z0-9-]*$/i;
const NS_HANDLE = /^[a-z0-9][a-z0-9-]*$/;

export interface Mention {
  form: "bare" | "ns";
  /** Lowercase handle used for registry lookups. */
  handle: string;
  /** The handle as typed; used for the file-exists check. */
  raw: string;
  delivery?: DeliveryMode;
  message: string;
}

/** Undefined when the text does not start with a mention (bare tokens that look like paths are not mentions). */
export function parseMention(text: string): Mention | { error: string } | undefined {
  if (!text.startsWith("@")) return undefined;
  const match = MENTION.exec(text);
  if (!match) return text.startsWith("@sub:") ? { error: "invalid @sub: reference; use @sub:<handle> <message>" } : undefined;
  const [, ns, raw = "", symbol, rest = ""] = match;
  const form = ns ? "ns" : "bare";
  if (!(form === "ns" ? NS_HANDLE : BARE_HANDLE).test(raw)) {
    return form === "ns" ? { error: `invalid @sub: reference "@sub:${raw}"; handles use a-z, 0-9 and -` } : undefined;
  }
  return {
    form,
    handle: raw.toLowerCase(),
    raw,
    ...(symbol ? { delivery: SYMBOLS[symbol] } : {}),
    message: rest.trim(),
  };
}

export interface RouteContext {
  resolve(handle: string): SubagentRecord | undefined;
  known(): string[];
  /** True when a file or directory named `raw` exists in the cwd (files win over bare handles). */
  fileExists(raw: string): boolean;
  /** Delivery for mentions without a symbol (settings.defaultDelivery). */
  defaultDelivery: DeliveryMode;
}

export type Route =
  | { action: "pass" }
  | { action: "main"; text: string }
  | { action: "error"; message: string }
  | { action: "steer"; handle: string; message: string; delivery?: DeliveryMode }
  | { action: "resume"; handle: string; message: string; delivery: DeliveryMode };

/** Decides what an input line starting with `@` does. Pure: no side effects. */
export function routeMention(text: string, ctx: RouteContext): Route {
  const parsed = parseMention(text);
  if (!parsed) return { action: "pass" };
  if ("error" in parsed) return { action: "error", message: parsed.error };
  const { form, handle, raw, delivery, message } = parsed;

  if (handle === MAIN_HANDLE) {
    if (form === "ns") return { action: "error", message: "@sub:main is reserved for the main session; write @main or just the message" };
    if (ctx.fileExists(raw) || !message) return { action: "pass" };
    if (delivery) return { action: "error", message: "@main takes no delivery symbol; write @main <message>" };
    return { action: "main", text: message };
  }
  if (form === "bare" && ctx.fileExists(raw)) return { action: "pass" };

  const record = ctx.resolve(handle);
  if (!record) {
    if (form === "bare") return { action: "pass" };
    const known = ctx.known().map((h) => `@${h}`).join(", ") || "(none)";
    return { action: "error", message: `no subagent @${handle}. Known: ${known}` };
  }
  if (!message) return { action: "error", message: `write a message after @${record.handle}` };
  switch (record.status) {
    case "running":
      return { action: "steer", handle: record.handle, message, ...(delivery ? { delivery } : {}) };
    case "queued":
      return { action: "error", message: `@${record.handle} is queued and has not started yet` };
    case "stopped":
      return { action: "error", message: `@${record.handle} was stopped and cannot be resumed; ask the main agent to start a new one` };
    default:
      return { action: "resume", handle: record.handle, message, delivery: delivery ?? ctx.defaultDelivery };
  }
}
