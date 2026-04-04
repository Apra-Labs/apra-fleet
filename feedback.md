## Review: sprint/oauth-providers Plan
Date: 2026-04-04
Reviewer: fleet-rev

## Verdict: CHANGES NEEDED

## Issues

1. **R1 not covered** — The plan never adds `oauthCredentialFiles()`, `oauthSettingsMerge()`, or `oauthEnvVarsToUnset()` to `ProviderAdapter`. Instead it parameterizes existing methods with a `provider` object, which only exposes `credentialPath` (a single path string). This cannot handle Gemini's 3-file OAuth or per-provider settings merge.

2. **R2 not covered** — No mention of implementing the three new methods in `GeminiProvider`. Gemini OAuth requires copying `oauth_creds.json`, `google_accounts.json`, AND merging `settings.json` with `selectedType: 'oauth-personal'`. The plan also omits unsetting `GEMINI_API_KEY` from remote shell profiles after OAuth provisioning. The `composePermissionConfig` overwrite-vs-merge issue is also not addressed.

3. **R3 not covered** — No mention of implementing the new interface methods in `ClaudeProvider` or migrating away from `supportsOAuthCopy()`. The existing hard-coded `readMasterCredentials()` path (`~/.claude/.credentials.json`) would remain.

4. **R4 partially covered** — Task 4 refactors `provision-auth.ts` but only parameterizes the single credential path. It does not implement the generic `provisionOAuthCopy()` flow that iterates `oauthCredentialFiles()`, calls `oauthSettingsMerge()`, and runs `oauthEnvVarsToUnset()`. The hard-coded Claude-only `readMasterCredentials()` and `verifyWithClaudePrompt()` remain.

5. **R6 not covered** — No settings merge helper (deep-merge read/merge/write) is planned. This is critical for both Gemini OAuth provisioning and fixing the `composePermissionConfig` overwrite bug.

6. **R7 not covered** — No investigation or stubs for Codex and Copilot providers.

7. **R8 not covered** — No changes to `member_detail` auth mode display.

8. **R5 partially covered** — The plan parameterizes `credentialFileWrite`/`credentialFileRemove` with a `provider` object rather than a `destPath` string as specified. More importantly, it doesn't account for writing *multiple* files per provider (Gemini needs 2 credential files + 1 merged settings file).

## What's Good

1. **Correct starting point** — Phase 1 correctly identifies that `os-commands.ts` credential helpers need to be parameterized away from hardcoded Claude paths.

2. **Build verification** — Task 6 includes a build+test verification step.

3. **Clean phasing** — The two-phase structure (OS layer first, then orchestration) is a reasonable dependency order.

4. **Scope awareness** — The plan touches the right files (`os-commands.ts`, `provision-auth.ts`, `remove-member.ts`), it just doesn't go deep enough on the interface changes needed.
