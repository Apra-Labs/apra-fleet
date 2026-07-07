# Phase 2 Code Review -- KB Branch Reconcile Sprint (epic yashr-ii1)

Reviewer: pm-reviewer. Reviewing Phase 2 (T2.1-T2.3) of the
kb-branch-reconcile sprint against PLAN.md (revision 3, T2.1-T2.3 +
R4/LOW-2), requirements.md (F4), and design.md (D3 with PROVENANCE
HARDENING + TRUST BOUNDARY). Commits reviewed: 20c86b3 (T2.1 kb_import +
provider support), 8f26099 (T2.2 CLI subcommand). Prior review verdicts
(plan Rounds 1-3, Phase 1) are preserved in this file's git history. This
was a SECURITY-CRITICAL review: the import trust surface was attacked
directly against the COMPILED dist, not only through the shipped tests.

## VERDICT: APPROVED

0 HIGH, 1 MEDIUM, 1 LOW. The import trust surface -- the load-bearing
security concern of this phase -- is airtight. Every attack in the review
brief was reproduced live against dist and defended correctly. The MEDIUM
(cwd anchoring under concurrency) and LOW (post-import sweep semantics) are
robustness / design-text-accuracy findings, not trust-surface holes, and
neither blocks Phase 2; both have a natural home in Phase 3 (T3.1 next
touches the same provider). Build clean (tsc exit 0). Full suite: 2026
passed / 14 skipped / 0 failed (run by this reviewer).

---

## Verification performed

- npm run build: clean (exit 0, tsc).
- npm test (this reviewer's own run): 139 test files, 2026 passed / 14
  skipped / 0 FAILED. Zero-failure criterion holds.
- LIVE ATTACK against compiled dist (dist/services/knowledge/
  sqlite-provider.js + dist/tools/kb-capture.js), 15 assertions, ALL PASS.
  The script exercised the real compiled SqliteProvider.capture and the real
  kbCaptureSchema, not the test doubles.
- ASCII: no non-ASCII byte on any line ADDED by 20c86b3 / 8f26099. The
  pre-existing non-ASCII in src/index.ts (em dashes + arrows in unrelated
  banners/tool descriptions) is present on main and untouched by this phase
  -- correct per no-mass-migration. The T3.4 ASCII sweep must verify by
  CHANGED-HUNK bytes, not whole-file grep, or it will false-positive here.

## Attack results (review brief items 1-4)

### 1. R4 unreachability -- AIRTIGHT (live-proven)

- 1(a) HTTP-shaped one-arg capture with source='import' + CONFIRMED:
  clamped to INFERRED AND source scrubbed to 'unknown'. source='promotion'
  likewise scrubbed. Verified live on the compiled provider.
- 1(b) MCP kb_capture zod path: kbCaptureSchema.safeParse of a body carrying
  importMode/preferredId/source drops all three -- parsed keys were
  {type,title,summary,content,role,confidence} only. z.object strips unknown
  keys, and independently the handler (kb-capture.ts:118) builds the input
  from named fields and derives `source` server-side, so even a
  non-stripping parser could not reach capture()'s opts.
- 1(c) CaptureOpts exists ONLY as SqliteProvider.capture's second param
  (types.ts CaptureOpts). Both deserialized routes pass exactly one
  argument: kb-server.ts:139 `provider.capture(input)` and kb-capture.ts:118
  `target.capture({...})`. No MCP/HTTP handler passes a second argument. The
  ordering -- directive gate (622) -> provenance normalization (664) ->
  clamp (680), gated on `!opts?.importMode` where relevant -- is correct.

### 2. Directive quarantine -- WORKS (live-proven)

A type='user-directive' bible entry at CONFIRMED, imported under import
mode, lands UNVERIFIED + flagged_for_review=1 + tag 'directive:pending';
promote() refuses to lift it (stays UNVERIFIED); default retrieval does not
surface it. The directive gate runs BEFORE and independently of import mode,
so import cannot smuggle an active directive.

### 3. Import trust order -- CORRECT (live-proven)

A non-directive CONFIRMED bible entry imports as CONFIRMED source='import'
(the sole intended exemption), while the identical payload through plain
one-arg capture() clamps to INFERRED. The gate->normalize->clamp ORDER
cannot be exploited by a directive+import combination: a directive at
CONFIRMED WITH source='import' AND importMode=true STILL lands UNVERIFIED +
flagged + directive:pending. The gate is unconditional; the exemption only
skips the general clamp for non-directive types.

### 4. Idempotency / id-hijack -- CORRECT (live-proven + code-read)

hasEntry(id) checks ALL rows (superseded/stale included) with no use_count
bump and is the FIRST per-entry gate (kb-import.ts:144), before capture(). A
bible entry whose id equals an EXISTING unrelated entry is SKIPPED, not
overwritten: seeded a row under a fixed id, confirmed hasEntry true, content
unchanged. preferredId is consumed only on the pure 'add' path
(sqlite-provider.ts:707) where the id is already proven free; AUDN
update/flagged branches always mint a fresh randomUUID, so no id collision
can overwrite an existing entry. Suite TEST 3 additionally proves a
symbol-less/file-less entry (AUDN can never dedupe it) is carried by the
id-skip, and re-import reports imported=0 with row count unchanged.

## Item 5 -- sweep semantics deviation (KEY JUDGMENT) -- ACCEPTABLE, rated LOW

The recorded deviation is accurate and honestly stated. capture() computes
source_file_hashes from the CURRENT worktree (computeSourceFileHashes), and
the bible field set carries NO per-file hashes, so a freshly imported entry
matches the worktree it was imported on BY CONSTRUCTION. The post-import
freshnessSweep therefore NEVER stales a fresh import -- the D3 sentence
"imported entries whose basis does not match this worktree are immediately
staled" describes an unreachable branch for fresh imports. The sweep's real
post-import value is re-evaluating PRE-EXISTING entries against the merged
worktree (staling branch-A entries whose files the merge changed, reviving
matches).

Judgment: ACCEPTABLE within the reconcile flow. Import runs ON the merged
worktree, so basis=current is the only sensible basis -- the bible has no
hashes to preserve, and the entry genuinely describes the merged code as of
import. This is the same hash-basis staleness model every capture() already
uses; it is not a new hole. Contradiction arbitration is the prefilter's job
(T3.1), not the sweep's. Rated LOW because it is a design-text vs behavior
mismatch, not a code defect; the code does the only correct thing.

What T3.3's e2e MUST prove (and MUST NOT claim): a B-side imported entry
ALWAYS matches the merged worktree immediately (its basis was computed from
it), so the prefilter's "exactly one side matches" mechanically confirms B
ONLY when the merge took B's version (A's original basis then mismatches),
and SAFELY DEFERS to the agent when the merge took A's version (both sides
match). T3.3 must exercise the contradiction chain with these asymmetric
bases and must NOT assert the post-import sweep stales a freshly imported
entry. kb-import.test.ts TEST 6 already frames this correctly (it stales a
PRE-EXISTING branch-A entry and asserts the imported entry stays fresh).

