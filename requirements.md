# Requirements — Bug Fixes & API Cleanup (#83, #84, #85, #87, #88, #89)

## Base Branch
`main` — branch to fork from and merge back to

## Goal
Fix a critical CWD bug in `execute_prompt` that causes agents to operate on the wrong repo, fix a crash in `compose_permissions`, and clean up provider-agnostic naming across 4 tools. Update all skill docs to reflect the changes.

## Scope

### Critical Bug
- **#89** — `execute_prompt`: always run from member `work_folder`; write `.fleet-task-*` files there (not Temp)
  - Run `execute_prompt` from the member's registered `work_folder` — no CWD resets, no exceptions
  - Write `.fleet-task-<id>.md` into `work_folder`
  - Gitignore `.fleet-task*` in `work_folder` on first use / during onboarding

### Bug
- **#88** — `compose_permissions`: crashes with `"ledger.granted is not iterable"` on fresh `permissions.json`
  - Guard: `const granted = ledger.granted ?? [];`
  - Fix the template `permissions.json` file to ship with `{"granted": []}` not `{}`
  - Add a test: initializing from the template and calling `compose_permissions` must not throw

### Refactors
- **#87** — `member_detail`: rename `claude.version` → `llm_cli.version`, `claude.auth` → `llm_cli.auth`; strip provider prefix from version string (e.g. `"2.1.92"` not `"Claude Code 2.1.92"`)

- **#85** — `execute_command` + `execute_prompt`: CWD defaulting and parameter rename
  - Rename param `work_folder` → `run_from` in `execute_command`
  - Both `execute_command` and `execute_prompt` must default to running from the member's registered `work_folder` — no override needed in 99% of cases
  - Fix `~` tilde expansion on macOS so `/Users/akhil/~/git/foo` never happens — resolve `~` to the actual home directory server-side before constructing the path
  - Update tool schema descriptions to make clear that `run_from` is rarely needed and defaults to the member's folder
  - Update fleet skill docs so they never instruct agents to pass the registered work folder path explicitly

- **#84** — rename `provision_auth` → `provision_llm_auth` in `src/index.ts` and all skill docs

- **#83** — replace `update_task_tokens` with automatic per-member token accumulation in the fleet server; surface totals via `member_detail` / `fleet_status`; remove manual PM burden

### Skill Doc Sweep
- Audit every skill doc (`skills/pm/`, `skills/fleet/`, and any others) for references to renamed tools and parameters
- Fix all references: `provision_auth` → `provision_llm_auth`, `work_folder` → `run_from` (where applicable), `claude.version` → `llm_cli.version`
- Remove any patterns that pass registered work folder path explicitly to `execute_command` or `execute_prompt`
- Remove any PM instructions to call `update_task_tokens`

## Out of Scope
- Dashboard or UI changes
- New tool features beyond the fixes and renames above

## Constraints
- Clean breaking changes throughout — no backward-compat shims
- macOS tilde resolution must be fixed server-side (fleet-rev is on macOS and will catch regressions in review)

## Acceptance Criteria
- [ ] `execute_prompt` always runs from `work_folder`; `.fleet-task-*` files land in `work_folder`
- [ ] `compose_permissions` does not throw when `permissions.json` is initialized from the template
- [ ] Test: fresh template `permissions.json` → `compose_permissions` → no crash
- [ ] `member_detail` returns `llm_cli.version` and `llm_cli.auth` for all providers; version strings have no prefix
- [ ] `execute_command` parameter is named `run_from`; both tools default to member `work_folder` without any override
- [ ] `~` in registered `work_folder` resolves correctly on macOS
- [ ] MCP tool formerly named `provision_auth` is now `provision_llm_auth`
- [ ] Token counts accumulated automatically by the server; `update_task_tokens` removed
- [ ] All skill docs updated — no stale tool names, no patterns passing registered folder explicitly
- [ ] All existing tests pass; new tests added for CWD fix, tilde resolution, and `compose_permissions` guard
