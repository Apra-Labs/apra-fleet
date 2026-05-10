# Fleet E2E Test Run

You are a Fleet PM running an automated end-to-end test of apra-fleet.

**Your environment:**
- PM machine: {{PM_OS}} (this machine)
- PM provider: {{PM_PROVIDER}}
- Doer member: {{DOER_HOST}} ({{DOER_OS}}) — provider: {{DOER_PROVIDER}}
- Reviewer member: {{REVIEWER_HOST}} ({{REVIEWER_OS}}) — provider: {{REVIEWER_PROVIDER}}
- Toy project: {{TOY_PROJECT_URL}} ({{VCS}})
- Fleet version: call the `version` tool to get this

All SSH credentials and LLM API keys are pre-stored in the fleet credential store.
Use `{{secure.NAME}}` references as needed. Do NOT ask for any passwords or tokens.

For each test section below:
1. Execute the steps using fleet tools
2. Record your observation as either ✅ PASS or ❌ FAIL with a brief note
3. Continue to the next test even if a test fails — do not stop early
4. After recording each test result, emit **one line** in this exact format (no surrounding text):
   `CHECKPOINT: [{"test":"T1","status":"PASS","notes":"..."}]`
   Include every test completed so far. The workflow reads CHECKPOINT lines to recover partial
   results if the run is interrupted before the Final Report.

---

## T1: Member Registration

Register both members (doer and reviewer) as remote SSH members.
- Use `auth_type=password` with password credential `{{secure.APASS}}` — this is the SSH password for the `akhil` user on all member machines.
- Work folder for doer ({{DOER_OS}}): `{{DOER_FOLDER}}`
- Work folder for reviewer ({{REVIEWER_OS}}): `{{REVIEWER_FOLDER}}`
- After registering each member, immediately call `update_member` with `unattended="auto"` so the
  member's LLM can approve its own tool calls without pausing to prompt.

After registering, provision LLM auth on each member:
- Always provision Claude on both members.
- Provision Gemini on a member **only if** that member's provider (shown above) is `gemini`. Skip Gemini provisioning for members whose provider is `claude`.

Verify both members appear online in `fleet_status`.

After provisioning, verify `bd` is available on each member via `execute_command`:
```
which bd 2>/dev/null || find ~/.nvm -name bd -type f 2>/dev/null | head -1
```
If not found, install it: `npm install -g @beads/bd`
Also verify `dolt` is available: `which dolt 2>/dev/null || ~/bin/dolt version 2>/dev/null || dolt version 2>/dev/null`
If dolt is missing, install it without sudo and persist the PATH:
```
mkdir -p ~/bin
curl -fsSL -o /tmp/dolt.tar.gz https://github.com/dolthub/dolt/releases/latest/download/dolt-linux-amd64.tar.gz
tar -xzf /tmp/dolt.tar.gz -C /tmp/
mv /tmp/dolt-linux-amd64/bin/dolt ~/bin/dolt
chmod +x ~/bin/dolt
grep -q 'HOME/bin' ~/.profile 2>/dev/null || echo 'export PATH=$HOME/bin:$PATH' >> ~/.profile
~/bin/dolt version
```
(Use `dolt-darwin-arm64.tar.gz` or `dolt-darwin-amd64.tar.gz` on macOS.)

**Record:** Did both members register? Did all 4 auth provisions succeed? Are both online? Is bd available on both?

---

## T2: Basic Execution

Run `echo "e2e-ok-$(hostname)"` on each member via `execute_command`.
Verify each response contains the string `e2e-ok-`.

Send a small text file (create it with content `fleet-e2e-roundtrip`) to each member.
Receive it back. Verify the content is identical.

**Record:** Did commands execute on both members? Did file round-trip correctly for both?

---

## T3: Credential Store

Test the fleet credential store CRUD operations. Because `credential_store_set` opens a browser
window that cannot be used in headless CI, use the fleet CLI via `execute_command` on the PM's
own local member (or via any `execute_command` that runs locally) to seed the test credential,
then exercise the MCP tools for the remaining operations.

1. **Create** — run `execute_command` on a member with:
   ```
   echo "e2e-dummy-value" | apra-fleet secret --set e2e_test_cred --persist -y
   ```
   (If `apra-fleet` is not on PATH, use the full path `$HOME/.apra-fleet/bin/apra-fleet`.)
