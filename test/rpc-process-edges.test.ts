import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RpcProcess, type RpcProcessOptions } from "../src/runner/rpc-process.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

// Boundary cases for RpcProcess beyond the plan's task-3 cases (test/rpc-process.test.ts).
const SERVER = fileURLToPath(new URL("./fixtures/fake-rpc-server.mjs", import.meta.url));
const EDGE_SERVER = fileURLToPath(new URL("./fixtures/fake-rpc-edge-server.mjs", import.meta.url));
const open: RpcProcess[] = [];
/** Detached descendants spawned by the edge fixture; killed after each case so none outlive the test. */
const holders: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killHolders(): Promise<void> {
  const pids = holders.splice(0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  // Holders are reparented to init, which reaps them; wait until they are gone so ps checks are deterministic.
  const deadline = Date.now() + 2_000;
  while (pids.some(isAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

function start(script: string, mode: string, extra: Partial<RpcProcessOptions> = {}): RpcProcess {
  const p = new RpcProcess({ cliPath: script, args: [], cwd: tempDir("rpc-edges-"), env: { FAKE_RPC_MODE: mode }, ...extra });
  open.push(p);
  return p;
}

/** Settles within `ms` or reports "pending", so "rejects at once" does not depend on a command timeout. */
function within<T>(promise: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: Error } | "pending"> {
  return Promise.race([
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: Error) => ({ ok: false as const, error }),
    ),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close()));
  await killHolders();
});
afterAll(cleanupTempDirs);

describe("RpcProcess start failures", () => {
  it("should_report_failed_to_start_when_cwd_does_not_exist", async () => {
    // Arrange
    const p = start(SERVER, "echo", { cwd: "/nonexistent-rpc-process-cwd" });
    const exits: string[] = [];
    p.onExit((r) => exits.push(r));

    // Act
    const result = p.request({ type: "get_state" }, 10_000);

    // Assert: spawn emits "error" without a pid, which is the start-failure branch.
    await expect(result).rejects.toThrow(/^child process failed to start: spawn .+ ENOENT$/);
    await p.exited;
    expect(p.alive).toBe(false);
    expect(p.exitReason).toMatch(/^child process failed to start: /);
    expect(exits).toEqual([p.exitReason]);
    expect(await p.close()).toBe("exited");
  });

  it("should_report_node_exit_code_and_stderr_when_script_does_not_exist", async () => {
    // Arrange: node itself starts, so this is an exit, not a spawn failure.
    const p = start("/nonexistent/cli.js", "echo");

    // Act
    const result = p.request({ type: "get_state" }, 10_000);

    // Assert
    await expect(result).rejects.toThrow(/^child process exited \(code 1\): [\s\S]*Cannot find module/);
    expect(p.alive).toBe(false);
  });
});

describe("RpcProcess timeouts and exits", () => {
  it("should_kill_child_and_reject_other_pending_when_a_command_times_out", async () => {
    // Arrange
    const p = start(SERVER, "echo", { commandTimeoutMs: 200 });
    const exits: string[] = [];
    p.onExit((r) => exits.push(r));

    // Act
    const timedOut = p.request({ type: "hang" });
    const other = p.request({ type: "hang" }, 10_000);

    // Assert
    await expect(timedOut).rejects.toThrow(/^hang timed out after 200ms$/);
    await expect(other).rejects.toThrow(/^child process exited \(signal SIGKILL\)$/);
    expect(p.alive).toBe(false);
    expect(exits).toEqual(["child process exited (signal SIGKILL)"]);
  });

  it("should_reject_immediately_when_requesting_after_the_child_exited", async () => {
    // Arrange
    const p = start(SERVER, "exit-soon");
    await p.exited;

    // Act
    const outcome = await within(p.request({ type: "ping" }, 10_000), 100);

    // Assert
    expect(outcome).not.toBe("pending");
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: Error }).error.message).toBe("child process exited (code 5)");
  });

  it("should_reject_pending_without_calling_onExit_when_closed_mid_request", async () => {
    // Arrange
    const p = start(SERVER, "echo", { closeTimeoutsMs: { stdin: 2_000, term: 2_000 } });
    const exits: string[] = [];
    p.onExit((r) => exits.push(r));
    await p.request({ type: "ping" });
    const pending = p.request({ type: "hang" }, 10_000);

    // Act
    const stage = await p.close();

    // Assert
    expect(stage).toBe("stdin");
    await expect(pending).rejects.toThrow(/^child process exited \(code 0\)$/);
    expect(exits).toEqual([]);
  });
});

describe("RpcProcess stderr tail", () => {
  it("should_keep_only_the_last_2048_stderr_characters", async () => {
    // Arrange
    const p = start(EDGE_SERVER, "stderr-flood");

    // Act
    await p.exited;

    // Assert
    const prefix = "child process exited (code 4): ";
    expect(p.exitReason?.startsWith(prefix)).toBe(true);
    const tail = p.exitReason!.slice(prefix.length);
    expect(tail).toHaveLength(2048);
    expect(tail).toBe(`${"x".repeat(2044)}TAIL`);
  });

  it("should_decode_a_multibyte_stderr_character_split_across_chunks", async () => {
    // Arrange
    const p = start(EDGE_SERVER, "stderr-split");

    // Act
    await p.exited;

    // Assert
    expect(p.exitReason).toBe("child process exited (code 6): boom é!");
  });
});

