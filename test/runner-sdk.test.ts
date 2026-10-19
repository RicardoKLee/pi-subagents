import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, createProvider, InMemoryCredentialStore, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type AgentSession, type AgentSessionEvent, ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "../src/agents.ts";
import { SdkChildSession, SdkRunner } from "../src/runner/sdk.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

/**
 * compat's registerFauxProvider only registers the API implementation, not a provider entry, so a
 * fresh ModelRuntime knows nothing about "faux". Bridge it here (test-only) with a keyless provider
 * that streams through the registered faux API implementation.
 */
async function fauxRuntime(agentDir: string, model: Model<any>): Promise<ModelRuntime> {
  // In-memory stores: registerNativeProvider starts an unawaited refresh that would otherwise recreate
  // auth.json / models-store.json under agentDir after afterAll has removed it.
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: join(agentDir, "models.json"),
  });
  const api = getApiProvider(model.api as Api);
  if (!api) throw new Error(`no API implementation registered for "${String(model.api)}"`);
  runtime.registerNativeProvider(
    createProvider({
      id: model.provider,
      name: model.provider,
      auth: { apiKey: { name: model.provider, resolve: async () => ({ auth: {} }) } },
      models: [model],
      api: { stream: api.stream, streamSimple: api.streamSimple },
    }),
  );
  return runtime;
}

const agent: AgentDef = { name: "echo", description: "test", systemPrompt: "You are a test agent.", source: "user", filePath: "/x/echo.md", tools: [] };

