# Phase 6–9 Implementation Review (MCP API & Usability Sprint, Issues #50–53)

**Reviewer:** Claude Opus 4.6  
**Branch:** `improve/token-usage`  
**Commits reviewed:** `5391ed4..d2a3bbc` (6 implementation commits since Phase 5 checkpoint `ed5794c`)  
**Date:** 2026-04-04

---

## Verdict: APPROVED

All 6 commits implement their stated goals cleanly. Build passes, 612 tests pass (4 skipped), 12/12 tasks completed.

---

## Per-Commit Review

### 1. `5391ed4` fix(#50): add 'server' to MCP title string
- **Change:** `apra-fleet ${ver}` → `apra fleet server ${ver}` in `src/index.ts:73`
- **Assessment:** Correct, minimal. SOUND ✓

### 2. `c5ad1df` fix(#51): accept member name in getAgentOrFail
- **Change:** `getAgentOrFail()` now falls back to `findAgentByName(id)` via `??` before returning error. Schema description updated to "UUID or friendly name". 3 tests added (UUID lookup, name lookup, not-found).
- **Assessment:** DRY fix — all tools calling `getAgentOrFail` now support name lookup without per-tool changes. UUIDs and friendly names occupy distinct namespaces, so no ambiguity. SOUND ✓

### 3. `ef4dc58` feat(#52): display git branch in member_detail and fleet_status
- **Changes:**
  - `lastBranch?: string` added to Agent type
  - `gitCurrentBranch()` added to OsCommands interface + linux/windows implementations (macOS inherits from Linux — correct)
  - `member_detail` fetches branch live via `git branch --show-current`, caches to `lastBranch` via `updateAgent`
  - `fleet_status` displays cached `lastBranch` (no live fetch — correct for fleet-wide summary)
  - 4 tests added across `agent-detail.test.ts` and `fleet-status-branch.test.ts`
- **Assessment:** Clean two-tier strategy (live in detail, cached in status). `2>/dev/null || true` prevents errors in non-git folders. Detached HEAD returns empty string, handled by `if (branchName)` guard. SOUND ✓

### 4. `e427f66` fix(#53): lead with tier names in execute_prompt model description
- **Change:** Schema description now leads with `"cheap", "standard", "premium"` tier names instead of provider-specific model IDs. Removes stale examples like `claude-sonnet-4-6`.
- **Assessment:** Correct for multi-provider UX — callers see tier names first, can still pass full model IDs. SOUND ✓

### 5. `4f233dd` fix(execute-prompt): resolve model tier names before passing to CLI
- **Change:** `tiers[input.model as keyof typeof tiers] ?? input.model` replaces direct pass-through.
- **Logic verification:**
  - `model: "cheap"` → `tiers.cheap` (e.g. `claude-haiku-4-5`) ✓
  - `model: "standard"` → `tiers.standard` (e.g. `claude-sonnet-4-6`) ✓
  - `model: "premium"` → `tiers.premium` (e.g. `claude-opus-4-6`) ✓
  - `model: "claude-opus-4-6"` → not in tiers → passes through as-is ✓
  - `model: undefined` → `tiers.standard` (default) ✓
- **Assessment:** Critical fix — without this, literal "cheap" would be sent to CLI as a model name. 3 dedicated tests verify all tier resolutions. SOUND ✓

### 6. `d2a3bbc` fix(schema): use provider-neutral language in tool descriptions
- **Changes:**
  - `execute_command`: "without spinning up Claude" → "without spinning up an LLM session"
  - `reset_session`: "fresh Claude session" → "fresh LLM session"
  - `execute_prompt` prompt field: "send to Claude" → "send to the LLM"
- **Remaining "Claude" in index.ts:** Two instances — `register_member` (lists all 4 providers by name) and `provision_auth` (documents Claude-specific OAuth flow). Both are accurate and provider-specific, not generic references.
- **Assessment:** Neutral language applied where generic; provider names preserved where specific. SOUND ✓

---

## Ancillary Changes (between ed5794c and implementation commits)

These were reviewed in the prior plan-review pass and remain sound:
- `update-task-tokens.ts`: Added missing `long_running`/`max_retries` fields
- Doc tier language fixes (vocabulary, user-guide, provider-matrix, security-review)
- `deploy.md`: New deploy runbook
- Template improvements (tpl-doer.md, tpl-reviewer.md)

---

## Build & Test

- `npm run build` — **PASS**
- `npm test` — **612 passed, 4 skipped** (39 test files)
- 10 new tests added across 4 files covering all new functionality

## Task Completion

All 12 tasks in `progress.json` show `"status": "completed"`. Done criteria from PLAN.md verified against actual code changes.

## No Issues Found

- No security concerns
- No regressions from baseline
- No provider-specific language leaking into generic tool descriptions
- Tier resolution logic is sound with correct fallback semantics
- All OS implementations consistent (Linux, Windows; macOS inherits correctly)

---

## Prior Reviews (Archived)

### Plan Review (pre-implementation)
**Verdict:** APPROVED — Plan was well-structured with pre-verified assumptions, clear done criteria, and correct task ordering. One gap noted (missing risk register) was mitigated by identified risks all being low-impact with existing guards.
