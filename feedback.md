## Review: sprint/oauth-providers Phase 1
Date: 2026-04-04
Reviewer: fleet-rev

## Verdict: APPROVED

## Issues
None.

## What's Good
- R1: Interface signatures are correct — `oauthCredentialFiles()` returns `Array<{localPath, remotePath}> | null`, `oauthSettingsMerge()` returns `Record<string, unknown> | null`, `oauthEnvVarsToUnset()` returns `string[]`. Clean nullable design lets callers skip providers that don't need OAuth.
- R2 (Gemini): `oauthCredentialFiles()` correctly returns `oauth_creds.json` + `google_accounts.json` (not settings.json). `oauthSettingsMerge()` returns `{security:{auth:{selectedType:'oauth-personal'}}}` — properly separated from credential files. `oauthEnvVarsToUnset()` returns `['GEMINI_API_KEY']` so the CLI falls through to OAuth.
- R3 (Claude): `oauthCredentialFiles()` returns `~/.claude/.credentials.json`. `oauthSettingsMerge()` returns `null` (Claude needs no settings merge). `oauthEnvVarsToUnset()` returns `[]` (no env var conflict).
- R7: Codex and Copilot stubs return `null`/`[]` with explanatory comments — correctly indicates no OAuth support.
- All four provider classes satisfy the `ProviderAdapter` interface with no type errors.
- Existing methods are unchanged — no regressions.
- Previous plan review note about settings.json separation was correctly implemented: Gemini's `oauthCredentialFiles()` returns only the 2 credential files, settings handled exclusively via `oauthSettingsMerge()`.

---

## Review: sprint/oauth-providers Phase 2
Date: 2026-04-04
Reviewer: fleet-rev

## Verdict: APPROVED

## Issues
None.

## What's Good
- R5: `credentialFileWrite(content, destPath)` and `credentialFileRemove(destPath)` are fully parameterized — no hardcoded paths in Linux or Windows implementations. `credentialFileCheck(destPath)` also parameterized consistently.
- R6: `deepMergeJson(destPath, newObj)` — Linux uses inline Node.js script that reads existing file, falls back to `{}` on missing/invalid, performs recursive deep merge (nested objects merged, arrays replaced not clobbered as objects), and writes back with `JSON.stringify(merged, null, 2)`. Parent dir created via `mkdir -p`.
- R6 Windows: PowerShell `Merge-Objects` function recurses on PSCustomObject properties, `ConvertTo-Json -Depth 99` preserves nesting, falls back to `@{}` on missing file. Uses `-EncodedCommand` for safe transport.
- `readRemoteJson` — both platforms return raw JSON text, defaulting to `'{}'` when file is missing. Linux: `[ -f ] && cat || echo '{}'`. Windows: `Test-Path` guard with `Get-Content -Raw`.
- `deep-merge.ts` utility: `isObject()` correctly excludes arrays (`!Array.isArray`). `deepMerge()` recursively merges nested objects; non-object values (including arrays) are replaced wholesale — correct behavior.
- Callers pass explicit paths: `provision-auth.ts:96` calls `credentialFileWrite(creds, '~/.claude/.credentials.json')`, `remove-member.ts:37` calls `credentialFileRemove('~/.claude/.credentials.json')` — same path previously hardcoded, now parameterized.
- No regressions in existing credential handling — method signatures changed but all call sites updated.

---

## Review: sprint/oauth-providers Phase 3
Date: 2026-04-04
Reviewer: fleet-rev

## Verdict: APPROVED

## Issues
None blocking. One minor observation:

- `provision-auth.ts:107` — the `credentialFiles.find(f => f.remotePath.includes('settings.json'))` search is dead code: no provider currently includes `settings.json` in `oauthCredentialFiles()` (settings are handled exclusively via `oauthSettingsMerge()`). The fallback `provider.credentialPath + "/settings.json"` always runs. Not a bug — just unnecessary.

## What's Good

### R4: `provisionOAuthCopy(agent, provider)` orchestration
- Iterates `provider.oauthCredentialFiles()` and writes each file via `credentialFileWrite(content, file.remotePath)` — no hardcoded paths.
- Reads local credential files via `file.localPath.replace('~', os.homedir())`, validates JSON credentials before deploying (expired-no-refresh check).
- If `provider.oauthSettingsMerge()` returns non-null, calls `deepMergeJson` with the provider's settings path — fully provider-generic.
- For each var in `provider.oauthEnvVarsToUnset()`, calls `cmds.unsetEnv()` which removes from `~/.bashrc`/`~/.profile` (consistent with `setEnv` behavior).
- Auth verify runs after OAuth copy: Claude via prompt, others via version check.

