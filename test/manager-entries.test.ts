import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { ChainStore } from "../src/chain.ts";
import type { DeliveryPort } from "../src/delivery.ts";
import { SubagentManager } from "../src/manager.ts";
import { Registry } from "../src/registry.ts";
import type { ChildResult } from "../src/runner/types.ts";
import { Scheduler } from "../src/scheduler.ts";
import { DEFAULT_SETTINGS, type SubagentSettings } from "../src/settings.ts";
import { FakeRunner, FakeSession, usage } from "./fakes.ts";
import { writeSkill } from "./fixtures/skill-fixtures.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

// The manager validates skill names against `<homeDir>/.agents/skills` and takes no homeDir dependency, so point
// HOME at a fresh temp dir for this file: the negative lookup must not depend on what the host has installed.
const realHome = process.env.HOME;
beforeAll(() => {
  process.env.HOME = tempDir("entry-home-");
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  cleanupTempDirs();
});

const codeAgent: AgentDef = { name: "code-agent", description: "codes", systemPrompt: "Code.", source: "user", filePath: "/a/code-agent.md" };
const ok = (text: string): ChildResult => ({ text, stopReason: "stop", usage: usage() });
const err = (message: string): ChildResult => ({ text: "", stopReason: "error", errorMessage: message, usage: usage(0) });

function setup(opts: { scripts?: ChildResult[][]; settings?: Partial<SubagentSettings>; withSkill?: boolean } = {}) {
  const root = tempDir("entry-");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (opts.withSkill) writeSkill(agentDir, "pdf-tools");
  const scripts = opts.scripts ?? [];
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, scripts[n] ?? [], false);
  });
  const sent: Parameters<DeliveryPort["sendMessage"]>[] = [];
  const registry = new Registry(() => {});
  const manager = new SubagentManager({
    registry,
    chainStore: new ChainStore(() => {}),
    scheduler: new Scheduler(() => 4),
    runners: { sdk: runner, rpc: undefined },
    agents: () => new Map([[codeAgent.name, codeAgent]]),
    settings: () => ({ ...DEFAULT_SETTINGS, maxResident: 0, ...opts.settings }),
    port: { sendMessage: (...args) => sent.push(args), appendEntry: () => {} },
    receiverContextWindow: () => 200000,
    cwd: root,
    agentDir,
    sessionDir: join(root, "sessions"),
    outputDir: join(root, "out"),
  });
  return { manager, runner, registry, sent, root, agentDir };
}

