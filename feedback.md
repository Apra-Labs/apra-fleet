# Polish Sprint OOB+misc — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-04-21 01:50:00+05:30
**Verdict:** APPROVED

---

## Fix-by-fix findings

### #164 — OOB retry hangs after terminal close
**PASS** — Commit 8a25a39

`pendingRequests.delete(memberName)` added to all three return paths in `collectOobInput` (`src/services/auth-socket.ts:262,271,279`). `passwordWaiters` cleanup added in the fallback branch (lines 264-268). Without this, `hasPendingAuth()` returned true on retry, the re-entrant guard skipped `launchAuthTerminal`, and the call hung indefinitely.

Two new tests cover the exact scenarios:
- `tests/auth-socket.test.ts:419` — fallback → retry launches fresh terminal
- `tests/auth-socket.test.ts:440` — cancel (non-zero exit) → retry launches fresh terminal

Both tests verify `hasPendingAuth()` returns false after cleanup.

### #165 — OOB shows credential name instead of member name
**PASS** — Commit 8a25a39

`src/cli/auth.ts:23` — header changed from `"Member: ${memberName}"` to `"Enter secure value for: ${memberName}"` for the `--api-key` mode. The SSH password and `--confirm` modes still show the appropriate labels.

### #33 — `__dirname` used in `install.ts` (ESM incompatible)
**PASS** — Commit c20dbfa

`src/cli/install.ts:123-126` — ESM-compatible `__dirname` shim added:
```ts
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

**NOTE:** Two other files use bare `__dirname`:
- `src/version.ts:19` — safe; entire block is inside a `try/catch` that uses `require()` (CJS), so in ESM mode it falls through to the `v0.0.0-unknown` fallback gracefully.
- `src/tools/compose-permissions.ts:63` — uses bare `__dirname` outside a try/catch. In dev mode via `tsx`, this would throw `ReferenceError` if `compose_permissions` is invoked. It doesn't block the acceptance criteria (which test `install --help`), but is a latent bug on the same pattern. **Recommend fixing in a follow-up.**

### #5 — `cloud_activity_command` `.min(1)` blocks clearing
**PASS** — Commit c20dbfa

`src/tools/update-member.ts:42` — `.min(1)` removed from the Zod schema. Empty string is now accepted by validation and reaches the handler where `|| undefined` clears the field.

Test coverage: `tests/update-member.test.ts` covers `{{secure.NAME}}` token resolution (lines 83-110). No dedicated test for the empty-string `.min(1)` removal, but since this is a schema-only change removing a constraint, the Zod behaviour is well-established and the risk is minimal.

### #106 — Headless/SSH fallback should mention `{{secure.NAME}}`
**PASS** — Commit c20dbfa

Both fallback messages in `src/services/auth-socket.ts` updated:
- Linux no-terminal (`line 451`): appends `Alternatively, pre-store the value with credential_store_set and reference it as {{secure.NAME}} in the credential field.`
- Catch-all error (`line 470`): same hint appended after the error message.

---

## Build & Test

- `npm run build` — **PASS** (tsc, no errors)
- `npm test` — **PASS** (45 test files, 785 tests passed, 4 skipped)

---

## Summary

All five issues (#164, #165, #33, #5, #106) are addressed correctly. Both commits are well-scoped and the changes match requirements.md acceptance criteria. New tests cover the critical OOB retry/cancel hang fix (#164).

One non-blocking follow-up recommended: apply the ESM `__dirname` shim to `src/tools/compose-permissions.ts` to prevent a `ReferenceError` when running that tool in dev mode.
