import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { BUILTIN_ENTRY_AGENT, BUILTIN_ENTRY_AGENT_DEF, parseEntryRequest, parseSubCommand, skillNames, templateNames, validateEntryTarget } from "../src/entries.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";

afterAll(cleanupTempDirs);

const agent: AgentDef = { name: "code-agent", description: "codes", systemPrompt: "Code.", source: "user", filePath: "/a/code-agent.md" };
const ctx = (extra: Partial<{ cwd: string; agentDir: string; homeDir: string }> = {}) => ({
  cwd: extra.cwd ?? tempDir("entry-cwd-"),
  agentDir: extra.agentDir ?? tempDir("entry-agent-"),
  homeDir: extra.homeDir ?? tempDir("entry-home-"),
  agents: new Map([[agent.name, agent]]),
});

/** A skill directory in the shape pi discovers: <dir>/<name>/SKILL.md with frontmatter. */
function writeSkill(root: string, name: string, body = "Do the thing."): void {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
}

function writeTemplate(root: string, name: string, content = "Template body: $ARGUMENTS"): void {
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", `${name}.md`), content);
}

describe("parseEntryRequest", () => {
  it("names the built-in entry base", () => {
    expect(BUILTIN_ENTRY_AGENT).toBe("subagent");
  });

  it("keeps the built-in entry base fields the virtual subagent relies on", () => {
    expect(BUILTIN_ENTRY_AGENT_DEF).toMatchObject({
      name: "subagent",
      systemPrompt: "",
      source: "user",
      filePath: "",
    });
    expect(BUILTIN_ENTRY_AGENT_DEF.description).toBeTruthy();
  });

  it("parses an agent entry and requires a task", () => {
    expect(parseEntryRequest({ agent: "code-agent", task: "do it" }, "run")).toEqual({ kind: "agent", name: "code-agent", prompt: "do it" });
    expect(() => parseEntryRequest({ agent: "code-agent" }, "run")).toThrow(/requires "task"/);
  });

  it("builds the slash prompt for skill and command entries", () => {
    expect(parseEntryRequest({ skill: "pdf-tools", task: "extract a.pdf" }, "run")).toEqual({ kind: "skill", name: "pdf-tools", prompt: "/skill:pdf-tools extract a.pdf" });
    expect(parseEntryRequest({ skill: "pdf-tools" }, "run")).toEqual({ kind: "skill", name: "pdf-tools", prompt: "/skill:pdf-tools" });
    expect(parseEntryRequest({ command: "review", task: "src/x.ts" }, "parallel")).toEqual({ kind: "command", name: "review", prompt: "/review src/x.ts" });
  });

  it("rejects anything but exactly one entry kind", () => {
    for (const req of [{}, { agent: "a", skill: "s" }, { agent: "a", command: "c" }, { skill: "s", command: "c" }, { agent: "a", skill: "s", command: "c" }]) {
      expect(() => parseEntryRequest(req, "run")).toThrow(/exactly one of "agent", "skill" or "command"/);
    }
  });
});

