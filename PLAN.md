# PLAN -- KB Branch Reconcile Sprint (epic yashr-ii1)

Branch: feat/code-intelligence-abstraction (base: main). All work lands on this
branch. NEVER push to main. NO PR -- the user raises PRs. Requirements:
requirements.md (F1-F6, phases P1/P2/P3). Binding decisions: design.md D1-D6
AS HARDENED at commit a1d344d (D2 four-actor predicate, D3 provenance
normalization + trust boundary, D4 resolveContradiction + flaggedPairs
liveness), including the shared-file sequencing rule (sqlite-provider.ts).
Deviations need a recorded reason in progress.json notes.

REVISION 2: folds in plan-review feedback.md at commit 91b2a2c (CHANGES
NEEDED: 1 HIGH, 4 MEDIUM, 2 LOW). Structure, models, ordering, and
resolutions R1-R6 are unchanged (R4 confirmed airtight by the reviewer);
the findings land as: HIGH-1 -> T3.1/T3.2/T3.3 (resolveContradiction),
MEDIUM-1/2 -> T1.3 (predicate conjuncts + tests), MEDIUM-3 -> T3.1
(flaggedPairs liveness), MEDIUM-4 -> T2.1 (source normalization), LOW-1 ->
T2.1/T3.2 (trust-boundary wording), LOW-2 -> T2.1 (id-skip before AUDN +
deterministic content synthesis). New resolution R7 records the
resolveContradiction tool surface.

REVISION 3: folds in re-review feedback.md at commit 52ef4fe (0 HIGH,
2 MEDIUM, 1 LOW; all Round 1 findings verified fixed, R7 war-gamed). Two
surgical T3.1(b) edits -- pair-linkage refusal (MEDIUM-1 R2) and winner-path
flag-clear-BEFORE-predicate ordering + old-side flagged winner test
(MEDIUM-2 R2) -- plus the LOW-1 R2 marker-anchoring note in T1.3.

Risk order per design Phasing: F1 (test isolation) is the FIRST task of the
sprint; from the task after it onward, every VERIFY requires ZERO test
failures -- the allowed-failure list is retired permanently. Then F3 (clamp
relocation -- the same capture() choke point F4 needs), then F2 (bidirectional
staleness). P2 is F4 (kb_import). P3 is F5 (prefilter + reconciler template +
PM command/docs), F6 (e2e), final VERIFY.

## Planning context (KB coverage)

kb_session_prime returned session_warm with zero top_entries (live server
predates recent retrieval work; hyphenated FTS queries error with "no such
column" -- fallback was plain-word kb_query, and that quirk is now captured as
KB 49ce4c31). Per-topic queries retrieved 12 live entries that replaced
essentially all exploratory reads:

- 9462ab04 (CONFIRMED) "HTTP /api/kb/capture bypasses general confidence
  clamp (yasyr-f3g)" -> T1.2 is a direct execution of this entry's
  recommendation; exact clamp location kb-capture.ts:97-101, HTTP route
  src/commands/kb-server.ts:133-141, directive gate already in capture()
  (sqlite-provider.ts:450-462).
- cf0ce11e + 61770438 (CONFIRMED) clamp history and the directive-exemption
  mechanics -> T1.2/T2.1 (promote is sole CONFIRMED path; exemption shape).
- 8de251dc (CONFIRMED) "DIRECTIVE GATE CLOSED: proposal-only via capture()
  choke point" -> T2.1 directive quarantine reuses this exact gate (forced
  UNVERIFIED + flagged_for_review + tag 'directive:pending' + scope forced
  'project'; activation CLI-only via apra-fleet kb approve-directive).
- d1c6f758 (CONFIRMED) "Auto-staleness at prime via checkFreshness (T2.2)"
  -> T1.3 (basis storage format source_file_hashes JSON map, empty-basis
  safety, computeFileHashBatch single-batch pattern, try/catch non-fatal
  contract at prime).
- 4b87fbce (CONFIRMED) kb_feedback mechanics -> T1.3's exclusion tests
  (feedback sets stale=1 AND flagged_for_review=1 with a "[feedback ...]"
  content note; active directives flagged-only).
- b9df569a + f173d00a (CONFIRMED) kb_export + cold-seed + global bible chain
  -> T2.1 (bible field set {id, type, title, summary, symbols, source_files,
  confidence, updated_at}, asciiSafeStringify, COLD_KB_MAX=3, cold-seed is
  OUTPUT-ONLY and never writes the DB -- kb_import is the missing write path).
- 34b9b7a6 (CONFIRMED) kb_export auto-commit (pathspec-only, pm-kb identity,
  content-gated, non-fatal, injection-safe) -> T3.2 (reconcile flow ends with
  kb_export; no new commit machinery needed).
- d5193cb9 (CONFIRMED) resolveRepoPath precedence (explicit > validated cwd >
  refuse/skip; kb-export throws, kb-session-prime returns null) -> T2.1
  (kb_import path resolution) and T1.1 (the tests leak via unmocked cwd).
- c5a129ed (CONFIRMED) "kb-session-prime graph-neighbor test failures are
  environmental (yashr-bwc)" -> T1.1 (root cause: unmocked process.cwd()
  reads this repo's real .fleet/kb-canonical.json).
- a2781b82 (CONFIRMED) flagged-pipeline e2e stages -> T3.1/T3.3 (promote does
  NOT clear flagged_for_review or contradiction_of -- reviewer re-verified;
  resolution needs its own write path, see HIGH-1/D4).
- 989d00c3 (INFERRED) module-singleton vitest pattern -> all test tasks.

In-flight planning captures (tags sprint:kb-branch-reconcile, phase:0):
d036ab13 (CaptureSource lacks 'import', verified types.ts:20), 49ce4c31
(FTS hyphen quirk), 81dbaee9 (clamp relocation will break CONFIRMED-seeding
test fixtures -- migration options recorded).

