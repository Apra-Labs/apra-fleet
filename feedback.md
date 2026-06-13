# Phase 1 Implementation Review -- VERIFY 1

**Verdict: APPROVED**

**Reviewer:** nbkuh (reviewer)
**Date:** 2026-06-13
**Branch:** feat/opencode-pm-epic
**Commits reviewed:** 70279e3, 678d2d3, fbc8b72

---

## VERIFY 1 Checklist

### 1. Submodule -- PASS
- `git submodule status` -> `3667cc11f4c7d310b01dcaee0a40f954b63fa294 vendor/apra-pm (heads/main)` -- valid SHA, pinned
- `.gitmodules` URL correct: `https://github.com/Apra-Labs/apra-pm.git`
- `vendor/apra-pm/skills/pm/SKILL.md` exists (8824 bytes)
- `vendor/apra-pm/agents/planner.md` exists (7048 bytes)

### 2. Build vendoring -- PASS
- `npm run build` (tsc) succeeds with clean output
- `node scripts/vendor-pm.mjs` produces `dist/skills/pm/SKILL.md` and `dist/agents/planner.md`
- `npm pack --dry-run` (after vendoring) includes all 6 PM skill files and 4 agent files in dist/
- `prepublishOnly` correctly wired in package.json: `"node scripts/vendor-pm.mjs && npm run build"`
- gen-sea-config.mjs updated to collect from `vendor/apra-pm/` for both skills and agents

### 3. install.ts -- PASS
- `buildDevManifest` sources skills from `vendor/apra-pm/skills/pm/` (falls back to `dist/skills/pm/`)
- `buildDevManifest` sources agents from `vendor/apra-pm/agents/` (falls back to `dist/agents/`)
- PM skill install step (Step 7) sources from `vendor/apra-pm/skills/pm` with dist/ fallback
- Empty-submodule guard present (lines 656-668): checks for `SKILL.md` marker in vendor dir, errors with clear `git submodule update --init --recursive` guidance
- `agents` field added to `AssetManifest` interface (infrastructure for Phase 4)

### 4. Hygiene -- PASS
- `grep -rn 'pm-lite|apra-pm-lite'` across src/, scripts/, package.json, .gitmodules: 0 hits
- No old `skills/pm/` paths referenced in new code (install.ts now uses `vendor/apra-pm/` exclusively)
- Only implementation files touched: .gitmodules, package.json, scripts/gen-sea-config.mjs, scripts/vendor-pm.mjs (new), src/cli/install.ts
- No stray artifacts committed

### 5. Dev-mode install -- PASS
- `node dist/index.js install --llm claude` completes successfully (8 steps)
- Installed `~/.claude/skills/pm/SKILL.md` is byte-identical to `vendor/apra-pm/skills/pm/SKILL.md` (diff returns empty)
- All 6 vendor PM skill files installed: SKILL.md, beads.md, doer-reviewer-loop.md, sprint.md, tpl-progress.json, worktrees.md

### 6. Tests -- PASS
- `npm test`: 86 test files passed, 1 skipped (auth-terminal-wait, unrelated)
- 1379 tests passed, 7 skipped -- no regressions

---

## Findings

### A. npm pack tarball contains both old and new PM skills (LOW)
**Location:** package.json `files` field
**Detail:** The `files` array includes `"skills/"` (old PM files from repo root) AND `"dist/"` (where vendor-pm.mjs copies submodule files). After `prepublishOnly` runs, the tarball contains both sets. install.ts correctly uses only `vendor/apra-pm/` or `dist/skills/pm/`, never the root `skills/pm/`. This is benign dead weight that will resolve itself when Phase 2 (T2.1) deletes `skills/pm/`.
**Action:** None required in Phase 1. Phase 2 should also remove `"skills/"` from the `files` field.

### B. dist/ vendor files not produced by `npm run build` alone (INFORMATIONAL)
**Detail:** The VERIFY 1 criteria says to confirm `dist/skills/pm/SKILL.md` exists after `npm run build`. Build is just `tsc`; vendor files are populated by `vendor-pm.mjs` (wired to `prepublishOnly`). In dev mode, install.ts reads from `vendor/apra-pm/` directly, bypassing dist/. This is correct by design -- the criteria wording is slightly off, not the code.
**Action:** None.

### C. No agent install step yet (EXPECTED)
**Detail:** `agents` field added to AssetManifest; gen-sea-config.mjs collects agent files; vendor-pm.mjs copies agents to dist/. But no install step writes agents to `~/.claude/agents/`. This is explicitly Phase 4 (T4.2) work. The Phase 1 infrastructure prep is correct.
**Action:** None.

### D. .gitmodules omits `branch = main` (INFORMATIONAL)
**Detail:** Design doc shows `branch = main` in .gitmodules. Implementation omits it. This is fine -- `branch` is only used by `git submodule update --remote`; without it, the submodule stays pinned to the committed SHA, which is more stable.
**Action:** None.

---

## Code Quality Notes

- vendor-pm.mjs has a clean three-way guard: submodule present -> copy; dist/ already populated -> skip; neither -> error with guidance. Covers all three installation scenarios (dev, npm global, broken clone).
- install.ts empty-submodule guard correctly checks for the SKILL.md marker file rather than just directory existence, catching the non-recursive clone case.
- gen-sea-config.mjs correctly uses the `rootBase` parameter for relative path calculation, ensuring consistent manifest keys for both skills and agents.
- The fallback chain (vendor/apra-pm -> dist/) is consistently applied in both buildDevManifest and the PM skill install step.

---

## Summary

Phase 1 implementation is clean and correct. The submodule is properly pinned, build-time vendoring works, dev-mode install sources PM skills from the submodule, the empty-submodule guard provides clear recovery guidance, and all existing tests pass. No blocking issues found.
