# Review: code-intelligence-power sprint, Phase 4 (final) -- T4.1-T4.5

Reviewer: pm-reviewer
Scope: telemetry (P8/D8), code_tests + isTestPath (P9/D9). Commits ac09a6a
(T4.1), 3f8ac49 (T4.2), 45a60c7 (T4.3), 0742c33 (T4.4), verify T4.5.

## Verdict: APPROVED

Phase 4 implements D8 telemetry and D9 test-mapping exactly to spec. All
load-bearing safety properties hold, tests are thorough and meaningful, build
is clean, and the only failing tests are the two known pre-existing timezone
cases (yashr-302). No regressions. No Phase-4-introduced non-ASCII.

## Checklist results

1. T4.1 telemetry (D8) -- PASS. recordUsage() appends one JSON line
   {ts:ISO8601, tool, target, repo} to usage.jsonl; rotation renames to
   usage.jsonl.1 (fs.rename overwrite semantics) only when size strictly > 5MB;
   writeUsageLine does mkdir(recursive) -> rotateIfNeeded -> appendFile, all
   swallowed via `void writeUsageLine().catch(()=>{})` plus an outer try/catch.
   recordUsage returns void synchronously -- cannot throw or block. Wired in the
   src/index.ts shared handler layer for all seven code_* tools (graph, impact,
   query, context, map, flow, tests), one line each, before the provider call.
   Provider file NOT polluted: code-intelligence-gitnexus.ts imports only
   isTestPath (T4.4), never the telemetry module -- provider stays a pure proxy.

2. T4.2 fleet_status top symbols (D8 read) -- PASS. computeTopSymbols() reads
   usage.jsonl AND usage.jsonl.1, skips unparseable lines, filters ts >= now-30d
   (boundary-inclusive), aggregates count by target via Map, returns top 5. JSON
   codeIntelligence.topSymbols + compact "top symbols (30d): a (12), ..."
   fragment appended to both the present and no-index branches. Fully
   degraded-safe: readUsageLines catches per-file, computeTopSymbols wraps the
   whole pass, and fleetStatus wraps the call again -- missing file / bad JSON /
   read error -> field and segment omitted, never throws. Follows the
   codeIntelligenceHealth degraded-safe pattern.

3. T4.3 isTestPath (D9) -- PASS. Pure exported fn; splits on /[/\\]+/, true when
   any segment (lowercased) is in {test,tests,spec} OR the filename matches
   /\.(test|spec)\.[^.]+$/i. Negatives correctly rejected: contest, attest.ts,
   testfile.ts, protest.spec (no trailing extension), attestation/, specimen/,
   testHelpers.ts, empty string. Mixed separators handled. Exhaustive
   table-driven tests (22).

4. T4.4 code_tests (D9) -- PASS. GitNexusProvider.tests() routes
   callGitNexus('impact', {target:symbol, direction:'upstream', maxDepth:2,
   includeTests:true, repo?}); mapTestsResult collects byDepth["1"]+["2"] and
   filters filePath through isTestPath, returning {tests, count}. codeTestsSchema
   {symbol, repo?}. Registered in src/index.ts with routing-guidance description
   ("run targeted tests ... Prefer this over Grep for test discovery"); telemetry
   wired in the handler. Inherits pre-flight missing-index check and connection
   resilience from callGitNexus.

5. Load-bearing safety -- PASS. Telemetry is synchronous fire-and-forget with
   swallow at both the sync and async boundaries; it cannot throw, block, or
   degrade a tool call. code_tests never throws: callGitNexus returns structured
   {content,isError} and mapTestsResult passes error results through untouched;
   extractImpactPayload returning null falls back to the raw result rather than
   throwing.

6. Tests -- PASS. Telemetry: append format (exact keys, ISO ts, repo null/set),
   mkdir-before-append, no-rotate under threshold, exactly-5MB no-rotate,
   rotate+overwrite, error isolation x4 (mkdir/stat/rename/appendFile reject).
   Top-N: ties, <5, 30d filter, exact-boundary inclusion, reads .1, unparseable
   skipped, missing-ts/target skipped, error->undefined. isTestPath: exhaustive
   positives/negatives + mixed separators. code_tests: impact-args, depth-1+2
   filtering, empty result, hint-suffix stripping, error passthrough, schema,
   missing-index reuse. The telemetry test's use of static vi.mock('fs/promises')
   + vi.waitFor instead of vi.resetModules is a correct, documented deviation:
   the module holds no singleton state, so KB constraint 1 does not apply.

7. build + test -- PASS. `npm run build` (tsc) exit 0. Full suite: 1770 passed,
   2 failed, 14 skipped -- both failures are the known pre-existing timezone
   tests in tests/time-utils.test.ts (yashr-302). No other regressions.

8. ASCII -- PASS (no Phase 4 violation). Byte-scan of all Phase 4 changed files:
   check-status.ts's 9 non-ASCII bytes are pre-existing on main (em-dash comments
   + a warning-sign glyph from PRs #1/#263, lines 423/427/491 -- outside T4.2's
   diff); code-intelligence-gitnexus.ts (21) and code-intelligence.test.ts (14)
   are the Phase 2 asciiSanitizeLabel UNICODE_ARROW_PATTERN and its test
   fixtures, which are load-bearing (the sanitizer must contain the glyphs it
   strips). Phase 4 (T4.1-T4.4) introduced zero non-ASCII bytes.

## Findings

HIGH: none.

MEDIUM: none.

LOW-1 (cosmetic, non-blocking): code_map records recordUsage('code_map', '', ...)
and code_flow may record '' when no name/from/to is given. Since
computeTopSymbols accepts any string target (including ''), heavy code_map use
could surface a blank-labelled entry in the fleet_status "top symbols (30d)"
line, e.g. " (7)". This matches the doer's documented choice (a listing tool has
no natural single-string target) and does not affect correctness or the D8
contract; a future cleanup could drop empty targets from the top-N aggregation
or omit telemetry for argument-less tools. No change required for this sprint.

## Rationale

Phase 4 lands telemetry and code_tests precisely per D8/D9 with airtight
error isolation, thorough tests, a clean build, no regressions, and no
Phase-4-introduced ASCII violations -- APPROVED.
