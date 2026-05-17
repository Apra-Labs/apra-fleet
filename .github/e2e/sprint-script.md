# Fleet E2E Sprint Phase - {{SUITE_ID}}

Automated end-to-end test of the apra-fleet product, operating on the team's own test machines and the fleet-e2e-toy test repo.

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

## Members

- **doer** (name: `doer`, provider: {{DOER_PROVIDER}})
- **reviewer** (name: `reviewer`, provider: {{REVIEWER_PROVIDER}})

## Checkpoints

When you finish a step, print one line, exactly like this, as plain text (no code block, no backticks):

  CHECKPOINT: {"id":"T3-repo-setup","status":"PASS","notes":"one short note"}

- One line per step. One JSON object, not an array. Print it once.
- If a step fails, print it with `"status":"FAIL"` and move on to the next step.
- The steps are: `T3-repo-setup`, `T3-discover`, `T3-sprint`, `T3-pr-verified`, `T3-done`.
- Print `T3-done` last, only after the other four. If `T3-done` is missing, the phase failed.

---

## T3: Run a Sprint with /pm

Run a full sprint on the toy repo using the pm skill. Do all of it yourself in this conversation -- no sub-agents. Do not stop or wait for anyone: when a step finishes, start the next one.

### T3.1 Set up the repo

On the doer: clone {{TOY_PROJECT_URL}} into its work folder if needed, then `git fetch origin && git checkout main && git pull`. Provision {{VCS}} auth.

CHECKPOINT: {"id":"T3-repo-setup","status":"PASS","notes":"..."}

### T3.2 Pick the work

Run `bd ready` on the doer. Pick 3 P1 issues. Write `requirements.md` for them into the current working directory.

CHECKPOINT: {"id":"T3-discover","status":"PASS","notes":"..."}

### T3.3 Run the sprint

Activate the pm skill, then run:

```
/pm init fleet-e2e-toy
/pm pair doer reviewer
/pm plan fleet-e2e-toy using the doer
/pm start sprint
```

Branch prefix: `{{BRANCH_PREFIX}}`.

The pm skill runs the doer/reviewer loop. Follow it until the sprint is approved, then run `/pm cleanup fleet-e2e-toy`.

CHECKPOINT: {"id":"T3-sprint","status":"PASS","notes":"..."}

### T3.4 Check the result

Confirm a branch with prefix `{{BRANCH_PREFIX}}` exists on origin and a PR was raised.

CHECKPOINT: {"id":"T3-pr-verified","status":"PASS","notes":"..."}

### Done

Print this only after the four steps above are done:

CHECKPOINT: {"id":"T3-done","status":"PASS","notes":"sprint phase finished"}

---

## Collect Session Logs

Throughout this phase you will dispatch `execute_prompt` calls to members. Each response includes the session ID(s) used. Collect all session IDs per member from this phase AND the setup phase (session IDs from setup phase output are available in the run directory as raw-setup.txt).

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
