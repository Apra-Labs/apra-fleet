# Running a Sprint

## Lifecycle
`vision` → `reqs` → `design` → `plan` → `dev` → `test` → `deploy`

## Phase 1: Requirements
Write `<project>/requirements.md`. Include issue details, root causes. Riskiest assumptions first.

## Phase 2: Plan
- `send_files requirements.md`.
- `execute_prompt plan-prompt.md`.
- Doer-reviewer loop (use `tpl-reviewer-plan.md`).
- Approved? Save `planned.json` (immutable, NEVER modify it).

## Phase 3: Execution
### Harness
`send_files`: Context file, `PLAN.md`, `progress.json`, `requirements.md`, `design.md`.

### Dispatch
`nextTask` = first pending in `planned.json`.
`model` = `nextTask.tier`.
`resume` = `true` if same phase, else `false`.

### Loop
PM sends harness → Dispatch doer → Doer works/commits/updates `progress.json` → `VERIFY` checkpoint → PM reads `progress.json` → Dispatch Reviewer (`model=premium`) → `feedback.md` verdict.
- **APPROVED** → Next task.
- **CHANGES NEEDED** → Feedback to doer → Doer fix → Re-review.

### Permissions
Recompose on role switch. Denial? `compose_permissions` with `grant`. NEVER bypass by running the denied command yourself.

### Monitoring
- `cat progress.json`.
- `git log`.
- `backlog.md`: Unaddressed MED/LOW findings.

### Safeguards
- **Retry:** 3x fail → flag user.
- **Cycles:** 3x `CHANGES NEEDED` → flag user.
- **Escalation:** 2x resets → model up.

## Phase 4: Deployment
Run `deploy.md` steps via `execute_command`. Verification/rollback mandatory.

## Completion
1. **Harvest:** Extract knowledge to `docs/`. Review harvest.
2. **Cleanup:** `cleanup.md`.
3. **Backlog:** Record unresolved findings.
4. **Status:** Mark complete.

## Recovery
1. `fleet_status`.
2. `cat progress.json` + `git log` + `git status`.
3. Compare with `status.md`.
4. **Auto-resume:** clear next step.
5. **Escalate:** uncommitted work / conflict.