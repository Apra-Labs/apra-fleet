# PLAN — Issue #40: Fix provision_auth env var visibility for non-Claude providers

**Branch:** `feature/multi-provider`
**Issue:** Apra-Labs/apra-fleet#40

## Problem Summary

`provision_auth` with `api_key` writes env vars to shell profiles that are never sourced in non-interactive SSH sessions. Auth env vars (e.g. `GEMINI_API_KEY`) are invisible to `execute_prompt` and `execute_command`.

## Design

**Core approach:** Store provisioned env vars encrypted in the Agent registry record. Inject them inline into every command built by `execute_prompt` and `execute_command`, similar to how `CLAUDE_PATH` already injects `export PATH=...`.

Shell profile writes remain as fallback for interactive/debug use.

**Key decisions:**
- New field `encryptedEnvVars?: Record<string, string>` on `Agent` type (envVarName -> encrypted value)
- Reuse existing `encryptPassword()`/`decryptPassword()` from `src/utils/crypto.ts`
- New helper `buildAuthEnvPrefix(agent, os)` builds platform-correct inline export prefix
- Injection happens in the tool callers (execute-prompt.ts, execute-command.ts), not in OsCommands — avoids changing the OsCommands interface
- `CLAUDE_PATH` renamed to `CLI_PATH` (provider-neutral)
- Gemini `parseResponse()` returns `"gemini-latest"` sentinel; `resumeFlag()` returns `--resume latest`
- **OOB API key entry**: When `provision_auth` is called without `api_key`, non-Claude providers use the same OOB terminal prompt mechanism as `register_member` password entry. This prevents API keys from appearing in conversation context or logs. The `api_key` parameter remains for automation.

---

## Requirements Deviation Notes

These deviations from requirements.md are intentional and documented here for reviewer clarity:

| Requirement | Plan Decision | Rationale |
|------------|---------------|-----------|
| Fix `setEnv()` on Windows to use PowerShell | **No change needed** | Windows `setEnv()` already uses `[Environment]::SetEnvironmentVariable()` via PowerShell. The requirement misidentifies this as broken. Verified in `src/os/windows.ts`. |
| Rename `CLAUDE_PATH` across `linux.ts` and `macos.ts` | **Targets `linux.ts` and `windows.ts`** | `CLAUDE_PATH` exists in `linux.ts` and `windows.ts`, not `macos.ts`. The requirement has a typo — macOS uses a different path mechanism. |
| Update `revoke_vcs_auth` to clean up stored env vars | **No changes to `revoke_vcs_auth`** | VCS auth tokens (SSH keys, Git credentials) are separate from LLM API keys stored in `encryptedEnvVars`. `revoke_vcs_auth` manages VCS credentials only; LLM key cleanup happens in `remove_member`. |
| Integration tests (`provision_auth` -> `execute_prompt` on Gemini) | **Deferred to follow-up** | Integration tests require a live Gemini API key and a registered remote member. These are environment-dependent and cannot run in CI. Unit tests cover all code paths. A follow-up issue should add manual integration test scripts. |
| Windows escaping in `buildAuthEnvPrefix()` | **Reuses existing `envPrefix()` pattern** | `windows.ts:envPrefix()` (line 153) already implements single-quote escaping (`value.replace(/'/g, "''")`) for PowerShell. `buildAuthEnvPrefix()` will use the same escaping approach rather than inventing its own. |
| Long-running task env var injection | **Deferred — known limitation** | The nohup wrapper script in `execute_command` (lines 38-73) writes a bash script to disk. Injecting env vars there requires writing secrets to a file, which is a different security model. Captured in risk register as a follow-up. |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Shell escaping edge cases** — API keys containing quotes, backslashes, or `$` could break inline export commands | Command execution failure or partial key injection | `buildAuthEnvPrefix()` uses `escapeDoubleQuoted()` for Linux/macOS (already battle-tested in PATH injection) and PowerShell single-quote escaping from `windows.ts:envPrefix()`. Add unit tests with adversarial key values (`key"with'quotes$and\backslash`). |
| **Concurrent `provision_auth` calls** — Two simultaneous calls for the same member could clobber `encryptedEnvVars` via read-merge-write race in `updateAgent()` | Last write wins; one key silently lost | Low probability in practice (provisioning is a manual, infrequent operation). Document as a known limitation. If needed later, add optimistic locking to `updateAgent()`. |
| **Encrypted value size limits** — `agents.json` grows with each stored key | File bloat over many provision/revoke cycles | Each encrypted key is ~100-200 bytes. Even 10 providers per agent adds <2KB. Not a practical concern. |
| **Long-running tasks miss env vars** — `execute_command`'s nohup wrapper script does NOT get env vars injected | Long-running Gemini commands fail silently with auth errors | Documented as out-of-scope. Follow-up issue needed: write env vars into the wrapper script (with appropriate file permissions and cleanup). |
| **OOB terminal launch failure** — Headless servers or remote desktops may not have a terminal emulator | API key cannot be entered interactively | Same fallback as `register_member`: return a message instructing the user to run `apra-fleet auth-key <member-name>` manually, or retry with the `api_key` parameter. |

