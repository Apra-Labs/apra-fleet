# Member host and CLI robustness

Design notes for three behaviours that keep a fleet working on members the
operator does not control: where the LLM CLI lives, hosts without a service
manager, and CLI refusals of shell loops during a sprint.

## LLM CLI resolution

A member's provider CLI (claude, codex, ...) is not always on the PATH of a
non-interactive command: nvm installs, user prefixes and login-shell-only
PATH entries are common. The resolver (`src/services/llm-cli-resolver.ts`)
therefore resolves the CLI **once**, stores the absolute path on the member
record (`Agent.llmCli`), and every CLI-invoking tool (`execute_prompt`,
`provision_llm_auth`, `update_llm_cli`) runs it by that quoted absolute path
with the path's directory prepended to PATH (POSIX) or via `& '<path>'`
(PowerShell). The prepend matters for CLIs with a `node` shebang.

Invariants:

- Probe order starts with the member's own default PATH (works without bash),
  then the login shell, then well-known install locations. A default-PATH hit
  therefore outranks the older fixed `~/.local/bin` prepend.
- Two distinct failures: CLI found nowhere is deterministic
  (`llm_cli_not_found`, listing every probed location and a fix); a probe that
  could not execute (connection drop, timeout) is `dispatch_failed`, which is
  transient and never clears the stored path.
- `update_member` clears the stored path when provider, host, user or shell
  changes, because the path is only valid for that tuple.
- Command construction stays OS/shell aware (see
  cross-shell-command-construction.md); nothing relies on hub-side shell
  expansion.

## Standalone member server

Hosts with no usable service manager (containers, WSL without systemd,
minimal distros) cannot register an auto-start. The member install does not
fail: it reports `MEMBER-STANDALONE`, and the fleet starts the member's
server itself (detached, with a pid file and log under the member's data
dir). Later probes restart it only when the failure looks like a down server,
and a server the user deliberately stopped is left stopped. When it cannot be
kept running the member reports `member-server-not-running` with the log tail
and a fix. Trade-off: this is best-effort, not supervision -- there is no
restart on reboot until the next probe. Operator-facing detail is in
install.md and troubleshooting.md.

`apra-fleet call` also passes its own version as the expected client
version, so member auto-start never fails with `AUTOSTART_VERSION_UNKNOWN`.

## Shell-loop refusals in sprints

Claude Code refuses `for`/`while` loops and other compound shell calls it
cannot statically check, even when each inner command is allowed. The
fleet-sprint engine handles this without granting loop prefixes:

1. **Judge by impact.** If the refused turn's reply is complete
   (`replyComplete`) and validates against the role's dispatch schema, it is
   accepted with a logged warning; otherwise the heal path runs.
2. **Split and nudge.** A refused compound call is parsed with a real shell
   parser (`unbash`, `fleet-sprint/shell-commands.mjs`). If every inner command
   is inside the member's composed policy, the same session is resumed with a
   "run each command separately" nudge (capped at two per dispatch ladder, not
   charged to the ladder). Unparseable or unmodelled syntax fails closed.
3. **Never grant loop prefixes.** `Bash(for:*)`, `while`, `until`, `do` and
   subshell grants are filtered (`isCompoundShellGrant`); granting them would
   widen the policy to arbitrary bodies.
4. **Prevent.** Every role prompt carries a no-shell-loops rule, enforced by a
   test that enumerates the prompts.

`unbash` ships in both the npm install and the single-executable binary
(the SEA config generator guards for it).

A canary (`scripts/claude-cli-loop-canary.mjs`, run from the regression
playbook) installs the latest Claude CLI in a throwaway prefix, forces one
loop dispatch, and checks the engine decision. It reports NOT RUN, never a
pass, when no credential is available. Its verdict logic is unit tested
against recorded CLI output so a CLI behaviour change shows up as a canary
failure rather than a mid-sprint abort.
