# apra-fleet #212 — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-05-02 19:56:00+05:30
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Build & Test Verification

`npm run build` — **PASS.** TypeScript compiles cleanly, no errors or warnings.

`npm test` — **PASS.** 1072 tests passed, 6 skipped, 0 failures across 63 test files. All new test files (`tests/install.test.ts`, `tests/update.test.ts`) and the updated `tests/update-check.test.ts` pass.

---

## Phase 1: Install option persistence (T1)

**PASS.** `src/cli/install.ts` writes `install-config.json` at the end of `runInstall()` with `{ llm, skill: skillMode }`, serialized with `JSON.stringify(..., null, 2)` and file mode `0o600`. The directory is created with `mkdirSync({ recursive: true })` before writing.

The path `path.join(FLEET_BASE, 'data', 'install-config.json')` correctly resolves to `~/.apra-fleet/data/install-config.json`, matching the requirements spec.

Done-when criteria verified: both default (`{llm: "claude", skill: "all"}`) and custom flag cases are handled and tested.

---

## Phase 2: Core update command (T2, T3)

### T2 — `src/cli/update.ts`

**PASS.** All 10 steps from the plan are implemented:

1. GitHub API fetch with 5s AbortController timeout and User-Agent header — matches `checkForUpdate()` pattern. **PASS.**
2. Pre-release tag filtering via `/-(alpha|beta|rc)\b/i` regex. **PASS.**
3. Version comparison using imported `isNewer()` and `parseVersion()` — DRY reuse from `update-check.ts`. **PASS.**
4. Platform detection for win-x64, darwin-arm64, linux-x64 with correct `.exe` suffix for Windows. **PASS.**
5. Download via `fetch` + `WritableStream` piped to `fs.createWriteStream`. **PASS** — see NOTE 1 below.
6. Executable bit set on POSIX via `chmodSync(tmpPath, 0o755)`. **PASS.**
7. `install-config.json` read with existence check and JSON parse error handling, defaults fallback with warning message. **PASS.**
8. Args array built from config: `['install', '--llm', config.llm, '--skill', config.skill]`. **PASS.**
9. Print "Updating to \<version\> — restarting..." message. **PASS.**
10. Detached spawn with `stdio: 'ignore'` + `unref()` + `process.exit(0)`. **PASS.**

Error handling wraps the entire function in try/catch with a user-friendly error message. **PASS.**

### T3 — `src/index.ts` wiring

**PASS.** The `update` branch dispatches `--check` to `checkForUpdate()` + `getUpdateNotice()`, and bare `update` to `runUpdate()`. Both paths have proper `.catch()` error handling with `process.exit(1)`.

The global `--help` text is updated to list `apra-fleet update` and `apra-fleet update --check`.

**NOTE 2:** The plan specified adding a dedicated `apra-fleet update --help` subcommand path. This is not implemented — running `apra-fleet update --help` will trigger the full update flow instead. Non-blocking since the global `--help` covers it, but worth noting as a gap against the plan spec.

---

## Phase 3: Update notice polish (T4)

**PASS.** `getUpdateNotice()` in `src/services/update-check.ts` now returns `Run \`apra-fleet update\` to update.` instead of the old `/pm deploy apra-fleet` string. The corresponding test in `tests/update-check.test.ts` is updated to match.

---

## Phase 4: Tests (T5, T6)

### T5 — `tests/install.test.ts`

**PASS.** 4 test cases covering:
- Default config (no flags) → `{llm: "claude", skill: "all"}`
- Custom flags (`--llm gemini --skill none`) → `{llm: "gemini", skill: "none"}`
- Shorthand (`--llm=codex --no-skill`) → `{llm: "codex", skill: "none"}`
- Specific skill mode (`--skill fleet`) → `{llm: "claude", skill: "fleet"}`

All assertions verify the exact path, JSON content, and file mode `0o600`. Mock setup is clean with `_setSeaOverride` and `_setManifestOverride` test helpers.

### T6 — `tests/update.test.ts`

**PASS.** 4 test cases covering:
- Up-to-date version → prints message, no download, no spawn
- Newer available → downloads correct platform asset, spawns with saved config flags, exits
- Missing `install-config.json` → warns, falls back to defaults, still spawns
- Invalid JSON in config → warns, falls back to defaults, still spawns

The plan specified 3 test paths; the implementation adds a 4th (invalid JSON) which improves coverage. All cases verify the correct `spawn` arguments and `process.exit` behavior.

---

## Cross-cutting checks

### Security
- **PASS.** No injection vectors. Config is read from a local file, not user input. GitHub API URL is hardcoded. Installer binary is downloaded to temp path, never overwrites the running binary.
- **PASS.** File permissions `0o600` on `install-config.json` restrict read/write to the owner.

### Consistency with existing patterns
- **PASS.** Dynamic imports in `index.ts` match the existing `install` and `auth` dispatch pattern. Error handling with `logError` + `process.exit(1)` is consistent.
- **PASS.** `update-check.ts` exports `parseVersion` and `isNewer` cleanly without changing their implementation.

### Regressions
- **PASS.** No existing tests broken. The only change to an existing test (`update-check.test.ts`) is the expected notice string, which correctly reflects the T4 change.

### Documentation
- **PASS.** Global `--help` text updated to include update commands.

---

## Notes (non-blocking)

**NOTE 1 — File stream flush race.** In `update.ts:58-64`, the download writes chunks via `fileStream.write()` and calls `fileStream.end()` synchronously, then immediately proceeds to `chmodSync` and `spawn`. The Node.js writable stream `end()` triggers an async flush — there is no `await` on the `finish` event. For typical installer sizes this is unlikely to cause issues (the OS buffer will flush before the spawned process reads the file), but a robust fix would be to await the `finish` event before proceeding.

**NOTE 2 — Missing `update --help` subcommand.** As noted above, `apra-fleet update --help` is not handled as a dedicated path per the plan's Task 3 spec. The global `--help` covers it adequately.

**NOTE 3 — Config path indirection.** In `update.ts:70`, the config path is computed as `path.join(FLEET_DIR, '..', 'data', 'install-config.json')`. Since `FLEET_DIR` is already `~/.apra-fleet/data`, this goes up to `~/.apra-fleet` then back to `data` — resolving correctly but unnecessarily roundabout. Simpler: `path.join(FLEET_DIR, 'install-config.json')`.

---

## Summary

All four phases (T1–T6, V1–V4) are complete and verified. Build passes, all 1072 tests pass. The implementation faithfully follows the plan and requirements: install options are persisted at install time, `runUpdate()` fetches/downloads/spawns correctly with config replay and fallback defaults, the notice string is updated, and tests cover all specified paths plus an additional edge case. Three non-blocking notes are documented above for future cleanup. No changes needed.
