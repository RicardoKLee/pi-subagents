import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildRpcArgs, buildRpcEnv, LEAF_PIN_ENTRY_TYPE, piCliPath, pinLeaf, RpcRunner } from "../src/runner/rpc.ts";
import type { ChildSession, ChildSpec } from "../src/runner/types.ts";
import { echoAgent } from "./harness.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

afterAll(cleanupTempDirs);

const SERVER = fileURLToPath(new URL("./fixtures/fake-rpc-server.mjs", import.meta.url));
const GAP_SERVER = fileURLToPath(new URL("./fixtures/fake-rpc-gap-server.mjs", import.meta.url));
const base: ChildSpec = { agent: echoAgent, cwd: "/w", sessionDir: "/s", appendSystemPrompt: ["Be brief.", "End with <summary>."] };

describe("buildRpcArgs", () => {
  it("maps a new session", () => {
    expect(buildRpcArgs({ ...base, agent: { ...echoAgent, tools: undefined } }, "p/m", {})).toEqual([
      "--mode", "rpc", "--session-dir", "/s", "-ne", "--model", "p/m",
      "--append-system-prompt", "Be brief.", "--append-system-prompt", "End with <summary>.",
    ]);
  });

  it("maps resume, thinking, tools, trust and extra args", () => {
    const spec = { ...base, resumeFile: "/s/a.jsonl", agent: { ...echoAgent, thinking: "high", tools: ["read", "grep"] } };
    expect(buildRpcArgs(spec, "p/m", { trusted: true, extraArgs: ["--offline"] })).toEqual([
      "--mode", "rpc", "--session", "/s/a.jsonl", "-ne", "--model", "p/m", "--thinking", "high", "--tools", "read,grep",
      "--append-system-prompt", "Be brief.", "--append-system-prompt", "End with <summary>.", "-a", "--offline",
    ]);
  });

  it("an empty tool list disables all tools and untrusted projects pass -na", () => {
    const args = buildRpcArgs({ ...base, agent: { ...echoAgent, tools: [] } }, "p/m", { trusted: false });
    expect(args).toContain("--no-tools");
    expect(args).not.toContain("--tools");
    expect(args.at(-1)).toBe("-na");
  });
});

describe("pinLeaf", () => {
  function session() {
    const dir = tempDir("pin-");
    const sm = SessionManager.create(dir, join(dir, "sessions"));
    sm.appendMessage({ role: "user", content: "one", timestamp: Date.now() } as never);
    sm.appendMessage(fauxAssistantMessage("a1") as never);
    const firstLeaf = sm.getLeafId()!;
    sm.appendMessage({ role: "user", content: "two", timestamp: Date.now() } as never);
    sm.appendMessage(fauxAssistantMessage("a2") as never);
    return { file: sm.getSessionFile()!, firstLeaf, lastLeaf: sm.getLeafId()! };
  }

  it("does nothing when the leaf is already the last entry", () => {
    const { file, lastLeaf } = session();
    const before = readFileSync(file, "utf8");
    expect(pinLeaf(file, lastLeaf)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("appends a marker under the pinned leaf so reopening continues there", () => {
    const { file, firstLeaf } = session();
    expect(pinLeaf(file, firstLeaf)).toBe(true);
    const reopened = SessionManager.open(file);
    const leaf = reopened.getLeafEntry() as { type: string; customType?: string; parentId?: string };
    expect(leaf).toMatchObject({ type: "custom", customType: LEAF_PIN_ENTRY_TYPE, parentId: firstLeaf });
  });

  it("throws for an unknown leaf", () => {
    const { file } = session();
    expect(() => pinLeaf(file, "no-such-entry")).toThrow(/not found/);
  });
});

describe("piCliPath", () => {
  it("finds pi's cli.js and honours PI_SUBAGENTS_PI_CLI", () => {
    expect(existsSync(piCliPath())).toBe(true);
    expect(piCliPath()).toMatch(/pi-coding-agent\/dist\/cli\.js$/);
    const custom = join(tempDir("cli-"), "cli.js");
    writeFileSync(custom, "");
    process.env.PI_SUBAGENTS_PI_CLI = custom;
    try {
      expect(piCliPath()).toBe(custom);
    } finally {
      delete process.env.PI_SUBAGENTS_PI_CLI;
    }
  });
});

describe("RpcRunner with a fake child", () => {
  const sessions: ChildSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.dispose().catch(() => {})));
  });
  const runner = (mode: string) =>
    new RpcRunner({ resolveModel: () => ({ provider: "p", id: "m" }), cliPath: SERVER, env: { FAKE_RPC_MODE: mode } });
  const open = async (mode: string) => {
    const s = await runner(mode).open({ ...base, cwd: process.cwd(), sessionDir: tempDir("fake-") });
    sessions.push(s);
    return s;
  };

  it("collects the turn's answer, usage delta and new leaf", async () => {
    const s = await open("echo");
    const result = await s.prompt("hi");
    expect(result).toMatchObject({ text: "echo: hi", stopReason: "stop" });
    expect(result.usage).toMatchObject({ input: 10, output: 5 });
    expect(s.leafId).toBe("leaf-2");
  });

  it("a crash during a prompt rejects with the exit code and stderr, and the session is dead", async () => {
    const s = await open("crash-on-prompt");
    await expect(s.prompt("x")).rejects.toThrow(/code 3\): fatal: provider exploded/);
    expect(s.alive).toBe(false);
  });

  it("a prompt handled without a run is an error", async () => {
    const s = await open("handled");
    expect(await s.prompt("x")).toMatchObject({ stopReason: "error", errorMessage: "prompt was handled without a run" });
  });

  it("open fails with the child's stderr when it cannot start", async () => {
    await expect(open("exit-at-start")).rejects.toThrow(/bad flag --nope/);
  });

  it("reports a child that exits while idle", async () => {
    const s = await open("exit-soon");
    const reason = await new Promise<string>((resolve) => s.onExit(resolve));
    expect(reason).toMatch(/code 5/);
    expect(s.alive).toBe(false);
  });

  it("keeps the last known leaf when get_entries keeps failing", async () => {
    const s = await open("entries-fail-after-first");
    await s.prompt("one");
    const first = s.leafId;
    expect(first).toBeTruthy();
    await s.prompt("two");
    expect(s.leafId).toBe(first);
  });

  it("cannot resolve a model", async () => {
    const r = new RpcRunner({ resolveModel: () => undefined, cliPath: SERVER });
    await expect(r.open(base)).rejects.toThrow(/cannot resolve model/);
  });
});

