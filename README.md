# pi-subagents

pi extension: delegate work to named subagents that keep their own session, can be steered
while running, and can be resumed by handle after they finish.

Status: milestone 1 (M1). Children run in-process through the pi SDK. See
`/sandbox/temp/plans/pi-subagent-extension-plan.md` for the full plan.

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
| `defaultDelivery` | `"auto"` | `private`, `share` or `auto`. Used for `@handle` messages without a symbol (M2). Background runs started by the main agent always use `auto`. |
| `defaultRunner` | `"sdk"` | `sdk` or `rpc`. Only `sdk` exists in M1; `rpc` makes runs fail with "not available". |
| `contextRatio` | `0.3` | In `(0, 1]`. A foreground result larger than this share of the main model's context window is written to a file; the tool returns the summary and the file path. |
| `pendingResultTimeoutMinutes` | `30` | `> 0`. Read and validated, used from M6. |
| `mentionQuoteMaxChars` | `2000` | Positive integer. Longest user message quoted with an `@` result; longer messages are cut with a note. |

## Tool `subagents`

| `action` | Parameters | Effect |
| --- | --- | --- |
| `run` | `agent`, `task`, optional `background` | Starts a new subagent and returns its handle. Foreground waits for the result; background returns at once and delivers the result later (background results always use auto). |
| `resume` | `handle`, `message`, optional `background` | Continues a finished or paused subagent in its own session (background results always use auto). Unknown, stopped, still-running or session-file-missing handles are rejected. |
| `steer` | `handle`, `message`, optional `mode` (`steer` or `followUp`) | Sends guidance to a running subagent. |
| `interrupt` | `handle` | Pauses a running subagent; it can be resumed. |
| `stop` | `handle` | Ends a subagent permanently; it can no longer be resumed. |
| `list` | none | Shows all subagents on the current branch with status and usage. |

Children are asked to end with a `<summary>` tag; without one (or with an empty one) the first 1200 characters are used as the summary.

## Delivery modes (background results)

- `private`: stored as a custom session entry and shown only in the TUI. It never enters the model context, including compaction and branch summaries.
- `share`: written into the main session without starting a turn. The full output goes to a file; the message contains the summary, the output file path and the child session path.
- `auto` (default for @ messages; always used for background runs started by the main agent): same content as `share`, then triggers a follow-up turn.

## Files

With a session directory: child sessions in `<sessionDir>/subagents/`, large outputs in `<sessionDir>/subagents/outputs/`,
and a read-only snapshot `<sessionDir>/<sessionId>.subagents.json` (never used for recovery; session entries are authoritative).

## Known limits (M1)

- Esc pauses subagents only while the `subagents` tool call is executing. Background children keep running after Esc; use `interrupt` or `stop`.
- After `/fork` or `/tree`, each branch resumes a subagent from the point its own record last ended, so branches do not see each other's later turns. Their turns are written to the same child session file as separate branches; two pi processes resuming the same handle at the same time write to that file without a lock.
- Without a session directory (in-memory session), child sessions and outputs go to `<tmpdir>/pi-subagents/<sessionId>/` and no snapshot is written.
- `private` results are visible only in the TUI; in print, JSON or RPC mode they are not displayed.
- After `/reload` or a restart, records that were running are marked `paused` and can be resumed.
- After `/tree`, a still-running record carried over to the new branch may share its handle with a record already on that branch. `@handle` resolution is then ambiguous; use the record id, or wait for the run to finish.
- Not yet available: RPC runner, `@handle` mentions in the editor, chains, nested subagents. These are planned for later milestones.
