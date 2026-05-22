# Fleet E2E Sprint Phase - {{SUITE_ID}}

Automated end-to-end test of the apra-fleet product, operating on the team's own test machines and the fleet-e2e-toy test repo.

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

## Members

- **doer** (name: `doer`, provider: {{DOER_PROVIDER}})
- **reviewer** (name: `reviewer`, provider: {{REVIEWER_PROVIDER}})

> [!IMPORTANT]
> If you are running in non-interactive print mode (e.g. through a CI runner or using the `-p` / `--print` flags) and are waiting for a background task or moving to the next checkpoint, you MUST execute a tool call (such as a status check command or reading progress files) in every intermediate turn. Do not return a text-only response until the entire script/phase/task is fully completed.

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
/pm start doer
```

Branch prefix: `{{BRANCH_PREFIX}}`.

The pm skill runs the doer/reviewer loop. After `/pm start doer`, keep driving that loop yourself: when the doer reaches review, dispatch the reviewer; when the reviewer asks for changes, dispatch the doer again. Repeat until the reviewer approves, then run `/pm cleanup fleet-e2e-toy`. Do not stop until the sprint is approved.

CHECKPOINT: {"id":"T3-sprint","status":"PASS","notes":"..."}

### T3.4 Check the result

Confirm a branch with prefix `{{BRANCH_PREFIX}}` exists on origin and a PR was raised.

CHECKPOINT: {"id":"T3-pr-verified","status":"PASS","notes":"..."}

### Done

Print this only after the four steps above are done:

CHECKPOINT: {"id":"T3-done","status":"PASS","notes":"sprint phase finished"}

---

## Collect Session Logs

During this phase you dispatched `execute_prompt` calls to members. Each response gives you the session ID it used. Collect every session ID per member, from this phase and the setup phase (setup-phase session IDs are in the run directory as `raw-setup.txt`).

Each member's transcript file lives in the LLM's own log directory. How you find it depends on the member's provider.

**Claude member -- the path is exact:**

`~/.claude/projects/<slug>/<session-id>.jsonl`

`<slug>` is the member's work_folder with every `/` (or `\` on Windows) replaced by `-` and any leading slash dropped. Example: `/home/user/fleet-work` becomes `home-user-fleet-work`.

**Gemini member -- match on the session ID:**

`~/.gemini/tmp/*/chats/session-*-<id8>.jsonl`

`<id8>` is the first 8 characters of the session ID. Gemini does not name the file by work_folder or by the full ID, so list that glob -- the 8-character ID prefix identifies the file uniquely.

Use the exact path (Claude) or the glob (Gemini). Do NOT run a recursive search (`find`, `locate`) -- a single fixed-depth glob in the directory above is all that is needed.

Session files live outside the member's work_folder, so `receive_files` cannot reach them directly. For each file: copy it into the member's work_folder, `receive_files` it, then delete the copy.

```bash
# Unix
cp <transcript-path> <work-folder>/<session-id>.jsonl
```
```powershell
# Windows
Copy-Item "<transcript-path>" "<work-folder>\<session-id>.jsonl"
```

Receive into:
- Doer sessions -> `logs/doer/<session-id>.jsonl`
- Reviewer sessions -> `logs/reviewer/<session-id>.jsonl`

Skip any session whose file does not exist on the member.
