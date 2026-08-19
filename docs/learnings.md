# Fleet Learnings

Operational knowledge gathered from real fleet usage. Will eventually become a skill for guiding users through common scenarios.

## Member Registration Troubleshooting

### SSH Connection Refused (ECONNREFUSED)

**Symptom:** `register_member` fails with `connect ECONNREFUSED <host>:22 -- Agent was NOT registered.`

**Root cause:** SSH server is not running or not enabled on the target machine.

**Platform-specific steps:**

#### macOS

SSH (Remote Login) is disabled by default on macOS.

**Via System Settings (GUI):**

1. Open **System Settings** (or System Preferences on older macOS)
2. Go to **General -> Sharing**
3. Toggle on **Remote Login**
4. Choose whether to allow access for all users or specific users

**Via Terminal:**

```bash
# Enable SSH (Remote Login)
sudo systemsetup -setremotelogin on

# Verify it's running
sudo systemsetup -getremotelogin
```

#### Linux (Ubuntu/Debian)

```bash
# Install and enable SSH server
sudo apt install openssh-server
sudo systemctl enable --now sshd

# Verify it's running
sudo systemctl status sshd
```

#### Linux (RHEL/Fedora)

```bash
# Install and enable SSH server
sudo dnf install openssh-server
sudo systemctl enable --now sshd

# Verify it's running
sudo systemctl status sshd
```

#### Windows

**Via Settings (GUI):**

1. Open **Settings > Apps > Optional Features**
2. Click **Add a feature**, search for and install **OpenSSH Server**
3. Open **Services** (services.msc), find **OpenSSH SSH Server**, set startup type to **Automatic**, and start it

**Via PowerShell (Admin):**

```powershell
# Install OpenSSH Server
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Start the service
Start-Service sshd

# Auto-start on boot
Set-Service sshd -StartupType Automatic

# Verify it's running
Get-Service sshd
```

#### Windows -- Additional Setup for Remote Members

After installing OpenSSH Server, Windows has some quirks that can block fleet registration:

**Default shell:** Windows OpenSSH defaults to `cmd.exe`. For best compatibility with fleet commands, switch to PowerShell:

```powershell
# Set PowerShell as the default SSH shell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
```

**Admin users and authorized_keys:** Windows OpenSSH has a special rule for administrator accounts -- it ignores `~/.ssh/authorized_keys` and instead reads `C:\ProgramData\ssh\administrators_authorized_keys`. If key-based auth fails for an admin user:

```powershell
# Add your public key to the administrators file
Add-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value "ssh-rsa AAAA..."

# Fix permissions (must match sshd expectations)
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "SYSTEM:F" /grant "BUILTIN\Administrators:F"
```

For non-admin users, `~/.ssh/authorized_keys` works normally.

**Elevated sessions:** Windows OpenSSH runs with full admin privileges when the SSH user is in the Administrators group -- UAC is bypassed entirely. This means all fleet commands will execute as admin. Be aware of the security implications, especially on production machines. To avoid this, use a non-admin user account for SSH.

**Admin vs non-admin:** Fleet operations (registration, status checks, auth provisioning, execute_prompt) do **not** require admin privileges -- they work with standard user accounts. Using a non-admin user is recommended for better security.

**Claude install/update on Windows:** Both install and update work without admin. Claude installs per-user to `C:\Users\<username>\.local\bin\claude.exe` -- same pattern as Linux/macOS (`~/.local/bin`). The installer warns that `.local\bin` is not in PATH; the fleet server handles this automatically by prepending the path before running claude commands.

**Verify SSH is reachable:** From another machine, test with `ssh username@windows-host`. If it connects but immediately closes, the default shell may not be set correctly (see above).

### Authentication Failed (All configured authentication methods failed)

**Symptom:** `register_member` fails with `All configured authentication methods failed -- Agent was NOT registered.`

SSH is reachable but the credentials are wrong. Common causes:

- **Wrong password** -- macOS uses the user's login password, not a separate SSH password
- **Password auth disabled** -- some systems only allow key-based auth by default. Check `/etc/ssh/sshd_config` for `PasswordAuthentication yes`
- **Wrong username** -- macOS usernames are case-sensitive and may differ from the display name (check with `whoami` on the target)

