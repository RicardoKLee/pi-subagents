import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildRpcArgs, LEAF_PIN_ENTRY_TYPE, piCliPath, pinLeaf, RpcRunner, type RpcRunnerOptions } from "../src/runner/rpc.ts";
import type { ChildSession, ChildSpec } from "../src/runner/types.ts";
import { echoAgent } from "./harness.ts";
import { procTag } from "./proc.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const GAP_SERVER = fileURLToPath(new URL("./fixtures/fake-rpc-gap-server.mjs", import.meta.url));
const REPO_CLI = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const base: ChildSpec = { agent: echoAgent, cwd: "/w", sessionDir: "/s", appendSystemPrompt: ["Be brief."] };
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra });

describe("buildRpcArgs branches", () => {
  it("should_use_only_--session_when_resuming", () => {
    const args = buildRpcArgs({ ...base, resumeFile: "/s/a.jsonl" }, "p/m", {});
    expect(args.slice(0, 4)).toEqual(["--mode", "rpc", "--session", "/s/a.jsonl"]);
    expect(args).not.toContain("--session-dir");
    expect(args).not.toContain("/s");
  });

  it("should_pass_no_tool_flag_when_tools_are_undefined", () => {
    const args = buildRpcArgs({ ...base, agent: { ...echoAgent, tools: undefined } }, "p/m", {});
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--no-tools");
  });

  it("should_pass_no_trust_flag_when_trusted_is_undefined", () => {
    const args = buildRpcArgs(base, "p/m", { trusted: undefined, extraArgs: ["--x"] });
    expect(args).not.toContain("-a");
    expect(args).not.toContain("-na");
    expect(args.at(-1)).toBe("--x");
  });

  it("should_omit_thinking_and_system_prompts_when_absent", () => {
    const args = buildRpcArgs({ ...base, appendSystemPrompt: [] }, "p/m", {});
    expect(args).not.toContain("--thinking");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("should_keep_extra_args_after_the_trust_flag", () => {
    expect(buildRpcArgs(base, "p/m", { trusted: true, extraArgs: ["-e", "x.ts"] }).slice(-3)).toEqual(["-a", "-e", "x.ts"]);
  });
});

describe("pinLeaf edges", () => {
  function session() {
    const dir = tempDir("pin-gap-");
    const sm = SessionManager.create(dir, join(dir, "sessions"));
    sm.appendMessage({ role: "user", content: "one", timestamp: Date.now() } as never);
    sm.appendMessage(fauxAssistantMessage("a1") as never);
    const firstLeaf = sm.getLeafId()!;
    sm.appendMessage({ role: "user", content: "two", timestamp: Date.now() } as never);
    sm.appendMessage(fauxAssistantMessage("a2") as never);
    const header = (JSON.parse(readFileSync(sm.getSessionFile()!, "utf8").split("\n")[0]!) as { id: string }).id;
    return { dir, file: sm.getSessionFile()!, firstLeaf, header };
  }
  const contextText = (file: string) => JSON.stringify(SessionManager.open(file).buildSessionContext().messages);

  it("should_throw_and_create_no_file_when_the_session_file_does_not_exist", () => {
    const dir = tempDir("pin-missing-");
    const file = join(dir, "missing.jsonl");
    expect(() => pinLeaf(file, "some-leaf")).toThrow(/not found/);
    expect(existsSync(file)).toBe(false);
  });

  it("should_throw_and_leave_the_file_unchanged_when_the_leaf_is_not_an_entry", () => {
    const { file, header } = session();
    const before = readFileSync(file, "utf8");
    // The session header has an id but is not a tree entry.
    expect(() => pinLeaf(file, header)).toThrow(/not found/);
    expect(() => pinLeaf(file, "no-such-entry")).toThrow(/not found/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("should_hide_the_later_branch_from_the_reopened_context_when_pinning_an_earlier_leaf", () => {
    const { file, firstLeaf } = session();
    expect(contextText(file)).toContain("two");
    expect(pinLeaf(file, firstLeaf)).toBe(true);
    const ctx = contextText(file);
    expect(ctx).toContain("one");
    expect(ctx).toContain("a1");
    expect(ctx).not.toContain("two");
    expect(ctx).not.toContain("a2");
    expect(readFileSync(file, "utf8")).toContain("a2");
  });

  it("should_keep_the_pinned_context_when_the_same_leaf_is_pinned_again", () => {
    const { file, firstLeaf } = session();
    pinLeaf(file, firstLeaf);
    const ctx = contextText(file);
    pinLeaf(file, firstLeaf);
    expect(contextText(file)).toBe(ctx);
    expect((SessionManager.open(file).getLeafEntry() as { customType?: string }).customType).toBe(LEAF_PIN_ENTRY_TYPE);
  });
});

describe("piCliPath fallback order", () => {
  const argv1 = process.argv[1];
  afterEach(() => {
    process.argv[1] = argv1!;
    delete process.env.PI_SUBAGENTS_PI_CLI;
  });

  /** A fake pi install (symlinked bin like npm creates) whose cli.js differs from the repo's. */
  function fakeInstall() {
    const root = tempDir("pi-install-");
    const dist = join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "cli.js"), "");
    mkdirSync(join(root, "bin"));
    symlinkSync(join(dist, "cli.js"), join(root, "bin", "pi"));
    return { bin: join(root, "bin", "pi"), cli: join(dist, "cli.js") };
  }

  it("should_prefer_PI_SUBAGENTS_PI_CLI_over_the_running_pi", () => {
    const { bin } = fakeInstall();
    process.argv[1] = bin;
    process.env.PI_SUBAGENTS_PI_CLI = "/custom/cli.js";
    expect(piCliPath()).toBe("/custom/cli.js");
  });

  it("should_use_the_running_pi_through_its_symlink_before_the_package_lookup", () => {
    const { bin, cli } = fakeInstall();
    process.argv[1] = bin;
    expect(piCliPath()).toBe(cli);
    expect(piCliPath()).not.toBe(REPO_CLI);
  });

  it("should_fall_back_to_the_installed_package_when_argv1_is_not_pi", () => {
    process.argv[1] = fileURLToPath(import.meta.url);
    expect(piCliPath()).toBe(REPO_CLI);
  });

  it("should_fall_back_when_argv1_does_not_exist", () => {
    process.argv[1] = "/no/such/dir/pi-coding-agent/dist/cli.js";
    expect(piCliPath()).toBe(REPO_CLI);
  });
});

describe("RpcRunner against a configurable fake child", () => {
  const sessions: ChildSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.dispose().catch(() => {})));
  });
  function runner(config: Record<string, unknown>, opts: Partial<RpcRunnerOptions> = {}) {
    const tag = procTag();
    const r = new RpcRunner({
      resolveModel: () => ({ provider: "p", id: "m" }),
      cliPath: GAP_SERVER,
      env: { GAP_CONFIG: JSON.stringify(config) },
      extraArgs: tag.args,
      ...opts,
    });
    return { runner: r, live: tag.live };
  }
  const open = async (r: RpcRunner, spec: Partial<ChildSpec> = {}) => {
    const s = await r.open({ ...base, cwd: process.cwd(), sessionDir: tempDir("gap-"), ...spec });
    sessions.push(s);
    return s;
  };

  it("should_reject_open_with_exit_code_and_stderr_and_leave_no_process_when_the_child_fails_to_start", async () => {
    const { runner: r, live } = runner({ startExit: { code: 7, stderr: "unknown option --frobnicate" } });
    await expect(open(r)).rejects.toThrow(/child process exited \(code 7\): unknown option --frobnicate/);
    expect(live()).toEqual([]);
  });

  it("should_reject_open_when_the_cli_path_does_not_exist", async () => {
    const { runner: r } = runner({}, { cliPath: join(tempDir("nocli-"), "missing-cli.js") });
    await expect(open(r)).rejects.toThrow(/child process exited \(code 1\).*Cannot find module/s);
  });

  it("should_reject_open_and_stop_the_child_when_the_session_is_not_persisted", async () => {
    const { runner: r, live } = runner({ state: {} });
    await expect(open(r)).rejects.toThrow(/not persisted/);
    expect(live()).toEqual([]);
  });

  it("should_forward_model_cwd_env_agent_dir_and_extra_args_and_omit_trust_when_projectTrusted_is_undefined", async () => {
    const dir = tempDir("rec-");
    const recordFile = join(dir, "argv.json");
    const { runner: r } = runner({ recordFile }, { agentDir: join(dir, "agent"), projectTrusted: () => undefined, env: { GAP_CONFIG: JSON.stringify({ recordFile }), GAP_EXTRA: "1" } });
    await open(r, { cwd: dir });
    const rec = JSON.parse(readFileSync(recordFile, "utf8")) as { argv: string[]; cwd: string; env: Record<string, string> };
    expect(rec.argv).toEqual(expect.arrayContaining(["--model", "p/m"]));
    expect(rec.argv).not.toContain("-a");
    expect(rec.argv).not.toContain("-na");
    expect(rec.argv.at(-2)).toBe("--gap-tag");
    expect(rec.cwd).toBe(dir);
    expect(rec.env).toEqual({ PI_CODING_AGENT_DIR: join(dir, "agent"), GAP_EXTRA: "1" });
  });

  it("should_pass_-na_when_the_project_is_not_trusted", async () => {
    const recordFile = join(tempDir("rec-"), "argv.json");
    const { runner: r } = runner({ recordFile }, { projectTrusted: () => false });
    await open(r);
    expect((JSON.parse(readFileSync(recordFile, "utf8")) as { argv: string[] }).argv).toContain("-na");
  });

  it("should_report_each_turn_usage_as_the_difference_of_cumulative_session_stats", async () => {
    const stats = [
      { input: 100, output: 40, cacheRead: 7, cacheWrite: 3, cost: 0.5 },
      { input: 130, output: 52, cacheRead: 9, cacheWrite: 3, cost: 0.75 },
      { input: 130, output: 52, cacheRead: 9, cacheWrite: 3, cost: 0.75 },
      { input: 200, output: 60, cacheRead: 20, cacheWrite: 10, cost: 1.25 },
    ];
    const { runner: r } = runner({ stats, turns: [{ messages: [assistant("a")] }, { messages: [assistant("b")] }] });
    const s = await open(r);
    expect((await s.prompt("one")).usage).toEqual({ input: 30, output: 12, cacheRead: 2, cacheWrite: 0, cost: 0.25 });
    expect((await s.prompt("two")).usage).toEqual({ input: 70, output: 8, cacheRead: 11, cacheWrite: 7, cost: 0.5 });
  });

  it("should_take_the_answer_from_this_turn_only_and_ignore_messages_outside_the_turn", async () => {
    const { runner: r } = runner({
      // Stats call 2 is the "before" of turn 2: a stray assistant message arrives between the turns.
      strayOnStats: [2],
      turns: [
        { messages: [{ role: "user", content: "one" }, assistant("", { stopReason: "toolUse" }), assistant("final one")] },
        { messages: [{ role: "user", content: "two" }] },
      ],
    });
    const s = await open(r);
    expect(await s.prompt("one")).toMatchObject({ text: "final one", stopReason: "stop" });
    const second = await s.prompt("two");
    expect(second.text).toBe("");
    expect(second.text).not.toContain("stray");
    expect(second.text).not.toContain("final one");
  });

  it("should_report_the_last_assistant_error_of_the_turn", async () => {
    const { runner: r } = runner({
      turns: [{ messages: [assistant("partial", { stopReason: "toolUse" }), assistant("", { stopReason: "error", errorMessage: "rate limited" })] }],
    });
    const s = await open(r);
    expect(await s.prompt("x")).toMatchObject({ stopReason: "error", errorMessage: "rate limited" });
  });

  it("should_report_aborted_when_the_settle_event_says_so", async () => {
    const { runner: r } = runner({ turns: [{ messages: [assistant("half")], aborted: true }] });
    const s = await open(r);
    expect((await s.prompt("x")).stopReason).toBe("aborted");
  });

  it("should_stop_the_child_process_on_dispose_and_tolerate_a_second_dispose", async () => {
    const { runner: r, live } = runner({});
    const s = await open(r);
    expect(live()).toHaveLength(1);
    await s.dispose();
    await vi.waitFor(() => expect(live()).toEqual([]));
    await expect(s.dispose()).resolves.toBeUndefined();
  });
});
