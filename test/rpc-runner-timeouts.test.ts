import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ChildSession, ChildSpec } from "../src/runner/types.ts";
import { echoAgent } from "./harness.ts";
import { procTag } from "./proc.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

// The ready and abort timeouts are module constants (30 s / 60 s, see the plan's global constraints);
// shorten them for this file only. RpcProcess itself is the real implementation.
vi.mock("../src/runner/rpc-process.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runner/rpc-process.ts")>()),
  READY_TIMEOUT_MS: 400,
  ABORT_TIMEOUT_MS: 400,
}));

const { RpcRunner } = await import("../src/runner/rpc.ts");

afterAll(cleanupTempDirs);

const GAP_SERVER = fileURLToPath(new URL("./fixtures/fake-rpc-gap-server.mjs", import.meta.url));
const base = (): ChildSpec => ({ agent: echoAgent, cwd: process.cwd(), sessionDir: tempDir("to-"), appendSystemPrompt: [] });

describe("RpcRunner timeouts", () => {
  const sessions: ChildSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.dispose().catch(() => {})));
  });
  function runner(config: Record<string, unknown>, commandTimeoutMs?: number) {
    const tag = procTag();
    const r = new RpcRunner({
      resolveModel: () => ({ provider: "p", id: "m" }),
      cliPath: GAP_SERVER,
      env: { GAP_CONFIG: JSON.stringify(config) },
      extraArgs: tag.args,
      ...(commandTimeoutMs ? { commandTimeoutMs } : {}),
    });
    return { runner: r, live: tag.live };
  }
  const open = async (r: InstanceType<typeof RpcRunner>) => {
    const s = await r.open(base());
    sessions.push(s);
    return s;
  };

  it("should_reject_open_and_kill_the_child_when_the_readiness_probe_times_out", async () => {
    // commandTimeoutMs is long on purpose: the probe must use the ready timeout, not the command timeout.
    const { runner: r, live } = runner({ hang: ["get_state"] }, 60_000);
    const started = Date.now();
    await expect(open(r)).rejects.toThrow(/get_state timed out after 400ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
    await vi.waitFor(() => expect(live()).toEqual([]), { timeout: 5_000 });
  });

  it("should_fail_the_turn_and_kill_the_child_when_a_control_command_times_out", async () => {
    const { runner: r, live } = runner({ hang: ["get_session_stats"] }, 300);
    const s = await open(r);
    const exits: string[] = [];
    s.onExit((reason) => exits.push(reason));
    await expect(s.prompt("x")).rejects.toThrow(/get_session_stats timed out after 300ms/);
    await vi.waitFor(() => expect(s.alive).toBe(false), { timeout: 5_000 });
    await vi.waitFor(() => expect(exits).toEqual([expect.stringMatching(/signal SIGKILL/)]), { timeout: 5_000 });
    expect(live()).toEqual([]);
  });

  it("should_time_out_a_prompt_that_is_never_acknowledged", async () => {
    const { runner: r } = runner({ hang: ["prompt"] }, 300);
    const s = await open(r);
    await expect(s.prompt("x")).rejects.toThrow(/prompt timed out after 300ms/);
    await vi.waitFor(() => expect(s.alive).toBe(false), { timeout: 5_000 });
  });

  it("should_time_out_steer_with_the_command_timeout", async () => {
    const { runner: r } = runner({ hang: ["steer", "follow_up"] }, 300);
    const s = await open(r);
    await expect(s.steer("x", "steer")).rejects.toThrow(/steer timed out after 300ms/);
  });

  it("should_time_out_abort_with_its_own_timeout_not_the_command_timeout", async () => {
    const { runner: r } = runner({ hang: ["abort"] }, 60_000);
    const s = await open(r);
    const started = Date.now();
    await expect(s.abort()).rejects.toThrow(/abort timed out after 400ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
    await vi.waitFor(() => expect(s.alive).toBe(false), { timeout: 5_000 });
  });
});
