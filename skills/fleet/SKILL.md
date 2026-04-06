---
name: fleet
description: Fleet infrastructure mechanics — member management, permissions, onboarding, provider awareness, tool usage patterns, and git-as-transport
---

# Fleet Skill

This skill defines how to interact with fleet infrastructure: registering and onboarding members, managing permissions, dispatching work, monitoring tasks, and handling provider-specific differences.

## Cross-Skill Reference Mechanism

Claude Code resolves skill references by matching the `name` field in skill frontmatter to natural language prose. The pattern `"See the fleet skill"` or `"follow the fleet skill"` is resolved by the skill loader at runtime — the same mechanism used in `tpl-claude-pm.md` ("follow the pm skill").

**If cross-skill prose references do not load automatically:** use explicit file-path references (`See skills/fleet/SKILL.md`) as fallback. The content is identical; only the resolution path differs.

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
| `send_files` | Push files from PM to a member's work folder |
| `receive_files` | Pull files from a member's work folder to PM |
| `monitor_task` | Monitor a running task's output |
| `compose_permissions` | Generate and deliver provider-native permission config |
| `provision_auth` | Provision authentication for a member |
| `provision_vcs_auth` | Provision VCS credentials (GitHub, Bitbucket, Azure DevOps) |
| `revoke_vcs_auth` | Revoke VCS credentials |
| `setup_ssh_key` | Migrate remote member from password to key-based auth |
| `setup_git_app` | Configure GitHub App for token minting |
| `update_task_tokens` | Record token usage from dispatches into progress.json |
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
- **PM uses `gh` CLI directly** via Bash for GitHub operations (PRs, issues, CI checks) — never delegate these to fleet members
- Fleet tools are the canonical interface — all member interactions go through them

## Dispatch Rules

All fleet operations run as background subagents using `execute_prompt` with `run_in_background=true`. This keeps PM responsive while members work. Never block on a dispatch — always fire and monitor.

## Pre-dispatch Checks

Before dispatching any work:
1. `fleet_status` — confirm member is idle (status must not be busy)
2. Member must have completed onboarding — see `onboarding.md`

Do not dispatch to a busy member. If busy, wait or check `monitor_task` to understand the current task's state.

## Pre-flight Checks

### Before any dispatch
Verify member is on the correct branch with a clean working tree:
1. `execute_command → git status && git branch --show-current` — confirm clean tree and correct branch

Do not dispatch to a member on the wrong branch or with uncommitted changes.

### Before review dispatch
Verify reviewer is at the correct commit:
1. `execute_command → git rev-parse HEAD` on reviewer — must match doer's pushed HEAD SHA
2. If SHA doesn't match: `execute_command → git fetch origin && git reset --hard origin/<branch>` on reviewer, then re-verify

## Task Harness Delivery

Generate three files and send to the member's `work_folder` root via `send_files`:
1. `PLAN.md` — task breakdown with all tasks, types, and acceptance criteria
2. `progress.json` — task state tracker (use `tpl-progress.json` as template)
3. The member's instruction file (`CLAUDE.md` / `GEMINI.md` / `AGENTS.md` / `COPILOT.md`) — see Provider Awareness for filename lookup

Call `send_files` with the `member_id` and a list of file objects (each with `local_path` and `remote_path`). The instruction file must be sent before any `execute_prompt` dispatch — it persists across session resumes.

## Delivery Mechanics

To send documents to a member (requirements, design, context docs):
- `send_files` with member_id and list of `{local_path, remote_path}` objects
- Remote path is relative to the member's work_folder
- To receive results or updated files back: `receive_files` with member_id and file list

## Monitoring

Check a member's progress:
1. `execute_command → cat progress.json` — current task states (completed/pending/blocked)
2. `execute_command → git log --oneline -5` — recent commits
3. `execute_command → git status` — uncommitted changes
4. `monitor_task` with task_id from `execute_prompt` response — live output of a running task

Use these after every dispatch to confirm progress before escalating.

## Recovery Commands

For each member after PM restart:
1. `execute_command → cat progress.json` — what tasks are completed/pending/blocked?
2. `execute_command → git log --oneline -5` — any commits since last known state?
3. `execute_command → git status` — uncommitted changes?

