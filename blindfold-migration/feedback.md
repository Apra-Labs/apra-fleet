# blindfold-migration - Phase 1 + INC-1 Code Review

**Reviewer:** reviewerAF
**Date:** 2026-05-19 20:05:00+05:30
**Verdict:** APPROVED

> See `git log -- blindfold-migration/feedback.md` for prior reviews.

---

## Phase 1 - entrypoint wiring (commit 6dbe017)

### initFleetBlindfold helper (src/services/blindfold-init.ts)

**PASS.** New file creates an idempotent `initFleetBlindfold()` that
calls `initBlindfold()` with the three critical parameters:

- `dataDir`: `process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data')` (blindfold-init.ts:16)
- `productName`: `'apra-fleet'` (blindfold-init.ts:17)
- `pipeName`: `'apra-fleet-auth'` (blindfold-init.ts:18)

These match the requirements (requirements.md:20-23) for preserving
existing users' credential paths, socket paths, and Windows pipe names.

**NOTE (LOW):** PLAN.md specifies importing `FLEET_DIR` from
`../paths.js`, but the doer replicated the expression inline to avoid
pulling in `paths.ts` (which transitively imports `log-helpers.ts` and
triggers registry + statusline side-effects at module load). This is
a sound engineering decision -- the expression is identical to the one
in `src/paths.ts:4`. The tradeoff is that if `FLEET_DIR`'s derivation
ever changes, `blindfold-init.ts` must be updated separately. Acceptable
for this migration; a `// mirrors FLEET_DIR from paths.ts` comment
would help but is not blocking.

### Logger implementation

**PASS.** The logger writes directly to `process.stderr` instead of
using `logInfo/logWarn/logError` from `log-helpers.ts`. The commit
message explains the rationale: log-helpers pulls in side-effects at
import time that broke statusline test isolation. Each write is wrapped
in try/catch to avoid crashing on closed stderr (blindfold-init.ts:6-8).
Tag format is `[fleet] blindfold [<tag>] <msg>` which matches the
fleet logging convention.

### Import shape

**PASS.** `import { initBlindfold, type Logger } from 'blindfold'`
(blindfold-init.ts:1). No relative path into `blindfold/`.

### src/index.ts placement

**PASS.** `initFleetBlindfold()` is called at index.ts:42, which is:
- AFTER `--version` exit (index.ts:10-13)
- AFTER `--help` exit (index.ts:15-40)
- BEFORE first subcommand dispatch `if (arg === 'install')` (index.ts:44)

This placement satisfies the PLAN.md requirement that --version/--help
remain fast while blindfold is initialized before any subcommand that
might touch credentials.

### --version speed

**PASS.** Measured `node dist/index.js --version` wall time: **0.146s**
(146ms). Well under the 200ms threshold specified in PLAN.md and under
the 1-second threshold in the task spec.

### src/smoke-test.ts placement

**PASS.** `initFleetBlindfold()` called at smoke-test.ts:19, at the
top of the file immediately after imports and before any blindfold
API usage. The import of `FLEET_DIR` from `paths.js` (smoke-test.ts:16)
happens on a subsequent line after the init, which is the correct
ordering since smoke-test is a standalone script (not loaded by vitest)
and imports resolve synchronously.

### tests/setup.ts (Phase 1 original, before INC-1)

**PASS.** Phase 1 commit added `initFleetBlindfold()` at the end of
setup.ts, after setting `APRA_FLEET_DATA_DIR`. Import uses the correct
path `'../src/services/blindfold-init.js'`. This was the right call
at the time -- the INC-1 fix below supersedes the setup.ts wiring but
the Phase 1 commit's logic was correct in isolation.

---

## INC-1 - vitest.config.ts top-level env (commit eb65946)

### Root cause analysis

INC-1 was a critical bug discovered during Phase 1 verification: `npm test`
was writing to `~/.apra-fleet/data/registry.json`, replacing real fleet
members with fake test agents. Root cause: `paths.ts` captures `FLEET_DIR`
at module-load time, but `tests/setup.ts` set `APRA_FLEET_DATA_DIR`
via top-level code that ran AFTER its hoisted imports had already pulled
in `paths.ts` transitively (backlog.md:7-16).

### vitest.config.ts top-level env set

