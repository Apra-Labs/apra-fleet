# i193-data-dir — Code Review

**Reviewer:** fleet-reviewer
**Date:** 2026-05-03T15:40:00+05:30
**Verdict:** CHANGES NEEDED

> First review of this feature branch. No prior feedback.md history.

---

## Install Flags (Phase 1)

**--data-dir parsing** — PASS. Both `--data-dir=<path>` and `--data-dir <path>` forms are handled (`install.ts:416-426`). Tilde expansion uses `dataDir.replace(/^~(?=$|\/)/, home)` which works on Unix. NOTE: the regex `(?=$|\/)` won't match `~\` on Windows (backslash separator), so `--data-dir ~\custom` would not expand. Low severity since `--data-dir` accepts absolute paths and `path.join` handles the `--instance` case, but worth noting.

**--instance parsing** — PASS. Input validated with `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/` (`install.ts:411`). Correctly derives `serverName = apra-fleet-<name>` and default `dataDir = ~/.apra-fleet/workspaces/<name>`. The `--instance` flag value being alphanumeric-only prevents injection into shell commands and path traversal.

**env var injection into MCP configs** — PASS for Gemini, Codex, and Copilot (JSON-based, no shell risk). These correctly spread `envVars` into the config object only when non-empty.

**FAIL — Command injection in Claude MCP registration** (`install.ts:585`):
```typescript
const envFlags = Object.entries(envVars).map(([k, v]) => `-e ${k}="${v}"`).join(' ');
```
When `--data-dir` is user-supplied (no `--instance`), `v` is arbitrary string input interpolated into a shell command executed via `execSync`. A path like `--data-dir '/foo"; rm -rf / #'` would inject shell commands. The `--instance` path is safe because the name is validated, but `--data-dir` alone has no such restriction.

**Fix:** Escape the value for shell interpolation, or use `execFileSync` with an argument array instead of string interpolation. At minimum, reject or escape shell metacharacters in `dataDir` before building the command string.

**Default install behaviour** — PASS. When neither `--data-dir` nor `--instance` is provided, `serverName` defaults to `'apra-fleet'` and `envVars` is `{}`, so no env flags are added. The command template matches the pre-feature code exactly. Known flags list updated to include new flags.

**Permissions** — PASS. `mergePermissions` correctly uses the dynamic `serverName` so `mcp__apra-fleet-<name>__*` is set for instances.

**workspaces.json registration** — PASS. Written only when `--instance` is used (not for bare `--data-dir`). Creates both the index and data directory with `recursive: true`.

---

## Workspace Subcommand (Phase 2)

**Dispatch** — PASS. `src/index.ts:42-44` adds a `workspace` branch that dynamically imports and calls `runWorkspace`. Help text updated with all five subcommands.

**`workspace.ts` structure** — PASS. Clean implementation with `list`, `add`, `remove`, `use`, `status` subcommands. Input validation for workspace names matches install's regex. Reserved name `default` is rejected for `add` and `remove`.

**NOTE — Duplicated path constants.** `workspace.ts` redeclares `APRA_BASE`, `WORKSPACES_DIR`, `WORKSPACES_INDEX` locally (lines 5-7) even though `paths.ts` exports the same constants (added in Task 1.3). Should import from `../paths.js` to keep a single source of truth. Not a blocker but creates divergence risk.

**`workspace add --install`** — PASS. Correctly chains to `runInstall(['--instance', name])` via dynamic import.

**`workspace remove`** — PASS. Preserves data directory on disk (only removes from index). Refuses removal when members are registered unless `--force`.

**`workspace use`** — PASS. Prints `export APRA_FLEET_DATA_DIR=...` for eval. Includes eval hint.

**`workspace status`** — PASS. Shows path existence, member count, statusline age, salt presence, and active state. Falls back gracefully when data dir doesn't exist.

**`workspace list`** — PASS. Tabular output with dynamic column widths. Always includes `default` workspace. Active indicator uses emoji which is fine for CLI output.

---

## Tests (Phase 3)

**Coverage** — PASS. 17 test cases in `tests/install-data-dir.test.ts` covering:
- `--data-dir` with space and equals forms
- `--instance` with space and equals forms
- Server name derivation (`apra-fleet-<name>`)
- Data dir derivation for `--instance`
- `claude mcp remove` uses correct server name
- Invalid instance name rejection
- `workspaces.json` written for `--instance`, not for bare `--data-dir`
- Gemini provider: env embedding and server key name
- Permissions: correct `mcp__` prefix for both instance and default
- Tilde expansion

**NOTE — Missing test coverage for:**
1. No test for `--data-dir` with `--instance` together (plan says `--instance` only sets `dataDir` if `--data-dir` is NOT also provided — this precedence is untested).
2. No test for Codex or Copilot providers with `--data-dir` / `--instance` (only Claude and Gemini tested). Not critical since the merge functions are structurally identical.
3. No unit tests for `workspace.ts` subcommands (list/add/remove/use/status). The workspace logic is entirely untested. This is a gap — at minimum `add` and `remove` should have tests.

**Test quality** — PASS. Mocking strategy (fs + child_process) is sound. Tests verify actual command strings and written file contents. The workspaces.json test re-sets up mocks which is slightly redundant but doesn't harm correctness.

---

## Documentation (Task 3.2)

**README.md** — PASS. New `<details>` section documents both `--instance` and `--data-dir` with examples. Commands match the implemented CLI. Salt isolation is explicitly noted: "Credentials stored in one instance are not readable by another — each instance has its own encryption salt."

**SKILL.md** — PASS. One-line addition noting `--instance` flag and its behavior. Accurate.

**Help text** — PASS. Both `apra-fleet --help` (index.ts) and `apra-fleet install --help` (install.ts) updated with the new flags and workspace subcommands. Column alignment is consistent.

---

## Security

**FAIL — Shell injection via `--data-dir`** (see Install Flags section above). The `--data-dir` value is interpolated unsanitized into a shell command string for the Claude provider path. While this is a local CLI tool (attacker == user), it's still bad practice and could bite if paths contain quotes, spaces with special chars, or dollar signs. The `--instance` path is safe due to regex validation.

**Path traversal** — PASS for `--instance` (alphanumeric only, joined under `workspaces/`). NOTE for `--data-dir`: by design it accepts arbitrary absolute paths, so path traversal is a feature, not a bug. The user explicitly chooses where data goes.

**Salt isolation** — PASS. Each data directory gets its own salt (documented). No cross-instance credential leakage path.

---

## Summary

**Must fix before merge (CHANGES NEEDED):**
1. **Shell injection in `--data-dir` → `claude mcp add`** (`install.ts:585`). The `dataDir` value must be properly escaped or the command must be built using `execFileSync` with an argv array. This is the only blocking issue.

**Should fix (non-blocking):**
2. `workspace.ts` should import `APRA_BASE`, `WORKSPACES_DIR`, `WORKSPACES_INDEX` from `../paths.js` instead of redeclaring them.
3. Add at least basic tests for `workspace add` and `workspace remove`.
4. Add a test for `--data-dir` + `--instance` precedence (data-dir wins).

**Passed:**
- Default install path unchanged — no regression
- All 883 tests pass (52 files)
- Docs accurate, salt isolation documented
- Instance name validation is solid
- Provider configs (Gemini, Codex, Copilot) handle env vars correctly via JSON (no shell risk)
