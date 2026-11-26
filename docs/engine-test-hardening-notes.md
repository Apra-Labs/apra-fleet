# Cross-platform kill, align result and test-budget notes

Durable design notes on a set of hardening changes to timeout kill, member
alignment, the pre-sprint check and slow-runner test budgets.

## Git Bash timeout kill walks the MSYS process tree

On a Git Bash member on Windows, the Windows parent-pid link between a
timed-out command and its descendants is broken by MSYS process emulation, so
`taskkill /T` on the root alone leaves descendants alive. The kill therefore:

1. walks the MSYS process tree under `/proc` (by MSYS parent pid) from the root,
2. `taskkill`s each process's Windows pid,
3. `kill -9`s the MSYS pids,
4. then runs the original `taskkill /T` as a final sweep.

Invariants:
- Only descendants of the root are touched; errors for processes already gone
  are swallowed.
- The pid wrapper (`pidWrapGitBash`) appends a `_fleet_rc` tail so the subshell
  stays a live bash; the command's exit status is unchanged.
- The tree kill applies to Git Bash members only. Linux, macOS and PowerShell
  kill strings are byte-identical to before.
- Tests model the broken parent link with a fake `/proc` and process table. A
  re-run on a real Windows Git Bash host is still unproven.

## Align: an unreachable member is not a missing origin remote

`toAlignCommandResult` (member-align) classifies a result as unreachable when
`isError` plus a `reason` is set, or `exitCode < 0`. `execute_command` sets
`isError`/`reason` only on preflight and dispatch failures, never on the
success path, so a preflight-offline member no longer reads as "no origin
remote". A genuine missing origin (exit code 2) stays distinct.

## Pre-sprint check mixes cached and fresh bead reads (fixed)

The pre-sprint check in the sprint runner takes the ready list and the
not-done list as fresh `bd list` reads, but derives the verify-routing set from
the run's cached full-DB snapshot. The cache invalidation contract only covers
commands issued through the run's own command wrapper, so a `bd close` from
another process (for example a second sprint sharing the same epic) leaves the
snapshot stale. Result: nothing is ready, the root is not routed to verify, and
the check throws DEADLOCKED naming only the root.

Fix: before declaring a deadlock, the check invalidates the cached snapshot and
classifies the verify set again on a fresh read taken after the not-done read,
so routing and readiness agree (closes only add, so that snapshot sees every
close the not-done read saw). Pinned by
`packages/apra-fleet-se/test/mock-sprint-pre-sprint-concurrent-close.test.mjs`.
Related: when a real server already holds the supervisor port, the client
auto-start waits its full timeout though `start` exits non-zero at once; it
should fail fast.

## Test-budget conventions for slow runners

- Spawn-heavy tests use Windows-sized timeouts (30s-60s) and marker waits of
  15s; assertions are never weakened to fit a slow runner.
- Wall-clock budgets scale with test concurrency (`scaledTimeout`), while the
  structural check (only `git` is ever spawned) stays the primary guard.
- Tests that exercise scheduled-task XML or launcher generation must not
  write into the working directory: assert by name that no such file appears in
  the cwd and that launcher paths are absolute and inside the tmp dir.
