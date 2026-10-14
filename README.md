# subagents

Planned pi extension: delegate work to named subagents that keep their session,
can be steered while running, and can be resumed with `@handle` after they finish.
Runs children either in-process (pi SDK session) or as a long-lived `pi --mode rpc` process.

Status: planning. See `/sandbox/temp/plans/pi-subagent-extension-plan.md` section 6.
