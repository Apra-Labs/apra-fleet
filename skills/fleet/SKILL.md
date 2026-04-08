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

See sub-documents for detailed usage:
- `onboarding.md` — full 7-step member onboarding sequence
- `permissions.md` — permission composition and denial handling
- `profiles/` — stack permission profiles (base-dev, base-reviewer, node, python, go, etc.) — add new profiles here to support additional stacks or roles
- `troubleshooting.md` — fleet tool troubleshooting by symptom
- `skill-matrix.md` — skill installation matrix by project + VCS + role
- `auth-github.md`, `auth-bitbucket.md`, `auth-azdevops.md` — VCS auth provisioning per provider

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

- `send_files` — push any files to a member: context files, plans, scripts, binaries, configs, or any other content
- `receive_files` — pull files back: results, logs, build artifacts, updated configs, etc.
- `send_files` takes `local_paths` (array of local file paths) and optional `dest_subdir` (destination subdirectory relative to work_folder on member; defaults to work_folder root, equivalent to `"."`). Always try to batch multiple files in a single call.
- `receive_files` takes `remote_paths` (array of paths on the member) and `local_dest_dir` (local directory to write files into). Always try to batch multiple files in a single call.

## Permissions

`compose_permissions` produces provider-native config automatically. See `permissions.md` for:
- How to compose and deliver permissions before dispatching work
- How to handle permission denials during execution
- How to recompose when switching roles

## Model Tiers

Use model tiers: `cheap` for execution (commands, status, tests, deploys), `standard` for construction (code, config, devops), `premium` for planning, review, design, and architecture. The server resolves tiers to the appropriate model for each provider. User override always wins. When in doubt, prefer cheaper.

Pass as `model: "cheap" | "standard" | "premium"` in `execute_prompt`.

## Member Icons

Icons are auto-assigned by the server and returned in `register_member` / `list_members` / `member_detail`. Prefix every member reference in output with their icon: `🔵 alice: building auth module`.

To override, use `update_member` with the icon parameter.

## Provider Awareness

| Concern | How to handle |
|---------|---------------|
| **Agent context file** | Use `member_detail` → `llmProvider` to determine filename: CLAUDE.md (Claude), GEMINI.md (Gemini), AGENTS.md (Codex), COPILOT-INSTRUCTIONS.md (Copilot) |
| **Attribution config** | Claude-only (Step 2 in onboarding.md) — skip for all other providers |
| **Timeouts** | Gemini members are slower — use 2-3x timeout multiplier for `execute_prompt` dispatches to Gemini members |
