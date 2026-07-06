# Plan Review -- Code Intelligence Power Sprint (PLAN.md @ 6671ec6)

Reviewer: pm-plan-reviewer
Sources: requirements.md, design.md (D1-D9), PLAN.md, KB (kb_session_prime +
kb_query for callGitNexus / fleet_status), source spot-checks.

## Verdict: APPROVED

All findings below are LOW; none blocks execution. The plan is complete,
design-compliant, correctly risk-ordered, and self-contained.

## Findings

1. LOW -- Telemetry tie behavior is claimed as a recorded resolution but the
   rule is never stated. T4.2 requires tests for "top-N aggregation (ties,
   fewer than 5 targets)" yet the task text only says "take top 5 by count";
   a doer cannot write a deterministic tie assertion without a rule. Suggest
   adding one line to T4.2 (e.g. "ties broken deterministically:
   lexicographic by target"). Non-blocking: any deterministic choice the doer
   documents satisfies D8.

2. LOW -- The FTS-sensitivity resolution is only implicit. SqliteProvider
   itself notes FTS "may fail on unusual tokens" (sqlite-provider.ts line
   545, catch in prime()). In T1.3 the single batch query
   `neighbors.join(' ')` means one FTS-hostile symbol name (dots, parens,
   dashes are common in symbol output) fails the WHOLE batch and the
   try/catch silently skips the entire expansion; T3.3 queries by raw symbol
   name with the same exposure. This degrade is design-compliant (D4:
   degrade to current behavior), but the plan should state it explicitly so
   doers/testers know batch-loss-on-bad-token is intentional, and so a test
   can cover an FTS-error neighbor name. One sentence in T1.3 and T3.3 fixes
   it.

3. LOW -- T1.2 (embeddings spike) is assigned claude-sonnet-4-6 while the
   review bar asks for strong models on spikes. Acceptable here: T1.2 is a
   narrow, timeboxed CLI/docs investigation gating only T2.3, and the
   high-leverage spike (T1.1, gating T2.1/T2.2/T4.4) correctly gets
   claude-opus-4-8. Recorded for PM awareness, no change required.

4. LOW -- Minor anchor drift: PLAN.md cites HttpKbProvider.prime at
   src/services/knowledge/http-provider.ts lines 233-243; actual span is
   234-244. Off by one, cannot mislead a doer. All other cited anchors are
   exact (see verification below).

## Checklist verification

1. Coverage -- PASS. P1 -> T1.1 + T2.1 + T2.2; P2 -> T1.2 + T2.3; P3 ->
   T3.1 + T3.2; P4a -> T3.3; P4b -> T1.3; P8 -> T4.1 + T4.2; P9 -> T4.3 +
   T4.4. Every investigation-gated task (T2.1, T2.2, T2.3, T4.4) states its
   decision rule inline (proxy / compose / descope+docs+backlog per D1
   ladder; LOCAL/EXTERNAL/UNSUPPORTED per D2), and all state that silent
   omission is unacceptable. Done criteria are testable (finding 1 is the
   one soft spot).

2. Design compliance -- PASS.
   - D1: map/flow/tests are provider-interface methods routed through
     callGitNexus; registration mirrors src/index.ts lines 310-325; "do NOT
     parse ladybugdb (lbug)" repeated in T2.1/T2.2/T4.4 and sprint-wide
     constraints.
   - D2: T2.3 three-branch rule, default OFF, config only in
     ~/.apra-fleet/data/code-intelligence/config.json.
   - D3: T3.1 in-memory Map, pure shouldStartReindex(entry, now, cooldownMs)
     (unit-testable without timers), 120000 ms default + config override,
     detached spawn off the call path with stderr tail to log helpers,
     enabled default true.
   - D4: T3.3 enrichment lives in code-intelligence-kb-enrich.ts imported
     only by the handler (provider never imports KB service); T1.3 expansion
     lives in the kb-session-prime wrapper via getProvider(), with
     NEIGHBOR_CAP = 10 and ADDED_ENTRY_CAP = 5 exported; both joins
     read-only + hard-skip on error.
   - D8: JSONL {ts, tool, target, repo}, 5MB rotate to .1, recording in
     handlers only (provider stays pure proxy), fire-and-forget try/catch,
     read path single-pass over .jsonl + .1 with 30d filter.
   - D9: T4.3 isTestPath spec matches design verbatim (segment
     test/tests/spec case-insensitive, /\.(test|spec)\.[^.]+$/ filename,
     both separators); T4.4 fixes depth at 2.

3. Risk order -- PASS. Phase 1 = T1.1 spike + T1.2 spike + T1.3 (P4b,
   riskiest pure-code) per design phasing guidance. All spike-gated build
   tasks (T2.1, T2.2, T2.3, T4.4) are in later phases than their spikes.
   T1.3's reference to T1.1's surface doc is satisfied by in-phase task
   ordering and carries its own defensive fallback (context or impact,
   isError/unparseable treated as no neighbors).

4. Models -- PASS. Every work/spike task has an exact model (2x
   claude-opus-4-8, 9x claude-sonnet-4-6, 2x claude-haiku-4-5; summary table
   matches task-by-task assignments). All four VERIFY tasks are modelless
   and each includes build + test + gitnexus analyze + the non-ASCII
   AGENTS.md/CLAUDE.md revert (KB constraint 2 verbatim) + push, and each
   names the 2 known timezone failures (tests/time-utils.test.ts, beads
   yashr-302) as the only allowed failures. See finding 3 on T1.2's tier.

5. Self-containedness -- PASS. Factual anchors verified against source:
   - src/tools/code-intelligence.ts: interface lines 7-12, PROVIDERS line
     16, getProvider lines 42-59, CONFIG_PATH line 14 -- all exact.
   - src/index.ts lines 310-325: four code_* registrations, handler pattern
     and routing sentence exactly as quoted in the plan.
   - src/tools/kb-session-prime.ts: wrapper flow (prime -> global append)
     and query call shape {query, l1_only, limit, include_stale} match.
   - SqliteProvider.prime lines 511-577 -- exact. HttpKbProvider.prime --
     off by one (finding 4).
   - .gitnexus/meta.json stats {380/4051/10976/214/300/0} and vectorSearch
     exact-scan/unavailable -- exact.
   - logError confirmed in src/utils/log-helpers.ts (via code_query).
   - tests/time-utils.test.ts, tests/knowledge/kb-session-prime.test.ts,
     tests/fleet-status-code-intelligence.test.ts,
     src/services/knowledge/kb-providers.ts all exist.
   - KB CONFIRMED entries corroborate the callGitNexus resilience/freshness
     claims, the freshness-module circular-import rule, the check-status
     degraded-safe pattern, and both KB constraints copied verbatim into the
     plan. A doer with only PLAN.md + repo can execute each task.

6. Repo rules -- PASS. ASCII-only stated sprint-wide and per task; "never
   push main" and "NO PR" in every VERIFY task and sprint constraints,
   consistent with standing user rules (no PR until asked, no merges).

7. Ambiguity resolutions -- 3 of 5 explicit, 2 partial (findings 1-2):
   - P4b at tool-wrapper layer: reflected (T1.3 "do NOT modify
     SqliteProvider.prime or HttpKbProvider.prime -- the join lives one
     layer up"); reasonable -- works for both project providers, including
     the HTTP provider whose prime executes remotely.
   - P4a exact symbol match: reflected (T3.3 "exact match on the symbols
     field"); reasonable -- query-then-filter-exact handles FTS looseness.
   - Telemetry tie behavior: NOT stated in task text (finding 1).
   - Suffix only on newly-started reindex: reflected (T3.2 "When
     maybeScheduleReindex returned true ... exact suffix"; done criterion
     "suffix only when scheduled"); reasonable.
   - FTS sensitivity note: behaviorally covered by try/catch graceful skip
     in T1.3/T3.3 but not called out (finding 2).

## Summary

APPROVED. 0 HIGH, 0 MEDIUM, 4 LOW. The LOW items are one-line clarifications
the planner may fold in at dispatch time; none requires a plan revision
cycle.
