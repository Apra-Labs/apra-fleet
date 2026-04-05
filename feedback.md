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
