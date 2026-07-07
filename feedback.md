# Phase 2 Review -- KB Trust-Ops Sprint (epic yashr-bp2)

Reviewer: pm-reviewer. Target: Phase 2 (T2.1-T2.4 + VERIFY T2.5) on branch
feat/code-intelligence-abstraction. Commits reviewed: cfdd287 (T2.1 kb_stats),
5b7b4d1 (T2.2 fleet_status KB health), 1097428 (T2.3 auto-commit -- UPGRADED),
e9f54b4 (T2.4 version handshake). Checked against requirements.md (F5, F6 as
amended -- F6a auto-commit per user directive 2026-07-07), design.md (D4, D5
AMENDED "Bible auto-commit at harvest", D6), and progress.json. The critical
item (T2.3 auto-commit) was exercised LIVE against real temp git repos through
the real kbExport code path, not merely read from the shipped tests.

## VERDICT: APPROVED

0 HIGH, 0 MEDIUM, 3 LOW. Every Phase 2 acceptance point holds: kb_stats is a
telemetry-free aggregation read, fleet_status KB health + version handshake are
degraded-safe, and the D5 auto-commit is pathspec-only, correctly identified,
content-gated, non-fatal, config-gated, and injection-safe. Build clean; tests
green except the exact allowed failures (2 timezone yashr-302 + 4 kb-session-
prime real-KB leaks yashr-bwc).

## T2.3 auto-commit -- LIVE experiment (the critical item, D5 amended is binding)

Independent vitest experiment written by the reviewer, importing the real
kbExport (src/tools/kb-export.ts) with getKbProviders stubbed to an in-memory
SqliteProvider, driving genuine `git init` temp repos. All checks passed:

- (a) PATHSPEC-ONLY -- PASS. Seeded a repo, staged an unrelated NEW file
  (staged.txt) and left a tracked file dirty (tracked.txt). After export:
  `git show --stat HEAD` contained ONLY .fleet/kb-canonical.json; staged.txt
  REMAINED staged (A staged.txt), tracked.txt stayed unstaged-dirty
  (space-M tracked.txt). The `git add <bible>` + `git commit ... -- <bible>`
  pathspec never swept in unrelated index/worktree state.
- (b) IDENTITY -- PASS. Commit author is pm-kb <kb@pm.local> (via
  `-c user.name=pm-kb -c user.email=kb@pm.local`), not the caller's identity.
- (c) CONTENT-UNCHANGED -> NO NEW COMMIT -- PASS. First export committed
  (committed:true); immediate re-export returned committed:false and the log
  stayed at exactly one commit. `git status --porcelain -- <bible>` correctly
  gates on real change (and detects the first-export untracked case).
- (d) GIT FAILURE -> EXPORT STILL SUCCEEDS -- PASS. (d) Non-git dir (.git
  removed): export returned exported:1, committed:false, bible written, no throw.
  (d2) Broken .git file: export succeeded and logWarn('kb-export', ...) fired
  the non-fatal warning. Failure is caught and logged; export return value is
  produced before the commit attempt.
- (e) autoCommit:false -> NO GIT INVOCATION -- PASS. With
  FLEET_DIR/knowledge/config.json {bible:{autoCommit:false}}, committed:false
  and no commit was ever created (`git log` throws -- empty repo). Config
  default TRUE; missing/malformed config degrades to TRUE (verified in code).
- COMMAND-INJECTION SURFACE -- SAFE. All git calls use execFileSync (argv, no
  shell). The commit message embeds only the numeric entry count + fixed text;
  paths are argv args. A KB entry titled with `; rm -rf /` + backtick / $()
  payloads produced the exact fixed subject "chore(kb): update knowledge bible
  -- 1 confirmed entries", no pwned file, repo intact. Nothing user-controlled
  is shell-interpolated.

## T2.1 kb_stats (F5, D4/D5)

- No use_count bumps: CONFIRMED. SqliteProvider.stats() is pure SELECT/COUNT/
  GROUP BY -- no UPDATE. The tool's bible section calls provider.list(), which
  (sqlite-provider.ts:757-797) is also a pure SELECT with no telemetry write.
  Zero side effects across the whole stats path.
