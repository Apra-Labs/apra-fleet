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

**Branch naming:** choose a name that makes the purpose of the branch immediately clear — `sprint/<description>`, `feat/<description>`, `bug_fix/<short_description>`, etc. PM records this as `{{branch}}` in the agent context file before dispatch.

1. Send `requirements.md` to doer via `send_files`
2. Dispatch `plan-prompt.md` via `execute_prompt` (wrapped in background Agent)
3. Run doer-reviewer loop (see `doer-reviewer.md`) using `tpl-reviewer-plan.md` for the reviewer
4. Iterate until plan passes quality criteria
5. Once APPROVED: save `planned.json` in `<project>/` — this is the immutable original, never modify it
6. **Beads: push plan tasks** — for each task in PLAN.md, create a Beads task and wire dependencies:
   ```bash
   bd create "T1.1: <title>" -p 1 --parent <epic-id>   # → task-id
   bd create "T1.2: <title>" -p 2 --parent <epic-id>   # → task-id
   bd dep add <T1.2-id> <T1.1-id>                       # T1.2 blocked until T1.1 done
   ```
   Record all task IDs in `<project>/status.md` Beads section. See `beads.md`.
7. Proceed to Phase 3

---

## Phase 3 — Execution

### Task Harness

The task harness is the set of files sent to the doer's `work_folder` root via `send_files` to bootstrap execution:

1. **Agent context file** — from `tpl-doer.md`. See `context-file.md` for filename and delivery rules.
2. **PLAN.md** — implementation plan with phases and tasks
3. **progress.json** — task tracker (generated from PLAN.md per `tpl-progress.json`)
4. **Project docs** — `requirements.md`, `design.md`, and any other docs the doer needs. Doer commits these to the branch. Re-send via `send_files` if PM-side docs are updated mid-sprint.

`progress.json` is the living state. Always query it for current status.

### Per-Task Dispatch Algorithm

Before each doer dispatch, PM reads `planned.json` and `progress.json`:

```
nextTask = planned.json.tasks.find(t => t.status === "pending")
tier     = nextTask.tier
resume   = (nextTask.phase === lastDispatchedPhase)   // from status.md
```

Dispatch ONE task at `model: <tier>`. PM records `lastDispatchedPhase = nextTask.phase` in `status.md` after each dispatch.

### Execution Loop

