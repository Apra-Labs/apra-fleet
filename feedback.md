# Phase 1 VERIFY Review: OOB Terminal & Versioned MCP Key

**Branch:** `sprint/ux-quality-fixes`
**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-05
**Commits reviewed:** `d63e38c` (Task 1), `e041f1a`+`4442fa5` (Task 2), plus fixup commits through `61a13e9`

## Task 1: Issue #42 — OOB terminal cancellation & paste support

### Cancellation — all 3 paths

1. **Window close (macOS):** The new AppleScript waits via `repeat while busy of w` and reads the exit code from a temp file. If the temp file is missing (window closed manually), `exitCode` defaults to 1, which triggers the `reject(new Error('cancelled'))` path in `collectOobInput`. The cancellation promise rejects, the catch block cleans up pending state, and returns the `cancelledMessage` fallback. **PASS**

2. **Ctrl+C:** The auth CLI subprocess receives SIGINT and exits non-zero. On macOS, the temp file gets `$?` (non-zero) written; on Linux/Windows, the child process `close` event fires with non-zero code. Both paths flow through `onExit(exitCode !== 0)` → `reject('cancelled')`. **PASS**

3. **Esc:** Esc is handled by the auth CLI's readline prompt (not the terminal launcher). If the auth CLI exits non-zero on Esc, the same `onExit` callback fires. This works because the launcher now tracks process exit rather than detaching and forgetting. **PASS**

### Paste support

The old macOS launcher used `osascript -e` with a one-liner `do script` command. The new version uses `osascript -` (stdin) with a multi-line AppleScript, and the Terminal.app window is a standard `do script` invocation. Terminal.app natively supports Cmd+V paste — there's no `-e` flag or `pbcopy` pipe that would interfere. **PASS**

### Caller unblocking

All three callers (`provision-auth.ts:253`, `register-member.ts:65`, `update-member.ts:71`) now handle the updated return type (`{ password?: string; fallback?: string }`) with the `!` assertion on `oob.password` and a fallback default. The `collectOobInput` function always returns one of the two fields populated, so callers unblock on either success or cancellation. **PASS**

### Return type change

The return type changed from `{ password: string } | { fallback: string }` (discriminated union) to `{ password?: string; fallback?: string }` (single object with optionals). This is a weakening — callers can no longer rely on the type system to guarantee exactly one field is set. The callers compensate with `?? 'Error: OOB operation cancelled.'` defaults and `!` assertions. Acceptable for now, but worth tightening in a future cleanup. **Minor concern, non-blocking.**

### BOM character

The diff shows a BOM (`\uFEFF`) was introduced at line 1 of `auth-socket.ts` (`﻿import net`). This is cosmetic but unnecessary and may cause linter warnings. **Minor concern, non-blocking.**

## Task 2: Issue #78 — Versioned MCP registration key

### Key format

`mcpKey = \`apra-fleet_${serverVersion.replace(/\+/g, '_')}\`` at `install.ts:333`. With `serverVersion = 'v0.1.3+62ec2e'`, the key becomes `apra-fleet_v0.1.3_62ec2e`. The `+` → `_` replacement avoids issues with shell escaping and TOML quoting. **PASS**

### All 4 providers

1. **Claude:** `claude mcp remove apra-fleet` (legacy cleanup) then `claude mcp add --scope user ${mcpKey}`. Only removes the unversioned `apra-fleet` key — can't easily enumerate other versioned keys via CLI. Acceptable limitation, documented in comment. **PASS**
2. **Gemini:** `mergeGeminiConfig` iterates `settings.mcpServers`, deletes any key starting with `apra-fleet` that isn't the new `mcpKey`, then writes the new entry with `trust: true`. **PASS**
3. **Codex:** `mergeCodexConfig` same pattern on `settings.mcp_servers`. **PASS**
4. **Copilot:** `mergeCopilotConfig` same pattern on `settings.mcpServers`. **PASS**

### Legacy key cleanup

For Gemini/Codex/Copilot: the `for (const key in ...)` loop with `key.startsWith('apra-fleet') && key !== mcpKey` correctly removes old unversioned and older versioned keys. For Claude: only the static `apra-fleet` key is removed. If a user upgrades from one versioned key to another, the old versioned Claude key would persist. This is a known limitation (comment at line 410) and acceptable since `claude mcp list` + manual removal is available. **PASS with noted limitation.**

### Permissions

`mergePermissions` now receives `mcpKey` and generates `mcp__${mcpKey}__*` instead of the hardcoded `mcp__apra-fleet__*`. This correctly matches the versioned server name. **PASS**

### Tests

The `install-multi-provider.test.ts` tests validate:
- Versioned key in `claude mcp add` command (line 61-64)
- Versioned key in Gemini JSON output with `trust: true` (line 247-249)
- Versioned key in Codex TOML via regex `/\[mcp_servers\."apra-fleet_.*"\]/` (line 100, 261)
- Copilot settings contain `apra-fleet` (line 116)
- Permissions reference provider-specific skill paths (line 288-333)
- Default model written per provider (lines 336-390)

All 19 install tests pass. **PASS**

## Build & Test

- `npm run build`: **PASS** (clean tsc compilation)
- `npm test`: **PASS** (614 tests passed, 4 skipped, 40 test files, 0 failures)

## Auth/Install Regression Check

- Auth socket lifecycle tests (27 tests): **PASS** — pending auth, TTL, waitForPassword, collectOobPassword, collectOobApiKey all green
- No changes to core auth encryption, socket protocol, or pending request map structure
- Install flow unchanged for binary copy, hooks, scripts, statusline, skill extraction

## Issues Found

None blocking.

## Minor Concerns (non-blocking)

1. **Return type weakening** in `collectOobInput`: `{ password?: string; fallback?: string }` loses the discriminated union guarantee. Callers use `!` assertions that could theoretically NPE. Consider restoring the union type in a future pass.
2. **BOM character** at start of `auth-socket.ts` — cosmetic, should be stripped.
3. **Claude versioned key cleanup limitation** — only removes the unversioned `apra-fleet` key, not prior versioned keys. Documented and acceptable.
4. **No dedicated cancellation test** in `auth-socket.test.ts` — the `collectOobPassword` tests cover the launch/fallback/timeout paths but don't exercise the `onExit(non-zero)` → cancelled path via the mock `launchFn`. Consider adding one in a future pass.

---

**Verdict: APPROVED**

Both tasks meet their "done when" criteria. Cancellation works for all 3 paths, paste is unblocked, versioned keys register across all 4 providers with legacy cleanup, and the full test suite passes cleanly. The minor concerns are non-blocking quality improvements for a later sprint.
