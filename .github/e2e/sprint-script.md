# Fleet E2E Sprint Phase - {{SUITE_ID}}

Automated end-to-end test of the apra-fleet product, operating on the team's own test machines and the fleet-e2e-toy test repo.

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

## Members

- **doer** (name: `doer`, provider: {{DOER_PROVIDER}})
- **reviewer** (name: `reviewer`, provider: {{REVIEWER_PROVIDER}})

> [!IMPORTANT]
> Do NOT print CHECKPOINT lines as plain text -- that causes agy to exit. Instead, record each checkpoint by running a command (see below). After recording, immediately continue to the next task without any text-only response.

## Checkpoints

Record each checkpoint by running this command (works on Linux, macOS, and Windows):

```bash
node -e "const fs=require('fs');fs.appendFileSync('checkpoints.json',JSON.stringify({id:'T3-repo-setup',status:'PASS',notes:'one short note'})+'\n')"
```

- One JSON object per line appended to `checkpoints.json` in the current working directory.
- If a step fails, write `status:'FAIL'` and continue to the next step.
- The steps are: `T3-repo-setup`, `T3-discover`, `T3-sprint`, `T3-pr-verified`, `T3-done`.
- After writing each checkpoint, immediately continue to the next task -- no pausing, no text summary.
- Write `T3-done` last. If it is missing from `checkpoints.json` after the session, the phase failed.

---

## T3: Run a Sprint with /pm

Run a full sprint on the toy repo using the pm skill. Do all of it yourself in this conversation -- no sub-agents. Do not stop or wait for anyone: when a step finishes, start the next one.

### T3.1 Set up the repo

On the doer: clone {{TOY_PROJECT_URL}} into its work folder if needed, then `git fetch origin && git checkout main && git pull`. Provision {{VCS}} auth.

Record checkpoint:
```bash
node -e "const fs=require('fs');fs.appendFileSync('checkpoints.json',JSON.stringify({id:'T3-repo-setup',status:'PASS',notes:'your note here'})+'\n')"
```
Then immediately continue to T3.2.

### T3.2 Pick the work

Work on exactly this one issue: `gh-toy-4ef` (Add --version flag to CLI). Write `requirements.md` for this issue only into the current working directory. Do NOT pick additional issues or run `bd ready`.

Record checkpoint:
```bash
node -e "const fs=require('fs');fs.appendFileSync('checkpoints.json',JSON.stringify({id:'T3-discover',status:'PASS',notes:'your note here'})+'\n')"
```
Then immediately continue to T3.3.

### T3.3 Run the sprint

Activate the pm skill.

Before running any `/pm` commands, read `projects.md` in the current directory:
- If `fleet-e2e-toy` already appears in the table with Phase 1 or later and status "active", **skip `/pm init`, `/pm pair`, and `/pm plan`** -- the plan is already done. Go directly to `/pm start doer`.
- If `fleet-e2e-toy` is not present, run the full sequence:

```
/pm init fleet-e2e-toy
/pm pair doer reviewer
/pm plan fleet-e2e-toy using the doer
/pm start doer
```

Branch prefix: `{{BRANCH_PREFIX}}`.

The pm skill runs the doer/reviewer loop. Drive it yourself:
1. Dispatch the doer with `execute_prompt`. Wait for its response.
2. Read the doer's response (it will be in the `execute_prompt` result). If it says VERIFY or requests review, dispatch the reviewer.
3. Read the reviewer's response. If the reviewer requests changes, dispatch the doer again. Repeat until the reviewer explicitly approves.
4. A reviewer approval means the reviewer's response contains words like "approved", "LGTM", or "no changes needed". If `execute_prompt` returns empty or an error, re-dispatch.
5. Once approved, run `/pm cleanup fleet-e2e-toy`.

Do NOT record T3-sprint PASS until you have confirmed a reviewer approval response in the execute_prompt result (not just dispatched -- you must read the response).

Record checkpoint:
```bash
node -e "const fs=require('fs');fs.appendFileSync('checkpoints.json',JSON.stringify({id:'T3-sprint',status:'PASS',notes:'your note here'})+'\n')"
```
Then immediately continue to T3.4.

### T3.4 Check the result

Confirm a branch with prefix `{{BRANCH_PREFIX}}` exists on origin and a PR was raised.

Record checkpoint:
```bash
node -e "const fs=require('fs');fs.appendFileSync('checkpoints.json',JSON.stringify({id:'T3-pr-verified',status:'PASS',notes:'your note here'})+'\n')"
```
Then record T3-done:
```bash
node -e "const fs=require('fs');fs.appendFileSync('checkpoints.json',JSON.stringify({id:'T3-done',status:'PASS',notes:'sprint phase finished'})+'\n')"
```

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
