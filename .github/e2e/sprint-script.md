# Fleet E2E Sprint Phase - {{SUITE_ID}}

Automated end-to-end test of the apra-fleet product, operating on the team's own test machines and the fleet-e2e-toy test repo.

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

## Members

- **doer** (name: `doer`, provider: {{DOER_PROVIDER}}, work folder: {{DOER_FOLDER}})
- **reviewer** (name: `reviewer`, provider: {{REVIEWER_PROVIDER}}, work folder: {{REVIEWER_FOLDER}})

## Rules

- Run every test in this phase even if earlier ones fail.
- After each test or state transition emit one line in this exact format (no backticks, no code block):
  CHECKPOINT: [{"test":"T5-...","status":"PASS","notes":"..."}]
  Always include every test completed so far **in this phase** in the array.

---

## T5: Sprint via /pm (Primary Session Only)

**FORBIDDEN**: You are strictly forbidden from using 'invoke_agent' or the 'Agent' tool for any part of T5. You MUST issue all /pm commands directly in this top-level conversation. Delegation to subagents is a violation of test protocol.

**MANDATORY**: You MUST call 'activate_skill(name="pm")' at the start of T5.3.

### T5.1 Setup Repo

On doer: clone toy repo into work folder if needed. Provision VCS auth ({{VCS}}).
After cloning, run `git fetch origin && git checkout main && git pull origin main` to ensure latest main.

CHECKPOINT: [{"test":"T5-repo-setup","status":"PASS","notes":"Toy repo cloned and VCS auth provisioned"}]

### T5.2 Discover Issues

Run `bd ready` on doer. Pick 3 issues. Write `requirements.md` into the run directory (current working directory).

CHECKPOINT: [{"test":"T5-repo-setup","status":"PASS","notes":"..."},{"test":"T5-discover","status":"PASS","notes":"3 issues selected from bd ready"}]

### T5.3 Drive Sprint

Call `activate_skill(name="pm")`.

CHECKPOINT: [{"test":"T5-repo-setup","status":"PASS","notes":"..."},{"test":"T5-discover","status":"PASS","notes":"..."},{"test":"T5-skill-loaded","status":"PASS","notes":"PM skill activated in primary session"}]

Issue PM commands:
```
/pm init fleet-e2e-toy
/pm pair doer reviewer
/pm plan fleet-e2e-toy
/pm start doer
```

Branch prefix: `{{BRANCH_PREFIX}}`

#### Poll Loop

Poll `/pm status doer` to track sprint progress.

- **Max poll iterations**: 20
- **Poll interval**: wait approximately 30 seconds between polls (use a brief pause or perform useful work between status checks)
- **Done conditions**:
  - `approved` -> sprint completed successfully, proceed to T5.4
  - `max-iterations` or iteration count reaches 20 -> CHECKPOINT FAIL with reason "poll timeout: sprint did not reach approved state within 20 iterations"

**State transitions and actions during polling**:
- When status shows `VERIFY` or `needs_review`: dispatch reviewer with `/pm start reviewer`
- When status shows `CHANGES_REQUESTED` or `needs_fix`: dispatch doer with `/pm start doer`
- When status shows `approved`: exit poll loop, sprint complete

CHECKPOINT at each state transition (append to array):
- On reviewer dispatch: add `{"test":"T5-review-dispatched","status":"PASS","notes":"reviewer dispatched at iteration N"}`
- On fix dispatch: add `{"test":"T5-fix-dispatched","status":"PASS","notes":"doer re-dispatched at iteration N"}`
- On approved: add `{"test":"T5-sprint-approved","status":"PASS","notes":"sprint approved at iteration N"}`
- On poll timeout: add `{"test":"T5-sprint-approved","status":"FAIL","notes":"poll timeout after 20 iterations, last state: <state>"}`

After sprint completes (or fails): `/pm cleanup fleet-e2e-toy`

### T5.4 Verify Branch and PR

Verify branch with prefix `{{BRANCH_PREFIX}}` exists on origin. Verify a PR was raised.

CHECKPOINT: append `{"test":"T5-pr-verified","status":"PASS","notes":"branch and PR confirmed on origin"}`

---

## Collect Session Logs

Throughout this phase you dispatched `execute_prompt` calls to members. Each response includes the session ID(s) used. Collect all session IDs per member from this phase AND the setup phase (session IDs from setup phase output are available in the run directory as raw-setup.txt).

For each session ID, the transcript path is deterministic:

**Claude**: `~/.claude/projects/<slug-of-work-folder>/<session-id>.jsonl`
where `<slug-of-work-folder>` is the work_folder path with `/` replaced by `-` and leading slash removed (e.g., `/home/user/fleet-work` becomes `home-user-fleet-work`).

<<GEMINI-TRANSCRIPT-PATH: pending gemini-specialist review>>

The script already knows each member's work_folder and session-id -- use the deterministic path directly. Do NOT use `find`, `locate`, or any recursive search.

Session files live outside the member's work_folder so `receive_files` cannot access them directly. For each session file, stage a temporary copy for transfer into the work folder, receive it, then remove the staged copy:

```bash
# Unix - stage temporary copy
cp ~/.claude/projects/<slug>/<session-id>.jsonl <work-folder>/<session-id>.jsonl
```
```powershell
# Windows - stage temporary copy
Copy-Item "$env:USERPROFILE\.claude\projects\<slug>\<session-id>.jsonl" "<work-folder>\<session-id>.jsonl"
```

Then `receive_files` the file from the work folder, and remove the staged copy afterward.

Receive into:
- Doer sessions -> `logs/doer/<session-id>.jsonl`
- Reviewer sessions -> `logs/reviewer/<session-id>.jsonl`

Skip files that do not exist on the member.
