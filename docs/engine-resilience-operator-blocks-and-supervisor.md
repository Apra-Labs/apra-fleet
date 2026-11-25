# Engine resilience: operator blocks, supervisor liveness, auth heal, launch preflight

Design notes for how the fleet-sprint engine and supervisor behave when the
environment or the operator, rather than the code, is the blocker.

## LLM auth self-heal fails loudly

The self-heal callback returns a structured outcome. A deploy that the server
could not verify (`deployed_unverified`) is a failed heal, and its cause is the
server's own Auth test line, word for word. A failed heal throws
`LlmAuthSelfHealFailedError` (member, cause, remedy) on both the abort and
non-abort dispatch ladders. There is no "succeeded, retrying" log, no backoff
and no retry: retrying against credentials the server could not verify only
burns the ladder.

## Plan loop and operator blocks

- `SprintBlockedOnOperatorError` carries terminal reason `BLOCKED_ON_OPERATOR`.
  It is a typed abort but not a deterministic relaunch gate: the same sprint can
  be relaunched once the operator acts.
- A planner that returns BLOCKED files a pending decision and waits on the
  decision channel. Once answered, planning re-runs and the BLOCKED round does
  not count against the plan round cap. With no answer or no pause channel the
  sprint ends with the typed error instead of re-planning.
- A plan-reviewer CHANGES_NEEDED that names only beads held by an open decision
  or human bead is non-blocking.
- The Plan phase is skipped when every open in-scope bead is held by an open
  gate. The check reuses Route's beads snapshot (no extra `bd` call). Only
  `discovered-from` edges from a gate hold work; a gate's own `blocks`
  dependencies are its prerequisites and do not hold it.

## Supervisor must outlive its console

- `serve.mjs` detaches by default when stdin or stdout is a TTY. `--foreground`
  opts out; `--detach` together with `--foreground` is refused. The detached
  child is always started with an explicit `--foreground`. Non-TTY service
  managers keep running in the foreground.
- Coordination clients (dolt-mutex acquire, id allocate) retry only
  `ECONNREFUSED` (read from the error cause chain) for a bounded budget (default
  120 s, `FLEET_SPRINT_SUPERVISOR_WAIT_MS`). Any other transport failure throws
  `SupervisorUnreachableError` at once. When the supervisor is the cause, the
  post-dispatch sync error names it rather than blaming credentials or remote.

## Documented control commands are tested

Every documented POST to the supervisor sends `Content-Type: application/json`
and a `{}` body (PowerShell equivalents included), per the request guard. A docs
check and a verbatim run of the documented shutdown/stop commands against a real
supervisor keep the docs from drifting from the guard.

## Launch refuses unpushed beads

`POST /api/sprints` probes whether the local beads clone holds unpushed changes
before the member-overlap guard. Definitely unpushed: HTTP 409 with the remedy.
Inconclusive probe: a warning, and the launch proceeds. A sprint launched from
an unpushed clone would otherwise work from stale scope.

## Known gaps

- The dolt-sync uncommitted-changes reader guesses field names that
  `bd vc status --json` does not return, so that branch never fires.
- The 409 remedy chains with `&&`, which Windows PowerShell 5.1 lacks.
- `LlmAuthSelfHealFailedError` does not set its `name` and is not listed in the
  typed-abort check, so a failed heal ends as an untyped abort.
