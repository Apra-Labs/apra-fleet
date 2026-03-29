# PR #14 Review: Fix Windows VCS auth — PowerShell syntax + token expiry tracking

## Summary of Changes

**10 commits, 17 files changed** (+207, -863 lines — net deletion largely from docs site removal)

### 1. Windows PowerShell credential helper fix (core fix)
- `src/os/windows.ts` `gitCredentialHelperWrite`: replaced PowerShell here-string (`@'...'@`) with array `-join` approach
- Here-strings break over SSH because the multiline delimiters don't survive remote command execution
- The new approach builds a `.bat` script from a PowerShell array joined with `` `r`n `` — single statement, no line-boundary issues

### 2. Host-specific git credential config key
- Changed from global `credential.helper` to host-scoped `credential.https://<host>.helper`
- Applied to **all three OS implementations** (linux, macos, windows) and all three VCS providers
- Uses `--replace-all` to reset the host-specific stack, then `--add` to set the fleet helper
- **Why this matters**: the global `credential.helper` key gets overwritten by `gh auth setup-git` and other tools; host-scoped keys take priority and coexist safely

### 3. Token expiry tracking
- Added `vcsProvider` and `vcsTokenExpiresAt` (ISO 8601) fields to `Agent` type
- `provisionVcsAuth` persists these in the registry after successful deploy
- New `checkVcsTokenExpiry()` helper warns when tokens are expired or expiring within 10 minutes
- Expiry warning is appended to the provision output message

### 4. Unrelated: docs site deletion
- Deleted `docs/site/icons/icon.svg` and `docs/site/index.html` (~826 lines)

---

## Issues Found

### MEDIUM: Batch metacharacter risk in Windows `.bat` credential helper

**File**: `src/os/windows.ts:144`

The token is escaped for PowerShell single-quoted strings (`'` → `''`) but is written into a `.bat` file that `cmd.exe` executes. Batch metacharacters (`&`, `|`, `>`, `<`, `^`, `%`) in the token value would break the batch script or cause unexpected behavior.

The Linux version properly escapes shell metacharacters via `escapeDoubleQuoted()`. The Windows version has no equivalent batch-level escaping.

**Practical risk**: LOW — GitHub tokens (`ghp_`, `ghs_`), Bitbucket app passwords, and Azure DevOps PATs are alphanumeric/base64 and won't contain these characters. But it's a correctness gap.

**Recommendation**: Consider wrapping the token value with `^` escaping for batch metacharacters, or document that this is a known limitation for exotic token formats.

### LOW: Docs deletion is unrelated to PR scope

The PR title is "Fix Windows VCS auth: PowerShell syntax + token expiry tracking" but it also deletes `docs/site/` files. This should ideally be a separate commit or PR for cleaner git history and easier reverts.

### LOW: Redundant `?? undefined`

**File**: `src/tools/provision-vcs-auth.ts:97`
```ts
vcsTokenExpiresAt: deployResult.metadata?.expiresAt ?? undefined,
```
The `?? undefined` is redundant since optional chaining already returns `undefined`. Harmless but noisy.

---

## Test Coverage Assessment

**Excellent**. All new behavior has dedicated tests:

| Area | Tests | Quality |
|------|-------|---------|
| Windows credential helper (no here-string) | 6 tests in `windows-credential-helper.test.ts` | Covers: no here-string syntax, single quotes, double quotes, dollar signs, backticks, `-join` usage, cmd metachar escaping |
| Token expiry logic | 5 tests in `agent-helpers.test.ts` | Covers: no expiry, not near expiry, 5-min warning, expired, singular "minute" |
| Registry persistence | 2 tests in `provision-vcs-auth.test.ts` | Covers: github-app persists both fields, bitbucket persists provider without expiresAt |
| Host-specific credential key | Cross-platform tests in `platform.test.ts` | Covers all 3 OSes × 3 VCS hosts, verifies `credential.https://<host>.helper` format |
| Revoke uses host-specific key | Updated in `revoke-vcs-auth.test.ts` | Verifies `credential.https://` in unset command |

Tests verify real behavior (command output content, registry state after operations), not just mock interactions.

---

## Security Assessment

- **Token masking**: Tokens are masked in output (`token.substring(0, 4) + '****'`) — correct
- **File permissions**: `.bat` credential helper file is ACL'd to current user only via `icacls /inheritance:r /grant:r "${u}:F"` — correct
- **Input escaping**: Host and username go through `escapeWindowsArg` (cmd.exe metachar escaping). Token gets PowerShell single-quote escaping. No injection vectors found for expected token formats
- **No secrets in code**: All tokens are passed at runtime, never hardcoded
- **The `.bat` file stores the token in plaintext** on disk — this is inherent to git credential helpers and matches the Linux approach (`~/.fleet-git-credential` shell script). The file permission lockdown mitigates this

---

## Final Verdict

The PR delivers exactly what it claims: a correct fix for PowerShell here-string syntax over SSH, a robust host-specific credential config approach that prevents `gh` CLI conflicts, and clean token expiry tracking. Test coverage is thorough. The one medium issue (batch metachar escaping) is low practical risk for real VCS tokens but worth noting for completeness.

**APPROVED**
