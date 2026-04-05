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
