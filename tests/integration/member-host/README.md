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
nothing, then succeed once it is stopped). A stale or missing release baseline
is INCONCLUSIVE (exit 3), never PASS. Every spawned process gets HOME,
USERPROFILE and GIT_CONFIG_GLOBAL pointed at a temp sandbox.
