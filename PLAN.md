# Install UX, Bug Fixes & Docs — Implementation Plan

## Sprint Branch
`feat/install-ux-and-docs` (from `main`)

## Issues Addressed
- #115 — Codex `config.toml` TOML quoting + silent provider fallback
- #108 — Use `claude -c` instead of `claude -r <session-id>` for resume
- #39 — Verify statusline icon clears after `remove_member`
- #96 — `apra-fleet install --force` flag + busy prompt
- #139 — Make `--skill all` the default; add named skill set options
- #140 — CONTRIBUTING.md: add "For AI agents" section
- #136 — User guide: install `--skill` explainer (depends on #139)
- #134 — `llms.txt` + CI-generated `llms-full.txt`
- #142 — `install --help` executes install instead of printing help

## Risk Register
| Risk | Mitigation |
|------|-----------|
| #115 TOML bug root cause unclear from the report alone (`model = \gpt-5.3-codex` does not obviously map to any existing write path) | Task 1.1 is a diagnostic audit — reproduce `config.toml` output on Windows install before changing code. Document the exact writer. |
| #39 may already be fixed — writing patch code wastes effort | Task 1.2 starts with a reproducing test (register → writeStatusline → remove → assert file empty). Only patch if test fails. |
| #108 session-ID capture could regress — `-c` still needs to surface the new session ID for debugging | Task 1.3 keeps `parseResponse` + `touchAgent(agent.id, parsed.sessionId)` unchanged. Only the outbound command swaps from `--resume "<id>"` to `-c`. |
| #96 `taskkill`/`pkill` patterns could match unrelated processes | Scope kill to exact binary name (`apra-fleet.exe` / exact full path match with `pkill -f`); verify with unit test that mocks `execSync`. |
| #139 changing default is a behavior change — existing CI / scripts passing `--skill` must keep working | Preserve backwards-compat: bare `--skill` → `all`; unknown `--skill=X` still errors. Add explicit test matrix for every combination. |
| `llms-full.txt` generation bloat — concatenating all docs could be huge / drift | Only include the 5 docs listed in `llms.txt`. Gate the CI step behind the `release` job (tag pushes only). Generate via a small Node script, committed so it's reviewable. |
| Two features touching `install.ts` (#96 + #139) risk merge conflict if done in parallel | Sequence them on the same branch — #139 first (arg parser refactor), then #96 on top (adds kill-check path). Single VERIFY gate after both. |

---

## Phase 1 — Bug Fixes (Issues #115, #108, #39)

### Task 1.1 — Diagnose & fix Codex `config.toml` quoting + silent provider fallback (#115)
- **Files:** `src/cli/install.ts`, `src/providers/index.ts`, `src/providers/codex.ts` (audit only), `tests/install-multi-provider.test.ts`, `tests/providers.test.ts`
- **What:**
  1. Audit every code path that writes to `~/.codex/config.toml`: `writeConfig` (uses `smol-toml.stringify`), `mergeCodexConfig`, `writeDefaultModel`, `mergeHooksConfig`, `configureStatusline`, `mergePermissions`, and `compose-permissions.deliverConfigFile`. Identify which writer produces the malformed `model = \X` / `provider = \X` output the reporter saw. Likely candidates: (a) `Set-Content -Value '<toml>'` on Windows in `deliverConfigFile` when the TOML string contains single quotes or newlines being re-serialized, (b) `smol-toml` bug triggered by a specific value. Reproduce on a Windows host using `npm run build && node dist/index.js install --llm codex` and inspect the actual file bytes.
  2. Fix the writer so TOML scalar strings are always emitted as `"value"` (double-quoted TOML string literals). Route `config.toml` writes through `smol-toml.stringify` consistently (fix `deliverConfigFile` to stringify structured data rather than pass raw strings through PowerShell `Set-Content` with single-quote escaping, which eats newlines and `"`). On Windows, use `Out-File -Encoding UTF8` with a here-string or base64-encoded PowerShell (same pattern as `execute-prompt.writePromptFile` line 55).
  3. Fix silent provider fallback in `src/providers/index.ts`: `getProvider(llmProvider)` currently returns `claude` for both `undefined` and any unknown value. Change behavior: keep `undefined`/`null` → `claude` (legacy agents), but throw a `TypeError` with a clear message for any non-empty `llmProvider` string that isn't in the providers map. Callers (execute-prompt, member-detail, list-members, etc.) will surface the error instead of silently using Claude.
  4. Add tests: (a) TOML output for a fresh Codex install contains `defaultModel = "gpt-5.4"` (proper quoting, no backslash), (b) `getProvider('bogus')` throws with a message naming the unknown provider, (c) `getProvider(undefined)` returns claude.
- **Done:**
  - Running `node dist/index.js install --llm codex` against a mocked home produces a `config.toml` whose lines all parse back cleanly with `smol-toml.parse`.
  - `getProvider('nonsense')` throws; `getProvider(undefined)` returns Claude adapter.
  - New tests pass; existing `install-multi-provider.test.ts` Codex cases still pass.
- **Blocks:** If the TOML bug cannot be reproduced with mocked `fs`, escalate — may need actual Windows install to observe the malformed bytes (reporter's environment is Windows).
- **Tier:** premium

### Task 1.2 — Fix statusline not clearing after `remove_member` (#39)
- **Files:** `src/services/statusline.ts`, `tests/activity.test.ts` (or new `tests/statusline.test.ts`)
- **What:**
  1. Write a test first: register agent → call `writeStatusline(new Map([[id, 'busy']]))` → assert `statusline.txt` has content → call `removeAgent(id)` → call `writeStatusline()` → assert `statusline.txt` is empty or deleted. Run the test; confirm it fails on `main`.
  2. Root cause: `writeStatusline()` at `src/services/statusline.ts:42` returns early when `agents.length === 0`, leaving the old file intact. Fix: when no agents remain, overwrite the statusline file with an empty line (preserves permissions, works with Claude Code's statusline reader) and clear the state file as well.
  3. If test already passes on `main`, close #39 with a pointer to the passing test as evidence — no code change needed.
- **Done:**
  - New test passes.
  - Manual smoke-test step documented in the PR: register a member, verify icon appears under Claude input, remove member, verify icon clears within one statusline refresh.
- **Blocks:** None.
- **Tier:** standard

### Task 1.3 — Switch `claude` resume from `-r <id>` to `-c` (#108)
- **Files:** `src/providers/claude.ts`, `src/providers/provider.ts` (if `buildResumeFlag` becomes Claude-only, keep it but stop calling it from Claude), `tests/providers.test.ts`
- **What:**
  1. In `ClaudeProvider.buildPromptCommand`, replace the `buildResumeFlag(sessionId)` logic (which emits `--resume "<id>"`) with an unconditional `-c` when `opts.sessionId` is present. `-c` with no prior session just starts fresh (verified in requirements), so behavior on first call is unchanged.
  2. `ClaudeProvider.resumeFlag()` still exists as an adapter method — return `'-c'` when sessionId is present, `''` otherwise, to match the new invocation.
  3. Keep `parseResponse` + `touchAgent(agent.id, parsed.sessionId)` in `execute-prompt.ts` unchanged — session IDs stay captured and stored for observability, they just stop being the resume mechanism.
  4. `buildResumeFlag` shared helper stays for Gemini (which still uses `--resume latest` / `--resume <id>`). Confirm no other callers are affected.
  5. Update tests: `tests/providers.test.ts` — assert Claude command with sessionId ends in ` -c` and does NOT contain `--resume`. Assert command without sessionId contains neither.
- **Done:**
  - New tests pass. Existing stale-session retry logic in `execute-prompt.ts:140-144` (which re-runs with `sessionId: undefined` after a failure) still works — with `-c` the retry becomes a no-op of the flag change, which is fine.
- **Blocks:** None.
- **Tier:** standard

### VERIFY 1 — Bug fixes landed
- [ ] `npm test` green on all three tests added in Tasks 1.1–1.3.
- [ ] `npm run build` succeeds.
- [ ] Manual smoke: run `node dist/index.js install --llm codex` against a test home dir; `config.toml` parses cleanly with `smol-toml.parse`.
- [ ] Manual smoke: register a local member, confirm statusline icon appears; `remove_member`, confirm icon clears.
- [ ] Grep confirms no remaining `--resume` emission in Claude provider code.

---

## Phase 2 — Install UX (Issues #139, #96)

Order matters: #139 refactors the `--skill` parser; #96 adds a pre-check before binary copy. Both live in `src/cli/install.ts`.

### Task 2.1 — `--skill` default = `all`, add `none` / `--no-skill` (#139)
- **Files:** `src/cli/install.ts`, `src/index.ts` (help text), `tests/install-multi-provider.test.ts`
- **What:**
  1. In `runInstall`, change the `--skill` parser so the default (no flag) = `all`. Support values: `all`, `fleet`, `pm`, `none`. Also accept `--no-skill` as synonym for `--skill none`. Bare `--skill` with no value keeps meaning `all` (backwards-compat per requirements).
  2. When `skillMode === 'pm'`, preserve existing "PM depends on fleet — installing fleet skill first" warning.
  3. Update `totalSteps` calculation and the console "Skipping skills" branch.
  4. Update `src/index.ts` `--help` output to match the table in requirements §#139.
  5. Tests (matrix, in `tests/install-multi-provider.test.ts`):
     - `install` (no flags) → fleet + pm skill dirs written
     - `install --skill all` → same
     - `install --skill pm` → same (warning emitted)
     - `install --skill fleet` → fleet dir written, pm dir NOT written
     - `install --skill none` → neither skill dir written
     - `install --no-skill` → neither skill dir written
     - `install --skill` (bare) → both written (backwards-compat)
     - `install --skill bogus` → non-zero exit, error message
- **Done:** Full matrix test passes; `--help` reflects new defaults.
- **Blocks:** None.
- **Tier:** standard

### Task 2.2 — `--force` flag + busy prompt (#96)
- **Files:** `src/cli/install.ts`, `tests/install-multi-provider.test.ts`
- **What:**
  1. At the top of `runInstall` (after `--llm` and `--skill` parsing, before the binary copy in Step 1), add a running-process detection:
     - Windows: `tasklist /FI "IMAGENAME eq apra-fleet.exe" /NH 2>nul` → check if output contains `apra-fleet.exe`.
     - macOS/Linux: `pgrep -f apra-fleet` → check exit code 0.
     - Skip the check in dev mode (`!isSea()`) — dev mode runs via `node dist/index.js`, not the packaged binary, so the check is meaningless and would false-negative.
  2. If a running process is detected:
     - Without `--force`: print the exact error block from requirements §#96 (error + `--force` hint + `taskkill` hint on Windows), `process.exit(1)`.
     - With `--force`: run `taskkill /F /IM apra-fleet.exe` (Windows) or `pkill -f apra-fleet` (macOS/Linux), wait briefly (e.g. 500ms), log "Stopped running server.", then proceed to binary copy. After the install completes, append "Restart Claude Code to reload the MCP server." to the final success message.
  3. Parse `--force` from args. Any other unknown `--foo` flag still errors (new behavior — preserves typo-safety).
  4. Tests (mock `execSync` to simulate both running and not-running states, verify correct error path / kill command / final message).
- **Done:**
  - Running installer on a busy server prints the force-prompt block and exits non-zero.
  - `--force` on a busy server issues the kill command and completes install.
  - Final success message includes the "Restart Claude Code" line when `--force` was used.
  - Tests pass on Windows + macOS/Linux code paths (matrix via mocked `process.platform`).
- **Blocks:** None (depends on 2.1's arg-parser shape — do 2.1 first).
- **Tier:** standard

### Task 2.3 — `--help` / `-h` guard in install command (#142)
- **Files:** whichever file contains the install command entry point (likely `src/cli/install.ts`)
- **What:**
  1. At the very top of the install command handler, before any file writes, config reads, or process detection, check if `--help` or `-h` is present in the args. If so, print usage text and exit 0.
- **Done:** `apra-fleet install --help` and `apra-fleet install -h` print help and exit with no side effects; existing tests pass; new test added.
- **Blocks:** None.
- **Tier:** cheap

### VERIFY 2 — Install UX landed
- [ ] Skill matrix test green.
- [ ] Force-flag tests green.
- [ ] Manual smoke on Windows: (a) `apra-fleet install` with no server running → normal install; (b) run server via `node dist/index.js` in a second terminal, then `apra-fleet install` → error prompt; (c) `apra-fleet install --force` → kills server, completes install.
- [ ] `apra-fleet install --help` and `-h` print help and exit 0 with no side effects.
- [ ] `apra-fleet install --help` output matches requirements table.

---

## Phase 3 — Documentation & CI (Issues #140, #136, #134)

### Task 3.1 — `llms.txt` + CI `llms-full.txt` generation (#134)
- **Files:** `llms.txt` (new, repo root), `scripts/gen-llms-full.mjs` (new), `.github/workflows/ci.yml` (modify `release` job), `.gitignore` (do NOT ignore `llms-full.txt` — it is committed)
- **What:**
  1. Verify the five docs referenced in requirements exist: `docs/user-guide.md`, `docs/vocabulary.md`, `docs/provider-matrix.md`, `docs/FAQ.md`, `docs/architecture.md`. (All present per `ls docs/`.)
  2. Write `llms.txt` at repo root following the format in requirements §#134, with the five doc links.
  3. Write `scripts/gen-llms-full.mjs`: Node script, no dependencies, reads each of the five docs, wraps each in `<doc title="..." desc="...">...</doc>`, wraps all in `<docs>...</docs>` inside `<project title="Apra Fleet" summary="...">`, writes to `llms-full.txt` at repo root.
  4. In `.github/workflows/ci.yml` `release` job (which already runs only on tag push), add a step after "Create release tarball" and before "Bump version.json":
     - `node scripts/gen-llms-full.mjs`
     - `git add llms-full.txt`
     - Include in the same commit as the version bump (`git commit -m "chore: bump version to X + regenerate llms-full.txt [skip ci]"`) OR a separate commit — pick the cleaner option. Recommended: same commit, to keep `release` job commits single-purpose.
  5. Test: run `node scripts/gen-llms-full.mjs` locally; verify output is well-formed XML and contains all five doc bodies. Commit the initial `llms-full.txt` so the first release after merge has one already (doesn't block on tag push).
- **Done:**
  - `llms.txt` committed to repo root.
  - `scripts/gen-llms-full.mjs` runs locally and produces `llms-full.txt`.
  - `llms-full.txt` committed to repo root.
  - CI `release` job regenerates + commits on tag push.
- **Blocks:** None.
- **Tier:** standard

### Task 3.2 — CONTRIBUTING.md "For AI agents" section (#140)
- **Files:** `CONTRIBUTING.md`
- **What:**
  1. Verify `package.json` scripts: `build` = `tsc`, `start` = `node dist/index.js`, `test` = `vitest run`. (Confirmed.) So dev-mode install = `npm run build && node dist/index.js install` — this is the command to document.
  2. Add "For AI agents" section near the end of CONTRIBUTING.md (before License) covering: dev-mode install command, file map (`src/`, `skills/`, `CLAUDE.md`, `hooks/`), how to test skill changes (edit `skills/fleet/` or `skills/pm/`, no rebuild needed, `/mcp` to reload), sprint branch naming (`sprint/<desc>` or `feat/<desc>`), note that PM & fleet skills are the orchestration layer.
- **Done:** Section added; dev-mode command verified by running it locally.
- **Blocks:** None.
- **Tier:** cheap

### Task 3.3 — User guide `--skill` explainer (#136, blocked on 2.1)
- **Files:** `docs/user-guide.md`, `README.md`, `docs/FAQ.md`, `skills/pm/deploy.md` (any installer examples inside)
- **What:**
  1. After Task 2.1 ships, update the Install section at the top of `docs/user-guide.md`:
     - Change one-liner install commands to drop `--skill` (new default is `all`).
     - Add a short "What install writes" block: files under `~/.apra-fleet/bin/`, `~/.apra-fleet/hooks/`, `~/.apra-fleet/scripts/`, plus `~/.claude/skills/fleet/` and `~/.claude/skills/pm/` (verified against `install.ts` constants and `paths.skillsDir`/`paths.fleetSkillsDir`).
     - Add "What install does NOT do": no system-level changes, no network calls beyond `claude mcp add`, no background services.
     - Add "How to uninstall" — list the directories to delete, and `claude mcp remove apra-fleet --scope user`.
  2. Remove/replace `--skill` from other examples: `README.md` install snippets, `docs/FAQ.md` (if mentioned), `skills/pm/deploy.md`.
  3. All file paths in the doc must be grep-verified against `src/cli/install.ts` constants before commit.
- **Done:**
  - Install section updated; all paths and commands cross-checked against code.
  - No remaining `--skill` in any example command (except explicitly documenting the flag's values).
- **Blocks:** Task 2.1 must be merged first (new defaults).
- **Tier:** standard

### VERIFY 3 — Docs & CI landed
- [ ] `llms.txt` and `llms-full.txt` committed; `node scripts/gen-llms-full.mjs` is idempotent.
- [ ] CONTRIBUTING.md "For AI agents" section present; dev-mode install command tested.
- [ ] User guide install section reflects new `--skill` default; no stray `--skill` in one-liner examples.
- [ ] `npm test` still green.

---

## Phase 4 — Final Acceptance

### VERIFY FINAL — All acceptance criteria
Walk the full checklist from `requirements.md` Acceptance Criteria — every box ticked:
- [ ] Codex `config.toml` uses proper TOML double-quoted strings
- [ ] Fleet server errors (not silent fallback) on unknown provider
- [ ] `claude -c` used for resume; session IDs still captured
- [ ] Statusline clears after `remove_member` (evidence: test)
- [ ] `apra-fleet install` (no flags) installs MCP + fleet + pm
- [ ] `--skill all|fleet|pm|none` all work
- [ ] `--no-skill` equivalent to `--skill none`
- [ ] Bare `--skill` = `all`
- [ ] Busy-server prompt shown without `--force`; kills with `--force`
- [ ] CONTRIBUTING.md has "For AI agents" section
- [ ] user-guide.md install explainer matches new defaults
- [ ] `llms.txt` + `llms-full.txt` at repo root; CI regenerates on release
- [ ] All tests pass; CI green
