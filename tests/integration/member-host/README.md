# Member-host upgrade harness

Covers what the fresh-install harness cannot: a member host reached over SSH.
A Windows sshd whose default shell is Git Bash used to drop the argv of
quote-led commands; `memberCommandFor` now delivers POSIX member commands as
base64 + eval. This harness proves that, and the member `replace-full` /
rollback paths from the latest release, on a disposable Windows VM.

- `setup-openssh-gitbash.ps1` - installs and starts OpenSSH, sets Git Bash as
  its DefaultShell, creates a throwaway user and a per-run key pair in the
  runner temp dir, authorized for localhost only. Refuses (exit 2) unless
  `CI=true` and `-IAmDisposable`. The user's profile is created through the
  Windows profile service (userenv CreateProfile) and its real folder read
  from the registry, so `authorized_keys` lands where sshd looks; the key has
  an empty passphrase, checked right after it is generated. The info file's
  `home` is that folder, and `run.mjs` registers the member's work folder
  under it.
- `run.mjs` - `--plan` lists the passes and expected outcomes (any OS, no VM
  changes). A real run needs `--binary`, `--setup-info`, `--i-am-disposable`.
- `lib/` - pure helpers (opt-in refusal, quote-led cases, sandbox paths,
  scenario plan, verdict + report). Unit tests: `tests/member-host-harness.test.ts`,
  `tests/member-host-scenarios.test.ts`.

Passes: Q (quote-led commands), RF (replace-full), RB (rollback), RFS
(replace-full refuses while a sprint runs, reason fleet-se-running, changing
nothing; with only the idle supervisor left it stops it itself and replaces),
RBS (the rollback's reinstall refuses with E-FLEET-SE-RUNNING under a
supervisor, changing nothing, then succeeds once it is stopped).

How the driver talks to the member:
- Exit codes and output come from execute_command's structuredContent
  (exitCode, stdout); a nonzero exit is not an MCP isError. User-only
  `<apra-fleet-display>` items are dropped (`lib/mcp-result.mjs`).
- The member is registered as a claude member with fleet_install skip: only
  claude / opencode members get a member install.
- The orchestrator is installed `--transport stdio` (no service) with its own
  APRA_FLEET_PORT: an http install's service would start in the runner user's
  real environment and hold 7523, which the member (another user on the same
  host) needs.
- The supervisor and the stand-in sprint (a node process holding a sprint
  lock, which the install guard counts) start detached via CreateProcess,
  breaking away from the SSH session's job when the job allows it (WMI is
  refused for a key-auth SSH user); a later session must still see them. The
  rollback reinstalls with `--llm claude`, the member's provider, as the
  product's own rollback steps do. The candidate's own `fleet-se-check`,
  copied to the member home, detects them (the release binary has no such verb).
- RFS copies the release's `workflows/` and `node_modules/` (same layout) to
  `~/supervisor-runtime` right after installing it; RBS starts its supervisor
  from that copy (a member install has no fleet-sprint). serve.mjs imports
  bare `@apralabs/*` packages that resolve only from a `node_modules/` next to
  `workflows/`. A supervisor that is not seen gets report notes: pid alive
  (Get-Process), `~/supervisor.log` size and tail, and the tail of the
  supervisor's own `~/.apra-fleet-se/logs/supervisor.log`.
- A refusal attempt runs only when its precondition step passed (RFS: the
  sprint was detected; RBS: the supervisor is up). Otherwise it is recorded
  FAIL (`SKIPPED`) and not run, so a non-refusal cannot replace or reinstall
  under the later steps.
- Report notes carry diagnostics, never verdicts: the member's ApraFleet task
  state, HKCU Run entry and logon sessions, and what the install guard's
  `Get-CimInstance` command-line probe returns in the SSH session.

The rollback (`lib/rollback.mjs`) restores from the newest
`$HOME/.apra-fleet-replace-backup-*` that replace-full made (data/, fleet.key,
old binary), as docs/install.md says: uninstall; put the old data back from
`data.replaced-<stamp>` (data/ kept if never moved; the backup's data/ only
when neither exists); restore fleet.key only if missing; reinstall the old
binary. Each step is gated on the previous one (`&&`) and ending in `ROLLBACK-OK`. RB and
RBS then require the data dir listing and fleet.key hash to EQUAL the snapshot
taken right before that pass's replace-full. RBS's refusal attempt runs only
the guarded step (the old binary's reinstall) with the supervisor running, so
an unguarded uninstall or data restore can never run during the attempt that
must prove nothing changed.

`service-notice.json` in the data dir is a one-shot notice, not state: the
release's first install writes one, the rollback's reinstall clears it, and
the release guard writes one when it refuses. `client-autostart.lock` is the
client auto-start mutex: a process that exits mid auto-start leaves it behind
(the idle supervisor stopped by replace-full while it waits on the member
server), and the next auto-start removes it as stale. Every listing compare
(RB/RBS data, RFS/RBS unchanged) leaves both out and says so.

Known gap: on Windows the member's server is a scheduled task that runs only
in an interactive logon session, so a member reached only over SSH has no
running server. `rf-tools` is ENV-LIMITED, with the note `KNOWN-GAP (member
server needs an interactive logon on Windows; tracked for v0.4.7)`, only when
all four hold:
- keyline `SERVER-NOT-STARTED`: the auto-start handed off to the service
  manager and timed out;
- the candidate is older than 0.4.7;
- the ApraFleet task's Last Result reads as a never-ran code (a run that
  ended, with any code, or is still running is not the gap; an unreadable
  Last Result, no task or a failed diag is not either);
- the server log the error names, and `data/fleet.log` (where the task wrapper
  appends the server's stderr), show no crash: uncaughtException,
  unhandledRejection, fatal, nonzero exit, Node's `Node.js vX.Y.Z` crash
  footer, or an error-level `startup` record.

That signature alone cannot tell the gap from a member-mode server crashing
on start, and nothing else in the regression suite starts a `--member` http
server on Windows. A crash is `SERVER-CRASHED` (FAIL). The log tails and the
task's Last Result go to the notes. The gap is listed under Overall at the
top of report.md and as a CI warning. Any other `rf-tools` failure is FAIL.

A stale or missing release baseline is INCONCLUSIVE (exit 3), never PASS. Every spawned process gets HOME,
USERPROFILE and GIT_CONFIG_GLOBAL pointed at a temp sandbox.