### Firewall Blocking Port 22

If SSH is enabled but connection still refused, check firewall rules:

- **Linux:** `sudo ufw allow ssh` or `sudo firewall-cmd --add-service=ssh --permanent && sudo firewall-cmd --reload`
- **macOS:** SSH through the firewall is allowed automatically when Remote Login is enabled
- **Windows:** `New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22`

## Auth Provisioning

### Prerequisites

- **For OAuth (default):** Run `/login` in your Claude Code session (or `claude auth login` from terminal) first. `provision_llm_auth` copies your credentials to the remote member.
- **For API key:** Have your Anthropic API key ready. Pass it as the `api_key` parameter to `provision_llm_auth`.

`provision_llm_auth` checks token expiry before deploying. If your access token is expired but a refresh token exists, deployment proceeds -- the member's CLI will auto-refresh on first use.

### Auth Check Failed Warning During Registration

If `register_member` succeeds but shows `Claude CLI auth check failed -- you may need to run provision_llm_auth`, this is normal for new members. Run `provision_llm_auth` with the member's ID to set up authentication.

## Local Member on Windows -- Pristine Shell Issues

### Problem: `claude -p` Hangs Inside a Claude Code Session

When the MCP server runs inside a Claude Code session, `LocalStrategy.execCommand()` spawns child processes that inherit the parent's environment. Two issues caused `claude -p` to hang indefinitely with zero output:

**Issue 1: `CLAUDECODE` env var leaks into child process**

Claude Code sets `CLAUDECODE=1` in its process environment. When a child `claude -p` process sees this var, it refuses to start (nested session protection). The original fix (`delete env.CLAUDECODE` from a copy of `process.env`) was fragile -- it only stripped one known var and leaked the full parent environment.

**Fix:** Added `cleanExec(command)` to the `OsCommands` strategy interface. Each OS provides a pristine shell:
- **Linux/macOS:** Wraps command in `env -i bash -l -c '...'` -- clears the entire env, rebuilds from login profiles.
- **Windows:** Reads Machine + User registry env vars via `[Environment]::GetEnvironmentVariables()`, adds Windows session-level vars (USERPROFILE, APPDATA, SystemRoot, etc.), caches the result. Returns this as the `env` option to `exec()`, completely replacing `process.env`.

**Issue 2: `exec()` leaves stdin open**

Node's `child_process.exec()` connects the child's stdin to the parent. `claude -p` detects it's connected to a non-TTY pipe and waits for input that never arrives -- hanging indefinitely. This happened regardless of environment variables.

**Fix:** Added `child.stdin?.end()` immediately after the `exec()` call in `LocalStrategy.execCommand()`. This closes stdin so `claude` proceeds with the `-p` prompt argument instead of waiting for piped input.

**Issue 3: Windows session-level env vars missing from registry**

The initial `getCleanEnv()` implementation only added 4 session vars (USERPROFILE, HOMEDRIVE, HOMEPATH, USERNAME). Windows creates ~18 session-level vars at login that are NOT stored in the registry (SystemRoot, APPDATA, LOCALAPPDATA, ProgramFiles, etc.). Without SystemRoot, many Windows system APIs fail. Without APPDATA, applications can't find their config directories.

**Fix:** Expanded the session var list to include all well-known Windows login-time variables.

### Debugging Technique

To isolate the stdin hang, tested with `spawn()` + `child.stdin.end()` vs `exec()` (which leaves stdin open). The `spawn` variant completed in 2 seconds; `exec` hung for 60+ seconds until killed. This confirmed the root cause was stdin, not environment.

### Key Takeaway

When spawning CLI tools from Node.js that are designed for interactive use, always close stdin if you don't intend to pipe input. This applies to any tool that might check for TTY/pipe and alter its behavior accordingly.

## MCP Tool Output

MCP tool results get collapsed in Claude Code's console (shown as "+N lines", requiring Ctrl+O to expand). Returning JSON from tools works best -- the agent parses the structured data and renders it in its own response, which displays fully. Avoid formatting tables or reports in tool output; let the agent handle presentation.

## Claude Workspace Trust Fix (eft.40) -- Live Verification Evidence (apra-fleet-eft.40.4)

