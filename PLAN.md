# Implementation Plan — API Cleanup & Skill Doc Sweep

Branch: `sprint/skill-refactor`  
Base: `main`  
Issues: #83, #84, #85, #87, #88  
Note: #89 is already fixed (commits e28f294, f02a4a0) — not included.

---

## Phase 1 — Crash fix & low-risk renames

### Task 1.1 — Fix compose_permissions crash on fresh permissions.json (#88)
**Tier:** cheap

**Files:**
- `src/tools/compose-permissions.ts`

**Changes:**
1. In `loadLedger()` (line 80-86): when the file exists, guard the parsed result:
   ```ts
   const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
   return { stacks: raw.stacks ?? [], granted: raw.granted ?? [] };
   ```
2. No template permissions.json file exists in the repo (glob confirmed). The `loadLedger` default when file is missing already returns `{ stacks: [], granted: [] }`. The fix ensures even a malformed on-disk `{}` is safe.

**Done:** `loadLedger` never returns undefined `granted` or `stacks`, regardless of file content. No template file is created — the guard-based approach in `loadLedger` is the chosen fix (see Risk R4).

### Task 1.2 — Add test: fresh template → compose_permissions → no crash (#88)
**Tier:** cheap

**Files:**
- `tests/compose-permissions.test.ts`

**Changes:**
1. Add a test case in a new `describe` block: "composePermissions — fresh/empty permissions.json"
2. Mock `fs.existsSync` to return true for `permissions.json`, `fs.readFileSync` to return `'{}'`
3. Call `composePermissions` with `project_folder` pointing to the mocked path
4. Assert: no throw, result contains success indicator

**Done:** Test passes; proves empty `{}` permissions.json doesn't crash.

### Task 1.3 — Rename provision_auth → provision_llm_auth (#84)
**Tier:** cheap

**Files:**
- `src/index.ts` (line 95): change `'provision_auth'` → `'provision_llm_auth'` in `server.tool()` registration

**Done:** MCP tool name is `provision_llm_auth`. No code-level rename needed — the export name `provisionAuth` is internal.

---

**VERIFY after Phase 1:** `npm test` — all existing tests pass, new test passes.

---

## Phase 2 — member_detail rename & version strip (#87)

### Task 2.1 — Rename claude → llm_cli in member_detail output
**Tier:** cheap

**Files:**
- `src/tools/member-detail.ts`

**Changes:**
1. Line 146: `result.claude = cli;` → `result.llm_cli = cli;`
2. Remove the comment `// kept for backwards compatibility`

**Done:** JSON output key is `llm_cli`, not `claude`.

### Task 2.2 — Strip provider prefix from version string
**Tier:** cheap

**Files:**
- `src/tools/member-detail.ts`

**Changes:**
1. After line 109 (`cli.version = versionResult.stdout.trim();`), add:
   ```ts
   // Strip provider prefix: "Claude Code 2.1.92" → "2.1.92"
   const vMatch = String(cli.version).match(/(\d+\.\d+\.\d+.*)$/);
   if (vMatch) cli.version = vMatch[1];
   ```

**Done:** `llm_cli.version` returns `"2.1.92"` not `"Claude Code 2.1.92"`.

### Task 2.3 — Update member_detail test if it exists
**Tier:** cheap

**Files:**
- `tests/agent-detail.test.ts` (check for `claude` key references, update to `llm_cli`)

**Done:** Test references updated.

---

**VERIFY after Phase 2:** `npm test` — all tests pass.

---

## Phase 3 — execute_command param rename & tilde fix (#85)

### Task 3.1 — Rename work_folder → run_from in execute_command schema
**Tier:** cheap

**Files:**
- `src/tools/execute-command.ts`

**Changes:**
1. Line 16: rename `work_folder` → `run_from` in the zod schema. Update description to: `"Override directory to run from. Defaults to member's registered work folder — rarely needed."`
2. Line 37: `const folder = input.run_from ?? agent.workFolder;`

**Done:** Schema param is `run_from`; defaults to `agent.workFolder`.

### Task 3.2 — Server-side tilde expansion for workFolder
**Tier:** cheap

**Files:**
- `src/tools/execute-command.ts`
- `src/tools/execute-prompt.ts`

