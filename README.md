# pi-subagents

pi extension: delegate work to named subagents that keep their own session, can be steered
while running, and can be resumed by handle after they finish.

Status: milestone 3 (M3). Children run in-process through the pi SDK or as resident
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

## Tool `subagents`

| `action` | Parameters | Effect |
| --- | --- | --- |
| `run` | `agent`, `task`, optional `background` | Starts a new subagent and returns its handle. Foreground waits for the result; background returns at once and delivers the result later (background results always use auto). |
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
- Not yet available: chains, nested subagents. These are planned for later milestones.
- An RPC child starts in about a second; resuming a resident child has no start-up cost.
- Two pi processes resuming the same subagent at the same time write to the same child session file without a lock.
- RPC children load no extensions until nesting (M6).
