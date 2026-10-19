// Edge-case stand-in for `pi --mode rpc` (stdout noise, CRLF, huge lines, stderr tails). Mode comes from FAKE_RPC_MODE.
const mode = process.env.FAKE_RPC_MODE ?? "noisy";
const respond = (cmd, data, eol = "\n") =>
  process.stdout.write(`${JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data })}${eol}`);

if (mode === "stderr-flood") {
  // 5008 characters with no trailing whitespace, so the kept tail is exactly the last 2048 characters.
  process.stderr.write(`HEAD${"x".repeat(5000)}TAIL`, () => process.exit(4));
}
if (mode === "stderr-split") {
  // "é" (c3 a9) cut across two writes: the tail must not contain U+FFFD.
  const bytes = Buffer.from("boom é!");
  const cut = bytes.indexOf(0xc3) + 1;
  process.stderr.write(bytes.subarray(0, cut), () =>
    setTimeout(() => process.stderr.write(bytes.subarray(cut), () => process.exit(6)), 20),
  );
}

import { spawn } from "node:child_process";

/**
 * Detached descendant inheriting the requested stdio fds; exits on its own after a short sleep.
 * The trailing "fake-rpc-holder" argv tag makes it visible to `ps | grep fake-rpc`; the pid is returned
 * so the test can kill it instead of leaving it running after the case.
 */
function spawnHolder(stdio) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 8000)", "fake-rpc-holder"], {
    detached: true,
    stdio,
  });
  child.unref();
  return child.pid;
}

const held = [];
function handle(cmd) {
  if (mode === "reverse") {
    // Hold the first command, then answer the second before the first.
    held.push(cmd);
    if (held.length < 2) return;
    return held.splice(0).reverse().forEach((c) => respond(c, { echoed: c.type, value: c.value }));
  }
  if (mode === "noisy") {
    // Non-JSON garbage, blank lines (LF and CRLF), a truncated record, then a CRLF event and a CRLF response.
    process.stdout.write("not json at all\n\n\r\n{broken\n");
    process.stdout.write(`${JSON.stringify({ type: "crlf_event", n: 1 })}\r\n`);
    return respond(cmd, { ok: true }, "\r\n");
  }
  if (mode === "hold-stderr-exit-on-stdin" || mode === "hold-stderr-exit-now") {
    if (cmd.type === "spawn-holder" || cmd.type === "spawn-holder-and-exit") {
      // Inherit stderr (fd 2) so the parent's "close" waits on the descendant's write end.
      const holderPid = spawnHolder(["ignore", "ignore", 2]);
      respond(cmd, { ok: true, holderPid });
      if (cmd.type === "spawn-holder-and-exit") process.exit(0);
      return;
    }
    if (cmd.type === "hang") return;
  }
  if (mode === "late-stderr-exit-now" && cmd.type === "spawn-late-writer-and-exit") {
    // A descendant shares stderr, writes its tail 50ms after this child exits, then exits itself, so "close"
    // arrives well inside the post-exit drain grace and the late tail must still reach exitReason.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.stderr.write('late tail', () => process.exit(0)), 50)", "fake-rpc-holder"],
      { detached: true, stdio: ["ignore", "ignore", 2] },
    );
    child.unref();
    respond(cmd, { ok: true, holderPid: child.pid });
    process.exit(0);
  }
  if (mode === "non-objects") {
    process.stdout.write("null\n1\n\"x\"\n[]\n");
    process.stdout.write(`${JSON.stringify({ type: "kept_event", n: 1 })}\n`);
    return respond(cmd, { ok: true });
  }
  if (mode === "big") {
    // About 1 MB in one line; "→" is 3 bytes, so pipe chunk boundaries fall inside characters.
    process.stdout.write(`${JSON.stringify({ type: "big_event", text: "→".repeat(350_000) })}\n`);
    return respond(cmd, { ok: true });
  }
  return respond(cmd, { echoed: cmd.type });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
