# Sprint reliability gates and honest-failure contracts

Design record for a set of hardening changes whose common theme is: an operation
that did not happen must never be reported as having happened. Each item states the
invariant a future contributor must preserve.

## Sprint verdict gates

- **Failed deploy blocks PASS.** If the last cycle's deploy failed, the final
  verdict cannot be PASS, and the verdict and PR body name the failure. The gate is
  applied in the deploy verdict helper and again at the runner's satisfied-exit
  path, and it overrides a reviewer's final PASS. Known gap: a failed deploy.md
  probe currently clears the gate (tracked as backlog).
- **Reopen gate.** A reviewer's reopen of a below-goal bead is honoured only when
  the sprint actually worked on that bead. A red branch always yields a fix task,
  regardless of the reviewer's other output (`buildFailing` in the review schema).
- **Dispatch filter.** Ready beads below the goal priority are excluded from
  Develop dispatch unless they block in-goal work.

## Preflight

- A member that reads beads has beads set up before dispatch, or preflight fails.
- A dispatch member's missing permission config is re-composed before dispatch.
- The VCS preflight states its outcome; the "no callTool" skip log applies only to
  the VCS credential fallback. The backlog beads sync refreshes credentials.
- Unpushed schema migrations are published at the preflight D-pull.

## Landed-push verification

A D-push (dolt) or G-push (git) is only "landed" once the remote ref is observed to
have moved (`confirmPushLanded` in dolt sync, `checkGitPushLanded` in member sync).
A timed-out, transport-failed, or unmoved push is reported failed, never logged as
landed. A no-op push (nothing to push) is a separate case and is not verified
against a live remote in tests.

## execute_command failure contract

On exec timeout or transport failure `execute_command` returns `isError` with
`exitCode: -1` and a typed `reason`, instead of prose that looks like output.
The client's `commandFailureOf` and workflow `command()` read this and fail the
call. Any change to this shape must be made in the server tool and
`apra-fleet-client` together.

## Dispatch failure classification and healing

- An expired-OAuth result is classified as an LLM auth failure, healed once, and
  fails loudly if the heal fails.
- Claude `permission_denials` are judged by the session's permission mode
  (`claudePermissionMode`: the member's `unattended` setting plus the model;
  `auto` on a model without auto support, e.g. Haiku, runs `acceptEdits`).
  fleet-sprint dispatches with `fail_on_permission_denial: true`; other callers
  get a success with `permissionWarning` on a complete reply (v0.4.3
  semantics). A max_turns / auth / server result keeps its own reason, with
  the denials attached.
  - auto/bypass mode: the refusal is the safety classifier or a deny rule.
    A complete reply is a success carrying the denials as `permissionWarning`
    (logged); an incomplete one fails `permission_denied` with
    `healable: false` when the caller passed `fail_on_permission_denial: true`
    (fleet-sprint does), and otherwise keeps its ordinary reason with the
    denials attached as `permissionDenied`. No grant is ever added for it.
  - acceptEdits mode: the dispatch fails `permission_denied` and fleet-sprint
    heals it progressively: grant the missing tool (only within the member's
    composed policy from `compose_permissions` dry_run), retry, repeat for the
    next tool. It stops when no progress is possible (refused again after its
    grant, outside policy, NEVER_AUTO_GRANT, no grant maps) or at 3 heals per
    member per sprint / 2 per dispatch. Grants are recorded in a per-member
    ledger folder so the next sprint keeps them. A plan-reviewer refusal is
    never counted as a plan rejection.

## Cost accounting

A Claude dispatch is charged the CLI's own `total_cost_usd` (list price, model-
and cache-TTL-correct). It is cumulative across `--resume`, so the server
records each session's last figure and charges the delta (`usage.cost_usd`).
The rate table (Anthropic list prices; cache writes at the 1-hour rate the CLI
uses) prices only results without a reported cost, e.g. agy or opencode.
Token-unit budgets count input+output only; dollar budgets carry the cache cost.

## SSH / SFTP

- Every SFTP operation has an inactivity timeout; channels left open by a refused
  subsystem request are closed.
- Every `execCommand` caller sets an explicit timeout (see the timeout table in the
  SSH docs). Installer and VCS exec run under `FLEET_PID` so they are killable;
  this shares a per-member stored-PID slot, which is a known widening.
- Re-accepting a changed host key (TOFU) is logged as a warning.

## Windows process limits

`boundChildEnv` (`src/os/child-env-bound.ts`) shrinks the environment handed to
bd/dolt/git children to fit the CreateProcess block cap, deduplicating and trimming
PATH and dropping non-protected variables. When the cap still cannot be met, the
error names the Windows spawn limit instead of suggesting credential problems.
Known gap: it drops every non-protected variable even when that cannot reach the cap.

## Supervisor launch

Sprint ids and log file stems are bounded (`MAX_SPRINT_ID_LENGTH` in the supervisor
API) so multi-issue launches stay under Windows MAX_PATH, and launch failures
surface their cause. Windows-service launcher/log paths for POSIX-style paths must
not resolve relative to the cwd.
