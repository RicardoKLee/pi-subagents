import type { TreeView } from "./tree.ts";
import { SUBAGENT_ACTIONS } from "./tool.ts";

/**
 * The `/subagents` verbs that are also `subagents` tool actions. Derived from `SUBAGENT_ACTIONS` so the two lists cannot
 * drift: a rename in the tool schema shows up here as a missing verb instead of a second, stale word list.
 */
const CONTROL_ACTION_NAMES = new Set<string>(["stop", "stop-all", "interrupt", "interrupt-all", "restart"]);
const CONTROL_VERBS: readonly string[] = SUBAGENT_ACTIONS.filter((action) => CONTROL_ACTION_NAMES.has(action));

/** The views this command can print (`list` is the default). */
const VIEW_VERBS: readonly TreeView[] = ["list", "cost"];

/** Every first word `/subagents` accepts, in the order the help text lists them. */
export const SUBAGENT_VERBS: readonly string[] = [...VIEW_VERBS, ...CONTROL_VERBS, "help"];

/** One parsed `/subagents` argument line. */
export type SubagentCommand =
  | { kind: "view"; view: TreeView }
  | { kind: "help" }
  | { kind: "stop"; handle: string }
  | { kind: "interrupt"; handle: string }
  | { kind: "restart"; handle: string; message?: string }
  | { kind: "stop-all" }
  | { kind: "interrupt-all" }
  | { kind: "error"; message: string };

/** The verbs that must name exactly one subagent: a typo must never turn "stop one" into "stop all". */
const HANDLE_VERBS = new Set<string>(["stop", "interrupt", "restart"]);

/**
 * Strips the addressing sugar off a user-typed handle: `@x`, `x` and `@sub:x` all mean `x`, and a `父/子` path is kept
 * as written. An empty result is a missing handle, never "every subagent".
 */
export function parseHandle(token: string | undefined): string | undefined {
  if (!token) return undefined;
  let handle = token.trim();
  if (handle.startsWith("@")) handle = handle.slice(1);
  if (handle.toLowerCase().startsWith("sub:")) handle = handle.slice(4);
  handle = handle.trim();
  return handle.length ? handle : undefined;
}

/**
 * Parses one `/subagents` argument line. The verb comes first — `@handle …` keeps meaning "tell that subagent", so a
 * control word typed after a handle is never read as a command (`§7.4`: "why not `@x stop`").
 */
export function parseSubagentsCommand(raw: string): SubagentCommand {
  const text = raw.trim();
  if (!text) return { kind: "view", view: "list" };
  const space = text.search(/\s/);
  const verb = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : text.slice(space + 1).trim();

  if (VIEW_VERBS.includes(verb as TreeView)) return { kind: "view", view: verb as TreeView };
  if (verb === "help") return { kind: "help" };

  if (verb === "stop-all" || verb === "interrupt-all") {
    // A handle would read as "only that one", which these actions cannot honor; refuse instead of ignoring it.
    if (rest) return { kind: "error", message: `"${verb}" takes no handle; it applies to every subagent` };
    return { kind: verb };
  }

  if (HANDLE_VERBS.has(verb)) {
    const words = rest.split(/\s+/).filter(Boolean);
    const handle = parseHandle(words[0]);
    if (!handle) return { kind: "error", message: `/${verb} needs a handle, e.g. /subagents ${verb} @reviewer` };
    if (verb === "restart") {
      const message = rest.slice(rest.indexOf(words[0]!) + words[0]!.length).trim();
      return { kind: "restart", handle, ...(message ? { message } : {}) };
    }
    if (words.length > 1) return { kind: "error", message: `/${verb} takes a handle only, e.g. /subagents ${verb} @reviewer` };
    return { kind: verb as "stop" | "interrupt", handle };
  }

  if (verb.startsWith("/")) {
    // A second slash usually means two commands were typed on one line: say so instead of listing every verb.
    return { kind: "error", message: `${text} was not run; type it on its own line` };
  }

  return { kind: "error", message: `unknown verb "${verb}"; use one of ${SUBAGENT_VERBS.join(", ")}` };
}

/** One completion candidate for `/subagents`. */
export interface SubagentCompletion {
  value: string;
  label: string;
  description: string;
}

/**
 * Completions for `/subagents`: the first word completes verbs, the second completes handles of subagents that may be
 * addressed. Verbs that take no handle offer nothing more, so a stray handle is never suggested for `stop-all`.
 */
export function subagentsCompletions(prefix: string, known: () => string[]): SubagentCompletion[] {
  const text = prefix.replace(/^\s+/, "");
  const space = text.search(/\s/);
  if (space === -1) {
    const typed = text.trim().toLowerCase();
    return SUBAGENT_VERBS.filter((verb) => verb.startsWith(typed)).map((verb) => ({
      value: verb,
      label: verb,
      description: verb === "list" ? "status and cost" : verb === "cost" ? "tokens and cost" : verb === "help" ? "the control verbs" : `subagents ${verb}`,
    }));
  }
  const verb = text.slice(0, space).toLowerCase();
  if (!HANDLE_VERBS.has(verb)) return [];
  const partial = parseHandle(text.slice(space + 1))?.toLowerCase() ?? "";
  return known()
    .filter((handle) => handle.toLowerCase().startsWith(partial))
    .map((handle) => ({ value: `@${handle}`, label: `@${handle}`, description: handle }));
}

/** The `/subagents` help text: the verbs, one example each, and the shortcut. */
export const SUBAGENTS_HELP = [
  "用法：/subagents <动词> [@handle] [消息]",
  "  /subagents list | cost — 列表与成本",
  "  /subagents stop @x — 永久结束（不能 resume；之后可 restart）",
  "  /subagents interrupt @x — 暂停（可 resume，也可 restart）",
  "  /subagents restart @x [消息] — 同一 handle、新会话、按原 task 重跑",
  "  /subagents stop-all — 结束所有 active；paused 保持可 resume",
  "  /subagents interrupt-all — 暂停所有运行中的",
  "  快捷键：ctrl+shift+x = /subagents stop-all",
].join("\n");

/** The control verbs a `/subagents` invocation can perform (the ones that act on subagents). */
export type ControlCommand = Extract<SubagentCommand, { kind: "stop" | "interrupt" | "restart" | "stop-all" | "interrupt-all" }>;
