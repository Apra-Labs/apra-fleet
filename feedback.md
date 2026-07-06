# Phase 2 Review -- Code Intelligence Hardening (T2.1-T2.3)

Reviewer: pm-reviewer
Date: 2026-07-06
Scope: commits a8add4f (T2.1, F2.2 freshness note) and 56e27f6 (T2.2, F2.1 docs
re-index at VERIFY); phases 1-2 cumulative, with phase 1 (351ee89) already
APPROVED -- this review focuses on the phase 2 commits.
Verdict: **APPROVED**

## Checklist results

### 1. F2.2 -- freshness note (a8add4f)

- [OK] `freshnessNote(lastCommit, head)` is an exported pure function (no IO)
  in new `src/tools/code-intelligence-freshness.ts`. Returns null when either
  side is missing (`!lastCommit || !head`) or when they match; otherwise the
  note text matches requirements.md VERBATIM with `slice(0, 8)` truncation of
  both SHAs. Short SHAs (< 8 chars) are safe -- slice never throws.
- [OK] Separate module is justified: `code-intelligence.ts` imports
  `GitNexusProvider` from `code-intelligence-gitnexus.ts`, so placing the pure
  function in `code-intelligence.ts` would have created a circular value
  import. Sensible call.
- [OK] Wiring lives in the shared `callGitNexus` helper (single place, all
  four provider methods -- confirmed via code_impact: graph/impact/query/
  context are the only callers). Note is computed only when the call carries a
  non-empty string `repo` AND the F3.1 pre-flight passed (index exists), after
  a successful `callTool`.
- [OK] Degradation: `computeFreshnessNote` wraps meta.json read/parse and
  `git rev-parse HEAD` (execFileSync, 3s timeout, stderr ignored) in try/catch
  returning null -- any meta/git failure means "no note", never a blocked or
  failed call. Covered by tests (git throws; invalid JSON).
- [OK] MCP shape preserved: `appendFreshnessNote` only touches results that
  are objects with a `content` array, appending one `{ type: 'text', text }`
  block and spreading the rest of the result; anything else is returned
  unchanged rather than risk corrupting an unexpected shape. Note appended at
  most once per response (single call site, single append).
- [OK] No F3.1/F3.2 regression: pre-flight `existsSync` check still runs
  before `getGitNexusClient()` is awaited (missing index never spawns the
  child); the catch block still calls `resetConnection()` and returns the
  structured offline result. All 12 pre-existing F3.1/F3.2/getProvider tests
  in tests/code-intelligence.test.ts still green.

### 2. F2.1 -- re-index at VERIFY in PM docs (56e27f6)

- [OK] Doer template VERIFY sentence (skills/pm/doer-reviewer-loop.md lines
  167-169) now reads: build, linter, full test suite, then `npx gitnexus
  analyze` -- with non-fatality explicit: "(non-fatal; if it fails, record in
  progress.json and continue)". Analyze sits after tests and before the
  stop/push step, matching the required ordering.
- [OK] skills/pm/index.md "When to run" gains the bullet documenting that
  VERIFY checkpoints re-run analyze automatically (incremental via fileHashes,
  seconds).
- [OK] Diff confined to exactly those two files; no unrelated text reflowed.

### 3. Tests

- [OK] tests/code-intelligence-freshness.test.ts: 7 pure-function cases --
  match -> null, differ -> exact verbatim string with 8-char truncation,
  undefined lastCommit / head / both -> null, short SHAs no crash + verbatim,
  short-SHA match -> null. All meaningful (exact-string assertions, not
  substring smoke checks).
- [OK] tests/code-intelligence.test.ts: 4 new wiring tests with
  child_process.execFileSync mocked as the stubbed HEAD -- note appended when
  SHAs differ (asserts both content blocks and length 2), no note on match,
  no note + call unaffected when git throws, no note on invalid meta.json.
  The blanket child_process mock is safe in this file (documented in a
  comment; no other code path under test uses it).

### 4. Build and test run (executed by reviewer)

- [OK] `npm run build` (tsc): clean, no errors.
- [OK] `npm test`: 1658 passed, 2 failed, 14 skipped across 116 files. The
  2 failures are exactly the known pre-existing tests/time-utils.test.ts
  timezone-dependent failures (IST machine, beads yashr-302) -- the only
  failures permitted by the review instructions. No other failures.

### 5. ASCII

- [OK] All six touched files contain 0 non-ASCII bytes (checked with tr), and
  the full phase 2 diff (351ee89..985385a) is ASCII-only. The T2.3 note about
  reverting gitnexus-injected non-ASCII blocks in AGENTS.md/CLAUDE.md checks
  out -- neither file appears in the phase 2 diff.

## Findings

None. No HIGH, MEDIUM, or LOW findings.

## Verdict

**APPROVED** -- Phase 2 (T2.1, T2.2) meets the F2.1/F2.2 contracts verbatim,
degrades safely on every error path, preserves phase 1 behavior, and is fully
covered by meaningful tests. Phase 3 may proceed.