describe("SdkRunner", () => {
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 100000 }] });
  let modelRuntime: ModelRuntime;
  beforeAll(async () => {
    modelRuntime = await fauxRuntime(join(tempDir("sdk-runtime-"), "agent"), faux.getModel());
  });
  afterEach(() => faux.setResponses([]));

  function runner() {
    const root = tempDir("sdk-");
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    return {
      root,
      runner: new SdkRunner({ agentDir: join(root, "agent"), resolveModel: () => faux.getModel(), modelRuntime }),
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

  it("resumes from a pinned leaf without the later branch", async () => {
    const seen: string[] = [];
    faux.setResponses([
      fauxAssistantMessage("noted kiwi"),
      fauxAssistantMessage("noted mango"),
      (context) => {
        seen.push(context.messages.map((m) => JSON.stringify(m)).join("\n"));
        return fauxAssistantMessage("kiwi");
      },
    ]);
    const { runner: r, spec } = runner();
    const first = await r.open(spec);
    await first.prompt("remember the word kiwi");
    const file = first.sessionFile;
    const kiwiLeaf = first.leafId;
    expect(kiwiLeaf).toBeTruthy();
    await first.dispose();

    const other = await r.open({ ...spec, resumeFile: file });
    await other.prompt("remember the word mango");
    await other.dispose();

    const pinned = await r.open({ ...spec, resumeFile: file, resumeLeafId: kiwiLeaf });
    await pinned.prompt("which word?");
    await pinned.dispose();
    expect(seen[0]).toContain("kiwi");
    expect(seen[0]).not.toContain("mango");
    expect(readFileSync(file, "utf8")).toContain("mango");
  });

  it("rejects an unknown pinned leaf", async () => {
    faux.setResponses([fauxAssistantMessage("first")]);
    const { runner: r, spec } = runner();
    const first = await r.open(spec);
    await first.prompt("hello");
    const file = first.sessionFile;
    await first.dispose();
    await expect(r.open({ ...spec, resumeFile: file, resumeLeafId: "no-such-entry" })).rejects.toThrow(/not found/);
  });

  it("does not report the previous turn's answer for an aborted turn", async () => {
    faux.setResponses([
      fauxAssistantMessage("first"),
      (_context, options) =>
        new Promise((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" })), { once: true }),
        ),
    ]);
    const { runner: r, spec } = runner();
    const s = await r.open(spec);
    expect((await s.prompt("one")).text).toBe("first");
    const pending = s.prompt("two");
    await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(0));
    await s.abort();
    const result = await pending;
    expect(result.stopReason).toBe("aborted");
    expect(result.text).toBe("");
    await s.dispose();
  });

  // Guards the real path end to end: compaction settings are read from the agentDir settings.json and pi's own
  // compaction really runs inside the turn. The turn-slicing boundary itself (which messages belong to this turn
  // once compaction rewrites the history) is guarded by the fake-session cases in "SdkChildSession turn boundary" below.
  it("still reports this turn's answer when compaction shrinks the history during the turn", async () => {
    // Arrange: one responder for every model call; summary requests are told apart by pi's summarization system prompt.
    let summaries = 0;
    const respond = (context: { messages: unknown[] }) => {
      if (JSON.stringify(context.messages).includes("context summarization assistant")) {
        summaries++;
        return fauxAssistantMessage("summary of earlier turns");
      }
      const lastUser = [...context.messages].reverse().find((m) => (m as { role?: string }).role === "user") as { content: unknown };
      const text = typeof lastUser.content === "string" ? lastUser.content : (lastUser.content as { text?: string }[]).map((c) => c.text ?? "").join("");
      return fauxAssistantMessage(`reply:${text.slice(0, 20)}`);
    };
    faux.setResponses(Array.from({ length: 20 }, () => respond));
    const { root, runner: r, spec } = runner();
    const settingsFile = join(root, "agent", "settings.json");
    // Phase 1: build a history of 4 turns (8 messages) with compaction off.
    writeFileSync(settingsFile, JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    const first = await r.open(spec);
    for (let i = 0; i < 4; i++) await first.prompt(`turn ${i} ${"filler ".repeat(200)}`);
    const file = first.sessionFile;
    await first.dispose();
    expect(summaries).toBe(0);

    // Phase 2: the user's settings now force compaction before the next prompt (threshold 100 tokens, keep almost nothing).
    writeFileSync(settingsFile, JSON.stringify({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 99900, keepRecentTokens: 1 } }));
    const resumed = await r.open({ ...spec, resumeFile: file });

    // Act
    const result = await resumed.prompt("final question");
    await resumed.dispose();

    // Assert: compaction really ran (read from the agentDir settings) and the answer is this turn's, not empty.
    expect(summaries).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toContain('"type":"compaction"');
    expect(result.text).toBe("reply:final question");
    expect(result.stopReason).toBe("stop");
  });

  for (const mode of ["steer", "followUp"] as const) {
    it(`should_report_the_reply_to_a_${mode}_message_when_it_arrives_during_the_same_run`, async () => {
      // Arrange: the first model call waits on a gate so the message can be queued while the run is active
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const seen: string[] = [];
      faux.setResponses([
        async () => {
          await gate;
          return fauxAssistantMessage("first reply");
        },
        (context) => {
          seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage(`reply to ${mode}`);
        },
      ]);
      const { runner: r, spec } = runner();
      const s = await r.open(spec);
      const pending = s.prompt("start");
      await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(1));

      // Act
      await s.steer(`extra ${mode} input`, mode);
      release();
      const result = await pending;
      await s.dispose();

      // Assert: the queued message was answered inside this run, and that answer is the run's result
      expect(faux.getPendingResponseCount()).toBe(0);
      expect(seen[0]).toContain(`extra ${mode} input`);
      expect(result.text).toBe(`reply to ${mode}`);
      expect(result.stopReason).toBe("stop");
    });
  }

  it("should_report_only_this_turn_usage_when_the_session_already_has_usage", async () => {
    // Arrange
    faux.setResponses([fauxAssistantMessage("first ".repeat(50)), fauxAssistantMessage("second")]);
    const { runner: r, spec } = runner();
    const s = await r.open(spec);
    // Act
    const first = await s.prompt("one");
    const second = await s.prompt("two");
    await s.dispose();
    // Assert: each result carries its own turn's tokens, not the running session total
    expect(first.usage.output).toBeGreaterThan(0);
    expect(second.usage.output).toBeGreaterThan(0);
    expect(second.usage.output).toBeLessThan(first.usage.output);
  });

  describe("project trust", () => {
    const bashAgent: AgentDef = { ...agent, tools: ["bash"] };

    /**
     * A project whose cwd/.pi/settings.json prefixes every bash command with `touch <prefixMarker>`.
     * agentSettings go to the agentDir's settings.json (the user's own settings, always trusted).
     */
    function project(projectTrusted?: () => boolean | undefined, agentSettings: Record<string, unknown> = {}, projectSettings?: Record<string, unknown>) {
      const root = tempDir("sdk-trust-");
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      const prefixMarker = join(root, "prefix-ran");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, ...agentSettings }));
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(projectSettings ?? { shellCommandPrefix: `touch '${prefixMarker}'` }));
      const r = new SdkRunner({
        agentDir,
        resolveModel: () => faux.getModel(),
        modelRuntime,
        ...(projectTrusted ? { projectTrusted } : {}),
      });
      return { root, agentDir, cwd, prefixMarker, runner: r, spec: { agent: bashAgent, cwd, sessionDir: join(root, "sessions"), appendSystemPrompt: [agent.systemPrompt] } };
    }

    /** The child runs one bash command that touches commandMarker; returns whether the project's prefix ran too. */
    async function runBash(p: ReturnType<typeof project>): Promise<boolean> {
      const commandMarker = join(p.root, "command-ran");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: `touch '${commandMarker}'` }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      const s = await p.runner.open(p.spec);
      const result = await s.prompt("run it");
      await s.dispose();
      expect(result.text).toBe("done");
      // The bash tool really ran, so a missing prefix marker means the prefix was not applied (not that bash never ran).
      expect(existsSync(commandMarker)).toBe(true);
      return existsSync(p.prefixMarker);
    }

    it("should_ignore_the_project_shellCommandPrefix_when_projectTrusted_returns_false", async () => {
      expect(await runBash(project(() => false))).toBe(false);
    });

    it("should_apply_the_project_shellCommandPrefix_when_projectTrusted_returns_true", async () => {
      expect(await runBash(project(() => true))).toBe(true);
    });

    it("should_treat_an_undefined_trust_as_untrusted_when_nothing_trusts_the_project", async () => {
      // Same as `pi --mode rpc` without -a/-na: no trust.json entry and defaultProjectTrust "ask" without a UI = untrusted.
      expect(await runBash(project(() => undefined))).toBe(false);
    });

    it("should_treat_a_missing_projectTrusted_option_as_untrusted_when_nothing_trusts_the_project", async () => {
      expect(await runBash(project())).toBe(false);
    });

    it("should_use_the_saved_trust_decision_when_projectTrusted_returns_undefined", async () => {
      const p = project(() => undefined);
      new ProjectTrustStore(p.agentDir).set(p.cwd, true);
      expect(await runBash(p)).toBe(true);
    });

    it("should_use_defaultProjectTrust_always_when_projectTrusted_returns_undefined", async () => {
      expect(await runBash(project(() => undefined, { defaultProjectTrust: "always" }))).toBe(true);
    });

    it("should_not_run_the_project_npmCommand_on_open_when_projectTrusted_returns_false", async () => {
      // A missing project package makes resource loading install it with the project's npmCommand.
      const root = tempDir("sdk-npm-");
      const marker = join(root, "npm-ran");
      const p = project(() => false, {}, { npmCommand: ["sh", "-c", `touch '${marker}'`], packages: ["npm:pi-subagents-missing-test-pkg"] });
      vi.stubEnv("PI_OFFLINE", "");
      try {
        const s = await p.runner.open(p.spec);
        await s.dispose();
      } finally {
        vi.unstubAllEnvs();
      }
      expect(existsSync(marker)).toBe(false);
    });
  });
});

