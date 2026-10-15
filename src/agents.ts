import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { DeliveryMode, RunnerKind } from "./settings.ts";

export type AgentScope = "user" | "project" | "both";

export interface AgentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  runner?: RunnerKind;
  delivery?: DeliveryMode;
  handle?: string;
  /** undefined = may spawn any agent; [] = may spawn none (enforced from M6). */
  allowedSubagents?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

type RawFrontmatter = Record<string, unknown>;

function toList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

export function parseAgentFile(
  content: string,
  filePath: string,
  source: "user" | "project",
): { agent?: AgentDef; warning?: string } {
  const { frontmatter, body } = parseFrontmatter<RawFrontmatter>(content);
  if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
    return { warning: `${filePath}: frontmatter needs string name and description; skipped` };
  }
  const problems: string[] = [];
  const agent: AgentDef = {
    name: frontmatter.name,
    description: frontmatter.description,
    systemPrompt: body.trim(),
    source,
    filePath,
  };
  const tools = toList(frontmatter.tools);
  if (tools) agent.tools = tools;
  if (typeof frontmatter.model === "string") agent.model = frontmatter.model;
  if (typeof frontmatter.thinking === "string") agent.thinking = frontmatter.thinking;
  if (typeof frontmatter.handle === "string") agent.handle = frontmatter.handle;

  if (frontmatter.runner !== undefined) {
    if (frontmatter.runner === "sdk" || frontmatter.runner === "rpc") agent.runner = frontmatter.runner;
    else problems.push("runner must be sdk or rpc");
  }
  if (frontmatter.delivery !== undefined) {
    const d = frontmatter.delivery;
    if (d === "private" || d === "share" || d === "auto") agent.delivery = d;
    else problems.push("delivery must be private, share or auto");
  }
  if (frontmatter.allowed_subagents !== undefined) {
    const list = toList(frontmatter.allowed_subagents);
    if (list) agent.allowedSubagents = list;
    else problems.push("allowed_subagents must be a list");
  }
  return problems.length ? { agent, warning: `${filePath}: ${problems.join("; ")}; field ignored` } : { agent };
}

function readDir(dir: string, source: "user" | "project", warnings: string[]): AgentDef[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    warnings.push(`cannot read ${dir}: ${(error as Error).message}`);
    return [];
  }
  const agents: AgentDef[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    const filePath = join(dir, name);
    const { agent, warning } = parseAgentFile(readFileSync(filePath, "utf8"), filePath, source);
    if (warning) warnings.push(warning);
    if (agent) agents.push(agent);
  }
  return agents;
}

/** Project agents override user agents with the same name when scope is "both". */
export function loadAgents(opts: { userDir: string; projectDir?: string; scope: AgentScope }): {
  agents: Map<string, AgentDef>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const agents = new Map<string, AgentDef>();
  if (opts.scope !== "project") for (const a of readDir(opts.userDir, "user", warnings)) agents.set(a.name, a);
  if (opts.scope !== "user" && opts.projectDir) {
    for (const a of readDir(opts.projectDir, "project", warnings)) agents.set(a.name, a);
  }
  return { agents, warnings };
}
