import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadSkills, type ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "./agents.ts";

/** Name recorded as the base of skill and command entries (never resolved from the agents directory). */
export const BUILTIN_ENTRY_AGENT = "subagent";

/** Base for skill / command entries: no extra system prompt, model inherited, pi's default tools. */
export const BUILTIN_ENTRY_AGENT_DEF: AgentDef = {
  name: BUILTIN_ENTRY_AGENT,
  description: "Built-in base for skill and command entries",
  systemPrompt: "",
  source: "user",
  filePath: "",
};

export const SUB_USAGE = [
  "用法：",
  "  /sub [--cwd <目录>] <agent> <任务>",
  "  /sub [--cwd <目录>] /skill:<名字> [参数]",
  "  /sub [--cwd <目录>] /<模板> [参数]",
  "投递：/sub! = auto，/sub~ = share，/sub? = private（不带符号用设置 defaultDelivery）",
  "创建后用 @<handle> 续聊，用 /subagents 查看列表。",
].join("\n");

export type EntryKind = "agent" | "skill" | "command";

export interface EntryRequest {
  agent?: string;
  skill?: string;
  command?: string;
  task?: string;
}

export interface ResolvedEntry {
  kind: EntryKind;
  name: string;
  /** The text handed to the child session. */
  prompt: string;
}

/** Exactly one of agent / skill / command; an agent entry needs a task, skill and command entries may omit it. */
export function parseEntryRequest(req: EntryRequest, action: string): ResolvedEntry {
  const given = [
    req.agent ? `agent` : "",
    req.skill ? `skill` : "",
    req.command ? `command` : "",
  ].filter(Boolean);
  if (given.length !== 1) {
    throw new Error(`action "${action}" needs exactly one of "agent", "skill" or "command"`);
  }
  const task = (req.task ?? "").trim();
  if (req.agent) {
    if (!task) throw new Error(`action "${action}" requires "task" for an agent entry`);
    return { kind: "agent", name: req.agent, prompt: task };
  }
  if (req.skill) return { kind: "skill", name: req.skill, prompt: task ? `/skill:${req.skill} ${task}` : `/skill:${req.skill}` };
  return { kind: "command", name: req.command!, prompt: task ? `/${req.command} ${task}` : `/${req.command}` };
}

export interface EntryValidationContext {
  cwd: string;
  agentDir: string;
  agents: ReadonlyMap<string, AgentDef>;
  skillPaths?: string[];
  promptPaths?: string[];
  /** Home directory used to locate the shared `<home>/.agents/skills`; defaults to `homeDir()`. */
  homeDir?: string;
}

/** Same rule pi's own `getHomeDir()` uses when resolving the shared `~/.agents/skills` directory. */
export function homeDir(): string {
  return process.env.HOME || homedir();
}

const MAX_LISTED = 30;

function listed(names: readonly string[], hint?: string): string {
  if (!names.length) return "(none)";
  if (names.length <= MAX_LISTED) return names.join(", ");
  const head = `${names.slice(0, MAX_LISTED).join(", ")} (+${names.length - MAX_LISTED} more)`;
  return hint ? `${head}\n${hint}` : head;
}

/**
 * Skill names a child session would discover for this cwd.
 *
 * Covers `<agentDir>/skills`, `<cwd>/.pi/skills` and `<home>/.agents/skills` (pi loads the last one
 * unconditionally), plus any explicit `skillPaths`. Names are de-duplicated and sorted.
 *
 * Known gaps (tracked as future work, not regressions): project-ancestor `.agents/skills` directories
 * are skipped because they require pi's project-trust context, and pi settings / package-resolved
 * explicit skill paths are not reflected here.
 */
export interface SkillDiscovery {
  names: string[];
  /** Diagnostics of the loader: a skill that failed to load shows up here instead of silently missing. */
  diagnostics: ResourceDiagnostic[];
}

/** Skill names and loader diagnostics for this cwd and agent dir (same discovery the child uses). */
export function discoverSkills(ctx: Pick<EntryValidationContext, "cwd" | "agentDir" | "skillPaths" | "homeDir">): SkillDiscovery {
  const { skills, diagnostics } = loadSkills({
    cwd: ctx.cwd,
    agentDir: ctx.agentDir,
    skillPaths: [...(ctx.skillPaths ?? []), join(ctx.homeDir ?? homeDir(), ".agents", "skills")],
    includeDefaults: true,
  });
  return { names: [...new Set(skills.map((s) => s.name))].sort(), diagnostics };
}

