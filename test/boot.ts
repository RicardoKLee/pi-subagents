import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildResult, Runner } from "../src/runner/types.ts";
import { createExtension } from "../src/index.ts";
import { FakePi, fakeCtx } from "./fake-pi.ts";
import { FakeRunner, FakeSession } from "./fakes.ts";
import { writeSkill, writeTemplate } from "./fixtures/skill-fixtures.ts";
import { tempDir } from "./tmp.ts";

export const REVIEWER = "---\nname: reviewer\ndescription: Reviews code\n---\nReview.";

/** Boots the extension against a FakePi with a FakeRunner; one held or scripted child per open. */
export async function boot(
  opts: {
    hold?: boolean;
    scripts?: ChildResult[][];
    extraAgents?: Record<string, string>;
    extraSkills?: Record<string, string>;
    extraTemplates?: Record<string, string>;
    hasUI?: boolean;
    branch?: unknown[];
    settings?: Record<string, unknown>;
    rpcRunner?: Runner;
    /** Main-session model and what `modelRegistry.find` returns; used by the model resolver assertion. */
    model?: { provider: string; id: string };
    find?: (provider: string, id: string) => unknown;
    /** Extra keys for the project's `.pi/subagents.json` (written only when given). */
    projectSettings?: Record<string, unknown>;
    /** Project trust reported to the extension; absent means the context does not answer the question. */
    projectTrusted?: boolean;
  } = {},
) {
  const root = tempDir("ext-");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "reviewer.md"), REVIEWER);
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ maxResident: 0, ...opts.settings }));
  for (const [name, content] of Object.entries(opts.extraAgents ?? {})) writeFileSync(join(agentDir, "agents", name), content);
  for (const [name, body] of Object.entries(opts.extraSkills ?? {})) writeSkill(agentDir, name, body);
  for (const [name, content] of Object.entries(opts.extraTemplates ?? {})) writeTemplate(agentDir, name, content);
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  if (opts.projectSettings) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(opts.projectSettings));
  }
  const runner = new FakeRunner((spec, n) => {
    const file = spec.resumeFile ?? join(root, `child-${n}.jsonl`);
    writeFileSync(file, "", { flag: "a" });
    return new FakeSession(file, opts.scripts?.[n] ?? [], opts.hold ?? false);
  });
  const pi = new FakePi();
  const rpcResolvers: ((spec: string | undefined) => unknown)[] = [];
  createExtension({
    agentDir,
    createRunner: () => runner,
    ...(opts.rpcRunner
      ? {
          createRpcRunner: (resolveModel: (spec: string | undefined) => unknown) => {
            rpcResolvers.push(resolveModel);
            return opts.rpcRunner!;
          },
        }
      : {}),
  })(pi.asApi());
  pi.branch.push(...(opts.branch ?? []));
  const { ctx, notes, providers } = fakeCtx(pi, {
    cwd,
    sessionDir,
    hasUI: opts.hasUI ?? true,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.find ? { find: opts.find } : {}),
    ...(opts.projectTrusted === undefined ? {} : { projectTrusted: opts.projectTrusted }),
  });
  await pi.emit("session_start", { type: "session_start" }, ctx);
  const tool = pi.tools.get("subagents");
  const callTool = (params: Record<string, unknown>) => tool.execute("call-1", params, undefined, undefined, ctx);
  return { pi, ctx, notes, providers, sent: pi.sent, runner, callTool, root, cwd, agentDir, rpcRunner: opts.rpcRunner, rpcResolvers };
}