describe("validateEntryTarget", () => {
  it("accepts a known agent, skill and template", () => {
    const c = ctx();
    writeSkill(c.agentDir, "pdf-tools");
    writeTemplate(c.agentDir, "review");
    expect(() => validateEntryTarget({ kind: "agent", name: "code-agent", prompt: "x" }, c)).not.toThrow();
    expect(() => validateEntryTarget({ kind: "skill", name: "pdf-tools", prompt: "x" }, c)).not.toThrow();
    expect(() => validateEntryTarget({ kind: "command", name: "review", prompt: "x" }, c)).not.toThrow();
  });

  it("reports unknown names with what is available and the usage text", () => {
    const c = ctx();
    writeSkill(c.agentDir, "pdf-tools");
    writeTemplate(c.agentDir, "review");
    expect(() => validateEntryTarget({ kind: "skill", name: "nope", prompt: "x" }, c)).toThrow(/unknown skill "nope".*pdf-tools/s);
    expect(() => validateEntryTarget({ kind: "command", name: "nope", prompt: "x" }, c)).toThrow(/unknown prompt template "nope".*review/s);
    expect(() => validateEntryTarget({ kind: "agent", name: "nope", prompt: "x" }, c)).toThrow(/unknown agent "nope".*code-agent/s);
    expect(() => validateEntryTarget({ kind: "skill", name: "nope", prompt: "x" }, c)).toThrow(/\/sub \[--cwd/);
  });

  it("truncates a long name list", () => {
    const c = ctx();
    for (let i = 0; i < 35; i++) writeSkill(c.agentDir, `skill-${i}`);
    let message = "";
    try {
      validateEntryTarget({ kind: "skill", name: "nope", prompt: "x" }, c);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("+5 more");
  });

  it("finds skills and templates in the project directories of the child cwd", () => {
    const c = ctx();
    writeSkill(join(c.cwd, ".pi"), "project-skill");
    writeTemplate(join(c.cwd, ".pi"), "project-template");
    expect(skillNames(c)).toContain("project-skill");
    expect(templateNames(c)).toContain("project-template");
  });

  it("finds skills in the shared home .agents/skills directory", () => {
    const c = ctx();
    writeSkill(join(c.homeDir, ".agents"), "shared-skill");
    expect(skillNames(c)).toContain("shared-skill");
    expect(() => validateEntryTarget({ kind: "skill", name: "shared-skill", prompt: "x" }, c)).not.toThrow();
  });

  it("uses the injected homeDir and does not leak process HOME skills", () => {
    const empty = ctx();
    // A fresh temp home, agent dir and cwd contain no skills, so the host HOME must not leak in.
    expect(skillNames(empty)).toEqual([]);

    const c = ctx();
    const otherHome = tempDir("entry-home-other-");
    writeSkill(join(c.homeDir, ".agents"), "home-a");
    writeSkill(join(otherHome, ".agents"), "home-b");
    expect(skillNames(c)).toContain("home-a");
    expect(skillNames({ ...c, homeDir: otherHome })).toContain("home-b");
    expect(skillNames({ ...c, homeDir: otherHome })).not.toContain("home-a");
  });

  it("returns no skills when the shared and explicit paths are missing", () => {
    const c = ctx();
    const missing = { ...c, skillPaths: [join(c.agentDir, "missing-skills")], homeDir: join(c.homeDir, "missing-home") };
    expect(() => skillNames(missing)).not.toThrow();
    expect(skillNames(missing)).toEqual([]);
  });

  it("discovers skills from explicit skillPaths directories and markdown files", () => {
    const c = ctx();
    const skillRoot = tempDir("entry-skilldir-");
    writeSkill(skillRoot, "dir-skill");
    const fileRoot = tempDir("entry-skillfile-");
    writeFileSync(join(fileRoot, "flat-skill.md"), "---\nname: flat-skill\ndescription: flat skill\n---\nBody\n");
    const withPaths = { ...c, skillPaths: [join(skillRoot, "skills"), join(fileRoot, "flat-skill.md")] };

    expect(skillNames(withPaths)).toEqual(expect.arrayContaining(["dir-skill", "flat-skill"]));
    expect(() => validateEntryTarget({ kind: "skill", name: "dir-skill", prompt: "x" }, withPaths)).not.toThrow();
    expect(() => validateEntryTarget({ kind: "skill", name: "flat-skill", prompt: "x" }, withPaths)).not.toThrow();
  });

  it("discovers templates from promptPaths directories but ignores bare file paths", () => {
    const c = ctx();
    const dirRoot = tempDir("entry-promptdir-");
    writeTemplate(dirRoot, "dir-template");
    const fileRoot = tempDir("entry-promptfile-");
    writeFileSync(join(fileRoot, "flat-template.md"), "Body $ARGUMENTS\n");
    const withPaths = { ...c, promptPaths: [join(dirRoot, "prompts"), join(fileRoot, "flat-template.md")] };

    expect(templateNames(withPaths)).toContain("dir-template");
    // Known limitation: templateNames only enumerates directories, so a bare .md path is ignored.
    expect(templateNames(withPaths)).not.toContain("flat-template");
    expect(() => validateEntryTarget({ kind: "command", name: "dir-template", prompt: "x" }, withPaths)).not.toThrow();
    expect(() => validateEntryTarget({ kind: "command", name: "flat-template", prompt: "x" }, withPaths)).toThrow(/unknown prompt template "flat-template"/);
  });

  it("accepts project skills and templates through validateEntryTarget", () => {
    const c = ctx();
    writeSkill(join(c.cwd, ".pi"), "project-skill");
    writeTemplate(join(c.cwd, ".pi"), "project-template");
    expect(() => validateEntryTarget({ kind: "skill", name: "project-skill", prompt: "x" }, c)).not.toThrow();
    expect(() => validateEntryTarget({ kind: "command", name: "project-template", prompt: "x" }, c)).not.toThrow();
  });
});

describe("parseSubCommand", () => {
  it.each([
    ["code-agent do it", { target: { kind: "agent", name: "code-agent" }, rest: "do it" }],
    ["/skill:pdf-tools extract a.pdf", { target: { kind: "skill", name: "pdf-tools" }, rest: "extract a.pdf" }],
    ["/skill:pdf-tools", { target: { kind: "skill", name: "pdf-tools" }, rest: "" }],
    ["/review src/x.ts", { target: { kind: "command", name: "review" }, rest: "src/x.ts" }],
    ["--cwd /tmp/other code-agent do it", { cwd: "/tmp/other", target: { kind: "agent", name: "code-agent" }, rest: "do it" }],
    ["--cwd /tmp/other /skill:x a b", { cwd: "/tmp/other", target: { kind: "skill", name: "x" }, rest: "a b" }],
  ])("parses %j", (args, expected) => {
    expect(parseSubCommand(args)).toMatchObject(expected);
  });

  it("keeps inner spacing and drops outer whitespace", () => {
    expect(parseSubCommand("  code-agent   two  spaces  ")).toMatchObject({ target: { kind: "agent", name: "code-agent" }, rest: "two  spaces" });
  });

  it.each([
    ["/review", { target: { kind: "command", name: "review" }, rest: "" }],
    ["--cwd /tmp/other /review", { cwd: "/tmp/other", target: { kind: "command", name: "review" }, rest: "" }],
  ])("parses a template target without args from %j", (args, expected) => {
    expect(parseSubCommand(args)).toMatchObject(expected);
  });

  it("lets the last --cwd win when the flag repeats", () => {
    expect(parseSubCommand("--cwd /first --cwd /second code-agent do it")).toEqual({
      cwd: "/second",
      target: { kind: "agent", name: "code-agent" },
      rest: "do it",
    });
  });

  it.each([["", "用法"], ["--cwd", "用法"], ["/skill:", "用法"], ["--cwd /tmp/x", "用法"]])("reports usage for %j", (args, hint) => {
    expect(parseSubCommand(args)).toMatchObject({ error: expect.stringContaining(hint) });
  });
});