**Changes:**
1. Add a helper (inline or shared) to resolve `~` at the start of a path:
   ```ts
   function resolveTilde(p: string): string {
     if (p.startsWith('~/') || p === '~') {
       return p.replace('~', os.homedir());
     }
     return p;
   }
   ```
2. In `execute-command.ts` line 37: `const folder = resolveTilde(input.run_from ?? agent.workFolder);`
3. In `execute-prompt.ts` line 99: apply `resolveTilde` to `agent.workFolder` when constructing `promptFilePath`
4. Also apply in the `promptOpts.folder` assignment (line 113)

**Done:** `~/git/project` resolves to `/Users/akhil/git/project` server-side.

### Task 3.3 — Update execute_command test for run_from rename
**Tier:** cheap

**Files:**
- `tests/execute-command.test.ts` — find and replace `work_folder` → `run_from` in test inputs

**Done:** Tests use new param name.

### Task 3.4 — Add tilde resolution tests
**Tier:** cheap

**Files:**
- `tests/execute-command.test.ts` (new `describe` block, or a new `tests/resolve-tilde.test.ts` if `resolveTilde` is exported)

**Changes:**
1. Add tests covering:
   - `resolveTilde('~/git/project')` returns `os.homedir() + '/git/project'`
   - `resolveTilde('~')` returns `os.homedir()`
   - `resolveTilde('/absolute/path')` passes through unchanged
   - `resolveTilde('relative/path')` passes through unchanged

**Done:** All four cases pass. Tilde resolution acceptance criterion met.

---

**VERIFY after Phase 3:** `npm test` — all tests pass.

---

## Phase 4 — Auto-accumulate tokens & remove update_task_tokens (#83)

### Task 4.1 — Add token accumulation fields to Agent type
**Tier:** standard

**Files:**
- `src/types.ts`

**Changes:**
1. Add to `Agent` interface:
   ```ts
   tokenUsage?: { input: number; output: number };
   ```

**Done:** Agent type supports token tracking.

### Task 4.2 — Auto-accumulate tokens in execute_prompt
**Tier:** standard

**Files:**
- `src/tools/execute-prompt.ts`

**Changes:**
1. Import `updateAgent` from `../services/registry.js`
2. After `touchAgent(agent.id, parsed.sessionId)` (line 158), add:
   ```ts
   if (parsed.usage) {
     const prev = agent.tokenUsage ?? { input: 0, output: 0 };
     updateAgent(agent.id, {
       tokenUsage: {
         input: prev.input + parsed.usage.input_tokens,
         output: prev.output + parsed.usage.output_tokens,
       },
     });
   }
   ```

**Done:** Every successful prompt response accumulates tokens on the agent record.

### Task 4.3 — Surface token totals in member_detail
**Tier:** cheap

**Files:**
- `src/tools/member-detail.ts`

**Changes:**
1. After the `llm_cli` section, add:
   ```ts
   if (agent.tokenUsage) {
     result.tokenUsage = agent.tokenUsage;
   }
   ```
2. In compact format, append token info if present.

**Done:** `member_detail` shows accumulated token usage.

### Task 4.4 — Surface token totals in fleet_status
**Tier:** cheap

**Files:**
- `src/tools/check-status.ts`

**Changes:**
1. Include `tokenUsage` in the per-agent row when present (JSON format).
2. In compact format, append tokens if nonzero.

**Done:** `fleet_status` shows per-member token totals.

### Task 4.5 — Remove update_task_tokens tool
**Tier:** cheap

**Files:**
- `src/index.ts` — delete the import (line 67) and `server.tool('update_task_tokens', ...)` registration (line 116)
- `src/tools/update-task-tokens.ts` — delete the file
- `tests/update-task-tokens.test.ts` — delete the file

**Done:** Tool is fully removed. No backward-compat shim.

---

**VERIFY after Phase 4:** `npm test` — all tests pass, no references to `update_task_tokens` in src/.

---

## Phase 5 — Skill doc sweep

### Task 5.1 — Update fleet SKILL.md
**Tier:** cheap

**Files:**
- `skills/fleet/SKILL.md`

**Changes:**
1. Line 26: `provision_auth` → `provision_llm_auth`
2. Line 31: remove the `update_task_tokens` row entirely
3. Line 74: `work_folder` reference is about send_files remote path context — keep as-is (it describes the member property, not a tool param)

