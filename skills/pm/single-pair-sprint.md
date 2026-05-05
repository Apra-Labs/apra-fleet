# Running a Sprint

Lifecycle: `vision → requirements → design → plan → development → testing → deployment`.

## Phase 1 — Requirements

Write `<project>/requirements.md`. Include full issue text, locations, causes. Front-load risk in Task 1.

## Phase 2 — Plan Generation

**Branch naming**: clear purpose (`feat/<desc>`, `bug_fix/<desc>`). PM records as `{{branch}}` in context file.

1. `send_files` requirements.md to doer.
2. `execute_prompt` plan-prompt.md (background Agent).
3. Doer-reviewer loop (`doer-reviewer.md`) using `tpl-reviewer-plan.md`.
4. Approved? Save `planned.json` in `<project>/`. Proceed to Phase 3.

## Phase 3 — Execution

### Task Harness

Sent via `send_files`:
1. **Context file**: from `tpl-doer.md` (`context-file.md`).
2. **PLAN.md**: implementation plan.
3. **progress.json**: task tracker.
4. **Project docs**: requirements.md, design.md. Doer commits these.

### Dispatch Algorithm

PM reads `planned.json` + `progress.json`:
- `nextTask`: first pending task.
- `tier`: task tier.
- `resume`: `true` if `nextTask.phase === lastDispatchedPhase`.

Dispatch ONE task at `model: <tier>`. Update `lastDispatchedPhase` in `status.md`.

### Execution Loop

PM sends harness → dispatches doer → doer executes/commits/updates progress → hits VERIFY → STOPS → PM dispatches REVIEWER (premium) → reviewer commits verdict to feedback.md → pushes.
- APPROVED: next task.
- CHANGES NEEDED: PM sends feedback to doer → doer fixes → PM re-dispatches REVIEWER.

### Session Rules

| Condition | resume |
|-----------|--------|
| New phase | `false` |
| Same phase | `true` |
| Re-review after fixes | `true` |
| Role switch | `false` |

### Permissions

`compose_permissions` before execution/role switch.
**Denial**: call `compose_permissions` with `grant: [<permission>]` + `project_folder`. delivers config, appends to ledger. resume with `resume=true`.

### Monitoring

- `cat progress.json` + `git log`.
- Catch members blowing past VERIFY.
- Check drift: `git log <branch>..origin/main`. Rebase/retest if needed.
- Move MEDIUM/LOW findings to `<project>/backlog.md`.

### Safeguards

- Turn budget: session ends naturally.
- PM retry: 3x per dispatch then pause.
- Loop limit: 3 cycles per phase then pause.
- Model escalation: after 2 resets with zero progress: `cheap`→`standard`→`premium`.

## Phase 4 — Deployment

Run `<project>/deploy.md` via `execute_command`. Verification/rollback defined by user. failure? Rollback + flag user.

## Sprint Completion

1. **Docs Harvest**: Member extracts knowledge (architecture, decisions, API) from docs into `docs/`. Reviewer verifies. APPROVED? commit.
2. **PR**: cleanup.md.
3. **Backlog**: update unresolved items.
4. **Status**: mark complete, clear `lastDispatchedPhase`.

## Recovery After PM Restart

**Triage**: `fleet_status`.

Per member:
1. `cat progress.json` (doer only). Reviewer: check `feedback.md` log.
2. `git log` + `git status`.
3. Compare with `status.md`. Check `lastDispatchedPhase`.

Summary format:
| Member | PM last knew | Actual state | Delta | Action |
|--------|-------------|--------------|-------|--------|

**Auto-resume**: Review pending → dispatch reviewer; Clear next step → resume doer; No progress → re-dispatch.
**Escalate**: Uncommitted unknown changes; Conflicting state; Zero progress after re-dispatch.
