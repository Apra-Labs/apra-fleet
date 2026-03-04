# Plan Corrections — Apply Before Starting Execution

## Correction 1: Expand Task 18 Scope

Task 18 ("Update skills/pmo/SKILL.md with onboarding section") needs these additional subtasks added to PLAN.md:

- 18a: Fix the truncated model selection table (last row got cut off mid-sentence at "use")
- 18b: Add per-agent default paragraph and override logic paragraph that were missing
- 18c: Replace the credential management section (lines 76-81 referencing `provision_git_auth`/`revoke_git_auth`) with a new **Reactive Auth Pattern** section:

```
## Reactive Auth Pattern
When any VCS operation fails with an auth error (401/403, permission denied):
1. Detect the failure
2. For GitHub App — re-mint automatically via provision_vcs_auth, no user needed
3. For Bitbucket/Azure DevOps — ask user to provide a fresh token, then deploy
4. Retry the failed operation

Credentials are provisioned when needed and revoked when the user asks or when a project wraps up. No proactive token management or cleanup scheduling.
```

- 18d: Remove the line `Read [learnings.md](learnings.md) for the full pattern library.` — learnings.md is the user's personal notes file, NOT a skill dependency. Do not reference it from SKILL.md.
- 18e: Remove `skills/pmo/learnings.md` from the skill package entirely.
- 18f: Update `/pmo deploy` command description from "Pull, build, and restart" to "Download release artifact, run install.sh"
- 18g: Add a **Two-Context Design Review Loop** section to SKILL.md:

```
## Two-Context Design Review Loop
For design docs and architecture decisions, use the PMO + fleet agent review loop:
1. PMO brainstorms with user — captures intent, constraints, decisions
2. Fleet agent generates artifact — has codebase context
3. PMO reviews output — catches gaps against brainstorm
4. Fleet agent revises — incorporates corrections
5. Repeat until converged

PMO context holds the *what* (user intent). Agent context holds the *where* (codebase). Neither alone produces the right output.
```

## Correction 2: Fix Task 19 Hook Location

In Task 19 (PostToolUse hook), the hook source file should be at `hooks/post-register-agent.sh` in the repo (not `.claude/hooks/`). The `install.sh` (Task 22) copies it to the user's `~/.claude/settings.json` hook config during installation. Update PLAN.md accordingly.

## Correction 3: Add progress.json entries

If any of these corrections create new work items, add them to progress.json as pending tasks in the appropriate phase.

## After Corrections — Execute

After applying corrections:
1. Read progress.json to find the first pending task
2. Read PLAN.md for task details
3. Execute the task
4. Commit with a descriptive message
5. Update progress.json
6. Continue to the next task
7. STOP at verify checkpoint V1 (after Phase 1 tasks 1, 2, 3)