---

## Phase 1 — Foundation (Types + Storage + Platform Fix)

### Task 1: Add `encryptedEnvVars` to Agent type + create `buildAuthEnvPrefix()` helper

**Files:**
- `src/types.ts` — add `encryptedEnvVars?: Record<string, string>` to `Agent` interface
- `src/utils/auth-env.ts` — new file, exports `buildAuthEnvPrefix(agent: Agent, os: RemoteOS): string`

**Details:**
- `buildAuthEnvPrefix` iterates `agent.encryptedEnvVars`, decrypts each value, and builds:
  - Linux/macOS: `export NAME="escaped_value" && ` (joined with ` && `)
  - Windows: `$env:NAME='escaped_value'; ` (joined with `; `)
- Returns empty string if no stored env vars
- Uses `escapeDoubleQuoted()` for Linux/macOS, single-quote escape (matching `windows.ts:envPrefix()` pattern) for Windows

**Done:** `buildAuthEnvPrefix()` returns correct platform-specific prefix strings. Unit-testable in isolation.

**Risks:** None — additive only, no existing behavior changes.

### Task 2: Update `provisionApiKey()` to store encrypted API key in registry

**Files:**
- `src/tools/provision-auth.ts` — in `provisionApiKey()`, after successful `setEnv()` calls, also call `updateAgent()` to persist `encryptedEnvVars: { [envVarName]: encryptPassword(apiKey) }`

**Details:**
- Import `encryptPassword` from `../utils/crypto.js`
- Import `updateAgent` from `../services/registry.js`
- After the `setEnv` loop, call: `updateAgent(agent.id, { encryptedEnvVars: { ...agent.encryptedEnvVars, [envVarName]: encryptPassword(apiKey) } })`
- Update success message to mention "stored in member config"

**Done:** After `provision_auth` with `api_key`, the agent's registry entry contains the encrypted key in `encryptedEnvVars`.

### Task 3: Fix macOS `setEnv()`/`unsetEnv()` to include `.zshenv`

**Files:**
- `src/os/macos.ts` — add `.zshenv` write in `setEnv()`, add `.zshenv` cleanup in `unsetEnv()`

**Details:**
- `setEnv()`: add `echo 'export ${name}="${escaped}"' >> ~/.zshenv` to the returned commands array
- `unsetEnv()`: add `sed -i '' '/export ${name}=/d' ~/.zshenv 2>/dev/null || true` to the returned commands array
- `.zshenv` is the only file sourced in non-interactive zsh sessions on macOS

**Done:** `macos.setEnv()` returns 5 commands (was 4), `macos.unsetEnv()` returns 5 commands (was 4). Both include `.zshenv`.

