import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "../src/agents.ts";
import { RpcRunner } from "../src/runner/rpc.ts";
import { SdkRunner } from "../src/runner/sdk.ts";
import type { ChildSpec, Runner } from "../src/runner/types.ts";
import { FAUX_MODEL, FAUX_PROVIDER, type ScriptStep, scriptedProvider } from "./fixtures/scripted-provider.ts";
import { tempDir } from "./tmp.ts";

export const FIXTURE = fileURLToPath(new URL("./fixtures/scripted-provider.ts", import.meta.url));

export const echoAgent: AgentDef = { name: "echo", description: "test", systemPrompt: "You are a test agent.", source: "user", filePath: "/x/echo.md", tools: [] };

export interface Harness {
  runner: Runner;
  spec: ChildSpec;
  /** Replaces the scripted answers and restarts the script from its first step. */
  script(steps: ScriptStep[]): void;
  /** Messages of every model request so far, one JSON string per request. */
  seen(): string[];
}

/** A runner of the given kind wired to the scripted faux provider, with an isolated agent dir (no user config, no credentials). */
export async function harness(kind: "sdk" | "rpc"): Promise<Harness> {
  const root = tempDir(`${kind}-h-`);
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // Deterministic tests: no automatic retry of scripted errors.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const scriptFile = join(root, "script.json");
  const seenFile = join(root, "seen.jsonl");
  const script = (steps: ScriptStep[]) => {
    writeFileSync(scriptFile, JSON.stringify(steps));
    rmSync(`${scriptFile}.cursor`, { force: true });
  };
  script([]);
  writeFileSync(seenFile, "");
  const spec: ChildSpec = { agent: echoAgent, cwd, sessionDir: join(root, "sessions"), appendSystemPrompt: [echoAgent.systemPrompt] };
  const seen = () => readFileSync(seenFile, "utf8").split("\n").filter(Boolean);

  if (kind === "sdk") {
    const provider = scriptedProvider(scriptFile, seenFile);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerNativeProvider(provider.provider);
    const runner = new SdkRunner({ agentDir, resolveModel: () => provider.getModel(), modelRuntime });
    return { runner, spec, script, seen };
  }
  const runner = new RpcRunner({
    resolveModel: () => ({ provider: FAUX_PROVIDER, id: FAUX_MODEL }),
    agentDir,
    extraArgs: ["-e", FIXTURE, "--offline"],
    env: { PI_OFFLINE: "1", SCRIPTED_PROVIDER_SCRIPT: scriptFile, SCRIPTED_PROVIDER_SEEN: seenFile },
  });
  return { runner, spec, script, seen };
}
