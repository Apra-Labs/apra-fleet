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
| `monitor_task` | Check status of a long-running background command on a cloud member (cloud members only) |
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
| `stop_prompt` | Stop the active execute_prompt session on a member — kills the LLM process and sets a stopped flag to prevent re-dispatch |

See sub-documents for detailed usage:
- `onboarding.md` — full 8-step member onboarding sequence
- `permissions.md` — permission composition and denial handling
- `profiles/` — stack permission profiles (base-dev, base-reviewer, node, python, go, etc.) — add new profiles here to support additional stacks or roles
- `troubleshooting.md` — fleet tool troubleshooting by symptom
- `skill-matrix.md` — skill installation matrix by project + VCS + role
- `auth-github.md`, `auth-bitbucket.md`, `auth-azdevops.md` — VCS auth provisioning per provider

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

## Member Identification

All tools accept `member_id` (UUID) or `member_name` (friendly name) to identify a member. `member_id` takes precedence when both are provided.

## Tool Boundaries

- **Local members:** ALWAYS use fleet tools (`execute_command`, `execute_prompt`, `send_files`, etc.) — never SSH directly or bypass fleet infrastructure
- Fleet tools are the canonical interface — all member interactions go through them

## Dispatch Rules

- **`execute_prompt`** — always wrap in a background Agent: `Agent(run_in_background=true)`. No exceptions.
- **`execute_command`** — any command that may take several seconds must be wrapped in a background Agent. Short reads (`cat`, `git status`, `echo`) can be called inline. Always use bash syntax — Git Bash is universally available on developer machines. Never use PowerShell or cmd.exe syntax, even on Windows members.
- **`send_files` / `receive_files`** — transfers exceeding 1MB must use a background Agent.

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

## Permissions

`compose_permissions` produces provider-native config automatically. See `permissions.md` for:
- How to compose and deliver permissions before dispatching work
- How to handle permission denials during execution
- How to recompose when switching roles

## execute_prompt Timeout Parameters

`execute_prompt` accepts two independent timeout parameters:

| Parameter | Semantics |
|-----------|-----------|
| `timeout_ms` | **Inactivity timeout** — the session is killed only if no stdout/stderr output arrives for this many ms. The timer resets on every output chunk. Active sessions (writing code, running tests, producing tokens) are never killed by this timer as long as output keeps flowing. Default: 300 000 ms (5 min). |
| `max_total_ms` | **Hard ceiling** — the session is killed after this total elapsed time regardless of activity. Optional; defaults to unlimited. |

**When to use which:**

- Use `timeout_ms` for normal dispatch. It extends the deadline automatically as long as the member is active, so you don't need to over-estimate how long a task takes.
- Use `max_total_ms` only for tasks that must never run forever — CI pipelines, automated batch jobs, or any context where an unbounded runaway is unacceptable.
- Both timers run concurrently; whichever fires first kills the process.

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
| **Timeouts** | Gemini members are slower — use 2-3x timeout multiplier for `execute_prompt` dispatches to Gemini members |
