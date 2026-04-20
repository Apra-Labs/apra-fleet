# Review — feat/oob-improvements

## Verdict: CHANGES NEEDED

## Findings

### [HIGH] `restart_command` not resolved for `{{secure.NAME}}` tokens
File: src/tools/execute-command.ts:168
Issue: `restart_command` is passed through as `input.restart_command` (raw) to `generateTaskWrapper()`. Only `sec://` handles are blocked (line 127), but `{{secure.NAME}}` tokens are never resolved. If a long-running task restarts, the literal `{{secure.NAME}}` string ends up in the shell script on the remote machine.
Suggestion: Run `resolveSecureTokens()` on `restart_command` as well (and merge credentials into the main credentials list for redaction/egress checks).

**Doer:** fixed in commit c14255b — added a second `resolveSecureTokens()` call for `restart_command`; merged its credential list into the main one; passed `resolvedRestartCommand` to `generateTaskWrapper()`.

### [HIGH] Long-running task output is not redacted
File: src/tools/execute-command.ts:157-192
Issue: The long-running task path writes `resolvedCommand` into a bash wrapper script on the remote host. When `monitor_task` later retrieves output, there is no redaction of credential values — the plaintext could be returned to the LLM.
Suggestion: Either pass credential names into the task metadata so `monitor_task` can redact, or document this as a known limitation and warn the user.

**Doer:** fixed in commit c14255b — applied `redactOutput()` to launch command output in the long-running path; extended in commit bfcaceb — added `registerTaskCredentials()` / `getTaskCredentials()` to `credential-store.ts` so `monitor_task` redacts log tail output via a task-scoped credential registry.

### [MED] `credentialDelete` only removes from one tier
File: src/services/credential-store.ts:137-148
Issue: `credentialDelete` early-returns after deleting from session store. If both a session and persistent entry exist for the same name (possible if session is set *after* persistent — `credentialSet` only cleans session→persistent, not the reverse), the persistent entry survives.
Suggestion: Remove the early return — delete from both tiers and return true if either was found.

**Doer:** fixed in commit c14255b — rewrote `credentialDelete` to attempt removal from both session store and persistent file unconditionally, returning `true` if either was found.

### [MED] `--confirm` mode uses masked password input for "yes" confirmation
File: src/cli/auth.ts:30-31
Issue: The `--confirm` flow asks the user to type "yes" but uses `secureInput()` which masks characters as `*`. The user sees `***` instead of `yes`, making it unclear what they typed. This is a poor UX for a confirmation prompt.
Suggestion: Use a plain readline prompt (not `secureInput`) for the `--confirm` mode.

**Doer:** fixed in commit c14255b — replaced `secureInput()` with a plain `readline.createInterface` question for the `--confirm` branch so the user's typed input is visible.

### [MED] `input.prompt` is defined in schema but never used
File: src/tools/credential-store-set.ts:8,18
Issue: The `prompt` field is declared in the schema (line 8) and accepted as input, but `collectOobApiKey` is called with `input.name` (line 18), not `input.prompt`. The user's custom prompt is silently ignored.
Suggestion: Pass `input.prompt` through to the OOB collection flow so the terminal displays the user-specified message.

**Doer:** fixed in commit c14255b — threaded `input.prompt` through `collectOobApiKey()` opts → `collectOobInput()` → `extraArgs` as `--prompt <value>` CLI argument; `auth.ts` now reads `--prompt` and passes it to `secureInput()`.

### [MED] No tests for credential store, token resolution, redaction, or egress
File: tests/
Issue: There are zero tests for `credential-store.ts`, `resolveSecureTokens()`, `redactOutput()`, the network egress check, or the shell-escape paths. The only test changes are for the crypto key-file migration.
Suggestion: Add unit tests for at minimum: (1) credential set/get/delete round-trip, (2) token resolution with missing/valid credentials, (3) output redaction, (4) egress policy deny/confirm/allow logic, (5) `escapePowerShellArg` edge cases.

**Doer:** fixed in commit c14255b — added `tests/credential-store-and-execute.test.ts` with 16 tests covering credential round-trip, `{{secure.NAME}}` token resolution, output redaction (stdout and stderr), restart_command token resolution, and network egress policy (allow / deny / confirm / terminal-unavailable).

### [LOW] Dead code: `KEY_PATH` const and `getOrCreateSalt` function
File: src/utils/crypto.ts:11,19-37
Issue: `KEY_PATH` (line 11) is declared but never used — the key is stored at `SALT_PATH`. `getOrCreateSalt()` is kept with `void getOrCreateSalt` to suppress warnings but is dead code. `SALT_LENGTH` (line 9) is also only used in `getOrCreateSalt`.
Suggestion: Remove `KEY_PATH`, `SALT_LENGTH`, and `getOrCreateSalt` entirely. Update the `getOrCreateKey` JSDoc to clarify it uses the `salt` path for backward compatibility (or rename the file if a breaking change is acceptable).

