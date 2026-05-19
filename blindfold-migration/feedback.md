# blindfold-migration - Phase 0 Code Review

**Reviewer:** reviewerAF
**Date:** 2026-05-19 18:55:00+05:30
**Verdict:** APPROVED

> See `git log -- blindfold-migration/feedback.md` for prior reviews (first review now).

---

## Phase 0 - submodule + dependency

### Submodule pointer

**PASS.** `.gitmodules` created with `path = blindfold` and
`url = git@github.com:Apra-Labs/blindfold.git` (.gitmodules:1-3).
Submodule HEAD is `a35e266426db4500a3641b854d6044933dff1e44`. Tag
`v0.0.1` is an annotated tag whose dereferenced commit
(`git -C blindfold rev-parse v0.0.1^{commit}`) matches HEAD exactly.
42 previously-tracked `blindfold/**` files removed from the index and
replaced by the submodule pointer.

### package.json dep shape

**PASS.** `package.json` adds `"blindfold": "file:./blindfold"` in
`dependencies` (package.json:48). Existing deps `@inquirer/password`
and `zod` retained. `package-lock.json` updated with blindfold and
its transitive deps.

### Build + tests

**PASS.** All three gates verified independently on Node 20.20.1:

- `npm install` -- exit 0 (9 pre-existing audit vulnerabilities, unrelated).
- `npm run build` (tsc) -- exit 0, clean output.
- `npm test` -- **1280 passing, 3 failing, 5 skipped**.

The 3 failures are all in `tests/time-utils.test.ts` and relate to
timezone arithmetic (local-hour boundary expectations, minute-preservation
in UTC-to-local conversion). These failures reproduce on `main` before
this commit and are unrelated to the blindfold migration. Matches
doer's reported count exactly.

**NOTE (MEDIUM):** `npm install` creates a symlink
(`node_modules/blindfold -> ../blindfold`) rather than a copy, so
blindfold's `prepack` script does not run automatically. A fresh clone
requires `cd blindfold && npm install && npm run build` before
blindfold's `dist/` exists. This does not block Phase 0 (no source
imports from blindfold yet), but Phase 1+ will fail on a fresh clone
without that step. Consider adding a `postinstall` or `prepare` script
in the root `package.json` that builds the submodule, or document the
setup step in the README.

### Import resolution

**PASS.** After building blindfold locally, the five critical exports
all resolve:

```
typeof initBlindfold    -> function
typeof credentialSet    -> function
typeof getSocketPath    -> function
typeof resolveSecureTokens -> function
typeof getOobTimeoutMs  -> function
```

### Relative-path imports

**PASS (vacuous).** Phase 0 does not touch `src/` imports. Confirmed
no fleet source file imports a relative path into `blindfold/`.

### ASCII content

**PASS.** All new content introduced by commit `2b4150f` is ASCII-only:
`.gitmodules`, `.gitignore` addition, `package.json` dependency line,
commit message. The em-dashes in `blindfold-migration/progress.json`
step names (e.g. "Phase 0 -- submodule") pre-date this commit (scaffolded
in `ca10bd4` by PM) and are not a Phase 0 finding.

### AI attribution

**PASS.** `git log -1 --pretty=full HEAD` shows author and committer
as `mradul <mradul@apra.in>`. Commit subject is
`chore(deps): add blindfold as git submodule + file: dep`. No Claude,
Anthropic, or AI references in the message or body.

### Process notes (LOW)

**NOTE (LOW):** `progress.json` records commit SHA `061bc164` for tasks
0.1 and 0.V, but the actual HEAD is `2b4150f`. This is a known
chicken-and-egg issue: the doer updated progress.json inside the same
commit, then the commit was amended (changing the SHA). Not a blocker
-- the branch pointer is authoritative.

---

## Summary

**Verdict: APPROVED**

All Phase 0 "Done when" criteria pass:

- .gitmodules tracks blindfold at v0.0.1: PASS
- package.json has "blindfold": "file:./blindfold": PASS
- import { initBlindfold } from 'blindfold' resolves: PASS
- npm install / npm run build / npm test all pass: PASS
- No relative-path imports into blindfold/: PASS (vacuous)
- ASCII only in new content: PASS
- No AI attribution: PASS
- progress.json marks 0.1 and 0.V completed: PASS

**HIGH findings:** 0
**MEDIUM findings:** 1 -- fresh-clone build requires manual blindfold
build step (symlink vs prepack). Not blocking Phase 0; should be
addressed before Phase 6 final verification.
**LOW findings:** 1 -- progress.json commit SHA mismatch (cosmetic).