describe("delegation plumbing", () => {
  it("adds -e and the child env when the spec carries delegation", () => {
    const spec: ChildSpec = { ...base, delegation: { recordId: "rec-1", depth: 1, canDelegate: true, mailboxDir: "/tmp/m" } };
    const args = buildRpcArgs(spec, "p/m", {});
    expect(args).toContain("-e");
    expect(args[args.indexOf("-e") + 1]).toMatch(/src[\\/]index\.ts$/);
    expect(buildRpcEnv(spec)).toMatchObject({
      PI_SUBAGENTS_CHILD: "rec-1",
      PI_SUBAGENTS_DEPTH: "1",
      PI_SUBAGENTS_DELEGATE: "1",
      PI_SUBAGENTS_MAILBOX: "/tmp/m",
    });
    expect(buildRpcEnv({ ...base })).toEqual({});
  });

  it("places -e right after -ne and omits it without delegation", () => {
    const spec: ChildSpec = { ...base, delegation: { recordId: "rec-1", depth: 2, canDelegate: false, mailboxDir: "/tmp/m" } };
    const args = buildRpcArgs(spec, "p/m", {});
    expect(args[args.indexOf("-ne") + 1]).toBe("-e");
    expect(args[args.indexOf("-e") + 1]).toMatch(/src[\\/]index\.ts$/);
    expect(buildRpcArgs(base, "p/m", {})).not.toContain("-e");
  });

  it("reports canDelegate=false and no mailbox when the child may not spawn", () => {
    const spec: ChildSpec = { ...base, delegation: { recordId: "rec-2", depth: 2, canDelegate: false } };
    expect(buildRpcEnv(spec)).toEqual({ PI_SUBAGENTS_CHILD: "rec-2", PI_SUBAGENTS_DEPTH: "2", PI_SUBAGENTS_DELEGATE: "0" });
  });

  it("delivers with prompt when idle and follow_up when busy", async () => {
    const dir = tempDir("deliver-");
    const log = join(dir, "commands.jsonl");
    const runner = new RpcRunner({
      resolveModel: () => ({ provider: "p", id: "m" }),
      cliPath: GAP_SERVER,
      env: { GAP_CONFIG: JSON.stringify({ logFile: log, state: { sessionFile: join(dir, "child.jsonl") } }) },
    });
    const session = await runner.open({
      ...base,
      cwd: process.cwd(),
      sessionDir: dir,
      delegation: { recordId: "rec-1", depth: 1, canDelegate: true, mailboxDir: join(dir, "mbox") },
    });
    try {
      await session.deliver("first", "start");
      await session.deliver("second", "queue");
    } finally {
      await session.dispose();
    }
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(commands.map((c) => c.type)).toEqual(["get_state", "prompt", "follow_up"]);
    expect(commands[1]!.message).toBe("first");
    expect(commands[2]!.message).toBe("second");
  });
});
