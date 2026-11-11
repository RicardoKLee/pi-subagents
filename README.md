# pi-subagents

pi extension: delegate work to named subagents that keep their own session, can be steered
while running, and can be resumed by handle after they finish.

Status: milestone 7 (M7). Children run in-process through the pi SDK or as resident
`pi --mode rpc` child processes, can nest, and are bounded by stall budgets you can also drive by hand. See `/sandbox/temp/plans/pi-subagent-extension-plan.md` for the full plan.

## Loading

```sh
pi -e /sandbox/temp/extensions/subagents/src/index.ts
```

Agents are Markdown files with frontmatter in `~/.pi/agent/agents/*.md`
(`name` and `description` are required; optional `model`, `thinking`, `tools`, `handle`, `runner`).

## Settings

Optional file `~/.pi/agent/subagents.json` (user) and `<cwd>/.pi/subagents.json` (project, trusted projects only).
Missing file means defaults; invalid values log a warning and fall back to the default. The project file is layered on top
of the user file key by key, and is ignored entirely for an untrusted project.

| Field | Default | Meaning |
| --- | --- | --- |
| `maxConcurrent` | `4` | Children running at the same time. Positive = limit, `0` = none allowed, `-1` = unlimited. Extra runs wait for a slot. |
| `maxChildrenPerParent` | `4` | Most direct children (running or queued) one subagent may have at once. Positive = limit, `0` = cannot spawn any, `-1` = unlimited. A spawn beyond the limit is refused, not queued. The main session is not a parent record, so its own spawns are bounded by `maxConcurrent` / `maxParallelTasks` instead. |
| `maxDepth` | `2` | Deepest nesting level. Positive = limit, `0` = nothing may spawn (not even the main session), `-1` = unlimited. The main session is depth 0, so `maxDepth: 1` allows root subagents only and `maxDepth: 2` (default) allows one nesting level. |
| `maxResident` | `8` | Child sessions kept open between turns, running ones included. Positive = limit, `0` = close after every turn, `-1` = unlimited. The least recently used idle child is closed first; resuming it later reopens its session file. |
| `maxParallelTasks` | `8` | Most tasks in one `parallel` call. Positive = limit, `0` = parallel disabled, `-1` = unlimited. |
| `maxChainSteps` | `8` | Same value rules; `0` disables chains. |
| `defaultDelivery` | `"auto"` | `private`, `share` or `auto`. Used for `@handle` messages without a symbol (M2). Background runs started by the main agent always use `auto`. |
| `defaultRunner` | `"sdk"` | `sdk` (in-process) or `rpc` (a resident `pi --mode rpc` child process per subagent). An agent's `runner:` frontmatter overrides it. Existing records keep the runner they were created with. |
| `contextRatio` | `0.3` | In `(0, 1]`. A foreground result larger than this share of the main model's context window is written to a file; the tool returns the summary and the file path. |
| `pendingResultTimeoutMinutes` | `30` | `> 0`. Minutes a queued child result may wait before the user is reminded once, with the resume / `action=drain` / `action=drop` options. |
| `toolIdleTimeoutMinutes` | `45` | Non-negative integer, `0` = off. Minutes one tool call may show **no progress** before that subagent is paused (never stopped). Progress is counted per `toolCallId`, so parallel calls never refresh each other; only a non-empty tool update counts (bash sends an empty one when it starts). |
| `turnHardTimeoutMinutes` | `0` (off) | Non-negative integer, `0` = off. Absolute minutes one turn may run before it is paused. It is **never refreshed** by activity, so a loop that keeps producing output is still bounded. |
| `interruptGraceSeconds` | `20` | Positive integer. How long a run may take to settle after an interrupt/abort before it is abandoned: the record becomes `paused` with `did not settle after abort…` and the waiting tool call returns. |
| `mentionQuoteMaxChars` | `2000` | Positive integer. Longest user message quoted with an `@` result; longer messages are cut with a note. |
| `defaultModel` | unset | Model for every subagent whose agent file names none: `provider/id` (e.g. `deeproute/deepseek-v4.1-flash`) or a bare id resolved against the main session's provider. Unset = the child inherits the main session's model. An id pi cannot resolve is reported once at startup and ignored, so children inherit instead of failing. |
| `defaultThinking` | `"off"` | Thinking level for every subagent whose agent file names none: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. `off` is the default on purpose — a child only thinks when the agent file, the call or this setting says so. |