### Entry point branching (provision-auth.ts:241-253)
- `if api_key → provisionApiKey` ✅
- `else if oauthCredentialFiles()?.length → provisionOAuthCopy` ✅
- `else → collectOobApiKey` fallback ✅
- Old `readMasterCredentials()` and `provisionMasterToken()` removed — replaced by generic `provisionOAuthCopy`.

### R5 cleanup: `remove-member.ts`
- Loops `provider.oauthCredentialFiles() ?? []` and removes each `file.remotePath` — no hardcoded paths. Previously hardcoded `~/.claude/.credentials.json` is gone.

### Tests
- `provision-auth.test.ts`: Claude OAuth path covered (deploy master creds, missing creds, expired token, refresh token, near-expiry). Assertions updated to match new `"OAuth credentials for claude deployed"` message. Mock intercepts `.credentials.json` reads correctly.
- `tool-provider.test.ts`: OOB fallback test mocks Gemini's `oauthCredentialFiles()` returning `null` to force OOB path — valid. Multi-provider API key tests cover all four providers. No regressions in execute-prompt or update-agent-cli tests.

---

## Review: sprint/oauth-providers Phase 4 (Final) — Merge Gate
Date: 2026-04-04
Reviewer: fleet-rev

## Verdict: APPROVED — ready to merge after CI passes

## Phase 4: R8 Auth Mode Display

### member-detail.ts
- Checks `provider.oauthCredentialFiles()` via `credentialFileCheck(oauthFiles[0].remotePath)` — provider-generic, no hardcoded paths.
- Checks `provider.authEnvVar` via `apiKeyCheck()` — provider-generic.
- Auth mode logic:
  - Both present → `"api-key (WARNING: OAuth also present — API key takes precedence)"` ✅
  - API key only → `"api-key"` ✅
  - OAuth only → `"oauth"` ✅
  - Neither → `"none"` ✅
- Compact format includes `auth=` in output line.

### list-members.ts
- `getAuthStatus()` function performs same provider-generic checks per member.
- Auth mode values: `"api-key (warn: oauth)"`, `"api-key"`, `"oauth"`, `"none"`, `"offline"`, `"N/A"` (local).
- Checks run in parallel via `Promise.all(agents.map(getAuthStatus))`.

### Tests (agent-detail.test.ts)
- `reports no auth when nothing is found` → expects `"none"` ✅
- `detects both auth methods when present` → expects WARNING string ✅
- `detects API key only` → expects `"api-key"` without OAuth mention ✅

## Holistic Sprint Review — Acceptance Criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `provision_auth` on Gemini (no api_key) copies all OAuth files and merges settings.json | ✅ `provisionOAuthCopy` iterates `oauthCredentialFiles()` (2 files for Gemini), then calls `deepMergeJson` with `oauthSettingsMerge()` |
| 2 | `provision_auth` on Claude is unchanged | ✅ Claude path preserved — `oauthCredentialFiles()` returns 1 file, `oauthSettingsMerge()` returns null (no merge), same verification |
| 3 | `composePermissionConfig` in Gemini merges settings.json instead of overwriting | ✅ `deepMergeJson` performs recursive merge |
| 4 | `GEMINI_API_KEY` is unset from remote shell profiles after Gemini OAuth provisioning | ✅ `oauthEnvVarsToUnset()` returns `['GEMINI_API_KEY']`, `provisionOAuthCopy` calls `unsetEnv` for each |
| 5 | `remove_member` cleans up OAuth files for any provider | ✅ Loops `provider.oauthCredentialFiles() ?? []` |
| 6 | Zero hardcoded provider paths in provision-auth.ts or remove-member.ts | ✅ Verified via grep — no matches for `.claude/`, `.gemini/`, `.codex/`, `.copilot/` |
| 7 | Build passes, existing tests pass | ✅ `tsc --noEmit` clean, 612 tests pass (0 failures) |
| 8 | Codex/Copilot stubs return null/[] with comments | ✅ Verified in Phase 1 review |

## Files Changed (30 files, +1350/-110)
- **Provider interface**: `provider.ts` (+3 methods), `claude.ts`, `gemini.ts`, `codex.ts`, `copilot.ts`
- **OS commands**: `os-commands.ts`, `linux.ts`, `windows.ts` (parameterized credential ops, `readRemoteJson`, `deepMergeJson`)
- **Tools**: `provision-auth.ts` (refactored to provider interface), `remove-member.ts` (provider-generic cleanup), `member-detail.ts` (auth display), `list-members.ts` (auth display)
- **Utilities**: `deep-merge.ts` (new)
- **Tests**: `provision-auth.test.ts`, `tool-provider.test.ts`, `agent-detail.test.ts`, `platform.test.ts`
- **Support files**: `requirements.md`, `progress.json`, `feedback.md`, `PLAN.md`, dashboard merge utility, Gemini config files
