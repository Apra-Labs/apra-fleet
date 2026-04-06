---
name: fleet
description: Fleet infrastructure mechanics — member management, permissions, onboarding, provider awareness, tool usage patterns, and git-as-transport
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
| `provision_auth` | Provision authentication for a member |
| `provision_vcs_auth` | Provision VCS credentials (GitHub, Bitbucket, Azure DevOps) |
| `revoke_vcs_auth` | Revoke VCS credentials |
| `setup_ssh_key` | Migrate remote member from password to key-based auth |
| `setup_git_app` | Configure GitHub App for token minting |
| `update_task_tokens` | Accumulate token usage counts for a task |
| `update_llm_cli` | Update the LLM CLI on a member |
| `cloud_control` | Manage cloud infrastructure for members |
| `shutdown_server` | Shut down a remote member's server |

See sub-documents for detailed usage:
- `onboarding.md` — full 7-step member onboarding sequence
- `permissions.md` — permission composition and mid-sprint denial handling
- `troubleshooting.md` — fleet tool troubleshooting by symptom
- `skill-matrix.md` — skill installation matrix by project + VCS + role
- `auth-github.md`, `auth-bitbucket.md`, `auth-azdevops.md` — VCS auth provisioning per provider

## Tool Boundaries

- **Local members:** ALWAYS use fleet tools (`execute_command`, `execute_prompt`, `send_files`, etc.) — never SSH directly or bypass fleet infrastructure
- Fleet tools are the canonical interface — all member interactions go through them

## Dispatch Rules

`execute_prompt` and `execute_command` must never be called directly from the main conversation — always wrap them in a background Agent: `Agent(run_in_background=true)`. When making multiple sequential fleet operations, club them into a single background Agent rather than separate calls.

## Pre-dispatch Checks

Before dispatching any work:
1. `fleet_status` — confirm member is idle (status must not be busy)
2. Member must have completed onboarding — see `onboarding.md`

Do not dispatch to a busy member. If busy, wait or re-check `fleet_status`.

## Pre-flight Checks

### Before any dispatch
Verify member is on the correct branch with a clean working tree:
1. `execute_command → git status && git branch --show-current` — confirm clean tree and correct branch

Do not dispatch to a member on the wrong branch or with uncommitted changes.

### Before review dispatch
Verify reviewer is at the correct commit:
1. `execute_command → git rev-parse HEAD` on reviewer — must match doer's pushed HEAD SHA
2. If SHA doesn't match: `execute_command → git fetch origin && git reset --hard origin/<branch>` on reviewer, then re-verify

## Delivery Mechanics

To send documents to a member (requirements, design, context docs):
- `send_files` with member_id and list of `{local_path, remote_path}` objects
- Remote path is relative to the member's work_folder
- To receive results or updated files back: `receive_files` with member_id and file list

## Git as Transport

Git is the transport between members. The orchestrator manages the sync:

- **Push side:** `execute_command → git push origin <branch>` — verify push succeeded
- **Pull side:** `execute_command → git fetch origin && git checkout <branch> && git reset --hard origin/<branch>`

The member instruction file (CLAUDE.md / GEMINI.md / AGENTS.md / COPILOT.md) is NEVER committed — it is role-specific. Add it to `.gitignore` on the member:
- `execute_command → echo "<provider-file>" >> .gitignore` (use Provider Awareness lookup for the correct filename)

## Permissions

`compose_permissions` produces provider-native config automatically. See `permissions.md` for:
- How to compose and deliver permissions before a sprint
- How to handle mid-sprint permission denials
- How to recompose when switching roles

## Model Tiers

Use model tiers: `cheap` for execution (commands, status, tests, deploys), `standard` for construction (code, config, devops), `premium` for planning, review, design, and architecture. The server resolves tiers to provider-specific models via `modelTiers()`. User override always wins. When in doubt, prefer cheaper.

Pass as `model: "cheap" | "standard" | "premium"` in `execute_prompt`.

## Member Icons

Icons are auto-assigned by the server and returned in `register_member` / `list_members` / `member_detail`. Prefix every member reference in output with their icon: `🔵 alice: building auth module`.

To override, use `update_member` with the icon parameter.

## Provider Awareness

Fleet members run different LLM providers (Claude, Gemini, Codex, Copilot). All provider differences are handled by the fleet server — never construct CLI commands or read raw config formats directly.

| Concern | How to handle |
|---------|---------------|
| **Instruction file name** | Use `member_detail` → `llmProvider` to determine filename: CLAUDE.md (Claude), GEMINI.md (Gemini), AGENTS.md (Codex), COPILOT.md (Copilot) |
| **Permissions** | `compose_permissions` produces provider-native config automatically — call it with role + member |
| **Model tiers** | Use `cheap`/`standard`/`premium` — server resolves to provider-specific models via `modelTiers()` |
| **CLI commands** | Handled by `ProviderAdapter` — never construct provider CLI strings directly |
| **Attribution config** | Claude-only (Step 2 in onboarding.md) — skip for all other providers |
| **Timeouts** | Gemini members are slower — use 2-3x timeout multiplier for `execute_prompt` dispatches to Gemini members |
