# Fleet E2E – {{SUITE_ID}}

PM: {{PM_OS}} / {{PM_PROVIDER}} | VCS: {{VCS}} | Toy: {{TOY_PROJECT_URL}}

## Members

| Role     | Name     | IP                | User  | Pass               | LLM                | Work Folder          |
|----------|----------|-------------------|-------|--------------------|--------------------|----------------------|
| doer     | doer     | {{DOER_HOST}}     | akhil | {{secure.APASS}}   | {{DOER_PROVIDER}}  | {{DOER_FOLDER}}      |
| reviewer | reviewer | {{REVIEWER_HOST}} | akhil | {{secure.APASS}}   | {{REVIEWER_PROVIDER}} | {{REVIEWER_FOLDER}} |

## Rules

- Run every test even if earlier ones fail.
- After each test emit one line: `CHECKPOINT: [{"test":"T1","status":"PASS","notes":"..."}]`
  Always include every test completed so far in the array.

---

## T1: Member Registration

Register both members (`auth_type=password`, credentials from table). After each: `update_member unattended="auto"`.

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

On each member: `echo "e2e-ok-$(hostname)"` — verify `e2e-ok-` in response.
Send a file containing `fleet-e2e-roundtrip` to each member, receive it back, verify content matches.

---

## T3: Credential Store

On pm (here)
1. **Create** — `echo "e2e-dummy-value" | $HOME/.apra-fleet/bin/apra-fleet secret --set e2e_test_cred --persist -y`
2. **Read** — `credential_store_list` → verify `e2e_test_cred` present.
3. **Update** — `credential_store_update name="e2e_test_cred" network_policy="confirm"` → verify via list.
4. **Delete** — `credential_store_delete name="e2e_test_cred"` → verify absent.

---

## T4: LLM Execution

On each member `execute_prompt` with `model="cheap"`: `"What OS are you running on? Reply in one sentence."`
Verify response names the correct OS (doer: {{DOER_OS}}, reviewer: {{REVIEWER_OS}}).

---

## T5: Sprint via /pm

**T5.1** On doer: clone toy repo into work folder if needed. Provision VCS auth ({{VCS}}).
If `bitbucket`: `git config user.email {{secure.e2e_bb_user}}` in repo dir.

**T5.2** Run `bd ready` on doer from within the repo dir with explicit PATH:
```
cd {{DOER_FOLDER}}/fleet-e2e-toy && PATH=$HOME/bin:$HOME/.local/bin:$PATH bd ready
```
Pick the **3 oldest open issues**. Write `requirements.md` on PM (one paragraph per issue, acceptance criteria, no code).

**T5.3** Drive sprint:
```
/pm init fleet-e2e-toy
/pm pair doer reviewer
/pm plan fleet-e2e-toy
/pm start doer
```
Poll `/pm status doer` until VERIFY, then dispatch reviewer. Continue fix→review loop until approved. Then `/pm cleanup fleet-e2e-toy`.
Branch prefix: `{{BRANCH_PREFIX}}`

**T5.4** Verify branch `{{BRANCH_PREFIX}}/...` exists on origin, PR was raised, CI is green.

---

## Collect session logs

On each member:
```
LOG=$(find ~/.claude/projects -name "*.jsonl" 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
[ -n "$LOG" ] && cp "$LOG" session-log.jsonl || true
```
`receive_files`: doer → `logs/doer-session.jsonl`, reviewer → `logs/reviewer-session.jsonl`. Skip if absent.
