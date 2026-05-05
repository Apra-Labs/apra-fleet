# Running a Sprint

A sprint is a focused unit of work executed by a doer/reviewer pair against a codebase. This document covers the full lifecycle from initiation to merge.

## Lifecycle

```
vision → requirements → design → plan → development → testing → deployment
```

The PM drives work through these phases in order. Do not skip phases or stall between them.

---

## Phase 1 — Requirements

Create `<project>/requirements.md`. Quality criteria:
- Include full issue details such as code locations, root causes, and impact data.
- Do not summarize into short descriptions; include full issue text, code locations, and root causes.
- Front-load risk by ensuring the riskiest assumption is validated in Task 1 of the plan.

---

## Phase 2 — Plan Generation

**Branch naming:** Choose a name that makes the purpose of the branch clear, such as `sprint/<description>`, `feat/<description>`, or `bug_fix/<short_description>`. The PM records this as `{{branch}}` in the agent context file before dispatch.

1. Send `requirements.md` to the doer via `send_files`.
2. Dispatch `plan-prompt.md` via `execute_prompt` wrapped in a background Agent.
3. Run the doer-reviewer loop (see `doer-reviewer.md`) using `tpl-reviewer-plan.md` for the reviewer.
4. Iterate until the plan passes quality criteria.
5. Once APPROVED: save `planned.json` in `<project>/`. This is the immutable original; do not modify it.
6. Proceed to Phase 3.

---

## Phase 3 — Execution

### Task Harness

The task harness is the set of files sent to the doer's `work_folder` root via `send_files` to bootstrap execution:

1. **Agent context file** — from `tpl-doer.md`. See `context-file.md` for filename and delivery rules.
2. **PLAN.md** — the implementation plan with phases and tasks.
3. **progress.json** — the task tracker generated from PLAN.md per `tpl-progress.json`.
4. **Project docs** — `requirements.md`, `design.md`, and other necessary documents. The doer commits these to the branch. Re-send via `send_files` if PM-side documents are updated mid-sprint.

The `progress.json` file is the living state. Always query it for the current status.

### Per-Task Dispatch Algorithm

Before each doer dispatch, the PM reads `planned.json` and `progress.json`:

```
nextTask = planned.json.tasks.find(t => t.status === "pending")
tier     = nextTask.tier
resume   = (nextTask.phase === lastDispatchedPhase)   // from status.md
```

Dispatch ONE task at `model: <tier>`. The PM records `lastDispatchedPhase = nextTask.phase` in `status.md` after each dispatch.

### Execution Loop

```
PM sends task harness → dispatches doer (resume per data-driven rule, model=nextTask.tier)
  → doer reads progress.json → executes next pending task → commits → updates progress.json
  → hits VERIFY checkpoint → STOPS → PM reads progress.json
  → PM dispatches REVIEWER (model=premium) → reviewer reads deliverables + diff → commits verdict to feedback.md → pushes
  → APPROVED: PM dispatches doer for next task (resume=true if same phase) → repeat
  → CHANGES NEEDED: PM sends feedback to doer → doer fixes → PM re-dispatches REVIEWER → repeat
  → all tasks done → move to next phase or completion
```

### Session Rules

| Dispatch | resume |
|----------|--------|
| New phase (`nextTask.phase !== lastDispatchedPhase`) | `false` |
| Same phase (`nextTask.phase === lastDispatchedPhase`) | `true` |
| After reviewer CHANGES NEEDED → doer fix | `true` |
| Initial review dispatch | `false` |
| Re-review after fixes | `true` |
| Role switch (doer↔reviewer) | `false` |

**Data-driven resume rule** — derived from `planned.json` phase numbers:

| Condition | resume |
|-----------|--------|
| `nextTask.phase === lastDispatchedPhase` | `true` |
| `nextTask.phase !== lastDispatchedPhase` (new phase) | `false` |
| After reviewer CHANGES NEEDED → doer fix | `true` |
| Role switch (doer ↔ reviewer) | `false` |

### Permissions

Before starting execution, compose and deliver permissions for each member's role (see the fleet skill, `permissions.md`). Recompose on every role switch.

