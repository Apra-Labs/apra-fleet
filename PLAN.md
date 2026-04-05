# Plan: DRY OAuth Support in provision_auth (Issue #62)

## Phase 1: ProviderAdapter Interface + Provider Implementations
- Task 1.1: Add to ProviderAdapter interface (src/providers/provider.ts):
  - oauthCredentialFiles(): Array<{localPath: string; remotePath: string}> | null
  - oauthSettingsMerge(): Record<string, unknown> | null
  - oauthEnvVarsToUnset(): string[]
- Task 1.2: Implement in ClaudeProvider (src/providers/claude.ts):
  - oauthCredentialFiles() returns [{localPath: '~/.claude/.credentials.json', remotePath: '~/.claude/.credentials.json'}]
  - oauthSettingsMerge() returns null
  - oauthEnvVarsToUnset() returns []
  - Remove supportsOAuthCopy() from interface after migration
- Task 1.3: Implement in GeminiProvider (src/providers/gemini.ts):
  - oauthCredentialFiles() returns the 3 files: oauth_creds.json, google_accounts.json, settings.json (localPath and remotePath both under ~/.gemini/)
  - oauthSettingsMerge() returns {security: {auth: {selectedType: 'oauth-personal'}}}
  - oauthEnvVarsToUnset() returns ['GEMINI_API_KEY']
  - Fix composePermissionConfig to READ existing settings.json, merge mode change, write back (do not overwrite)
- Task 1.4: Codex and Copilot stubs — check src/providers/codex.ts and copilot.ts, add stub implementations returning null/[] with comment explaining no OAuth support
- Task 1.5: VERIFY — build passes, all providers implement the interface

## Phase 2: Settings Merge Helper + OS Commands Fix
- Task 2.1: Add settings merge helper to src/os/os-commands.ts (or new file):
  - readRemoteJson(destPath): reads existing JSON file on remote, returns {} if missing
  - deepMergeJson(destPath, newObj): reads existing, deep-merges, writes back
- Task 2.2: Parameterize credentialFileWrite(content, destPath) and credentialFileRemove(destPath) — remove hardcoded Claude path, accept destPath parameter
- Task 2.3: VERIFY — build passes

## Phase 3: DRY provision_auth Orchestration
- Task 3.1: Refactor src/tools/provision-auth.ts:
  - If input.api_key -> existing provisionApiKey path (no change)
  - Else if provider.oauthCredentialFiles() -> new provisionOAuthCopy(agent, provider):
    1. For each file in oauthCredentialFiles(): read local file, write to remote via credentialFileWrite(content, file.remotePath)
    2. If oauthSettingsMerge(): call deepMergeJson on remote settings file
    3. For each var in oauthEnvVarsToUnset(): remove from ~/.zshrc, ~/.bash_profile, ~/.bashrc, ~/.zprofile
    4. Verify auth (existing verify logic)
  - Else -> existing collectOobApiKey fallback
- Task 3.2: Update src/tools/remove-member.ts — call credentialFileRemove(file.remotePath) for each file in provider.oauthCredentialFiles() ?? []
- Task 3.3: VERIFY — build + full test suite passes, zero regressions

## Phase 4: member_detail Auth Mode (R8)
- Task 4.1: Update src/tools/member-detail.ts and src/tools/list-members.ts:
  - If OAuth files exist on remote AND no API key env var -> auth=oauth
  - If API key env var set -> auth=api-key
  - If both -> auth=api-key (WARNING: OAuth also present — API key takes precedence)
- Task 4.2: VERIFY — final build + tests green, push