```
PM sends task harness → dispatches doer (resume per data-driven rule, model=nextTask.tier)
  → bd update <task-id> --claim
  → doer reads progress.json → executes next pending task → commits → updates progress.json
  → hits VERIFY checkpoint → STOPS → PM reads progress.json
  → bd update <verify-id> --done
  → PM dispatches REVIEWER (model=premium) → reviewer reads deliverables + diff → commits verdict to feedback.md → pushes
  → APPROVED: PM dispatches doer for next task (resume=true if same phase) → repeat
  → CHANGES NEEDED: bd create "<finding>" -p 0 --parent <epic-id> per HIGH finding → PM sends feedback to doer → doer fixes → bd update <finding-id> --done → PM re-dispatches REVIEWER → repeat
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

**Data-driven resume rule** — derived from `planned.json` phase numbers, not manually reasoned:

| Condition | resume |
|-----------|--------|
| `nextTask.phase === lastDispatchedPhase` | `true` |
| `nextTask.phase !== lastDispatchedPhase` (new phase) | `false` |
| After reviewer CHANGES NEEDED → doer fix | `true` |
| Role switch (doer ↔ reviewer) | `false` |

### Permissions

Before kicking off execution, compose and deliver permissions for each member's role (see the fleet skill, `permissions.md`). Recompose on every role switch.

**Mid-sprint denial:** If a member is blocked by a permission denial, call `compose_permissions` with `grant: [<denied permission>]` and `project_folder` — this grants the missing permission, delivers the updated config, and appends to the ledger so future phases and sprints start with it already included. Then resume the member with `resume=true`. Never bypass by running the denied command yourself via `execute_command`.

### Monitoring

- Check progress: `execute_command → cat progress.json`
- Check git: `execute_command → git log --oneline -10`
- Members may blow past VERIFY checkpoints if context gets large — dispatch a review immediately when caught
- Long-running branches: check drift with `git log <branch>..origin/main --oneline`. If main moved, instruct rebase + retest
- After every review verdict: move unaddressed MEDIUM/LOW findings and any deferred scope items into `<project>/backlog.md` AND create low-priority Beads tasks (`bd create "<item>" -p 3 --parent <epic-id>`)
- Deferred items from user ("add to backlog", "defer this"): `bd create "<description>" -p 3 --parent <epic-id>`

### Safeguards

| Safeguard | Trigger | PM Action | Limit |
|-----------|---------|-----------|-------|
| Max-turns budget | Every dispatch | Session ends naturally at turn limit | Set per dispatch in `execute_prompt` |
| PM retry limit | Same dispatch fails (error, no output) | Retry up to 3×, then pause + flag user | 3 retries per dispatch |
| Doer-reviewer cycle limit | Reviewer returns CHANGES NEEDED | Re-dispatch doer with feedback; if 3 cycles don't resolve all HIGH items, pause + flag user | 3 cycles per phase |
| Model escalation | Zero progress after resets | Reset and resume; after 2 resets with zero progress: escalate model (`cheap`→`standard`→`premium`). Still zero? Flag user | 2 resets per model tier |

---

## Phase 4 — Deployment

Run `<project>/deploy.md` steps on the member via `execute_command`. Verification and rollback steps must be defined in `deploy.md` by the user — follow them exactly. On failure, execute the rollback steps in `deploy.md` and flag the user.

---

## Sprint Completion

When all phases are APPROVED:

1. **Documentation Harvest** — Dispatch a member to extract long-term knowledge from `requirements.md`, `design.md`, and `PLAN.md` into `docs/`. Structure inside `docs/` is content-driven (e.g. `docs/architecture.md`, `docs/features/<name>.md`). Extract: architecture decisions, feature design, key trade-offs, API contracts. Do NOT extract: task lists, code-line references, debug notes, implementation steps. Member commits the docs/ output to the branch. Then dispatch reviewer to review the harvest — verify it captures durable knowledge and nothing transient slipped in. Iterate until APPROVED.

2. **Cleanup and raise PR** — See cleanup.md.

3. **Update backlog.md** — record all unresolved MEDIUM/LOW review findings and deferred items from this sprint.

4. **Update status.md** — mark sprint complete, record member states. Clear `lastDispatchedPhase`.

---

## Recovery After PM Restart

When the PM session ends unexpectedly, remote agent CLI processes are killed (SSH channel close → SIGHUP). Partial work may be uncommitted.

**Step 0 — Global triage:** Run `bd ready` first — instantly shows all in-flight tasks across every project without reading files. Then `fleet_status` to check member connectivity.

For each member in the project:
1. `execute_command → cat progress.json` — what tasks are completed/pending/blocked?
   - **On reviewer members:** progress.json is not authoritative — it reflects the doer's task state at last sync. Check `git log --oneline -- feedback.md` for reviewer progress instead.
2. `execute_command → git log --oneline -5` — any commits since last known state?
3. `execute_command → git status` — uncommitted changes?
4. Compare against local `<project>/status.md` — what did PM last know? Check `lastDispatchedPhase` to determine resume vs. fresh-session for next dispatch.

Present a per-member state summary before acting:

| Member | PM last knew | Actual state | Delta | Action |
|--------|-------------|--------------|-------|--------|
| <name> | <phase/task from status.md> | <last commit + progress summary> | <what changed> | auto-resume / escalate |

**Auto-resume** (PM acts immediately, no user input needed):
- **Checkpoint reached, review pending** → dispatch reviewer now
- **Mid-task with commits, clear next step** → resume doer with `resume=true`
- **No progress, member idle** → re-dispatch from last known state

**Escalate to user** (ambiguous or risky — present options and wait):
- **Uncommitted changes of unknown origin** → "member has uncommitted work not matching any known task. Commit and resume, or discard?"
- **Conflicting state** (progress.json says complete but git shows no commits) → "state inconsistency detected. Investigate or reset?"
- **Zero progress after re-dispatch** → "member made no progress after re-dispatch. Escalate model or reassign?"