### VERIFY 1
- [ ] `Agent` type has `encryptedEnvVars` field
- [ ] `buildAuthEnvPrefix()` returns correct strings for linux, macos, windows
- [ ] `provisionApiKey()` stores encrypted key via `updateAgent()`
- [ ] macOS `setEnv()`/`unsetEnv()` include `.zshenv`
- [ ] All existing tests pass (`npm test`)

---

## Phase 2 — Core Fix: Env Var Injection + OOB Key Entry

### Task 4: Inject auth env vars in `execute_prompt`

**Files:**
- `src/tools/execute-prompt.ts` — prepend auth env prefix to built command

**Details:**
- Import `buildAuthEnvPrefix` from `../utils/auth-env.js`
- Import `getAgentOS` (already imported)
- After `cmds.buildAgentPromptCommand(provider, {...})`, prepend: `const authPrefix = buildAuthEnvPrefix(agent, getAgentOS(agent)); if (authPrefix) claudeCmd = authPrefix + claudeCmd;`
- Apply same prefix to all retry command builds (stale session retry, server error retry)

**Done:** `execute_prompt` on a member with stored `GEMINI_API_KEY` produces a command like `export GEMINI_API_KEY="key" && cd "/folder" && export PATH=... && gemini -p ...`

**Risks:** Must ensure prefix is applied to ALL command builds in the function (initial + 2 retries).

### Task 5: Inject auth env vars in `execute_command`

**Files:**
- `src/tools/execute-command.ts` — prepend auth env prefix to wrapped command