### Task 5.2 — Update fleet onboarding.md
**Tier:** cheap

**Files:**
- `skills/fleet/onboarding.md`

**Changes:**
1. Scan for `provision_auth` → replace with `provision_llm_auth` (none found in current file, but verify)
2. Scan for `work_folder` as a tool param → none found, file references the member property

### Task 5.3 — Update PM skill docs
**Tier:** cheap

**Files:**
- `skills/pm/context-file.md` — `work_folder` references are about the member property (where to send files), not a tool param. Keep as-is.
- `skills/pm/single-pair-sprint.md` — same: `work_folder` refers to the member's folder. Keep.
- `skills/pm/tpl-status.md` — `{{work_folder}}` is a template variable for the member property. Keep.

**Changes:**
1. Grep all PM docs for `update_task_tokens` — remove any instructions to call it
2. Grep for `provision_auth` — replace with `provision_llm_auth`
3. Add permission denial handling to `skills/pm/single-pair-sprint.md` `### Permissions` section and `skills/pm/doer-reviewer.md` `## Permissions` section:
   > **Mid-sprint denial:** If a member is blocked by a permission denial, call `compose_permissions` with `grant: [<denied permission>]` and `project_folder` — this grants the missing permission, delivers the updated config, and appends to the ledger so future phases and sprints start with it already included. Then resume the member with `resume=true`. Never bypass by running the denied command yourself via `execute_command`.

### Task 5.4 — Final stale-reference grep
**Tier:** cheap

**Changes:**
1. Run: `grep -rn 'provision_auth\|update_task_tokens\|claude\.version\|claude\.auth' skills/ src/ tests/`
2. Confirm zero matches (except `provisionAuth` as a code-internal export name, which is fine)

**Note (from Phase 5 review):** The initial sweep omitted `tests/` — stale refs in test files can cause silent regressions (e.g. `result.includes('provision_auth')` never matching after the rename). Always include `tests/` in the grep scope.

**Done:** All skill docs updated. No stale tool names remain.

---

**VERIFY after Phase 5:** `grep` confirms no stale references. Full `npm test` passes.

---

## Risk Register

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| R1 | **Breaking change:** `provision_auth` → `provision_llm_auth` (Task 1.3) and `work_folder` → `run_from` (Task 3.1) are schema-level renames. Any external caller using the old names will break. | High — callers must update immediately | Intentional per requirements ("no backward-compat shims"). Skill doc sweep (Phase 5) updates all known callers. |
| R2 | **Token accumulation race:** Task 4.2 does a read-modify-write on `agent.tokenUsage` via `updateAgent`. If two concurrent `execute_prompt` calls finish simultaneously for the same agent, one update could be lost. | Low — fleet members typically run one prompt at a time | `updateAgent` writes to an in-memory `Map` in a single-threaded Node.js event loop — no concurrent mutation is possible within one process. No atomic handling needed. |
| R3 | **Tilde expansion edge cases:** `resolveTilde` (Task 3.2) only handles `~/` and bare `~`. Paths like `~user/foo` (another user's home directory) are **not** resolved. | Low — fleet members always register their own home paths | Document in code comment that only current-user `~` is supported. `~user/foo` syntax is not a fleet use case. |
| R4 | **#88 template discrepancy:** Requirements originally said "fix the template permissions.json to ship with `{\"granted\": []}`" but no template file exists in the repo. | None — resolved | The `loadLedger` guard (Task 1.1) is the correct fix: it defends against any malformed JSON on disk, not just a missing template. Requirements.md updated to reflect the guard-based approach. |

---

## Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| 1 | 1.1–1.3 | Crash fix (#88), provision_auth rename (#84) |
| 2 | 2.1–2.3 | member_detail rename (#87) |
| 3 | 3.1–3.4 | execute_command param rename + tilde fix + tilde tests (#85) |
| 4 | 4.1–4.5 | Auto-token accumulation, remove update_task_tokens (#83) |
| 5 | 5.1–5.4 | Skill doc sweep (all issues) |

All tasks are cheap except 4.1–4.2 (standard). Total: ~16 tasks across 5 phases with verification after each phase.
