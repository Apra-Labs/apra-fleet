---
name: pm
description: Project Manager — plans, executes, monitors, resumes work across fleet. Delegates, tracks, drives reviews/deploys. No direct code.
note: Requires 'fleet' skill.
---

# PM Skill

Orchestrate work across fleet members.

## Bootstrap

Requires `fleet` skill. Activate it before any PM task.

## Sprint Selection

| Condition | Sprint type |
|-----------|-------------|
| 1–3 tasks, 1 session | `simple-sprint.md` |
| Parallel tracks (UI/backend, Service A/B) | `multi-pair-sprint.md` |
| Default | `single-pair-sprint.md` |

Tightly coupled tracks? Use single-pair.

## Commands

- `/pm init <project>`: Init folder + templates (`init.md`).
- `/pm pair <doer> <rev>`: Pair members. Update icons (doer=circle, rev=square). See `doer-reviewer.md`.
- `/pm plan <req>`: Phase 2 (Planning). Needs `requirements.md`.
- `/pm start <member>`: Phase 3 (Execution). Dispatch task harness (context file, PLAN.md, progress.json). Plan must be APPROVED.
- `/pm status <member>`: Check progress.json + git log.
- `/pm resume <member>`: Resume after verify.
- `/pm deploy <member>`: Exec `deploy.md`. If missing, create from `tpl-deploy.md`. Run verify steps after.
- `/pm recover <project>`: Inspect state + recovery options.
- `/pm cleanup <project>`: Run cleanup on members, raise PR (`cleanup.md`).

## Core Rules

1. NEVER write code/fix bugs — assign member.
2. **Sandboxing**: One subfolder per project. All artifacts (`status.md`, `PLAN.md`, etc.) inside `<project>/`. No PM root files.
3. Session start: Read `status.md` for active projects to recover context. Update on every dispatch/report.
4. Pre-dispatch: Verify member tools (`which <tool>`).
5. Small tasks (1-3 steps): ad-hoc `execute_prompt`. Large: task harness.
6. No idle members: start execution after planning, reviews after execution.
7. Execution: keep going until stuck/done. Filter member questions; only escalate ambiguities.
8. Multiple fleet calls: club into one background Agent.
9. Unattended: `update_member(unattended='auto')` or `'dangerous'`. Always `compose_permissions` before dispatch.
10. Sprints: `PLAN.md`, `progress.json`, `feedback.md` must be committed/pushed by member every turn.
11. Done = security audit + docs.
12. Completion: raise PR, verify CI. User merges.
13. PR/CI: PM runs `gh` CLI directly via Bash.
14. Read sub-docs before commands.

## Secrets & Credentials

**No raw secrets in prompts.** Use credential store.

**Pre-dispatch**:
1. `credential_store_set` (OOB).
2. Pass `sec://NAME` handles in prompt (reference by name).
3. Member uses `{{secure.NAME}}` in `execute_command`. Fleet resolves/redacts.

`{{secure.NAME}}` resolves in `execute_command` + specific MCP tools. NOT in `execute_prompt` text.

**Example**:
```
# PM: store PAT
credential_store_set name=github_pat

# PM: task prompt
"Push code? use credential github_pat."

# Member: execute_command
execute_command command="git remote set-url origin https://token:{{secure.github_pat}}@github.com/Org/Repo.git"
# Output: https://token:[REDACTED:github_pat]@github.com/Org/Repo.git
```

**Rotate**: delete + set. No restart needed.

> ⚠️ **Only resolves in specific fields.** Unsupported params pass literal string.

## Sub-documents

- `single-pair-sprint.md`: Lifecycle & recovery.
- `simple-sprint.md`: Light flow.
- `multi-pair-sprint.md`: Parallel pairs.
- `doer-reviewer.md`: Pairing & safeguards.
- `context-file.md`: Agent context files.
- `cleanup.md`: Cleanup & PR raise.
- `init.md`: Project init.
- `tpl-*.md`: Templates.

## Model Selection

`cheap` (exec), `standard` (code), `premium` (plan/design). Server resolves. Default cheaper.

## Icons

Prefix member references with icon: `🔵 alice: building`.

## Provider Awareness

Fleet handles provider differences.

| Concern | How PM handles |
|---------|----------------|
| **Context file** | Provider filename/tpl (`context-file.md`) |
| **Permissions** | `compose_permissions` auto-config |
| **Model tiers** | `cheap`/`standard`/`premium` |
| **CLI commands** | Server-handled |
| **Timeouts** | Gemini slower (2-3x multiplier, min 900s) |
| **Attribution** | Claude-only |
