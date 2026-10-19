// Configurable stand-in for `pi --mode rpc` used by the RpcRunner gap tests. Behaviour comes from GAP_CONFIG (JSON):
//   startExit:   { code, stderr }        exit right away (start-up failure)
//   hang:        ["get_state", ...]      command types that are never answered
//   state:       {...}                   get_state data (default: a session file)
//   stats:       [{ input, output, cacheRead, cacheWrite, cost }, ...]  cumulative stats, one per get_session_stats call
//   turns:       [{ messages: [...], aborted?: boolean }, ...]          message_end payloads emitted per prompt
//   strayOnStats: [n, ...]               before answering the n-th (0-based) get_session_stats, emit a stray assistant message
//   recordFile:  path                    write { argv, cwd, env } here at start
// Extra argv (e.g. a "--gap-tag <id>" pair) is ignored; it only makes the process findable in /proc.
import { writeFileSync } from "node:fs";

const config = JSON.parse(process.env.GAP_CONFIG ?? "{}");
const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const respond = (cmd, data) => write({ id: cmd.id, type: "response", command: cmd.type, success: true, data });

if (config.recordFile) {
  writeFileSync(
    config.recordFile,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null, GAP_EXTRA: process.env.GAP_EXTRA ?? null },
    }),
  );
}
if (config.startExit) {
  process.stderr.write(`${config.startExit.stderr}\n`, () => process.exit(config.startExit.code));
} else {
  let statsCalls = 0;
  let turn = 0;
  const handle = (cmd) => {
    if ((config.hang ?? []).includes(cmd.type)) return;
    switch (cmd.type) {
      case "get_state":
        return respond(cmd, config.state ?? { sessionFile: "/tmp/fake-gap-session.jsonl" });
      case "get_session_stats": {
        const n = statsCalls++;
        if ((config.strayOnStats ?? []).includes(n)) {
          write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stray" }], stopReason: "stop" } });
        }
        const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        const s = config.stats?.[n] ?? config.stats?.at(-1) ?? zero;
        return respond(cmd, { tokens: { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, total: 0 }, cost: s.cost });
      }
      case "get_entries":
        return respond(cmd, { entries: [], leafId: `leaf-${turn}` });
      case "prompt": {
        const t = config.turns?.[turn] ?? { messages: [] };
        turn++;
        respond(cmd, { disposition: "started" });
        for (const message of t.messages) write({ type: "message_end", message });
        return write({ type: "agent_settled", aborted: t.aborted === true });
      }
      default:
        return respond(cmd, {});
    }
  };
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
}