export function skillNames(ctx: Pick<EntryValidationContext, "cwd" | "agentDir" | "skillPaths" | "homeDir">): string[] {
  return discoverSkills(ctx).names;
}

/** Prompt template names from the conventional directories (pi does not export its template loader). */
export function templateNames(ctx: Pick<EntryValidationContext, "cwd" | "agentDir" | "promptPaths">): string[] {
  const dirs = [join(ctx.agentDir, "prompts"), resolve(ctx.cwd, ".pi", "prompts"), ...(ctx.promptPaths ?? [])];
  const names = new Set<string>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) if (file.endsWith(".md")) names.add(file.slice(0, -3));
  }
  return [...names].sort();
}

/** Throws with the available names and the usage text when the target does not exist. */
export function validateEntryTarget(entry: ResolvedEntry, ctx: EntryValidationContext): void {
  if (entry.kind === "agent") {
    if (ctx.agents.has(entry.name)) return;
    throw new Error(`unknown agent "${entry.name}". Available: ${listed([...ctx.agents.keys()])}\n\n${SUB_USAGE}`);
  }
  if (entry.kind === "skill") {
    const { names, diagnostics } = discoverSkills(ctx);
    if (names.includes(entry.name)) return;
    const skipped = diagnostics
      .slice(0, 3)
      .map((d) => `${d.type}: ${d.message}${d.path ? ` (${d.path})` : ""}`)
      .join("\n");
    const detail = skipped ? `\nSkipped skills:\n${skipped}` : "";
    throw new Error(`unknown skill "${entry.name}". Available: ${listed(names, "Use /sub /skill:<TAB> to see the full list.")}${detail}\n\n${SUB_USAGE}`);
  }
  const names = templateNames(ctx);
  if (names.includes(entry.name)) return;
  throw new Error(`unknown prompt template "${entry.name}". Available: ${listed(names, "Use /sub /<TAB> to see the full list.")}\n\n${SUB_USAGE}`);
}

export type SubTarget = { kind: EntryKind; name: string };

/**
 * `/sub [--cwd <dir>] <agent> <task>`, `/sub [--cwd <dir>] /skill:<name> [args]`, `/sub [--cwd <dir>] /<template> [args]`.
 * The first word picks the kind: `/skill:` → skill, other `/…` → template, anything else → agent name.
 */
export function parseSubCommand(args: string): { cwd?: string; target: SubTarget; rest: string } | { error: string } {
  let text = args.trim();
  let cwd: string | undefined;
  while (text.startsWith("--cwd")) {
    const afterFlag = text.slice("--cwd".length);
    const match = /^\s+(\S+)\s*([\s\S]*)$/.exec(afterFlag);
    if (!match) return { error: `--cwd needs a directory\n\n${SUB_USAGE}` };
    cwd = match[1]!;
    text = match[2]!.trim();
  }
  const space = text.search(/\s/);
  const first = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? "" : text.slice(space + 1).trim();
  if (!first) return { error: `nothing to start\n\n${SUB_USAGE}` };
  if (first.startsWith("/skill:")) {
    const name = first.slice("/skill:".length);
    if (!name) return { error: `a skill name is required after /skill:\n\n${SUB_USAGE}` };
    return { ...(cwd ? { cwd } : {}), target: { kind: "skill", name }, rest };
  }
  if (first.startsWith("/")) {
    const name = first.slice(1);
    if (!name) return { error: `a template name is required after /\n\n${SUB_USAGE}` };
    return { ...(cwd ? { cwd } : {}), target: { kind: "command", name }, rest };
  }
  if (!rest) return { error: `a task is required for agent "${first}"\n\n${SUB_USAGE}` };
  return { ...(cwd ? { cwd } : {}), target: { kind: "agent", name: first }, rest };
}

/**
 * TTL cache for the directory scans behind `/sub` completions: they run on every keystroke, and the discovery
 * result only changes when skills or templates are added. Injectable clock so the TTL is testable.
 */
export function createNameCache(ttlMs = 5_000, now: () => number = Date.now): { names(key: string, build: () => string[]): string[] } {
  let entry: { key: string; at: number; names: string[] } | undefined;
  return {
    names(key: string, build: () => string[]): string[] {
      const at = now();
      if (entry && entry.key === key && at - entry.at < ttlMs) return entry.names;
      const names = build();
      entry = { key, at, names };
      return names;
    },
  };
}
