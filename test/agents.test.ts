import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgents, parseAgentFile } from "../src/agents.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const md = (front: string, body = "You are a reviewer.") => `---\n${front}\n---\n${body}\n`;

describe("parseAgentFile", () => {
  it("parses the official-example fields", () => {
    const { agent } = parseAgentFile(
      md("name: reviewer\ndescription: Reviews code\ntools: read, grep\nmodel: claude-haiku-4-5"),
      "/a/reviewer.md",
      "user",
    );
    expect(agent).toMatchObject({
      name: "reviewer",
      description: "Reviews code",
      tools: ["read", "grep"],
      model: "claude-haiku-4-5",
      systemPrompt: "You are a reviewer.",
      source: "user",
    });
  });

  it("parses the extended optional fields", () => {
    const { agent, warning } = parseAgentFile(
      md("name: scout\ndescription: Recon\nthinking: low\nrunner: rpc\ndelivery: private\nhandle: sc\nallowed_subagents: [explore, oracle]"),
      "/a/scout.md",
      "user",
    );
    expect(warning).toBeUndefined();
    expect(agent).toMatchObject({ thinking: "low", runner: "rpc", handle: "sc", allowedSubagents: ["explore", "oracle"] });
    expect(agent).not.toHaveProperty("delivery");
  });

  it("ignores a delivery field in frontmatter", () => {
    const { agent, warning } = parseAgentFile(md("name: a\ndescription: d\ndelivery: private"), "/a/a.md", "user");
    expect(warning).toBeUndefined();
    expect(agent).not.toHaveProperty("delivery");
  });

  it("keeps an explicit empty allowed_subagents list", () => {
    const { agent } = parseAgentFile(md("name: a\ndescription: d\nallowed_subagents: []"), "/a/a.md", "user");
    expect(agent?.allowedSubagents).toEqual([]);
  });

  it("ignores unknown fields", () => {
    const { agent, warning } = parseAgentFile(md("name: a\ndescription: d\nmodel_profile: fast\ncolor: blue"), "/a/a.md", "user");
    expect(warning).toBeUndefined();
    expect(agent?.name).toBe("a");
  });

  it("warns and skips a file without name or description", () => {
    const { agent, warning } = parseAgentFile(md("name: a"), "/a/a.md", "user");
    expect(agent).toBeUndefined();
    expect(warning).toContain("/a/a.md");
  });

  it("warns on an invalid runner or delivery and drops the field", () => {
    const { agent, warning } = parseAgentFile(md("name: a\ndescription: d\nrunner: docker"), "/a/a.md", "user");
    expect(agent?.runner).toBeUndefined();
    expect(warning).toContain("runner");
  });
});

describe("loadAgents", () => {
  function dirs() {
    const root = tempDir("agents-");
    const user = join(root, "user");
    const project = join(root, "project");
    mkdirSync(user);
    mkdirSync(project);
    writeFileSync(join(user, "reviewer.md"), md("name: reviewer\ndescription: user reviewer"));
    writeFileSync(join(project, "reviewer.md"), md("name: reviewer\ndescription: project reviewer"));
    writeFileSync(join(user, "notes.txt"), "ignored");
    return { user, project };
  }

  it("loads only user agents by default scope", () => {
    const { user, project } = dirs();
    const { agents } = loadAgents({ userDir: user, projectDir: project, scope: "user" });
    expect(agents.get("reviewer")?.description).toBe("user reviewer");
  });

  it("lets project agents override user agents with scope both", () => {
    const { user, project } = dirs();
    const { agents } = loadAgents({ userDir: user, projectDir: project, scope: "both" });
    expect(agents.get("reviewer")?.source).toBe("project");
  });

  it("treats a missing directory as empty", () => {
    const { agents, warnings } = loadAgents({ userDir: "/nonexistent/agents", scope: "user" });
    expect(agents.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("skips a file with invalid YAML and warns", () => {
    const { user } = dirs();
    const bad = join(user, "bad.md");
    writeFileSync(bad, md("name: a\ndescription: d: e: ["));
    let result: ReturnType<typeof loadAgents> | undefined;
    expect(() => {
      result = loadAgents({ userDir: user, scope: "user" });
    }).not.toThrow();
    expect(result?.agents.get("reviewer")?.description).toBe("user reviewer");
    expect(result?.warnings).toHaveLength(1);
    expect(result?.warnings[0]).toContain(bad);
  });

  it("skips a directory named like an agent file", () => {
    const { user } = dirs();
    mkdirSync(join(user, "x.md"));
    let result: ReturnType<typeof loadAgents> | undefined;
    expect(() => {
      result = loadAgents({ userDir: user, scope: "user" });
    }).not.toThrow();
    expect(result?.warnings).toHaveLength(1);
    expect(result?.warnings[0]).toContain("x.md");
  });
});