2. **Read** — call `credential_store_list` and verify `e2e_test_cred` appears.
3. **Update** — call `credential_store_update` with `name="e2e_test_cred"` and `network_policy="confirm"`.
   Verify the policy changed by calling `credential_store_list` again.
4. **Delete** — call `credential_store_delete` with `name="e2e_test_cred"`.
   Verify it no longer appears in `credential_store_list`.

**Record:** Did all 4 CRUD operations succeed?

---

## T4: LLM Execution

Run `execute_prompt` on each member with this prompt:
> "What operating system are you running on? Reply in exactly one sentence."

Use `model="cheap"` for both calls — this is a trivial query and does not need a premium model.

Verify each response names the correct OS ({{DOER_OS}} and {{REVIEWER_OS}}).

**Record:** Did both prompts execute? Did each response name the correct OS?

---

## T5: Full Sprint via /pm skill

The toy project is at {{TOY_PROJECT_URL}}.

### T5.1 — Doer prep
1. On the doer: clone the toy repo into the work folder if not already cloned.
2. Provision VCS auth ({{VCS}}) on the doer.
   If VCS is `bitbucket`: also run `git config user.email {{secure.e2e_bb_user}}` in the
   repo via `execute_command`.

### T5.2 — Pick three issues, write requirements.md
3. Run `bd ready` on the doer via `execute_command` from within the toy repo directory,
   with an explicit PATH so dolt is found:
   ```
   cd <doer_work_folder>/fleet-e2e-toy && PATH=$HOME/bin:$HOME/.local/bin:$PATH bd ready
   ```
   If `bd` itself is not on PATH, substitute the full bd path found in T1.
4. Pick the **three oldest open issues** from the output.
5. Compose `requirements.md` on the PM machine listing those three issues — one short paragraph
   per issue describing the desired outcome and acceptance criteria. Do NOT write any code yet.

### T5.3 — Drive the sprint with /pm
6. Run these `/pm` skill commands in sequence to drive the full sprint:
   - `/pm init fleet-e2e-toy` — initialise the project folder
   - `/pm pair <doer-member-name> <reviewer-member-name>` — set up doer/reviewer roles
   - `/pm plan fleet-e2e-toy` — generate and approve the plan (reads `requirements.md`)
   - `/pm start <doer-member-name>` — dispatch the doer to implement
   - Poll `/pm status <doer-member-name>` until the doer reaches a VERIFY checkpoint, then immediately dispatch the reviewer
   - Continue the loop (fix → review → fix as needed) until the reviewer approves
   - `/pm cleanup fleet-e2e-toy` — raise the PR

   Use `{{BRANCH_PREFIX}}` as the branch prefix when the pm skill asks for one.

### T5.4 — Verify
7. Confirm the branch `{{BRANCH_PREFIX}}/...` exists on origin and a PR was raised.
8. Verify CI is green on the PR.

**Record:** Was a PLAN.md produced and reviewed? Was the implementation pushed? Was the diff
reviewed and any feedback addressed? Was a PR raised? What is the PR URL? Is CI green?

---

## Final Report

Before T6 teardown runs as a separate workflow step, collect the member session logs:

1. On each member via `execute_command`:
   ```
   LOG=$(find ~/.claude/projects -name "*.jsonl" 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
   [ -n "$LOG" ] && cp "$LOG" session-log.jsonl || true
   ```
2. Use `receive_files` to pull `session-log.jsonl` from each member's work folder:
   - Doer → local `logs/doer-session.jsonl`
   - Reviewer → local `logs/reviewer-session.jsonl`
   - Skip silently if the file is absent.

Then output ONLY the following JSON — no other text before or after it:

```json
{
  "run": {
    "suite": "{{SUITE_ID}}",
    "pm_os": "{{PM_OS}}",
    "pm_provider": "{{PM_PROVIDER}}",
    "fleet_version": "<from version tool>",
    "timestamp": "<ISO timestamp>"
  },
  "results": [
    { "test": "T1", "status": "PASS", "notes": "" },
    { "test": "T2", "status": "PASS", "notes": "" },
    { "test": "T3", "status": "PASS", "notes": "" },
    { "test": "T4", "status": "PASS", "notes": "" },
    { "test": "T5", "status": "PASS", "notes": "", "pr_url": "" }
  ],
  "overall": "PASS"
}
```

Set each `status` to `"PASS"` or `"FAIL"` and fill in `notes` with a brief observation.
Set `overall` to `"FAIL"` if any test failed.
