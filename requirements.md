# Requirements: Fix provision_auth env var visibility for non-Claude providers

**Issue:** Apra-Labs/apra-fleet#40
**Base branch:** feature/multi-provider
**Sprint:** PM skill fixes + multi-provider testing

## Problem

`provision_auth` with `api_key` parameter fails to make the key visible to subsequent `execute_prompt` / `execute_command` calls on all three platforms (macOS, Windows, Linux). The env var is written to shell profiles that are never sourced in non-interactive SSH sessions.

Confirmed broken during integration testing with Gemini CLI on macOS, Windows, and Linux.

## Root Cause

### macOS (`src/os/macos.ts:20-29`)
`setEnv()` writes to `.bashrc`, `.zshrc`, `.profile` — but **not `.zshenv`**. macOS defaults to zsh. SSH non-interactive sessions only source `~/.zshenv`.

### Windows (`src/os/windows.ts`)
`setEnv()` writes bash-style `export VAR=val >> ~/.bashrc` commands — but Windows OpenSSH server runs **PowerShell**, not bash. These profiles are never read.

### Linux (`src/os/linux.ts`)
`setEnv()` writes to `.bashrc` and `.profile` — but non-interactive SSH sessions on many Linux systems (e.g. Ubuntu) do not source any user dotfiles. Confirmed: env vars set in `.bashrc` and `.profile` are not visible in SSH command execution.

## Design Direction

**Recommended approach:** Rather than relying on shell profiles alone, fleet should:

1. **Store provisioned env vars in fleet's member config** (encrypted, alongside existing auth data in `agents.json`)
2. **Inject them into every command** built by `buildAgentPromptCommand()` and `execute_command`, similar to how `CLAUDE_PATH` already injects `export PATH="$HOME/.local/bin:$PATH" &&`

This makes auth work reliably regardless of which dotfiles the SSH session sources.

Additionally:
- Still write to shell profiles as a fallback (for interactive use, debugging)
- Fix the platform-specific profile issues (`.zshenv` on macOS, PowerShell on Windows)
- Rename `CLAUDE_PATH` to `CLI_PATH` or similar — it's no longer Claude-specific

## Scope

### In scope
- Store API key in member config (encrypted) when `provision_auth` is called with `api_key`
- Inject auth env var into `buildAgentPromptCommand()` on all platforms
- Inject auth env var into `execute_command` on all platforms
- Fix `setEnv()` on macOS to also write `.zshenv`
- Fix `setEnv()` on Windows to use `[System.Environment]::SetEnvironmentVariable()` and PowerShell `$PROFILE`
- Fix `unsetEnv()` to match the new `setEnv()` on all platforms
- Update `revoke_vcs_auth` / `remove_member` to clean up stored env vars
- Rename `CLAUDE_PATH` to `CLI_PATH` (or similar provider-neutral name) across linux.ts and macos.ts
- Fix Gemini session resume: `parseResponse` returns `sessionId: undefined` — should return a sentinel (e.g. `"gemini-latest"`) to signal an active session exists. `resumeFlag()` should return `--resume latest` instead of bare `--resume`. Gemini CLI does not use session IDs — it uses `--resume latest` to resume the most recent session in the project folder.
- Tests for all changed code paths

### Out of scope
- Gemini CLI Node 22 requirement (doc-only, not a code fix)
- Gemini settings.json auth (doesn't work, env var is the only way)

## Security considerations
- API keys stored in member config must be encrypted (like existing `encryptedPassword`)
- API keys must not appear in command output / logs
- `remove_member` must clean up stored keys

## Test plan
- Unit tests for `setEnv` / `unsetEnv` on all 3 platforms
- Unit test for env var injection in `buildAgentPromptCommand`
- Integration test: `provision_auth` → `execute_prompt` on Gemini member (use `gemini-2.5-flash-lite` model to stay within free tier)
- Integration test: Gemini session resume — fresh prompt, then resume with `--resume latest`, verify context carries over
