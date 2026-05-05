# Doer-Reviewer Loop

## Setup

1. Record pair in `<project>/status.md`.
2. Icons: `update_member` (doer=circle, reviewer=square).
3. `compose_permissions` (fleet) for each role.
4. `send_files` context file before dispatch (`context-file.md`).
   - Call `compose_permissions` before every dispatch.
   - `unattended='auto'` (preferred) or `'dangerous'`.

**Models**: Reviews @ `premium`. Doer @ `tasks[i].tier` from `planned.json`.

## Pre-flight

### Any dispatch
1. `fleet_status`: confirm idle.
2. `git status` + `git branch --show-current`: clean tree, correct branch.

### Review dispatch
1. `git rev-parse HEAD` on reviewer: must match doer's pushed SHA.
2. mismatch? `git fetch && git reset --hard origin/<branch>`, re-verify.

## Flow

1. Doer works/commits/pushes every turn. STOPS at VERIFY.
   - New phase: `resume=false`.
   - Same phase: `resume=true`.
2. **PM handles git**:
   - Dev: `git push origin <branch>`.
   - Rev: `git fetch origin && git checkout <branch> && git reset --hard origin/<branch>`.
3. **PM dispatches REVIEWER** @ VERIFY. PM never self-reviews. Send background info via `send_files`. Dispatch reviewer with `resume=false`.
   - Planning: prep reviewer in parallel while doer works.
   - Execution: new phase review = `resume=false`.
   - Verify SHA before dispatch.
4. Reviewer reads deliverables + diff. Cumulative review. Commits to feedback.md, pushes. Verdict: APPROVED or CHANGES NEEDED.
5. PM reads verdict:
   - APPROVED: next phase.
   - CHANGES NEEDED: PM sends feedback to doer → doer fixes → repeat.
6. Loop until all APPROVED.
7. **Completion**: `cleanup.md`.

## Resume Rules

**Doer**: derived from `planned.json` via `lastDispatchedPhase`.
- `nextTask.phase === lastDispatchedPhase`: `true`.
- `nextTask.phase !== lastDispatchedPhase`: `false`.
- After CHANGES NEEDED → doer fix: `true`.
- Role switch: `false`.

**General**:
- Initial plan gen / review: `false`.
- Plan revision / Re-review: `true`.
- After `stop_prompt`: `false`.
- After timeout mid-grant: `true`.

## Safeguards

- max_turns: session ends at limit.
- PM retry: 3x per dispatch then pause.
- Loop limit: 3 cycles per phase then pause.
- Model escalation: 2 resets with zero progress: `cheap`→`standard`→`premium`.

**Escalate to user**: 3 retries no progress; 3 cycles unresolved HIGH items; Premium model zero progress.

## Git as transport

- Doer commit: deliverables, `PLAN.md`, `progress.json`, docs. Fixes? annotate `feedback.md`: `**Doer:** fixed in <sha>`.
- Reviewer commit: `feedback.md`.
- Context file: NEVER committed.

## Permissions

`compose_permissions`. Recompose on role switch.
**Denial**: `compose_permissions` with `grant: [<permission>]` + `project_folder`. Resume with `resume=true`.
**Cancel**: `stop_prompt`. Follow with `resume=false`.

## PM Duties

- Distribute work by cohesion.
- Autonomous handoffs (doer↔reviewer). Don't wait for user.
