# Doer-Reviewer Loop

## Setup Checklist

1. Record pair in `<project>/status.md`. Multiple pairs per project is normal.
2. Override icons via `update_member` — doer gets circle, reviewer gets square, same color.
3. Compose and deliver permissions per `permissions.md` (fleet skill) for each member's role.
4. Send the role-specific agent context file via `send_files` before dispatch.
   - Call `compose_permissions` before every dispatch regardless of unattended mode.
   - For provider-specific unattended flag behaviour, see the fleet SKILL.md unattended modes section.
   - Prefer `unattended='auto'` over `'dangerous'` — `auto` scopes bypass to explicitly listed operations; `dangerous` skips all checks globally.
   - See `context-file.md` for provider filename lookup and role templates. Planning and plan review are dispatched as inline prompts — no agent context file needed for those phases.

**Model tier check:** Dispatch reviews with the costliest model tier available (`model=premium` where supported). Doers use `model=standard` by default unless the task tier specifies otherwise. User override always wins. 

## Pre-flight Checks

### Before any dispatch
Verify member is on the correct branch with a clean working tree:
1. `fleet_status` — confirm member is idle
2. `execute_command → git status && git branch --show-current` — confirm clean tree and correct branch

Do not dispatch to a member on the wrong branch or with uncommitted source code changes.

### Before review dispatch
Verify reviewer is at the correct commit before starting review:
1. `execute_command → git rev-parse HEAD` on reviewer — must match doer's pushed HEAD SHA
2. If SHA doesn't match: run `git fetch origin && git reset --hard origin/<branch>` on reviewer, then re-verify

## Flow

1. Doer works, commits and pushes deliverables at every turn → STOPS at every VERIFY checkpoint

   **Doer session rules:**
   - **Start of each new phase:** use `resume=false`
   - **Within a phase:** resume is allowed

2. **PM handles git transport via `execute_command`** — never delegate to prompts:
   - Dev side: `git push origin <branch>` — verify push succeeded
   - Rev side: `git fetch origin && git checkout <branch> && git reset --hard origin/<branch>`

3. **PM dispatches REVIEWER at every VERIFY checkpoint** — PM never self-reviews. Most context docs are committed in repository. PM sends any other required background information  to reviewer via `send_files`. Then dispatches reviewer with `resume=false` (fresh session).

   **Reviewer workflow rules:**
   - **During planning stage prep reviewer in parallel while doer works** — send requirements, set up branch, start a context-reading session on reviewer. Use session resume to send updated docs at handoff when doer is ready.
   - **During execution phase**: for each new phase's review use `resume=false` for the reviewer.
   - **Verify SHA before dispatching review** — `execute_command → git rev-parse HEAD` on reviewer must match doer's pushed HEAD (see Pre-flight Checks above).

4. Reviewer reads deliverables + diff, conducts cumulative review (all phases up to current, not just the latest) per its agent context file. Commits findings to feedback.md, pushes, and outputs verdict: APPROVED or CHANGES NEEDED
5. PM reads verdict:
   - **APPROVED** → proceed to next phase (or sprint completion if all phases done)
   - **CHANGES NEEDED** → PM sends feedback to doer → doer fixes → back to step 1 → PM re-dispatches REVIEWER
6. Loop until all phases APPROVED
7. **Sprint completion** — See cleanup.md.

## Resume Rule

| Dispatch | resume |
|----------|--------|
| Initial plan generation | `false` |
| Plan revision (any feedback iteration) | `true` |
| Initial review dispatch | `false` |
| Re-review after CHANGES NEEDED + doer fixes | `true` |
| Role switch (doer → reviewer, or reviewer → doer) | `false` |
| After `stop_prompt` cancellation | `false` | Session state unreliable after kill; start fresh |
| After session timed out mid-grant | `true` | Fleet auto-recovers (stale-session retry), but member restarts without prior context |

**Note:** A role switch always requires sending the new agent context file before dispatch. Never resume across a role switch.

## Safeguards

| Safeguard | Trigger | PM Action | Limit |
|-----------|---------|-----------|-------|
| max_turns budget | Every `execute_prompt` dispatch | Session ends naturally at turn limit | Set per dispatch in `execute_prompt` |
| PM retry limit | Same dispatch fails (error, no output) | Retry up to 3×, then pause sprint + flag user | 3 retries per dispatch |
| Doer-reviewer cycle limit | Reviewer returns CHANGES NEEDED | Re-dispatch doer with feedback; if 3 cycles don't resolve all HIGH items, pause sprint + flag user | 3 cycles per phase |
| Model escalation | Zero progress after session resets | Reset session and resume; after 2 resets with zero progress: escalate model (cheap→standard→premium). Still zero after premium? Flag user | 2 resets per model tier |

**When to escalate to user:**
- After 3 retries on the same dispatch with no progress
- After 3 doer-reviewer cycles with unresolved HIGH items
- After premium model still shows zero progress after 2 resets

## Git as transport

- Doers commit: deliverables, PLAN.md, progress.json, project docs. When fixing review findings, doer also annotates feedback.md — adding `**Doer:** fixed in commit <sha> — <what changed>` under each addressed finding — then commits feedback.md. Doer never rewrites feedback.md content.
- Reviewers commit: feedback.md (full content — see tpl-reviewer.md for format)
- The member agent context file is NEVER committed — see `context-file.md`

## Permissions

Compose and deliver permissions per `permissions.md` (fleet skill). Recompose when switching roles (e.g. doer↔reviewer). Each provider gets its native permission config — `compose_permissions` handles the format automatically.

**Mid-sprint denial:** If a member is blocked by a permission denial, call `compose_permissions` with `grant: [<denied permission>]` and `project_folder` — this grants the missing permission, delivers the updated config, and appends to the ledger so future phases and sprints start with it already included. Then resume the member with `resume=true`. Never bypass by running the denied
command yourself via `execute_command`. Act on the grant promptly — the inactivity
timer (transport-level, applies to all providers) fires on stdout silence. If it fires
while you are composing permissions, `resume=true` still succeeds via stale-session
auto-recovery, but the member restarts without its in-progress context.

**Cancelling a running session:** Use `stop_prompt` when a member is working on the wrong
thing, stuck in a loop, or dispatched with incorrect instructions. Always follow immediately
with `resume=false` to start a clean session.

Note: `stop_prompt` (a fleet MCP tool) kills the member's LLM process. This is distinct from
stopping a background orchestration sub-task within the PM's own session — the latter mechanism
is harness-dependent and not a fleet concept.

## PM responsibilities

- Distribute work across pairs based on cohesion (high cohesion within a pair, loose coupling between pairs)
- Don't wait for user between doer and reviewer handoffs, autonomously keep progressing the project unless blockers are observed