Live end-to-end verification of the eft.40.1/40.2/40.3 fix chain (`ensureWorkspaceTrusted`,
its wiring into `register_member`/`update_member`/`compose_permissions`, and the typed
`workspace_not_trusted` dispatch error), run against the **real** `claude` CLI (2.1.212,
macOS) via a genuinely fresh, never-opened `HOME` + `work_folder` -- not mocked exec.
Recorded here per the eft.40.4 VERIFICATION RECIPE rather than as a permanent vitest
suite, since it requires a real installed Claude CLI, real OAuth credentials, and makes
real (small) API calls -- none of which belong in the hermetic `npm test` run.

### Repro harness

Drove the actual compiled tool functions (`registerMember`, `composePermissions`,
`executePrompt`, `removeMember` from `dist/tools/*`) directly, with `HOME` overridden to
a fresh `mktemp -d` and `NODE_ENV=test` (to skip `register_member`'s interactive-bootstrap
branch, which needs a running fleet server). `member_type: 'local'` was used so
`LocalStrategy` naturally exercises real `env -i ... bash -l -c` clean-env delivery
(see "Local Member on Windows" section above -- the same `cleanExec` path also strips the
operator's own `CLAUDE_CODE_OAUTH_TOKEN`/macOS Keychain session). To authenticate the
member despite that, the harness set `agent.encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN`
directly on the registry entry (the same field `provision_llm_auth` populates), which
`buildAuthEnvPrefix` inlines as `export CLAUDE_CODE_OAUTH_TOKEN="..." && ...` into the
dispatch command itself -- surviving the clean-env spawn since it's set inside the shell
command, not the parent process env.

### CONDITIONAL reproduction -- exact trigger

Confirmed the bug is real and reproduces, but only under specific conditions, matching
the eft.40.4 task notes:

- **Work folder must carry a project-scoped `.claude/settings.json` with real
  `permissions.allow` entries** (a plain empty work folder with only a
  `.claude/settings.local.json` did NOT trigger the warning in an early attempt -- the
  degradation is specifically about *project-scoped* permission sources).
- **The member's `unattended` setting must be `false`/omitted (default permission mode,
  no `--permission-mode` flag)** -- a member registered with `unattended: 'auto'`
  (`--permission-mode auto`) did **not** reproduce the bug at all: Claude's `auto` mode
  approves most tool calls independent of `permissions.allow` matching, so the
  trust-gated allow-list path is never consulted. `compose_permissions`'
  `permissions.allow` entries are specifically for **default** mode -- that is the mode a
  real doer/reviewer member is expected to run in.
- **The command the model attempts must actually match/need an allow-listed pattern**
  from the untrusted source. A prompt whose tool call never needs the allow-list (e.g. a
  bare `Read`) will not surface anything.

### Real captured stderr (ground truth for `classifyPromptError`)

With a never-trusted work folder carrying an 18-entry project `.claude/settings.json`,
default permission mode, dispatching `mkdir -p eft404-marker-prefix && echo ...`:

```
Ignoring 18 permissions.allow entries from .claude/settings.json: this workspace has not
been trusted. Run Claude Code interactively here once and accept the trust dialog, or set
projects["/private/tmp/fleet-neveropened3-rqrVMg"].hasTrustDialogAccepted: true in
/tmp/fleet-fakehome3-XTqts0/.claude.json.
```

This confirms `src/utils/prompt-errors.ts`'s pattern
(`/this workspace has not been trusted/i`) matches the CLI's real wording verbatim, and
`execute_prompt` correctly surfaced the typed error (`structuredContent.reason ===
'workspace_not_trusted'`, `workspaceNotTrustedAdvice(...)` text prefixed onto the raw CLI
stderr) instead of falling through to the generic failure/retry paths.

### End-to-end result (all POST-FIX assertions held)

1. `register_member` (local, never-opened folder) seeded trust immediately -- no separate
   step needed (eft.40.2 wiring at registration).
2. Trust entry was deliberately deleted from the member-side `~/.claude.json` (simulating
   a pre-fix member / corrupted file). The next dispatch reproduced the real CLI warning
   above and `execute_prompt` returned the typed `workspace_not_trusted` error (eft.40.3)
   -- the `mkdir` never ran (`eft404-marker-prefix` was never created on disk).
