# Secure Variable (`{{secure.NAME}}`) — Fit Tests & Use Cases

`{{secure.NAME}}` tokens are resolved server-side before execution. The plaintext secret never appears in chat, logs, or LLM context. Only specific tool parameters support resolution — see the supported fields table below.

## Supported Fields

| Tool | Parameter | Notes |
|------|-----------|-------|
| `register_member` | `password` | SSH password for remote member registration |
| `update_member` | `password` | SSH password update |
| `provision_vcs_auth` | `token`, `api_token`, `pat` | GitHub PAT, Bitbucket token, Azure DevOps PAT |
| `execute_command` | `command` | Only when referencing a credential-store-aware field |

> **WARNING**: `{{secure.NAME}}` only resolves in the fields listed above. Using it in any other parameter (e.g. a prompt, a path field) passes the literal string through — the secret is NOT injected.

---

## Test Cases

### Test 1 — Register remote member with SSH password ✅

**Date:** 2026-05-07  
**Tool:** `register_member`  
**Field:** `password`

**Setup:**
- Secret `MyFavPass` stored persistently via `apra-fleet secret --set MyFavPass --persist`
- Remote member `fleet-rev` at `192.168.1.13`, user `akhil`

**Call:**
```json
{
  "friendly_name": "fleet-rev",
  "member_type": "remote",
  "host": "192.168.1.13",
  "username": "akhil",
  "work_folder": "/Users/akhil/git/apra-fleet",
  "auth_type": "password",
  "password": "{{secure.MyFavPass}}"
}
```

**Result:** ✅ Member registered successfully. SSH connection established (533ms latency). Secret resolved server-side — never appeared in chat or logs.

**Notes:** After registration, `setup_ssh_key` was used to migrate to key-based auth, making the password credential no longer needed for subsequent connections.

---

### Test 2 — Register remote member with non-existent secret ❌

**Date:** 2026-05-07  
**Tool:** `register_member`  
**Field:** `password`

**Setup:**
- Secret `MyFavPass` NOT yet in credential store (first attempt earlier in session)

**Call:**
```json
{
  "password": "{{secure.MyFavPass}}"
}
```

**Result:** ❌ `Credential "MyFavPass" not found. Run credential_store_set first. Member was NOT registered.`

**Notes:** Fleet fails fast with a clear error. Member is NOT partially registered — the operation is atomic.

---

### Test 3 — Anonymous OOB password (use-and-throw) ❌ BROKEN

**Issue:** `apra-fleet-projects-61g`  
**Tool:** `register_member`  
**Field:** `password` (omitted)

**Setup:** Remote member, `auth_type=password`, no `password` field provided.

**Call:**
```json
{
  "friendly_name": "lin-test",
  "member_type": "remote",
  "host": "192.168.1.102",
  "username": "akhil",
  "work_folder": "~/git/gemini-test",
  "llm_provider": "claude",
  "auth_type": "password"
}
```

**Expected:** OOB terminal opens, user enters password, SSH connection made, password discarded (never stored). Use-and-throw — no credential created.

**Actual:** ❌ OOB window does not open. Registration proceeds without password and likely fails SSH auth silently or errors without prompting.

**Notes:** Regression from older versions where omitting `password` triggered OOB collection automatically.

---

### Test 4 — Named credential auto-create via OOB (planned)

**Issue:** `apra-fleet-projects-61g` (Case 2)  
**Tool:** `register_member`  
**Field:** `password: "{{secure.MyLinPass}}"` where `MyLinPass` does NOT exist

**Call:**
```json
{
  "friendly_name": "lin-test",
  "member_type": "remote",
  "host": "192.168.1.102",
  "username": "akhil",
  "work_folder": "~/git/gemini-test",
  "auth_type": "password",
  "password": "{{secure.MyLinPass}}"
}
```

**Expected:**
1. Fleet detects `MyLinPass` is not in the store
2. OOB terminal opens: "Enter value for MyLinPass"
3. Fleet prompts: "Persist this secret? (y/n)"
4. If yes → stored as persistent credential under `MyLinPass`; if no → session-only
5. SSH proceeds using collected value
6. Member registered successfully

**Actual:** ❌ Returns `Credential "MyLinPass" not found` immediately. No OOB prompt, no auto-create.

---

### Test 5 — SSH auth failure retry loop (planned)

**Issue:** `apra-fleet-projects-61g` (Case 3)  
**Tool:** `register_member`  
**Scenario:** Wrong password entered in OOB → SSH login fails → re-prompt rather than hard error

**Expected flow:**
1. OOB password collected (Cases 1 or 2)
2. SSH connect attempted → auth failure
3. Fleet re-opens OOB: "SSH login failed. Try a different username/password?"
4. User can correct username and/or re-enter password
5. Loop until success or user cancels

**Actual:** ❌ Not implemented — hard error returned, member not registered.

---

### Test 6 — Scope secret to specific member (planned)

**Tool:** `register_member` + `credential_store_set`  
**Scenario:** Store a secret scoped to `fleet-rev` only, verify another member cannot resolve it.

---

### Test 7 — Secret with TTL expiry (planned)

**Tool:** `register_member`  
**Scenario:** Store a secret with `ttl_seconds=60`, wait for expiry, attempt to use it — expect `expired` error.

---

### Test 8 — Secret in unsupported field — negative test (planned)

**Tool:** `execute_prompt`  
**Scenario:** Pass `{{secure.MyFavPass}}` in the `prompt` field — verify the literal string `{{secure.MyFavPass}}` appears rather than the resolved value (i.e. no injection).

---

### Test 9 — Provision VCS auth with PAT from credential store (planned)

**Tool:** `provision_vcs_auth`  
**Field:** `token`  
**Scenario:** Store a GitHub PAT as a secret, provision VCS auth using `{{secure.github_pat}}`.

---

### Test 10 — Update member SSH password via credential store (planned)

**Tool:** `update_member`  
**Field:** `password`  
**Scenario:** Rotate SSH password — store new value, call `update_member` with `{{secure.new_pass}}`.

---

## Observations

- Delivery vs. persistence: Running `apra-fleet secret --set NAME` without `--persist` delivers to a waiting OOB request but does NOT store in the vault. `{{secure.NAME}}` requires vault storage — use `--persist`.
- `credential_store_set` **blocks** — when called, the tool opens an OOB terminal and waits synchronously for the user to enter the secret. It does not return a "Waiting..." intermediate status or require a second call. On success it returns `✓ NAME stored [session/persistent]. Use {{secure.NAME}} in commands.`
- Failed resolution is always explicit — the tool returns an error and aborts. No silent pass-through of the token string.

## CI / Non-Interactive Usage

For CI pipelines or scripts where interactive input is unavailable, use the `-y` flag with `apra-fleet secret --set` to read the value from stdin instead of opening an OOB terminal:

```bash
# Store a secret non-interactively (value from stdin)
echo "$TOKEN" | apra-fleet secret --set github_pat --persist -y

# Pipe from a file or command substitution
cat ~/.token | apra-fleet secret --set deploy_key --persist -y
```

The `-y` flag bypasses OOB terminal launch entirely — the value is read from stdin and stored directly. This is safe in CI because stdin is already a controlled, non-LLM channel. The same success message is returned: `✓ github_pat stored [persistent]. Use {{secure.github_pat}} in commands.`
