# Fix Windows VCS Auth — PowerShell + Token Expiry

## Context
Two bugs in the VCS credential provisioning flow break Windows members:

1. **PowerShell here-string syntax error** in `src/os/windows.ts:139-155` — `gitCredentialHelperWrite()` joins here-string delimiters (`@'` / `'@`) with semicolons, but PowerShell requires these on their own lines. The entire `provision_vcs_auth` tool is broken on Windows.

2. **Token expiry not persisted** — `mintGitToken()` returns `expiresAt` but it's only shown in transient metadata, never stored. No refresh, no warning. GitHub App tokens expire in ~1 hour. After expiry, all git ops fail silently.

## Requirements
- Fix the PowerShell script generation so `gitCredentialHelperWrite` works on Windows
- Persist token expiry in the agent registry so the system knows when credentials expire
- Add a check/warning mechanism when tokens are near or past expiry
- All existing tests must pass (`npm test`)
- Add new tests for the fixed Windows credential helper and token expiry tracking

## Branch
`fix/windows-vcs-auth`

---

## Phase 1: Fix PowerShell here-string bug

### T1: Fix `gitCredentialHelperWrite` in `src/os/windows.ts`
**File:** `src/os/windows.ts` lines 139-155
**Problem:** The method uses PowerShell here-strings (`@'...'@`) joined with `; `. PowerShell requires `@'` and `'@` to be alone on their own lines — incompatible with semicolon joining.
**Approach:** Replace the here-string with backtick-escaped newlines in a regular string, or use the same `Set-Content` + base64 pattern used by `credentialFileWrite()` (line 107-111). Look at how `credentialFileWrite` in the same file uses `Buffer.from(...).toString('base64')` + `powershell -EncodedCommand` — this is robust and avoids all quoting issues.
**Done:** Method generates valid PowerShell that creates the credential helper `.bat` file on Windows. Manual inspection of output string shows no here-string delimiters.

### T2: Add unit test for Windows credential helper
**File:** New test file or add to existing test suite
**Test:** Call `gitCredentialHelperWrite('github.com', 'x-access-token', 'ghu_test123')` and verify the output is valid PowerShell (no `@'` on same line as other content). Also test with tokens containing special chars (`'`, `"`, `$`, `` ` ``).
**Done:** Test passes, covers normal and special-char cases.

### V1: Verify Phase 1 (checkpoint)
**Type:** verify
Run `npm test`. Confirm all tests pass. Push branch.

---

## Phase 2: Persist token expiry

### T3: Add VCS credential fields to Agent type
**File:** `src/types.ts`
**Change:** Add optional fields to the `Agent` interface:
```typescript
vcsProvider?: 'github' | 'bitbucket' | 'azure-devops';
vcsTokenExpiresAt?: string;  // ISO 8601
```
**Done:** Fields added, `npm run build` succeeds.

### T4: Persist expiry after token deployment
**File:** `src/tools/provision-vcs-auth.ts`
**Change:** After successful deploy, save `vcsProvider` and `vcsTokenExpiresAt` to the agent registry. Use the existing `touchAgent` pattern — look at how `touchAgent` works and extend it or add a separate registry update.
**Also:** `src/services/vcs/github.ts` — ensure `expiresAt` is available in the deploy result metadata (it already is).
**Done:** After `provision_vcs_auth` succeeds, `registry.json` contains the expiry timestamp for that agent.

### T5: Add expiry warning to fleet status and pre-operation checks
**File:** `src/tools/provision-vcs-auth.ts` or relevant status tool
**Change:** When displaying VCS status or before git operations, check `vcsTokenExpiresAt`. If expired or expiring within 10 minutes, include a warning in the output. This is a lightweight check — no auto-refresh needed in this PR.
**Done:** Expired/expiring tokens show a warning.

### T6: Add tests for token expiry persistence
**Test:** Verify that after a mock deploy, the agent registry contains the expiry fields. Verify warning logic for expired/near-expiry tokens.
**Done:** Tests pass.

### V2: Verify Phase 2 (checkpoint)
**Type:** verify
Run `npm test`. Confirm all tests pass. Run `npm run build`. Push branch.
