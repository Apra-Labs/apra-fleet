# API Cleanup & Skill Doc Sweep — Phase 5 Code Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 23:10:00-04:00  
**Verdict:** CHANGES NEEDED → RESOLVED (2026-04-06)

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

Phase 4 re-review (commit d977bfc) was APPROVED. Phases 1–4 remain clean — no source files modified in Phase 5 that touch prior phase logic.

Phase 4 review carried forward one non-blocking item: "User-facing strings in `src/` still reference `provision_auth` — Phase 5 Task 5.4 scope." Phase 5 commit `7662a22` addressed this in `src/` — see Task 5.4 below.

Phase 5 work is a single commit: `7662a22` ("Phase 5: skill doc sweep — provision_llm_auth, rm update_task_tokens, permission denial guidance"). It touches 12 files: skill docs, source files, tests, and progress.json.

---

## Task 5.1 — Update fleet SKILL.md — PASS

`skills/fleet/SKILL.md:26`: `provision_auth` → `provision_llm_auth`. Correct.

`skills/fleet/SKILL.md`: `update_task_tokens` row removed from tool table. Correct.

No other stale references in this file. Clean.

---

## Task 5.2 — Update fleet onboarding.md — PASS

No stale `provision_auth` or `update_task_tokens` references existed. Confirmed clean.

---

## Task 5.3 — Update PM skill docs — PASS

`skills/pm/doer-reviewer.md:88`: Mid-sprint denial guidance added under `## Permissions`. Matches PLAN.md specification verbatim. Clean.

`skills/pm/single-pair-sprint.md:77`: Same mid-sprint denial guidance added under `### Permissions`. Clean.

No stale `update_task_tokens` or `provision_auth` references existed in PM docs.

---

## Task 5.4 — Final stale-reference grep — FAIL

The doer's grep was scoped to `skills/` and `src/` (matching the PLAN), and those directories are clean: zero matches for `provision_auth|update_task_tokens|claude.version|claude.auth`.

**However, the sweep missed `tests/`.** Two test files still contain stale `provision_auth` references:

### Finding 1 (BLOCKING) — `tests/integration.test.ts:210` — silent test regression

```ts
result.includes('/login') && result.includes('provision_auth')
  ? ok(`Auth error detected on ${ac.friendly_name}`)
  : skip(`Auth detect ${ac.friendly_name} — unexpected result ...`);
```

`authErrorAdvice()` in `src/utils/prompt-errors.ts` now returns `provision_llm_auth`. This means `result.includes('provision_auth')` will **always be false**, so the auth-detection test will silently skip every time — it can never detect auth errors anymore. This is a functional regression in the integration test.

**Fix:** Change `provision_auth` → `provision_llm_auth` on line 210. ✓ DONE

### Finding 2 (BLOCKING) — `tests/integration.test.ts:104` — stale skip message

```ts
: skip('~/.claude/.credentials.json missing — provision_auth will be skipped for remote agents');
```

The tool is now named `provision_llm_auth`. This is a user-visible message.

**Fix:** Change `provision_auth` → `provision_llm_auth` on line 104. ✓ DONE

### Finding 3 (NON-BLOCKING) — `tests/auth-socket.test.ts` — stale tool name in direct calls

Lines 372, 389, 400, 404, 411, 415: Tests call `collectOobApiKey('...', 'provision_auth', ...)` and assert fallback messages contain `'provision_auth'`. These tests still pass because `collectOobApiKey` uses whatever tool name is passed to it — so the function works correctly with any string. However, the tests no longer reflect production usage where `provisionAuth()` now passes `'provision_llm_auth'`.

**Recommended fix:** Update the tool name argument to `'provision_llm_auth'` in all 6 occurrences, and update the `.toContain('provision_auth')` assertions on lines 404 and 415 to `.toContain('provision_llm_auth')`. This keeps the tests aligned with the actual caller. ✓ DONE (all 6 occurrences replaced)

---

## Source file changes — PASS

The commit also updated `provision_auth` → `provision_llm_auth` in user-facing strings across source files. All changes are correct:

- `src/services/cloud/lifecycle.ts:40,44` — log messages. PASS.
- `src/tools/provision-auth.ts:90,252` — error message and OOB tool name. PASS.
- `src/tools/register-member.ts:40,199,200,204` — schema description and warning messages. PASS.
- `src/utils/prompt-errors.ts:18` — `authErrorAdvice` message. PASS.

Corresponding test updates:
- `tests/execute-prompt.test.ts:59` — assertion updated. PASS.
- `tests/prompt-errors.test.ts:32,35` — test name and assertion updated. PASS.
- `tests/security-hardening.test.ts:278` — assertion updated. PASS.
- `tests/tool-provider.test.ts:198` — assertion updated. PASS.

---

## Build & Full Test Suite — PASS

- `npm test` — 40 test files, 628 passed, 4 skipped. No failures.
- Zero stale references in `skills/` and `src/` (confirmed via grep).

---

## Phase 1–4 Regression Check — PASS

No prior phase source files (`compose-permissions.ts`, `member-detail.ts`, `execute-command.ts`, `execute-prompt.ts`, `check-status.ts`, `types.ts`) were modified in Phase 5. `git diff d977bfc..7662a22` shows no changes to these files. All prior phase tests continue to pass.

---

## Summary

| Task | Verdict | Notes |
|------|---------|-------|
| 5.1 — Update fleet SKILL.md | PASS | `provision_llm_auth` renamed, `update_task_tokens` removed |
| 5.2 — Update fleet onboarding.md | PASS | No stale refs existed |
| 5.3 — Update PM skill docs | PASS | Mid-sprint denial guidance added |
| 5.4 — Final stale-reference grep | FAIL → FIXED | Sweep missed `tests/` — 8 stale refs fixed; PLAN.md updated to include `tests/` in grep scope |
| V5 — npm test | PASS | 628 passed, 4 skipped |
| Phase 1–4 regression | PASS | No regressions |

**Blocking:** Fix the 2 stale `provision_auth` references in `tests/integration.test.ts` (lines 104 and 210). Line 210 is a silent regression — the auth-detection integration test can never pass with the old string.

**Non-blocking:** Update 6 stale `provision_auth` occurrences in `tests/auth-socket.test.ts` to match production usage.

**Carried forward from Phase 4 (non-blocking):** `member_detail` shows token string even when both values are 0; `fleet_status` suppresses zeros. Minor display inconsistency.