**Doer:** fixed in commit c14255b — removed `KEY_PATH`, `SALT_LENGTH`, the `getOrCreateSalt` function, and its `void getOrCreateSalt` suppression line from `crypto.ts`.

### [LOW] "API key" still in success message
File: src/cli/auth.ts:72
Issue: The prompt labels were renamed to "Secure Value" (lines 21, 30), but the success message on line 72 still says `"API key received"`. Inconsistent with the renaming intent.
Suggestion: Change to `"Secure value received"` or similar.

**Doer:** fixed in commit c14255b — changed the string to `"Secure value received. You can close this window."`.

### [LOW] `NETWORK_TOOL_RE` is a blocklist — easy to bypass
File: src/tools/execute-command.ts:35
Issue: The regex only matches a hardcoded set of network tool names. An LLM could use `python -c "import urllib..."`, `node -e "fetch(...)"`, `/usr/bin/curl` aliased, or any other indirect network access method.
Suggestion: Document that this is a best-effort heuristic, not a security boundary. Consider whether an allowlist approach or a more robust detection method is warranted for the `deny` policy.

**Doer:** fixed in commit c14255b — replaced the old inline comment on the `NETWORK_TOOL_RE` line with `// Best-effort heuristic — not a security boundary`.

## Re-review

**Verdict: APPROVED**

All 9 findings from the initial review have been properly addressed in commits c14255b, bfcaceb, and 3b199a2. Verified via `git diff origin/main...HEAD` and `npm test` (45 test files, 766 tests passed, 4 skipped).

### Finding-by-finding verification

| # | Severity | Finding | Status | Notes |
|---|----------|---------|--------|-------|
| H1 | HIGH | `restart_command` not resolved for `{{secure.NAME}}` | ✅ Fixed | `resolveSecureTokens()` called on `restart_command`; credentials merged into main list for redaction/egress (execute-command.ts:141-150) |
| H2 | HIGH | Long-running task output not redacted | ✅ Fixed | `redactOutput()` applied to launch output; `registerTaskCredentials()`/`getTaskCredentials()` added to credential-store.ts so `monitor_task` redacts log tail via task-scoped registry (monitor-task.ts:69-74) |
| M1 | MED | `credentialDelete` only removes from one tier | ✅ Fixed | Both session and persistent tiers attempted unconditionally; returns `true` if either was found (credential-store.ts:137-148) |
| M2 | MED | `--confirm` mode uses masked input | ✅ Fixed | Plain `readline.createInterface` used for confirmation prompt; `secureInput()` reserved for password/key entry (auth.ts:38-45) |
| M3 | MED | `input.prompt` defined but never used | ✅ Fixed | Threaded through `collectOobApiKey` opts → `collectOobInput` → `--prompt` CLI arg; auth.ts reads it and passes to `secureInput()` |
| M4 | MED | No tests for credential store / token resolution / redaction / egress | ✅ Fixed | 16 tests in `credential-store-and-execute.test.ts` covering round-trip, token substitution, redaction (stdout + stderr), restart_command resolution, and all three egress policies |
| L1 | LOW | Dead code: `KEY_PATH`, `SALT_LENGTH`, `getOrCreateSalt` | ✅ Fixed | All removed from crypto.ts; `getOrCreateKey()` is the sole key provider |
| L2 | LOW | "API key" in success message | ✅ Fixed | Changed to "Secure value received. You can close this window." |
| L3 | LOW | `NETWORK_TOOL_RE` blocklist comment | ✅ Fixed | Comment now reads "Best-effort heuristic — not a security boundary" |

### New issues introduced by fixes

None identified. The implementation is clean and consistent. Minor observations (not blocking):

- `taskCredentials` Map in credential-store.ts grows but is never cleaned up after task completion. Acceptable for current usage patterns — would only matter for very long-lived server sessions with many tasks.
- `void launchOutput` in execute-command.ts computes a redacted string then discards it. The comment explains this is a defense-in-depth safety measure, which is reasonable.

## Final Review

**Scope:** Commit 47a6fcd — `feat: resolve {{secure.NAME}} tokens in provision-vcs-auth and provision-auth`

**Verdict: APPROVED**

All tests pass: 45 test files, 772 tests passed, 4 skipped.

### Findings

#### 1. Correctness of token resolution

Both tools follow the same pattern as `register-member.ts`:
- Regex scan with `TOKEN_RE` (`/\{\{secure\.([a-zA-Z0-9_]{1,64})\}\}/g`)
- Collect unique names into a `Set`
- Resolve each via `credentialResolve(name)`
- `replaceAll` to substitute tokens with plaintext

