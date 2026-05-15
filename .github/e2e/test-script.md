# Fleet E2E - {{SUITE_ID}}

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

## Members

| Role     | Name     | IP                | User  | Pass               | LLM                | Work Folder          |
|----------|----------|-------------------|-------|--------------------|--------------------|----------------------|
| doer     | doer     | {{DOER_HOST}}     | {{DOER_USER}} | {{secure.E2E_ACRED}}   | {{DOER_PROVIDER}}  | {{DOER_FOLDER}}      |
| reviewer | reviewer | {{REVIEWER_HOST}} | {{REVIEWER_USER}} | {{secure.E2E_ACRED}}   | {{REVIEWER_PROVIDER}} | {{REVIEWER_FOLDER}} |

## Rules

- Run every test even if earlier ones fail.
- After each test emit one line in this exact format (no backticks, no code block):
  CHECKPOINT: [{"test":"T1","status":"PASS","notes":"..."}]
  Always include every test completed so far in the array.

---

## T1: Member Registration

Register both members. For each:
- If `host` is `"local"`: `register_member(member_name=..., work_folder=...)` - no host/username/password needed.
- If `host` is an IP address: `register_member(member_name=..., host=..., username=..., password={{secure.E2E_ACRED}}, auth_type="password", work_folder=...)`

After each: `update_member unattended="auto"`.

Provision LLM AUTH on both members.

Verify both online in `fleet_status`.

On each member verify `bd`: `which bd 2>/dev/null || find ~/.nvm -name bd -type f 2>/dev/null | head -1`
If missing: `npm install -g @beads/bd`

Verify `dolt`: `which dolt 2>/dev/null || ~/bin/dolt version 2>/dev/null`
If missing:
```
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/')
mkdir -p ~/bin
curl -fsSL -o /tmp/dolt.tar.gz https://github.com/dolthub/dolt/releases/latest/download/dolt-${OS}-${ARCH}.tar.gz
tar -xzf /tmp/dolt.tar.gz -C /tmp/ && mv /tmp/dolt-${OS}-${ARCH}/bin/dolt ~/bin/ && chmod +x ~/bin/dolt
grep -q 'HOME/bin' ~/.profile 2>/dev/null || echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
~/bin/dolt version
```

---

## T2: Basic Execution

On each member: `echo "e2e-ok-$(hostname)"` - verify `e2e-ok-` in response.
Send a file containing `fleet-e2e-roundtrip` to each member, receive it back, verify content matches.

---

## T4: LLM Execution

On each member `execute_prompt` with `model="cheap"`: `"What OS are you running on? Reply in one sentence."`
Verify response names the correct OS (doer: {{DOER_OS}}, reviewer: {{REVIEWER_OS}}).

---

## T5: Sprint via /pm

**CRITICAL REQUIREMENT**: You MUST use the PM skill via `activate_skill(name="pm")` for ALL sprint operations.
Single-turn implementations are FORBIDDEN. The Doer MUST operate under the PM workflow with proper planning and progress tracking artifacts.
The Doer MUST produce `PLAN.md` and `progress.json` in the repo directory before writing any implementation code.
DO NOT delegate the /pm loop to subagents. The PM skill MUST be driven directly in this conversation -- no `Agent(...)` calls for PM commands.

**T5.1** On doer: clone toy repo into work folder if needed. Provision VCS auth ({{VCS}}).
If `bitbucket`: `git config user.email {{secure.e2e_bb_user}}` in repo dir.
After cloning (or if repo already exists), run `git fetch origin && git checkout main && git pull origin main` inside the repo dir to ensure the sprint starts from the latest main.

**T5.2** Run `bd list --label e2e-testing` on doer from within the repo dir with explicit PATH:
```
cd {{DOER_FOLDER}}/fleet-e2e-toy && PATH=$HOME/bin:$HOME/.local/bin:$PATH bd list --label e2e-testing --status=open --sort priority --pretty
```
Pick the **3 highest-priority open issues** (P1 before P2, alpha within same priority). Write `requirements.md` on PM (one paragraph per issue, acceptance criteria, no code).

**T5.3** Drive sprint using the PM skill. You MUST call `activate_skill(name="pm")` before issuing any PM commands:

Step 1 - Initialize:
```
activate_skill(name="pm")
/pm init fleet-e2e-toy
/pm pair doer reviewer
```

Step 2 - Plan (MANDATORY - do NOT skip or combine with start):
```
/pm plan fleet-e2e-toy
```
Wait for the plan to complete. Verify that `PLAN.md` and `progress.json` exist in the doer's repo directory by running:
```
execute_command(member_name="doer", command="ls -la {{DOER_FOLDER}}/fleet-e2e-toy/PLAN.md {{DOER_FOLDER}}/fleet-e2e-toy/progress.json")
```
Both files MUST exist before proceeding. If either is missing, re-run `/pm plan fleet-e2e-toy`.

Verify `tracker_*` tools were called during planning. Check the PM log for calls to `tracker_create`, `tracker_update`, or similar `tracker_*` tools. If none are present, the plan did not use proper workflow tracking -- treat T5 as FAIL.

CHECKPOINT: [{"test":"T5-planning","status":"PASS","notes":"PLAN.md and progress.json confirmed on doer; tracker_* tools seen in PM log"}]

Step 3 - Implement (only after T5-planning checkpoint above):
```
/pm start doer
```
Poll `/pm status doer` until doer reaches VERIFY status.

CHECKPOINT: [{"test":"T5-doer","status":"PASS","notes":"Doer reached VERIFY; implementation committed on branch"}]

Dispatch reviewer and continue fix->review loop until approved.

CHECKPOINT: [{"test":"T5-reviewer","status":"PASS","notes":"Reviewer APPROVED; PR raised"}]

Then `/pm cleanup fleet-e2e-toy`.
Branch prefix: `{{BRANCH_PREFIX}}`

**T5.4** Verify branch `{{BRANCH_PREFIX}}/...` exists on origin, PR was raised, CI is green.

---

## Collect session logs

Throughout T1-T5 you will have dispatched one or more `execute_prompt` calls to each member. Each response includes the session ID(s) used. Collect all session IDs per member.

For each session ID, locate the file on the member using the appropriate shell command:

**Unix (Linux/macOS) - Claude:**
```bash
find ~/.claude/projects -name "<session-id>.jsonl" 2>/dev/null
```
**Unix (Linux/macOS) - Gemini:**
```bash
find ~/.gemini -name "<session-id>.jsonl" 2>/dev/null
```
**Windows - Claude:**
```powershell
Get-ChildItem "$env:USERPROFILE\.claude\projects" -Filter "<session-id>.jsonl" -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
```
**Windows - Gemini:**
```powershell
Get-ChildItem "$env:USERPROFILE\.gemini" -Filter "<session-id>.jsonl" -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
```

Run the relevant command(s) on the member via `execute_command` to get the absolute path(s).

Session files live outside the member's work_folder so `receive_files` cannot access them directly. For each session file, copy it into the work folder first, receive it, then remove the copy:

```bash
# Unix
cp <session-path> <work-folder>/<session-id>.jsonl
```
```powershell
# Windows
Copy-Item "<session-path>" "<work-folder>\<session-id>.jsonl"
```

Then `receive_files` the file from the work folder, and delete the copy afterward:
```bash
rm <work-folder>/<session-id>.jsonl
```

Receive into:
- Doer sessions -> `logs/doer/<session-id>.jsonl`
- Reviewer sessions -> `logs/reviewer/<session-id>.jsonl`

Skip files that don't exist on the member.
