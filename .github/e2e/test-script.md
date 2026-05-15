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

The orchestrator must coordinate the sprint using the PM skill. To ensure persistent access to /pm commands and tracking artifacts, coordination should be handled directly in the primary session. Do not delegate the high-level coordination loop to secondary agents.

Read @projects.md for active projects, then follow the pm skill.

CHECKPOINT: [{"test":"T5","status":"PASS","notes":"Sprint completed, PR raised and verified"}]

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
