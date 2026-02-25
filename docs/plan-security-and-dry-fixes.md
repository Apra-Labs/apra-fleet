# Plan: Security Fixes & DRY Refactoring

## Context

A deep code review identified:
- **5 CRITICAL** command injection vulnerabilities (CWE-78) — user-controlled strings (folder paths, tokens, session IDs) flow unsanitized into shell commands
- **5 HIGH** severity issues — weak KDF, plaintext OAuth token, permissive directory permissions
- **12 DRY violations** — repeated agent lookup patterns, duplicated command building, test helper duplication

This plan addresses all critical/high security issues and the highest-impact DRY violations.

---

## Phase 1: Shell Escaping Foundation

**Create `src/utils/shell-escape.ts`** — centralized escaping functions used by all subsequent fixes.

| Function | Purpose |
|----------|---------|
| `escapeShellArg(s)` | Escape a string for use inside single-quoted Unix shell args |
| `escapeDoubleQuoted(s)` | Escape a string for use inside double-quoted Unix shell args |
| `escapeWindowsArg(s)` | Escape for Windows cmd.exe double-quoted args (`"`, `&`, `\|`, `^`) |
| `escapeGrepPattern(s)` | Escape regex metacharacters for `grep -E` |
| `sanitizeSessionId(s)` | Validate session ID is alphanumeric+dash+underscore only |

**New tests:** `tests/shell-escape.test.ts`

---

## Phase 2: Fix CRITICAL Command Injection in `platform.ts`

**File: `src/utils/platform.ts`**

| Function | Fix |
|----------|-----|
| `getFleetProcessCheckCommand()` | Use `escapeGrepPattern()` on folder and sessionId for Unix; use `escapeWindowsArg()` on folder and sessionId for Windows |
| `getSetEnvCommand()` | Use `escapeDoubleQuoted()` on the value before interpolating into `export NAME="value"` |
| `getUnsetEnvCommand()` | Already safe (no user values), but audit for consistency |
| `getMkdirCommand()` | Use `escapeDoubleQuoted()` on folder |
| `getDiskCommand()` | Use `escapeDoubleQuoted()` on folder (Unix), `escapeWindowsArg()` on drive letter (Windows) |

**Updated tests:** `tests/platform.test.ts` — add injection-attempt test cases (folder with `$(whoami)`, `"&whoami&"`, etc.)

---

## Phase 3: Fix CRITICAL Command Injection in Tool Files

**File: `src/tools/execute-prompt.ts`**
- Use `escapeDoubleQuoted()` on `agent.remoteFolder` in the `cd` command
- Use `sanitizeSessionId()` on `agent.sessionId` before `--resume`
- Extract duplicated command building into `buildClaudeCommand()` helper (also fixes DRY violation #5)

**File: `src/tools/provision-auth.ts`**
- Use `escapeDoubleQuoted()` on `agent.remoteFolder` and `input.fleet_token` in the auth test command (line 59)
- The token passed to `getSetEnvCommand()` is now safe because Phase 2 fixed that function

---

## Phase 4: Fix HIGH — Directory Permissions, Encrypt Fleet Token, Improve KDF

**File: `src/services/registry.ts`**
- `ensureFleetDir()`: add `mode: 0o700` to both `mkdirSync` calls
- `setFleetToken()`: encrypt token with `encryptPassword()` before storing
- `getFleetToken()`: decrypt with `decryptPassword()` before returning
- Rename stored field from `fleetToken` to `encryptedFleetToken` (migrate on load)

**File: `src/utils/crypto.ts`**
- Replace static salt `'claude-fleet-salt'` with a per-installation random salt
- Store salt in `~/.claude-fleet/salt` file (generated once, 32 random bytes)
- `deriveKey()` reads salt from file, creates if missing
- **Backward compatibility:** try new per-install salt first, fall back to old static salt if decryption fails. This means existing encrypted passwords still work after upgrade, but users are encouraged to re-provision for stronger encryption.

**File: `src/tools/setup-ssh-key.ts`**
- Already uses `getKeysDir()` which calls `ensureFleetDir()` — the permission fix in `registry.ts` covers this.

**Updated tests:** `tests/crypto.test.ts` — verify salt file creation, backward-compat fallback.

---

## Phase 5: DRY — Create `src/utils/agent-helpers.ts`

Extract repeated patterns from all 10 tool files:

| Helper | Replaces | Used in |
|--------|----------|---------|
| `getAgentOrFail(id)` | 9x agent lookup + "not found" return | all tool files except list-agents, check-status |
| `getAgentOS(agent)` | 5x `agent.os ?? 'linux'` | agent-detail, execute-prompt, provision-auth, remove-agent, update-claude |
| `formatAgentHost(agent)` | 4x `agent.agentType === 'local' ? '(local)' : ...` | check-status, list-agents, agent-detail |
| `touchAgent(agentId, sessionId?)` | 3x `updateAgent(id, { lastUsed: ... })` | execute-prompt, provision-auth, send-files |
| `buildClaudeCommand(os, folder, b64, sessionId?)` | 2x identical command builder | execute-prompt (initial + retry) |

**New tests:** `tests/agent-helpers.test.ts`

---

## Phase 6: DRY — Create `tests/test-helpers.ts`

Extract from `tests/registry.test.ts` and `tests/strategy.test.ts`:

| Helper | Replaces |
|--------|----------|
| `makeTestAgent(overrides)` | `makeAgent()` in registry.test.ts + `makeRemoteAgent()` in strategy.test.ts |
| `makeTestLocalAgent(overrides)` | `makeLocalAgent()` in strategy.test.ts |
| Shared `beforeEach`/`afterEach` registry backup | Duplicated backup/restore logic in registry.test.ts |

---

## Implementation Order & Test Checkpoints

```
Phase 1: shell-escape.ts + tests       → npm run build && npm test
Phase 2: platform.ts fixes + tests     → npm run build && npm test
Phase 3: execute-prompt + provision-auth → npm run build && npm test
Phase 4: registry + crypto + perms      → npm run build && npm test
Phase 5: agent-helpers.ts + refactor    → npm run build && npm test
Phase 6: test-helpers.ts + refactor     → npm run build && npm test
Final: commit and push
```

Each phase is independently testable. Later phases depend on earlier ones (Phase 2-3 use Phase 1 escaping functions; Phase 5 uses Phase 3 command builder).

---

## Security Issues NOT Addressed (Accepted Risk)

| Issue | Severity | Why deferred |
|-------|----------|--------------|
| No SSH host key verification | MEDIUM | Requires user interaction for fingerprint confirmation; would break automated workflows. Could add opt-in `strict_host_key` flag later. |
| TOCTOU race in duplicate folder check | MEDIUM | Single-user CLI tool — concurrent registrations are extremely unlikely. File locking adds complexity for negligible benefit. |
| No registry JSON schema validation | MEDIUM | Registry is in user's home dir with restricted permissions (after Phase 4). Malformed JSON would cause a parse error, not code execution. |
| Decrypted password in memory | LOW | Inherent to any password-based SSH. Mitigated by encouraging key auth via `setup_ssh_key`. |
| No rate limiting | LOW | MCP runs over stdio from a local Claude CLI — not exposed to network. |
