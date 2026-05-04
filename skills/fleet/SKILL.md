---
name: fleet
description: Fleet infra: members, perms, onboarding, providers, tools
---

# Fleet Skill

Fleet mgmt: register, perms, dispatch, monitor, diffs.

## Commands

- /fleet onboard <member>: Execute 8-step onboarding.md sequence.

## Tools

| Tool | Purpose |
|------|--------|
| register_member | Add member |
| list_members | List members |
| member_detail | Detail info |
| update_member | Update meta |
| remove_member | Remove |
| fleet_status | Status |
| execute_command | Shell |
| execute_prompt | Prompt |
| send_files | Push |
| receive_files | Pull |
| monitor_task | BG task. auto_stop+GPU=cloud |
| compose_permissions | Perms |
| provision_llm_auth | Auth LLM |
| provision_vcs_auth | Auth VCS |
| revoke_vcs_auth | Revoke VCS |
| setup_ssh_key | SSH key |
| setup_git_app | Git App |
| update_llm_cli | Update CLI |
| cloud_control | Cloud |
| shutdown_server | Stop srv |
| credential_store_set | Store sec |
| credential_store_list | List sec |
| credential_store_delete | Del sec |
| credential_store_update | Upd sec |
| stop_prompt | Kill prompt. **TaskStop after** |

Docs: onboarding.md, permissions.md, profiles/, troubleshooting.md, skill-matrix.md, auth-*.md.

## Credentials

{{secure.NAME}} ref secrets.

**Flow:**
1. Store: credential_store_set.
2. Ref: {{secure.NAME}} in execute_command, register_member, update_member, provision_vcs_auth, provision_auth.
3. Resolve: Server-side. Redacted.

**Use:** API keys, tokens, passwords. Rotate: delete → set.

> ⚠ **Resolve specific fields only**. Else literal → leak risk.

**Access:** members="*" (all) or "alice,bob" (restricted).

**TTL:** ttl_seconds expire.

**Policy:** allow (default), deny (block net), confirm (prompt).

## Member ID
Use member_id (UUID) or member_name.

## Tool Boundaries
**Local:** ALWAYS use fleet tools. NEVER SSH directly or bypass.

## Dispatch
- Shell → execute_command.
- LLM → execute_prompt.
- Human write? → execute_command.

- execute_prompt: wrap in Agent(run_in_background=true).
- execute_command: wrap bg Agent if > 30s.
- Use bash (NEVER PowerShell/cmd). Background agent: MUST explicitly name tool.
- send_files/receive_files: > 1MB → bg Agent.

**Guard:** One execute_prompt per member. stop_prompt to cancel.

## Pre-dispatch
1. fleet_status: idle check.
2. Onboarding complete.

## File Transfer
Batch ops. NEVER transfer one file per call.

- send_files: push. local_paths, dest_subdir.
- receive_files: pull. remote_paths, local_dest_dir.

**Dirs:** Individual files. Dirs: tar → push → extract.
**OS:** Linux↔Windows.

## Permissions
compose_permissions before dispatch. Denial? grant.

## Timeouts
- timeout_s: Inactivity. Default 300s.
- max_total_s: Ceiling.

## Session Resume
resume=true (default).

| Provider | Resume |
|----------|--------|
| Claude | Full |
| Gemini | Full |
| Codex | Partial |
| Copilot | None |

## Unattended:
- false: Interactive.
- auto: Trust perms.
- dangerous: Skip checks.

## Model Tiers
cheap (exec), standard (construct), premium (plan).

## Provider Awareness
- member_detail → llmProvider → file (CLAUDE.md, etc.).
- Attribution: Claude-only.
- Gemini slow: 2-3x timeout. Min 900s.

## Logs
APRE_FLEET_DATA_DIR/logs/. jq to read.