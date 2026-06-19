# apra-fleet KB+CI Bug Fixes - Code Review

**Reviewer:** ApraFleetRev
**Date:** 2026-06-19 19:45:00+05:30
**Verdict:** CHANGES NEEDED

---

## T1.1 -- Field/type rename + tool names

**PASS (src/):** All source code renames are correct.
- `GitNexusCall` renamed to `CodeIntelCall` in `src/services/knowledge/types.ts:9`
- `recommended_gitnexus_calls` renamed to `recommended_code_calls` in `PrimedContext` at `types.ts:81`
- `sqlite-provider.ts:534` emits `{ tool: 'code_context', args: { name: symbol } }` -- correct
- `sqlite-provider.ts:539` emits `{ tool: 'code_impact', args: { target: file, direction: 'upstream' } }` -- correct
- Zero remaining uses of `GitNexusCall` or `recommended_gitnexus_calls` in `src/` (grep confirmed)

**FAIL (tests/):** `tests/knowledge/kb-session-prime.test.ts` was NOT updated. It still references:
1. Field name `recommended_gitnexus_calls` instead of `recommended_code_calls` (lines 95, 101, 102, 109, 113, 118, 120)
2. Tool name `'context'` instead of `'code_context'` (line 109)
3. Arg shape `{ symbol: 'initRegistry' }` instead of `{ name: 'initRegistry' }` (line 111)
4. Tool name `'impact'` instead of `'code_impact'` (line 113)
5. Arg shape `{ file: 'src/registry.ts' }` instead of `{ target: 'src/registry.ts', direction: 'upstream' }` (line 115)

This causes **2 NEW test failures** (not pre-existing). The test accesses the nonexistent `recommended_gitnexus_calls` property which is now `undefined`, producing assertion errors.

**Doer:** fixed in commit f381bdf -- updated kb-session-prime.test.ts: renamed field to recommended_code_calls, tool names to code_context/code_impact, updated arg shapes to { name } and { target, direction: 'upstream' }. All 4 kb-session-prime tests now pass. Total tests: 2 failed (pre-existing time-utils), 1616 passed.

## T1.2 -- skills/pm/index.md

**PASS.** `git ls-files skills/pm/index.md` confirms tracked. Content documents the `/pm index` command with correct fleet tool names (`code_graph`, `code_impact`, `code_query`, `code_context`).

## T1.3 -- Installer overlay

**PASS.** Two overlay blocks present in `src/cli/install.ts`:
- SEA mode: lines 700-706 -- `fs.existsSync` + `fs.readdirSync` guard, then `copyDirSync`
- Dev/npm mode: lines 713-718 -- identical guard pattern

Both copy `skills/pm/` from repo root on top of the installed PM skills directory.

## T1.4 -- Build + install verification

**PARTIAL PASS.**
- `npm run build`: clean (exit 0)
- `npm test`: 1632 tests, **4 failures** -- 2 pre-existing in `time-utils.test.ts`, **2 NEW** in `kb-session-prime.test.ts` (see T1.1 above)
- Installed `~/.claude/skills/pm/tpl-doer.md`: contains `recommended_code_calls` -- correct
- Installed `~/.claude/skills/pm/tpl-reviewer.md`: contains `recommended_code_calls` -- correct
- Installed `~/.claude/skills/pm/index.md`: exists -- correct
- No `recommended_gitnexus_calls` found anywhere in installed `~/.claude/skills/pm/` -- correct

## File Hygiene

**PASS.** Sprint commits (`f4e3a03..42d61d0`) touch only:
- `progress.json` -- tracking
- `skills/pm/index.md` -- T1.2
- `skills/pm/tpl-doer.md`, `skills/pm/tpl-reviewer.md` -- T1.4
- `src/cli/install.ts` -- T1.3
- `src/services/knowledge/sqlite-provider.ts`, `src/services/knowledge/types.ts` -- T1.1

All files justified. CLAUDE.md is modified in working copy only (review instructions), not committed in sprint commits.

---

## Summary

T1.2, T1.3 are clean. T1.1 source rename in `src/` is correct, but the test file `tests/knowledge/kb-session-prime.test.ts` was not updated, causing 2 new test failures. The test must be updated to use `recommended_code_calls`, tool names `code_context`/`code_impact`, and the new arg shapes (`{ name: ... }` / `{ target: ..., direction: 'upstream' }`). Once the test is fixed, T1.4 verification will also pass.

**Required fix:** Update `tests/knowledge/kb-session-prime.test.ts` lines 95-122 to match the renamed field and new tool/arg shapes from `sqlite-provider.ts`.
