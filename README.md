# pi-subagents

pi extension: delegate work to named subagents that keep their own session, can be steered
while running, and can be resumed by handle after they finish.

Status: milestone 5 (M5). Children run in-process through the pi SDK or as resident
`pi --mode rpc` child processes. See `/sandbox/temp/plans/pi-subagent-extension-plan.md` for the full plan.

## Loading

```sh
pi -e /sandbox/temp/extensions/subagents/src/index.ts
```

Agents are Markdown files with frontmatter in `~/.pi/agent/agents/*.md`
(`name` and `description` are required; optional `model`, `thinking`, `tools`, `handle`, `runner`).

## Settings

Optional file `~/.pi/agent/subagents.json`. Missing file means defaults; invalid values log a warning and fall back to the default.

| Field | Default | Meaning |
| --- | --- | --- |
| `maxConcurrent` | `4` | Children running at the same time. Positive = limit, `0` = none allowed, `-1` = unlimited. Extra runs wait for a slot. |
| `maxChildrenPerParent` | `4` | Same value rules. Read and validated, enforced from M6 (nesting). |
| `maxDepth` | `2` | Same value rules. Read and validated, enforced from M6 (nesting). |
| `maxResident` | `8` | Child sessions kept open between turns, running ones included. Positive = limit, `0` = close after every turn, `-1` = unlimited. The least recently used idle child is closed first; resuming it later reopens its session file. |
| `maxParallelTasks` | `8` | Most tasks in one `parallel` call. Positive = limit, `0` = parallel disabled, `-1` = unlimited. |
| `maxChainSteps` | `8` | Same value rules; `0` disables chains. |
| `defaultDelivery` | `"auto"` | `private`, `share` or `auto`. Used for `@handle` messages without a symbol (M2). Background runs started by the main agent always use `auto`. |
| `defaultRunner` | `"sdk"` | `sdk` (in-process) or `rpc` (a resident `pi --mode rpc` child process per subagent). An agent's `runner:` frontmatter overrides it. Existing records keep the runner they were created with. |
| `contextRatio` | `0.3` | In `(0, 1]`. A foreground result larger than this share of the main model's context window is written to a file; the tool returns the summary and the file path. |
| `pendingResultTimeoutMinutes` | `30` | `> 0`. Read and validated, used from M6. |
| `mentionQuoteMaxChars` | `2000` | Positive integer. Longest user message quoted with an `@` result; longer messages are cut with a note. |

## Runners

Both runners read the user's settings (`~/.pi/agent/settings.json`), so `defaultTools`, retry and the rest apply to a
child exactly as to a normal pi run. Either way the child session stays resident between turns and is reused by the
next `resume`.

`rpc` starts one `pi --mode rpc` child process per subagent, with `-ne` so it loads no extensions; the model, thinking
level, tool list and appended system prompt come from the agent definition. The child exits when the subagent is
stopped, when the main session ends (exit, `/new`, `/resume`, fork or `/reload`), or when `maxResident` evicts it.

If an idle RPC child dies, the next resume starts a new one from its session file, so the crash is invisible. If it
dies while a turn is running, that turn fails with the exit code and the tail of the child's stderr.

When pi's `cli.js` cannot be located, set `PI_SUBAGENTS_PI_CLI` to its path.

## Working directories

`run`, every item of `parallel` and every step of `chain` can carry a `cwd`; a relative path is resolved against the
main session's cwd. The record stores the resolved cwd, so later `resume`/`continue` turns run in the same directory;
if it no longer exists they fail with a clear error instead of falling back to the main cwd.

When `cwd` differs from the main session's cwd, project trust is decided for that directory on its own (a saved
decision, or the user's `defaultProjectTrust`); the main session's trust is never applied to another directory.

## Tool `subagents`

