# apra-fleet — Implementation Plan

> Fix 6 bugs and API inconsistencies: CWD bug in execute_prompt (#89), ledger guard in compose_permissions (#88), provider-agnostic fields in member_detail (#87), and skill doc sweep for execute_command (#85), provision_auth (#84), and update_task_tokens (#83).

---

## Tasks

### Phase 1: Foundations — CWD Fix & Permissions Guard

#### Task 1: Fix execute_prompt CWD to use agent.workFolder (#89)
- **Tier:** standard
- **Change:** Decouple the prompt file path from the agent launch folder. Currently `promptOpts.folder` is set to `tmpDir` (line 112), which means the agent launches with CWD in `/tmp`. Change `promptOpts.folder` to `agent.workFolder` while keeping the prompt file written to `tmpDir`. Update `buildAgentPromptCommand` call to pass the prompt file as an absolute path (combining `tmpDir` + `promptFileName`) so the agent can still read it from tmpDir but runs in the work folder. Update `deletePromptFile` to use the correct tmpDir-based path.
- **Files:** `src/tools/execute-prompt.ts`
- **Done when:** `promptOpts.folder` is `agent.workFolder`, prompt file is still in tmpDir, `deletePromptFile` still cleans up correctly, existing tests pass with updated expectations
- **Blockers:** Need to verify that `buildAgentPromptCommand` in OS commands supports absolute prompt file paths — check `src/services/os-commands.ts`

#### Task 2: Add ledger guard warning in compose_permissions (#88)
- **Tier:** cheap
- **Change:** When `compose_permissions` is called in reactive grant mode (`input.grant?.length`) without `project_folder`, append a warning to the response: `"⚠️ No project_folder — grants will not persist to ledger."` This makes the data-loss-on-omission visible to callers. No change to the proactive compose path (it already works correctly without project_folder).
- **Files:** `src/tools/compose-permissions.ts`
- **Done when:** Warning appears in response when granting without `project_folder`, no warning on proactive compose, test coverage for the warning path
- **Blockers:** None

#### Task 3: Add tests for Task 1 and Task 2
- **Tier:** cheap
- **Change:** Add/update tests: (a) `tests/execute-prompt.test.ts` — verify the folder passed to `buildAgentPromptCommand` is the agent's work folder, not tmpDir. (b) `tests/compose-permissions.test.ts` — verify warning message when granting without `project_folder`.
- **Files:** `tests/execute-prompt.test.ts`, `tests/compose-permissions.test.ts`
- **Done when:** New tests pass, existing tests still pass
- **Blockers:** None

#### VERIFY: Phase 1
- Run full test suite
- Confirm CWD fix works — agent folder is workFolder, prompt file is in tmpDir
- Confirm ledger warning appears correctly
- Report: tests passing, any regressions, any issues found

---

### Phase 2: API Cleanup — Field Rename & Token Docs

#### Task 4: Rename member_detail `claude` field to `cli` (#87)
- **Tier:** standard
- **Change:** In `member_detail`, rename the response field from `result.claude` to `result.cli` (containing `{ version, auth }`). This makes the field provider-agnostic. Search all callers of `member_detail` that read `claude.version` or `claude.auth` and update them. Update the tool's response description if it mentions `claude`.
- **Files:** `src/tools/member-detail.ts`, any files that consume the `claude` field from member_detail responses
- **Done when:** Field is `cli` everywhere, no references to `result.claude` remain, tests updated
- **Blockers:** If PM skill or fleet skill docs parse this field by name, they need updating (handled in Phase 3)

#### Task 5: Clarify update_task_tokens git-failure behavior (#83)
- **Tier:** cheap
- **Change:** (a) Update the tool description in `src/tools/update-task-tokens.ts` schema to mention that git commit is best-effort — tokens are persisted to file regardless. (b) Improve the warning message on git commit failure (line ~114) to include guidance: suggest manual commit. (c) Add a test that verifies tokens are written to file even when git commit fails.
- **Files:** `src/tools/update-task-tokens.ts`, `tests/update-task-tokens.test.ts`
- **Done when:** Tool description mentions best-effort commit, warning message is actionable, test for git-failure path exists and passes
- **Blockers:** None

#### VERIFY: Phase 2
- Run full test suite
- Confirm `cli` field works in member_detail
- Confirm update_task_tokens warning is clear
- Report: tests passing, any regressions, any issues found

---

### Phase 3: Skill Doc Sweep

#### Task 6: Update skill docs — work_folder, provision_auth, cli field, token behavior (#84, #85, #87 docs)
- **Tier:** cheap
- **Change:** Batch update to skill documentation:
  1. `skills/fleet/SKILL.md` — add `work_folder` parameter to `execute_command` documentation (currently undocumented)
  2. `skills/fleet/SKILL.md` — verify `provision_auth` name is consistent (no hyphenated `provision-auth` references)
  3. `skills/fleet/SKILL.md` — update `update_task_tokens` section to note best-effort git commit behavior
  4. `skills/fleet/SKILL.md` and `skills/pm/SKILL.md` — update any references from `claude.version`/`claude.auth` to `cli.version`/`cli.auth` (per Task 4 rename)
  5. Audit `skills/pm/tpl-*.md` templates for stale references
- **Files:** `skills/fleet/SKILL.md`, `skills/pm/SKILL.md`, `skills/pm/tpl-status.md` (if applicable)
- **Done when:** All skill docs use correct tool names, document work_folder, reference `cli` not `claude`, and note token git behavior
- **Blockers:** Task 4 must be complete (field rename)

#### VERIFY: Phase 3
- Run full test suite (ensure no doc-only regressions)
- Grep for stale references: `provision-auth` (hyphenated), `claude.version`, `claude.auth` in skills/
- Report: all references clean, tests passing

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| #89 CWD fix breaks `buildAgentPromptCommand` contract | High | Read `os-commands.ts` to verify absolute path support before coding; test on both local and remote agents |
| #87 `claude` → `cli` rename breaks PM skill parsing | Med | Grep all consumers before renaming; update skill docs in same sprint |
| #88 ledger warning confuses callers that don't use project_folder | Low | Warning is informational only — no behavior change, just visibility |
| Skill doc updates miss a reference | Low | Automated grep check in VERIFY phase |

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Base branch: `main`
- #89 is front-loaded as the riskiest change
- Skill doc sweep (#84, #85, partial #87) batched as a single cheap task in Phase 3