## Token Tracking

After every `execute_prompt` response (doer or reviewer), extract token counts and call `update_task_tokens`:

1. **Parse the token line** from the response using regex `Tokens: input=(\d+) output=(\d+)` — appears at the end of output when Claude provider returns usage data
2. **Call `update_task_tokens`** with:
   - `member_id` — the member that owns progress.json
   - `progress_json` — absolute path to progress.json on that member
   - `task_id` — the current task ID (e.g. `"3"`)
   - `role` — `"doer"` for doer dispatches, `"reviewer"` for reviewer dispatches
   - `input_tokens` — captured from regex group 1
   - `output_tokens` — captured from regex group 2
3. The tool accumulates tokens across calls — reviewer tokens from multiple review cycles are summed automatically. Never call with zeroes unless that is the actual count.
4. If the token line is absent (non-Claude provider or older CLI), skip the call for that dispatch only.

Call this after every dispatch — no exceptions.

## Git as Transport

Git is the transport between doer and reviewer. PM manages the sync:

- **Dev side (push):** `execute_command → git push origin <branch>` — verify push succeeded
- **Rev side (pull):** `execute_command → git fetch origin && git checkout <branch> && git reset --hard origin/<branch>`

The member instruction file (CLAUDE.md / GEMINI.md / AGENTS.md / COPILOT.md) is NEVER committed — it is role-specific. Add it to `.gitignore` on the member:
- `execute_command → echo "<provider-file>" >> .gitignore` (use Provider Awareness lookup for the correct filename)

## Cleanup Commands

Before merging a PR, remove fleet control files from both doer and reviewer. On each member:

```
execute_command: git rm PLAN.md progress.json feedback.md 2>/dev/null; rm -f CLAUDE.md GEMINI.md AGENTS.md COPILOT.md; git commit -m "cleanup: remove fleet control files" && git push
```

These are transport files — git history preserves the content.

## Permissions

`compose_permissions` produces provider-native config automatically. See `permissions.md` for:
- How to compose and deliver permissions before a sprint
- How to handle mid-sprint permission denials
- How to recompose when switching roles (doer↔reviewer)

## Model Tiers

Use model tiers: `cheap` for execution (commands, status, tests, deploys), `standard` for construction (code, config, devops), `premium` for planning, review, design, and architecture. The server resolves tiers to provider-specific models via `modelTiers()`. User override always wins. When in doubt, prefer cheaper.

Pass as `model: "cheap" | "standard" | "premium"` in `execute_prompt`.

## Member Icons

Icons are auto-assigned by the server and returned in `register_member` / `list_members` / `member_detail`. Prefix every member reference in output with their icon: `🔵 alice: building auth module`.

To override (e.g., for doer/reviewer pairing convention):
- Use `update_member` with the icon parameter
- Doer convention: circle emoji (🔵, 🟢, 🟡, etc.)
- Reviewer convention: square emoji (🟦, 🟩, 🟨, etc.), same color as doer

## Provider Awareness

PM manages members running different LLM providers (Claude, Gemini, Codex, Copilot). All provider differences are handled by the fleet server — PM never constructs CLI commands or reads raw config formats.

| Concern | How PM handles it |
|---------|-------------------|
| **Instruction file name** | Use `member_detail` → `llmProvider` to determine filename: CLAUDE.md (Claude), GEMINI.md (Gemini), AGENTS.md (Codex), COPILOT.md (Copilot) |
| **Permissions** | `compose_permissions` produces provider-native config automatically — PM just calls it with role + member |
| **Model tiers** | Use `cheap`/`standard`/`premium` — server resolves to provider-specific models via `modelTiers()` |
| **CLI commands** | Handled by `ProviderAdapter` — PM never constructs provider CLI strings directly |
| **Attribution config** | Claude-only (Step 2 in onboarding.md) — skip for all other providers |
| **PM itself** | PM runs on the configured fleet provider — its instructions and templates are adapted per provider |
| **Timeouts** | Gemini members are slower — use 2-3x timeout multiplier for `execute_prompt` dispatches to Gemini members |
