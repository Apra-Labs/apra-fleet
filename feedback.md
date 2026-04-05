## Review: sprint/oauth-providers Plan v2
Date: 2026-04-04
Reviewer: fleet-rev

## Verdict: APPROVED

All 8 requirements (R1–R8) are now covered in the rewritten 4-phase plan.

## Requirement Coverage

| Req | Status | Plan Task |
|-----|--------|-----------|
| R1 | Covered | Task 1.1 — adds `oauthCredentialFiles()`, `oauthSettingsMerge()`, `oauthEnvVarsToUnset()` to ProviderAdapter |
| R2 | Covered | Task 1.3 — GeminiProvider returns 3 files, settings merge with `selectedType: 'oauth-personal'`, `GEMINI_API_KEY` unset, plus `composePermissionConfig` merge fix |
| R3 | Covered | Task 1.2 — ClaudeProvider migrated, `supportsOAuthCopy()` removal planned |
| R4 | Covered | Task 3.1 — generic `provisionOAuthCopy(agent, provider)` loop: iterate files → settings merge → env unset → verify |
| R5 | Covered | Task 2.2 — `credentialFileWrite(content, destPath)` and `credentialFileRemove(destPath)` parameterized |
| R6 | Covered | Task 2.1 — `deepMergeJson` helper (read existing → deep-merge → write back) |
| R7 | Covered | Task 1.4 — Codex/Copilot stubs returning null/[] with comments |
| R8 | Covered | Task 4.1 — `member_detail` and `list-members` auth mode detection (oauth / api-key / warning) |

## What's Good

1. **Clean 4-phase structure** — interface first, then helpers, then orchestration, then display. Each phase has a verify step.
2. **Multi-file OAuth** — correctly models Gemini's 3-file requirement with per-file local→remote copy.
3. **Settings merge** — both provisioning and `composePermissionConfig` use the same `deepMergeJson` helper, avoiding duplicate logic.
4. **Env var cleanup** — `oauthEnvVarsToUnset()` addresses the `GEMINI_API_KEY` override issue explicitly.
5. **Remove-member cleanup** — Task 3.2 iterates all OAuth files for cleanup, not just the first one.
6. **Progress tracking** — `progress.json` has 13 discrete tasks matching the plan, ready for execution.

## Minor Notes (non-blocking)

- Task 1.3 lists `settings.json` as the 3rd file in `oauthCredentialFiles()`, but per R2 the settings file should be handled via `oauthSettingsMerge()` (merge, not copy). The plan's Task 3.1 step 2 already handles this correctly — just ensure Task 1.3 implementation only returns the 2 credential files (`oauth_creds.json`, `google_accounts.json`) in `oauthCredentialFiles()`, with `settings.json` handled exclusively by `oauthSettingsMerge()`.
- Consider whether `readRemoteJson` in Task 2.1 belongs in `os-commands.ts` (OS-specific) or a standalone util. Either works — just a naming/organization choice.