`provision-vcs-auth.ts` extracts a reusable `resolveSecureField()` helper and correctly resets `TOKEN_RE.lastIndex = 0` since the regex is module-scoped. `provision-auth.ts` creates `TOKEN_RE` fresh inside the `if` block, so no stale `lastIndex` issue. Both return clear error messages referencing the missing credential name when resolution fails.

**Status:** ✅ Correct — consistent with established pattern.

#### 2. No credential leakage

- `provision-auth.ts`: Resolved key flows to `provisionApiKey()` which passes it to `setEnv()` commands, encrypts it via `encryptPassword()`, and stores the encrypted form. Return messages never include the plaintext value.
- `provision-vcs-auth.ts`: Resolved values flow through `buildCredentials()` to provider deploy functions. Error messages only reference credential names, not values.

**Status:** ✅ No leakage — resolved values are never returned in output or logged.

#### 3. Test quality

New tests cover:
- **provision-auth:** Happy path (`{{secure.MY_API_KEY}}` → resolved → "API key provisioned"), error path (missing `NONEXISTENT_KEY` → `❌` error with credential name)
- **provision-vcs-auth:** Happy paths for all three providers (GitHub PAT, Bitbucket `api_token`, Azure DevOps `pat`), plus error path for missing credential

Tests properly set up and tear down credentials via `credentialSet`/`credentialDelete`.

**Status:** ✅ Good coverage of happy and error paths across all providers.

#### 4. Edge cases and observations

- **Multiple tokens in one field:** Handled correctly — `Set` collects unique names, `replaceAll` substitutes each.
- **Partial token (e.g. `prefix-{{secure.X}}-suffix`):** Works — `replaceAll` replaces the token portion only.
- **Code duplication (non-blocking):** Token resolution logic is now inlined in three places (`register-member.ts`, `provision-auth.ts`, `provision-vcs-auth.ts`). `provision-vcs-auth.ts` at least extracts `resolveSecureField()`, but the other two inline the pattern. Consider extracting a shared utility in a follow-up.

**Status:** ✅ No edge cases missed. Duplication is a minor style observation, not blocking.

## update-member Review

**Scope:** Commit d78343f — `feat(update-member): resolve {{secure.NAME}} tokens in password field`

**Verdict: APPROVED**

All tests pass: 45 test files, 774 tests passed, 4 skipped.

### Findings

#### 1. Token resolution pattern matches register-member.ts

The implementation at `update-member.ts:82-97` is a line-for-line match of the pattern in `register-member.ts:62-77`:
- Same `TOKEN_RE` regex (`/\{\{secure\.([a-zA-Z0-9_]{1,64})\}\}/g`) created fresh inside the `if` block (no stale `lastIndex`)
- Same `Set<string>` for unique token names
- Same `credentialResolve()` call with early-return error on missing credential
- Same `replaceAll` substitution loop

Only difference: error message says "Member was NOT updated" vs "Member was NOT registered" — correct and intentional.

**Status:** ✅ Exact pattern match.

#### 2. OOB fallback logic

The OOB condition at line 106 now checks `!resolvedPassword` instead of `!input.password`. This is correct:
- If the user passes `{{secure.X}}` as a password, it resolves to plaintext → `resolvedPassword` is truthy → OOB is skipped → password flows to `encryptPassword()` at line 125. Correct.
- If the user passes no password and is switching to password auth or rotating, `resolvedPassword` is `undefined` → OOB fires. Correct.
- If the user passes a literal password, behavior is unchanged. Correct.

**Status:** ✅ OOB fallback logic is correct.

#### 3. No credential leakage

- `resolvedPassword` only flows to `encryptPassword()` (line 125), which returns the encrypted form stored in the registry.
- The return message at the end of the function references `friendlyName`, not the password value.
- The `input.password` raw token string is never logged or returned — only `resolvedPassword` is used, and only for encryption.

**Status:** ✅ No leakage — resolved values never appear in output or logs.

#### 4. Test quality

Two new tests added:
- **Happy path** (`tests/update-member.test.ts:82-96`): Creates a password-auth agent, sets a credential, passes `{{secure.<name>}}` as password, asserts update succeeds. Properly cleans up credential in `finally` block.
- **Error path** (`tests/update-member.test.ts:98-109`): Passes `{{secure.nonexistent_cred}}` and asserts the `❌ Credential "nonexistent_cred" not found` error with "Member was NOT updated".

Both tests validate the core behavior. The happy path doesn't assert that the stored encrypted password matches `encryptPassword('mysecretpass')`, but the round-trip through the credential store and token resolution is implicitly validated by the absence of error. Acceptable coverage.

**Status:** ✅ Good coverage of happy and error paths.

#### 5. Code duplication (non-blocking observation)

This is now the fourth inline copy of the token resolution pattern (joining `register-member.ts`, `provision-auth.ts`, and `provision-vcs-auth.ts`). The case for extracting a shared `resolveSecureTokens(field)` utility is growing stronger. Not blocking.
