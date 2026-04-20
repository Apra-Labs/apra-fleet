# Review — feat/oob-improvements

## Verdict: CHANGES NEEDED

## Findings

### [HIGH] `restart_command` not resolved for `{{secure.NAME}}` tokens
File: src/tools/execute-command.ts:168
Issue: `restart_command` is passed through as `input.restart_command` (raw) to `generateTaskWrapper()`. Only `sec://` handles are blocked (line 127), but `{{secure.NAME}}` tokens are never resolved. If a long-running task restarts, the literal `{{secure.NAME}}` string ends up in the shell script on the remote machine.
Suggestion: Run `resolveSecureTokens()` on `restart_command` as well (and merge credentials into the main credentials list for redaction/egress checks).

### [HIGH] Long-running task output is not redacted
File: src/tools/execute-command.ts:157-192
Issue: The long-running task path writes `resolvedCommand` into a bash wrapper script on the remote host. When `monitor_task` later retrieves output, there is no redaction of credential values — the plaintext could be returned to the LLM.
Suggestion: Either pass credential names into the task metadata so `monitor_task` can redact, or document this as a known limitation and warn the user.

### [MED] `credentialDelete` only removes from one tier
File: src/services/credential-store.ts:137-148
Issue: `credentialDelete` early-returns after deleting from session store. If both a session and persistent entry exist for the same name (possible if session is set *after* persistent — `credentialSet` only cleans session→persistent, not the reverse), the persistent entry survives.
Suggestion: Remove the early return — delete from both tiers and return true if either was found.

### [MED] `--confirm` mode uses masked password input for "yes" confirmation
File: src/cli/auth.ts:30-31
Issue: The `--confirm` flow asks the user to type "yes" but uses `secureInput()` which masks characters as `*`. The user sees `***` instead of `yes`, making it unclear what they typed. This is a poor UX for a confirmation prompt.
Suggestion: Use a plain readline prompt (not `secureInput`) for the `--confirm` mode.

### [MED] `input.prompt` is defined in schema but never used
File: src/tools/credential-store-set.ts:8,18
Issue: The `prompt` field is declared in the schema (line 8) and accepted as input, but `collectOobApiKey` is called with `input.name` (line 18), not `input.prompt`. The user's custom prompt is silently ignored.
Suggestion: Pass `input.prompt` through to the OOB collection flow so the terminal displays the user-specified message.

### [MED] No tests for credential store, token resolution, redaction, or egress
File: tests/
Issue: There are zero tests for `credential-store.ts`, `resolveSecureTokens()`, `redactOutput()`, the network egress check, or the shell-escape paths. The only test changes are for the crypto key-file migration.
Suggestion: Add unit tests for at minimum: (1) credential set/get/delete round-trip, (2) token resolution with missing/valid credentials, (3) output redaction, (4) egress policy deny/confirm/allow logic, (5) `escapePowerShellArg` edge cases.

### [LOW] Dead code: `KEY_PATH` const and `getOrCreateSalt` function
File: src/utils/crypto.ts:11,19-37
Issue: `KEY_PATH` (line 11) is declared but never used — the key is stored at `SALT_PATH`. `getOrCreateSalt()` is kept with `void getOrCreateSalt` to suppress warnings but is dead code. `SALT_LENGTH` (line 9) is also only used in `getOrCreateSalt`.
Suggestion: Remove `KEY_PATH`, `SALT_LENGTH`, and `getOrCreateSalt` entirely. Update the `getOrCreateKey` JSDoc to clarify it uses the `salt` path for backward compatibility (or rename the file if a breaking change is acceptable).

### [LOW] "API key" still in success message
File: src/cli/auth.ts:72
Issue: The prompt labels were renamed to "Secure Value" (lines 21, 30), but the success message on line 72 still says `"API key received"`. Inconsistent with the renaming intent.
Suggestion: Change to `"Secure value received"` or similar.

### [LOW] `NETWORK_TOOL_RE` is a blocklist — easy to bypass
File: src/tools/execute-command.ts:35
Issue: The regex only matches a hardcoded set of network tool names. An LLM could use `python -c "import urllib..."`, `node -e "fetch(...)"`, `/usr/bin/curl` aliased, or any other indirect network access method.
Suggestion: Document that this is a best-effort heuristic, not a security boundary. Consider whether an allowlist approach or a more robust detection method is warranted for the `deny` policy.