Plan-review facts folded in (feedback.md 91b2a2c, verified against source by
the reviewer): AUDN's contradiction branch inserts the NEW entry with
newEntryOverrides {confidence:'UNVERIFIED', contradiction_of,
flagged_for_review:false} -- the flag lands on the OLD side only; invalidate()
is a FOURTH stale actor (content_hash='invalidated', stale=1, flagged=0,
superseded NULL, basis untouched); kb_export exports via
list({confidence:'CONFIRMED'}) which hard-filters superseded_at IS NULL AND
stale=0 (kb-export.ts:173, sqlite-provider.ts:775); the HTTP route parses the
body as KBEntryInput and insertEntry persists input.source verbatim.

Coverage judgment: the choke point, directive gate, freshness basis, bible
format, and auto-commit are densely covered by CONFIRMED entries with line
numbers -> those tasks run on claude-sonnet-4-6 or claude-haiku-4-5. The two
places where reasoning risk concentrates are (a) the F2 un-stale predicate
(FOUR actors set stale=1 and only one population may revive) and (b) the F4
import-mode trust semantics (a controlled clamp exemption that must be
unreachable from HTTP) -> claude-opus-4-8 for T1.3 and T2.1.

## Sprint-wide constraints (apply to every task)

- ASCII only: never write non-ASCII characters to any file. Use "-" for
  dashes, "->" for arrows, "[OK]" for checkmarks.
- Pre-commit ASCII hook gotcha (copy into your head before writing strings):
  the hook false-positives on backtick-n/t/r escape sequences inside template
  literals -- when a string needs literal "\n"/"\t"/"\r" text next to
  backticks, use string concatenation instead of template literals.
- Never push to main. NO PR -- the user raises PRs. Push only the sprint
  branch feat/code-intelligence-abstraction.
- Commit style: type(scope): description. Commit after each task.
- Test pattern for module-level singletons: vi.hoisted mock refs at top of
  file, vi.mock factories referencing them, then per-test vi.resetModules() +
  vi.clearAllMocks() + dynamic import so each test gets fresh module state
  while sharing mock call counts (KB 989d00c3, tests/code-intelligence.test.ts
  shows the shape).
- From T1.2 onward, "npm test green" means ZERO failures. There is no
  allowed-failure list anywhere in this sprint after T1.1 lands.
- No mass migration; forward-only schema/data changes.

## Shared-file sequencing (binding, design Phasing)

src/services/knowledge/sqlite-provider.ts is modified by four tasks. They MUST
land strictly in this order, one at a time, never in parallel:

1. T1.2 (F3): clamp added to capture()
2. T1.3 (F2): checkFreshness extended + freshnessSweep() added
3. T2.1 (F4): import mode + source normalization threaded through capture()
4. T3.1 (D4): flaggedPairs() + resolveContradiction() + prefilter added

Also: src/tools/kb-capture.ts is touched only by T1.2;
tests/kb-session-prime.test.ts by T1.1 then T1.3 (new sweep tests);
src/tools/kb-export.ts is NOT modified this sprint (the reconcile flow merely
invokes it); src/index.ts gains registrations in T1.3, T2.1, T2.2, T3.1 --
sequential anyway under the ordering above.

---

## Phase P1 -- Hygiene + trust + staleness core

### T1.1 -- F1: Zero the allowed-failure list (test isolation + TZ)

- id: T1.1
- model: claude-sonnet-4-6
- design: D1; beads yashr-bwc, yashr-302

Description. Two suites currently carry allowed failures; fix both so the
sprint runs at zero failures from here on.

(a) tests/kb-session-prime.test.ts -- 4 leaking tests in the
graph-neighbor/cold-seed blocks read the machine's REAL KB and this repo's
real .fleet/kb-canonical.json because resolveRepoPath falls through to an
unmocked process.cwd() (KB c5a129ed). Isolate every test that touches the
cold-seed/graph-neighbor paths: run against a temp-dir KB and a mocked or
injected repo root -- either mock resolveRepoPath / process.cwd() per test or
pass an explicit repo param pointing at a temp fixture dir. No test may
resolve the developer's real cwd repo or ~/.apra-fleet data. Use the
vi.hoisted + vi.mock + per-test vi.resetModules() + dynamic import pattern
(sprint-wide constraints). Do not weaken what the tests assert: the
cold-seed hard-skip contract, COLD_KB_MAX=3 threshold, dedupe-by-id, and
via:'canonical-bible' marking must still be asserted, just against fixtures.

(b) tests/time-utils.test.ts -- 2 timezone-dependent assertions fail off the
author's zone. Make them TZ-independent: construct dates from fixed epochs
with explicit offset expectations, or force a fixed zone (vi.stubEnv('TZ',...)
where the implementation reads it). Do not weaken the assertions -- they must
still pin the same formatting/arithmetic behavior, only expressed
zone-independently.

Then delete/empty the allowed-failure list wherever it is recorded
(progress.json notes and any test-runner config), so nothing downstream can
lean on it.

Done criteria:
- npm test: the 4 kb-session-prime tests and 2 time-utils tests pass, and the
  FULL suite passes with zero failures on this machine.
- Proof of isolation: temporarily rename .fleet/kb-canonical.json (or run
  with a scratch cwd) and show the kb-session-prime suite still passes;
  restore afterward. State the result in the commit message body.
- No test reads ~/.apra-fleet or the real repo bible; no assertion weakened.
- Allowed-failure list is EMPTY and removed from wherever it lived.

### T1.2 -- F3: Relocate the general confidence clamp into capture()

- id: T1.2
- model: claude-sonnet-4-6
- design: D-context (design.md "Relevant code"), bead yashr-f3g; KB 9462ab04