### Which model a child runs with

Each layer only fills what the layer above left empty, for `model` and `thinking` independently:

1. the call itself: `model` / `thinking` on the `subagents` tool (`run`, a `parallel` item, a `chain` step) or the
   `/sub --model <provider/id> --thinking <level>` flags;
2. the agent file's `model:` / `thinking:` frontmatter;
3. the project's `.pi/subagents.json` → `defaultModel` / `defaultThinking` (trusted projects only);
4. `~/.pi/agent/subagents.json` → the same two keys;
5. nothing: the child inherits the main session's model, and thinking is `off`.

A skill or command entry (`/sub /skill:x`, `/sub /<template>`) has no agent file, so it starts from layer 3.

The resolved model and thinking level are stored on the subagent's record, like its runner and working directory: a
resumed subagent keeps the model it was created with even after the agent file or a default changes.

## Runners

Both runners read the user's settings (`~/.pi/agent/settings.json`), so `defaultTools`, retry and the rest apply to a
child exactly as to a normal pi run. Either way the child session stays resident between turns and is reused by the
next `resume`.

`rpc` starts one `pi --mode rpc` child process per subagent, with `-ne` so it loads no extensions; a nested child
also gets an explicit `-e` for this extension, which is how it can delegate. The model and thinking level are the
ones resolved for the run (`--model`, `--thinking`), the tool list and appended system prompt come from the agent
definition. The child exits when the subagent is
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
| `run` | exactly one of `agent` \| `skill` \| `command`, optional `task`, `cwd`, `model`, `thinking`, `background` | Starts a new subagent and returns its handle. The entry is `agent` (with a required `task`), `skill` (run as `/skill:<name>` in the child) or `command` (a prompt template, run as `/<name>`); for skill and command entries `task` is the arguments appended to the slash command. Foreground waits for the result; background returns at once and delivers the result later (background results always use auto). |
| `parallel` | `tasks` (`[{ agent\|skill\|command, task?, cwd?, model?, thinking? }]`), optional `background` | Runs tasks at the same time (the global `maxConcurrent` still caps concurrency). Every task gets its own handle. `task` is required for an agent item and is the appended arguments for a skill or command item. The result is one summary: `Parallel: X/N succeeded` plus a section per task. A failure does not stop the others. |
| `chain` | `chain` (`[{ agent\|skill\|command, task?, cwd?, model?, thinking? }]`), optional `background` | Runs steps in order; `{previous}` in a task is replaced with the previous step's output. `task` is required for an agent step and is the appended arguments for a skill or command step. Each step gets its own handle. A failing step stops the chain; its status and the chain progress are kept. |
| `continue` | `handle` (the step that stopped the chain), optional `message` | Resumes that step (its own session) and then runs the remaining steps. Works for `failed` and `paused` chains; a `stopped` chain cannot be continued. |
| `resume` | `handle`, `message`, optional `background` | Continues a finished or paused subagent in its own session (background results always use auto). Unknown, stopped, still-running or session-file-missing handles are rejected; a stopped record points at `restart`. |
| `steer` | `handle`, `message`, optional `mode` (`steer` or `followUp`) | Sends guidance to a running subagent. |
| `interrupt` | `handle` | Pauses a running subagent. It can be resumed, or `restart`ed for a clean context. |
| `stop` | `handle` | Ends a subagent and every descendant permanently. It can no longer be resumed, but `restart` still reruns its task in a fresh session. |
| `stop-all` | none | Ends every **active** record (`queued`/`running`, nested descendants included). `paused` records are left resumable. Idempotent: a second call stops nothing. Reports how many were stopped and how many were still queued. |
| `interrupt-all` | none | Pauses every live subagent (what Esc does) and returns how many. A run that is already stopping keeps its stop intent. |
| `restart` | `handle`, optional `message`, optional `background` | Runs the record's task again in a **brand-new** child session while keeping the handle: `runId + 1`, `sessionFile` cleared, the old session file kept for review, pending child results left queued. A live run is halted first (bounded by `interruptGraceSeconds`), so two runs of a record never overlap. Works for `paused`, `completed`, `failed` and `stopped`; `queued` records and chain steps are refused. |
| `drain` | `handle` | Hands the child results waiting for a paused subagent to the caller and clears them. |
| `drop` | `handle` | Discards the child results waiting for a paused subagent. |
| `list` | none | Shows the subagents on the current branch as a tree. |

