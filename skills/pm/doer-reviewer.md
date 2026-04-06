# Doer-Reviewer Loop

## Setup Checklist

1. Record pair in `<project>/status.md`. Multiple pairs per project is normal.
2. Override icons — doer gets circle, reviewer gets square, same color. See the fleet skill for icon assignment. This is not optional.
3. Compose and deliver permissions per the fleet skill for each member's role.
4. Configure role-specific instruction file — three distinct phases:
   - **Planning:** Dispatch `plan-prompt.md` content — see the fleet skill for dispatch mechanics. No instruction file needed for planning.
   - **Execution:** Send `tpl-doer.md` as the member's instruction file to doer — **must be sent before execution starts** (persists across session resumes). See the fleet skill for delivery mechanics and provider-specific file naming.
   - **Review:** Send `tpl-reviewer.md` as the reviewer's instruction file — **must be sent before review dispatch** (persists across session resumes). See the fleet skill for delivery mechanics and provider-specific file naming. Use `tpl-reviewer-plan.md` for plan review.



**Reviewer tier check:** Reviews benefit from the highest reasoning tier available. Dispatch reviews with `model=premium` — the PM maps this to the best available model for each provider. If no premium option exists, use what is available — no warning needed. User's choice is final. Doers use `model=standard` by default unless the task tier specifies otherwise.

## Pre-flight Checks

### Before any dispatch
Verify member is on the correct branch with a clean working tree — see the fleet skill for pre-flight check commands.

Do not dispatch to a member on the wrong branch or with uncommitted changes.

### Before review dispatch
Verify reviewer is at the correct commit before starting review — see the fleet skill for SHA verification commands.

## Flow

1. Doer works, commits and pushes deliverables at every turn → STOPS at every VERIFY checkpoint

   **Doer session rules:**
   - **Start of each new phase:** use `resume=false` — fresh context per phase keeps token usage small and avoids cross-phase confusion from stale context
   - **Within a phase:** resume is allowed — tasks within a phase are cohesive and benefit from shared context

2. **PM handles git transport** between doer and reviewer — see the fleet skill for git transport commands.

3. **PM dispatches REVIEWER at every VERIFY checkpoint** — PM never self-reviews. PM sends context docs to reviewer (`<project>/requirements.md`, `<project>/design.md`, and relevant `<project>/*plan.md`) — see the fleet skill for delivery mechanics. Then dispatches reviewer with `resume=false` (fresh session).

   **Reviewer workflow rules:**
   - **Prep reviewer in parallel while doer works** — send requirements, set up branch, start a context-reading session on reviewer. Use session resume to send updated docs at handoff. Eliminates dead time.
   - **Always use `resume=false` for review dispatches** — never resume a stale review session. Each review must start fresh.
   - **Verify SHA before dispatching review** — see the fleet skill for pre-flight check details.

4. Reviewer reads deliverables + diff, conducts cumulative review (all phases up to current, not just the latest) per its instruction file. Commits findings to feedback.md, pushes, and outputs verdict: APPROVED or CHANGES NEEDED
5. PM reads verdict:
   - **APPROVED** → cleanup → merge → next phase
   - **CHANGES NEEDED** → PM sends feedback to doer → doer fixes → back to step 1 → PM re-dispatches REVIEWER
6. **Pre-merge cleanup** — remove fleet control files from doer (PLAN.md, progress.json, feedback.md, and the provider instruction file); commit and push — see the fleet skill for cleanup commands.
7. Loop until all phases APPROVED

## Post-dispatch Token Tracking

Track tokens after every dispatch — see the fleet skill for token tracking details.

## Resume Rule (token-saving best practice)

Setting `resume` correctly avoids re-reading large context files on every dispatch.

| Dispatch | resume | Reason |
|----------|--------|--------|
| Initial plan generation | `false` | Member has no prior context |
| Plan revision (any feedback iteration) | `true` | Member already has plan context; resuming saves re-reading files |
| Initial review dispatch | `false` | Reviewer needs fresh, unbiased context |
| Re-review after CHANGES NEEDED + doer fixes | `true` | Reviewer already read the plan; saves significant tokens |
| Role switch (doer → reviewer, or reviewer → doer) | `false` | New role requires different instruction file; must start clean |

**Note:** A role switch always requires sending the new instruction file before dispatch. Never resume across a role switch.

## Safeguards

The PM must enforce these limits to prevent infinite loops and runaway sessions:

| Safeguard | Trigger | PM Action | Limit |
|-----------|---------|-----------|-------|
| max_turns budget | Every dispatch | Session ends naturally at turn limit | Set per dispatch — see the fleet skill |
| PM retry limit | Same dispatch fails (error, no output) | Retry up to 3×, then pause sprint + flag user | 3 retries per dispatch |
| Doer-reviewer cycle limit | Reviewer returns CHANGES NEEDED | Re-dispatch doer with feedback; if 3 cycles don't resolve all HIGH items, pause sprint + flag user | 3 cycles per phase |
| Model escalation | Zero progress after session resets | Reset session and resume; after 2 resets with zero progress: escalate model (cheap→standard→premium). Still zero after premium? Flag user | 2 resets per model tier |

**When to escalate to user:**
- After 3 retries on the same dispatch with no progress
- After 3 doer-reviewer cycles with unresolved HIGH items
- After premium model still shows zero progress after 2 resets

## Git as transport

- Doers commit: deliverables, PLAN.md, progress.json, project docs
- Reviewers commit: feedback.md
- The member instruction file (CLAUDE.md / GEMINI.md / AGENTS.md / COPILOT.md) is NEVER committed — it is role-specific (different for doer vs reviewer)
- Only the instruction file goes in .gitignore (add the provider-appropriate name — see the fleet skill for provider file naming)

## Permissions

Compose and deliver permissions per the fleet skill. Recompose when switching roles (doer↔reviewer).

## PM responsibilities

- Distribute work across pairs based on cohesion (high cohesion within a pair, loose coupling between pairs)
- Keep going autonomously (rule 7) — don't wait for user between doer and reviewer handoffs
