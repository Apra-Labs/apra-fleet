## Planning Session
- Member: fleet-dev2
- Date: 2026-05-01
- Gemini session: 5a72fea9 (start fresh session on fleet-dev2 to resume planning context)

---

# Gemini members launch apra-fleet.exe — Implementation Plan

> Fix two related bugs in `compose-permissions.ts` / `gemini.ts`: (1) `.gemini/settings.json` written on Windows has UTF-8 BOM, corrupting the file; (2) the fleet MCP server exclusion written by `compose_permissions` does not prevent Gemini members from launching `apra-fleet.exe`.

---

## Tasks

### Phase 1: Research — confirm Gemini MCP exclusion mechanism

#### Task 1: Verify Gemini settings.json MCP exclusion syntax on a live member
- **Change:** On a live Gemini member, run `gemini --help` and inspect `~/.gemini/settings.json` to determine: (a) the correct field name for excluding MCP servers (current code uses `mcp: { excluded: [...] }` — verify this is valid Gemini CLI syntax); (b) whether a per-project `.gemini/settings.json` exclusion overrides entries in the global `~/.gemini/settings.json`; (c) whether `apra-fleet` appears in the global settings and how it got there. Write findings to `docs/research-219-gemini-mcp.md` on the branch. If the exclusion field name is wrong, document the correct one.
- **Files:** `docs/research-219-gemini-mcp.md` (new)
- **Tier:** cheap
- **Done when:** Research doc committed with: correct exclusion field name, confirmed whether per-project overrides global, and current state of the global settings file on the test member
- **Blockers:** none

#### VERIFY: Phase 1
- `docs/research-219-gemini-mcp.md` committed with findings
- `npm run build` passes

---

### Phase 2: Fix UTF-8 BOM in `deliverConfigFile()`

#### Task 2: Replace `Set-Content -Encoding UTF8` with BOM-free write
- **Change:** In `src/tools/compose-permissions.ts`, update `deliverConfigFile()` Windows write command from `Set-Content -Path "..." -Value '...' -Encoding UTF8` to `[System.IO.File]::WriteAllText("...", '...', (New-Object System.Text.UTF8Encoding($false)))`. The `$false` argument disables BOM. Single-quote escaping in the content string remains the same (`'` → `''`). Test: after `compose_permissions` on a Windows member, run `git diff --check` on `.gemini/settings.json` — must show no whitespace/encoding warnings.
- **Files:** `src/tools/compose-permissions.ts`
- **Tier:** cheap
- **Done when:** `.gemini/settings.json` written on a Windows Gemini member passes `git diff --check` (no BOM); `npm run build` passes
- **Blockers:** none

#### VERIFY: Phase 2
- `npm run build` passes
- Manual: `compose_permissions` on a Windows Gemini member → `file .gemini/settings.json` reports UTF-8 without BOM; file is valid JSON

---

### Phase 3: Fix Gemini MCP exclusion

#### Task 3: Fix MCP exclusion in `composePermissionConfig()` based on research
- **Change:** In `src/providers/gemini.ts` `composePermissionConfig()`, update the settings.json output based on Task 1 findings: (a) **If exclusion field is wrong** — replace with the correct Gemini CLI syntax; (b) **If per-project doesn't override global** — also remove `apra-fleet` from the global `~/.gemini/settings.json` by adding a second config path in `permissionConfigPaths()` for the global file and writing a merged exclusion there; (c) **If `apra-fleet` is added to global settings by `apra-fleet install`** — fix the install path to not add fleet to Gemini's global MCP config. The fix must definitively prevent Gemini CLI from loading the fleet MCP server in member sessions.
- **Files:** `src/providers/gemini.ts`, possibly `src/cli/install.ts`
- **Tier:** standard
- **Done when:** After `compose_permissions`, a Gemini member dispatch does not spawn `apra-fleet.exe`; verified by checking process list on the member machine during a dispatch
- **Blockers:** Task 1

#### VERIFY: Phase 3
- `npm run build` passes
- Manual: `compose_permissions` + `execute_prompt` on a Gemini member → no `apra-fleet.exe` process spawned; `fleet_status` shows only the orchestrator's fleet instance

---

### Phase 4: Tests

#### Task 4: Unit tests for `deliverConfigFile()` BOM-free write
- **Change:** In `tests/compose-permissions.test.ts` (create if absent), mock `strategy.execCommand` and assert: (a) on `agentOs === 'windows'`, the write command contains `UTF8Encoding($false)` and does NOT contain `Set-Content -Encoding UTF8`; (b) on `agentOs === 'linux'`, the write command uses the heredoc form (unchanged); (c) content with single quotes is correctly double-escaped.
- **Files:** `tests/compose-permissions.test.ts`
- **Tier:** standard
- **Done when:** `npm test` passes with all 3 cases
- **Blockers:** Task 2

#### Task 5: Unit tests for Gemini `composePermissionConfig()` MCP exclusion
- **Change:** In `tests/providers/gemini.test.ts` (create if absent), call `new GeminiProvider().composePermissionConfig('doer', [])` and assert: (a) the returned settings JSON contains the correct MCP exclusion field (using whatever syntax Task 3 established); (b) `'apra-fleet'` appears in the exclusion list; (c) the fleet TOML does not reference `apra-fleet` in the allow list.
- **Files:** `tests/providers/gemini.test.ts`
- **Tier:** standard
- **Done when:** `npm test` passes with all 3 cases
- **Blockers:** Task 3

#### VERIFY: Phase 4
- `npm test` passes clean across all suites
- End-to-end: full `compose_permissions` + `execute_prompt` cycle on a Gemini member shows no fleet MCP launch and no BOM in settings files

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Gemini CLI ignores per-project `mcp.excluded` — global config always wins | high | Task 1 research confirms; fallback: also patch global settings in Task 3 |
| `[System.IO.File]::WriteAllText` escaping differs from `Set-Content` for embedded quotes | med | Task 4 unit test covers single-quote escaping; run against real Gemini settings JSON which contains double quotes |
| Fix breaks Gemini OAuth settings (`oauth-personal`) that were previously in settings.json | med | Current `composePermissionConfig()` TODO notes this — Task 3 must read-merge existing settings before writing, not overwrite |
| `apra-fleet install` re-adds fleet to Gemini global settings on next reinstall | low | If install adds it, fix the install path in same PR; document in install.ts |
| Research (Task 1) requires a live Gemini member — if none available, block | low | Use fleet-dev2 (local Windows Gemini member) for research |

## Notes
- Base branch: `main`
- Implementation branch: `feat/gemini-mcp-fix`
- Each task = one git commit
- VERIFY = checkpoint, stop and report
- Tasks 2 and 3 are independent and can be implemented in either order; Task 1 must complete before Task 3
- The TODO on line 129 of `compose-permissions.ts` (read existing settings before merge) is a prerequisite for Task 3 — implement the read-merge as part of Task 3 to avoid clobbering user settings
