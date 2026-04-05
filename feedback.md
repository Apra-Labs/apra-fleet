## Review: sprint/oauth-providers Plan v2
Date: 2026-04-04
Reviewer: fleet-rev

## Verdict: CHANGES NEEDED

**Note:** PLAN.md is unchanged from v1 review. The same 6-task plan remains. All previously identified gaps persist.

## Remaining Gaps

1. **R1 not covered** — `ProviderAdapter` never gets `oauthCredentialFiles()`, `oauthSettingsMerge()`, or `oauthEnvVarsToUnset()`. The plan only parameterizes existing methods with a `provider` object exposing `credentialPath` (single string), which cannot handle multi-file OAuth (Gemini needs 3 files) or per-provider settings merge/env cleanup.

2. **R2 not covered** — No `GeminiProvider` implementation of the three new methods. Missing: `oauth_creds.json` + `google_accounts.json` copy, `settings.json` merge with `selectedType: 'oauth-personal'`, `GEMINI_API_KEY` unset, and fix for `composePermissionConfig` overwriting settings.json.

3. **R3 not covered** — No `ClaudeProvider` migration to new interface methods. `supportsOAuthCopy()` removal not planned.

4. **R4 partially covered** — Task 4 parameterizes the single credential path but does not implement the generic `provisionOAuthCopy()` loop over `oauthCredentialFiles()` → `oauthSettingsMerge()` → `oauthEnvVarsToUnset()`.

5. **R5 partially covered** — Parameterizes with `provider` object instead of `destPath` string. Does not support writing multiple files per provider.

6. **R6 not covered** — No `deepMergeJson` helper for read-merge-write of settings files.

7. **R7 not covered** — No Codex/Copilot stubs with null returns.

8. **R8 not covered** — No `member_detail` or `list-members` auth mode detection changes.

## What's Good

1. Correct identification that `os-commands.ts` credential helpers need parameterization.
2. Build+test verification step included.
3. Two-phase structure (OS layer → orchestration) is sound dependency ordering.
4. Touches the right files — needs deeper interface-level changes within them.