describe("skill and command entries", () => {
  it("runs a skill entry, sends the slash prompt and records the entry", async () => {
    const { manager, runner } = setup({ withSkill: true, scripts: [[ok("done")]] });
    const { record } = await manager.run({ skill: "pdf-tools", task: "extract a.pdf" });
    expect(runner.sessions[0]!.prompts).toEqual(["/skill:pdf-tools extract a.pdf"]);
    expect(record.task).toBe("/skill:pdf-tools extract a.pdf");
    expect(record.entry).toEqual({ kind: "skill", name: "pdf-tools" });
    expect(record.handle).toBe("pdf-tools");
    expect(record.agent).toBe("subagent");
    expect(runner.opened[0]!.agent.name).toBe("subagent");
    expect(runner.opened[0]!.agent.systemPrompt).toBe("");
  });

  it("rejects an unknown skill before creating a record", async () => {
    const { manager } = setup();
    await expect(manager.run({ skill: "nope", task: "x" })).rejects.toThrow(/unknown skill "nope"/);
    expect(manager.list()).toHaveLength(0);
  });

  it("rejects a mix of entry kinds and a missing agent task", async () => {
    const { manager } = setup({ withSkill: true });
    await expect(manager.run({ agent: "code-agent", skill: "pdf-tools" })).rejects.toThrow(/exactly one of/);
    await expect(manager.run({ agent: "code-agent" })).rejects.toThrow(/requires "task" for an agent entry/);
    expect(manager.list()).toHaveLength(0);
  });

  it("resumes a skill entry without the agent file and keeps the base", async () => {
    const { manager, runner, registry } = setup({ withSkill: true, scripts: [[ok("first")], [ok("second")]] });
    await manager.run({ skill: "pdf-tools", task: "one" });
    const { record } = await manager.resume("pdf-tools", "two", { delivery: "auto" });
    expect(record.status).toBe("completed");
    expect(registry.resolve("pdf-tools")!.entry).toEqual({ kind: "skill", name: "pdf-tools" });
    expect(runner.opened[1]!.agent.name).toBe("subagent");
    // maxResident 0 closes the child after every turn, so the resume opens a second session and "two" goes there.
    expect([...runner.sessions[0]!.prompts, ...runner.sessions[1]!.prompts]).toEqual(["/skill:pdf-tools one", "two"]);
  });

  it("runs a parallel batch with mixed entry kinds", async () => {
    const { manager, runner } = setup({ withSkill: true, scripts: [[ok("a")], [ok("b")]] });
    const out = await manager.runParallel({
      items: [
        { skill: "pdf-tools", task: "one" },
        { agent: "code-agent", task: "two" },
      ],
    });
    expect(out.records.map((r) => r.handle)).toEqual(["pdf-tools", "code-agent"]);
    expect(out.records.map((r) => r.entry?.kind ?? "agent")).toEqual(["skill", "agent"]);
    expect(runner.sessions[0]!.prompts).toEqual(["/skill:pdf-tools one"]);
    expect(runner.sessions[1]!.prompts).toEqual(["two"]);
  });

  it("substitutes {previous} into a skill step's args", async () => {
    const { manager, runner } = setup({ withSkill: true, scripts: [[ok("alpha")], [ok("beta")]] });
    const out = await manager.runChain({
      steps: [
        { agent: "code-agent", task: "first" },
        { skill: "pdf-tools", task: "summarise {previous}" },
      ],
    });
    expect(out.chain!.status).toBe("completed");
    expect(runner.sessions[1]!.prompts).toEqual(["/skill:pdf-tools summarise alpha"]);
    expect(out.records[1]!.entry).toEqual({ kind: "skill", name: "pdf-tools" });
  });

  it("quotes the ask in a mention-style delivery", async () => {
    const { manager, sent } = setup({ withSkill: true, scripts: [[ok("done")]] });
    await manager.run({ skill: "pdf-tools", task: "extract a.pdf", background: true, delivery: "auto", ask: "/skill:pdf-tools extract a.pdf" });
    await manager.whenIdle();
    expect(sent[0]![0].content).toContain("[user asked @pdf-tools]");
    expect(sent[0]![0].content).toContain("/skill:pdf-tools extract a.pdf");
  });

  it("continues a chain that failed on a skill step by replaying the slash prompt", async () => {
    const { manager, runner } = setup({ withSkill: true, scripts: [[ok("alpha")], [err("rate limited")], [ok("beta")], [ok("gamma")]] });
    const out = await manager.runChain({
      steps: [
        { agent: "code-agent", task: "first" },
        { skill: "pdf-tools", task: "summarise {previous}" },
        { agent: "code-agent", task: "final {previous}" },
      ],
    });
    expect(out.chain!.status).toBe("failed");
    expect(out.chain!.currentStep).toBe(1);
    // The chain keeps the entry fields of a skill step so it can be continued (and reloaded) as such.
    expect(manager.listChains()[0]!.steps[1]).toMatchObject({ skill: "pdf-tools", task: "summarise {previous}" });
    const failed = out.records.at(-1)!;
    const cont = await manager.continueChain(failed.handle);
    expect(cont.chain!.status).toBe("completed");
    // The skill step is replayed with its substituted slash prompt, then the remaining step runs.
    expect(runner.sessions[2]!.prompts).toEqual(["/skill:pdf-tools summarise alpha"]);
    expect(runner.sessions[3]!.prompts).toEqual(["final beta"]);
  });
});