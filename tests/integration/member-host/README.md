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

Passes: Q (quote-led commands), RF (replace-full), RB (rollback), RFS / RBS
(same with a supervisor running: refuse with E-FLEET-SE-RUNNING, change
nothing, then succeed once it is stopped).

The rollback (`lib/rollback.mjs`) restores from the newest
`$HOME/.apra-fleet-replace-backup-*` that replace-full made (data/, fleet.key,
old binary): uninstall, restore data/ and fleet.key, reinstall the old binary,
each step gated on the previous one (`&&`) and ending in `ROLLBACK-OK`. RB and
RBS then require the data dir listing and fleet.key hash to EQUAL the snapshot
taken right before that pass's replace-full. RBS's refusal attempt runs only
the guarded step (the old binary's reinstall) with the supervisor running, so
an unguarded uninstall or data restore can never run during the attempt that
must prove nothing changed.

A stale or missing release baseline is INCONCLUSIVE (exit 3), never PASS. Every spawned process gets HOME,
USERPROFILE and GIT_CONFIG_GLOBAL pointed at a temp sandbox.
