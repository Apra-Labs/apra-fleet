# Doer-Reviewer Loop

## Setup Checklist

1. Record pair in `<project>/status.md`. Multiple pairs per project is normal.
2. Override icons via `update_member` — doer gets circle, reviewer gets square, same color. This is not optional.
3. Compose and deliver permissions per permissions.md for each member's role.
4. Configure role-specific CLAUDE.md — three distinct phases:
   - **Planning:** Dispatch `plan-prompt.md` content via `execute_prompt` — no CLAUDE.md needed for planning
   - **Execution:** Send `tpl-claude.md` as CLAUDE.md to doer via `send_files` — **must be sent before execution starts** (persists across session resumes)
   - **Review:** Send `tpl-reviewer.md` as CLAUDE.md to reviewer via `send_files` — **must be sent before review dispatch** (persists across session resumes). Use `tpl-reviewer-plan.md` for plan review.

**Single-member pairs:** One member fills both roles via `reset_session`. PM resets, sends the other role's CLAUDE.md + permissions, same member reviews with fresh context. Track current role and session ID in status.md.

## Pre-flight Checks

### Before any dispatch
Verify member is on the correct branch with a clean working tree:
1. `fleet_status` — confirm member is idle
2. `execute_command → git status && git branch --show-current` — confirm clean tree and correct branch

Do not dispatch to a member on the wrong branch or with uncommitted changes.

### Before review dispatch
Verify reviewer is at the correct commit before starting review:
1. `execute_command → git rev-parse HEAD` on reviewer — must match doer's pushed HEAD SHA
2. If SHA doesn't match: run `git fetch origin && git reset --hard origin/<branch>` on reviewer, then re-verify

## Flow

1. Doer works, commits and pushes deliverables at every turn → STOPS at every VERIFY checkpoint
2. **PM handles git transport via `execute_command`** — never delegate to prompts:
   - Dev side: `git push origin <branch>` — verify push succeeded
   - Rev side: `git fetch origin && git checkout <branch> && git reset --hard origin/<branch>`
3. **PM dispatches REVIEWER at every VERIFY checkpoint** — PM never self-reviews. PM sends context docs to reviewer via `send_files`: `<project>/requirements.md`, `<project>/design.md`, and relevant `<project>/*plan.md`. Then dispatches reviewer with `resume=false` (fresh session).

   **Reviewer workflow rules:**
   - **Prep reviewer in parallel while doer works** — send requirements, set up branch, start a context-reading session on reviewer. Use session resume to send updated docs at handoff. Eliminates dead time.
   - **Always use `resume=false` for review dispatches** — never resume a stale review session. Each review must start fresh.
   - **Verify SHA before dispatching review** — `execute_command → git rev-parse HEAD` on reviewer must match doer's pushed HEAD (see Pre-flight Checks above).

4. Reviewer reads deliverables + diff, conducts cumulative review (all phases up to current, not just the latest) per its CLAUDE.md. Commits findings to feedback.md, pushes, and outputs verdict: APPROVED or CHANGES NEEDED
5. PM reads verdict:
   - **APPROVED** → merge → cleanup → next phase
   - **CHANGES NEEDED** → PM sends feedback to doer → doer fixes → back to step 1 → PM re-dispatches REVIEWER
6. **Post-merge cleanup** — `execute_command` on doer: `git rm PLAN.md progress.json feedback.md 2>/dev/null; rm -f CLAUDE.md; git commit -m "cleanup: remove fleet control files"`. These are transport files — git history preserves the content.
7. Loop until all phases APPROVED

## Safeguards

The PM must enforce these limits to prevent infinite loops and runaway sessions:

| Safeguard | Trigger | PM Action | Limit |
|-----------|---------|-----------|-------|
| max_turns budget | Every `execute_prompt` dispatch | Session ends naturally at turn limit | Set per dispatch in `execute_prompt` |
| PM retry limit | Same dispatch fails (error, no output) | Retry up to 3×, then pause sprint + flag user | 3 retries per dispatch |
| Doer-reviewer cycle limit | Reviewer returns CHANGES NEEDED | Re-dispatch doer with feedback; if 3 cycles don't resolve all HIGH items, pause sprint + flag user | 3 cycles per phase |
| Model escalation | Zero progress after session resets | Reset session and resume; after 2 resets with zero progress: escalate model (haiku→sonnet→opus). Still zero after opus? Flag user | 2 resets per model tier |

**When to escalate to user:**
- After 3 retries on the same dispatch with no progress
- After 3 doer-reviewer cycles with unresolved HIGH items
- After opus model still shows zero progress after 2 resets

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