## Item 6 -- cwd anchoring (LOW-1) -- NOT concurrency-safe, rated MEDIUM

sweepAnchored() (kb-import.ts:200) does `process.chdir(repoAnchor)` before
`await freshnessSweep()` and restores prevCwd in a finally. The chdir is
functionally NECESSARY: imported entries store repo-relative basis paths and
freshnessSweep -> computeFileHashBatch resolves relatives against
process.cwd() (file-hash.ts:49 fs.existsSync + `git hash-object <relpath>`).

But process.chdir mutates PROCESS-GLOBAL state, and freshnessSweep awaits
`git hash-object` via execFileAsync -- it yields the event loop for the whole
hashing window. In the long-lived MCP/KB server process, a concurrent tool
call that reads process.cwd() during that window would resolve the wrong
repo: the HTTP /api/kb/capture route hashing its own relative source_files
(a WRONG-basis write, silent data corruption), another kb_import, or
kb_export/resolveRepoPath falling back to cwd. It is not safe under
concurrent async tool calls in one server process.

Rating: MEDIUM, non-blocking for Phase 2. Real-world exposure is low --
kb_import is a manual post-merge command, unlikely to overlap a concurrent
KB write -- and the author documented it as an accepted tradeoff. But the
"safe under concurrency" question is honestly answered NO. The clean fix is
to thread a root/baseDir option into freshnessSweep() /
computeFileHashBatch() (git -C <root> or path.resolve(root, p)) and drop the
global chdir entirely. T3.1 next edits sqlite-provider.ts (freshnessSweep's
home) -- the natural place to land it. Recommend scheduling before sprint
close; not a gate on Phase 2.

## Numbered findings

- MEDIUM-1 (item 6): kb_import's chdir-based sweep anchoring is not
  concurrency-safe (process-global cwd mutation across an await that yields
  during git hashing). Non-blocking; fix by passing an explicit root into
  freshnessSweep/computeFileHashBatch.
- LOW-1 (item 5): D3's "imported entries ... immediately staled" is an
  unreachable branch for fresh imports (basis=current at capture, bible
  carries no hashes). Behavior is correct and honestly recorded; the design
  text overstates it. T3.3 obligations stated above.

## What is correct and load-bearing

- CaptureOpts is a non-deserializable second parameter; both routes pass one
  argument; zod strips unknown keys. R4 closed, live-verified.
- Provenance normalization (MEDIUM-4): 'import'/'promotion' from a
  deserialized body are rewritten to 'unknown' unless import mode is engaged;
  source='import' survives only under the internal flag.
- Directive gate is unconditional and ordered before the exemption; import
  cannot mint or smuggle an active directive; activation stays CLI-only.
- id-first idempotency via hasEntry() (all rows, no telemetry bump);
  preferredId only on the free 'add' path; no id can overwrite an existing
  entry.
- CLI (T2.2) is a thin wrapper over the same kbImport (no logic dup), prints
  an ASCII report, exits 1 on resolution failure, carries the LOW-1 trust
  line in help. Tests cover happy + missing-bible + malformed-JSON + exit
  codes.
- Report shape {imported, skipped, superseded, flagged, sweep:{checked,
  staled, unstaled}} matches the plan.