| `action` | Parameters | Effect |
| --- | --- | --- |
| `run` | exactly one of `agent` \| `skill` \| `command`, optional `task`, `cwd`, `background` | Starts a new subagent and returns its handle. The entry is `agent` (with a required `task`), `skill` (run as `/skill:<name>` in the child) or `command` (a prompt template, run as `/<name>`); for skill and command entries `task` is the arguments appended to the slash command. Foreground waits for the result; background returns at once and delivers the result later (background results always use auto). |
| `parallel` | `tasks` (`[{ agent\|skill\|command, task?, cwd? }]`), optional `background` | Runs tasks at the same time (the global `maxConcurrent` still caps concurrency). Every task gets its own handle. `task` is required for an agent item and is the appended arguments for a skill or command item. The result is one summary: `Parallel: X/N succeeded` plus a section per task. A failure does not stop the others. |
| `chain` | `chain` (`[{ agent\|skill\|command, task?, cwd? }]`), optional `background` | Runs steps in order; `{previous}` in a task is replaced with the previous step's output. `task` is required for an agent step and is the appended arguments for a skill or command step. Each step gets its own handle. A failing step stops the chain; its status and the chain progress are kept. |
| `continue` | `handle` (the step that stopped the chain), optional `message` | Resumes that step (its own session) and then runs the remaining steps. Works for `failed` and `paused` chains; a `stopped` chain cannot be continued. |
| `resume` | `handle`, `message`, optional `background` | Continues a finished or paused subagent in its own session (background results always use auto). Unknown, stopped, still-running or session-file-missing handles are rejected. |
| `steer` | `handle`, `message`, optional `mode` (`steer` or `followUp`) | Sends guidance to a running subagent. |
| `interrupt` | `handle` | Pauses a running subagent; it can be resumed. |
| `stop` | `handle` | Ends a subagent permanently; it can no longer be resumed. |
| `list` | none | Shows the subagents on the current branch as a tree. |

Statuses: `queued` (waiting for a slot or for its child session to open), `running`, `paused`, `completed`, `failed`, `stopped`.
An interrupt or stop on a queued run cancels it: the record becomes `stopped` with `cancelled before it started`.

Children are asked to end with a `<summary>` tag; without one (or with an empty one) the first 1200 characters are used as the summary.

## Delivery modes (background results)

- `private`: stored as a custom session entry and shown only in the TUI. It never enters the model context, including compaction and branch summaries.
- `share`: written into the main session without starting a turn. The full output goes to a file; the message contains the summary, the output file path and the child session path.
- `auto` (default for @ messages; always used for background runs started by the main agent): same content as `share`, then triggers a follow-up turn.

## Mentions (TUI only)

Start a message with `@<handle>` to talk to an existing subagent without going through the main model:
it is steered when running and resumed when paused, completed or failed. `@sub:<handle>` does the same and
always means a subagent; use it when a file or directory in the cwd has the same name (files win for the bare form).

A symbol right after the handle picks the delivery for this message only:
`@reviewer? ...` private, `@reviewer! ...` auto, `@reviewer~ ...` share. Without a symbol `defaultDelivery` is used.
A symbol on a mention that reaches a running subagent applies to that instruction only; the run keeps its delivery. With ? the instruction is never quoted to the main session, but the subagent's answer may still reflect it.
The question is quoted with the result. `@main <message>` sends the message to the main session.
Mentions are only recognised at the start of a message, typed in the TUI (not RPC, print mode or other extensions).

## Command

- `/subagents list` (default): the subagents on the current branch as a tree under `main`, with handle, agent, run,
  cost (parents also show their subtree total), the first line of an error, and the status at the end of the line.
- `/subagents cost`: the same tree with input, output, cache read and cache write tokens and cost, plus a total line.

Both are shown in the TUI only; they are custom entries and never enter the model context.

## Starting a subagent from the prompt

`/sub` starts a subagent without going through the main model, and the symbol in the command name picks the delivery:

| Command | Delivery |
| --- | --- |
| `/sub …` | the `defaultDelivery` setting (default `auto`) |
| `/sub! …` | `auto` — write the result and start a turn |
| `/sub~ …` | `share` — write the result, do not start a turn |
| `/sub? …` | `private` — show it in the TUI only |

The target is an agent, a skill or a prompt template:

```sh
/sub code-agent review src/manager.ts
/sub /skill:sil-iterate watch MRSet 91425
/sub /my-template some arguments
/sub --cwd /path/to/repo code-agent look at this checkout
```

Agent entries need a task; skill and template entries may omit the arguments. Names are validated before anything
starts: an unknown agent, skill or template is reported with the available names and nothing is created.
Every created subagent gets a handle, so `@handle` continues it and `/subagents` lists it.

## Chain progress

Chain definitions and progress are stored as `pi-subagents/chain` custom entries on the session branch (rebuilt
after `/reload`, `/tree` and fork like the record registry). `/subagents` shows a chain as
`chain 1  2 steps  step 2/2  $0.0180  [failed]` with its steps indented below; `/subagents cost` shows the chain's
summed tokens and cost and a total line. A chain that is paused or stopped does not create records for the steps it
never reached.

## Background batches

`background: true` on a `parallel` group or a `chain` delivers exactly one summary when the whole group or chain
finishes (always auto), never one message per task. Background batches that end paused or stopped deliver nothing.
Each item and step still has its own handle, so a single one can be inspected, `steer`ed, `interrupt`ed or `stop`ped
while the rest continue.

## Files

