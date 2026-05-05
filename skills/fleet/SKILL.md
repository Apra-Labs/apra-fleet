---
name: fleet
description: Member management, permissions, onboarding, provider awareness, tool usage patterns
---

# Fleet Skill

Interact with fleet: register members, manage permissions, dispatch work, monitor tasks, handle provider differences.

## Core Tools

| Tool | Purpose |
|------|---------|
| `register_member` | Add member |
| `list_members` | List members + status |
| `member_detail` | Get provider, OS, icon, etc. |
| `update_member` | Update metadata |
| `remove_member` | Remove member |
| `fleet_status` | Check idle/busy state |
| `execute_command` | Run shell commands |
| `execute_prompt` | Dispatch prompt to LLM agent |
| `send_files` | Push files to member |
| `receive_files` | Pull files from member |
| `monitor_task` | Check background task. `auto_stop` + GPU poll cloud-only. |
| `compose_permissions` | Deliver provider permission config |
| `provision_llm_auth` | Provision auth |
| `provision_vcs_auth` | Provision VCS (GH/BB/Az) |
| `revoke_vcs_auth` | Revoke VCS |
| `setup_ssh_key` | Migrate password → key auth |
| `setup_git_app` | Config GitHub App |
| `update_llm_cli` | Update LLM CLI |
| `cloud_control` | Manage cloud infra |
| `shutdown_server` | Shutdown remote server |
| `credential_store_set` | Store secret (OOB entry) |
| `credential_store_list` | List credential names |
| `credential_store_delete` | Delete credential |
| `credential_store_update` | Update metadata without secret re-entry |
| `stop_prompt` | Kill LLM process. **Call `TaskStop` after**. |

Details:
- `onboarding.md`: 8-step sequence
- `permissions.md`: Composition + denial handling
- `profiles/`: Stack profiles (node, python, etc.)
- `troubleshooting.md`: Tool fixes
- `skill-matrix.md`: Install matrix
- `auth-github.md`, `auth-bitbucket.md`, `auth-azdevops.md`: VCS auth

## Secure Credentials

`{{secure.NAME}}` references secrets in commands without exposure.

**Mechanics:**
1. Store with `credential_store_set` (OOB prompt).
2. Use `{{secure.NAME}}` in `execute_command`, `register_member`, etc.
3. Fleet resolves server-side; output redacted to `[REDACTED:NAME]`.

**Usage:**
- API keys, tokens, passwords for shell.
- Rotate: delete + set (no re-provision).
- Pre-load secrets before dispatch.

> ⚠️ **Only resolves in specific fields.** unsupported params pass literal string (not injected, visible in logs).

**Access (Scoping):**
- `members="*"` (default): all access.
- `members="alice,bob"`: restricted.
- Scoping enforced at resolve.
- Update `members`, `ttl_seconds`, `network_policy` via `credential_store_update`.

**TTL:** `ttl_seconds` auto-expires. Resolve fails with error.

Example: `credential_store_set name=ci_token ttl_seconds=3600`

**Network egress policy:**

| Policy | Behaviour |
|--------|-----------|
| `'allow'` | Default |
| `'deny'` | Blocks curl, wget, ssh, git push, etc. |
| `'confirm'` | OOB prompt before call |

## Identification

Tools accept `member_id` (UUID) or `member_name`. `member_id` takes precedence.

## Boundaries

- Local members: ALWAYS use fleet tools. No direct SSH.
- Canonical interface: all interactions via tools.

## Dispatch Rules

Shell (git, npm, bash) → `execute_command`. LLM reasoning (code, review, plan) → `execute_prompt`. If human can write string → `execute_command`.

- **`execute_prompt`**: ALWAYS wrap in background Agent: `Agent(run_in_background=true)`.
- **`execute_command`**: Background Agent if >few seconds. Short reads (`cat`, `status`) inline. Use bash. Never PowerShell/cmd.
- **Clubbing calls**: Explicitly name tools in subagent prompt ("use `execute_command` to...").
- **File transfers**: Background Agent if >1MB.

**Guard**: One `execute_prompt` per member. Second returns error. Use `stop_prompt` to cancel.

## Pre-dispatch

1. `fleet_status`: confirm idle.
2. Ensure onboarding complete (`onboarding.md`).
Do not dispatch to busy member. Wait or check `member_detail`.

## File Transfer

Batch ops: transfer all files in one call.

- `send_files`: `local_paths` + `dest_subdir` (defaults `.`).
- `receive_files`: `remote_paths` + `local_dest_dir`.

**Dirs + Globs**: Indiv paths only. For dirs: tar locally, send, extract on member:
```
1. Local: tar -czf src.tar.gz -C /path/to src/
2. send_files: local_paths=["src.tar.gz"]
3. Member: tar -xzf src.tar.gz && rm src.tar.gz
```
**Cross-OS**: Bidirectional Linux↔Windows supported.

## Permissions

`compose_permissions` auto-produces native config. Delivered before dispatch.

## execute_prompt Timeouts

| Param | Semantics |
|-----------|-----------|
| `timeout_s` | **Inactivity**: timer resets on output. Default 300s. |
| `max_total_s` | **Hard ceiling**: killed after elapsed time. Optional. |

- `timeout_s` for normal dispatch.
- `max_total_s` for bounded jobs (CI).
- Whichever fires first kills process.

## execute_prompt: Resume

| Value | Behaviour |
|-------|-----------|
| `true` | Continue session ID if exists (default). |
| `false` | Fresh session. |

Resumes most recent session.

**Recovery**: If resume fails, retries once with fresh session automatically.

**Provider support**: Claude (Full), Gemini (Full), Codex (Partial), Copilot (None).

## Unattended Modes

`unattended` param in `register`/`update`:

| Mode | Behaviour |
|------|-----------|
| `false` | Interactive prompts (default) |
| `'auto'` | Trust permissions from `compose_permissions` |
| `'dangerous'` | Skip all checks (YOLO) |

**Prefer `auto` + `compose_permissions` over `dangerous`**. deliver config before CLI starts.

## Model Tiers

`cheap` (exec/tests), `standard` (code/devops), `premium` (plan/design). Server resolves to provider model. Pass as `model` in `execute_prompt`.

## Icons

Auto-assigned. Prefix member references with icon: `🔵 alice: building`. Override via `update_member`.

## Update Notices

`fleet_status` reports updates: `ℹ️ v0.1.8 available`. Surface to user verbatim. JSON: `updateAvailable` object.

## Provider Awareness

- **Context file**: Determine via `llmProvider` (CLAUDE.md, GEMINI.md, AGENTS.md, etc.).
- **Attribution**: Claude-only.
- **Timeouts**: Gemini slower → use 2-3x multiplier (min 900s).

## Logs

JSONL logs in `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log`. Call `fleet_status` to find exact path. Read with `jq`.
```bash
cat $(fleet_status path) | jq '.'
```
