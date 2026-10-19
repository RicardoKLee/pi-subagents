// Minimal stand-in for `pi --mode rpc` used to test the client mechanics. Mode comes from FAKE_RPC_MODE.
const mode = process.env.FAKE_RPC_MODE ?? "echo";
const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const respond = (cmd, data, success = true, error) =>
  write({ id: cmd.id, type: "response", command: cmd.type, success, ...(success ? { data } : { error }) });

if (mode === "exit-at-start") {
  process.stderr.write("bad flag --nope\n");
  process.exit(2);
}
if (mode === "term-only" || mode === "stubborn" || mode === "exit-soon") setInterval(() => {}, 1000);
if (mode === "stubborn") process.on("SIGTERM", () => {});
if (mode === "exit-soon") setTimeout(() => process.exit(5), 200);

let leaf = "leaf-0";
let n = 0;
function handle(cmd) {
  switch (cmd.type) {
    case "get_state":
      return respond(cmd, { sessionFile: process.env.FAKE_RPC_SESSION_FILE ?? "/tmp/fake-session.jsonl" });
    case "get_session_stats":
      n++;
      return respond(cmd, { tokens: { input: 10 * n, output: 5 * n, cacheRead: 0, cacheWrite: 0, total: 15 * n }, cost: 0.01 * n });
    case "get_entries":
      return respond(cmd, { entries: [], leafId: leaf });
    case "fail":
      return respond(cmd, undefined, false, "nope");
    case "hang":
      return;
    case "emit": {
      // A line separator inside a JSON string, and a multi-byte character split across two writes.
      const line = Buffer.from(`${JSON.stringify({ type: "custom_event", text: "a\u2028b\u2029c → d" })}\n`);
      const cut = line.indexOf(Buffer.from("→")) + 1;
      process.stdout.write(line.subarray(0, cut));
      return setTimeout(() => {
        process.stdout.write(line.subarray(cut));
        respond(cmd, { ok: true });
      }, 20);
    }
    case "prompt":
      if (mode === "crash-on-prompt") {
        process.stderr.write("fatal: provider exploded\n");
        return process.exit(3);
      }
      if (mode === "handled") return respond(cmd, { disposition: "handled" });
      respond(cmd, { disposition: "started" });
      leaf = `leaf-${n + 1}`;
      write({ type: "message_end", message: { role: "user", content: cmd.message } });
      write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `echo: ${cmd.message}` }], stopReason: "stop" } });
      return write({ type: "agent_settled", aborted: false });
    default:
      return respond(cmd, { echoed: cmd.type, value: cmd.value });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (mode === "echo" || mode === "handled" || mode === "crash-on-prompt") process.exit(0);
});
