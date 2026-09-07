# Troubleshooting

Common symptoms and how to resolve them. If something here does not match what
you see, search [GitHub Issues](https://github.com/Apra-Labs/apra-fleet/issues)
or ask in [Discussions](https://github.com/Apra-Labs/apra-fleet/discussions).

## Members

**Member shows as offline**

- Check the machine is reachable: `ping <ip>`.
- For remote members, verify SSH directly: `ssh user@host "echo ok"`.
- If SSH works but the member is still offline, re-provision auth: ask Fleet to
  "Provision auth for `<member>`".

**Empty response from a member**

Usually an expired auth token. Ask Fleet to "Provision auth for `<member>`".
For VCS tokens specifically, re-run `provision_vcs_auth`.

If it is the member's *first* dispatch after registration and the CLI exited
with code 0 and no output at all, suspect workspace trust rather than auth:
`execute_prompt` classifies an exit-0/empty-stdout dispatch against a
never-trusted workspace as `workspace_not_trusted`, seeds trust, and retries
once. See "Permission granted but still denied on Claude" below.

**`Claude CLI auth check failed -- you may need to run provision_llm_auth` during registration**

Normal for a new member. `register_member` still succeeds; run
`provision_llm_auth` for that member to finish setting up authentication.

Before provisioning: for the default OAuth flow, log in locally first (`/login`
in a Claude Code session, or `claude auth login`) -- `provision_llm_auth` copies
your credentials to the member. For the API-key flow, pass the key as the
`api_key` parameter. The tool checks token expiry before deploying; an expired
access token with a live refresh token still deploys, and the member's CLI
refreshes on first use.

**Auth error (401 / 403)**

- GitHub App tokens: re-mint with `provision_vcs_auth`.
- Bitbucket / Azure DevOps: the token likely expired -- get a fresh one, then
  re-provision and retry. See the `auth-*.md` references in the fleet skill.

**Member blew past a checkpoint**

Check what actually happened on the member:
ask Fleet to run `cat progress.json` on it.

**Long-running background task fails to launch on a Windows member**

`execute_command`'s `long_running` mode on Windows launches the task
detached via `Invoke-CimMethod Win32_Process.Create` (WMI). If this fails,
check that the WMI service (`Winmgmt`) is running on the member and that the
fleet SSH user has permission to create processes via WMI -- `monitor_task`
will otherwise report the task as immediately failed/missing rather than
running.

## Permissions

**Permission denied on a member**

Fleet can configure member permissions. Ask it to, for example, "Grant
`build-server` permission to run `npm install`". Under the hood this runs
`compose_permissions`, which writes provider-native config:

| Provider | Config location |
|----------|-----------------|
| Claude | `.claude/settings.local.json` |
| Codex | `.codex/config.toml` (approval mode) |
| Copilot | `.github/copilot/settings.local.json` |

**Permission granted but still denied on Claude**

Claude Code only honors `.claude/settings.local.json` permissions once the
project folder is a **trusted workspace**. If the member's work folder has
never been opened and trusted in Claude Code directly, the permissions Fleet
writes there are inert. Open the folder in Claude Code once and accept the
trust prompt, then retry.

**A deploy step is blocked at the permission pre-check even though similar commands are allowed**

Check the allowlist for the *exact* subcommand the deploy step invokes, not
just the binary name -- an allowlist entry scoped to one subcommand (e.g.
`Bash(<tool> start)`) does not cover a different subcommand of the same
binary (e.g. `Bash(<tool> run ...)`) even though both start the same
long-running process. Read the deploy runbook's own Permissions section for
the full list of required command prefixes and diff it against
`.claude/settings.json` / `.claude/settings.local.json` before assuming the
underlying operation itself is unsafe or needs a workaround -- add the
missing prefix and re-trigger.

## Timeouts

A dispatch can end in two distinct ways:

- **Inactivity timeout (`timeout_s`)** -- fires when no stdout/stderr output
  arrives for N seconds (default 300s / 5 min). It is transport-level, so it
  applies to every member and provider. The usual cause is a build or test
  runner that buffers output (`npm test`, `vitest`, `cargo build`) and stays
  silent for long stretches even while working. Fix: raise `timeout_s` to
  600-1200 for build/test dispatches.
- **Total timeout (`max_total_s`)** -- fires after N seconds of wall-clock time
  regardless of output. Use it as a hard ceiling on long jobs, alongside
  `timeout_s` when you want both a silence guard and a wall-clock cap.

## Credentials

**A token or password appeared in command output**

Store the secret with `credential_store_set`, then reference it as
`{{secure.NAME}}` in `execute_command`. Fleet redacts it to `[REDACTED:NAME]`
before the LLM ever sees the output. See
[docs/features/oob-auth.md](features/oob-auth.md).

**Rotate a credential without re-provisioning**

Run `credential_store_delete name=<NAME>` then `credential_store_set
name=<NAME>`. The new value is picked up immediately on the next
`execute_command` that references `{{secure.NAME}}`.

## Git

**Cannot push workflow files or merge PRs from a member**

Minted VCS tokens may lack CI/CD permissions. Run those operations from your
main AI coding session instead -- it has your full git credentials. See
[docs/design-git-auth.md](design-git-auth.md).

**`git push` from a Windows member hangs or fails silently with no auth prompt**

If the member's git config has `credential.helper=manager` (Git Credential
Manager), the helper tries to open an interactive prompt that cannot appear in
a headless session, so the push stalls or fails without a useful error. Use a
non-interactive credential source instead: `gh auth setup-git` (GitHub) or the
token minted by `provision_vcs_auth`, which writes a scoped credential entry
that needs no prompt.

**`bd init` errors "already initialized" on a second run**

`bd init` is not idempotent. Any script or playbook that bootstraps beads must
check for an existing `.beads/` directory (or `bd` reporting a database) before
calling it, rather than treating the error as a failure.

## Build & native dependencies

**`npm ci`/`npm install` fails compiling a native module (e.g. `better-sqlite3`) via `node-gyp`**

This is a toolchain/environment incompatibility, not a code defect -- do not
patch the deploy or build scripts to work around it. On macOS it shows up as
Xcode Command Line Tools' `libc++` headers rejecting newer C++20 constructs
(`concept`, `requires`, `output_iterator_tag`/`contiguous_iterator_tag`) that
the Node header set expects, once the Node major version and the installed
CLT/node-gyp versions drift out of the combination that was actually tested.
Resolve by aligning the toolchain, not the source tree: update Xcode Command
Line Tools (`xcode-select --install` / reinstall), or build against a Node
version known to match the installed CLT, or update `node-gyp` itself. Check
the npm debug log path printed in the failure output for the exact compiler
error before assuming this is the cause.

## Stuck agents

**A member is stuck after a session reset**

Escalate the model tier (cheap -> standard -> premium) and retry. If it is still
stuck, the task likely needs a human decision -- inspect `progress.json` and
intervene directly.

## Logs

For unexplained behavior -- missing output, silent failure, unexpected results
-- check the server logs:

```
$APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log
```

These are JSON lines. Filter by member or by tool with `jq`:

```bash
jq 'select(.member_id == "<uuid>")' fleet-<pid>.log
jq 'select(.tag == "<tool>")'       fleet-<pid>.log
```

The **Fleet Logs** section of the fleet skill's `SKILL.md` has the full field
reference and more `jq` examples.

## Contributor gotchas

Failure modes that look like success when working on this repo.

**A `scripts/` entrypoint guard never fires on Windows**

Comparing `import.meta.url` against a hand-built `"file://" + process.argv[1]`
string never matches
on Windows: `process.argv[1]` is a native path (`C:\path\to\s.mjs`), so the
hand-built string has two slashes after the scheme, while `import.meta.url` is
a properly encoded URL with three slashes and forward slashes throughout. The
comparison is always false, `main()` never runs, and the script exits 0 having
verified nothing -- indistinguishable from a real pass. Use
`pathToFileURL(process.argv[1]).href` instead. Coverage for this class of
defect must spawn the script as a real CLI process; an in-process `import()`
does not exercise the guard at all.

**`execFileSync('bd', [...])` fails with `spawnSync bd ENOENT` on Windows**

The globally installed `bd` resolves on PATH to npm's `bd.cmd`/`bd.ps1` shims,
which `CreateProcess` cannot exec directly. Adding `{ shell: true }` "fixes" it
but reintroduces command injection, since Node joins the command and every
array argument into one unquoted command line. The repo's shared helper
(`scripts/lib/exec-bd.mjs` and its supervisor twin) instead parses the shim for
the underlying `bin/bd.js` path and spawns
`execFileSync(process.execPath, [scriptPath, ...args])` -- no shell involved.
Route new `bd` call sites through that helper rather than reimplementing.

**A green root test run can still miss a whole workspace**

A workspace whose tests run under a different runner than the root (e.g.
`node --test` alongside a root `vitest run`) is invisible to the root test
command unless its script is explicitly chained in. Verify the root gate
actually executes every workspace's suite before treating it as a gate.

**When spawning an interactive CLI from Node, close stdin**

`child_process.exec()` leaves the child's stdin connected to the parent. A CLI
that checks for a TTY (such as `claude -p`) then waits forever for input that
never arrives. Call `child.stdin?.end()` immediately after the spawn.