**Details:**
- Import `buildAuthEnvPrefix` from `../utils/auth-env.js`
- Import `getAgentOS` (already imported)
- After `const wrapped = cmds.wrapInWorkFolder(folder, input.command)`, prepend auth prefix
- Only for the regular (non-long-running) path — long-running tasks use nohup/wrapper scripts that need different handling (see risk register; out of scope for #40)

**Done:** `execute_command` on a member with stored env vars prepends them to the SSH command.

### Task 6: Add OOB API key entry to `provision_auth`

**Files:**
- `src/cli/auth.ts` — extend `runAuth()` to support an `--api-key` flag that changes the prompt text from "Enter SSH password" to "Enter API key"
- `src/services/auth-socket.ts` — add `collectOobApiKey()` that wraps `collectOobPassword()` mechanics but launches the terminal with the `--api-key` flag
- `src/tools/provision-auth.ts` — in `provisionAuth()`, when `api_key` is not provided and the provider is non-Claude (no OAuth copy), call `collectOobApiKey()` instead of returning the error message

**Details:**

**CLI changes (`src/cli/auth.ts`):**
- `runAuth()` checks for `--api-key` flag in args: `const isApiKey = args.includes('--api-key'); const memberName = args.find(a => !a.startsWith('--'));`
- When `--api-key` is set, display "Enter API key for <provider>" instead of "Enter SSH password"
- Prompt text: `API key: ` instead of `Password: `
- Success message: "API key received" instead of "Password received"
- The socket message is identical: `{type: "auth", member_name, password: <the-key>}` — the field name doesn't matter since it's an opaque secret on the wire

**Socket service (`src/services/auth-socket.ts`):**
- Add `collectOobApiKey(memberName: string, toolName: string)` — same signature and behavior as `collectOobPassword()` but calls `launchAuthTerminal(memberName, '--api-key')` to pass the flag
- Extend `launchAuthTerminal()` to accept optional extra args and forward them to the CLI subcommand
- Reuses the same socket, pending map, and encryption — no protocol changes needed

**Provision-auth changes (`src/tools/provision-auth.ts`):**
- In `provisionAuth()`, replace the non-Claude error block (lines 197-199) with:
  ```
  const oob = await collectOobApiKey(agent.friendlyName, 'provision_auth');
  if ('fallback' in oob) return oob.fallback;
  return provisionApiKey(agent, decryptPassword(oob.password), provider);
  ```
- The OOB-collected key is already encrypted by the socket handler; decrypt it before passing to `provisionApiKey()` which needs the plaintext to call `setEnv()` and `encryptPassword()`

**Done:**
- `provision_auth` without `api_key` for non-Claude providers opens an OOB terminal window prompting "Enter API key"
- User pastes key in separate terminal; key never appears in conversation context or MCP logs
- `provisionApiKey()` receives the key and proceeds as normal (store + shell profile + verify)
- `provision_auth` with `api_key` parameter still works (automation path, no OOB prompt)
- Headless fallback: returns message instructing user to run `apra-fleet auth --api-key <member-name>` manually or retry with `api_key` parameter

### VERIFY 2
- [ ] `execute_prompt` command string includes auth env export prefix
- [ ] `execute_command` command string includes auth env export prefix
- [ ] All retry paths in `execute_prompt` include the prefix
- [ ] `provision_auth` without `api_key` for Gemini opens OOB terminal prompt
- [ ] `provision_auth` with `api_key` still works (no OOB prompt)
- [ ] Headless fallback returns useful message
- [ ] Existing tests pass

---

## Phase 3 — Rename, Gemini Fix, Cleanup

### Task 7: Rename `CLAUDE_PATH` to `CLI_PATH`

**Files:**
- `src/os/linux.ts` — rename constant `CLAUDE_PATH` -> `CLI_PATH`
- `src/os/windows.ts` — rename constant `CLAUDE_PATH` -> `CLI_PATH`

**Details:**
- Simple find-replace within each file. The constant is local to each file (not exported).
- Linux: `const CLI_PATH = 'export PATH="$HOME/.local/bin:$PATH" && ';`
- Windows: `const CLI_PATH = '$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path"; ';`
- Update all references within the file.

**Done:** No references to `CLAUDE_PATH` remain. All usages reference `CLI_PATH`. Behavior unchanged.

### Task 8: Fix Gemini session resume

**Files:**
- `src/providers/gemini.ts`

**Details:**
- `parseResponse()`: Instead of `sessionId: undefined`, return `sessionId: 'gemini-latest'` on successful parse (code === 0). This signals that a session exists without a specific ID. Gemini CLI uses `--resume latest`, not session IDs.
- `resumeFlag()`: Change return from `'--resume'` to `'--resume latest'`. The Gemini CLI requires `--resume latest` to resume the most recent session in the project folder.

**Done:** 
- `parseResponse()` returns `sessionId: 'gemini-latest'` for successful responses
- `resumeFlag()` returns `'--resume latest'`
- `execute_prompt` will store `'gemini-latest'` as sessionId, and on next call with `resume: true`, will build `--resume latest`

### Task 9: Verify `remove_member` cleanup of stored env vars

**Files:**
- `src/tools/remove-member.ts` — verify only, no code changes expected

**Details:**
- The existing `remove_member` flow calls `unsetEnv(provider.authEnvVar)` to remove env vars from shell profiles (fallback cleanup)
- The registry entry (including `encryptedEnvVars`) is deleted when `removeFromRegistry()` is called, which deletes the agent's entire JSON record
- **Decision: registry deletion is sufficient.** Explicit zeroing of `encryptedEnvVars` before deletion is unnecessary because: (a) the values are already encrypted at rest, (b) `removeFromRegistry()` overwrites the file atomically (write-then-rename), so the old content is not recoverable from the file, and (c) in-memory JS strings are immutable and will be GC'd — explicit "zeroing" of JS strings is not possible anyway
- No changes needed to `revoke_vcs_auth` — it manages VCS credentials (SSH keys, Git tokens), not LLM API keys

**Done:** Confirmed that `remove_member` -> `removeFromRegistry()` deletes the entire agent record including `encryptedEnvVars`. No code changes needed. This task is verification-only.

### VERIFY 3
- [ ] `CLAUDE_PATH` renamed to `CLI_PATH` in linux.ts and windows.ts, no functional change
- [ ] Gemini `parseResponse()` returns `sessionId: 'gemini-latest'` for successful responses
- [ ] Gemini `resumeFlag()` returns `'--resume latest'`
- [ ] `remove_member` deletes stored env vars via registry deletion (verified, no code change)
- [ ] All existing tests pass

---

## Phase 4 — Tests

### Task 10: Tests for platform fixes + auth env prefix helper

**Files:**
- `tests/platform.test.ts` — update existing `setEnv`/`unsetEnv` tests for macOS `.zshenv`
- `tests/auth-env.test.ts` — new file, tests for `buildAuthEnvPrefix()`

**Details:**
- Update macOS setEnv test: expect 5 commands (was 4), one containing `.zshenv`
- Update macOS unsetEnv test: expect 5 commands (was 4), one containing `.zshenv`
- `buildAuthEnvPrefix` tests:
  - Returns empty string when `encryptedEnvVars` is undefined
  - Returns empty string when `encryptedEnvVars` is empty `{}`
  - Linux: returns `export GEMINI_API_KEY="..." && ` format
  - Windows: returns `$env:GEMINI_API_KEY='...'; ` format
  - Multiple env vars produce multiple exports joined correctly
  - Values with special characters are escaped (test with `key"with'quotes$and\backslash`)

**Done:** All new tests pass. Existing platform tests updated and passing.

### Task 11: Tests for OOB API key entry + Gemini + CLI_PATH rename

**Files:**
- `tests/auth-socket.test.ts` — add tests for `collectOobApiKey()` (parallel to existing `collectOobPassword` tests)
- `tests/providers.test.ts` — update Gemini tests for `parseResponse()` and `resumeFlag()`
- `tests/platform.test.ts` — verify `CLI_PATH` rename didn't break command output (existing tests cover this implicitly via `agentCommand`, `agentVersion`, `buildAgentPromptCommand` tests)

**Details:**
- `collectOobApiKey` tests: launches terminal with `--api-key` flag, returns encrypted key, headless fallback works
- Gemini `parseResponse()` test: successful response should return `sessionId: 'gemini-latest'`
- Gemini `resumeFlag()` test: should return `'--resume latest'` regardless of argument
- Verify existing `buildAgentPromptCommand` tests still pass (they test command output, not constant names)

**Done:** All tests updated and passing.

### VERIFY 4 (Final)
- [ ] All new tests pass
- [ ] All existing tests pass
- [ ] `npm test` green
- [ ] No TypeScript errors (`npx tsc --noEmit`)

---

## Task Summary

| # | Task | Files | Phase |
|---|------|-------|-------|
| 1 | Add `encryptedEnvVars` to Agent type + `buildAuthEnvPrefix()` helper | types.ts, utils/auth-env.ts (new) | 1 |
| 2 | Store encrypted API key in `provisionApiKey()` | tools/provision-auth.ts | 1 |
| 3 | Fix macOS setEnv/unsetEnv for `.zshenv` | os/macos.ts | 1 |
| 4 | Inject auth env vars in `execute_prompt` | tools/execute-prompt.ts | 2 |
| 5 | Inject auth env vars in `execute_command` | tools/execute-command.ts | 2 |
| 6 | OOB API key entry for `provision_auth` | cli/auth.ts, services/auth-socket.ts, tools/provision-auth.ts | 2 |
| 7 | Rename `CLAUDE_PATH` -> `CLI_PATH` | os/linux.ts, os/windows.ts | 3 |
| 8 | Fix Gemini session resume (sentinel + `--resume latest`) | providers/gemini.ts | 3 |
| 9 | Verify `remove_member` cleanup of stored env vars (no code change) | tools/remove-member.ts | 3 |
| 10 | Tests: platform fixes + auth env prefix helper | tests/platform.test.ts, tests/auth-env.test.ts (new) | 4 |
| 11 | Tests: OOB API key + Gemini fixes + injection verification | tests/auth-socket.test.ts, tests/providers.test.ts, tests/platform.test.ts | 4 |

## Out of Scope
- Gemini CLI Node 22 requirement (doc-only)
- Gemini settings.json auth (doesn't work)
- Long-running task env var injection (see risk register — different security model, separate issue)
- Integration tests with real Gemini API (requires API key + live member; see deviation notes)
