# PLAN — Issue #40: Fix provision_auth env var visibility for non-Claude providers

**Branch:** `feature/multi-provider`
**Issue:** Apra-Labs/apra-fleet#40

## Problem Summary

`provision_auth` with `api_key` writes env vars to shell profiles that are never sourced in non-interactive SSH sessions. Auth env vars (e.g. `GEMINI_API_KEY`) are invisible to `execute_prompt` and `execute_command`.

## Design

**Core approach:** Store provisioned env vars encrypted in the Agent registry record. Inject them inline into every command built by `execute_prompt` and `execute_command`, similar to how `CLAUDE_PATH` already injects `export PATH=...`.

Shell profile writes remain as fallback for interactive/debug use.

**Key decisions:**
- New field `encryptedEnvVars?: Record<string, string>` on `Agent` type (envVarName → encrypted value)
- Reuse existing `encryptPassword()`/`decryptPassword()` from `src/utils/crypto.ts`
- New helper `buildAuthEnvPrefix(agent, os)` builds platform-correct inline export prefix
- Injection happens in the tool callers (execute-prompt.ts, execute-command.ts), not in OsCommands — avoids changing the OsCommands interface
- `CLAUDE_PATH` renamed to `CLI_PATH` (provider-neutral)
- Gemini `parseResponse()` returns `"gemini-latest"` sentinel; `resumeFlag()` returns `--resume latest`

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
- Uses `escapeDoubleQuoted()` for Linux/macOS, single-quote escape for Windows

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

## Phase 2 — Core Fix: Env Var Injection

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
- Only for the regular (non-long-running) path — long-running tasks use nohup/wrapper scripts that may need different handling (out of scope for #40, can be addressed separately)

**Done:** `execute_command` on a member with stored env vars prepends them to the SSH command.

### VERIFY 2
- [ ] `execute_prompt` command string includes auth env export prefix
- [ ] `execute_command` command string includes auth env export prefix
- [ ] All retry paths in `execute_prompt` include the prefix
- [ ] Existing tests pass

---

## Phase 3 — Rename, Gemini Fix, Cleanup

### Task 6: Rename `CLAUDE_PATH` to `CLI_PATH`

**Files:**
- `src/os/linux.ts` — rename constant `CLAUDE_PATH` → `CLI_PATH`
- `src/os/windows.ts` — rename constant `CLAUDE_PATH` → `CLI_PATH`

**Details:**
- Simple find-replace within each file. The constant is local to each file (not exported).
- Linux: `const CLI_PATH = 'export PATH="$HOME/.local/bin:$PATH" && ';`
- Windows: `const CLI_PATH = '$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path"; ';`
- Update all references within the file.

**Done:** No references to `CLAUDE_PATH` remain. All usages reference `CLI_PATH`. Behavior unchanged.

### Task 7: Fix Gemini session resume

**Files:**
- `src/providers/gemini.ts`

**Details:**
- `parseResponse()`: Instead of `sessionId: undefined`, return `sessionId: 'gemini-latest'` on successful parse (code === 0). This signals that a session exists without a specific ID. Gemini CLI uses `--resume latest`, not session IDs.
- `resumeFlag()`: Change return from `'--resume'` to `'--resume latest'`. The Gemini CLI requires `--resume latest` to resume the most recent session in the project folder.

**Done:** 
- `parseResponse()` returns `sessionId: 'gemini-latest'` for successful responses
- `resumeFlag()` returns `'--resume latest'`
- `execute_prompt` will store `'gemini-latest'` as sessionId, and on next call with `resume: true`, will build `--resume latest`

### Task 8: Update `remove_member` to clean up stored env vars

**Files:**
- `src/tools/remove-member.ts` — clear `encryptedEnvVars` from agent before removal

**Details:**
- The existing code already calls `unsetEnv(provider.authEnvVar)` to remove from shell profiles
- No additional remote cleanup needed — the shell profile cleanup already covers the fallback writes
- The registry entry (including `encryptedEnvVars`) is deleted when `removeFromRegistry()` is called
- No changes needed to `revoke_vcs_auth` — it doesn't deal with LLM auth env vars

**Done:** Verify that `remove_member` flow naturally cleans up `encryptedEnvVars` via registry deletion. If stored keys need explicit zeroing before delete, add that.

### VERIFY 3
- [ ] `CLAUDE_PATH` renamed to `CLI_PATH` in linux.ts and windows.ts, no functional change
- [ ] Gemini `parseResponse()` returns `sessionId: 'gemini-latest'` for successful responses
- [ ] Gemini `resumeFlag()` returns `'--resume latest'`
- [ ] `remove_member` cleans up stored env vars
- [ ] All existing tests pass

---

## Phase 4 — Tests

### Task 9: Tests for platform fixes + auth env prefix helper

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
  - Values with special characters are escaped

**Done:** All new tests pass. Existing platform tests updated and passing.

### Task 10: Tests for env var injection + Gemini + CLI_PATH rename

**Files:**
- `tests/providers.test.ts` — update Gemini tests for `parseResponse()` and `resumeFlag()`
- `tests/platform.test.ts` — verify `CLI_PATH` rename didn't break command output (existing tests cover this implicitly via `agentCommand`, `agentVersion`, `buildAgentPromptCommand` tests)

**Details:**
- Gemini `parseResponse()` test: successful response should return `sessionId: 'gemini-latest'`
- Gemini `resumeFlag()` test: should return `'--resume latest'` regardless of argument
- Verify existing `buildAgentPromptCommand` tests still pass (they test command output, not constant names)

**Done:** All Gemini tests updated and passing. Platform tests still pass.

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
| 6 | Rename `CLAUDE_PATH` → `CLI_PATH` | os/linux.ts, os/windows.ts | 3 |
| 7 | Fix Gemini session resume (sentinel + `--resume latest`) | providers/gemini.ts | 3 |
| 8 | Verify `remove_member` cleanup of stored env vars | tools/remove-member.ts | 3 |
| 9 | Tests: platform fixes + auth env prefix helper | tests/platform.test.ts, tests/auth-env.test.ts (new) | 4 |
| 10 | Tests: Gemini fixes + injection verification | tests/providers.test.ts, tests/platform.test.ts | 4 |

## Out of Scope
- Gemini CLI Node 22 requirement (doc-only)
- Gemini settings.json auth (doesn't work)
- Long-running task env var injection (separate concern)
- Integration tests with real Gemini API (requires API key + live member)
