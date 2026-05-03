---
name: fleet
description: Fleet infrastructure mechanics — member management, permissions, onboarding, provider awareness, and tool usage patterns
---

# Fleet Skill

This skill defines how to interact with fleet infrastructure: registering and onboarding members, managing permissions, dispatching work, monitoring tasks, and handling provider-specific differences.

## Core Fleet Tools

| Tool | Purpose |
|------|---------|
| `register_member` | Add a new member to the fleet |
| `list_members` | List all fleet members and their status |
| `member_detail` | Get detailed info on a member (provider, OS, icon, etc.) |
| `update_member` | Update member metadata (icon, name, etc.) |
| `remove_member` | Remove a member from the fleet |
| `fleet_status` | Check member idle/busy state before dispatch |
| `execute_command` | Run shell commands on a member |
| `execute_prompt` | Dispatch a prompt to a member's LLM agent |
| `send_files` | Push files from local to a member's work folder |
| `receive_files` | Pull files from a member's work folder |
| `monitor_task` | Check status of a long-running background task on any member. The `auto_stop` parameter and GPU utilization polling are cloud-only features. |
| `compose_permissions` | Generate and deliver provider-native permission config |
| `provision_llm_auth` | Provision authentication for a member |
| `provision_vcs_auth` | Provision VCS credentials (GitHub, Bitbucket, Azure DevOps) |
| `revoke_vcs_auth` | Revoke VCS credentials |
| `setup_ssh_key` | Migrate remote member from password to key-based auth |
| `setup_git_app` | Configure GitHub App for token minting |
| `update_llm_cli` | Update the LLM CLI on a member |
| `cloud_control` | Manage cloud infrastructure for members |
| `shutdown_server` | Shut down a remote member's server |
| `credential_store_set` | Store a secret credential for use in commands (entered OOB — never in chat) |
| `credential_store_list` | List stored credential names (values are never returned) |
| `credential_store_delete` | Delete a stored credential by name |
| `credential_store_update` | Update credential metadata (members, TTL, network policy) without re-entering the secret |
| `stop_prompt` | Kill the active LLM process on a member. **Always call `TaskStop` after calling `stop_prompt`**.<br><br>**Use when:** a member is hung, working on the wrong thing, or needs to be cancelled. |

See sub-documents for detailed usage:
- `onboarding.md` — full 8-step member onboarding sequence
- `permissions.md` — permission composition and denial handling
- `profiles/` — stack permission profiles (base-dev, base-reviewer, node, python, go, etc.) — add new profiles here to support additional stacks or roles
- `troubleshooting.md` — fleet tool troubleshooting by symptom
- `skill-matrix.md` — skill installation matrix by project + VCS + role
- `auth-github.md`, `auth-bitbucket.md`, `auth-azdevops.md` — VCS auth provisioning per provider
- `beads.md` — Beads persistent task DB: commands, backlog ops, session recovery patterns

## Beads — Persistent Task Tracking

Beads (`bd` CLI) is installed automatically by `apra-fleet install`. It gives fleet users a persistent, dependency-aware task database that survives across sessions, branches, and members.

**Run `bd` via `Bash` on the orchestrator — never via `execute_command` on a member.**

### Session-Start Rule

**Always run `bd ready` at the start of any fleet session before reading status files.** It instantly shows all in-flight tasks across every project — no file reads required.

```bash
bd ready       # show all unblocked, unclaimed tasks (in-flight view)
bd ready --all # show ALL tasks including backlog
```

### Core Commands

```bash
bd init                             # init in current repo (once, idempotent)
bd create "title" -p <0-3>          # create task (0=critical, 1=high, 2=med, 3=low)
bd update <id> --claim              # mark in-progress (on dispatch)
bd update <id> --done               # mark complete (on verify/approval)
bd update <id> --note "PR: <url>"   # attach a note
bd dep add <child-id> <parent-id>   # child blocked until parent done
bd show <id> --tree                 # task + all dependencies
```

### Backlog Pattern

When a user says "add to backlog" or "defer this":
```bash
bd create "<description>" -p 3 --parent <epic-id>   # low priority, stays in backlog
```

When asked "what's deferred" or "show backlog":
```bash
bd ready --all   # or: bd show <epic-id> --tree
```

See `beads.md` for the full reference, workflow examples, and PM integration details.

## Secure Credentials

The `{{secure.NAME}}` pattern lets you reference stored secrets in any command without ever exposing plaintext to the LLM or logs.

**How it works:**
1. Store a secret with `credential_store_set` — Fleet opens an OOB terminal prompt, so the value never appears in chat
2. Reference it as `{{secure.NAME}}` anywhere in a command string passed to `execute_command`, `register_member`, `update_member`, `provision_vcs_auth`, or `provision_auth`
3. Fleet resolves the token server-side before execution; output containing the plaintext is redacted to `[REDACTED:NAME]` before results reach the LLM

**When to use:**
- Any API key, token, or password that a member needs in a shell command
- Rotating credentials: `credential_store_delete` then `credential_store_set` — no re-provisioning required
- Pre-loading secrets before a dispatch so members can authenticate in commands autonomously