**Mid-sprint denial:** If a member is blocked by a permission denial, call `compose_permissions` with `grant: [<denied permission>]` and `project_folder`. This grants the missing permission, delivers the updated config, and appends to the ledger for future phases and sprints. Then resume the member with `resume=true`. Do not bypass by running the denied command yourself via `execute_command`.

### Monitoring

- Check progress: `execute_command → cat progress.json`.
- Check git: `execute_command → git log --oneline -10`.
- Members may exceed VERIFY checkpoints if context becomes large. Dispatch a review immediately when this is identified.
- Long-running branches: check drift with `git log <branch>..origin/main --oneline`. If main has moved, instruct rebase and retest.
- After every review verdict: move unaddressed MEDIUM or LOW findings and deferred scope items into `<project>/backlog.md`.

### Safeguards

| Safeguard | Trigger | PM Action | Limit |
|-----------|---------|-----------|-------|
| Max-turns budget | Every dispatch | Session ends naturally at turn limit. | Set per dispatch in `execute_prompt`. |
| PM retry limit | Same dispatch fails (error, no output) | Retry up to 3 times, then pause and flag the user. | 3 retries per dispatch. |
| Doer-reviewer cycle limit | Reviewer returns CHANGES NEEDED | Re-dispatch doer with feedback; if 3 cycles do not resolve HIGH items, pause and flag the user. | 3 cycles per phase. |
| Model escalation | Zero progress after resets | Reset and resume; after 2 resets with zero progress: escalate model (`cheap`→`standard`→`premium`). | 2 resets per model tier. |

---

## Phase 4 — Deployment

Run `<project>/deploy.md` steps on the member via `execute_command`. Verification and rollback steps must be defined in `deploy.md` by the user; follow them exactly. On failure, execute the rollback steps in `deploy.md` and flag the user.

---

## Sprint Completion

When all phases are APPROVED:

1. **Documentation Harvest** — Dispatch a member to extract long-term knowledge from `requirements.md`, `design.md`, and `PLAN.md` into `docs/`. The structure inside `docs/` is content-driven (e.g. `docs/architecture.md`, `docs/features/<name>.md`). Extract architecture decisions, feature design, key trade-offs, and API contracts. Do not extract task lists, code-line references, debug notes, or implementation steps. The member commits the `docs/` output to the branch. Dispatch a reviewer to verify the harvest captures durable knowledge. Iterate until APPROVED.

2. **Cleanup and raise PR** — See cleanup.md.

3. **Update backlog.md** — Record all unresolved MEDIUM or LOW review findings and deferred items from this sprint.

4. **Update status.md** — Mark the sprint as complete and record member states. Clear `lastDispatchedPhase`.

---

## Recovery After PM Restart

When the PM session ends unexpectedly, remote agent CLI processes are killed. Partial work may be uncommitted.

**Step 0 — Global triage:** `fleet_status` — Identify which members are idle, busy, or unreachable before per-member inspection.

For each member in the project:
1. `execute_command → cat progress.json` — Identify completed, pending, or blocked tasks.
   - **On reviewer members:** `progress.json` is not authoritative. Check `git log --oneline -- feedback.md` for reviewer progress.
2. `execute_command → git log --oneline -5` — Check for commits since the last known state.
3. `execute_command → git status` — Check for uncommitted changes.
4. Compare against local `<project>/status.md`. Check `lastDispatchedPhase` to determine resume or fresh-session for the next dispatch.

Present a per-member state summary before acting:

| Member | PM last knew | Actual state | Delta | Action |
|--------|-------------|--------------|-------|--------|
| <name> | <phase/task from status.md> | <last commit + progress summary> | <what changed> | auto-resume / escalate |

**Auto-resume** (PM acts immediately):
- **Checkpoint reached, review pending** → Dispatch reviewer now.
- **Mid-task with commits, clear next step** → Resume doer with `resume=true`.
- **No progress, member idle** → Re-dispatch from the last known state.

**Escalate to user** (ambiguous or risky):
- **Uncommitted changes of unknown origin** → "The member has uncommitted work not matching any known task. Commit and resume, or discard?"
- **Conflicting state** (progress.json says complete but git shows no commits) → "A state inconsistency was detected. Investigate or reset?"
- **Zero progress after re-dispatch** → "The member made no progress after re-dispatch. Escalate model or reassign?"