Description. The general CONFIRMED->INFERRED clamp lives in the kb_capture
tool handler (src/tools/kb-capture.ts:97-101). The HTTP /api/kb/capture route
(src/commands/kb-server.ts:133-141) calls provider.capture() directly and can
mint CONFIRMED for non-directive types. Fix per F3: move/duplicate the clamp
into SqliteProvider.capture() (src/services/knowledge/sqlite-provider.ts),
the same choke point where the directive proposal gate already lives
(sqlite-provider.ts:450-462), so EVERY route is covered.

Implementation notes:
- In capture(): for non-directive types with requested confidence CONFIRMED,
  clamp to INFERRED and append a bracketed note to content (mirror the
  handler's wording); directives are already handled by the existing gate
  (forced UNVERIFIED proposal) BEFORE this clamp -- keep that ordering.
- Keep the handler-level clamp in kb-capture.ts so the tool still returns
  confidence_clamped:true to MCP callers (F3 says move/duplicate; duplicating
  preserves the user-facing flag with zero API change). The provider clamp is
  the enforcement; the handler clamp is UX.
- Exemptions at the provider level after this task: NONE except paths that do
  not go through capture() at all (promote(), approveDirective/addDirective
  CLI-only). T2.1 adds the sole capture()-level exemption (import mode) plus
  source normalization; do NOT pre-build them here, but leave the clamp as a
  single well-named private method or clearly-commented block so T2.1 can
  thread a flag through.
- Expected fallout (KB 81dbaee9): test fixtures that seed CONFIRMED entries
  via direct provider.capture() (kb-export tests, flagged-pipeline, promote
  tests) will now be clamped. Migrate those fixtures to capture-then-promote
  (the real ladder) or direct sqlite INSERT for pure fixtures. Never add a
  test-only bypass flag to production code and never weaken assertions.

Fail-then-pass test (REQUIRED, provider level): a test that calls
provider.capture() directly (as the HTTP route does) with type='learning',
confidence='CONFIRMED' and asserts the stored row is INFERRED. Commit history
or test output must show this test failing against the pre-change provider
(red) and passing after (green) -- e.g. write the test first, run it, then
implement. Also assert: directive inputs still become UNVERIFIED pending
proposals (gate unchanged), and promote() still mints CONFIRMED.

Done criteria:
- Fail-then-pass evidence recorded (test-first commit or output transcript in
  the commit body).
- npm run build clean; npm test ZERO failures (fixtures migrated).
- kb_capture MCP behavior unchanged from the caller's perspective
  (confidence_clamped flag still returned).

### T1.3 -- F2: Bidirectional staleness + freshnessSweep()

- id: T1.3
- model: claude-opus-4-8
- design: D2 (HARDENED a1d344d); bead yashr-mwd; KB d1c6f758, 4b87fbce;
  feedback.md MEDIUM-1, MEDIUM-2

Description. checkFreshness() (src/services/knowledge/sqlite-provider.ts,
called from prime, currently sets stale=1 only -- see KB d1c6f758 for the
basis mechanics: source_file_hashes JSON map column, computeFileHashBatch)
must become bidirectional, and a bounded full-KB sweep must exist for the
reconcile flow.

THE UN-STALE PREDICATE (binding, hardened D2 -- state it verbatim in a code
comment at the shared implementation site): un-stale ONLY entries where

    stale = 1
    AND superseded_at IS NULL
    AND flagged_for_review = 0
    AND content_hash != 'invalidated'
    AND content NOT LIKE '%[feedback %'
    AND the re-hash of their FULL stored basis matches current files

That is precisely the freshness-staled population. stale=1 is set by FOUR
actors -- freshness mismatch (prime), supersede (AUDN update, carries
superseded_at), feedback downvote (carries flagged_for_review=1 and a
"[feedback ...]" content note), and invalidate() (sets
content_hash='invalidated' on context-cache entries while leaving
flagged_for_review=0, superseded_at NULL, and the stored basis untouched --
the fourth actor, feedback.md MEDIUM-1) -- and only the first may revive.
The content-marker conjunct (MEDIUM-2) is the durable downvote record: a
feedback-downvoted entry must stay retired even if some later flow clears
its flagged_for_review bit (the T3.1 winner path clears flags; the
"[feedback " note is what survives). A superseded, downvoted, or invalidated
entry must stay retired even if its files match again.
MARKER ANCHORING (re-review LOW-1, 52ef4fe): implement the marker match
anchored to what feedback() actually writes -- it appends two newlines +
"[feedback " + ISO timestamp -- so match the newline-prefixed (or
timestamp-anchored) form rather than a bare substring. Otherwise an entry
whose content merely QUOTES the feedback note format (e.g. a learning ABOUT
the kb_feedback mechanism; such entries exist in this very KB) would, once
freshness-staled, be permanently excluded from revival. State the chosen
pattern in the predicate comment.

Two surfaces:
(a) Extend checkFreshness() to do both directions over the primed candidate
    set: mark stale=1 on basis mismatch (existing), clear stale=0 where the
    predicate holds (new). Keep the existing bounded single
    computeFileHashBatch call over the union of basis files, the empty-basis
    safety (never falsely stale, never falsely revive on empty/malformed
    basis), and the non-fatal try/catch contract at prime.
    CAVEAT (document in code + doc comment): prime's candidate set excludes
    stale entries by definition, so prime alone cannot revive a staled entry.
    The revival path is freshnessSweep, invoked by kb_import (T2.1) and
    /pm kb-reconcile (T3.2). Branch-switch revival requires a sweep, not just
    a prime. kb_stats stays read-only (D2: explicitly NOT wired there).
(b) New provider method freshnessSweep(): runs the same predicate in BOTH
    directions over ALL entries with a non-empty basis. Bounded: one
    computeFileHashBatch over the union of all basis files (KB is <1000
    entries; fine for an explicit command, NOT wired into prime). Returns
    {checked, staled, unstaled}. Share the predicate implementation between
    (a), (b), and T3.1's resolveContradiction winner path (which reuses it)
    -- one function, not copies.
    Expose it as MCP tool kb_freshness_sweep (thin handler, new
    src/tools/kb-freshness-sweep.ts, registered in src/index.ts) so the PM
    reconcile flow can invoke it standalone (resolution R2 below).

Tests (each exclusion tested individually, hardened D2):
1. Fail-then-pass core (REQUIRED): capture entry on state A with a real file
   basis; modify the file (state B) -> sweep/checkFreshness marks stale;
   restore the file byte-identical (state A) -> freshnessSweep un-stales it
   and a subsequent prime returns it. Show this red before the un-stale code
   exists, green after.
2. Superseded exclusion: entry with superseded_at set and matching basis
   stays stale=1 after sweep.
3. Feedback exclusion (flag standing): entry downvoted via feedback()
   (stale=1, flagged_for_review=1) with matching basis stays stale=1.
4. Downvote-marker exclusion (MEDIUM-2): entry carrying a "[feedback ..."
   content note whose flagged_for_review has been cleared (simulate the
   T3.1 flag-clear) with matching basis stays stale=1 after sweep.
5. Invalidated exclusion (MEDIUM-1): entry with content_hash='invalidated'
   (via invalidate()), flagged=0, superseded NULL, and matching basis stays
   stale=1 after sweep.
6. Partial-basis exclusion: entry whose basis has 2 files, only 1 matching ->
   NOT revived (FULL basis must match).
7. Empty/malformed basis: never staled, never revived, never counted beyond
   'checked' semantics you define (document the choice).
8. freshnessSweep return shape {checked, staled, unstaled} asserted.

Done criteria:
- Fail-then-pass evidence for test 1 recorded in the commit body.
- All eight test groups green; npm run build clean; npm test ZERO failures.
- Predicate (all six conjuncts) stated verbatim in a comment at the shared
  implementation site.
- kb_freshness_sweep registered and callable via MCP.

### T1.4 -- VERIFY Phase P1

- id: T1.4
- type: verify (no model)

Steps, in order:
1. npm run build -- must be clean.
2. npm test -- ZERO failures (the allowed-failure list died in T1.1).
3. npx gitnexus analyze -- non-fatal (warn and continue on error). GOTCHA
   (copy verbatim): gitnexus analyze injects non-ASCII into AGENTS.md /
   CLAUDE.md -- every VERIFY runs `git checkout -- AGENTS.md CLAUDE.md`
   right after analyze.
4. git push origin feat/code-intelligence-abstraction. Never push main.
   NO PR.

---

## Phase P2 -- Import

### T2.1 -- F4: kb_import -- trusted-channel import with directive quarantine

- id: T2.1
- model: claude-opus-4-8
- design: D3 (HARDENED a1d344d); KB 8de251dc, b9df569a, d5193cb9, d036ab13;
  feedback.md MEDIUM-4, LOW-1, LOW-2

Description. New tool src/tools/kb-import.ts + provider support. This is the
missing write path that lets a warm local KB absorb a merged-in bible (the
cold-seed in kb-session-prime is OUTPUT-ONLY and fires only under
COLD_KB_MAX=3; it never writes the DB -- do not touch it).

Input { path?, repo?, scope?: 'project' }. Resolve the bible file: explicit
path if given, else resolveRepoPath(repo)/.fleet/kb-canonical.json using the
established precedence (explicit > validated cwd > refuse -- throw like
kb-export, this is an explicit command; KB d5193cb9). Validate the path
resolves and the file parses BEFORE importing anything. Bible entry field
set is {id, type, title, summary, symbols, source_files, confidence,
updated_at} (KB b9df569a) -- NOTE: no content field; tolerate and skip
malformed entries individually.

ORDER OF OPERATIONS per entry (LOW-2 -- the id-skip runs BEFORE AUDN):
1. Id-exists check FIRST: if the bible id already exists in the KB, skip
   (count as skipped) WITHOUT calling capture()/AUDN. This is what makes
   re-import exact: AUDN dedupe needs symbol AND file overlap plus content
   equality (symbolsOverlap()/filesOverlap() return false on empty arrays),
   so a symbol-less or file-less bible entry can NEVER dedupe via AUDN and
   would re-add on every import if AUDN alone guarded idempotency.
2. Otherwise route through provider.capture() (the AUDN choke point) with
   the bible id as the preserved entry id, synthesizing content
   DETERMINISTICALLY from the bible fields (e.g. from summary) so the AUDN
   'none' content-equality path also works for id-collision-with-identical-
   content cases. On id collision with DIFFERENT content, let AUDN decide
   (update/flag) under a fresh id.

IMPORT MODE in capture():
(a) Preserves the entry's bible confidence for NON-directive types. This is
    the SOLE capture()-level exemption to the T1.2 clamp. Rationale (binding,
    D3): the bible is a git-reviewed, human-merged artifact -- the trusted
    channel; re-clamping would demote the entire team's CONFIRMED knowledge
    on every import. Stamp source='import' -- ADD 'import' to the
    CaptureSource union first (verified absent, types.ts:20, KB d036ab13).
    SECURITY (hard requirement, R4 -- reviewer-confirmed airtight): import
    mode MUST be an internal parameter of capture() (a separate opts
    argument), NEVER a field of the deserialized input object -- the HTTP
    route does `provider.capture(JSON.parse(body) as KBEntryInput)` with
    exactly one argument and the MCP handler builds the input from zod-parsed
    fields, so a second parameter is structurally unreachable from every
    deserialized route.
(b) PROVENANCE NORMALIZATION (MEDIUM-4, hardened D3): capture() must
    normalize the source field -- a caller-supplied source of 'import' (or
    'promotion') arriving via the deserialized input is OVERWRITTEN with a
    route-appropriate value (e.g. 'session' or 'unknown') unless the internal
    import mode is actually engaged. insertEntry currently persists
    input.source verbatim, so without this any HTTP caller could stamp forged
    trusted-channel provenance (clamped, but mislabeled -- audits and future
    logic keyed on source='import' would trust forged rows).
(c) FORCES type='user-directive' entries to pending proposals: the existing
    directive gate in capture() applies unchanged (forced UNVERIFIED +
    flagged_for_review + tag 'directive:pending' + scope 'project'; KB
    8de251dc) -- import mode must NOT bypass it; the gate runs BEFORE the
    exemption. A bible cannot smuggle an active directive; activation stays
    CLI-only (apra-fleet kb approve-directive). Same security property as
    cold-seed.

After the entry loop, call provider.freshnessSweep() (T1.3) so imported
entries whose basis does not match THIS worktree are immediately staled
rather than serving wrong-branch claims (D3). Return
{imported, skipped, superseded, flagged} plus the sweep's
{checked, staled, unstaled}.

Register as MCP tool kb_import in src/index.ts. TRUST BOUNDARY (LOW-1,
hardened D3 -- state it in the tool description, honestly): kb_import reads
a caller-named local file; a local caller with tool access could import a
hand-crafted bible. This is equivalent in power to the already-MCP-exposed
kb_promote surface (which walks any entry INFERRED->CONFIRMED one call at a
time), so import-from-path adds bulk convenience, not a new privilege class;
the "git-reviewed artifact" rationale only holds for the repo-resolved
.fleet/kb-canonical.json -- an explicit path is caller-asserted trust. The
unforgeable tier remains user-directives (CLI-gated; the gate runs before
the exemption either way). (CLI subcommand is T2.2.)

Tests (provider/tool level, temp KB + temp bible fixtures):
1. Non-directive CONFIRMED bible entry imports as CONFIRMED with
   source='import' (clamp exemption works) -- and the same payload through
   plain capture() (no import mode) is still clamped to INFERRED.
2. Directive-in-bible -> pending proposal (UNVERIFIED + flagged +
   directive:pending), NEVER active. Assert kb_query default retrieval does
   not surface it.
3. Idempotency: import same bible twice; second run reports imported=0,
   everything skipped; row count unchanged. Include a symbol-less/file-less
   bible entry in the fixture to prove the id-skip (not AUDN) carries
   idempotency for it (LOW-2).
4. Duplicate/refinement/contradiction routing: seeded local entry vs bible
   entry -> skipped / superseded / flagged respectively, counted in the
   report.
5. Id preservation: fresh import keeps bible ids; id collision with
   different content -> AUDN decision under a fresh id.
6. Post-import sweep: bible entry whose basis mismatches the current
   worktree ends stale=1 immediately after import.
7. HTTP-shape safety (extended per MEDIUM-4): an HTTP-shaped payload (plain
   capture(input), one argument) carrying confidence='CONFIRMED' AND
   source='import' (and any import-ish extra fields) is BOTH clamped to
   INFERRED AND has its source rewritten (not 'import'). Also cover
   source='promotion' rewrite.

Done criteria:
- All seven test groups green; npm run build clean; npm test ZERO failures.
- capture() diff shows import mode as a non-deserializable internal
  parameter; 'import' added to CaptureSource; source normalization applied
  when the internal mode is unset.
- Report shape {imported, skipped, superseded, flagged} exact.
- Tool description carries the LOW-1 trust-boundary statement.

### T2.2 -- F4: CLI subcommand `apra-fleet kb import`

- id: T2.2
- model: claude-haiku-4-5
- design: D3

Description. Mechanical wiring: add `apra-fleet kb import [--repo <path>]
[--path <file>]` following the existing CLI subcommand pattern in
src/cli/kb-directives.ts / kb-commit.ts (argv dispatch lives in
src/index.ts). The subcommand calls the same import function as the MCP tool
(share the implementation from T2.1; no logic duplication) and prints the
{imported, skipped, superseded, flagged} + sweep report in plain ASCII.
Non-zero exit code on resolution failure (missing bible/invalid repo). Update
the CLI help text; the --path flag's help line carries the same
caller-asserted-trust caveat as the tool description (LOW-1). This is the
post-merge entry point for humans.

Tests: one CLI-level test (or direct handler test following how
kb-directives.ts is tested) covering happy path + missing-bible error path.

Done criteria:
- `apra-fleet kb import` works against a temp repo fixture; help text lists
  it; npm run build clean; npm test ZERO failures.

### T2.3 -- VERIFY Phase P2

- id: T2.3
- type: verify (no model)

Steps, in order:
1. npm run build -- must be clean.
2. npm test -- ZERO failures.
3. npx gitnexus analyze -- non-fatal. GOTCHA (copy verbatim): gitnexus
   analyze injects non-ASCII into AGENTS.md / CLAUDE.md -- every VERIFY runs
   `git checkout -- AGENTS.md CLAUDE.md` right after analyze.
4. git push origin feat/code-intelligence-abstraction. Never push main.
   NO PR.

---

## Phase P3 -- Reconcile flow

### T3.1 -- F5 step 3: flaggedPairs() + resolveContradiction() + prefilter

- id: T3.1
- model: claude-sonnet-4-6
- design: D4 (HARDENED a1d344d); KB a2781b82; feedback.md 91b2a2c HIGH-1,
  MEDIUM-2, MEDIUM-3; re-review 52ef4fe MEDIUM-1, MEDIUM-2

Description. Last sqlite-provider.ts change of the sprint (after T2.1).
Three pieces: a pair reader, a dedicated resolution write path, and the
mechanical prefilter that drives it.

(a) New provider read flaggedPairs(): flagged entries joined to their
    contradiction_of counterpart. LIVENESS CONTRACT (MEDIUM-3, binding --
    state it in the method doc comment + test): pair membership requires
    ONLY superseded_at IS NULL on both sides -- stale members MUST be
    included. Do NOT reuse the codebase's default "live" filter
    (superseded_at IS NULL AND stale=0, as in list()/stats()/query()): the
    imported side of a pair is TYPICALLY stale after the post-import sweep,
    and the default filter would make flaggedPairs() return nothing and the
    prefilter silently no-op. Also note the pair ASYMMETRY (verified): AUDN's
    contradiction branch inserts the NEW entry with newEntryOverrides
    {confidence:'UNVERIFIED', contradiction_of, flagged_for_review:false} --
    flagged_for_review lives on the OLD side only; contradiction_of lives on
    the NEW side only. flaggedPairs() must join from either anchor and return
    true contradiction PAIRS (both rows exist, neither superseded) -- lone
    feedback-downvoted entries (flagged, no counterpart) are never returned.

(b) New provider method resolveContradiction(winnerId, loserId, evidence) --
    the SINGLE write path for ALL reconcile resolutions (prefilter here AND
    the reconciler agent in T3.2). NOT composed from promote()+feedback():
    promote() is a one-step ladder that cannot lift AUDN's UNVERIFIED
    contradiction-born entries to CONFIRMED, and it clears neither
    flagged_for_review nor contradiction_of (KB a2781b82). Semantics
    (binding, hardened D4 -- this is the HIGH-1 fix that makes F6
    satisfiable, because kb_export filters CONFIRMED + stale=0 +
    superseded_at IS NULL):
    - LINKAGE REFUSAL (re-review MEDIUM-1, binding): before writing
      ANYTHING, the method verifies the two ids form a GENUINE contradiction
      pair -- loser.contradiction_of === winner.id OR
      winner.contradiction_of === loser.id (the AUDN asymmetry means the
      pointer sits on either side depending on which side wins) -- AND both
      rows exist AND neither is superseded. Refuse otherwise, nothing
      written. Without this, any caller could mint CONFIRMED from any tier
      in ONE call and permanently retire an arbitrary entry -- the method
      reads both rows anyway (the directive refusal already requires it),
      so the check is nearly free and matches the sprint's refusal-tested
      choke-point standard.
    - WINNER (operations in THIS order -- re-review MEDIUM-2): (1) set
      confidence='CONFIRMED' directly (regardless of starting tier -- the
      merged code IS the verdict; reconcile is verdict-equivalent) with the
      evidence note appended to content; (2) clear the winner's flag fields
      FIRST: on whichever side each lives -- flagged_for_review=0 (old
      side) and contradiction_of cleared/annotated (new side) per the
      asymmetry in (a); define the exact column writes in the method;
      (3) THEN evaluate the D2 safe predicate (reuse T1.3's shared
      predicate function -- one implementation) and clear stale ONLY if it
      holds. The order matters: the predicate contains
      flagged_for_review=0, so evaluating it before the flag-clear would
      self-defeat for a flagged OLD-side winner (the branch-switch revival
      scenario this sprint exists for) -- it would end CONFIRMED but
      stale=1 and silently vanish from the bible. The durable exclusions
      ("[feedback " marker, content_hash='invalidated') are unaffected by
      the flag-clear, so an invalidated or feedback-downvoted winner still
      stays retired -- it wins the CONTRADICTION, not its reputation
      (MEDIUM-2 R1 preserved).
    - LOSER: superseded_at=now + stale=1 + flag cleared (retired with audit
      trail -- the existing loser invariant, which the reviewer verified
      safe: superseded_at is set alongside the flag-clear, so the loser can
      never satisfy the D2 predicate).
    - NEVER deletes anything.
    Expose as MCP tool kb_resolve_contradiction (thin handler,
    src/tools/kb-resolve-contradiction.ts, registered in src/index.ts) so
    the T3.2 reconciler agent uses the SAME write path (resolution R7).
    The tool refuses when either id is missing, when the ids are not a
    genuinely linked contradiction pair (above), or when the pair involves
    an ACTIVE user-directive (below).

(c) Prefilter (surface per R1: MCP tool kb_reconcile_prefilter in
    src/tools/kb-reconcile-prefilter.ts backed by a provider method
    reconcilePrefilter(), registered in src/index.ts). For each pair from
    flaggedPairs(), re-hash BOTH sides' full bases against the current
    worktree (one computeFileHashBatch over the union):
    - EXACTLY ONE side fully matches -> that side WINS mechanically:
      resolveContradiction(matchingId, otherId, "hash-basis match on merged
      worktree") -- verbatim evidence string.
    - Both match, both mismatch, or EITHER side has an empty/missing basis ->
      leave the pair untouched for the agent rung.
    - HARD EXCLUSION: pairs involving an ACTIVE user-directive
      (type='user-directive' AND confidence='CONFIRMED') are NEVER touched --
      no resolve, no supersede, no flag-clear; directives outrank mechanics
      and the flag stays for the human.
    Returns {pairs, resolved, left_for_agent, skipped_directive}.

Tests:
1. Win path end-state (HIGH-1): seed a pair where the winner is the
   UNVERIFIED, stale=1 contradiction-born imported side; prefilter resolves
   it; assert winner ends confidence='CONFIRMED', stale=0, flag fields
   cleared on the correct sides, evidence note present; loser ends
   superseded_at set + stale=1 + flag cleared; a subsequent
   list({confidence:'CONFIRMED'}) (the kb_export filter) INCLUDES the winner
   and excludes the loser.
2. Downvoted winner (MEDIUM-2): winner carries a "[feedback ..." note;
   after resolveContradiction it is CONFIRMED, flag-cleared, but STILL
   stale=1 (predicate blocked the un-stale), and a subsequent freshnessSweep
   does NOT revive it (T1.3 test 4 companion at the integration level).
3. Invalidated winner: content_hash='invalidated' winner stays stale=1.
4. flaggedPairs liveness (MEDIUM-3): pair with one stale member is returned
   and resolvable; superseded member excludes the pair; lone
   feedback-flagged entry (no counterpart) never returned.
5. Both-match and both-mismatch left alone; empty-basis left alone.
6. Directive pair untouched even when the hash says the other side wins;
   kb_resolve_contradiction refuses directive pairs directly too.
7. Old-side flagged winner (re-review MEDIUM-2): winner is the OLD side
   (flagged_for_review=1, stale=1, matching basis, no feedback/invalidated
   marker); after resolveContradiction it ends CONFIRMED + unflagged +
   stale=0 and PASSES the list({confidence:'CONFIRMED'}) export filter
   (proves the flag-clear-before-predicate order).
8. Linkage refusal (re-review MEDIUM-1): two existing but UNLINKED entries
   (neither's contradiction_of points at the other) -> refused, NOTHING
   written (confidence, stale, flags, superseded_at all unchanged on both
   rows). Also cover: missing id refused; linked-but-superseded member
   refused.

Done criteria:
- All test groups green; npm run build clean; npm test ZERO failures.
- flaggedPairs liveness contract stated in the doc comment; winner/loser
  column writes explicit in resolveContradiction; the linkage refusal and
  the flag-clear-before-predicate winner order both stated in the method
  doc comment; D2 predicate reused, not copied.
- kb_reconcile_prefilter AND kb_resolve_contradiction registered and
  callable; NEVER deletes anything.

### T3.2 -- F5 steps 1-5: /pm kb-reconcile command, reconciler template, docs

- id: T3.2
- model: claude-sonnet-4-6
- design: D5, D4 (HARDENED -- one write path), D3 (trust boundary);
  feedback.md HIGH-1, LOW-1

Description. Documentation + agent template for the post-merge flow. New
files: skills/pm/tpl-kb-reconciler.md (role template) and
skills/pm/kb-reconcile.md (PM flow doc); edits: skills/pm/SKILL.md (command
table row for /pm kb-reconcile + lifecycle mention) and the completion/
cleanup flow doc ("after merging branches, run /pm kb-reconcile") -- both a
standalone command AND the post-merge hook in the /pm cleanup completion
flow must be documented.

kb-reconcile.md documents the ladder in order:
1. kb_import the merged bible (T2.1; CLI or MCP). State the LOW-1 trust
   boundary honestly: importing the repo-resolved .fleet/kb-canonical.json
   is the git-reviewed trusted channel; an explicit --path bible is
   caller-asserted trust, equivalent in power to the existing kb_promote
   surface, and directives stay quarantined either way.
2. Freshness sweep via kb_freshness_sweep (T1.3) -- re-hash ALL entries with
   a stored basis against the merged worktree; un-stale matches, stale
   mismatches. Note: import already runs a sweep; the explicit step covers
   the reconcile-without-import path and is idempotent. (No post-prefilter
   sweep is needed: resolveContradiction sets the winner's end state itself,
   including the predicate-guarded un-stale -- HIGH-1.)
3. Hash prefilter via kb_reconcile_prefilter (T3.1) -- mechanical wins
   through resolveContradiction.
4. Reconciler agent (tpl-kb-reconciler.md) for pairs hashes cannot settle.
5. kb_export -- auto-commits the bible (pathspec-only, pm-kb identity,
   content-gated, non-fatal; existing machinery, KB 34b9b7a6) so the merged
   branch's bible reflects merged truth: reconcile winners are CONFIRMED +
   un-staled (when the D2 predicate allows) and therefore pass kb_export's
   CONFIRMED + stale=0 filter. No push beyond the sprint's normal flow.

tpl-kb-reconciler.md (the agent, cheap/standard model tier -- state
claude-sonnet-4-6 in the template): for each remaining flagged pair, read the
MERGED code via code_context / code_impact / code_query -- NEVER Glob/Grep
for structural questions -- and decide which claim the code supports. Every
decided pair is resolved via kb_resolve_contradiction(winnerId, loserId,
evidence) -- the SAME single write path the prefilter uses (hardened D4;
do NOT compose kb_promote + kb_feedback for pair resolutions, they cannot
produce the required end state). Evidence note must cite file + symbol for
code-decided pairs, or the trust-tier rule for tier-decided ones. Code
silent -> trust-tier tiebreak: an ACTIVE user-directive always survives
(flag only, never auto-retired -- and kb_resolve_contradiction refuses
directive pairs anyway); otherwise CONFIRMED > INFERRED > UNVERIFIED. Still
undecidable -> leave flagged for /pm kb-review with a note appended. A
downvoted winner stays stale (it wins the contradiction, not its
reputation) -- the template states this so the agent does not "fix" it.
NEVER delete. Report shape: {pairs, code_decided, tier_decided, deferred}.

ASCII reminder: these are markdown files -- keep them pure ASCII; remember
the pre-commit hook's backtick-escape false-positive when quoting shell
snippets.

Done criteria:
- Both new files exist; SKILL.md command table row present; cleanup flow
  mentions the post-merge hook; ladder steps 1-5 in order with the exact
  tool names; kb_resolve_contradiction named as the sole resolution path in
  the template; directive-survival + trust-tier + downvoted-winner +
  NEVER-delete rules stated; trust-boundary sentence present in
  kb-reconcile.md; report shapes documented.
- npm run build clean; npm test ZERO failures (docs-only task, still run).

### T3.3 -- F6: E2E two-branch simulation

- id: T3.3
- model: claude-sonnet-4-6
- design: D6, D4 (HARDENED); feedback.md HIGH-1

Description. Provider/tool-level e2e test (new tests/knowledge/
kb-branch-reconcile.e2e.test.ts or similar) in a temp git repo + temp KB.
Follow the singleton test pattern (sprint-wide constraints) and keep ALL
paths inside temp dirs (T1.1's isolation discipline -- never the real KB or
repo bible).

Script:
1. Seed branch-A claims via capture() with real hash bases from fixture
   files in the temp repo.
2. Write a branch-B bible fixture containing: one duplicate of an A entry,
   one refinement of an A entry, one contradiction of an A entry, and one
   type='user-directive' entry.
3. kb_import it (T2.1 path). Assert: duplicate skipped; refinement
   superseded the old (superseded_at + stale per existing semantics);
   contradiction flagged per the pair asymmetry (A-side
   flagged_for_review=1, B-side contradiction_of=A, B-side stored
   UNVERIFIED by AUDN's contradiction branch); directive became a pending
   proposal (UNVERIFIED + flagged + directive:pending), never active; report
   counts match.
4. Run freshnessSweep: B-basis entries mismatching the current fixture state
   are stale; A entries with matching bases live. Assert the contradiction
   pair is STILL returned by flaggedPairs() despite B being stale
   (MEDIUM-3 liveness).
5. Modify fixture files to the "merged" state where B's claim matches the
   code; run kb_reconcile_prefilter. Assert the resolveContradiction end
   state (HIGH-1): B confidence='CONFIRMED' (lifted from UNVERIFIED
   directly), B stale=0 (basis matches and B carries no feedback/invalidated
   marker, so the D2 predicate allowed the un-stale), evidence note cites
   "hash-basis match on merged worktree"; A superseded_at set + stale=1;
   flag fields cleared on their respective sides. Add a second,
   hash-undecidable pair and assert left_for_agent counts it and its rows
   are untouched.
6. kb_export to the temp repo; assert .fleet/kb-canonical.json contains B's
   claim (CONFIRMED + stale=0 passes the export filter -- the HIGH-1
   satisfiability check), does NOT contain A's superseded claim, and does
   NOT contain the pending directive.

Done criteria:
- E2E green and hermetic (passes with the real repo bible renamed away);
  npm run build clean; npm test ZERO failures.

### T3.4 -- FINAL VERIFY (sprint close)

- id: T3.4
- type: verify (no model)

Steps, in order:
1. npm run build -- must be clean.
2. npm test -- ZERO failures.
3. npx gitnexus analyze -- non-fatal. GOTCHA (copy verbatim): gitnexus
   analyze injects non-ASCII into AGENTS.md / CLAUDE.md -- every VERIFY runs
   `git checkout -- AGENTS.md CLAUDE.md` right after analyze.
4. Sprint ASCII sweep: scan every file touched this sprint (git diff
   --name-only main...HEAD) for non-ASCII bytes; fix any hits (remember the
   hook's backtick-escape false-positive -- verify real offenders by bytes,
   not by the hook alone).
5. git push origin feat/code-intelligence-abstraction. Never push main.
   NO PR.

---

## Ambiguities and recorded resolutions

- R1 (D4 left the surface open): the prefilter ships as MCP tool
  kb_reconcile_prefilter backed by SqliteProvider.reconcilePrefilter(), so
  the PM flow invokes it like every other kb_* step. Recorded here and in
  T3.1. (Confirmed by hardened D4.)
- R2 (F5 step 2 needs a PM-invokable sweep surface; D2 forbids kb_stats and
  prime): freshnessSweep ships with its own thin MCP tool
  kb_freshness_sweep in T1.3, and kb_import additionally runs the sweep
  internally (D3). Recorded here and in T1.3/T2.1/T3.2.
- R3 (F3 says "move/duplicate"): DUPLICATE -- provider clamp is enforcement,
  handler clamp stays for the confidence_clamped UX flag. Recorded in T1.2.
- R4 (import mode transport): internal capture() parameter, never part of
  the deserialized input, so HTTP cannot set it (closes rather than reopens
  yashr-f3g). Reviewer-verified airtight (feedback.md 2a): the HTTP route
  passes exactly one argument and the MCP handler builds input from
  zod-parsed fields. Recorded in T2.1 with a dedicated test; MEDIUM-4's
  source normalization rides in the same task.
- R5 (clamp fallout): existing fixtures seeding CONFIRMED via direct
  capture() must migrate to capture-then-promote or direct INSERT
  (KB 81dbaee9). Recorded in T1.2.
- R6 (live-server retrieval quirks): tag-only/hyphenated kb_query fails on
  the deployed server ("no such column"); plain-word queries used instead;
  quirk captured as KB 49ce4c31 for future agents.
- R7 (NEW -- D4/D5 write-path surface): hardened D4 makes
  resolveContradiction the single write path for ALL reconcile resolutions,
  while D5's text still says "winner -> kb_promote"; resolved in favor of
  the hardened D4 (later, and explicitly "one write path for all reconcile
  outcomes"). The agent needs a tool surface for it, so T3.1 registers
  kb_resolve_contradiction (thin handler over the provider method) and
  T3.2's template instructs the reconciler to use it instead of composing
  kb_promote + kb_feedback for pair resolutions. Re-review war-game
  (52ef4fe): with the T3.1 linkage refusal and the
  flag-clear-before-predicate winner order, R7 introduces no new hole --
  the tool writes only to genuinely flagged, non-directive, non-superseded
  pairs, and the loser invariant holds on every path.

## Task and model summary

- Phase P1: T1.1 (sonnet), T1.2 (sonnet), T1.3 (opus), T1.4 (VERIFY)
- Phase P2: T2.1 (opus), T2.2 (haiku), T2.3 (VERIFY)
- Phase P3: T3.1 (sonnet), T3.2 (sonnet), T3.3 (sonnet), T3.4 (VERIFY)

8 work tasks: 2x claude-opus-4-8 (T1.3 un-stale predicate, T2.1 import-mode
trust semantics), 5x claude-sonnet-4-6, 1x claude-haiku-4-5. 3 VERIFY
checkpoints (no model). Zero-test-failure criterion applies to every task
from T1.2 onward and every VERIFY.