> ⚠️ **`{{secure.NAME}}` only resolves in specific credential fields** (listed above).
> Using it in any other parameter (e.g. a prompt, a path field in a non-credential tool, or any other unsupported parameter) will pass the
> token string through literally — the secret will NOT be injected, and the raw handle name
> will be visible in logs. Only use `{{secure.NAME}}` in the fields documented above.

**Access control (scoping):** Credentials can be scoped to specific members.
- `members="*"` (default) — all members can access the credential
- `members="alice,bob"` — only those members can access it
- Scoping is enforced at resolve time — a member outside the allowed set receives an access-denied error
- **Updating scope or metadata:** Use `credential_store_update` to change `members`, `ttl_seconds`, or `network_policy` without re-entering the secret. Use `credential_store_set` again only if you need to change the secret value (triggers OOB re-entry).

**TTL (time-to-live):** Set `ttl_seconds` to auto-expire a credential. Expired credentials
are rejected at resolve time with a clear error (not silently empty).

Example: `credential_store_set  name=ci_token  ttl_seconds=3600`

**Network egress policy:** Attach a network policy to a credential to control outbound
network access for commands that use it:

| Policy | Behaviour |
|--------|-----------|
| `'allow'` (default) | No restriction |
| `'deny'` | Commands invoking network tools (curl, wget, ssh, git push, etc.) are blocked |
| `'confirm'` | OOB prompt before the network call is allowed |

## Member Identification

All tools accept `member_id` (UUID) or `member_name` (friendly name) to identify a member. `member_id` takes precedence when both are provided.

## Tool Boundaries

- **Local members:** ALWAYS use fleet tools (`execute_command`, `execute_prompt`, `send_files`, etc.) — never SSH directly or bypass fleet infrastructure
- Fleet tools are the canonical interface — all member interactions go through them

## Dispatch Rules

**Rule:** Shell commands (git, npm, bash scripts, file ops) → `execute_command`. LLM reasoning tasks (write code, review, plan, analyse) → `execute_prompt`. When in doubt: if a human could write the exact command string upfront, it's `execute_command`.

- **`execute_prompt`** — always wrap in a background Agent: `Agent(run_in_background=true)`. No exceptions.
- **`execute_command`** — any command that may take several seconds must be wrapped in a background Agent. Short reads (`cat`, `git status`, `echo`) can be called inline. Always use bash syntax — Git Bash is universally available on developer machines. Never use PowerShell or cmd.exe syntax, even on Windows members.
- **When clubbing fleet calls into a background Agent:** Always name the tool explicitly in the subagent prompt — write "use `execute_command` to run..." or "use `execute_prompt` to dispatch...". Never leave tool selection implicit.
- **`send_files` / `receive_files`** — transfers exceeding 1MB must use a background Agent.

**Concurrent dispatch guard:** Only one `execute_prompt` can be in-flight per member at a time (enforced server-side). A second concurrent dispatch returns immediately with:

```
❌ execute_prompt is already running for "<member-name>"
```

Use `stop_prompt` to cancel the in-flight session before re-dispatching.

## Pre-dispatch Checks

Before dispatching any work:
1. `fleet_status` — confirm member is idle (status must not be busy)
2. Member must have completed onboarding — see `onboarding.md`

Do not dispatch to a busy member. If busy, wait or re-check `member_detail`.

## File Transfer

Both `send_files` and `receive_files` are batch operations — always transfer all files in a single call, never one file per call.

- `send_files` — push any files to a member: context files, plans, scripts, binaries, configs, or any other content. Takes `local_paths` (array of local file paths) and optional `dest_subdir` (destination subdirectory relative to work_folder on member; defaults to work_folder root, equivalent to `"."`). Always try to batch multiple files in a single call.
- `receive_files` — pull files back: results, logs, build artifacts, updated configs, etc. Takes `remote_paths` (array of file paths on the member) and `local_dest_dir` (local directory to write files into). Always try to batch multiple files in a single call.

