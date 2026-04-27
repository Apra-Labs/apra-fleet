# Review: PR #183 Fix Commits — Post-Rebase Verification

**Branch:** `sprint/session-lifecycle-oob-fix`
**Reviewed:** 2026-04-27
**Scope:** 9 fix commits (d269043–1e2b2fe) addressing prior expert review findings
**Verdict:** APPROVED — 0 blocking, 1 advisory

---

## Fix Verification

### #1 — Label injection: Zod regex + scope_url safety comments — PASS

- `provision-vcs-auth.ts`: `.regex(/^[a-zA-Z0-9_-]{1,64}$/)` on label ✅ (9f15fd7)
- `revoke-vcs-auth.ts`: same regex ✅ (9f15fd7)
- `linux.ts` + `windows.ts`: scope_url safety comments on all 4 escaping sites ✅ (d269043)

**Advisory (A1):** Prior insist-on asked for defense-in-depth quoting of `${credFile}` in Linux shell commands (`> "${credFile}"` instead of `> ${credFile}`). Only scope_url comments were added; credFile paths remain unquoted. With the regex in place, no metacharacters can reach these paths — quoting is pure belt-and-suspenders. Recommend follow-up.

### #2 — revoke_vcs_auth accepts and uses scope_url — PASS

- Schema: `scope_url: z.string().optional()` added ✅ (9f15fd7)
- Implementation: `input.scope_url ?? \`https://${host}\`` replaces hardcoded value ✅
- Plumbing to `service.revoke()` was already in place — only schema + fallback needed

### #3 — In-flight Set guard on executePrompt — PASS

- Module-level `const inFlightAgents = new Set<string>()` ✅ (5489911)
- Guard: `if (inFlightAgents.has(agent.id))` → clear error with agent name ✅
- Cleanup: `finally` block deletes from set; early stopped-flag exit also deletes ✅
- stop_prompt ↔ in-flight interaction: kill triggers `execCommand` rejection → `finally` block cleanup. The agent IS still in-flight until the kill completes, so returning "already in flight" to a concurrent dispatch is correct behavior. No explicit clearing in `stopPrompt()` needed.

### #4 — Dead `dangerouslySkipPermissions` removed from PromptOptions — PASS

- Removed from interface at `provider.ts` ✅ (a2be2e2)
- Schema field in execute-prompt.ts preserved as deprecated for backwards compat ✅

### #5 — Dead `activePid` removed from Agent interface — PASS

- Removed from `types.ts` ✅ (f262b29)
- Optional field — persisted registry data unaffected

### #6 — PROVIDER_HOSTS extracted to shared constants — PASS

- New `src/services/vcs/constants.ts` ✅ (9f15fd7)
- Both tools import from shared location; no duplicates remain ✅

### #10 — LocalStrategy sends SIGKILL — PASS

- Both timer callbacks: `child.kill('SIGKILL')` with cross-platform comment ✅ (124fce9)
- Matches SSH path's `kill -9` behavior

### #11 — .unref() on timers in LocalStrategy — PASS

- `inactivityTimer.unref()` after resetInactivityTimer's setTimeout ✅ (124fce9)
- `maxTotalTimer.unref()` after creation ✅
- Matches existing ssh.ts pattern

### #12 — .gitignore CLAUDE.md explanatory comment — PASS

- Two-line comment added ✅ (8cb0286)

### #13 — feedback.md moved to docs/reviews/ — PASS

- Root `feedback.md` deleted ✅ (d269043)
- `docs/reviews/feedback-b238154.md` created with identical content ✅ (feae945)

### #15 — Empty afterEach filled with credential cleanup — PASS

- `tests/credential-scoping-ttl.test.ts`: afterEach iterates `credentialList()`, regex-matches test prefixes (`scope_star_`, `scope_in_`, `scope_deny_`, `scope_bypass_`, `scope_undef_`), calls `credentialDelete()` for each ✅ (1e2b2fe)

---

## Rebuttals Re-verified

| # | Claim | Still holds? |
|---|-------|-------------|
| #7 | Timer dedup across SSH/local is forced (different handle types) | Yes — ChildProcess.kill vs SSH stream reject |
| #8 | Zod `.positive()` at schema boundary is sufficient | Yes — internal code receives only validated values |
| #9 | `$!` captures backgrounded command group PID | Yes — `{ ... } &` + `$!` is correct |
| #14 | `console.warn` to stderr for deprecation is acceptable | Yes — non-MCP context, observability out of scope |

---

## Regressions

None. All fixes are surgical, well-scoped, and don't introduce new issues.

---

## Summary

All 11 fixes correctly implemented. All 4 rebuttals remain sound. One advisory (A1): add credFile quoting in linux.ts as defense-in-depth in a follow-up — not blocking since the regex prevents injection.
