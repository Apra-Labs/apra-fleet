# API Cleanup & Skill Doc Sweep — Phase 1 Code Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 21:35:00-04:00  
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

The plan review (commit 8350b36) was APPROVED after four rounds. This is the first code review, covering Phase 1 tasks (1.1, 1.2, 1.3, V1) completed in commit f70637f (reported as 6930f55 in progress.json — the doer likely rebased or the SHA is from the pre-push state). The commit message references #84 and #88 correctly.

---

## Build & Tests

- `npx tsc --noEmit` — clean, no errors. PASS
- `npx vitest run` — 41 test files, 628 passed, 4 skipped. PASS

---

## Task 1.1 — Fix compose_permissions crash on fresh permissions.json (#88) — PASS

`src/tools/compose-permissions.ts:80-87`: The `loadLedger` function now parses the JSON into `raw` and returns `{ stacks: raw.stacks ?? [], granted: raw.granted ?? [] }`. This correctly defends against `{}`, `{"stacks": null}`, or any other malformed content. The default return when the file doesn't exist (`{ stacks: [], granted: [] }`) is unchanged. Clean, minimal fix — exactly what the plan specified.

---

## Task 1.2 — Add test: fresh template -> compose_permissions -> no crash (#88) — FAIL

`tests/compose-permissions.test.ts:343-372`: The test has two compounding bugs that cause it to **pass vacuously** without actually verifying the fix:

**Bug 1 — Mock breaks `findProfilesDir` before `loadLedger` is reached.** The `existsSpy` (line 349) returns `false` for all paths except those ending in `permissions.json`. But `composePermissions` calls `findProfilesDir()` at line 161 **before** calling `loadLedger()` at line 162. `findProfilesDir` checks paths like `~/.claude/skills/fleet/profiles`, `~/.claude/skills/pm/profiles`, and walks up from `__dirname` — none of which end in `permissions.json`. So the mock returns `false` for every candidate, and `findProfilesDir` throws `Error('Cannot find profiles directory')`. The test never exercises `loadLedger` at all.

**Bug 2 — Async assertion pattern doesn't catch promise rejections.** The assertion:
```ts
await expect(async () => {
  result = await composePermissions({...});
}).not.toThrow();
```
In vitest, `expect(fn).not.toThrow()` only detects **synchronous** throws. When the async function's inner `await` rejects (from `findProfilesDir` throwing inside the async `composePermissions`), the rejection propagates as a rejected promise from the outer async wrapper — which `.toThrow()` does not inspect. The test passes regardless of whether the code works.

**Fix needed:** The mock must also return `true` for at least one profiles directory candidate (e.g., `s.includes('profiles')`) to let `findProfilesDir` succeed. The assertion should use `await expect(composePermissions({...})).resolves.toBeDefined()` or simply `await composePermissions({...})` (vitest fails on unhandled rejections). The `loadProfile` calls in `compose()` also need handling — the mock should return `false` for profile JSON files, which it already does (they don't end in `permissions.json`), so `loadProfile` would return `null` and the base profile would be empty. That's fine for this test — it only needs to prove no crash, not validate permission content.

**Doer:** fixed in commit 5ba6e92 — (1) `existsSpy` now returns `true` for any path containing `'profiles'` so `findProfilesDir` resolves; (2) assertion changed from broken `expect(async fn).not.toThrow()` to `await expect(composePermissions({...})).resolves.toBeDefined()` which correctly awaits and inspects the promise.

---

## Task 1.3 — Rename provision_auth -> provision_llm_auth (#84) — PASS

`src/index.ts:95`: The MCP tool registration is correctly renamed from `'provision_auth'` to `'provision_llm_auth'`. The internal export name `provisionAuth` is unchanged, consistent with the plan's "No code-level rename needed" note.

**NOTE (non-blocking, deferred to Phase 5):** There are 8+ user-facing strings in `src/` that still reference `provision_auth` — error messages in `prompt-errors.ts:18`, `register-member.ts:40/199/200/214`, `provision-auth.ts:90/252`, and `lifecycle.ts:40/45`. These tell users to "run provision_auth" but the tool is now `provision_llm_auth`. Phase 5 Task 5.4 greps `src/` for `provision_auth` and expects zero matches (excluding the internal export name), so this should be caught then. Flagging now so the doer is aware these must be updated — the grep will surface them, but the plan's Phase 5 tasks (5.1-5.3) only mention skill docs, not source-code strings. Task 5.4 would catch them, but there's no explicit task to fix them.

---

## Regressions in Previously Approved Phases — PASS

No regressions detected. The `findProfilesDir` update (checking fleet/profiles before pm/profiles) and `execute-prompt.ts` CWD fix (writing task files to `agent.workFolder`) were from earlier commits on this branch and are unchanged by Phase 1.

---

## Summary

| Task | Verdict | Notes |
|------|---------|-------|
| 1.1 — loadLedger guard | PASS | Clean null-coalescing fix |
| 1.2 — Fresh permissions test | **FAIL** | Vacuously passing — mock breaks findProfilesDir, async assertion doesn't catch rejections |
| 1.3 — provision_llm_auth rename | PASS | MCP registration updated correctly |
| V1 — npm test | PASS | 628/628 passed, 4 skipped |

**Blocking:** Task 1.2 must be fixed — the test gives false confidence. The loadLedger guard (1.1) is correct but unverified by tests.

**Non-blocking:** User-facing `provision_auth` strings in `src/` need updating (expected in Phase 5, but plan tasks 5.1-5.3 only mention docs — the doer should ensure Task 5.4's grep results are acted on).
