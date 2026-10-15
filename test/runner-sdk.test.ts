import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { SdkRunner } from "../src/runner/sdk.ts";

const agent: AgentDef = { name: "echo", description: "test", systemPrompt: "You are a test agent.", source: "user", filePath: "/x/echo.md", tools: [] };

describe("SdkRunner", () => {
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 100000 }] });
  afterEach(() => faux.setResponses([]));

  function runner() {
    const root = mkdtempSync(join(tmpdir(), "sdk-"));
    return {
      root,
      runner: new SdkRunner({ agentDir: join(root, "agent"), resolveModel: () => faux.getModel() }),
      spec: { agent, cwd: root, sessionDir: join(root, "sessions"), appendSystemPrompt: [agent.systemPrompt] },
    };
  }

  it("runs a prompt and persists the child session", async () => {
    faux.setResponses([fauxAssistantMessage("first answer")]);
    const { runner: r, spec } = runner();
    const s = await r.open(spec);
    expect(s.sessionFile).toMatch(/\.jsonl$/);
    const result = await s.prompt("hello");
    expect(result.text).toBe("first answer");
    expect(result.stopReason).toBe("stop");
    await s.dispose();
  });

  it("resumes from the session file with prior context", async () => {
    const seen: string[][] = [];
    faux.setResponses([
      fauxAssistantMessage("first answer"),
      (context) => {
        seen.push(context.messages.map((m) => JSON.stringify(m)));
        return fauxAssistantMessage("second answer");
      },
    ]);
    const { runner: r, spec } = runner();
    const first = await r.open(spec);
    await first.prompt("remember the word kiwi");
    const file = first.sessionFile;
    await first.dispose();

    const resumed = await r.open({ ...spec, resumeFile: file });
    const result = await resumed.prompt("what was the word?");
    expect(result.text).toBe("second answer");
    expect(resumed.sessionFile).toBe(file);
    expect(seen[0]!.join("\n")).toContain("kiwi");
    await resumed.dispose();
  });

  it("reports error stop reason with the message", async () => {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
    const { runner: r, spec } = runner();
    const s = await r.open(spec);
    const result = await s.prompt("x");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("boom");
    await s.dispose();
  });
});
