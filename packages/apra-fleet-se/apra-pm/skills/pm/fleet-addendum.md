# Fleet Execution Addendum

This document covers features that apply ONLY when the pm skill runs in fleet
mode (dispatching to remote fleet members via execute_prompt). Fleet mode is an
integration with the separate apra-fleet product; apra-pm never requires it --
local subagent mode is the complete feature set, and the tools named here
(execute_prompt, compose_permissions, list_members, ...) exist only when
apra-fleet is installed. In local subagent
mode, everything here is skipped -- local subagents inherit the orchestrator's
permissions and context.

## Mode detection

At sprint start, detect the execution mode:

1. Probe for fleet MCP tools (fleet_status, list_members). If the tool is absent
   or returns no members, fall to local mode.
2. An explicit --local or --fleet flag from the user overrides the probe.
3. Default: if fleet members are available AND the task tier has a matching
   member, use fleet mode. Otherwise use local mode.

Record the mode in status.md at sprint init so recovery/resume uses the same
mode.

## Permissions

Compose and deliver permissions per the fleet skill permissions.md for each
member using tag-based selection: tags: ['doer'] for doer members, tags: ['reviewer']
for reviewer members. Recompose when switching tags (doer to reviewer or vice versa).
Each provider gets its native permission config -- compose_permissions handles the
format automatically.

Call compose_permissions before EVERY dispatch regardless of unattended mode.

### Unattended modes

- `update_member(unattended='auto')` -- safer auto-approval scoped to
  explicitly listed operations.
- `update_member(unattended='dangerous')` -- full permission bypass. Prefer
  auto over dangerous.
- Do NOT pass dangerously_skip_permissions to execute_prompt -- it is deprecated
  and ignored.

### Mid-sprint permission denial

If a member is blocked by a permission denial:

1. Call compose_permissions with `grant: [<denied permission>]` and
   project_folder.
2. This grants the missing permission, delivers the updated config, and appends
   to the ledger so future phases start with it included.
3. Resume the member with resume=true.
4. Never bypass by running the denied command yourself via execute_command.

Act on the grant promptly -- the inactivity timer fires on stdout silence. If
it fires while you are composing permissions, resume=true still succeeds via
stale-session auto-recovery, but the member restarts without its in-progress
context.

## stop_prompt

Use stop_prompt (a fleet MCP tool) when a member is working on the wrong thing,
stuck in a loop, or dispatched with incorrect instructions. Always follow
immediately with resume=false to start a clean session.

stop_prompt kills the member's LLM process. This is distinct from stopping a
background orchestration sub-task within the PM's own session.

## Doer-reviewer pairing (fleet mode)

1. Record pair in status.md. Multiple pairs per project is normal.
2. Override icons via update_member -- doer gets circle, reviewer gets square,
   same color.
3. Compose and deliver permissions for each member using tag-based selection:
   tags: ['doer'] for the doer, tags: ['reviewer'] for the reviewer.
4. Send the role-specific agent context file via send_files before dispatch.

## Agent context file delivery

Each fleet member needs a provider-specific agent context file in their
work_folder root. It is the member's persistent execution model and survives
across session resumes.

### Provider filename table

Use member_detail -> llmProvider to determine the target filename:

| Provider | Filename |
|----------|----------|
| Claude | CLAUDE.md |
| Antigravity (agy) | AGY.md |
| Gemini | GEMINI.md |
| Codex | AGENTS.md |
| Copilot | COPILOT.md |
| OpenCode | OPENCODE.md |

### Rules

- Pick the correct template based on role and filename based on provider.
- Fill in {{branch}} and {{base_branch}} with the sprint branch and base branch
  before delivering.
- Send to member via send_files to the member's work_folder root before dispatch.
- Never commit to git -- add the filename to the member's .gitignore.
- On role switch: send the new context file before dispatch.
- Remove before merge: use the cleanup procedure in sprint.md Completion.

## Secrets and credentials

Never pass raw secrets in execute_prompt prompts -- reference the credential by
name only (e.g. "authenticate using credential github_pat"). The member then
uses {{secure.github_pat}} in its own execute_command calls. The
{{secure.NAME}} token is substituted at launch time -- reference it bare in
execute_command, not inside your own quotes (it is already single-quote-escaped
by the fleet).

## Fleet call batching (R8)

When executing a sequence of fleet calls -- any combination of send_files,
execute_command, execute_prompt, receive_files -- club them into a single
background Agent rather than issuing individual calls or multiple background
agents. This reduces orchestrator turn overhead.
