# Requirements: provision_auth OAuth support for all providers
Issue: #62
Sprint: fleet-sprint-62
Date: 2026-04-04

## Background

`provision_auth` currently has two hard-coded paths:
- **OAuth copy** — only for Claude (`provider.supportsOAuthCopy()` returns true only for Claude). Copies `~/.claude/.credentials.json` to the remote member.
- **API key** — for all providers, either via `api_key` param or OOB terminal prompt.

Gemini, Codex, and Copilot all have OAuth credential files, but the server has no mechanism to copy them. Users authenticating their local Gemini CLI via OAuth are forced to use an API key instead. This session exposed the problem: deploying Gemini OAuth to a remote macOS member required manually reading local files, encoding them, and piping via `execute_command`. It should be a single `provision_auth` call.

Additionally, `composePermissionConfig` in `GeminiProvider` overwrites `~/.gemini/settings.json` entirely, clobbering the `security.auth.selectedType` field needed for OAuth. Settings writes must MERGE with existing content, not replace.

## Key Files

- `src/tools/provision-auth.ts` — provision_auth orchestration
- `src/tools/remove-member.ts` — cleanup on member removal
- `src/providers/provider.ts` — `ProviderAdapter` interface
- `src/providers/gemini.ts` — Gemini adapter
- `src/providers/claude.ts` — Claude adapter (reference implementation)
- `src/os/os-commands.ts` — `credentialFileWrite`, `credentialFileRemove` (currently hardcode Claude paths)
- `src/tools/list-members.ts` and `src/tools/member-detail.ts` — auth mode display

## Gemini OAuth: 3 Files Required (from #63)

Deploying Gemini OAuth requires ALL THREE files (missing any one causes fallback to API key or hang):
1. `~/.gemini/oauth_creds.json` — OAuth access token
2. `~/.gemini/google_accounts.json` — active account: `{"active": "user@gmail.com", "old": []}`
3. `~/.gemini/settings.json` — must contain `{"security": {"auth": {"selectedType": "oauth-personal"}}}` — MERGED with existing keys (e.g. `mode`)

Additionally: `GEMINI_API_KEY` in shell env overrides OAuth even when settings.json is correct. `provision_auth` OAuth path must unset it on the remote.

## Requirements

### R1 — Extend ProviderAdapter interface (src/providers/provider.ts)

Add to `ProviderAdapter`:
```ts
// Returns list of local OAuth credential files to copy, in order. null = no OAuth support.
oauthCredentialFiles(): Array<{ localPath: string; remotePath: string }> | null;

// Returns additional config to merge into remote settings after OAuth copy (e.g. settings.json auth type).
// Return null if no settings merge needed.
oauthSettingsMerge(): Record<string, unknown> | null;

// Returns env vars to unset on remote after OAuth copy (e.g. GEMINI_API_KEY).
oauthEnvVarsToUnset(): string[];
```

### R2 — Implement in GeminiProvider (src/providers/gemini.ts)

```ts
oauthCredentialFiles() {
  return [
    { localPath: '~/.gemini/oauth_creds.json',      remotePath: '~/.gemini/oauth_creds.json' },
    { localPath: '~/.gemini/google_accounts.json',   remotePath: '~/.gemini/google_accounts.json' },
  ];
}

oauthSettingsMerge() {
  return { security: { auth: { selectedType: 'oauth-personal' } } };
}

oauthEnvVarsToUnset() {
  return ['GEMINI_API_KEY'];
}
```

Also fix `composePermissionConfig`: when writing `~/.gemini/settings.json`, READ existing content first, merge the mode change, write back. Do not overwrite.

### R3 — Implement in ClaudeProvider (src/providers/claude.ts)

Migrate existing OAuth copy logic to use the new interface:
```ts
oauthCredentialFiles() {
  return [{ localPath: '~/.claude/.credentials.json', remotePath: '~/.claude/.credentials.json' }];
}
oauthSettingsMerge() { return null; }
oauthEnvVarsToUnset() { return []; }
```

Remove `supportsOAuthCopy()` from interface after migration (or keep for backwards compat — decide during implementation).

### R4 — DRY provision_auth orchestration (src/tools/provision-auth.ts)

Refactor so OAuth copy is provider-generic:
```
if (input.api_key) → provisionApiKey (existing, no change)
else if provider.oauthCredentialFiles() → provisionOAuthCopy (generalized)
else → collectOobApiKey (existing fallback)
```

`provisionOAuthCopy(agent, provider)`:
1. For each file in `provider.oauthCredentialFiles()`: read local file, copy to remote via existing `credentialFileWrite` mechanism
2. If `provider.oauthSettingsMerge()`: read existing remote settings JSON, deep-merge, write back
3. For each var in `provider.oauthEnvVarsToUnset()`: remove from remote shell profiles (`~/.zshrc`, `~/.bash_profile`, `~/.bashrc`, `~/.zprofile`)
4. Verify auth works (existing verify logic)

### R5 — Fix os-commands.ts credential helpers

`credentialFileWrite(content, destPath)` and `credentialFileRemove(destPath)` currently hardcode the Claude credential path. Parameterize with `destPath`.

Update `remove-member.ts` to call `credentialFileRemove(provider.oauthCredentialFiles()?.[0]?.remotePath)` for cleanup.

### R6 — Settings merge helper

Add a helper (in `os-commands.ts` or a new `settings-merge.ts`) that:
1. Reads existing JSON file on remote (returns `{}` if missing)
2. Deep-merges new object in
3. Writes back

Used by `provisionOAuthCopy` for `oauthSettingsMerge()` and by `composePermissionConfig` in Gemini.

### R7 — Codex and Copilot

Investigate whether they have OAuth credential files. If yes, implement. If no, implement stubs returning `null` with a comment explaining why.

### R8 — member_detail auth mode

`member_detail` currently shows `auth=OAuth credentials file, API key (env)` when both are present. After this sprint, it should show only the active auth mode. If OAuth files exist on remote AND no API key env var → `auth=oauth`. If API key env var → `auth=api-key`. If both → warn: `auth=api-key (WARNING: OAuth also present — API key takes precedence)`.

## Acceptance Criteria

- `provision_auth` on a Gemini member (no `api_key` param) copies all 3 OAuth files and merges settings.json
- `provision_auth` on a Claude member is unchanged
- `composePermissionConfig` in Gemini merges settings.json instead of overwriting
- `GEMINI_API_KEY` is unset from remote shell profiles after Gemini OAuth provisioning
- `remove_member` cleans up OAuth credential files for any provider
- All provider OAuth paths defined in `ProviderAdapter` — zero hardcoding in `provision_auth.ts` or `remove_member.ts`
- Build passes, existing tests pass
- Codex/Copilot: investigated and either implemented or documented why not

## Out of Scope
- OAuth device flow / browser-based login
- Refresh token rotation
- First-run interactive trust prompt (tracked in #63)
