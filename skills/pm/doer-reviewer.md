# Doer-Reviewer Loop

## Setup
1. Record pair in `<project>/status.md`.
2. Icons: `update_member` (doer=circle, reviewer=square).
3. `compose_permissions` (fleet) per role.
4. `send_files` context file (see `context-file.md`).
- Tiers: Reviewer `premium`. Doer use `tasks[i].tier`.

## Pre-flight
### Before Dispatch
1. `fleet_status`: idle.
2. `git status && git branch`: clean + correct.

### Before Review
1. Reviewer SHA must match doer SHA.
2. If not: `fetch` + `reset --hard origin/<branch>`.

## Flow
1. **Doer works**, commits, pushes. Stop at `VERIFY`.
- New phase: `resume=false`.
- Same phase: `resume=true`.
2. **PM handles transport** (`execute_command`):
- Dev: `git push`.
- Rev: `git fetch` + `checkout` + `reset --hard`.
3. **PM dispatches Reviewer** at `VERIFY`. Fresh session (`resume=false`).
- Reviewer reads deliverables + diff.
- Cumulative review.
- Commits findings to `feedback.md`.
- Verdict: `APPROVED` or `CHANGES NEEDED`.
4. **APPROVED** → next phase.
5. **CHANGES NEEDED** → doer fixes → loop.
6. **Completion** → `cleanup.md`.

## Resume Rules
- Doer same phase: `true`.
- Doer new phase: `false`.
- After fix: `true`.
- Switch role: `false`.
- Stop/kill: `false`.
- Timeout: `true`.

## Safeguards
- **Retry:** 3x same dispatch fail → flag user.
- **Cycles:** 3x `CHANGES NEEDED` → flag user.
- **Escalation:** 2x resets 0 progress → model up (`cheap`→`standard`→`premium`).

## Git
- Doer commits deliverables, `PLAN.md`, `progress.json`.
- Doer annotates `feedback.md` with fixes.
- Reviewer commits `feedback.md`.
- Context files NEVER committed.

## Permissions
- Recompose on role switch.
- Denial? `compose_permissions` w/ `grant`. Append to ledger.
- Stuck/wrong? `stop_prompt` → `resume=false`.