describe("RpcProcess subscriptions", () => {
  it("should_stop_delivering_events_after_onEvent_unsubscribe", async () => {
    // Arrange
    const p = start(SERVER, "echo");
    const removed: unknown[] = [];
    const kept: unknown[] = [];
    const off = p.onEvent((e) => removed.push(e));
    p.onEvent((e) => kept.push(e));

    // Act
    off();
    await p.request({ type: "emit" });

    // Assert
    expect(removed).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it("should_not_call_onExit_listener_after_unsubscribe", async () => {
    // Arrange
    const p = start(SERVER, "exit-soon");
    const removed: string[] = [];
    const kept: string[] = [];
    const off = p.onExit((r) => removed.push(r));
    p.onExit((r) => kept.push(r));

    // Act
    off();
    await p.exited;

    // Assert
    expect(removed).toEqual([]);
    expect(kept).toEqual(["child process exited (code 5)"]);
  });
});

describe("RpcProcess correlation", () => {
  it("should_match_responses_by_id_when_they_arrive_out_of_order", async () => {
    // Arrange: the server answers the second command before the first.
    const p = start(EDGE_SERVER, "reverse");
    const order: string[] = [];

    // Act
    const first = p.request({ type: "first", value: 1 }).then((d) => (order.push("first"), d));
    const second = p.request({ type: "second", value: 2 }).then((d) => (order.push("second"), d));
    const [a, b] = await Promise.all([first, second]);

    // Assert
    expect(order).toEqual(["second", "first"]);
    expect(a).toEqual({ echoed: "first", value: 1 });
    expect(b).toEqual({ echoed: "second", value: 2 });
  });
});

describe("RpcProcess descendant pipes (REVIEW-305)", () => {
  it("should_return_close_within_timeout_when_descendant_holds_stderr", async () => {
    // Arrange: a detached descendant inherits fd 2 and stays alive after the child exits on stdin end.
    const p = start(EDGE_SERVER, "hold-stderr-exit-on-stdin", { closeTimeoutsMs: { stdin: 300, term: 300 } });
    const { holderPid } = await p.request<{ holderPid: number }>({ type: "spawn-holder" });
    holders.push(holderPid);

    // Act
    const stage = await within(p.close(), 2_000);

    // Precondition: the descendant still held stderr when close() returned, so the bound was really exercised.
    expect(isAlive(holderPid)).toBe(true);

    // Assert
    expect(stage).not.toBe("pending");
    expect(["stdin", "exited"]).toContain((stage as { value: string }).value);
  });

  it("should_notify_onExit_and_reject_pending_when_child_exits_while_descendant_holds_pipe", async () => {
    // Arrange
    const p = start(EDGE_SERVER, "hold-stderr-exit-now");
    const exits: string[] = [];
    p.onExit((r) => exits.push(r));
    const pending = p.request({ type: "hang" }, 10_000);

    // Act
    const { holderPid } = await p.request<{ holderPid: number }>({ type: "spawn-holder-and-exit" });
    holders.push(holderPid);
    const outcome = await within(pending, 1_500);

    // Precondition: the descendant still holds the pipe, so "close" cannot have fired yet.
    expect(isAlive(holderPid)).toBe(true);

    // Assert
    expect(outcome).not.toBe("pending");
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: Error }).error.message).toMatch(/^child process exited \(code 0\)$/);
    expect(exits).toEqual(["child process exited (code 0)"]);
    expect(p.alive).toBe(false);
  });

  it("should_include_stderr_written_by_a_descendant_when_close_arrives_within_drain_grace", async () => {
    // Arrange: the descendant writes to the shared stderr ~50ms after the child exits, then closes it.
    const p = start(EDGE_SERVER, "late-stderr-exit-now");
    const exits: string[] = [];
    p.onExit((r) => exits.push(r));

    // Act
    const { holderPid } = await p.request<{ holderPid: number }>({ type: "spawn-late-writer-and-exit" });
    holders.push(holderPid);
    await p.exited;

    // Assert: "exit" alone must not finalize the reason; the drain grace lets "close" deliver the late tail.
    expect(p.exitReason).toBe("child process exited (code 0): late tail");
    expect(exits).toEqual(["child process exited (code 0): late tail"]);
  });
});

describe("RpcProcess malformed records (REVIEW-305)", () => {
  it("should_ignore_null_number_string_and_array_lines_without_an_uncaught_error", async () => {
    // Arrange
    const p = start(EDGE_SERVER, "non-objects");
    const events: unknown[] = [];
    p.onEvent((e) => events.push(e));
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);

    try {
      // Act
      const data = await p.request({ type: "ping" });
      await new Promise((r) => setTimeout(r, 50));

      // Assert
      expect(data).toEqual({ ok: true });
      expect(events).toEqual([{ type: "kept_event", n: 1 }]);
      expect(uncaught).toEqual([]);
      expect(p.alive).toBe(true);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

describe("RpcProcess stdout framing", () => {
  it("should_ignore_non_json_lines_and_accept_crlf_records", async () => {
    // Arrange
    const p = start(EDGE_SERVER, "noisy");
    const events: unknown[] = [];
    p.onEvent((e) => events.push(e));

    // Act
    const data = await p.request({ type: "ping" });

    // Assert
    expect(data).toEqual({ ok: true });
    expect(events).toEqual([{ type: "crlf_event", n: 1 }]);
    expect(p.alive).toBe(true);
  });

  it("should_parse_a_single_one_megabyte_json_line", async () => {
    // Arrange
    const p = start(EDGE_SERVER, "big");
    const events: { type: string; text?: string }[] = [];
    p.onEvent((e) => events.push(e as { type: string; text?: string }));

    // Act
    const data = await p.request({ type: "ping" });

    // Assert
    expect(data).toEqual({ ok: true });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("big_event");
    expect(events[0]!.text).toHaveLength(350_000);
    expect(events[0]!.text).toBe("→".repeat(350_000));
  });
});