With a session directory: child sessions in `<sessionDir>/subagents/`, large outputs in `<sessionDir>/subagents/outputs/`,
and a read-only snapshot `<sessionDir>/<sessionId>.subagents.json` (never used for recovery; session entries are authoritative).

## Known limits

- Esc pauses subagents only while the `subagents` tool call is executing. Background children keep running after Esc; use `interrupt` or `stop`.
- After `/fork` or `/tree`, each branch resumes a subagent from the point its own record last ended, so branches do not see each other's later turns. Their turns are written to the same child session file as separate branches; two pi processes resuming the same handle at the same time write to that file without a lock.
- Without a session directory (in-memory session), child sessions and outputs go to `<tmpdir>/pi-subagents/<sessionId>/` and no snapshot is written.
- `private` results are visible only in the TUI; in print, JSON or RPC mode they are not displayed.
- After `/reload` or a restart, records that were running are marked `paused` and can be resumed.
- After `/tree`, a still-running record carried over to the new branch may share its handle with a record already on that branch. `@handle` resolution is then ambiguous; use the record id, or wait for the run to finish.
- Messages typed while the main session is compacting are queued by pi; an `@` message then runs after compaction.
- Mentions in print or RPC mode are passed to the main session unchanged.
- `@` completion uses pi's autocomplete hook; how it behaves after `/reload` or `/new` has not been verified.
- An instruction sent with @ just as the subagent finishes may be quoted with the result even though the subagent did not act on it.
- Records created before M2 have no pinned child leaf; the first resume on each branch after /fork or /tree can still see the other branch once.
- Not yet available: nested subagents. It is planned for a later milestone.
- `pi` rewrites its process title to `pi`; to see the resident RPC children, list the main pi's children whose comm is `pi` (`ps --ppid <main pi> -o pid,comm`), instead of `grep`ping the command line.
- Chain steps run one after another; a parallel group inside a chain is not supported yet.
- A step's prompt is the substituted task text (with `{previous}` already replaced), and `continue` replays that same text when no message is given.
- An RPC child starts in about a second; resuming a resident child has no start-up cost.
- RPC children load no extensions until nesting (M6).
- A project-local skill or template is only expanded when the child's project is trusted; otherwise pi passes `/skill:x …` through as plain text. The name was validated against the discoverable directories, so this can only be noticed from the result.
- Records store the prompt that was sent to the child (for skill and command entries that is the slash form, e.g. `/skill:sil-iterate …`); `continue` replays that text when no message is given.
- `/sub` always creates a new subagent (a name clash becomes `name-2`); use `@handle` to continue an existing one.
- `/sub` completion only applies to a bare target token: after `--cwd <dir>`, or once arguments have been entered, it does not complete (first-version limit).
- Validation covers `<agentDir>/skills`, `<cwd>/.pi/skills`, `<home>/.agents/skills` and the prompt-template directories. Explicit `skillPaths` / `promptPaths` in the settings are not read in the first version (future work), and project-ancestor `.agents/skills` is not covered.

## Manual checks (M5)

1. `/sub /skill:sil-iterate 阻塞监听 MRSet 91425 这一轮` —— 确认 notify 里有 handle 与入口标识（`skill:sil-iterate`），结果按 auto 投递回来，`@sil-iterate …` 能续聊。
2. `/sub? /skill:<某个 skill> 参数` —— 结果只在界面（`[subagent private]` 条目），条目里能看到你让它做什么。
3. 把 `subagents.json` 的 `defaultDelivery` 改成 `share`，重启后 `/sub reviewer 任务` 应写入但不触发；`/sub!` 仍然触发新一轮。
4. `/sub --cwd /tmp/m4-cwd code-agent 看一眼这个目录` —— 用 `ps --ppid <主 pi> -o pid,comm` 找到子进程，核对 `/proc/<pid>/cwd` 为目标目录。
5. `/sub /skill:nope` —— 报错并列出可用 skill 名，`/subagents` 里不出现新记录。
6. `/sub /<某个模板> 参数` —— 子会话里模板已展开（结果里能看到模板内容生效）。
7. 让主 agent 用工具跑 `parallel`，其中一项是 skill、一项是 agent；再跑一条链，链里某一步用 `{previous}` 作为 skill 参数。
8. `@<skill 入口的 handle>` 续聊（那个 skill 文件即使被删掉也应能续），`/subagents` 里 agent 列显示 `skill:x` / `command:y`。
9. 在一个**未受信任**的项目目录里准备 `/.pi/skills/<name>/SKILL.md`，然后 `/sub --cwd <该目录> /skill:<name> …` —— 观察已知限制的表现（结果里出现字面量 `/skill:…`），确认 README 的说明与实际一致。
