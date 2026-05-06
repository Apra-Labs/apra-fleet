# Review: fix/dep-vulns-100 — Security Vulnerability Fixes (Issue #100)

**Reviewer:** Claude (reviewer role)  
**Branch:** `fix/dep-vulns-100`  
**Commit:** `5747b2a fix(deps): resolve security vulnerabilities (issue #100)`  
**Date:** 2026-05-06

---

## Files Changed

| File | Verdict | Notes |
|---|---|---|
| `package.json` | OK | uuid bumped from `^11.0.0` to `^14.0.0` — only change, as expected |
| `package-lock.json` | OK | Transitive deps updated: @hono/node-server 1.19.9→1.19.14, express-rate-limit 8.2.1→8.5.0, hono 4.12.2→4.12.17, ip-address 10.0.1→10.1.0, picomatch 8.3.0→8.4.2, postcss 4.0.3→4.0.4, uuid 11→14 |
| `GEMINI.md` | OK (fixed) | Restored to project context in `2cd5b96`. Matches origin/main. |

## Checklist

### R1 — npm audit fix applied
**PASS.** `package-lock.json` shows transitive dependency upgrades for @hono/node-server, express-rate-limit, hono, ip-address, picomatch, and postcss. All expected packages were updated.

### R2 — uuid bumped to v14
**PASS.** `package.json` shows `"uuid": "^14.0.0"`. Lock file confirms resolution.

### R3 — uuid API compatibility
**PASS.** Three files use uuid:
- `src/services/strategy.ts:5` — `import { v4 as uuid } from 'uuid'`
- `src/services/ssh.ts:5` — `import { v4 as uuid } from 'uuid'`
- `src/tools/register-member.ts:2` — `import { v4 as uuid } from 'uuid'`

All use the `v4` named export, which is fully supported in uuid v14. No API changes needed. No source files were modified — correct.

### R4 — Tests pass
**PASS.** `npm test` — 73 test files, 1181 tests passed, 6 skipped, 0 failures.

### R5 — Audit clean (HIGH severity)
**PASS.** `npm audit` reports 0 HIGH vulnerabilities. 3 MODERATE remain (ip-address XSS in Address6 HTML methods, affecting express-rate-limit → @modelcontextprotocol/sdk). Fixing these would require downgrading @modelcontextprotocol/sdk to 1.25.3, which is a breaking change. Acceptable per requirements ("MODERATE items may remain if they cannot be addressed without breaking changes").

### R6 — File justification
**FLAG: GEMINI.md** — ~~Modified to contain doer sprint instructions. Not related to the security fix task.~~  
**RESOLVED** in commit `2cd5b96`. GEMINI.md has been restored to the standard project context version (matches origin/main exactly). The fix commit is clean — only touches GEMINI.md, reducing it from sprint instructions back to the README-pointing context file.

---

## Verdict

**APPROVED**

All acceptance criteria are met:
- uuid bumped to v14, API usage compatible (v4 export unchanged)
- All HIGH vulnerabilities resolved via npm audit fix
- Tests pass (1181 passed, 0 failures)
- GEMINI.md sprint artifact reverted in `2cd5b96` — file now matches main
- No unrelated changes remain on the branch