Statuses: `queued` (waiting for a slot or for its child session to open), `running`, `paused`, `completed`, `failed`, `stopped`.
An interrupt or stop on a queued run cancels it: the record becomes `stopped` with `cancelled before it started`.
`paused` can be resumed (same context) or restarted (fresh context); `stopped` can only be restarted.

`waitMinutes` (foreground `run`, `parallel`, `chain`, `resume` and `continue`) bounds how long the call itself waits: at
the deadline those runs are paused exactly like a stall, and the call returns normally with `paused` records. Background
calls ignore it.

`stop`, `interrupt` and `restart` need a `handle`; `stop-all` and `interrupt-all` refuse one, so a typo can never
silently narrow or widen their scope. A subagent may not call `stop-all`/`interrupt-all` at all (`only the main agent can
stop all subagents`).

Children are asked to end with a `<summary>` tag; without one (or with an empty one) the first 1200 characters are used as the summary.

## Delivery modes (background results)

- `private`: stored as a custom session entry and shown only in the TUI. It never enters the model context, including compaction and branch summaries. The entry shows the conclusion open and keeps the full result (process, quoted question, paths) collapsed; expand it to read everything. Entries written before the conclusion was stored separately keep their full text visible.
- `share`: written into the main session without starting a turn. The full output goes to a file; the message contains the summary, the output file path and the child session path.
- `auto` (default for @ messages; always used for background runs started by the main agent): same content as `share`, then triggers a follow-up turn.

## Completion notifications

A `share` or `private` result starts no turn, so nothing else would tell the user it finished. For those two modes the
extension shows a notification (`ctx.ui.notify`; RPC forwards it as an `extension_ui_request`, print/JSON fall back to
stderr) and emits `pi-subagents:settled` on `pi.events` with
`{ handle, agent, status, delivery, summary, sessionFile, filePath? }` for other extensions:

```ts
pi.events.on("pi-subagents:settled", (info) => {
  // info.status is completed or failed; info.delivery is share or private
});
```

`auto` stays silent here because its follow-up turn already ends in `agent_settled`. Foreground results and nested
child results (which go to their parent) do not notify either.

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

`/subagents <verb> [@handle] [message]` — the verb comes first.

| Command | What it does |
| --- | --- |
| `/subagents list` (default) | The subagents on the current branch as a tree under `main`, with handle, agent, run, cost (parents also show their subtree total), the first line of an error, the status at the end of the line, and `(N results waiting · 12m)` when child results wait for it. A live run also shows its phase: `[running] · bash 45m`. |
| `/subagents cost` | The same tree with input, output, cache read and cache write tokens and cost, plus a total line; a parent row also shows its `subtree $X` total and the waiting hint. |
| `/subagents stop @x` | Ends that subagent (and its descendants); it cannot be resumed. |
| `/subagents interrupt @x` | Pauses that subagent; the main agent can resume it, or `/subagents restart @x` reruns the task in a fresh session. |
| `/subagents restart @x [message]` | Starts `run 2` of the same handle in a brand-new session (background, so the command returns at once). The rest of the line is appended to the original task. |
| `/subagents stop-all` | Ends every active subagent; `paused` ones stay resumable. |
| `/subagents interrupt-all` | Pauses every running subagent. |
| `/subagents help` | This table, one line per verb. |

`list` and `cost` are shown in the TUI only; they are custom entries and never enter the model context.

The handle can be written `@x`, `x` or `@sub:x`; a nested one as `@父/子`. `stop`/`interrupt`/`restart` **require** a
handle — a missing one is an error, never "all of them". The shortcut `ctrl+shift+x` is `/subagents stop-all`.

Why not `@x stop`: `@handle …` means "send this message to that subagent" (steer when running, resume when paused), so
`@x stop` would just be a (dangerous) message. Control words are therefore only read as the **first** word after
`/subagents`.

