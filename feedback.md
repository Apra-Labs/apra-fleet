# PR Review Fix Verification — 2026-04-24

**Branch:** `sprint/session-lifecycle-oob-fix`
**Task:** Verify 6 commits listed in `.fleet-task.md`
**Reviewer:** Claude (automated review)

---

## Verdict: CHANGES NEEDED

**The 6 commits referenced in the task do not exist.** Commits `e6d7982`, `be83193`, `9a2ac33`, `9eba874`, `3940788`, and `64b6f66` are not present in the branch history, reflog, or any other branch. The fixes described were never applied.

---

## Fix-by-Fix Assessment

### Fix 1 — `stop_agent` → `stop_prompt` rename (commit 64b6f66): FAIL — NOT APPLIED

`stop_agent` still appears in:
- `src/index.ts:194` — MCP tool name is `'stop_agent'`
- `src/tools/stop-agent.ts` — file, schema, type, and function all use `stopAgent`/`StopAgent`
- `src/utils/agent-helpers.ts:90,98` — comments reference `stop_agent`
- `docs/api/stop-agent.md` — entire file references `stop_agent`
- `docs/api/execute-prompt.md:72` — references `stop_agent`
- `docs/features/session-lifecycle.md` — references `stop_agent`
- `tests/stop-agent.test.ts` — test file references `stop_agent`

Zero occurrences of `stop_prompt` exist in `src/`.

### Fix 2 — DRY: extract duplicate headless fallback (commit 3940788): FAIL — NOT APPLIED

`src/services/auth-socket.ts` lines 404-409 contain two inline fallback messages (Windows + Linux) with duplicated structure:
- Windows (line 405): `"fallback:No interactive desktop session detected (SSH or service context).\n\nRun this in a separate terminal:\n  ! apra-fleet auth ${memberName}\n\n..."`
- Linux (line 409): `"fallback:No graphical display detected (SSH or headless session).\n\nRun this in a separate terminal:\n  ! apra-fleet auth ${memberName}\n\n..."`

No shared helper function exists. The strings also duplicate with the catch-all at line 475 and line 494.

### Fix 3 — macOS SSH gap (commit 9eba874): FAIL — NOT APPLIED

`src/services/auth-socket.ts` line 412: the `platform === 'darwin'` branch has **no SSH/headless check**. It unconditionally launches AppleScript → Terminal.app. When connected via SSH (`SSH_TTY` set), this will either fail (no display) or open a terminal on the remote desktop that the SSH user can't see.

Linux checks `hasGraphicalDisplay()`, Windows checks `hasInteractiveDesktop()`, but macOS checks nothing.

### Fix 4 — `stop_prompt` in SKILL.md tools table (commit 9a2ac33): FAIL — NOT APPLIED

`skills/fleet/SKILL.md` tools table (lines 17-37) does not list `stop_prompt` or `stop_agent`. The tool is completely absent from the skill's tool reference.

### Fix 5 — `timeout_ms` vs `max_total_ms` guidance in SKILL.md (commit be83193): FAIL — NOT APPLIED

`skills/fleet/SKILL.md` has no mention of `timeout_ms` or `max_total_ms` semantics. The distinction is documented in `docs/api/execute-prompt.md` (lines 27-54) but not surfaced in the skill file where the dispatch rules live.

### Fix 6 — Stale `.md` references updated (commit e6d7982): FAIL — NOT APPLIED

- `docs/api/execute-prompt.md:72` still references `stop_agent` (not `stop_prompt`)
- `docs/api/stop-agent.md` — entire file uses `stop_agent` (file should be renamed to `stop-prompt.md`)
- `docs/features/session-lifecycle.md` — references `stop_agent`

Note: `docs/api/execute-prompt.md` does already document `max_total_ms` and `timeout_ms` correctly (this was done in an earlier sprint commit), so that part of fix 6 is moot.

---

## Summary

| Fix | Description | Status |
|-----|-------------|--------|
| 1 | `stop_agent` → `stop_prompt` rename | **FAIL** — not applied |
| 2 | Extract duplicate headless fallback | **FAIL** — not applied |
| 3 | macOS SSH detection | **FAIL** — not applied |
| 4 | `stop_prompt` in SKILL.md tools table | **FAIL** — not applied |
| 5 | Timeout semantics in SKILL.md | **FAIL** — not applied |
| 6 | Stale doc references | **FAIL** — not applied |

**Root cause:** The 6 commits listed in `.fleet-task.md` were never created. The branch HEAD is `2629f3f` (cleanup: remove fleet control files) and the reflog shows no evidence these commits ever existed.

**Action required:** All 6 fixes must be implemented and committed before re-review.
