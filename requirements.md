# Requirements — API Cleanup & Skill Doc Sweep (#83, #84, #85, #87, #88)

## Base Branch
`main` — branch to fork from and merge back to

## Goal
Fix a crash in `compose_permissions`, and clean up provider-agnostic naming across 4 tools. Update all skill docs to reflect the changes. Note: #89 (execute_prompt CWD bug) is ALREADY FIXED in commits e28f294 and f02a4a0 — do NOT plan it again.

## Issues to plan

**#88 — compose_permissions crashes with "ledger.granted is not iterable" on fresh permissions.json**
- Fix: `const granted = ledger.granted ?? [];` in `src/tools/compose-permissions.ts`
- Also fix the template `permissions.json` file (wherever it lives in the repo) to ship with `{"granted": []}` not `{}`
- Add a test: fresh template permissions.json → compose_permissions → must not throw

**#87 — member_detail: rename claude.version → llm_cli.version, claude.auth → llm_cli.auth**
- Strip provider prefix from version string (e.g. `"2.1.92"` not `"Claude Code 2.1.92"`)
- Files: `src/tools/member-detail.ts` and any consumers

**#85 — execute_command + execute_prompt: CWD defaulting and parameter rename**
- Rename param `work_folder` → `run_from` in `execute_command` tool schema
- Both `execute_command` and `execute_prompt` must default to running from the member's registered `work_folder` — `run_from` override rarely needed
- Fix `~` tilde expansion on macOS: server-side, resolve `~` to actual home dir before constructing paths
- Update tool schema descriptions
- Update fleet skill docs to never instruct passing the registered folder explicitly

**#84 — rename provision_auth → provision_llm_auth**
- Rename in `src/index.ts` (MCP tool registration)
- Update all skill docs (`skills/pm/`, `skills/fleet/`)

**#83 — replace update_task_tokens with automatic per-member token accumulation**
- Fleet server auto-accumulates token counts from every execute_prompt response
- Surface totals via `member_detail` / `fleet_status`
- Remove `update_task_tokens` tool entirely
- Remove PM instructions to call it from skill docs

## Skill Doc Sweep (covers all above)
- Audit `skills/pm/` and `skills/fleet/` for: `provision_auth`, `work_folder` (as param), `claude.version`, `update_task_tokens`
- Fix all references after renames/removals
- Remove patterns that pass registered work folder explicitly to execute_command/execute_prompt

## Constraints
- Clean breaking changes — no backward-compat shims
- macOS tilde resolution must be fixed server-side

## Acceptance Criteria
- [ ] compose_permissions does not throw on fresh `{"granted": []}` template
- [ ] Test: fresh template → compose_permissions → no crash
- [ ] member_detail returns `llm_cli.version` and `llm_cli.auth`; version strings have no prefix
- [ ] execute_command param renamed to `run_from`; both tools default to workFolder
- [ ] `~` in workFolder resolves correctly on macOS
- [ ] provision_auth renamed to provision_llm_auth in src/index.ts and all skill docs
- [ ] Token counts auto-accumulated; update_task_tokens removed
- [ ] All skill docs updated; no stale references
