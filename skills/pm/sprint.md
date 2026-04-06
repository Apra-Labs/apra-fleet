# Running a Sprint

A sprint is a focused unit of work executed by a doer/reviewer pair against a codebase. This document covers the full lifecycle from initiation to merge.

## Lifecycle

```
vision → requirements → design → plan → development → testing → deployment
```

PM drives work through these phases in order. Don't skip, don't stall between them.

---

## Phase 1 — Requirements

Write `<project>/requirements.md`. Quality bar:
- Include full issue details — code locations, root causes, impact data
- Never summarize into 2-3 line descriptions — include full issue text, code locations, root causes
- Front-load risk — the riskiest assumption must be validated in Task 1 of the plan

---

## Phase 2 — Plan Generation

1. Send `requirements.md` to doer via `send_files`
2. Dispatch `plan-prompt.md` via `execute_prompt` (wrapped in background Agent)
3. Run doer-reviewer loop (see `doer-reviewer.md`) using `tpl-reviewer-plan.md` for the reviewer
4. Iterate until plan passes quality criteria
5. Once APPROVED: save `planned.json` in `<project>/` — this is the immutable original, never modify it
6. Proceed to Phase 3

---

## Phase 3 — Execution

### Task Harness

Send three files to the doer's `work_folder` root via `send_files`:

1. **Agent context file** — from `tpl-doer.md`. See `context-file.md` for filename and delivery rules.
2. **PLAN.md** — implementation plan with phases and tasks
3. **progress.json** — task tracker (generated from PLAN.md per `tpl-progress.json`)

`progress.json` is the living state. Always query it for current status.

### Execution Loop

```
PM sends task harness → kicks off doer (resume=false — fresh session per phase)
  → doer reads progress.json → executes next pending task → commits → updates progress.json
  → hits VERIFY checkpoint → STOPS → PM reads progress.json
  → PM dispatches REVIEWER → reviewer reads deliverables + diff → commits verdict to feedback.md → pushes
  → APPROVED: PM resumes doer (resume=true within a phase) → repeat
  → CHANGES NEEDED: PM sends feedback to doer → doer fixes → PM re-dispatches REVIEWER → repeat
  → all tasks done → move to next phase or completion
```

### Session Rules

| Dispatch | resume |
|----------|--------|
| Start of new phase | `false` |
| Within a phase | `true` |
| Initial review dispatch | `false` |
| Re-review after fixes | `true` |
| Role switch (doer↔reviewer) | `false` |

### Permissions

Before kicking off execution, compose and deliver permissions for each member's role (see the fleet skill, `permissions.md`). Recompose on every role switch.

### Monitoring

- Check progress: `execute_command → cat progress.json`
- Check git: `execute_command → git log --oneline -10`
- Members may blow past VERIFY checkpoints if context gets large — dispatch a review immediately when caught
- Long-running branches: check drift with `git log <branch>..origin/main --oneline`. If main moved, instruct rebase + retest

### Safeguards

| Safeguard | Trigger | PM Action | Limit |
|-----------|---------|-----------|-------|
| Max-turns budget | Every dispatch | Session ends naturally at turn limit | Set per dispatch in `execute_prompt` |
| PM retry limit | Same dispatch fails (error, no output) | Retry up to 3×, then pause + flag user | 3 retries per dispatch |
| Doer-reviewer cycle limit | Reviewer returns CHANGES NEEDED | Re-dispatch doer with feedback; if 3 cycles don't resolve all HIGH items, pause + flag user | 3 cycles per phase |
| Model escalation | Zero progress after resets | Reset and resume; after 2 resets with zero progress: escalate model (`cheap`→`standard`→`premium`). Still zero? Flag user | 2 resets per model tier |

---

## Phase 4 — Deployment

Run `<project>/deploy.md` steps on the member via `execute_command`, then verify the deployment succeeded. See `/pm deploy`.

---

## Sprint Completion

When all phases are APPROVED:

1. **Cleanup** — remove fleet control files from doer and reviewer:
   ```
   execute_command: git rm PLAN.md progress.json feedback.md 2>/dev/null; rm -f CLAUDE.md GEMINI.md AGENTS.md COPILOT-INSTRUCTIONS.md; git commit -m "cleanup: remove fleet control files" && git push
   ```
   Run on both doer and reviewer.

2. **Merge** — PM runs `gh pr merge` directly (never delegate to fleet members). CI must be green and reviewer APPROVED verdict must exist. No exceptions.

3. **Update status.md** — mark sprint complete, record member states.

---

## Recovery After PM Restart

When the PM session ends unexpectedly, remote agent CLI processes are killed (SSH channel close → SIGHUP). Partial work may be uncommitted.

For each member in the project:
1. `execute_command → cat progress.json` — what tasks are completed/pending/blocked?
2. `execute_command → git log --oneline -5` — any commits since last known state?
3. `execute_command → git status` — uncommitted changes?
4. Compare against local `<project>/status.md` — what did PM last know?

Present findings to user with options:
- **Completed checkpoint:** "member finished phase 2, needs review. Trigger reviewer?"
- **Mid-task with commits:** "member committed task 3 but didn't reach checkpoint. Resume?"
- **Uncommitted changes:** "member has uncommitted work. Commit and resume, or discard?"
- **No progress:** "member unchanged since last known state. Re-dispatch?"

User picks, PM executes.