3. `compose_permissions` self-healed trust on that same run (eft.40.2's "every compose"
   invariant) -- verified via `~/.claude.json`.
4. The next dispatch (identical shape, `eft404-marker-postfix`) succeeded with no trust
   warning anywhere in stdout/stderr, and the directory was actually created on disk --
   composed permissions were honored on first real dispatch.
5. `~/.claude.json` contained **exactly one** `projects` key, matching the work folder
   path precisely (`hasTrustDialogAccepted: true`) -- confirms exact-folder scoping, no
   parent-directory or sibling-project leakage.
6. A non-Claude provider (`GeminiProvider.ensureWorkspaceTrusted` -- Gemini was a
   supported provider at the time of this verification and has since been removed)
   returned `{ seeded: false }` and never invoked the exec callback -- confirms the fix
   is a no-op for other providers.
7. `remove_member` cleaned up the temp registry entry; the temp `HOME`/`work_folder`
   scratch directories were deleted after the run.

No code changes were needed -- this task closes the eft.40 verification loop with real
evidence rather than mocked-exec unit assertions (which `tests/ensure-workspace-trusted.test.ts`,
`tests/compose-permissions.test.ts`, `tests/execute-prompt.test.ts`, and
`tests/prompt-errors.test.ts` already cover).

## Workspace trust detection must not assume a nonzero exit code

The workspace-trust failure mode documented above (eft.40) was originally
detected only on a nonzero CLI exit code with a matching stderr pattern. A
live incident found a second shape of the same underlying problem: a
freshly-initialized provider identity that has never been run interactively
on that host can also fail with **exit code 0 and empty stdout** -- the CLI
exits cleanly mid-turn with no parseable output at all, rather than a
nonzero exit with a recognizable trust-dialog message. Detection logic that
only fires on nonzero exit misses this case entirely, so the existing
self-heal (re-seed workspace trust and retry once) never triggers, and the
dispatch instead surfaces as a generic empty-response failure with no
actionable signal.

The fix classifies an exit-0/empty-stdout dispatch against a workspace whose
trust has not been established as `workspace_not_trusted` (not
`empty_response`), gated to self-heal-and-retry exactly once: seed trust,
retry the dispatch, and if the retry still comes back empty, fall through to
`workspace_not_trusted` rather than looping. A plain empty-stdout dispatch
against an already-trusted workspace is unaffected -- the new classification
only applies when the trust signal itself indicates the workspace has never
been accepted. This closes an entire failure class (a member's very first
real dispatch after registration silently dying with no diagnostic signal)
that the exit-code-based detection alone could not catch.

## Windows entrypoint guards: `file://${process.argv[1]}` string comparison silently never matches

Several standalone verification/CLI scripts under `scripts/` used the common
Node idiom to detect "was this file run directly, not imported" by comparing
`import.meta.url` against a hand-built string:

```js
if (import.meta.url === `file://${process.argv[1]}`) { main(); }
```

**This never matches on Windows.** `process.argv[1]` on Windows is a native
path (`C:\path\to\script.mjs`), so the hand-built string ends up with two
slashes after the scheme (`file://C:\path\to\script.mjs`) while
`import.meta.url` is a properly-encoded URL with three slashes and forward
slashes throughout (`file:///C:/path/to/script.mjs`). The comparison is
always false, `main()` never runs, and the script exits 0 having printed
nothing and verified nothing -- indistinguishable from a genuine pass unless
someone checks the script's actual output for the expected content.

This is a particularly dangerous failure mode specifically because it is
**silent and looks like success**: a verification script whose entire job
is to fail loudly on a real problem instead exits clean regardless of input,
so a CI/integration pass built on "the checker script exited 0" gives false
confidence.

**The fix**, applied uniformly everywhere this idiom appeared:

