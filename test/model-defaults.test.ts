import { afterAll, describe, expect, it } from "vitest";
import { boot } from "./boot.ts";
import { cleanupTempDirs } from "./tmp.ts";

afterAll(cleanupTempDirs);

const MODEL = { provider: "main-prov", id: "main-model" };
/** `modelRegistry.find` for a resolvable spec; anything else resolves to nothing, as pi would for an unknown id. */
const find = (provider: string, id: string) =>
  [`${provider}/${id}`].includes("deeproute/deepseek-v4.1-flash") || provider === "deeproute" ? { provider, id, contextWindow: 64000 } : undefined;
const ok = { text: "done", stopReason: "stop" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } };

const AGENT_WITH_MODEL = "---\nname: owned\ndescription: Names its own model\nmodel: deeproute/own-model\n---\nOwn.";
const AGENT_WITH_THINKING = "---\nname: thinker\ndescription: Names its own thinking\nthinking: high\n---\nThink.";

describe("model resolution order", () => {
  it("uses the global defaultModel for an agent that names none", async () => {
    const { runner, callTool } = await boot({ scripts: [[ok]], settings: { defaultModel: "deeproute/deepseek-v4.1-flash" }, model: MODEL, find });
    await callTool({ action: "run", agent: "reviewer", task: "x" });
    expect(runner.opened[0]!.agent.model).toBe("deeproute/deepseek-v4.1-flash");
  });

  it("keeps the agent file's model over the default", async () => {
    const { runner, callTool } = await boot({
      scripts: [[ok]],
      settings: { defaultModel: "deeproute/deepseek-v4.1-flash" },
      extraAgents: { "owned.md": AGENT_WITH_MODEL },
      model: MODEL,
      find,
    });
    await callTool({ action: "run", agent: "owned", task: "x" });
    expect(runner.opened[0]!.agent.model).toBe("deeproute/own-model");
  });

  it("lets the tool call's model win over the agent file and the default", async () => {
    const { runner, callTool } = await boot({
      scripts: [[ok]],
      settings: { defaultModel: "deeproute/deepseek-v4.1-flash" },
      model: MODEL,
      find,
    });
    await callTool({ action: "run", agent: "reviewer", task: "x", model: "deeproute/from-the-call" });
    expect(runner.opened[0]!.agent.model).toBe("deeproute/from-the-call");
  });

  it("inherits the main session's model when nothing configures one", async () => {
    const { runner, callTool } = await boot({ scripts: [[ok]], model: MODEL, find });
    await callTool({ action: "run", agent: "reviewer", task: "x" });
    // No spec at all: the runner resolves `undefined` to the main session's model.
    expect(runner.opened[0]!.agent.model).toBeUndefined();
  });

  it("gives a skill entry the configured default model", async () => {
    const { runner, callTool } = await boot({
      scripts: [[ok]],
      settings: { defaultModel: "deeproute/deepseek-v4.1-flash" },
      extraSkills: { review: "Review the diff." },
      model: MODEL,
      find,
    });
    await callTool({ action: "run", skill: "review", task: "src" });
    expect(runner.opened[0]!.agent.model).toBe("deeproute/deepseek-v4.1-flash");
  });

  it("warns and inherits when the default model cannot be resolved", async () => {
    const { runner, callTool, notes } = await boot({ scripts: [[ok]], settings: { defaultModel: "deeproute/missing-model" }, model: MODEL, find: () => undefined });
    await callTool({ action: "run", agent: "reviewer", task: "x" });
    expect(runner.opened[0]!.agent.model).toBeUndefined();
    expect(notes.some((n) => n.message.includes("defaultModel") && n.type === "warning")).toBe(true);
  });

  it("pins the model a run was created with, so a resume keeps it", async () => {
    const { runner, callTool } = await boot({ scripts: [[ok], [ok]], settings: { defaultModel: "deeproute/deepseek-v4.1-flash" }, model: MODEL, find });
    const started = await callTool({ action: "run", agent: "reviewer", task: "x", model: "deeproute/pinned" });
    const handle = /@([\w-]+)/.exec(started.content[0].text)![1]!;
    await callTool({ action: "resume", handle, message: "again" });
    expect(runner.opened.map((spec) => spec.agent.model)).toEqual(["deeproute/pinned", "deeproute/pinned"]);
  });

  it("carries a per-step model through a chain", async () => {
    const { runner, callTool } = await boot({ scripts: [[ok], [ok]], settings: { defaultModel: "deeproute/deepseek-v4.1-flash" }, model: MODEL, find });
    await callTool({ action: "chain", chain: [{ agent: "reviewer", task: "one", model: "deeproute/step" }, { agent: "reviewer", task: "two" }] });
    expect(runner.opened.map((spec) => spec.agent.model)).toEqual(["deeproute/step", "deeproute/deepseek-v4.1-flash"]);
  });
});

describe("thinking resolution order", () => {
  it("defaults to off, so a child does not think unless something says so", async () => {
    const { runner, callTool } = await boot({ scripts: [[ok]], model: MODEL, find });
    await callTool({ action: "run", agent: "reviewer", task: "x" });
    expect(runner.opened[0]!.agent.thinking).toBe("off");
  });

  it("uses the configured defaultThinking", async () => {
    const { runner, callTool } = await boot({ scripts: [[ok]], settings: { defaultThinking: "low" }, model: MODEL, find });
    await callTool({ action: "run", agent: "reviewer", task: "x" });
    expect(runner.opened[0]!.agent.thinking).toBe("low");
  });

  it("keeps the agent file's thinking level over the default", async () => {
    const { runner, callTool } = await boot({
      scripts: [[ok]],
      settings: { defaultThinking: "low" },
      extraAgents: { "thinker.md": AGENT_WITH_THINKING },
      model: MODEL,
      find,
    });
    await callTool({ action: "run", agent: "thinker", task: "x" });
    expect(runner.opened[0]!.agent.thinking).toBe("high");
  });

  it("lets the tool call's thinking win over everything", async () => {
    const { runner, callTool } = await boot({
      scripts: [[ok]],
      settings: { defaultThinking: "low" },
      extraAgents: { "thinker.md": AGENT_WITH_THINKING },
      model: MODEL,
      find,
    });
    await callTool({ action: "run", agent: "thinker", task: "x", thinking: "max" });
    expect(runner.opened[0]!.agent.thinking).toBe("max");
  });
});

describe("project settings layer", () => {
  it("overrides the global default model for a trusted project", async () => {
    const { runner, callTool } = await boot({
      scripts: [[ok]],
      settings: { defaultModel: "deeproute/deepseek-v4.1-flash" },
      projectSettings: { defaultModel: "deeproute/project-model" },
      projectTrusted: true,
      model: MODEL,
      find,
    });
    await callTool({ action: "run", agent: "reviewer", task: "x" });
    expect(runner.opened[0]!.agent.model).toBe("deeproute/project-model");
  });

  it("ignores the project file of an untrusted project", async () => {
    const { runner, callTool } = await boot({
      scripts: [[ok]],
      settings: { defaultModel: "deeproute/deepseek-v4.1-flash" },
      projectSettings: { defaultModel: "deeproute/project-model" },
      projectTrusted: false,
      model: MODEL,
      find,
    });
    await callTool({ action: "run", agent: "reviewer", task: "x" });
    expect(runner.opened[0]!.agent.model).toBe("deeproute/deepseek-v4.1-flash");
  });
});