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

---

## T1: Member Registration

Register both members (doer and reviewer) as remote SSH members.
- Use `auth_type=key` — SSH keys are pre-configured on each machine.
- Work folder for each: `~/git/apra-fleet-e2e` (Linux/macOS) or `C:\Users\<user>\git\apra-fleet-e2e` (Windows)

After registering, provision LLM auth on each member:
- Provision Claude on both
- Provision Gemini on both

Verify both members appear online in `fleet_status`.

**Record:** Did both members register? Did all 4 auth provisions succeed? Are both online?

---

## T2: Basic Execution

Run `echo "e2e-ok-$(hostname)"` on each member via `execute_command`.
Verify each response contains the string `e2e-ok-`.

Send a small text file (create it with content `fleet-e2e-roundtrip`) to each member.
Receive it back. Verify the content is identical.

**Record:** Did commands execute on both members? Did file round-trip correctly for both?

---

## T3: Credential Store

Create a credential named `e2e_test_cred` with a dummy value via `credential_store_set`.
Verify it appears in `credential_store_list`.
Update its network policy to `confirm` via `credential_store_update`.
Verify the policy changed.
Delete it via `credential_store_delete`.
Verify it no longer appears in `credential_store_list`.

**Record:** Did all 4 CRUD operations succeed?

---

## T4: LLM Execution

Run `execute_prompt` on each member with this prompt:
> "What operating system are you running on? Reply in exactly one sentence."

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
3. Run `bd ready` in the toy repo (Beads task backlog committed in `.beads/`).
4. Pick the **three oldest open issues**.
5. Compose a `requirements.md` on the PM machine that lists those three issues, with one short paragraph per issue describing the desired outcome and acceptance criteria. Do NOT write any code yet.

### T5.3 — Drive the sprint with /pm
6. Invoke your `/pm` skill: pair the doer (already registered as a fleet member) with the reviewer
   (already registered), then run a **full doer → reviewer sprint to implement the contents of
   `requirements.md`**. The sprint must include:
   - planning phase (doer produces PLAN.md, reviewer reviews PLAN.md and writes feedback)
   - implementation phase (doer codes on branch `{{BRANCH_PREFIX}}/<short-slug>`, runs tests, commits, pushes)
   - code review phase (reviewer reads the diff, writes feedback)
   - fix phase if reviewer requests changes
   - PR phase (doer raises a PR targeting `main`)

### T5.4 — Verify
7. Confirm the branch `{{BRANCH_PREFIX}}/...` exists on origin and a PR was raised.
8. Verify CI is green on the PR.

**Record:** Was a PLAN.md produced and reviewed? Was the implementation pushed? Was the diff
reviewed and any feedback addressed? Was a PR raised? What is the PR URL? Is CI green?

---

> **T6 ALWAYS RUNS** — even if T5 failed, partially completed, or threw an error,
> proceed to T6 immediately and clean up. Do not skip cleanup.

## T6: Cleanup

Remove both members from fleet.
Verify `fleet_status` shows no registered members (or only the PM itself).

**Record:** Were both members removed cleanly?

---

## Final Report

Output ONLY the following JSON — no other text before or after it:

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
    { "test": "T5", "status": "PASS", "notes": "", "pr_url": "" },
    { "test": "T6", "status": "PASS", "notes": "" }
  ],
  "overall": "PASS"
}
```

Set each `status` to `"PASS"` or `"FAIL"` and fill in `notes` with a brief observation.
T6 must always have a status (PASS / FAIL based on whether members were actually removed). It is never "SKIPPED".
Set `overall` to `"FAIL"` if any test failed.
