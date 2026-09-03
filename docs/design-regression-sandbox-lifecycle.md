<!-- llm-context: How the regression-test-playbook's smoke-test sandbox isolates itself from a real, concurrently-running apra-fleet supervisor on the same machine, and the non-obvious cross-shell pid pitfall that hazard-scoping code on Windows must respect. Read before touching sandbox-lock.mjs, dolt-orphan-sweep.mjs, kill-port.mjs, reap-sandbox-dolt.mjs, or the regression-test-playbook Setup/Teardown steps. -->
<!-- keywords: sandbox isolation, regression-test-playbook, dolt-orphan-sweep, sandbox-lock, MSYS pid, process.kill, port guard, supervisor readiness, singleton version check -->
<!-- see-also: windows-shell-selection.md (shell probing/selection), cross-shell-command-construction.md (command building across shells) -->

# Design: Regression-test-playbook sandbox lifecycle and cross-instance isolation

## Why this exists

The regression-test-playbook's smoke test (Part 2) boots a throwaway
supervisor sandbox by overriding `HOME`/`USERPROFILE` to a temp root and
using a non-default port range, so it does not touch a developer's real
`~/.apra-fleet`. That HOME-level override already closes known gaps in
`os.homedir()`-derived paths. What remains hard is everything that is
*not* naturally scoped by that override: processes, ports, and lockfiles
that a concurrently-running real supervisor on the same machine can also
touch.

## Invariant: a shell's `$$` is not a native OS pid on Windows Git Bash

Any liveness check that records a pid in one shell and later probes it
with a *different* mechanism must keep both sides in the same pid
namespace. Under Git Bash on Windows, `$$` (and MSYS-spawned child pids in
general) are **MSYS pids**, not native Win32 pids. `process.kill(pid, 0)`
(Node's liveness probe) only understands native pids. Recording `$$` from
a Setup shell and later checking liveness with `process.kill(pid, 0)`
therefore compares values from two different numbering spaces:

- A still-live MSYS-side holder can read as dead (native `process.kill`
  finds no such native pid), causing a lock to be reclaimed while its
  original owner is still running -- a correctness hazard, not just a
  false negative.
- An unrelated *native* process that happens to reuse that numeric pid can
  read as "busy", blocking a legitimate new sandbox run for no reason.

This is not specific to one lockfile implementation -- it is a property of
mixing MSYS-origin pids with native-origin liveness checks, and applies
anywhere a Windows Git Bash process id is captured for later
cross-process comparison (readiness probes, lockfiles, watchdogs). Treat
any pid captured from a Git-Bash `$$` as untrustworthy input to
`process.kill(pid, 0)` until it has been translated to (or cross-checked
against) a native pid.

## Cross-instance hazards this sandbox design guards against

- **Orphan-sweep kill scope.** A sweep that reaps orphaned Dolt
  `sql-server` processes must scope its kill set to the *owning*
  supervisor instance, not just to a port-range/process-age heuristic
  applied machine-wide -- otherwise an isolated sandbox supervisor with a
  locally-registered member can kill Dolt processes belonging to a
  different, live supervisor instance on the same machine. The owner
  scope is derived from `APRA_FLEET_DATA_DIR`; when that value falls back
  to a *relative* path, the owner-scope filter is inert (documented as a
  known, not-yet-test-pinned gap -- do not assume owner scoping holds
  under a relative data-dir).
- **Port collisions.** The smoke-test sandbox uses scratch ports (e.g.
  port 18700 for a scripted, fail-loud verification gate; port 3001 for
  the toy dev server started/stopped by Setup/Teardown) specifically so a
  real service or a prior interrupted run's orphaned process already
  bound to that port is detected and visibly skipped/guarded, rather than
  silently colliding or falsely reporting success. A "port not free"
  condition inside the sandbox setup should always fail loud or skip
  visibly -- never silently pass as if the guarded resource were free.
- **Dolt transient-failure taxonomy.** Fork/exec spawn failures (the OS
  could not even start the Dolt process) are classified as *transient*,
  not *remote-unreachable* -- the two failure modes call for different
  retry/backoff behavior and conflating them causes the wrong recovery
  path to run.
- **Oversized settle SQL.** Settle-phase SQL that is too large for a
  single `-c` argument is routed through a scratch file instead, avoiding
  a silent truncation/argv-length failure mode on some shells.

## Server reuse requires a version match

`start`'s "reuse an already-running server" path checks the running
server's advertised version (from its `server.json`) against the version
being started. A mismatch is a hard refusal to reuse -- the caller must
stop the stale server and start the new one, rather than silently
continuing to talk to an old binary. Reuse remains lenient (does not
refuse) only when the running server reports no version at all, since
that is the pre-versioning legacy case rather than a genuine mismatch.

## Test-harness hermeticity: fail loud on unmocked network commands

The mock-sprint test harness intercepts network-shaped commands (curl/wget
building VCS provider requests) so tests never make real network calls.
The guard matches on command *shape*, not a fixed wrapper allowlist, so a
composed or differently-quoted curl/wget invocation is still caught. A
known residual gap: the guard's shape-matching is anchored in a way that
still misses an **absolute-path** invocation (e.g. `/usr/bin/curl ...`
matches differently than a bare `curl ...`) -- treat this as an open gap
in the interception surface, not a solved problem, when adding new
network-shaped test coverage.
