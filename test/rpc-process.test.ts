import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RpcProcess } from "../src/runner/rpc-process.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

const SERVER = fileURLToPath(new URL("./fixtures/fake-rpc-server.mjs", import.meta.url));
const open: RpcProcess[] = [];

function start(mode: string, extra: Partial<ConstructorParameters<typeof RpcProcess>[0]> = {}): RpcProcess {
  const p = new RpcProcess({ cliPath: SERVER, args: [], cwd: tempDir("rpc-process-"), env: { FAKE_RPC_MODE: mode }, ...extra });
  open.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close()));
});
afterAll(cleanupTempDirs);

describe("RpcProcess", () => {
  it("correlates concurrent requests by id", async () => {
    const p = start("echo");
    const [a, b] = await Promise.all([p.request({ type: "ping", value: 1 }), p.request({ type: "pong", value: 2 })]);
    expect(a).toEqual({ echoed: "ping", value: 1 });
    expect(b).toEqual({ echoed: "pong", value: 2 });
  });

  it("rejects a failed command with its error", async () => {
    await expect(start("echo").request({ type: "fail" })).rejects.toThrow("fail: nope");
  });

  it("splits records only on LF", async () => {
    const p = start("echo");
    const events: unknown[] = [];
    p.onEvent((e) => events.push(e));
    await p.request({ type: "emit" });
    expect(events).toEqual([{ type: "custom_event", text: "a\u2028b\u2029c → d" }]);
  });

  it("rejects pending requests when the child exits, with the exit code and stderr", async () => {
    const p = start("crash-on-prompt");
    const exits: string[] = [];
    p.onExit((r) => exits.push(r));
    await expect(p.request({ type: "prompt", message: "x" })).rejects.toThrow(/child process exited \(code 3\): fatal: provider exploded/);
    expect(p.alive).toBe(false);
    expect(exits).toHaveLength(1);
    await expect(p.request({ type: "ping" })).rejects.toThrow(/code 3/);
  });

  it("reports a child that exits while idle", async () => {
    const p = start("exit-soon");
    const reason = await new Promise<string>((resolve) => p.onExit(resolve));
    expect(reason).toMatch(/code 5/);
  });

  it("a request that is never answered times out and kills the child", async () => {
    const p = start("echo", { commandTimeoutMs: 200 });
    await expect(p.request({ type: "hang" })).rejects.toThrow(/timed out after 200ms/);
    await p.exited;
    expect(p.alive).toBe(false);
  });

  it.each([
    ["echo", "stdin"],
    ["term-only", "sigterm"],
    ["stubborn", "sigkill"],
  ] as const)("close escalates for a %s child (%s)", async (mode, stage) => {
    const p = start(mode, { closeTimeoutsMs: { stdin: 200, term: 200 } });
    await p.request({ type: "ping" });
    const exits: string[] = [];
    p.onExit((r) => exits.push(r));
    expect(await p.close()).toBe(stage);
    expect(p.alive).toBe(false);
    expect(exits).toEqual([]);
  });

  it("close can be repeated and returns at once after the child has exited", async () => {
    const crashed = start("crash-on-prompt");
    await expect(crashed.request({ type: "prompt", message: "x" })).rejects.toThrow(/code 3/);
    const t0 = Date.now();
    expect(await crashed.close()).toBe("exited");
    expect(await crashed.close()).toBe("exited");
    expect(Date.now() - t0).toBeLessThan(100);

    const closed = start("echo");
    await closed.request({ type: "ping" });
    expect(await Promise.all([closed.close(), closed.close()])).toEqual(["stdin", "stdin"]);
    expect(await closed.close()).toBe("exited");
  });

  it("a child that fails at startup rejects with its stderr", async () => {
    await expect(start("exit-at-start").request({ type: "get_state" })).rejects.toThrow(/code 2\): bad flag --nope/);
  });

  it("a missing executable rejects with a start error", async () => {
    const p = start("echo", { cliPath: "/nonexistent/cli.js" });
    await expect(p.request({ type: "get_state" })).rejects.toThrow(/exited|failed to start/);
  });
});