**Directories and globs:** `send_files` accepts individual file paths only — directories and glob patterns are not supported yet (see issue #98). To transfer an entire directory, tar it locally and extract on the member:

```
1. execute_command on local: tar -czf /tmp/src.tar.gz -C /path/to src/
2. send_files: local_paths=["/tmp/src.tar.gz"]
3. execute_command on member: tar -xzf src.tar.gz && rm src.tar.gz
```

**Cross-OS transfers:** Both `send_files` and `receive_files` must work bidirectionally for Linux↔Windows transfers (fleet host on Linux, member on Windows, and vice versa).

## Permissions

`compose_permissions` produces provider-native config automatically. See `permissions.md` for:
- How to compose and deliver permissions before dispatching work
- How to handle permission denials during execution
- How to recompose when switching roles

## execute_prompt Timeout Parameters

`execute_prompt` accepts two independent timeout parameters:

| Parameter | Semantics |
|-----------|-----------|
| `timeout_s` | **Inactivity timeout** — the session is killed only if no stdout/stderr output arrives for this many seconds. The timer resets on every output chunk. Active sessions (writing code, running tests, producing tokens) are never killed by this timer as long as output keeps flowing. Default: 300s (5 min). |
| `max_total_s` | **Hard ceiling** — the session is killed after this total elapsed time in seconds regardless of activity. Optional; defaults to unlimited. |

**When to use which:**

- Use `timeout_s` for normal dispatch. It extends the deadline automatically as long as the member is active, so you don't need to over-estimate how long a task takes.
- Use `max_total_s` only for tasks that must never run forever — CI pipelines, automated batch jobs, or any context where an unbounded runaway is unacceptable.
- Both timers run concurrently; whichever fires first kills the process.

## execute_prompt: Session Resume

The `resume` parameter controls whether a prior session is continued:

| Value | Behaviour |
|-------|-----------|
| `true` (default) | If a session ID is stored for this member, continues it. If none exists, starts fresh. |
| `false` | Always starts a fresh session — ignores any stored session ID. |

`resume` is boolean only. There is no way to target a specific session ID by value.
The tool always resumes the most recently stored session for that member.

**Automatic stale-session recovery:** If `resume=true` and the stored session has expired
or the provider returns an error, `execute_prompt` retries once automatically with a fresh
session. This recovery is transparent — no caller intervention required.

**Provider support:**

| Provider | Session resume | Notes |
|----------|---------------|-------|
| Claude | ✅ Full | `claude --resume <sessionId>` |
| Gemini | ✅ Full | Native session support |
| Codex | ⚠️ Partial | `resume` command supported |
| Copilot | ❌ None | Always starts fresh regardless of `resume` value |

Session IDs are parsed from `execute_prompt` output and stored server-side per member.
The output footer contains: `session: <sessionId>` when the provider supports it.

## Unattended Execution Modes

Configured via `register_member` or `update_member` with the `unattended` parameter:

| Mode | Behaviour |
|------|-----------|
| `false` (default) | Interactive — member prompts for permission approvals |
| `'auto'` | Trust the permissions config written by `compose_permissions` — auto-approves tools in the allow list |
| `'dangerous'` | Skip all permission checks globally, bypassing the allow list |

Per-provider flag behaviour:

| Provider | `'auto'` flag | `'dangerous'` flag |
|----------|--------------|-------------------|
| Claude | `--permission-mode auto` | `--dangerously-skip-permissions` |
| Gemini | None (config-file only via `compose_permissions`) | `--yolo` |
| Codex | `--ask-for-approval auto-edit` | `--sandbox danger-full-access --ask-for-approval never` |
| Copilot | ⚠️ Not supported — warns and runs interactively | ⚠️ Not supported |

Auto-approval is delivered via config files written by `compose_permissions` — call it before every dispatch.

**Prefer `auto` + `compose_permissions` over `dangerous`** — `auto` scopes approval to the
explicitly listed tools; `dangerous` bypasses all checks globally.

**Always call `compose_permissions` before dispatch regardless of unattended mode.**
The permissions config file must be delivered to the member's work folder before the CLI
starts — `compose_permissions` does this for all providers.

## Model Tiers

Use model tiers: `cheap` for execution (commands, status, tests, deploys), `standard` for construction (code, config, devops), `premium` for planning, review, design, and architecture. The server resolves tiers to the appropriate model for each provider. User override always wins. When in doubt, prefer cheaper.

Pass as `model: "cheap" | "standard" | "premium"` in `execute_prompt`.

## Member Icons

Icons are auto-assigned by the server and returned in `register_member` / `list_members` / `member_detail`. Prefix every member reference in output with their icon: `🔵 alice: building auth module`.

To override, use `update_member` with the icon parameter.

## Update Notices

`fleet_status` output may include a one-line update notice at the top when a newer release of apra-fleet is available:

```
ℹ️ apra-fleet v0.1.8 is available (installed: v0.1.7). Run `/pm deploy apra-fleet` to update.
```

When you see this notice, surface it to the user verbatim before the rest of the status output. Do not suppress or paraphrase it. In JSON format the notice appears as an `updateAvailable` object with `latest` and `installed` fields — surface it the same way.

## Provider Awareness

| Concern | How to handle |
|---------|---------------|
| **Agent context file** | Use `member_detail` → `llmProvider` to determine filename: CLAUDE.md (Claude), GEMINI.md (Gemini), AGENTS.md (Codex), COPILOT-INSTRUCTIONS.md (Copilot) |
| **Attribution config** | Claude-only (Step 2 in onboarding.md) — skip for all other providers |
| **Timeouts** | Gemini members are slower � use 2-3x timeout multiplier for `execute_prompt` dispatches to Gemini members. Minimum `timeout_s: 900` for any non-trivial task. |

## Fleet Logs

The fleet server writes structured JSONL logs to `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log`. Multiple fleet instances each have their own log file. **To find the correct log file for the server you are talking to, call `fleet_status` — it reports the exact log file path** (e.g. `logging: ~/.apra-fleet/data/logs/fleet-40064.log`). Never guess by listing the directory.

Use `jq` to read logs:

```bash
cat "$APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log" | jq '.'
```