**PASS.** The fix sets `APRA_FLEET_DATA_DIR` at the very top of
`vitest.config.ts` (vitest.config.ts:5-13), before `defineConfig` is
even called. This is the earliest possible point in the vitest lifecycle
-- the config module is evaluated before any test file is loaded.

The `TEST_DATA_DIR` is derived as `path.join(os.tmpdir(), 'apra-fleet-test-data')`
(vitest.config.ts:5), and set via both:
- `process.env.APRA_FLEET_DATA_DIR = TEST_DATA_DIR` (vitest.config.ts:13) -- immediate effect for the config process
- `test.env: { APRA_FLEET_DATA_DIR: TEST_DATA_DIR }` (vitest.config.ts:25) -- vitest's own env propagation to worker processes

The dual-layer approach is correct: the top-level mutation catches
paths.ts if it's loaded during config evaluation, and `test.env` ensures
vitest's worker processes also inherit the value.

### tests/setup.ts fail-fast guard

**PASS.** The guard at setup.ts:8-18 computes the expected tmp dir
independently, reads `process.env.APRA_FLEET_DATA_DIR`, and calls
`process.exit(2)` with a descriptive error message if the value is
missing or differs. This is belt-and-suspenders: even if vitest.config.ts
drifts in a future refactor, the guard prevents silent writes to the
real data directory.

The guard removed the original `process.env.APRA_FLEET_DATA_DIR = ...`
assignment from setup.ts (which was the racy line that caused INC-1).
Instead, setup.ts now only validates -- it does not set. Correct
separation of concerns.

### Empirical isolation (registry diff)

**PASS.** Registry isolation verified empirically:

1. Snapshotted `~/.apra-fleet/data/registry.json` to `/tmp/reviewer-registry-pre-test.json` (2536 bytes)
2. Ran `rm -rf /tmp/apra-fleet-test-data && npm test`
3. Snapshotted again to `/tmp/reviewer-registry-post-test.json`
4. `diff /tmp/reviewer-registry-pre-test.json /tmp/reviewer-registry-post-test.json | wc -l` -> **0**

Zero diff lines confirms that `npm test` no longer pollutes the real
fleet registry. INC-1 fix is effective.

---

## ASCII + attribution

**PASS.** All new content in commits 6dbe017 and eb65946 is ASCII-only.
Verified via `LC_ALL=C grep -P '[^\x00-\x7F]'` on the cumulative diff --
zero matches. No Claude, Anthropic, or AI attribution in commit messages
or code (word-boundary grep confirms).

---

## Build + tests

**PASS.** Build and test results on Node 20.20.1:

- `npm run build` (tsc): exit 0, clean output.
- `npm test`: **1280 passing, 3 failing, 5 skipped** (78 test files).

The 3 failures are the same pre-existing baseline as Phase 0:
- 1x `tests/platform.test.ts` -- login-shell env probe (HOME/PATH assertion)
- 2x `tests/time-utils.test.ts` -- IST timezone arithmetic

No new regressions introduced by Phase 1 or INC-1.

---

## Summary

**Verdict: APPROVED**

Phase 1 "Done when" criteria:

- initFleetBlindfold() called at every entrypoint before blindfold APIs: **PASS**
  - src/index.ts: after --version/--help, before subcommands (index.ts:42)
  - src/smoke-test.ts: top of file (smoke-test.ts:19)
  - tests/setup.ts: after APRA_FLEET_DATA_DIR guard (setup.ts:22-23)
- --version responds in under 200ms: **PASS** (146ms)
- Existing tests pass: **PASS** (1280/1283, 3 pre-existing failures)
- initBlindfold params match requirements: **PASS** (dataDir, productName, pipeName all correct)
- Import from 'blindfold', not relative path: **PASS**

INC-1 criteria:

- vitest.config.ts sets env at top level: **PASS** (vitest.config.ts:5-13)
- tests/setup.ts fail-fast guard: **PASS** (setup.ts:8-18, exit 2 on mismatch)
- Empirical registry isolation: **PASS** (diff lines: 0)

**HIGH findings:** 0
**MEDIUM findings:** 0
**LOW findings:** 1 -- blindfold-init.ts replicates FLEET_DIR expression
inline instead of importing from paths.ts (sound rationale, minor
duplication risk).