/**
 * Deterministic stand-in for AgentSession: prompt() emits the given events to subscribers and then
 * replaces `messages` the way a compaction inside the turn would. Only the members SdkChildSession uses.
 */
function fakeSession(initial: unknown[], turn: { events: AgentSessionEvent[]; after: unknown[]; fail?: Error }) {
  const listeners: ((e: AgentSessionEvent) => void)[] = [];
  const session = {
    messages: initial,
    sessionFile: "/fake/session.jsonl",
    sessionManager: { getLeafId: () => "leaf" },
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
    subscribe(listener: (e: AgentSessionEvent) => void) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    async prompt() {
      for (const e of turn.events) for (const l of [...listeners]) l(e);
      session.messages = turn.after;
      if (turn.fail) throw turn.fail;
    },
    async waitForIdle() {},
    dispose() {},
    listenerCount: () => listeners.length,
    /** Delivers events to whoever is subscribed right now (for tests that script prompt() themselves). */
    emit: (events: AgentSessionEvent[]) => {
      for (const e of events) for (const l of [...listeners]) l(e);
    },
  };
  return session;
}

describe("SdkChildSession turn boundary", () => {
  const user = (text: string) => ({ role: "user", content: text });
  const answer = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
  const summary = { role: "compactionSummary", summary: "earlier turns" };
  const history = [user("q0"), answer("old 0"), user("q1"), answer("old 1")];

  it("reports this turn's answer when compaction leaves the history exactly as long as before", async () => {
    const reply = answer("new answer");
    const fake = fakeSession(history, {
      events: [{ type: "message_end", message: user("final") as never }, { type: "message_end", message: reply as never }, { type: "agent_settled", aborted: false }],
      after: [summary, user("q1"), user("final"), reply],
    });
    const start = fake.messages.length;
    const result = await new SdkChildSession(fake as unknown as AgentSession).prompt("final");
    expect(fake.messages.length).toBe(start);
    expect(result.text).toBe("new answer");
    expect(result.stopReason).toBe("stop");
    expect(fake.listenerCount()).toBe(0);
  });

  it("does not report an answer kept by compaction when the turn produced none", async () => {
    const fake = fakeSession(history, {
      events: [{ type: "message_end", message: user("final") as never }, { type: "agent_settled", aborted: false }],
      after: [summary, user("q0"), answer("old 0"), user("q1"), answer("old 1"), user("final")],
    });
    const result = await new SdkChildSession(fake as unknown as AgentSession).prompt("final");
    expect(result.text).toBe("");
    expect(fake.listenerCount()).toBe(0);
  });

  it("should_report_aborted_when_the_run_settles_aborted_even_if_the_last_answer_says_stop", async () => {
    // Arrange: the provider finished its message normally, but the run itself was aborted
    const fake = fakeSession(history, {
      events: [{ type: "message_end", message: answer("partial") as never }, { type: "agent_settled", aborted: true }],
      after: [...history, user("final"), answer("partial")],
    });
    // Act
    const result = await new SdkChildSession(fake as unknown as AgentSession).prompt("final");
    // Assert: agent_settled.aborted wins over the message's own stopReason
    expect(result.stopReason).toBe("aborted");
    expect(result.text).toBe("partial");
  });

  it("should_not_carry_an_abort_into_the_next_turn_when_the_same_session_is_prompted_again", async () => {
    // Arrange: two prompts on one SdkChildSession; only the first run settles aborted
    let call = 0;
    const fake = fakeSession(history, { events: [], after: history });
    fake.prompt = async () => {
      fake.emit(
        call++ === 0
          ? [{ type: "message_end", message: answer("one") as never }, { type: "agent_settled", aborted: true }]
          : [{ type: "message_end", message: answer("two") as never }, { type: "agent_settled", aborted: false }],
      );
    };
    const child = new SdkChildSession(fake as unknown as AgentSession);
    // Act
    const first = await child.prompt("one");
    const second = await child.prompt("two");
    // Assert
    expect(first).toMatchObject({ text: "one", stopReason: "aborted" });
    expect(second).toMatchObject({ text: "two", stopReason: "stop" });
    expect(fake.listenerCount()).toBe(0);
  });

  it("should_unsubscribe_when_prompt_throws", async () => {
    // Arrange: AgentSession.prompt rejects (e.g. preflight failure) after the listener is attached
    const fake = fakeSession(history, { events: [], after: history, fail: new Error("preflight failed") });
    // Act + Assert: the error propagates and no listener is left on the session
    await expect(new SdkChildSession(fake as unknown as AgentSession).prompt("final")).rejects.toThrow("preflight failed");
    expect(fake.listenerCount()).toBe(0);
  });
});