```js
import { pathToFileURL } from 'node:url';
// ...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

`pathToFileURL()` produces the same correctly-encoded, forward-slashed form
`import.meta.url` uses, on every platform -- so the comparison is meaningful
cross-platform instead of only on POSIX.

**Corollary invariant for testing this class of defect:** an in-process
`import()` of the module does not exercise this guard at all (the module
loads either way; only a real CLI invocation drives `process.argv[1]`).
Coverage for an entrypoint guard fix must **spawn the script as a real CLI
process** (e.g. `execFileSync`/`spawn` against `node script.mjs <args>`) and
assert on its actual stdout/exit code -- a unit test that merely imports the
module and calls its exported functions directly can pass while the guard
itself is still broken.

## Windows: invoking `bd` via `execFileSync` without a shell fails with ENOENT

`execFileSync('bd', [...])` (no `{ shell: true }`) throws `spawnSync bd
ENOENT` on Windows even when `bd` is genuinely installed and works fine
interactively. The root cause: the globally-installed `bd` (npm's
`@beads/bd`) resolves on PATH to npm's shim files (`bd.cmd`/`bd.ps1`), not a
directly-executable binary -- Windows' `CreateProcess` cannot exec a shebang
script directly, and only an interactive shell (which consults `PATHEXT`)
resolves the `.cmd`/`.ps1` shim on its own. A plain array-form
`execFileSync` spawn does not do that PATHEXT resolution.

The naive fix -- adding `{ shell: true }` -- reintroduces a real command
injection surface: Node joins the command and every array-passed argument
into **one unquoted shell command line** when `shell: true` is set, so shell
metacharacters (`&`, `;`, `$()`, ...) inside any argument value are
reinterpreted by `cmd.exe` as separate tokens or additional commands. This
matters concretely for call sites that pass caller-influenced values (a
`--prefix` string, a `pathToFileURL(...)`-derived `--remote` URL) that are
not shell-escaped anywhere in the pipeline.

The durable fix instead **locates the actual wrapped script the npm shim
points to and invokes that directly**, with no shell involved at all: parse
`bd.cmd`'s contents for the underlying `bin/bd.js` path (every npm Windows
shim ends with a line invoking that script via a double-quoted path
immediately followed by `%*`), then spawn
`execFileSync(process.execPath, [scriptPath, ...args])` -- a normal
argv-array child-process spawn. This is strictly safer than trying to quote
values correctly for `cmd.exe` (a notoriously easy thing to get subtly
wrong) while also sidestepping the original ENOENT problem, since the
`.cmd` file (and its shebang/PATHEXT dance) is never invoked at all. On
non-Windows platforms the shim-resolution step is a no-op and a real `bd`
binary already execs fine via a plain, shell-less `execFileSync`, so
behavior there is unchanged.

A shared helper implementing this now backs every `bd` invocation site that
previously used `execFileSync`/`{ shell: true }` directly, so the fix (and
its safety property) is not something each call site has to reimplement or
risk getting wrong independently. One call site that only ever passes
structured, non-free-text arguments (subcommands, flags, issue ids -- never
operator-supplied URLs or prefixes) additionally validates every argument
against an allowlisted character set before any shell-involving fallback
path could see it; this extra check is appropriate there specifically
because that caller's inputs are narrow enough to allowlist safely, not
because it is a stronger guarantee than the shim-resolution fix itself.

## `compose_permissions` reported success on a config write that never landed

**Symptom:** a `compose_permissions` grant call returned a success message
("Granted N permissions" / "Permissions composed"), but the target member's
provider settings file (`.claude/settings.local.json` and equivalents) was
unchanged on disk -- the grant silently had no effect. Reproduced on Windows,
but the underlying defect was platform-agnostic.

**Root cause:** the delivery path (`deliverConfigFile`) ran a remote `mkdir`
command and a remote write command via the strategy's `execCommand`, but
never inspected the returned exit code or stderr of either command, and never
read the file back to confirm the intended content actually landed. Any
failure along that path -- a nonzero exit code, a quoting fault that wrote
nothing, or a write that resolved against the wrong path -- was silently
discarded, and the caller unconditionally returned a success string and
updated the permissions ledger as if the grant had taken effect.

**Why the existing test suite didn't catch it:** the pre-existing test file
for this tool mocked the command-execution layer entirely and asserted only
on the *generated command string*, never on what a real write actually
produces. A write command that would fail against a real filesystem still
"looked correct" as a string, so the no-op shipped unnoticed.

**Fix shape (the durable pattern, not tied to any one call site):**
1. Treat "the write command executed" and "the write took effect" as two
   separate facts that both need checking. A nonzero exit code from either
   the directory-creation or the write command is a hard failure.
2. After writing, read the target file back and verify the *actual content*,
   not just the exit code -- an exit-code-only check still misses a write
   that "succeeds" against the wrong path or one that silently produces an
   empty file. For structured (JSON) content, parse and structurally compare
   against the intended merged document (key order must not matter); for
   opaque/string content (TOML, etc.), confirm the expected marker text is
   present in the read-back.
3. Surface any verification failure as an explicit, typed error at the point
   of delivery, and have every caller of the delivery function translate that
   into an explicit failure return -- never a success string -- and skip any
   side effect (like a ledger update) that implies the grant took effect.
4. A regression test for this class of bug must exercise the real,
   unmocked execution strategy against a scratch filesystem and assert on
   file content read from disk with the standard filesystem API -- not on the
   tool's return value and not against a mocked command executor. Mocking the
   executor is exactly what let the original bug ship, so the regression
   test's entire value is in refusing to do that.

**Known residual gap:** write-level verification (did the intended bytes
land on disk) is a different guarantee from CLI-level uptake (does the
consuming provider CLI actually read and honor that file once written -- see
the workspace-trust caveat elsewhere in this document, where a syntactically
correct settings file is present but ignored because the workspace isn't
trusted). Fixing the write-level no-op does not by itself guarantee the
CLI applies the grant; that remains a separate, already-tracked concern.
Verifying the Windows write path specifically also still depends on running
the actual PowerShell write command against a real filesystem on a Windows
host -- a POSIX-only test run can inspect that code path but cannot execute
it, and should say so explicitly rather than claim full coverage.

## Windows stall-poller: avoid intermediate `$variable` tokens in remote PowerShell one-liners

On at least one Windows member, the SSH execution path was observed to strip
bare `$name` tokens (e.g. a loop variable like `$i`) out of a command string
before a nested `powershell -c` invocation ever parsed it, turning an
otherwise-correct one-liner into a parse error on every invocation. This
broke an mtime-based liveness/staleness signal that polled a remote
directory or file for its most recent write time, on every poll, on that
class of member.

The durable fix is to write remote PowerShell one-liners used for this kind
of polling as a single pipeline with no intermediate variable assignment --
lean on the pipeline's own terminal stage (e.g. resolving straight through to
a formatting cmdlet) rather than capturing an intermediate result in a
`$variable` and referencing it in a later statement. A `Test-Path` (or
equivalent existence) guard ahead of the expensive part of the pipeline is
cheap and avoids running that part of the pipeline against a path that does
not exist yet -- both the guard and the pipeline's happy path stay
one-liners with no `$variable`.

**Trap to avoid when redesigning this kind of poll:** a pipeline stage that
enumerates a directory recursively can hang indefinitely when pointed at a
path that does not exist and errors are suppressed, rather than failing
fast -- this is easy to miss because the same stage against an existing-but-
empty directory returns instantly, so a quick manual check against a real
directory will not reveal the hang. Isolate each pipeline stage individually
(e.g. run each stage as its own job with a timeout) before trusting that a
suppressed-errors pipeline is safe to chain unconditionally against a path
whose existence you have not confirmed.

## Cross-shell member-bound command construction

See `docs/cross-shell-command-construction.md` for the full pattern. Short
version: never rely on shell-level variable expansion (`$HOME`, `$VAR`, `~`)
or POSIX-only utilities in a command string sent to a member -- the remote
shell may be PowerShell, not bash, and the two disagree on syntax and
sometimes silently corrupt bare `$name` tokens in transit. Resolve values
host-side in JS or branch explicitly on `agent.os`, and route any
Windows-bound PowerShell script through the shared `wrapPowerShellEncoded`
helper so encoding and exit-code semantics stay centralized rather than
reimplemented per call site.

## Root test gate must exercise every workspace's own test runner

A workspace that runs its tests via a different test runner than the root
(e.g. `node --test` alongside a root `vitest run`) is invisible to the root
test command unless that workspace's script is explicitly chained into it.
A green root test run is only a meaningful gate if it actually executes
every workspace's suite -- silently excluding one because it uses a
different runner lets regressions in that workspace pass CI unnoticed.
