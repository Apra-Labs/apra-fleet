# Doer-Reviewer Loop

## Setup Checklist

1. Record pair in `<project>/status.md`. Multiple pairs per project is normal.
2. Override icons via `update_member` — doer gets circle, reviewer gets square, same color. This is not optional.
3. Compose and deliver permissions per permissions.md for each member's role.
4. Send role-specific CLAUDE.md via `send_files`:
   - Doer: plan-prompt.md (planning) or tpl-claude.md (execution)
   - Reviewer: tpl-reviewer-plan.md (planning) or tpl-reviewer.md (execution)

**Single-member pairs:** One member fills both roles via `reset_session`. PM resets, sends the other role's CLAUDE.md + permissions, same member reviews with fresh context. Track current role and session ID in status.md.

## Flow

1. Doer works, commits and pushes deliverables at every turn → STOPS at every VERIFY checkpoint
2. **PM handles git transport via `execute_command`** — never delegate to prompts:
   - Dev side: `git push origin <branch>` — verify push succeeded
   - Rev side: `git fetch origin && git checkout <branch> && git reset --hard origin/<branch>`
3. **PM dispatches REVIEWER at every VERIFY checkpoint** — PM never self-reviews. PM sends context docs to reviewer via `send_files`: `<project>/requirements.md`, `<project>/design.md`, and relevant `<project>/*plan.md`. Then dispatches reviewer with `resume=false` (fresh session).
4. Reviewer reads deliverables + diff, conducts cumulative review (all phases up to current, not just the latest) per its CLAUDE.md. Commits findings to feedback.md, pushes, and outputs verdict: APPROVED or CHANGES NEEDED
5. PM reads verdict:
   - **APPROVED** → merge → cleanup → next phase
   - **CHANGES NEEDED** → PM sends feedback to doer → doer fixes → back to step 1 → PM re-dispatches REVIEWER
6. **Post-merge cleanup** — `execute_command` on doer: `git rm PLAN.md progress.json feedback.md 2>/dev/null; rm -f CLAUDE.md; git commit -m "cleanup: remove fleet control files"`. These are transport files — git history preserves the content.
7. Loop until all phases APPROVED

## Git as transport

- Doers commit: deliverables, PLAN.md, progress.json, project docs
- Reviewers commit: feedback.md
- CLAUDE.md is NEVER committed — it's role-specific (different for doer vs reviewer)
- Only CLAUDE.md goes in .gitignore

## Permissions

Compose and deliver `settings.local.json` per permissions.md. Recompose when switching roles (doer↔reviewer).

## PM responsibilities

- Distribute work across pairs based on cohesion (high cohesion within a pair, loose coupling between pairs)
- Keep going autonomously (rule 7) — don't wait for user between doer and reviewer handoffs