- Drift semantics per D5: CORRECT. Absent/unreadable/malformed/non-array bible
  -> present=false and drift = ALL live CONFIRMED (fallback set before the file
  read, hoisted outside the parse try so a JSON.parse throw cannot lose it).
  Present+parsed -> drift = count of live-CONFIRMED whose (promoted_at||
  created_at) > bible's newest updated_at.
- Coverage: EXACT-symbol match via json_each(symbols) WHERE value = ? scoped
  to CONFIRMED + live; substring near-misses correctly excluded.
- Null denominators: hit_rate null when totalLive=0; promote_ratio null when
  CONFIRMED=0. No 0/NaN leakage.
- HttpKbProvider.stats(): returns a shape-complete supported:false object with
  no network call -- never throws.

## T2.2 fleet_status KB health (F5/F6, D5 amended)

- Degraded-safe: kbHealthSummary() try/catch -> null on any failure (reject or
  bad JSON); fleetStatus() adds a belt-and-suspenders outer try/catch. On error
  the compact line and JSON key are both omitted; fleet_status still returns.
- Anomaly wording matches amended D5 verbatim: "bible: N promotions behind
  (auto-commit may have failed -- run apra-fleet kb commit)", appended only when
  drift>0. hit-rate/promote-ratio render n/a (not 0%/NaN) on null denominators.

## T2.4 version handshake (F7, D6)

- Mismatch warning correct: compact "server running vX, disk has vY -- restart
  your MCP client" + JSON versionMismatch field, only on true mismatch. Dev
  git-hash suffix (_abcdef) stripped from the running side before compare.
- Disk-read failure -> null -> both omitted (missing file, malformed JSON,
  non-string version, SEA asset unavailable); never throws.
- Perf: readDiskVersion does a FRESH read each call (correct -- caching would
  defeat the "rebuilt-but-not-restarted" detection), but it is cheap: a capped
  5-level walk of existsSync + one small readFile + JSON.parse. No meaningful
  per-call cost on fleet_status.

## Cross-cutting

- Amended-D5 deviation recorded: progress.json T2.3 note documents the upgrade
  from docs-only to code (auto-commit inside kb_export) per user directive
  2026-07-07, and the deliberate non-touch of SKILL.md's manual-commit bullet.
- tpl-kb-agent.md tool-commits-not-agent nuance: CORRECT and explicit. Role
  section, Step 6b checklist, Step 8 report line, and Rules section all carve
  out that the commit is the export TOOL's code (identity pm-kb), not agent
  discretion, so the "no git operations" rule is not violated.
- ASCII: all Phase 2 new/changed lines are ASCII-clean. The only non-ASCII bytes
  in the touched files (check-status.ts lines 485/489/577) are pre-existing
  (git-blamed to commits 1970ced and 1ab19a5 by other authors), outside every
  Phase 2 hunk.
- Build + tests: npm run build clean; full npx vitest run = 1936 passed,
  6 failed, 14 skipped -- the 6 are exactly the allowed set (2 time-utils
  yashr-302 + 4 kb-session-prime graph-neighbor yashr-bwc). No regression.

## Findings

LOW-1 (dangling command reference). The amended-D5 anomaly message points the
user to `apra-fleet kb commit`, but no such subcommand exists -- the kb group
implements only directives / approve-directive / reject-directive / add-directive
(src/cli/kb-directives.ts). The wording is verbatim-faithful to binding D5 (so
this is NOT a spec deviation), but a user hitting nonzero drift is told to run a
command that will error. Recommend either adding a `kb commit` command in a later
task or rewording to a real remediation (re-run kb_export / inspect the logged
warning). Non-blocking.

LOW-2 (http-project edge, theoretical). kb_stats's bible section calls
providers.project.list(); HttpKbProvider has no list(). If the PROJECT provider
were ever an HttpKbProvider, that call would throw and bible would degrade to
{present:false, drift:0} rather than "all live CONFIRMED". Unreachable in normal
operation (providers.project is always the local SqliteProvider; HTTP is the sync
peer), so cosmetic only.

LOW-3 (informational, carried from Phase 1). The 4 kb-session-prime graph-
neighbor failures (yashr-bwc) are an environmental real-KB leak (unmocked
process.cwd() reading this repo's own .fleet/kb-canonical.json), not a Phase 2
regression -- confirmed unchanged by any T2.x work. Already tracked.