A command handler runs even while the main agent is streaming (pi calls registered extension commands before it queues
the input), so these verbs work when the main turn is busy. The handler deliberately does **not** call
`ctx.abort()` after an action that released the blocking run (that cascade would pause every other healthy subagent);
it only aborts when the turn is still busy and the action settled nothing.

## Stall control

A subagent that sits inside one tool call has no natural end, and a foreground call blocks the main agent until it
returns. Three budgets bound that, all in the settings file:

| Budget | Counts from | At the deadline |
| --- | --- | --- |
| `toolIdleTimeoutMinutes` (45) | the last **real** output of one `toolCallId` (a start, or an empty update such as bash's, is not output) | pause that subagent |
| `turnHardTimeoutMinutes` (0) | the start of the turn; never refreshed | pause that subagent |
| `interruptGraceSeconds` (20) | the moment the pause was requested | abandon: record `paused` with `did not settle after abort…` and return the call |

Only a pause is ever automatic — never a stop, never an automatic resume, never a delivery. The tool call that was
waiting then returns with the record `paused`, and the reason is kept in the record's `error`
(`stalled: bash produced no progress for 45m (tool call call_8699…)`), so `/subagents list` and the notification say
what happened. A child that never settles after the abort makes the call return `paused: did not settle after abort;
use restart`. From there the choice is yours: `resume` continues the same context, `restart` clears it and reruns the
task, `stop` ends the record. Parallel tool calls are judged per call, so one chatty call never keeps a silent one alive.

When the main agent may stop things: while it has a turn. A foreground `run`/`parallel`/`chain`/`resume` holds the turn,
so the model cannot issue a second tool call — only the budgets above or the user (`/subagents stop-all`,
`ctrl+shift+x`) can intervene then.

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
/sub --model deeproute/deepseek-v4-pro --thinking high code-agent dig into this failure
```

The optional flags come before the target, in any order: `--cwd <dir>`, `--model <provider/id>` (or a bare model id)
and `--thinking <level>`. Model and thinking outrank the agent file and the settings defaults (see
“Which model a child runs with”).

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

## Nested subagents

A subagent can start subagents of its own: the tool keeps the same name (`subagents`) and only reaches its own
subtree, so a handle resolves relative to the caller. Nesting is on by default to `maxDepth: 2` (one level below a
root subagent); `maxDepth: 1` allows no grandchild, `0` disables subagents entirely and `-1` leaves depth unlimited.

An agent file may carry `allowed_subagents`: omitted means no restriction, a list means only those names, `[]` means
none. A level can only narrow what its ancestors allowed: the effective set is the intersection down the chain.

`maxChildrenPerParent` caps the direct children (running or queued) of one subagent; a spawn beyond the cap is refused
instead of queued. The main session is not a parent record, so its own spawns are not counted against a parent cap —
`maxConcurrent` and `maxParallelTasks` bound them.

A foreground delegation (`run`, `resume`, `continue`, `parallel`, `chain`) yields the parent's global scheduler slot
while it waits for the child, so with `maxConcurrent: 1` the child can still start. Background delegations and
`list` / `steer` / `interrupt` / `stop` / `drain` / `drop` do not yield.

The `/subagents` tree indents children under their parent. A nested handle is addressed as `@父/子`, where every later
segment must be a direct child of the previous one.

## Waiting child results

When a parent is interrupted (or its session is closed) while a child runs, the child's result is not lost: it is
queued on the parent as a pending child result. Only a `completed` child result is queued; a failed or stopped child is
visible through its own record status. A parent whose session was closed is never silently reopened — the pending
result waits for an explicit resume, `action=drain` or `action=drop`.

`/subagents` appends `(N results waiting · 12m)` to a row with pending results, using the oldest one's wait (`12m` or
`1h05m`). After `pendingResultTimeoutMinutes`, the session is reminded once, with three ways to handle them: resume the
parent (`@handle …`), hand the results over with `subagents action=drain handle=…`, or discard them with
`action=drop handle=…`. Delivering into a live or resumed parent follows the same 30% context rule as any child result
(larger output goes to a file). Stopping a parent discards its pending results.

## Files

With a session directory: child sessions in `<sessionDir>/subagents/`, large outputs in `<sessionDir>/subagents/outputs/`,
and a read-only snapshot `<sessionDir>/<sessionId>.subagents.json` (never used for recovery; session entries are authoritative).

## Known limits

- Esc pauses subagents only while a single foreground `subagents` call is executing: Esc (and any caller abort) cascades into `interruptAll()`. The items of a foreground `parallel`, `chain` or `continue` do not receive the caller's signal — only `waitMinutes` reaches a batch — so while such a call blocks the turn, only the stall budgets, `/subagents …` or `ctrl+shift+x` can release it. Background children keep running after Esc; use `interrupt` or `stop`.
- An interrupt/stop sent by the main agent needs a turn of its own. While it is blocked in a foreground `run`, `parallel`, `chain`, `resume` or `continue`, only the stall budgets, `/subagents …` and `ctrl+shift+x` can release it.
- A long **silent** tool (a remote build, `git fetch`, a watcher) is paused once `toolIdleTimeoutMinutes` passes with no output. That is the deliberate trade-off: the cost is one pause and a `resume`, the gain is that an endless wait is bounded. Raise the value or set it to `0` to disable that budget.
- A subagent stuck inside a tool call is better `restart`ed than `resume`d: resuming hands the same wedged state back.
- An abandoned run of an in-process (SDK) child cannot be killed; its record stays `paused` and its pending work lives in the parent process until it exits. An RPC child is killed. Abandoning hands the scheduler slot back at once, so that still-running in-process child no longer counts against `maxConcurrent` (the limit can be oversold for a while), and `stop-all` does not reclaim it because its record is already `paused`.
- `interrupt`, `interrupt-all` and `stop` only ask the child to abort; they do not arm the abandonment grace window. A child that ignores the abort keeps its run: after an `interrupt` only the `toolIdleTimeoutMinutes` budget can still abandon it, while `stop` has no automatic fallback, so `whenIdle()` and session shutdown then wait until that child returns on its own.
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
- Wildcard addressing (`@*/scout`) and cross-parent fuzzy matching are not supported yet (TODO in the resolver).
- An RPC child can only delegate if it can load this extension file; without the `-e` argument an RPC subagent has no `subagents` tool.
- Only a `completed` child result is queued for its parent; a failed or stopped child result is not delivered and is visible only through its record status.
- After `continue` finishes a chain, the remaining steps all inherit the parent of the step that stopped it; per-step parents are not preserved.
- `pi` rewrites its process title to `pi`; to see the resident RPC children, list the main pi's children whose comm is `pi` (`ps --ppid <main pi> -o pid,comm`), instead of `grep`ping the command line.
- Chain steps run one after another; a parallel group inside a chain is not supported yet.
- A step's prompt is the substituted task text (with `{previous}` already replaced), and `continue` replays that same text when no message is given. A step whose task is only `{previous}` and whose previous step produced no output is rejected as an empty agent task (the chain is not created).
- An RPC child starts in about a second; resuming a resident child has no start-up cost.
- Project skills and prompt templates are loaded regardless of project trust (pi only gates `SYSTEM.md` / `APPEND_SYSTEM.md` by trust), so `/sub /skill:x` works in an untrusted project too. pi expands the slash command inside the child and passes an unknown name through unchanged, so if a skill cannot be loaded there (a malformed or unreadable file, or a discovery difference) the model receives the literal `/skill:x …` text instead of an error.
- Records store the prompt that was sent to the child (for skill and command entries that is the slash form, e.g. `/skill:sil-iterate …`); `continue` replays that text when no message is given.
- `/sub` always creates a new subagent (a name clash becomes `name-2`); use `@handle` to continue an existing one.
- Wildcard addressing (`@*/scout`) and cross-parent fuzzy matching are not supported yet; the resolver carries a `TODO(addressing)` marker for them.
- `/sub` completion only applies to a bare target token: after `--cwd <dir>`, or once arguments have been entered, it does not complete (first-version limit).
- Validation covers `<agentDir>/skills`, `<cwd>/.pi/skills`, `<home>/.agents/skills` and the prompt-template directories. Explicit `skillPaths` / `promptPaths` in the settings are not read in the first version (future work), and project-ancestor `.agents/skills` is not covered.
