# Doer-Reviewer Loop

## Setup Checklist

1. Record the pair in `<project>/status.md`. Multiple pairs per project are normal.
2. Override icons via `update_member`. The doer receives a circle icon, and the reviewer receives a square icon of the same color.
3. Compose and deliver permissions for each member's role as described in `permissions.md`.
4. Send the role-specific agent context file via `send_files` before dispatch.
   - Call `compose_permissions` before every dispatch, regardless of unattended mode.
   - For provider-specific unattended flag behavior, see the fleet `SKILL.md` unattended modes section.
   - Prefer `unattended='auto'` over `'dangerous'`. `auto` mode scopes bypass to explicitly listed operations; `dangerous` mode skips all checks globally.
   - See `context-file.md` for provider filename lookup and role templates. Planning and plan review are dispatched as inline prompts; no agent context file is required for those phases.

**Model tier check:** Dispatch reviews at `model=premium`. For doers, the PM reads `tasks[i].tier` from `planned.json` and passes `model: <tier>` to `execute_prompt`. No hardcoded default is used. User override always takes precedence.

## Pre-flight Checks

### Before any dispatch
Verify that the member is on the correct branch with a clean working tree:
1. `fleet_status` — Confirm the member is idle.
2. `execute_command → git status && git branch --show-current` — Confirm a clean tree and the correct branch.

Do not dispatch to a member on the wrong branch or with uncommitted source code changes.

### Before review dispatch
Verify the reviewer is at the correct commit before starting the review:
1. `execute_command → git rev-parse HEAD` on the reviewer; this must match the doer's pushed HEAD SHA.
2. If the SHA does not match: Run `git fetch origin && git reset --hard origin/<branch>` on the reviewer, then re-verify.

## Flow

1. The doer works, commits, and pushes deliverables at every turn. The doer stops at every VERIFY checkpoint.

   **Doer session rules:**
   - **New phase (`nextTask.phase !== lastDispatchedPhase`):** Use `resume=false`.
   - **Same phase (`nextTask.phase === lastDispatchedPhase`):** Use `resume=true`.

2. **The PM handles git transport via `execute_command`**; do not delegate this to prompts:
   - Developer side: `git push origin <branch>`; verify the push succeeded.
   - Reviewer side: `git fetch origin && git checkout <branch> && git reset --hard origin/<branch>`.

3. **The PM dispatches the REVIEWER at every VERIFY checkpoint.** The PM never self-reviews. Most context documents are committed in the repository. The PM sends other required background information to the reviewer via `send_files`. The PM then dispatches the reviewer with `resume=false` for a fresh session.

   **Reviewer workflow rules:**
   - **During planning stage prep, prepare the reviewer in parallel while the doer works.** Send requirements, set up the branch, and start a context-reading session on the reviewer. Use session resume to send updated documents at handoff when the doer is ready.
   - **During the execution phase:** For each new phase's review, use `resume=false` for the reviewer.
   - **Verify the SHA before dispatching the review.** `execute_command → git rev-parse HEAD` on the reviewer must match the doer's pushed HEAD.

4. The reviewer reads deliverables and the diff, then conducts a cumulative review (all phases up to current) according to its agent context file. The reviewer commits findings to `feedback.md`, pushes, and outputs a verdict: APPROVED or CHANGES NEEDED.
5. The PM reads the verdict:
   - **APPROVED** → Proceed to the next phase or sprint completion if all phases are finished.
   - **CHANGES NEEDED** → The PM sends feedback to the doer, the doer fixes the issues, and the loop returns to step 1 before the PM re-dispatches the REVIEWER.
6. Repeat the loop until all phases are APPROVED.
7. **Sprint completion** — See cleanup.md.

## Resume Rule

**Doer dispatches** — Resume is derived from `planned.json` phase numbers via `lastDispatchedPhase` in `status.md`:

| Condition | resume |
|-----------|--------|
| `nextTask.phase === lastDispatchedPhase` | `true` |
| `nextTask.phase !== lastDispatchedPhase` (new phase) | `false` |
| After reviewer CHANGES NEEDED → doer fix | `true` |
| Role switch (doer ↔ reviewer) | `false` |

**All dispatches:**

| Dispatch | resume |
|----------|--------|
| Initial plan generation | `false` |
| Plan revision (any feedback iteration) | `true` |
| Initial review dispatch | `false` |
| Re-review after CHANGES NEEDED and doer fixes | `true` |
| Role switch (doer → reviewer, or reviewer → doer) | `false` |
| After `stop_prompt` cancellation | `false` (start a fresh session as state is unreliable) |
| After session timed out mid-grant | `true` (Fleet auto-recovers, but the member restarts without prior context) |

**Note:** A role switch always requires sending the new agent context file before dispatch. Do not resume across a role switch.

## Safeguards

| Safeguard | Trigger | PM Action | Limit |
|-----------|---------|-----------|-------|
| max_turns budget | Every `execute_prompt` dispatch | The session ends naturally at the turn limit. | Set per dispatch in `execute_prompt`. |
| PM retry limit | Same dispatch fails (error, no output) | Retry up to 3 times, then pause the sprint and flag the user. | 3 retries per dispatch. |
| Doer-reviewer cycle limit | Reviewer returns CHANGES NEEDED | Re-dispatch the doer with feedback; if 3 cycles do not resolve HIGH items, pause the sprint and flag the user. | 3 cycles per phase. |
| Model escalation | Zero progress after session resets | Reset the session and resume; after 2 resets with zero progress, escalate the model (`cheap`→`standard`→`premium`). If no progress after premium model, flag the user. | 2 resets per model tier. |

**When to escalate to the user:**
- After 3 retries on the same dispatch with no progress.
- After 3 doer-reviewer cycles with unresolved HIGH items.
- After a premium model shows zero progress after 2 resets.

## Git as transport

- Doers commit: deliverables, PLAN.md, progress.json, and project documents. When fixing review findings, the doer also annotates `feedback.md` by adding `**Doer:** fixed in commit <sha> — <what changed>` under each addressed finding, then commits `feedback.md`. The doer never rewrites `feedback.md` content.
- Reviewers commit: `feedback.md` (full content; see `tpl-reviewer.md` for format).
- The member agent context file is NEVER committed; see `context-file.md`.

## Permissions

Compose and deliver permissions per `permissions.md`. Recompose when switching roles. Each provider receives its native permission configuration; `compose_permissions` handles the format automatically.

**Mid-sprint denial:** If a member is blocked by a permission denial, call `compose_permissions` with `grant: [<denied permission>]` and `project_folder`. This grants the missing permission, delivers the updated configuration, and appends to the ledger for future phases and sprints. Then resume the member with `resume=true`. Do not bypass by running the denied command yourself via `execute_command`. Act on the grant promptly; the inactivity timer fires on stdout silence. If it fires while you are composing permissions, `resume=true` still succeeds via stale-session auto-recovery, but the member restarts without its in-progress context.

**Cancelling a running session:** Use `stop_prompt` when a member is working on the wrong task, stuck in a loop, or dispatched with incorrect instructions. Follow immediately with `resume=false` to start a clean session.

Note: `stop_prompt` kills the member's LLM process. This is distinct from stopping a background orchestration sub-task within the PM's session.

## PM responsibilities

- Distribute work across pairs based on cohesion (high cohesion within a pair, loose coupling between pairs).
- Do not wait for the user between doer and reviewer handoffs; autonomously progress the project unless blockers are observed.
