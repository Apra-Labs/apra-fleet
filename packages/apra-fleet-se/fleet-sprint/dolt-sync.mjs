/**
 * DoltSync -- the SINGLE permitted dolt command surface for fleet-sprint.
 *
 * SCOPE / INVARIANT (apra-fleet-417.2, apra-fleet-417.2.1)
 * -------------------------------------------------------
 * Every `bd dolt pull` / `bd dolt push` this orchestrator ever issues, and
 * every dolt merge-conflict decision it ever takes, MUST go through this
 * module. No other file -- runner.js included -- may spawn a `bd dolt ...`
 * command directly, and no other file may re-implement classification, retry,
 * gating, or conflict handling for one. runner.js keeps only purpose-level
 * calls (syncBefore / syncAfter / status); the mechanics live here.
 *
 * WHY: before this module the same bracket logic was inlined in runner.js and
 * reached from ~12 call sites, so a fix to retry/gating/conflict behavior had
 * to be replayed at each of them and drifted in practice. One module with one
 * documented entry point per PURPOSE (not per command) makes that impossible.
 *
 * PUBLIC API (the only supported entry points -- see the bottom of this file)
 * --------------------------------------------------------------------------
 *   syncBefore(member, opts)  -- freshen `member`'s beads clone before it is
 *                                read from or dispatched (D-pull bracket).
 *                                `opts.readinessGate: true` (apra-fleet-417.5
 *                                rename of `healthGate`, ADR Decision 2)
 *                                selects the pre-flight beads-health variant,
 *                                which additionally composes the actionable
 *                                "beads DB diverged" diagnosis line.
 *   syncAfter(member, opts)   -- publish `member`'s beads mutations (D-push
 *                                bracket, mutex-serialized, with the single
 *                                bounded first-successful-pusher-wins
 *                                reconcile).
 *   status(member, opts)      -- read-only probe: is this clone actually wired
 *                                to a shared beads remote? Issues no dolt
 *                                command and never throws.
 *
 * FAULT-TOLERANCE POLICY (apra-fleet-417.3.1): syncBefore/syncAfter return a
 * STRUCTURED OUTCOME `{ ok, kind, degraded, degradedKind, detail, ... }` and
 * are DEGRADED BY DEFAULT -- an unresolved sync failure does not throw, it
 * reports `degraded: true` (with `degradedKind` carrying the ADR's
 * backend-neutral failure taxonomy, apra-fleet-417.5) and lets the sprint
 * continue. A call site that must still hard-abort says so explicitly with
 * `fatal: true` (and `readinessGate: true` implies it). See the "Structured
 * outcomes and the bounded DEGRADED-BUT-NON-FATAL path" section near the
 * bottom of this file.
 *
 * The lower-level primitives (doltPullBefore / preflightBeadsHealthGate /
 * doltPushAfter / classifyDoltFailure / extract*) stay exported because the
 * unit suites drive them directly and 417.2.2 migrates call sites onto the
 * purpose-based API incrementally; they are IMPLEMENTATION DETAIL of the three
 * entry points above, not a second supported surface.
 *
 * CONFLICT-RECOVERY DISPOSITION (docs/dolt-sync-redesign.md Parts 2.2/2.4)
 * -------------------------------------------------------------------------
 * The old 3-tier ladder (dolt-recovery.mjs Path A, dolt-recovery-path-b.mjs
 * Path B, dolt-recovery-tier2.mjs Tier 2 + docs/dolt-tier2-runbook.md) is
 * RETIRED, not merely rewired. In production it could never resolve anything:
 * Path A threw its precondition guard on every invocation (no sql runtime was
 * ever injected at its call site), Path B was hard-disabled for a correct
 * reason, and Tier 2 only DISPATCHED an LLM -- it never verified, so
 * recoverDoltConflict() returned `ok: false` by construction, 100% of the
 * time. Worse, its teardown was an instruction step an agent could abandon
 * mid-procedure (apra-fleet-5mqg).
 *
 * It is replaced by ONE deterministic function: settleDoltConflicts()
 * (fleet-sprint/dolt-settle.mjs), total over every row-level conflict shape
 * this data model can produce -- no gates, no allowlist, no escalation, no
 * LLM -- with a real `finally` teardown. This module holds it as
 * `opts.settle`: a zero-argument callback (buildSettleCallback(), same file)
 * that RESOLVES on a verified recovery, because settle itself republishes and
 * verifies before returning.
 *
 * Where it is wired -- BOTH divergence terminals, not just the push side:
 *   - doltPushAfter()'s terminal, where a divergence outlives the bounded
 *     first-successful-pusher-wins reconcile (where the ladder used to sit).
 *   - doltPullBefore()'s diverged terminal, which had NO recovery at all: a
 *     clone wedged by an earlier failed reconcile used to hard-abort the next
 *     sprint at the readiness gate (preflightBeadsHealthGate delegates here,
 *     so it inherits the same self-heal).
 *   - repair(), the operator/tool entry point -- same one implementation.
 *
 * Kept unchanged on purpose: with NO `settle` callback wired, both brackets
 * behave exactly as before (the typed error propagates immediately), so the
 * degraded-by-default path (apra-fleet-417.3.1) and every existing call site
 * keep their prior semantics.
 *
 * ASCII only.
 */

import { DoltDivergedError, DoltSyncError } from './errors.mjs';
import { classifyFailure, toDoltVerdict } from './vcs-module.mjs';
import { buildSettleCallback } from './dolt-settle.mjs';

// ---------------------------------------------------------------------------
// Dolt sync brackets: D-pull / D-push
// ---------------------------------------------------------------------------
//
// The beads database is a Dolt database that every member syncs through a
// shared remote, orthogonally to the git code branch. Where the git brackets
// keep each member's *code checkout* current, these keep each member's *beads
// clone* current: a D-pull before every dispatch/read that consumes beads
// state, and a D-push after every step that mutates it.
//
// The most divergence-sensitive read in the runner is the orchestrator's
// post-streak `bd show` verification (verifyDoerStreakClosed): a remote doer
// closes its beads in ITS OWN clone and D-pushes them, so without an
// orchestrator-side D-pull immediately before that read the orchestrator reads
// its own stale (still-open) copy and falsely marks every remote doer streak
// FAILED.
//
// Conflict policy, deliberately NOT per-conflict judgment: D-push is
// first-successful-pusher-wins. A member whose push is rejected is the loser
// and reconciles MECHANICALLY -- it D-pulls the winner's state (ours/theirs
// fixed by which clone is resolving, never a human/LLM decision) then re-pushes
// exactly once. A divergence that outlives that one bounded reconcile is a hard
// DoltDivergedError, never retried blindly -- the mirror of the git
// single-writer stance.
//
// Every `bd dolt` command is issued via the injected command() with an explicit
// member_name -- agents never sync beads themselves; the orchestrator brackets
// each dispatch. `command` is dependency-injected so unit tests can drive these
// helpers with a mock command() and no live Dolt server.

// apra-fleet-647.1.3.2: the DOLT_*_PATTERNS lists that used to live here
// (DOLT_NO_REMOTE_PATTERNS, DOLT_EMPTY_REMOTE_PATTERNS,
// DOLT_REMOTE_UNREACHABLE_PATTERNS, DOLT_AUTH_PATTERNS, DOLT_DIVERGED_PATTERNS,
// DOLT_TRANSIENT_PATTERNS) are GONE -- classifyDoltFailure() below delegates
// to VCSModule.classifyFailure(raw, { provider: 'dolt' }), the ONE place VCS
// stderr is parsed. The 'dolt' provider (./vcs-providers/dolt.mjs) carries
// every one of those six tables VERBATIM, plus their own precedence (auth
// checked BEFORE diverged -- see that file's header for the live incident
// this ordering prevents, apra-fleet-spp), so this is a delegation, not a
// behavior change.

/**
 * Best-effort extraction of the remote URL named in a remote-unreachable
 * `bd dolt` failure, for the named diagnosis message. Returns null when the
 * output carries no recognizable URL.
 *
 * @param {string} output - the raw stderr/stdout of the failed `bd dolt` command
 * @returns {string|null}
 */
export function extractDoltRemoteUrl(output) {
    const text = String(output == null ? '' : output);
    const quoted = text.match(/the remote: \S+ '([^']+)' could not be accessed/i);
    if (quoted) return quoted[1];
    const scheme = text.match(/(?:file|https?|git\+https?|ssh):\/\/[^\s'"]+/i);
    if (scheme) return scheme[0];
    return null;
}

/**
 * Classify a failed `bd dolt` command's output into the failure classes the
 * Dolt brackets route differently. Thin adapter over
 * VCSModule.classifyFailure(raw, { provider: 'dolt' }) + toDoltVerdict(),
 * mapping the neutral kind taxonomy onto this module's legacy verdict
 * vocabulary with NO verdict change from the deleted pattern-list classifier.
 * The 'dolt' provider's own `precedence` (./vcs-providers/dolt.mjs) preserves
 * this function's documented check order: no-remote, empty-remote,
 * remote-unreachable, THEN auth (before diverged -- apra-fleet-spp /
 * apra-fleet-417.3.1), THEN diverged, THEN transient.
 *
 * @param {string} output - the raw stderr/stdout of the failed `bd dolt` command
 * @returns {'no-remote'|'empty-remote'|'remote-unreachable'|'auth'|'diverged'|'transient'|'unknown'}
 */
export function classifyDoltFailure(output) {
    return toDoltVerdict(classifyFailure(output, { provider: 'dolt' }).kind);
}

/**
 * Query whether `member`'s bd-level `sync.remote` setting is currently
 * configured.
 *
 * Deliberately independent of Dolt's raw remote wiring and of
 * classifyDoltFailure's stderr pattern matching: a miswired Dolt-level remote
 * can still make a real `bd dolt push` attempt and fail with a credentials
 * error that classifies as 'auth' rather than 'no-remote', even when the
 * bd-level sync.remote for this clone is neutralized and nothing is supposed to
 * be pushed. Consulting the bd-level setting directly closes that gap
 * regardless of what Dolt's own remote list says.
 *
 * Uses `bd config get sync.remote --json` via the injected command() with an
 * explicit member_name, rather than reading config.yaml off disk, because
 * command() is the only member-scoped I/O this runner has -- a member's clone
 * is not assumed to be locally readable.
 *
 * Fails CLOSED: a failed command(), a failSoft error result, or output that
 * cannot be positively parsed as `{ value: '' }` is all treated as CONFIGURED
 * (returns true). "Not configured" is only ever reported on a positively
 * confirmed empty `value` from a clean JSON parse, because a false positive
 * here would silently swallow a genuine D-push failure on a real,
 * actively-synced clone.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function }} opts
 * @returns {Promise<boolean>}
 */
export async function isMemberSyncRemoteConfigured(member, opts) {
    return (await readMemberSyncRemote(member, opts)).configured;
}

// ---------------------------------------------------------------------------
// sync.remote probe memoization (apra-fleet-akuv)
// ---------------------------------------------------------------------------
//
// `bd config get sync.remote --json` used to be spawned FRESH on every call --
// once per D-pull pre-gate, once per D-push pre-gate, once per status() probe,
// and every dispatch is bracketed -- which measured out at roughly 90-160
// spawns (about 0.6s each) per sprint re-reading a value that never changes
// mid-run. A codebase-wide search confirmed no production path in this package
// writes sync.remote during a live sprint; only test fixtures and one-time
// setup/seed scripts do. So the result is memoized PER MEMBER for the process
// lifetime, with explicit invalidation rather than a TTL (a TTL would re-add
// spawns for no real safety).
//
// WHAT IS CACHED, deliberately narrow: ONLY a positively parsed answer -- a
// clean JSON parse of the command's output. Every fail-safe path (command()
// threw, a failSoft error result, no output at all, unparseable output) reports
// "configured" WITHOUT caching, so a transient probe failure can never pin the
// fail-safe answer for the rest of the run; the next call re-probes. This
// preserves isMemberSyncRemoteConfigured's fail-CLOSED contract exactly.
//
// INVALIDATION -- three HARD seams that drop BOTH this memo and the member's
// recorded remote-tip fingerprint (see the invariant below), plus one SOFT
// seam that drops nothing and instead marks the member for a lazy re-check:
//   1. noteMemberCommand() -- called from the runner's central command()
//      wrapper; drops the entry for any `bd config set` / `bd dolt remote` /
//      `bd init` / `bd bootstrap` the ORCHESTRATOR issues against that member.
//   2. the auth self-heal path in runDoltStep(), when onAuthFailure fires for
//      a member (re-provisioning credentials can rewire the remote).
//   3. repair(), the operator/tool remediation entry point.
//   4. (soft) noteMemberDispatchCompleted() -- called from the runner's
//      central agent() wrapper the moment ANY dispatch to a member settles.
//      A dispatched agent runs its `bd` commands in its own session on the
//      member, never through the command() wrapper, so seam 1 cannot see an
//      agent-side `bd config set sync.remote`. This seam therefore marks the
//      member DISPATCHED-SINCE-VERIFIED; the memo stays, and is re-read
//      (one `bd config get`, a plain config.yaml read) only at the one
//      decision a stale answer could turn into stale DATA -- the moment a
//      D-pull is about to be SKIPPED on the strength of the fingerprint. See
//      noteMemberDispatchCompleted for why this is the right trigger and
//      why an unconditional per-dispatch wipe was replaced.
//
// INVARIANT: the hard seams forget the two per-member memos (this one and
// lastSyncedTips) TOGETHER. Any event that can rewire a member's remote or
// replace its local clone invalidates both; a seam that dropped only one
// would leave a fingerprint that was minted against the other, stale, answer.
// The fingerprint additionally carries the URL it was minted against, so a
// memo that is later re-read to a DIFFERENT url can never validate it.
//
// The same cache entry carries the remote URL, which the remote-tip
// fingerprint (see readRemoteDoltTip below) needs -- one probe answers both
// questions, so the fingerprint costs no extra `bd config get`.

/** member -> { configured: boolean, url: string|null } (positively parsed only) */
const syncRemoteCache = new Map();

/** Members dispatched to since their sync.remote memo was last POSITIVELY
 *  read. Set by noteMemberDispatchCompleted(); cleared by any positive
 *  re-read of the memo and by the hard seams. Consulted only on the
 *  D-pull skip path (see confirmSkipAfterDispatch). */
const dispatchedSinceVerified = new Set();

/** Commands whose success can change a member's bd-level sync.remote wiring.
 *
 *  Deliberately NOT left-anchored (dolt sync budget review round 2, item 5):
 *  member-bound command strings are routinely COMPOUND, because a member's cwd
 *  has to be established in the same string (its shell may be PowerShell or a
 *  POSIX shell). scripts/dolt-settle-integration.mjs already issues exactly
 *  that shape --
 *    cd "<dir>" && bd dolt remote add origin "<url>" && bd config set sync.remote "<url>"
 *    Set-Location "<dir>"; bd dolt remote add origin "<url>"; bd config set ...
 *  -- both of which the old `^\s*bd` anchor silently failed to recognize,
 *  leaving a rewired member answering from a stale memo. The leading
 *  `(?:^|[\s;&|(])` keeps the match word-bounded (so `abd bootstrap` or
 *  `--bd init` never match) while allowing anything to precede the invocation.
 */
const SYNC_REMOTE_INVALIDATING_COMMAND_RE = /(?:^|[\s;&|(])bd\s+(?:config\s+set|dolt\s+remote|init|bootstrap)\b/i;

/**
 * Drop the memoized sync.remote answer for `member` (or for every member when
 * called with no argument -- test hygiene, and the operator-repair path).
 *
 * @param {string} [member]
 * @returns {number} how many cache entries were dropped
 */
export function invalidateSyncRemoteCache(member) {
    if (member === undefined) {
        const n = syncRemoteCache.size;
        syncRemoteCache.clear();
        return n;
    }
    return syncRemoteCache.delete(member) ? 1 : 0;
}

/**
 * Invalidation seam for the runner's central command() wrapper: hand every
 * member-bound command string here and the sync.remote memo is dropped when the
 * command could have rewired that member's remote. A non-matching command (the
 * overwhelming majority) is a cheap regex test and no cache change.
 *
 * The recorded remote-tip fingerprint is dropped alongside the memo (dolt sync
 * budget review round 2, item 4): `bd init` / `bd bootstrap` can REPLACE the
 * member's local Dolt clone outright, and a freshly recreated (empty) clone is
 * not current with anything -- yet the remote tip it is compared against has
 * not moved, so a surviving fingerprint would match and skip the very pull that
 * clone needs most. Forgetting it only ever costs one real pull.
 *
 * @param {string} member
 * @param {string} cmd
 * @returns {boolean} whether the command invalidated the memo
 */
export function noteMemberCommand(member, cmd) {
    if (typeof member !== 'string' || member.length === 0) return false;
    if (typeof cmd !== 'string') return false;
    if (!SYNC_REMOTE_INVALIDATING_COMMAND_RE.test(cmd)) return false;
    forgetMemberSyncState(member);
    return true;
}

/**
 * Drop BOTH per-member memos (the sync.remote answer and the recorded
 * remote-tip fingerprint) for `member`. The one primitive every invalidation
 * seam calls, so the two can never drift apart.
 *
 * @param {string} member
 */
function forgetMemberSyncState(member) {
    invalidateSyncRemoteCache(member);
    clearLastSyncedTip(member);
    dispatchedSinceVerified.delete(member);
    tipProbeFailures.delete(member);
}

/**
 * Soft invalidation seam for the runner's central agent() wrapper: called
 * once per dispatch, the moment the dispatch settles (fulfilled OR rejected),
 * and BEFORE the post-dispatch D-push bracket for that member runs. Marks
 * `member` as dispatched-since-verified. It forgets NOTHING.
 *
 * THE DESIGN DECISION (dolt sync budget review round 4). Round 3 made this
 * seam an unconditional wipe of both memos, on the argument that an agent
 * runs its `bd` commands in its own session (invisible to noteMemberCommand)
 * and might `bd bootstrap` / `bd init` / `bd config set sync.remote` the
 * member's clone. Combined with "a push never mints a fingerprint" (correct,
 * see doltPullBefore's section comment), that left the fingerprint EMPTY at
 * the start of every dispatch bracket -- the module's primary path -- and
 * re-spawned `bd config get` once per dispatch (the golden mock-sprint
 * transcript went from 1 probe to 14). The primary path then paid one
 * ls-remote MORE than before this feature existed and skipped nothing.
 *
 * The wipe was the wrong tool because the hazards it guarded are not what
 * they were assumed to be. Taking each agent-side event in turn, against
 * what bd actually does (verified against the beads source):
 *
 *   * `bd bootstrap` -- the one self-heal this repo's agent instructions
 *     prescribe ("database exists" -> retry with `--database <name>`) -- is
 *     NON-DESTRUCTIVE. With a DB present it validates and reports; it never
 *     replaces the clone. Where it does create a DB it CLONES it from the
 *     configured sync.remote, i.e. the result is current with the remote by
 *     construction. In neither case can a fingerprint that still equals the
 *     remote's tip describe a clone that is not at that tip. A surviving
 *     fingerprint stays TRUE across a bootstrap.
 *   * `bd init` REFUSES on an existing DB unless forced (`--reinit-local` /
 *     `--force`). A forced re-init yields a clone with an UNRELATED history:
 *     no `bd dolt pull` can bring it current (there is nothing to
 *     fast-forward), so skipping that pull changes nothing, and the clone's
 *     next push diverges into the terminals that already forget the tip and
 *     run settle. The fingerprint is not the deciding factor there either.
 *   * `bd config set sync.remote <other>` -- the ONE event where a skip would
 *     suppress a pull that WOULD have helped (the clone should now follow a
 *     different remote). This is handled, not accepted: the fingerprint is
 *     bound to the URL it was minted against, and a member marked here has
 *     its sync.remote RE-READ before any skip is taken on its fingerprint
 *     (confirmSkipAfterDispatch). A changed URL forgets the fingerprint and
 *     forces a real pull; an unreadable answer forces a real pull too.
 *
 * WHY LAZY, AND WHY ONLY ON THE SKIP PATH. A stale memo can only turn into
 * stale DATA at one decision: "skip this pull". Every other consumer fails
 * closed -- a wrong "configured" answer merely issues a real pull/push
 * against whatever remote bd itself has configured, which is the right
 * remote regardless of what we cached. So the re-read is paid exactly where
 * it buys correctness: once per skip-after-dispatch (one `bd config get`, a
 * plain config.yaml read with no Dolt engine start, instead of a real pull
 * that opens the whole chunk store), never per dispatch. A bracket whose
 * remote tip MOVED pays nothing extra; consecutive orchestrator-side reads
 * with no dispatch in between pay nothing extra. The golden transcript is
 * back to one probe per member per process.
 *
 * THE ABSENT CASE (round-4 review, finding 1). A member whose sync.remote
 * was positively ABSENT when first read never reaches the skip path -- both
 * pre-gates take the no-remote exit first -- so the lazy re-check above
 * cannot cover it, and a first cut of this design accepted that as
 * residual. It is not acceptable: an agent that wires a remote mid-dispatch
 * (a `bd init --remote` / `bd config set sync.remote` in its own session)
 * would leave every later D-push of that member reporting `{ ok: true,
 * skipped: true, reason: 'no-remote' }` -- success -- while its bead closes
 * never left the clone, for the rest of the process. So a memoized ABSENT
 * answer is re-read once after any dispatch to the member, at the next
 * pre-gate (readMemberSyncRemote). Cost: one config.yaml read per dispatch,
 * paid ONLY by members with no remote (sandboxes, the no-remote mock
 * sprint -- whose golden transcript therefore shows one probe per dispatch);
 * a member with a remote still pays one probe per process.
 *
 * @param {string} member
 * @returns {boolean} whether the member was marked (false for a non-member)
 */
export function noteMemberDispatchCompleted(member) {
    if (typeof member !== 'string' || member.length === 0) return false;
    dispatchedSinceVerified.add(member);
    return true;
}

/**
 * Has `member` been dispatched to since its sync.remote memo was last
 * positively read? Exposed for tests and operator tooling.
 * @param {string} member
 * @returns {boolean}
 */
export function isMemberDispatchedSinceVerified(member) {
    return dispatchedSinceVerified.has(member);
}

/**
 * Read `member`'s bd-level sync.remote, memoized per member (see the section
 * comment above). Returns both the fail-closed boolean the pre-gates consult
 * and the remote URL string the tip fingerprint needs.
 *
 * `configured: true` with `url: null` means "could not be positively read, so
 * treated as configured" -- the fail-safe answer, never cached. `positive`
 * says whether the answer came from a clean parse (live or memoized) rather
 * than the fail-safe fallback.
 *
 * `opts.verify: true` bypasses the memo and re-reads the member (the lazy
 * post-dispatch check, see confirmSkipAfterDispatch). Any positive read --
 * a cache miss or a verify -- refreshes the memo and clears the member's
 * dispatched-since-verified mark.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, verify?: boolean }} opts
 * @returns {Promise<{ configured: boolean, url: string|null, positive: boolean }>}
 */
export async function readMemberSyncRemote(member, opts) {
    const { command, log = () => {}, verify = false } = opts;
    const cached = verify ? undefined : syncRemoteCache.get(member);
    // A memoized ABSENT answer is re-read once after any dispatch to the
    // member (round-4 review, finding 1). Nothing downstream of a cached
    // "absent" ever reaches the fingerprint's lazy re-check -- both pre-gates
    // take the no-remote exit first -- so an agent that wires a remote
    // mid-dispatch would otherwise leave every later D-push of that member
    // reporting a benign no-remote skip while its bead closes never left the
    // clone. A memoized PRESENT answer needs no re-read here: a wrong
    // "configured" answer fails closed (a real pull/push against whatever
    // remote bd itself has), and the skip path re-verifies on its own.
    const absentAfterDispatch = cached && cached.configured === false && dispatchedSinceVerified.has(member);
    if (cached && !absentAfterDispatch) return { ...cached, positive: true };

    let res;
    try {
        res = await command('bd config get sync.remote --json', { member_name: member, silent: true, failSoft: true });
    } catch (err) {
        log(`[Dolt] could not query bd-level sync.remote for member '${member}' (fail-safe: treating as configured): ${err.message}`);
        return { configured: true, url: null, positive: false };
    }
    if (res && typeof res === 'object' && res.ok === false) {
        log(`[Dolt] 'bd config get sync.remote' failed for member '${member}' (fail-safe: treating as configured): ${res.error}`);
        return { configured: true, url: null, positive: false };
    }
    const output = res && typeof res === 'object' ? res.output : res;
    if (!output) {
        // No output to positively parse (e.g. a no-op/unmocked command()):
        // sync.remote cannot be confirmed absent, so do not treat it as
        // neutralized -- and do not cache a non-answer.
        return { configured: true, url: null, positive: false };
    }
    let parsed;
    try {
        parsed = JSON.parse(output);
    } catch (err) {
        log(`[Dolt] could not parse 'bd config get sync.remote --json' output for member '${member}' (fail-safe: treating as configured): ${err.message}`);
        return { configured: true, url: null, positive: false };
    }
    const value = typeof parsed.value === 'string' ? parsed.value.trim() : null;
    const entry = {
        configured: !(value !== null && value.length === 0),
        url: value !== null && value.length > 0 ? value : null,
    };
    // Only a positively parsed answer is memoized -- and a positive read is
    // by definition a verification, so the dispatch mark is cleared with it.
    syncRemoteCache.set(member, entry);
    dispatchedSinceVerified.delete(member);
    return { ...entry, positive: true };
}

// Bounded exponential backoff between TRANSIENT retries (apra-fleet-417.3.1).
// A network blip, a busy dolt-server or a held row lock is not cleared by an
// instant re-issue -- the previous code retried with zero delay, which turned
// the bound into "fail twice as fast". Delay is attempt-indexed and capped, and
// `sleep` is injectable so unit suites never actually wait.
//
// apra-fleet-ka1u follow-up: a live Windows machine-wide git.exe spawn outage
// (fork/exec ... "Not enough memory resources") was directly measured to last
// 1-3 MINUTES per occurrence (fleet supervisor log analysis), during which
// essentially every dolt-initiated git spawn fails -- not an isolated blip.
// The original 8s cap meant even 5 retries covered at most ~15s of backoff,
// structurally unable to span an outage an order of magnitude longer; the
// sprint kept dying with retries correctly firing but exhausted. Raised to
// 30s so a realistic retry budget can actually outlast one of these windows
// instead of just softening it.
//
// TIME-BOXED, NOT COUNT-BOXED (dolt sync budget review, section A.3)
// -------------------------------------------------------------------------
// Widening the ladder to `maxTransientRetries = 8` with a 30s cap fixed the
// spawn-outage case but applied that budget to EVERY transient kind, and the
// cost was demonstrated immediately: the unit suite went from 80s to 6m15s,
// because an ordinary transient in a test fixture now walked the full 8-retry
// x 30s-cap ladder (91.5s of pure sleep in one exhausted ladder, before
// counting the 600s per-attempt timeout). The retry budget was never really
// about a COUNT -- it was about spanning a wall-clock outage window.
//
// So the ladder is split by error CLASS, and only the class that motivated the
// widening gets the long budget:
//
//   * SPAWN OUTAGE (`fork/exec ...`, "Not enough memory resources") -- the OS
//     refused to start git.exe at all. Retried against a WALL-CLOCK budget
//     (DOLT_SPAWN_OUTAGE_BUDGET_MS, 3 min, matching the measured 1-3 min
//     window) with the 30s backoff cap. The bound is elapsed time, so it is
//     the same 3 minutes whether each attempt returns instantly or sits on a
//     long timeout -- the old count-based bound multiplied out to a worst case
//     of 9 attempts x the 600s step timeout.
//   * EVERY OTHER TRANSIENT (network blip, busy server, held row lock) keeps
//     the short ladder it always had before the widening: 5 retries, 8s cap.
//     These were never the failure the long budget was bought for, and giving
//     them the long one is exactly what caused the suite regression.
//
// `maxTransientRetries` still bounds the generic class and is still honored
// when a caller passes it explicitly, so every existing test seam keeps
// working; only the DEFAULT drops back from 8 to the pre-widening 5.
//
// ROUND-3 CORRECTION (dolt sync budget review round 3, item 4): "honored when
// passed explicitly" now applies to BOTH classes. The round-2 cut let an
// explicit `maxTransientRetries` cap only the generic ladder while the
// spawn-outage ladder ignored it and always ran to its own wall-clock budget
// and 30-attempt backstop -- a caller asking for a tight bound could still sit
// in a 3-minute retry loop. An explicit value is now a hard attempt cap on the
// spawn-outage ladder too (min(explicit, DOLT_SPAWN_OUTAGE_MAX_RETRIES), with
// the wall-clock budget still applying on top). Left UNSPECIFIED -- the
// production default, since no runner call site passes it -- the spawn-outage
// class keeps the full wall-clock budget; the "hard attempt backstop" below is
// then the only count in play. runDoltStep() therefore distinguishes "not
// passed" (undefined) from "passed", which is why the bracket entry points no
// longer fill in the default themselves.
//
// ROUND-2 CORRECTION (dolt sync budget review round 2, item 3): the first cut
// of this split set the generic default to 2, describing it as "the ladder it
// always had before the widening". That was wrong -- `git show 3f49419b`
// (bump D-pull/D-push transient-retry budget from 1 to 5) shows the
// pre-widening default was 5 (~15.5s of backoff), not 2 (~1.5s). The suite
// regression that motivated the reduction came from the SPAWN-OUTAGE class's
// 3-minute wall-clock budget, a test-fixture problem (fixtures sleeping
// through real backoff), not from this ladder -- so the generic class is back
// at 5 and any slow test injects its own `sleep`/`backoffBaseMs` instead.
const DOLT_BACKOFF_BASE_MS = 500;
const DOLT_BACKOFF_MAX_MS = 30000;

/** Backoff cap for the ordinary transient class -- the pre-widening value. */
const DOLT_GENERIC_BACKOFF_MAX_MS = 8000;

/** Retry count for the ordinary transient class (the default for
 *  `maxTransientRetries`). The pre-widening baseline -- see the note above,
 *  including why the round-1 value of 2 was a mis-restoration. */
export const DOLT_GENERIC_TRANSIENT_MAX_RETRIES = 5;

/** Total wall-clock retry budget for the spawn-outage class, sized to the
 *  measured 1-3 minute Windows git.exe spawn outage with headroom. */
export const DOLT_SPAWN_OUTAGE_BUDGET_MS = 180000;

/** Hard attempt backstop for the spawn-outage ladder. The real bound is the
 *  wall-clock budget above (~10 retries at the 30s cap); this only keeps a
 *  non-advancing clock from spinning. */
const DOLT_SPAWN_OUTAGE_MAX_RETRIES = 30;

/** The spawn-outage class: the OS refused to START the git subprocess, as
 *  opposed to anything that happened once it was running. Deliberately broad
 *  on the `fork/exec` line: any process-spawn refusal is the same class
 *  regardless of the OS's phrasing for why it refused.
 *
 *  Exactly ONE pattern, on purpose (dolt sync budget review round 3, item
 *  5). An earlier cut also matched the Windows wording "Not enough memory
 *  resources" on its own, but that pattern was dead: isSpawnOutageFailure()
 *  only runs on a failure the 'dolt' provider already classified 'transient',
 *  and that provider's TRANSIENT table carries `fork/exec ` and NOT the
 *  memory-resources wording -- so a text with the wording but no fork/exec
 *  line classifies 'unknown', is never retried, and never reaches this
 *  check. It is also redundant in practice: Go's os/exec formats every spawn
 *  refusal as `fork/exec <path>: <os error>`, so the live incident text
 *  (test/dolt-remote-unreachable.test.mjs) always carries both halves on
 *  the same line. Matching fork/exec alone is therefore complete for the
 *  class, and this list stays in lock-step with what can actually arrive. */
const DOLT_SPAWN_OUTAGE_PATTERNS = [
    /fork\/exec /i,
];

/**
 * Is this failure text the spawn-outage class that earns the long wall-clock
 * retry budget? Callers must already have classified the failure as
 * 'transient'; this only sub-classifies WITHIN that verdict and never widens
 * what counts as retryable (see DOLT_SPAWN_OUTAGE_PATTERNS for why the list
 * must not carry a pattern the provider's TRANSIENT table cannot deliver).
 *
 * @param {string} output - raw stderr/stdout of the failed command
 * @returns {boolean}
 */
export function isSpawnOutageFailure(output) {
    const text = String(output == null ? '' : output);
    return DOLT_SPAWN_OUTAGE_PATTERNS.some((re) => re.test(text));
}

// apra-fleet-jxdf.2: every `bd dolt pull`/`bd dolt push` this module issues
// used to inherit whatever generic default the injected command() primitive
// falls back to when no timeout is specified (120s, sized for an ordinary
// shell command, not a Dolt sync). A live incident confirmed an INCREMENTAL
// pull against an already-cloned, several-hundred-MB embedded Dolt DB can
// take multiple minutes -- an order of magnitude past that default -- and
// every one of those pulls was timing out, silently, every single time,
// with no fatal error surfaced and the caller left reading stale data. Size
// this for realistic Dolt DB sizes in this fleet, not a toy DB; callers that
// need a different budget can still override via opts.timeoutS.
const DOLT_STEP_TIMEOUT_S = 600;

/**
 * Delay before transient retry #`attempt` (1-based): base * 2^(attempt-1),
 * capped at DOLT_BACKOFF_MAX_MS.
 *
 * @param {number} attempt
 * @param {number} [baseMs]
 * @param {number} [maxMs]
 * @returns {number}
 */
/** How often the push mutex's lease is renewed while this bracket holds it.
 *  Well under the supervisor mutex's 60s lease (src/supervisor/dolt-mutex.mjs
 *  DEFAULT_LEASE_MS), so a legitimately long hold -- push + reconcile +
 *  settle -- never loses mutual exclusion to reclaimExpired(). Design doc
 *  Part 3.4. */
export const DOLT_MUTEX_RENEW_INTERVAL_MS = 20_000;

export function doltBackoffDelayMs(attempt, baseMs = DOLT_BACKOFF_BASE_MS, maxMs = DOLT_BACKOFF_MAX_MS) {
    const n = Math.max(1, Number(attempt) || 1);
    return Math.min(maxMs, baseMs * Math.pow(2, n - 1));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a single `bd dolt` command via the injected command() with failSoft,
 * retrying ONLY transient failures up to `maxTransientRetries` times, with a
 * bounded exponential backoff between attempts (doltBackoffDelayMs; override
 * the waiter with `sleep` in tests). A diverged (or unknown) failure is
 * returned immediately, never retried.
 *
 * AUTH SELF-HEAL CONTRACT (the optional `onAuthFailure` param, threaded
 * through by every caller below): a DISTINCT, bounded one-shot path, never
 * folded into the `maxTransientRetries` loop. On an 'auth' classification (see
 * classifyDoltFailure), `onAuthFailure` is called at most ONCE, and if it
 * resolves without throwing the same `bd dolt` command is retried exactly once
 * more. If `onAuthFailure` throws, or is omitted, the failed result is
 * returned to the caller as-is.
 *
 * apra-fleet-647.1.3.3: an 'unknown' classification gets this SAME bounded
 * one-shot self-heal + single retry, rather than failing immediately -- an
 * unrecognized provider failure text is more likely a stale credential than a
 * truly fatal condition, so it is worth exactly one bounded self-heal attempt
 * before giving up. It shares the single `authHealAttempted` latch with the
 * 'auth' path, so self-heal still fires AT MOST ONCE per runDoltStep call. A
 * 'diverged' classification remains excluded and is still returned
 * immediately, never retried.
 *
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, kind?: 'no-remote'|'empty-remote'|'remote-unreachable'|'diverged'|'auth'|'transient'|'unknown' }>}
 */
async function runDoltStep({ command, member, cmd, label, log, maxTransientRetries, onAuthFailure, sleep = defaultSleep, backoffBaseMs = DOLT_BACKOFF_BASE_MS, timeoutS = DOLT_STEP_TIMEOUT_S, spawnOutageBudgetMs = DOLT_SPAWN_OUTAGE_BUDGET_MS, now = Date.now }) {
    let attempt = 0;
    let authHealAttempted = false;
    const startedAt = now();
    // An explicitly passed `maxTransientRetries` caps BOTH ladders (see the
    // ROUND-3 CORRECTION in the constants block); left undefined, the generic
    // class gets its default and the spawn-outage class keeps its own
    // backstop, bounded by wall clock.
    const explicitRetryCap = maxTransientRetries !== undefined && maxTransientRetries !== null;
    const genericMaxRetries = explicitRetryCap ? Number(maxTransientRetries) : DOLT_GENERIC_TRANSIENT_MAX_RETRIES;
    const spawnOutageMaxRetries = explicitRetryCap
        ? Math.min(Number(maxTransientRetries), DOLT_SPAWN_OUTAGE_MAX_RETRIES)
        : DOLT_SPAWN_OUTAGE_MAX_RETRIES;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await command(cmd, { member_name: member, silent: true, failSoft: true, label, timeout_s: timeoutS });
        if (res && res.ok) return res;
        const error = res ? res.error : 'unknown command failure';
        const kind = classifyDoltFailure(error);
        if (kind === 'transient') {
            // Sub-classify WITHIN the transient verdict: only the spawn-outage
            // class gets the long wall-clock budget (see the constants block
            // above for why the count-based ladder was replaced).
            if (isSpawnOutageFailure(error)) {
                const elapsedMs = now() - startedAt;
                // The attempt ceiling is a backstop, not the policy: at the 30s
                // backoff cap a 3-minute budget spends itself in ~10 retries, so
                // this can only ever fire if the injected clock does not
                // advance. It exists so a broken clock degrades to the old
                // bounded ladder rather than spinning forever.
                if (elapsedMs < spawnOutageBudgetMs && attempt < spawnOutageMaxRetries) {
                    attempt += 1;
                    const delayMs = doltBackoffDelayMs(attempt, backoffBaseMs, DOLT_BACKOFF_MAX_MS);
                    log(`[Dolt] transient SPAWN-OUTAGE failure for member '${member}' (${label}); retry ${attempt} after ${delayMs}ms backoff (${Math.round(elapsedMs / 1000)}s of a ${Math.round(spawnOutageBudgetMs / 1000)}s wall-clock budget used${explicitRetryCap ? `, capped at ${spawnOutageMaxRetries} retries by the caller` : ''}): ${error}`);
                    if (delayMs > 0 && typeof sleep === 'function') await sleep(delayMs);
                    continue;
                }
                log(`[Dolt] spawn-outage retry budget (${Math.round(spawnOutageBudgetMs / 1000)}s wall clock, ${spawnOutageMaxRetries} retries max) EXHAUSTED for member '${member}' (${label}) after ${attempt} retries; giving up: ${error}`);
            } else if (attempt < genericMaxRetries) {
                attempt += 1;
                const delayMs = doltBackoffDelayMs(attempt, backoffBaseMs, DOLT_GENERIC_BACKOFF_MAX_MS);
                log(`[Dolt] transient failure for member '${member}' (${label}); retry ${attempt}/${genericMaxRetries} after ${delayMs}ms backoff: ${error}`);
                if (delayMs > 0 && typeof sleep === 'function') await sleep(delayMs);
                continue;
            }
        }
        if ((kind === 'auth' || kind === 'unknown') && typeof onAuthFailure === 'function' && !authHealAttempted) {
            authHealAttempted = true;
            // Re-provisioning a member's VCS auth can rewire its remote, so
            // neither memo may survive a self-heal: the sync.remote answer AND
            // the remote-tip fingerprint minted against it (round 3, item 6 --
            // this used to drop only the former, unlike repair()).
            forgetMemberSyncState(member);
            log(`[Dolt] ${kind} failure for member '${member}' (${label}); invoking self-heal (provision_vcs_auth) once before a single bounded retry: ${error}`);
            try {
                await onAuthFailure({ member, label, cmd, error, kind: 'dolt' });
            } catch (healErr) {
                log(`[Dolt] self-heal for member '${member}' (${label}) failed; not retrying further: ${healErr.message}`);
                log(`[Dolt] ${label} FAILED (${kind}) -- reads/writes for member '${member}' may be stale until this is resolved. Raw: ${error}`);
                return { ok: false, output: res ? res.output : '', error, kind };
            }
            log(`[Dolt] self-heal for member '${member}' (${label}) completed; retrying the failed dolt command once.`);
            continue;
        }
        // apra-fleet-jxdf.2: every non-ok exit from this function used to be
        // reported ONLY as a structured return value -- a caller on the
        // fatal:false path (the common case, e.g. refreshView's documented
        // "never throws" contract) could silently proceed on stale data with
        // no trace of this failure anywhere in the sprint log. Log it loudly
        // here, once, at the single choke point every D-pull/D-push passes
        // through, so a degraded read/write is always visible to whoever is
        // watching a live sprint -- independent of whether the caller treats
        // it as fatal.
        log(`[Dolt] ${label} FAILED (${kind}) -- reads/writes for member '${member}' may be stale until this is resolved. Raw: ${error}`);
        return { ok: false, output: res ? res.output : '', error, kind };
    }
}

/**
 * D-pull: bring `member`'s beads clone up to the shared remote before it reads
 * or is dispatched -- `bd dolt pull`. Transient (network / server / lock)
 * failures are retried up to `maxTransientRetries`; a divergence (a conflict
 * that a plain pull cannot fast-forward) is a distinct typed
 * DoltDivergedError, never retried blindly. Every command is issued via the
 * injected command() with an explicit member_name.
 *
 * The pull is PRE-GATED on the member's own bd-level `sync.remote`: a clone
 * whose sync.remote is positively confirmed absent issues no `bd dolt`
 * command at all, because bd auto-provisions a Dolt-level remote from git's
 * own origin as a side effect of any `bd dolt` invocation that needs one --
 * an ungated pull would therefore re-arm a remote a sandbox had deliberately
 * neutralized. The gate fails CLOSED (isMemberSyncRemoteConfigured reports
 * "not configured" only on a positively-confirmed empty value; any
 * inconclusive read lets the pull proceed), so a real, actively-synced clone
 * is never suppressed. Override the check with
 * `opts.checkSyncRemoteConfigured` (same test hook doltPushAfter exposes).
 *
 * A further benign skip is the REMOTE-TIP FINGERPRINT: `reason:
 * 'remote-unchanged'` means `git ls-remote <sync.remote> refs/dolt/data`
 * returned the exact SHA this member last synchronized to, so the pull is a
 * provable no-op and is not spawned. See the section comment above this
 * function for the correctness argument and the fail-open rules; disable it
 * with `opts.remoteTipFingerprint: false`.
 *
 * Two further benign no-op skips return `{ ok: true, skipped: true }` rather
 * than throwing: `reason: 'no-remote'` (no dolt remote configured -- nothing
 * to pull) and `reason: 'empty-remote'` (a configured remote that has never
 * had anything pushed into it, i.e. Dolt's "no branches found in remote"
 * Error 1105 -- nothing to reconcile). `skipPull: true` skips the actual `bd
 * dolt pull` spawn while still running the sync.remote pre-gate probe, and
 * returns `reason: 'already-fresh'`; callers may only set it where the
 * clone's freshness is already established, since it trades a redundant (and,
 * against a slow or unreachable remote, hang-prone) pull for that assumption.
 *
 * `onAuthFailure` is threaded through to runDoltStep -- see its AUTH SELF-HEAL
 * CONTRACT.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, checkSyncRemoteConfigured?: Function, skipPull?: boolean, onAuthFailure?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, skipped?: true, reason?: 'no-remote'|'empty-remote'|'already-fresh'|'remote-unchanged' }>}
 */
/**
 * Invoke the injected settle callback at a divergence terminal, if one is
 * wired. Returns the settle result on a verified recovery, or null when there
 * is no callback / settle itself failed -- in which case the caller surfaces
 * its typed error exactly as it did before settle existed.
 *
 * A settle failure is an OPERATIONAL failure (no usable dolt binary, server
 * would not start, a SQL statement errored), never "this conflict is
 * unresolvable" -- there is no such outcome. It is logged and folded into the
 * existing divergence terminal rather than being escalated anywhere.
 *
 * @param {{ settle?: Function, member: string, operation: string, error: Error, log: Function }} ctx
 * @returns {Promise<object|null>}
 */
async function attemptSettle({ settle, member, operation, error, log }) {
    if (typeof settle !== 'function') return null;
    log(`[Dolt] ${operation} for member '${member}' diverged; running settleDoltConflicts() (deterministic, no escalation) before surfacing BEADS_SYNC_CONFLICT.`);
    let result = null;
    try {
        result = await settle({ operation, error });
    } catch (settleErr) {
        log(`[Dolt] settle itself failed operationally for member '${member}' (treated as unrecovered; this is an infra failure, NOT an unresolvable conflict): ${(settleErr && settleErr.message) || settleErr}`);
        return null;
    }
    if (result && result.ok) {
        const tables = (result.resolvedTables || []).join(', ') || 'none';
        log(`[Dolt] settle RESOLVED the divergence for member '${member}' (tables: ${tables}) and republished; ${operation} reconciled.`);
        for (const warning of result.warnings || []) log(`[Dolt] settle warning for member '${member}': ${warning}`);
        return result;
    }
    log(`[Dolt] settle returned no verified recovery for member '${member}'; surfacing the divergence.`);
    return null;
}

// ---------------------------------------------------------------------------
// Remote-tip fingerprint: skip a D-pull only when the remote provably has not
// moved (dolt sync budget review, section B.1)
// ---------------------------------------------------------------------------
//
// THE CORRECTNESS ANCHOR. The shared remote's `refs/dolt/data` ref is the ONLY
// channel through which beads state moves between machines. A member's clone
// can therefore be stale in exactly one way: that ref advanced since the member
// last pulled or pushed. "Is a D-pull needed?" is then a question with a cheap,
// EXACT answer -- compare the remote SHA now against the SHA this member last
// synchronized to -- rather than a policy bet about who else might be writing.
// That is why this supersedes the role-based and time-based skip policies that
// were considered: those trade real staleness for speed (a reviewer reading
// acceptance criteria a remote doer just pushed is the exact false-FAILED-streak
// failure the post-streak verify pull exists to prevent), whereas a tip-equal
// skip removes only pulls that are provably no-ops.
//
// The probe is `git ls-remote <sync.remote> refs/dolt/data`: one network round
// trip, no Dolt engine startup, no 548MB chunk store to open (~0.35s measured,
// against multi-minute real pulls).
//
// THE RECORDED TIP is minted in exactly ONE place, and only ever from a value
// this member's clone is PROVABLY current with:
//   * after a successful PULL, record the SHA observed IMMEDIATELY BEFORE the
//     pull -- never one read afterwards. A push racing in during the pull then
//     simply forces the NEXT pull to be real, which is the safe error.
//   * after a successful PUSH by this member, FORGET the recorded tip. A push
//     never records anything -- see the block below for why.
//
// WHY A PUSH CANNOT MINT A FINGERPRINT (dolt sync budget review round 3,
// item 1 -- the correct redesign of two earlier attempts):
//
//   Attempt 1 recorded the remote SHA read AFTER the push, "still under the
//   push mutex". Attempt 2 read it before AND after, and recorded the post-push
//   SHA only when the ref had advanced ("it advanced, so I must have moved
//   it"). Both are wrong for the same reason: the push mutex serializes THIS
//   FLEET's pushes against each other and nothing else. Any unrelated machine
//   can push to the same shared remote in the gap between this member's push
//   completing and its post-push `git ls-remote` returning. The post-push read
//   then observes a stranger's newer commit that this clone has never seen,
//   records it as "my lastSyncedTip", and the very next D-pull is wrongly
//   skipped -- exactly the staleness this feature exists to prevent. A network
//   read of "the remote's current tip" is NEVER a proxy for "what my push
//   published".
//
//   The obvious local alternative -- record this clone's own commit SHA, the
//   thing a fast-forward push makes the remote ref equal to -- does not exist
//   for THIS transport. bd's git-backed remote (`git+https://...`) is Dolt's
//   git blobstore: a push wraps the chunk-store manifest in a FRESH git commit,
//   built inside the push on top of the remote head it just fetched, and
//   publishes it with a lease. That commit (and so the remote's new
//   refs/dolt/data SHA) is minted by the push itself, is not a function of
//   local Dolt state, is not printed by `bd dolt push` ("Pushing to Dolt
//   remote... / Push complete." either way), and lands locally only in a
//   per-process UUID-named ref (refs/dolt/blobstore/<remote>/dolt/data/<uuid>)
//   inside a sha256-named cache dir under .beads/ -- reachable only by a
//   shell-dialect-specific filesystem scan on the member, which is exactly the
//   kind of doubt this module refuses to turn into a skip. (Verified against a
//   live clone: the cache repo's tracking refs and FETCH_HEAD already disagreed
//   with the remote's live tip, and no stable local ref names the pushed SHA.)
//
//   So a successful push FORGETS the fingerprint. The remote is now at a SHA
//   this module cannot know; the pusher's next D-pull runs one real pull (after
//   one ls-remote that re-arms the skip for the pulls after it). That is the
//   conservative direction by construction: a redundant pull is the safe
//   error, a skipped needed pull is not. A NO-OP push (nothing local to
//   publish) is indistinguishable from a real one at this layer and is treated
//   the same way -- it proves nothing about the clone's freshness, so it may
//   not keep a fingerprint either. As a side effect no `git ls-remote` is
//   issued anywhere in the D-push bracket any more (round 3, item 3): the
//   mutex hold is now exactly push + reconcile + settle.
//
// FAIL-OPEN, ALWAYS. Every uncertainty -- no recorded tip yet, ls-remote failed
// or timed out, unparseable output, a sync.remote that could not be positively
// read, a URL outside the strict safe charset -- falls through to a REAL pull.
// The skip is only ever taken on a positive SHA match. There is deliberately no
// path in which doubt produces a skip.

/** member -> { sha, url }: the remote refs/dolt/data SHA this member is known
 *  to be current with, and the ls-remote URL it was observed at. Bound to the
 *  URL so a fingerprint can never validate a skip against a remote other than
 *  the one it was minted from (round 4 -- an agent-side `bd config set
 *  sync.remote` is the one reset a surviving fingerprint would otherwise get
 *  wrong; see noteMemberDispatchCompleted). Process-lifetime, same scope as
 *  the sync.remote memo. */
const lastSyncedTips = new Map();

/** Short timeout for the tip probe: it is one ls-remote round trip, and must
 *  never inherit the 600s budget sized for a real Dolt sync -- a probe that
 *  hangs has to fall through to the real pull quickly, not stall the bracket. */
const DOLT_TIP_PROBE_TIMEOUT_S = 30;

/** The ref every `bd dolt push` advances on a git-transport Dolt remote. */
const DOLT_DATA_REF = 'refs/dolt/data';

/** Never let the probe wait on a human (round-4 review, finding 2). The
 *  probe URL carries no userinfo (see toGitLsRemoteUrl), so on a member
 *  whose only credential for the host is the one embedded in sync.remote
 *  git would otherwise try to PROMPT: on a Windows member Git Credential
 *  Manager can block on a dialog until the 30s probe timeout, on every
 *  bracket. `credential.interactive=never` is GCM's own no-UI switch;
 *  `core.askPass=` (empty) disables any askpass program, so with no terminal
 *  attached git fails immediately instead of waiting. Passed as `-c` config
 *  because the command string must not rely on shell-level env assignment
 *  (the member's shell may be PowerShell). */
const GIT_NO_PROMPT_FLAGS = '-c credential.interactive=never -c core.askPass=';

/** After this many CONSECUTIVE failed probes a member's probe is disabled
 *  for the process (cleared by the hard seams): a member that cannot
 *  authenticate ls-remote, or whose sync.remote is a Dolt-native remote git
 *  cannot list, would otherwise pay a failed round trip on every bracket.
 *  Two, not one, so a single network blip does not cost the feature. */
export const DOLT_TIP_PROBE_MAX_CONSECUTIVE_FAILURES = 2;

/** member -> consecutive probe failures (a success resets to 0). */
const tipProbeFailures = new Map();

/**
 * Is `member`'s remote-tip probe currently disabled by the failure latch?
 * @param {string} member
 * @returns {boolean}
 */
export function isTipProbeDisabled(member) {
    return (tipProbeFailures.get(member) || 0) >= DOLT_TIP_PROBE_MAX_CONSECUTIVE_FAILURES;
}

/**
 * Reset the probe failure latch for `member` (or every member -- test
 * hygiene, alongside invalidateSyncRemoteCache() / clearLastSyncedTip()).
 * @param {string} [member]
 * @returns {number} how many entries were dropped
 */
export function clearTipProbeFailures(member) {
    if (member === undefined) {
        const n = tipProbeFailures.size;
        tipProbeFailures.clear();
        return n;
    }
    return tipProbeFailures.delete(member) ? 1 : 0;
}

/**
 * Strict safe-charset URL gate. The probe command string is handed to the
 * member's own shell, which may be PowerShell OR a POSIX shell, so rather than
 * trying to quote correctly for both this REFUSES any remote URL containing a
 * character outside a conservative set (no whitespace, no quote, no shell
 * metacharacter of either dialect). A rejected URL yields no fingerprint and a
 * real pull -- the safe direction.
 */
const SAFE_REMOTE_URL_RE = /^[A-Za-z0-9._~:/@+-]+$/;

/** A URL with an explicit scheme (`https://`, `ssh://`, `file://`, ...). */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The userinfo (`user@` or `user:password@`) of an http(s) URL. */
const HTTP_USERINFO_RE = /^(https?:\/\/)[^/@]*@/i;

/**
 * Convert a bd `sync.remote` value into the URL `git ls-remote` should be
 * pointed at, or null when it cannot be used safely.
 *
 * bd spells a git-transport Dolt remote `git+https://host/org/repo.git`; the
 * `git+` scheme prefix is bd's own marker and is NOT part of the git URL, so it
 * is stripped. Anything failing the safe-charset gate returns null.
 *
 * NOTE: this deliberately derives the probe target from sync.remote and NEVER
 * from git's `origin`. The two can legitimately differ on a member, and probing
 * origin would compare this member's freshness against the wrong ref.
 *
 * SCHEME REQUIRED (round 4, fix A). sync.remote may legitimately hold a bare
 * Dolt remote NAME (`origin` -- the integration fixtures set exactly that),
 * which passes the charset gate but is not a URL at all: handed to
 * `git ls-remote origin` it silently resolves against GIT'S OWN origin, the
 * very thing the note above forbids. A scheme-less value -- a remote name,
 * or a bare filesystem path (a Dolt file remote, never a git repository) --
 * therefore yields null: no fingerprint, a real pull.
 *
 * USERINFO STRIPPED (round 4, fix B). The probe string is journaled VERBATIM
 * as a persisted, dashboard-visible command record (the workflow's command()
 * records the command text; `silent` only suppresses the console line). A
 * sync.remote of the shape `git+https://x-access-token:ghp_...@host/...`
 * would bake that token into the record, whereas before this feature it only
 * ever appeared as command OUTPUT. So an http(s) userinfo is removed before
 * the URL becomes part of any command. The stripped URL still authenticates:
 * every provisioned member carries a git credential helper for its VCS host
 * (provision_vcs_auth writes it; that is how `git push` works on members
 * today), and a member whose ONLY credential was the embedded userinfo gets
 * a failed probe, which is the fail-open real pull, not a wrong skip. ssh
 * URLs keep their userinfo: `git@` is the login name, not a secret.
 *
 * @param {string|null|undefined} syncRemote
 * @returns {string|null}
 */
export function toGitLsRemoteUrl(syncRemote) {
    if (typeof syncRemote !== 'string') return null;
    const trimmed = syncRemote.trim();
    if (trimmed.length === 0) return null;
    let url = trimmed.startsWith('git+') ? trimmed.slice(4) : trimmed;
    if (url.length === 0) return null;
    if (!URL_SCHEME_RE.test(url)) return null;
    url = url.replace(HTTP_USERINFO_RE, '$1');
    if (!SAFE_REMOTE_URL_RE.test(url)) return null;
    return url;
}

/**
 * Parse `git ls-remote` output for the refs/dolt/data SHA. Output lines are
 * `<sha>\t<ref>`. Returns null on anything unrecognized -- an empty result, a
 * malformed line, or a ref that is not exactly refs/dolt/data -- so the caller
 * falls through to a real pull.
 *
 * @param {string|null|undefined} output
 * @returns {string|null}
 */
export function parseLsRemoteTip(output) {
    const text = String(output == null ? '' : output);
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([0-9a-f]{7,64})\s+(\S+)\s*$/i);
        if (m && m[2] === DOLT_DATA_REF) return m[1].toLowerCase();
    }
    return null;
}

/**
 * Read the shared remote's current refs/dolt/data SHA for `member`, via one
 * `git ls-remote` on that member. Never throws: any failure returns null and
 * the caller treats that as "unknown", i.e. do the real thing.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, url: string }} ctx
 * @returns {Promise<string|null>}
 */
async function readRemoteDoltTip(member, { command, log = () => {}, url }) {
    const sha = await readRemoteDoltTipOnce(member, { command, log, url });
    if (sha) {
        tipProbeFailures.delete(member);
        return sha;
    }
    const failures = (tipProbeFailures.get(member) || 0) + 1;
    tipProbeFailures.set(member, failures);
    if (failures === DOLT_TIP_PROBE_MAX_CONSECUTIVE_FAILURES) {
        log(`[Dolt] remote-tip probe for member '${member}' failed ${failures} times in a row; disabling the probe for this member for the rest of the run (every D-pull is real, as before the fingerprint existed).`);
    }
    return null;
}

async function readRemoteDoltTipOnce(member, { command, log, url }) {
    let res;
    try {
        res = await command(`git ${GIT_NO_PROMPT_FLAGS} ls-remote ${url} ${DOLT_DATA_REF}`, {
            member_name: member,
            silent: true,
            failSoft: true,
            label: `Dolt remote-tip probe for '${member}'`,
            timeout_s: DOLT_TIP_PROBE_TIMEOUT_S,
        });
    } catch (err) {
        log(`[Dolt] remote-tip probe for member '${member}' threw (falling through to a real pull): ${(err && err.message) || err}`);
        return null;
    }
    if (!res || res.ok === false) {
        log(`[Dolt] remote-tip probe for member '${member}' failed (falling through to a real pull): ${res ? res.error : 'no result'}`);
        return null;
    }
    const sha = parseLsRemoteTip(typeof res === 'object' ? res.output : res);
    if (!sha) {
        log(`[Dolt] remote-tip probe for member '${member}' returned no parseable ${DOLT_DATA_REF} SHA (falling through to a real pull).`);
        return null;
    }
    return sha;
}

/**
 * Resolve the ls-remote URL for `member` from the MEMOIZED sync.remote probe,
 * or null when it cannot be positively read / is not safely usable. Returns
 * null without probing when `command` is missing.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function }} ctx
 * @returns {Promise<string|null>}
 */
async function resolveTipProbeUrl(member, { command, log }) {
    if (typeof command !== 'function') return null;
    if (isTipProbeDisabled(member)) return null;
    const { url } = await readMemberSyncRemote(member, { command, log });
    return toGitLsRemoteUrl(url);
}

/**
 * The SHA `member` is currently known to be synchronized with, or undefined.
 * @param {string} member
 * @returns {string|undefined}
 */
export function getLastSyncedTip(member) {
    const entry = lastSyncedTips.get(member);
    return entry ? entry.sha : undefined;
}

/**
 * Record the SHA `member` is now synchronized with, observed at ls-remote
 * URL `url`. Both are required: a tip with no URL to bind it to is doubt,
 * and doubt never produces a skip, so it is not recorded at all. Exported for
 * the tests and for any future call site that learns the tip out of band.
 * @param {string} member
 * @param {string} sha
 * @param {string} url - the exact `git ls-remote` target the SHA was read at
 */
export function setLastSyncedTip(member, sha, url) {
    if (typeof sha !== 'string' || sha.length === 0) return;
    if (typeof url !== 'string' || url.length === 0) return;
    lastSyncedTips.set(member, { sha, url });
}

/**
 * Decide whether `member`'s D-pull may be skipped: the observed remote tip
 * must equal the recorded one, at the same URL -- and if the member has been
 * dispatched to since its sync.remote memo was last positively read, that
 * memo is re-read FIRST and must still name the same URL. See
 * noteMemberDispatchCompleted for the reasoning.
 *
 * @param {string} member
 * @param {{ observedTip: string, probeUrl: string, command: Function, log: Function }} ctx
 * @returns {Promise<{ skip: boolean, reason?: 'remote-unchanged'|'no-remote', recordable: boolean }>}
 *   `recordable` is false when the probe turned out to target the wrong
 *   remote, so the caller must not mint a fingerprint from `observedTip`
 *   after its pull. `reason: 'no-remote'` means the re-read found sync.remote
 *   positively ABSENT: the pre-gate's own contract then applies (no `bd dolt`
 *   command may be issued against a neutralized clone), so the caller takes
 *   the no-remote exit rather than a real pull.
 */
async function confirmSkipAfterDispatch(member, { observedTip, probeUrl, command, log }) {
    const recorded = lastSyncedTips.get(member);
    if (!recorded || recorded.sha !== observedTip || recorded.url !== probeUrl) {
        return { skip: false, recordable: true };
    }
    if (!dispatchedSinceVerified.has(member)) return { skip: true, reason: 'remote-unchanged', recordable: true };
    const fresh = await readMemberSyncRemote(member, { command, log, verify: true });
    if (!fresh.positive) {
        log(`[Dolt] D-pull for member '${member}': remote tip matches the recorded fingerprint, but sync.remote could not be re-read after a dispatch to this member -- pulling for real rather than skipping on an unconfirmed remote.`);
        return { skip: false, recordable: true };
    }
    if (!fresh.configured) {
        log(`[Dolt] D-pull for member '${member}': sync.remote was neutralized under a dispatch; forgetting the fingerprint -- no pull command issued`);
        clearLastSyncedTip(member);
        return { skip: true, reason: 'no-remote', recordable: false };
    }
    const freshUrl = toGitLsRemoteUrl(fresh.url);
    if (freshUrl === probeUrl) return { skip: true, reason: 'remote-unchanged', recordable: true };
    log(`[Dolt] D-pull for member '${member}': sync.remote changed under a dispatch (fingerprint was minted against a different remote); forgetting the fingerprint and pulling for real.`);
    clearLastSyncedTip(member);
    return { skip: false, recordable: false };
}

/**
 * Forget `member`'s recorded tip (or every member's -- test hygiene). A
 * forgotten tip means the next D-pull is real, never skipped.
 * @param {string} [member]
 * @returns {number} how many entries were dropped
 */
export function clearLastSyncedTip(member) {
    if (member === undefined) {
        const n = lastSyncedTips.size;
        lastSyncedTips.clear();
        return n;
    }
    return lastSyncedTips.delete(member) ? 1 : 0;
}

export async function doltPullBefore(member, opts = {}) {
    // `maxTransientRetries` is deliberately NOT defaulted here: runDoltStep()
    // must see whether the caller passed it (an explicit value caps both
    // retry ladders; undefined selects each ladder's own default).
    const { command, log = () => {}, maxTransientRetries, checkSyncRemoteConfigured, skipPull = false, onAuthFailure, sleep, backoffBaseMs, timeoutS, settle, remoteTipFingerprint = true, spawnOutageBudgetMs, now } = opts;
    if (typeof command !== 'function') {
        throw new Error("doltPullBefore requires an injected command() in opts");
    }

    // Gate BEFORE issuing, so a neutralized clone never lets `bd dolt` re-arm
    // a Dolt-level remote as a side effect (see the doc comment above).
    const preGateCheckFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
    if (!(await preGateCheckFn(member, { command, log }))) {
        log(`[Dolt] D-pull for member '${member}' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no pull command issued`);
        return { ok: true, member, skipped: true, reason: 'no-remote' };
    }

    // skipPull suppresses only the `bd dolt pull` SPAWN; the pre-gate probe
    // above still runs, so a sync.remote-absent clone issues an identical
    // command sequence with or without this flag.
    if (skipPull) {
        log(`[Dolt] D-pull for member '${member}': skipping the 'bd dolt pull' spawn (beads clone already freshened by the orchestrator's pre-sprint D-pull, nothing mutated since -- first Planner dispatch).`);
        return { ok: true, member, skipped: true, reason: 'already-fresh' };
    }

    // Remote-tip fingerprint (see the section comment above doltPullBefore).
    // `observedTip` is the SHA read BEFORE the pull; it is only committed to
    // lastSyncedTips once the pull below actually succeeds.
    let observedTip = null;
    let probeUrl = null;
    if (remoteTipFingerprint) {
        probeUrl = await resolveTipProbeUrl(member, { command, log });
        if (probeUrl) {
            observedTip = await readRemoteDoltTip(member, { command, log, url: probeUrl });
            if (observedTip) {
                const verdict = await confirmSkipAfterDispatch(member, { observedTip, probeUrl, command, log });
                if (verdict.skip && verdict.reason === 'no-remote') {
                    return { ok: true, member, skipped: true, reason: 'no-remote' };
                }
                if (verdict.skip) {
                    log(`[Dolt] D-pull for member '${member}' skipped: remote ${DOLT_DATA_REF} is unchanged at ${observedTip} since this member last synchronized -- the shared remote is the only cross-machine channel, so the clone is provably current.`);
                    return { ok: true, member, skipped: true, reason: 'remote-unchanged', remoteTip: observedTip };
                }
                if (!verdict.recordable) observedTip = null;
            }
        }
    }

    const pull = await runDoltStep({
        command, member, cmd: 'bd dolt pull',
        label: `D-pull for '${member}'`, log, maxTransientRetries, onAuthFailure, sleep, backoffBaseMs, timeoutS, spawnOutageBudgetMs, now,
    });
    if (!pull.ok) {
        if (pull.kind === 'no-remote') {
            log(`[Dolt] D-pull for member '${member}' skipped: no dolt remote configured (nothing to pull)`);
            return { ok: true, member, skipped: true, reason: 'no-remote' };
        }
        if (pull.kind === 'empty-remote') {
            // sync.remote IS configured but has never had anything pushed
            // into it -- nothing to reconcile, so this is a benign no-op, not
            // a divergence. Genuine conflicts still fall through to the
            // DoltDivergedError branch below.
            log(`[Dolt] D-pull for member '${member}' skipped: dolt remote has zero branches (nothing pushed yet, nothing to pull)`);
            return { ok: true, member, skipped: true, reason: 'empty-remote' };
        }
        if (pull.kind === 'diverged') {
            // The pull-side divergence terminal. Before this was wired
            // (docs/dolt-sync-redesign.md Part 2.3), a clone wedged by an
            // earlier failed reconcile had NO recovery seam here at all and
            // hard-aborted the next sprint at its readiness gate.
            const diverged = new DoltDivergedError(
                `[Dolt] D-pull for member '${member}' hit an unmergeable beads conflict and must not be auto-resolved by judgment: ${pull.error}`,
                { member, doltOutput: pull.error, operation: 'pull' },
            );
            // A divergence (and any settle that republishes to resolve it)
            // leaves this clone at a tip we did not observe -- forget the
            // recorded fingerprint so the next D-pull is unconditionally real
            // rather than skipped against a stale SHA.
            clearLastSyncedTip(member);
            const settled = await attemptSettle({ settle, member, operation: 'D-pull', error: diverged, log });
            if (settled) {
                // settle ends with its own `bd dolt pull` + `bd dolt push`, so
                // a resolved settle means this clone is already current --
                // there is nothing left for this bracket to pull.
                return { ok: true, member, recovered: true, settledTables: settled.resolvedTables || [] };
            }
            throw diverged;
        }
        if (pull.kind === 'auth') {
            // apra-fleet-spp: a credential failure is its own class. It is NOT
            // a divergence (nothing conflicted) and must not be described as
            // one; the remedy is re-provisioning this member's VCS auth, which
            // the bounded one-shot onAuthFailure self-heal above already tried.
            throw new DoltSyncError(
                `[Dolt] D-pull for member '${member}' failed on VCS CREDENTIALS, not a data divergence -- re-provision the member's VCS auth (provision_vcs_auth) and retry. Raw: ${pull.error}`,
                { member, doltOutput: pull.error, details: { kind: 'auth', operation: 'pull' } },
            );
        }
        if (pull.kind === 'remote-unreachable') {
            const url = extractDoltRemoteUrl(pull.error);
            throw new DoltSyncError(
                `[Dolt] member '${member}' beads sync remote is unreachable/misconfigured${url ? ` (${url})` : ''} -- the clone's sync.remote points at a path or URL that cannot be opened (e.g. a deleted test sandbox). Repair the member's .beads sync remote before re-running; retrying cannot succeed. Raw: ${pull.error}`,
                { member, doltOutput: pull.error, remoteUrl: url },
            );
        }
        throw new DoltSyncError(
            `[Dolt] D-pull failed for member '${member}': ${pull.error}`,
            { member, doltOutput: pull.error },
        );
    }

    // The pull landed, so this clone is current with the remote AS OF the SHA
    // read BEFORE it. Deliberately not a post-pull read: a push that raced in
    // during the pull is not included in what we just fetched, and recording
    // the later SHA would claim freshness this clone does not have. Recording
    // the earlier one can only cost one redundant future pull.
    if (observedTip && probeUrl) setLastSyncedTip(member, observedTip, probeUrl);

    return { ok: true, member };
}

/**
 * Best-effort extraction of the beads/dolt table name(s) implicated in a
 * diverged `bd dolt pull`'s raw output, for preflightBeadsHealthGate()'s
 * one-line cause. Dolt's conflict text has no single stable grammar (it
 * varies with the conflict kind -- schema vs data, pull vs merge), so this
 * matches several shapes (`table <name>`, `` `<name>` table``, `conflict in
 * <name>`) rather than assuming a canonical format. Never throws; an output
 * with no recognizable table name returns `[]` so the caller can say
 * 'unknown' explicitly rather than silently omit the field.
 *
 * @param {string|null|undefined} doltOutput
 * @returns {string[]}
 */
export function extractConflictingTables(doltOutput) {
    const text = String(doltOutput == null ? '' : doltOutput);
    const tables = new Set();
    const patterns = [
        /\btables?\s+`?([A-Za-z_][\w.]*)`?/gi,
        /`([A-Za-z_][\w.]*)`\s+table/gi,
        /conflict(?:s|ed)? in\s+`?([A-Za-z_][\w.]*)`?/gi,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
            tables.add(m[1]);
        }
    }
    return [...tables];
}

/**
 * Pre-flight beads-health gate: the same D-pull probe as doltPullBefore(),
 * run before a sprint issues any mutating git or PR command, so a diverged
 * beads clone aborts the run before setup has changed anything.
 *
 * On divergence it composes and logs a single actionable line matching
 * /beads DB diverged/ naming the workspace path (a best-effort `pwd` probe on
 * `member`, falling back to the member id -- diagnostics must never block the
 * abort or throw a second, different error), the conflicting table(s) from
 * extractConflictingTables() (or 'unknown'), and the remediation text. That
 * composed string becomes the re-thrown DoltDivergedError's `.message`, which
 * the typed-abort handling persists verbatim, so one string reaches both the
 * main log and the dashboard.
 *
 * Any non-divergence outcome (DoltSyncError, or a benign skip) is passed
 * through unchanged -- it already carries doltPullBefore()'s own message.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, checkSyncRemoteConfigured?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, skipped?: true, reason?: 'no-remote'|'empty-remote'|'already-fresh'|'remote-unchanged' }>}
 */
export async function preflightBeadsHealthGate(member, opts = {}) {
    const { command, log = () => {} } = opts;
    try {
        return await doltPullBefore(member, opts);
    } catch (err) {
        if (!(err instanceof DoltDivergedError)) {
            throw err;
        }
        let workspace = member;
        try {
            const pwdRes = await command('pwd', {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Resolve workspace path for member '${member}' (beads-health gate diagnostics)`,
            });
            if (pwdRes && pwdRes.ok && String(pwdRes.output || '').trim()) {
                workspace = String(pwdRes.output).trim();
            }
        } catch (pwdErr) {
            log(`[Beads Health] could not resolve workspace path for member '${member}' (falling back to member id): ${(pwdErr && pwdErr.message) || pwdErr}`);
        }
        const tables = extractConflictingTables(err.doltOutput);
        const tablesText = tables.length > 0 ? tables.join(', ') : 'unknown';
        const cause =
            `[Beads Health] beads DB diverged from the shared Dolt remote (member '${member}', workspace: ${workspace}; ` +
            `conflicting table(s): ${tablesText}) -- local beads DB diverged from remote; resolve or re-init from the ` +
            `shared remote, then relaunch.`;
        log(cause);
        throw new DoltDivergedError(cause, { member, doltOutput: err.doltOutput, operation: err.operation });
    }
}

/**
 * D-push: publish `member`'s committed beads changes to the shared remote
 * after a beads-mutating step -- `bd dolt push` with a mechanical,
 * first-successful-pusher-wins reconcile. If the push is rejected because the
 * remote moved first, do EXACTLY ONE `bd dolt pull` (reconciling ours/theirs
 * by which clone resolves -- never per-conflict judgment) and re-push once; if
 * that is still rejected, raise a typed DoltDivergedError. Transient (network
 * / server / lock) failures are retried up to `maxTransientRetries`; a
 * divergence is never retried beyond the one bounded reconcile.
 *
 * `pushBeads: false` makes this a no-op (a read-only bracket has nothing to
 * publish). Every command is issued via the injected command() with an
 * explicit member_name.
 *
 * The actual push is serialized behind a GLOBAL push mutex because two
 * concurrent dolt pushes can produce row-level conflicts, and a single
 * unresolved conflict wedges an entire clone's sync. `opts.mutex` is a client
 * with acquire()/release(); it is acquired before the first push attempt and
 * released in a `finally` on EVERY terminal path -- success, transient
 * exhaustion, and divergence -- so a failed push can never leak it. A crashed
 * holder is reclaimed by the mutex's own lease expiry, not by this bracket.
 *
 * Two paths return the benign `{ ok: true, pushed: false, reconciled: false,
 * skipped: true, reason: 'no-remote' }` instead of throwing: a 'no-remote'
 * classification, and -- defense in depth -- any non-diverged failure
 * classifyDoltFailure cannot recognize as 'no-remote' from stderr alone (e.g.
 * a credentials error from a mis-wired Dolt-level remote) when `member`'s
 * bd-level sync.remote is itself absent/neutralized, since nothing is
 * supposed to leave such a clone. A clone with an actively configured
 * sync.remote still throws DoltSyncError on that failure. Override the check
 * with `opts.checkSyncRemoteConfigured` (same `(member, {command, log}) =>
 * Promise<boolean>` shape) in tests.
 *
 * `onAuthFailure` is threaded through to every runDoltStep call below
 * (including the reconcile/re-push) -- see runDoltStep's AUTH SELF-HEAL
 * CONTRACT.
 *
 * REMOTE-TIP FINGERPRINT: a successful push (first attempt or the re-push
 * after the one reconcile) FORGETS this member's recorded tip and issues no
 * `git ls-remote` at all -- see "WHY A PUSH CANNOT MINT A FINGERPRINT" above
 * doltPullBefore. The pusher's next D-pull is therefore always real.
 *
 * `opts.settle` is the optional deterministic conflict-settlement callback
 * (buildSettleCallback, dolt-settle.mjs). When present, a divergence that
 * outlives the bounded reconcile runs settle before the DoltDivergedError is
 * surfaced as BEADS_SYNC_CONFLICT; when absent the divergence propagates
 * immediately (pre-settle behavior).
 *
 * @param {string} member
 * @param {{ command: Function, pushBeads?: boolean, log?: Function, maxTransientRetries?: number, mutex?: { acquire: Function, release: Function }, sprintId?: string, checkSyncRemoteConfigured?: Function, onAuthFailure?: Function, settle?: () => Promise<{ ok: boolean, resolvedTables?: string[] }> }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, reconciled: boolean, skipped?: true, reason?: 'no-remote', recovered?: true, settledTables?: string[] }>}
 */
export async function doltPushAfter(member, opts = {}) {
    // `maxTransientRetries` is deliberately NOT defaulted here -- see
    // doltPullBefore. `remoteTipFingerprint` is accepted for call-site parity
    // with doltPullBefore but has nothing to switch off on the push side any
    // more: a push never probes and never records (it only forgets).
    const { command, pushBeads = true, log = () => {}, maxTransientRetries, mutex, sprintId, checkSyncRemoteConfigured, onAuthFailure, sleep, backoffBaseMs, timeoutS, settle, renewIntervalMs = DOLT_MUTEX_RENEW_INTERVAL_MS, spawnOutageBudgetMs, now } = opts;
    if (typeof command !== 'function') {
        throw new Error("doltPushAfter requires an injected command() in opts");
    }

    if (!pushBeads) {
        return { ok: true, member, pushed: false, reconciled: false };
    }

    // Gate BEFORE issuing: bd auto-provisions a Dolt-level remote from git's
    // own origin on the push attempt itself, so merely ATTEMPTING the push on
    // a clone with valid credentials can succeed against the real shared
    // remote even though bd-level sync.remote is neutralized. The check fails
    // CLOSED (any inconclusive read reports configured), so it can only ever
    // suppress a push that was already declared must not happen. The
    // failure-path downgrade below stays as defense in depth.
    const preGateCheckFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
    // apra-fleet-7h6n.5: cache the pre-gate's boolean result so the
    // failure-path downgrade below (which used to re-invoke the same probe a
    // second time in this call) can reuse it instead of re-probing. By the
    // time the failure path runs, this pre-gate has already returned `true`
    // (a `false` result exits right here), so reusing it there is
    // behavior-preserving, not a new assumption.
    const syncRemoteConfiguredAtPreGate = await preGateCheckFn(member, { command, log });
    if (!syncRemoteConfiguredAtPreGate) {
        log(`[Dolt] D-push for member '${member}' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no push command issued`);
        return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
    }

    // Serialize this push behind the global mutex: acquire (waiting our FIFO
    // turn) before touching the remote; release on every exit.
    //
    // LEASE RENEWAL (docs/dolt-sync-redesign.md Part 3.4): the mutex lease is
    // 60s and reclaimExpired() force-evicts at expiry EVEN IF the holder is
    // alive. This bracket can legitimately outlive that -- a push, a reconcile
    // pull, and now a full settle (ephemeral server spawn + merge + resolve +
    // republish) -- so acquiring once and never renewing silently loses mutual
    // exclusion mid-operation. Renew on an interval well under the lease while
    // we hold it, and stop renewing in the same `finally` that releases.
    let grant = null;
    if (mutex && typeof mutex.acquire === 'function') {
        grant = await mutex.acquire(sprintId || member, { pid: process.pid });
    }
    let renewTimer = null;
    if (grant && mutex && typeof mutex.renew === 'function') {
        renewTimer = setInterval(() => {
            Promise.resolve()
                .then(() => mutex.renew(grant.token))
                .then((renewed) => {
                    if (renewed === false) {
                        log(`[Dolt] mutex lease renewal for member '${member}' was REFUSED (the lease was already reclaimed) -- another sprint may now hold the push mutex.`);
                    }
                })
                .catch((renewErr) => {
                    log(`[Dolt] mutex lease renewal for member '${member}' failed (non-fatal; the lease may expire): ${(renewErr && renewErr.message) || renewErr}`);
                });
        }, renewIntervalMs);
        if (typeof renewTimer.unref === 'function') renewTimer.unref();
    }
    try {
        return await doltPushGuarded();
    } finally {
        if (renewTimer) clearInterval(renewTimer);
        if (grant && mutex && typeof mutex.release === 'function') {
            try {
                await mutex.release(grant.token);
            } catch (relErr) {
                log(`[Dolt] mutex release after D-push for member '${member}' failed (non-fatal; lease will expire): ${relErr.message}`);
            }
        }
    }

    // The push-side divergence terminal. A divergence that outlives the
    // bounded first-successful-pusher-wins reconcile is exactly the
    // wedged-clone failure settleDoltConflicts() exists for. When an
    // `opts.settle` callback is wired (runner.js builds it via
    // buildSettleCallback and threads it through DoltSync.syncAfter), this
    // terminal runs it, and only surfaces the DoltDivergedError (which
    // runner.js classifies as the terminal BEADS_SYNC_CONFLICT) if settle
    // itself failed operationally. Unlike the retired Tier 2, a settle that
    // resolves IS a verified recovery: it republishes and verifies the push
    // before returning. With no settle callback wired the behavior is
    // unchanged: the DoltDivergedError propagates immediately.
    async function surfaceDivergence(divergedError, operation) {
        // Either terminal leaves the remote at a SHA this member never
        // observed (settle republishes; an unrecovered divergence leaves the
        // clone wedged), so drop the fingerprint and force a real next pull.
        clearLastSyncedTip(member);
        const settled = await attemptSettle({ settle, member, operation: `D-push (${operation})`, error: divergedError, log });
        if (settled) {
            return { ok: true, member, pushed: true, reconciled: true, recovered: true, settledTables: settled.resolvedTables || [] };
        }
        throw divergedError;
    }

    /**
     * A push landed. The remote's refs/dolt/data is now a SHA minted inside
     * the push that this module has no local, network-free way to learn (see
     * "WHY A PUSH CANNOT MINT A FINGERPRINT" above doltPullBefore), and any
     * post-push network read could observe an unrelated machine's later push
     * instead of ours. So the only correct bookkeeping is to FORGET whatever
     * fingerprint this member carried: the next D-pull is real. Local-only,
     * no command is issued.
     */
    function forgetTipAfterPush() {
        if (clearLastSyncedTip(member) > 0) {
            log(`[Dolt] D-push for member '${member}' landed; forgetting its remote-tip fingerprint (the remote is now at a SHA only the push knows) so the next D-pull is real.`);
        }
    }

    async function doltPushGuarded() {
    let push = await runDoltStep({
        command, member, cmd: 'bd dolt push',
        label: `D-push for '${member}'`, log, maxTransientRetries, onAuthFailure, sleep, backoffBaseMs, timeoutS, spawnOutageBudgetMs, now,
    });
    if (push.ok) {
        forgetTipAfterPush();
        return { ok: true, member, pushed: true, reconciled: false };
    }

    if (push.kind === 'no-remote') {
        log(`[Dolt] D-push for member '${member}' skipped: no dolt remote configured (nothing to push)`);
        return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
    }

    if (push.kind !== 'diverged') {
        // Transient-exhausted or unknown failure -- not a divergence, so no
        // reconcile. Before surfacing it as fatal, consult the member's OWN
        // bd-level sync.remote, independent of Dolt's raw remote wiring and
        // of classifyDoltFailure's stderr pattern matching (which can
        // misclassify a neutralized-sandbox failure as 'unknown'). An
        // absent sync.remote means nothing is supposed to be pushed from this
        // clone, so the failure is the same benign no-remote skip.
        // apra-fleet-7h6n.5: reuse the pre-gate's cached probe result instead
        // of re-invoking checkSyncRemoteConfigured/isMemberSyncRemoteConfigured
        // a second time -- see the pre-gate's comment above for why this is
        // always `true` by the time this failure path is reachable.
        const syncRemoteConfigured = syncRemoteConfiguredAtPreGate;
        if (!syncRemoteConfigured) {
            log(`[Dolt] D-push for member '${member}' skipped: no dolt remote configured (bd-level sync.remote neutralized/absent; push failure treated as benign: ${push.error})`);
            return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
        }
        if (push.kind === 'auth') {
            // apra-fleet-spp: the live 2026-08-02 fleet-mac failure. This used
            // to reach the reconcile ladder and end as DoltDivergedError
            // ("still rejected after one reconcile pull"), which was simply
            // false -- nothing had diverged. It is now its own terminal class,
            // reached only after the bounded one-shot auth self-heal above.
            throw new DoltSyncError(
                `[Dolt] D-push for member '${member}' failed on VCS CREDENTIALS, not a data divergence -- re-provision the member's VCS auth (provision_vcs_auth) and retry. Raw: ${push.error}`,
                { member, doltOutput: push.error, details: { kind: 'auth', operation: 'push' } },
            );
        }
        if (push.kind === 'remote-unreachable') {
            const url = extractDoltRemoteUrl(push.error);
            throw new DoltSyncError(
                `[Dolt] member '${member}' beads sync remote is unreachable/misconfigured${url ? ` (${url})` : ''} -- the clone's sync.remote points at a path or URL that cannot be opened (e.g. a deleted test sandbox). Repair the member's .beads sync remote before re-running; retrying cannot succeed. Raw: ${push.error}`,
                { member, doltOutput: push.error, remoteUrl: url },
            );
        }
        throw new DoltSyncError(
            `[Dolt] D-push for member '${member}' failed: ${push.error}`,
            { member, doltOutput: push.error },
        );
    }

    // Push loser: reconcile MECHANICALLY with EXACTLY ONE D-pull (ours/theirs
    // fixed by which clone resolves -- first-successful-pusher-wins), then one
    // re-push.
    log(`[Dolt] D-push for member '${member}' was rejected (another writer pushed first); reconciling with a single D-pull then one re-push (first-successful-pusher-wins).`);
    const reconcile = await runDoltStep({
        command, member, cmd: 'bd dolt pull',
        label: `D-push reconcile pull for '${member}'`, log, maxTransientRetries, onAuthFailure, sleep, backoffBaseMs, timeoutS, spawnOutageBudgetMs, now,
    });
    if (!reconcile.ok) {
        if (reconcile.kind === 'diverged') {
            return await surfaceDivergence(
                new DoltDivergedError(
                    `[Dolt] D-push reconcile pull for member '${member}' hit an unmergeable beads conflict -- must not be retried blindly: ${reconcile.error}`,
                    { member, doltOutput: reconcile.error, operation: 'push-reconcile' },
                ),
                'push-reconcile',
            );
        }
        throw new DoltSyncError(
            `[Dolt] D-push reconcile pull for member '${member}' failed: ${reconcile.error}`,
            { member, doltOutput: reconcile.error },
        );
    }

    push = await runDoltStep({
        command, member, cmd: 'bd dolt push',
        label: `D-push re-push after reconcile for '${member}'`, log, maxTransientRetries, onAuthFailure, sleep, backoffBaseMs, timeoutS, spawnOutageBudgetMs, now,
    });
    if (push.ok) {
        forgetTipAfterPush();
        return { ok: true, member, pushed: true, reconciled: true };
    }

    if (push.kind === 'auth') {
        // apra-fleet-spp.3: same mislabel class as the first-push/pull paths,
        // just reached via the post-reconcile re-push -- a credential that
        // lapsed mid-reconcile is not a data divergence, so it must not be
        // folded into DoltDivergedError below.
        throw new DoltSyncError(
            `[Dolt] D-push re-push after reconcile for member '${member}' failed on VCS CREDENTIALS, not a data divergence -- re-provision the member's VCS auth (provision_vcs_auth) and retry. Raw: ${push.error}`,
            { member, doltOutput: push.error, details: { kind: 'auth', operation: 'push-reconcile-repush' } },
        );
    }

    // Still rejected after the one bounded reconcile, and not an auth failure.
    return await surfaceDivergence(
        new DoltDivergedError(
            `[Dolt] D-push for member '${member}' still rejected after one reconcile pull -- refusing to retry further: ${push.error}`,
            { member, doltOutput: push.error, operation: 'push' },
        ),
        'push',
    );
    } // end doltPushGuarded
}

// ---------------------------------------------------------------------------
// Structured outcomes and the bounded DEGRADED-BUT-NON-FATAL path
// (apra-fleet-417.3.1 / apra-fleet-417.3)
// ---------------------------------------------------------------------------
//
// PRODUCT DECISION (417.3, do not relitigate): concurrent multi-agent dolt
// push/pull is a NORMAL condition, and a beads-sync hiccup must never
// hard-abort an otherwise healthy sprint. The primitives above still THROW --
// that is what the fatal call sites and the existing DoltDivergedError /
// DoltSyncError consumers (terminal-reason resolution, conflict-dump capture,
// PostDispatchSyncError wrapping) rely on. What changes here is the DEFAULT at
// the purpose-based entry points: syncBefore()/syncAfter() answer with a
// STRUCTURED OUTCOME instead of throwing, and a hard abort is now something a
// call site asks for EXPLICITLY (`fatal: true`), not what it gets by accident.
//
// Outcome shape (a superset of the primitives' old return objects, so every
// existing consumer of `.skipped` / `.reason` / `.pushed` / `.reconciled`
// keeps working unchanged):
//
//   { ok, kind, degraded, detail, member, operation, error?, ...legacy fields }
//
//   ok        -- did the sync do what it was asked to do (a benign skip is ok)
//   kind      -- 'synced' | 'no-remote' | 'empty-remote' | 'already-fresh'
//                | 'remote-unchanged' | 'diverged' | 'auth' | 'transient'
//                | 'remote-unreachable' | 'unknown'
//   degraded  -- true when the sync FAILED and the sprint is continuing anyway
//   detail    -- one human-readable line (the underlying error's message)
//   error     -- the underlying typed error, retained for later escalation
//
// VISIBILITY: a degraded outcome is never silent. It is logged loudly, passed
// to the optional `onDegraded` hook (the seam a caller uses to file a flagged
// follow-up bead), and appended to a module-level record list that
// getDegradedSyncRecords() exposes so a sprint can report "these syncs did not
// land". A record for `member` is retired when a later syncAfter() for the same
// member succeeds -- i.e. the NEXT bracket IS the queued retry; no separate
// retry timer exists or is wanted.

const degradedSyncRecords = [];

/**
 * Append a degraded-sync record to the module-level visibility list.
 *
 * @param {{ member: string, operation: string, kind: string, detail: string }} record
 * @returns {object} the stored record (timestamped)
 */
export function recordDegradedSync(record) {
    const stored = { at: new Date().toISOString(), pendingRetry: true, ...record };
    degradedSyncRecords.push(stored);
    return stored;
}

/**
 * Every degraded sync recorded so far this process, oldest first. Optionally
 * filtered to one member. Returns copies: callers cannot mutate the log.
 *
 * @param {{ member?: string, pendingOnly?: boolean }} [filter]
 * @returns {object[]}
 */
export function getDegradedSyncRecords(filter = {}) {
    const { member, pendingOnly = false } = filter;
    return degradedSyncRecords
        .filter((r) => (member ? r.member === member : true))
        .filter((r) => (pendingOnly ? r.pendingRetry : true))
        .map((r) => ({ ...r }));
}

/**
 * Retire this member's pending degraded records after a later sync for the
 * same member succeeded (the queued retry landed). With no member, clears the
 * whole list -- test hygiene only.
 *
 * @param {string} [member]
 * @returns {number} how many records were retired
 */
export function clearDegradedSyncRecords(member) {
    if (member === undefined) {
        const n = degradedSyncRecords.length;
        degradedSyncRecords.length = 0;
        return n;
    }
    let n = 0;
    for (const r of degradedSyncRecords) {
        if (r.member === member && r.pendingRetry) {
            r.pendingRetry = false;
            r.resolvedAt = new Date().toISOString();
            n += 1;
        }
    }
    return n;
}

/**
 * Classify a thrown dolt-sync error into an outcome `kind`. A DoltDivergedError
 * is 'diverged' by construction; anything else is re-derived from its captured
 * raw dolt output, so a credential failure reports 'auth' (never 'diverged') --
 * apra-fleet-spp.
 *
 * @param {Error} err
 * @returns {string}
 */
export function classifySyncError(err) {
    if (err instanceof DoltDivergedError) return 'diverged';
    const raw = err && err.doltOutput ? err.doltOutput : (err && err.message) || '';
    const kind = classifyDoltFailure(raw);
    return kind === 'unknown' && !(err instanceof DoltSyncError) ? 'error' : kind;
}

// ---------------------------------------------------------------------------
// Backend-neutral degraded.kind taxonomy (docs/adr-taskdb-backend-neutral-
// interface.md Decision 2, apra-fleet-417.5)
// ---------------------------------------------------------------------------
//
// The ADR's TaskDBModule contract carries failure classification in a
// backend-neutral vocabulary: 'transient', 'auth', 'conflict-resolvable',
// 'conflict-unresolvable', 'store-unreachable', 'no-store',
// 'coordination-unavailable', 'unknown'. The adapter-level `kind` this module
// already produces (classifyDoltFailure / classifySyncError) stays exactly as
// it is -- runner.js and the fault-tolerance/health-gate test suites branch on
// its Dolt-flavored values ('diverged', 'no-remote', 'remote-unreachable',
// ...) today, and `degraded` is a hard boolean those same suites assert with
// `assert.equal(outcome.degraded, true/false)`. Neither can change shape
// without breaking passing tests, so the neutral taxonomy is exposed as a
// SIBLING field, `degradedKind`, set only when `degraded: true`, rather than
// nesting it under `degraded` the way the ADR's prose literally shows.
//
// This mapping is the adapter's declaration of "which neutral kind is this
// Dolt-specific failure an instance of" -- the direct analogue of 647.1's
// classifyFailure() kind set. A diverged outcome only ever reaches the
// degraded path after the one bounded reconcile has already failed (see
// doltPushAfter), so it always maps to 'conflict-unresolvable' here, never
// 'conflict-resolvable' (that state exists only transiently, mid-reconcile,
// and is never itself reported as a degraded terminal outcome).
const NEUTRAL_KIND_MAP = {
    diverged: 'conflict-unresolvable',
    auth: 'auth',
    transient: 'transient',
    'no-remote': 'no-store',
    'empty-remote': 'no-store',
    'remote-unreachable': 'store-unreachable',
    unknown: 'unknown',
    error: 'unknown',
};

/**
 * Map an adapter-flavored outcome `kind` (classifySyncError's return value) to
 * the ADR's backend-neutral failure taxonomy. Unrecognized kinds map to
 * 'unknown' rather than throwing, since this runs on the degraded (already
 * failure) path and must never itself raise.
 *
 * @param {string} kind
 * @returns {'transient'|'auth'|'conflict-resolvable'|'conflict-unresolvable'|'store-unreachable'|'no-store'|'coordination-unavailable'|'unknown'}
 */
export function toNeutralDegradedKind(kind) {
    return NEUTRAL_KIND_MAP[kind] || 'unknown';
}

/**
 * TaskDBModule capabilities descriptor (ADR Decision 2/3) for the Dolt/beads
 * adapter: declares which neutral degraded.kind values this backend can ever
 * produce, plus the booleans callers use instead of assuming Dolt semantics.
 *
 * `supportsRepair: true` reflects that `repair()` below runs the real
 * deterministic settle (settleDoltConflicts, dolt-settle.mjs) rather than
 * being a named seam only -- see the CONFLICT-RECOVERY DISPOSITION note in
 * this file's header.
 *
 * @returns {{ wholeStatePublish: boolean, supportsRepair: boolean, supportsCoordinationLock: boolean, kinds: string[] }}
 */
export function capabilities() {
    return {
        wholeStatePublish: true,
        supportsRepair: true,
        supportsCoordinationLock: true,
        kinds: ['transient', 'auth', 'conflict-resolvable', 'conflict-unresolvable', 'store-unreachable', 'no-store', 'unknown'],
    };
}

/**
 * Normalize a primitive's successful return value into the structured outcome.
 *
 * @param {object} result
 * @param {string} member
 * @param {'pull'|'push'} operation
 * @returns {object}
 */
function successOutcome(result, member, operation) {
    const res = result && typeof result === 'object' ? result : {};
    const kind = res.skipped && res.reason ? res.reason : 'synced';
    return {
        ...res,
        ok: true,
        kind,
        degraded: false,
        detail: res.skipped
            ? `[Dolt] D-${operation} for member '${member}' was a benign no-op (${kind}).`
            : `[Dolt] D-${operation} for member '${member}' completed.`,
        member,
        operation,
    };
}

/**
 * Run one primitive bracket under the degraded-by-default policy.
 *
 * With `fatal: true` the primitive's typed error propagates untouched -- that
 * is how the explicitly-fatal call sites (the pre-flight beads-health gate,
 * the pre-dispatch D-pull, the post-dispatch sync bracket) keep their existing
 * DoltDivergedError / DoltSyncError behavior and their terminal-reason
 * plumbing. Hard abort is now the explicit last resort, not the default.
 *
 * @param {Function} run - () => Promise<object>, the throwing primitive
 * @param {{ member: string, operation: 'pull'|'push', fatal?: boolean, log?: Function, onDegraded?: Function }} ctx
 * @returns {Promise<object>} structured outcome
 */
async function runDegradable(run, ctx) {
    const { member, operation, fatal = false, log = () => {}, onDegraded } = ctx;
    let result;
    try {
        result = await run();
    } catch (err) {
        if (fatal) throw err;
        const kind = classifySyncError(err);
        const outcome = {
            ok: false,
            kind,
            degraded: true,
            // Backend-neutral classification (ADR Decision 2, apra-fleet-417.5)
            // alongside the adapter-flavored `kind` above -- see the
            // NEUTRAL_KIND_MAP comment for why this is a sibling field rather
            // than nested under `degraded`.
            degradedKind: toNeutralDegradedKind(kind),
            detail: (err && err.message) || String(err),
            member,
            operation,
            error: err,
        };
        log(
            `[Dolt] DEGRADED (non-fatal): D-${operation} for member '${member}' did not land (${kind}). ` +
            `The sprint CONTINUES -- this member's beads mutations are safe in its local clone and the next ` +
            `D-${operation} bracket for '${member}' is the queued retry. Cause: ${outcome.detail}`,
        );
        const record = recordDegradedSync({ member, operation, kind, detail: outcome.detail });
        if (typeof onDegraded === 'function') {
            try {
                await onDegraded({ ...outcome, record });
            } catch (hookErr) {
                log(`[Dolt] degraded-sync onDegraded hook failed for member '${member}' (non-fatal): ${(hookErr && hookErr.message) || hookErr}`);
            }
        }
        return outcome;
    }
    const outcome = successOutcome(result, member, operation);
    // The next successful bracket IS the queued retry: retire this member's
    // outstanding degraded records once one lands.
    if (operation === 'push' && outcome.ok) {
        const retired = clearDegradedSyncRecords(member);
        if (retired > 0) {
            log(`[Dolt] D-push for member '${member}' succeeded; retired ${retired} previously degraded sync record(s) for this member.`);
        }
    }
    return outcome;
}

// ---------------------------------------------------------------------------
// Public API -- the only supported entry points (see the module header)
// ---------------------------------------------------------------------------

/**
 * BEFORE bracket. Freshen `member`'s beads clone so whatever happens next --
 * a dispatch, or an orchestrator-side read of cross-member beads state --
 * sees the shared remote's current truth rather than a stale local copy.
 *
 * `opts.readinessGate: true` (apra-fleet-417.5 rename of `healthGate`, ADR
 * Decision 2) selects the pre-flight variant used once per run before any
 * mutating git/PR command: identical probe, but a divergence is re-thrown
 * with the composed, actionable "beads DB diverged" line (workspace path +
 * conflicting tables + remediation) that the dashboard persists.
 *
 * Returns a STRUCTURED OUTCOME ({ ok, kind, degraded, degradedKind, detail,
 * ... }) and, by default, does NOT throw: a sync failure the module cannot
 * resolve is surfaced as `degraded: true` (with `degradedKind` carrying the
 * ADR's backend-neutral taxonomy) so the sprint loop continues
 * (apra-fleet-417.3). Pass `fatal: true` to restore the throwing behavior at a
 * call site that genuinely must abort the run -- `readinessGate: true`
 * implies `fatal: true`, since that gate exists precisely to stop a run
 * before it mutates anything.
 *
 * `opts.skipRefresh` (apra-fleet-417.5 rename of `skipPull`, ADR Decision 2)
 * is threaded through to doltPullBefore()'s `skipPull` -- see that function's
 * doc comment for what it suppresses. The legacy spellings `healthGate` and
 * `skipPull` are REJECTED (thrown) rather than silently ignored: silently
 * dropping either into the `...rest` passthrough would leave a stale call
 * site with `fatal` quietly defaulting to `false`, turning a hard pre-flight
 * abort into a silent degrade.
 *
 * All other opts are passed through unchanged to doltPullBefore():
 * `command` (required), `log`, `maxTransientRetries`, `onAuthFailure`,
 * `checkSyncRemoteConfigured`, `sleep`, `backoffBaseMs`, `timeoutS` (defaults
 * to DOLT_STEP_TIMEOUT_S -- override only for a call site with a known-
 * different Dolt DB size/latency profile).
 *
 * @param {string} member
 * @param {{ command: Function, readinessGate?: boolean, fatal?: boolean, onDegraded?: Function, log?: Function, maxTransientRetries?: number, checkSyncRemoteConfigured?: Function, skipRefresh?: boolean, onAuthFailure?: Function, sleep?: Function, backoffBaseMs?: number }} opts
 * @returns {Promise<object>} structured outcome
 * @throws {DoltDivergedError|DoltSyncError} only when `fatal`/`readinessGate` is set
 */
export async function syncBefore(member, opts = {}) {
    const { readinessGate = false, skipRefresh, fatal, onDegraded, healthGate, skipPull, ...rest } = opts;
    // Both renames (healthGate -> readinessGate, skipPull -> skipRefresh) came
    // from apra-fleet-417.5 (ADR Decision 2). The tracker id lives here, in a
    // comment, because the thrown messages below are runtime strings.
    if (healthGate !== undefined) {
        throw new Error(
            "DoltSync.syncBefore: opts.healthGate is retired -- pass opts.readinessGate instead " +
            "(docs/adr-taskdb-backend-neutral-interface.md Decision 2).",
        );
    }
    if (skipPull !== undefined) {
        throw new Error(
            "DoltSync.syncBefore: opts.skipPull is retired -- pass opts.skipRefresh instead " +
            "(docs/adr-taskdb-backend-neutral-interface.md Decision 2).",
        );
    }
    const adapterOpts = { ...rest, skipPull: skipRefresh };
    const run = readinessGate
        ? () => preflightBeadsHealthGate(member, adapterOpts)
        : () => doltPullBefore(member, adapterOpts);
    return runDegradable(run, {
        member,
        operation: 'pull',
        fatal: fatal === undefined ? readinessGate : fatal,
        log: rest.log,
        onDegraded,
    });
}

/**
 * AFTER bracket. Publish `member`'s committed beads mutations to the shared
 * remote, serialized behind the global push mutex, with the single bounded
 * first-successful-pusher-wins reconcile (one D-pull, one re-push).
 *
 * `pushBeads: false` makes it an explicit no-op, so a read-only bracket can
 * call the same entry point unconditionally instead of branching at the call
 * site. All opts are passed through unchanged to doltPushAfter().
 *
 * Returns a STRUCTURED OUTCOME ({ ok, kind, degraded, detail, pushed,
 * reconciled, ... }) and, by default, does NOT throw. A push that is still
 * unresolved after the bounded transient retries, the one-shot auth self-heal
 * and the single reconcile is reported as `degraded: true` and the sprint
 * CONTINUES: the member's beads mutations are already committed in its local
 * clone, and the next syncAfter() for that member is the queued retry. Pass
 * `fatal: true` at a call site that must still hard-abort (the post-dispatch
 * sync bracket does, so an unreachable close can never be advertised).
 *
 * This is the seam settle is wired behind: an `opts.settle` callback is passed
 * straight through to doltPushAfter(), whose divergence terminal invokes it --
 * see the CONFLICT-RECOVERY DISPOSITION note in the module header.
 *
 * `opts.mutatedItemIds` (ADR Decision 2/3, apra-fleet-417.5) is accepted per
 * the TaskDBModule contract but INTENTIONALLY NOT CONSUMED by this adapter:
 * the Dolt/beads backend publishes whole state (`capabilities().
 * wholeStatePublish === true`), so a later successful push always implicitly
 * carries any earlier one and a per-item publish ledger keyed on these ids
 * buys nothing here. A future non-whole-state backend (e.g. the ADR's Jira
 * walk-through) is the one that must thread `mutatedItemIds` into a real
 * per-item retry ledger -- this parameter exists on the interface today so
 * that backend does not need a signature change to land.
 *
 * @param {string} member
 * @param {{ command: Function, pushBeads?: boolean, fatal?: boolean, onDegraded?: Function, log?: Function, maxTransientRetries?: number, mutex?: { acquire: Function, release: Function }, sprintId?: string, checkSyncRemoteConfigured?: Function, onAuthFailure?: Function, sleep?: Function, backoffBaseMs?: number, mutatedItemIds?: string[] }} opts
 * @returns {Promise<object>} structured outcome
 * @throws {DoltDivergedError|DoltSyncError} only when `fatal: true` is set
 */
export async function syncAfter(member, opts = {}) {
    const { fatal = false, onDegraded, mutatedItemIds, ...rest } = opts;
    void mutatedItemIds; // see doc comment: accepted for interface parity, not consumed by this whole-state-publish adapter
    return runDegradable(() => doltPushAfter(member, rest), {
        member,
        operation: 'push',
        fatal,
        log: rest.log,
        onDegraded,
    });
}

/**
 * Read-only status probe: is `member`'s beads clone actually wired to a shared
 * remote? Issues NO `bd dolt` command (so it can never re-arm a deliberately
 * neutralized remote as a side effect) and never throws -- an inconclusive
 * read reports `syncRemoteConfigured: true`, matching the fail-closed stance
 * of the brackets themselves.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, checkSyncRemoteConfigured?: Function }} opts
 * @returns {Promise<{ member: string, syncRemoteConfigured: boolean }>}
 */
export async function status(member, opts = {}) {
    const { command, log = () => {}, checkSyncRemoteConfigured } = opts;
    if (typeof command !== 'function') {
        throw new Error('DoltSync.status requires an injected command() in opts');
    }
    const checkFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
    return { member, syncRemoteConfigured: await checkFn(member, { command, log }) };
}

// ---------------------------------------------------------------------------
// TaskDBModule contract completion (docs/adr-taskdb-backend-neutral-
// interface.md Decision 2, apra-fleet-417.5): refreshView / ensureReady /
// flush / repair, each delegating to the machinery above rather than
// introducing new dolt call sites -- this module remains the SINGLE permitted
// dolt command surface (see the module header).
// ---------------------------------------------------------------------------

/**
 * Make `member`'s local view current before the orchestrator reads task
 * state. Delegates to the same D-pull bracket syncBefore() uses, non-fatal by
 * default (a stale-but-present view is reported via `fresh: false`, not
 * thrown) -- ADR Decision 2: "Never throws; fresh:false means reads are
 * possibly stale, so callers treat verification as INCONCLUSIVE rather than
 * failed."
 *
 * `opts.purpose` is accepted for interface parity (a future backend may use
 * it to decide whether a cache invalidation is warranted) but this adapter's
 * refresh is unconditional, so it is not otherwise consulted.
 *
 * @param {string} member
 * @param {{ command: Function, purpose?: string, fatal?: boolean, log?: Function, [key: string]: any }} opts
 * @returns {Promise<{ fresh: boolean, degraded?: object }>}
 */
export async function refreshView(member, opts = {}) {
    const { purpose, fatal = false, ...rest } = opts;
    void purpose; // interface parity only -- see doc comment
    const outcome = await syncBefore(member, { ...rest, fatal });
    return outcome.degraded ? { fresh: false, degraded: outcome } : { fresh: outcome.ok };
}

/**
 * Sprint-start gate: bring `member`'s local view of the task store into a
 * usable state before any work is dispatched. The one method permitted to
 * refuse to start -- delegates to syncBefore's `readinessGate` (pre-flight
 * beads-health) variant, which is fatal by default, so a genuinely unusable
 * store still aborts the run rather than reporting `ready: false` and
 * continuing.
 *
 * @param {string} member
 * @param {{ command: Function, fatal?: boolean, log?: Function, [key: string]: any }} opts
 * @returns {Promise<{ ready: boolean, degraded?: object }>}
 */
export async function ensureReady(member, opts = {}) {
    const outcome = await syncBefore(member, { ...opts, readinessGate: true });
    return outcome.degraded ? { ready: false, degraded: outcome } : { ready: outcome.ok };
}

/**
 * End-of-run: report the degradation ledger a terminal summary is built from.
 *
 * This adapter does not attempt a fresh publish here -- the ADR's "attempt
 * publication for every view still marked unpublished" is already satisfied
 * incrementally by this adapter's own retry contract: the NEXT syncAfter()
 * bracket for a given member IS its queued retry (see the module-level
 * "Structured outcomes" section above), and getDegradedSyncRecords() already
 * retires a member's records the moment one of those retries lands. flush()
 * is therefore a read of that ledger, not a second retry mechanism.
 *
 * @param {{ member?: string }} [filter]
 * @returns {{ published: boolean, degradations: object[] }}
 */
export function flush(filter = {}) {
    const degradations = getDegradedSyncRecords({ ...filter, pendingOnly: true });
    return { published: degradations.length === 0, degradations };
}

/**
 * Explicit remediation entry point (ADR Decision 2): "recovery ladder plus
 * credential re-provisioning. Called by operators/tools and by ensureReady();
 * never inline from a per-operation sync path."
 *
 * WIRED: runs the real deterministic settle (settleDoltConflicts,
 * dolt-settle.mjs) against a wedged beads clone and reports whether it was
 * repaired. This is the operator/tool entry point onto the SAME function both
 * divergence terminals invoke -- one implementation, three callers -- so a
 * manual repair and an automatic one behave identically. `command` is
 * required (settle issues every `bd dolt`/`dolt` command through it);
 * `platform`/`arch` are optional and probed from the member when absent.
 * `opts.settle` may be supplied to override the callback (tests do this).
 *
 * `opts.shell` threads the member's REGISTERED shell into dolt-settle
 * (apra-fleet-7dir.16/.24) the same way every other buildSettleCallback call
 * site does -- omitted (defaulting to '', the PowerShell dialect on
 * Windows) is the pre-shell-aware behavior, not a regression, for any
 * caller that has not resolved it.
 *
 * @param {string} member
 * @param {{ command?: Function, log?: Function, platform?: string, arch?: string, shell?: string, settle?: Function, [key: string]: any }} [opts]
 * @returns {Promise<{ repaired: boolean, escalation?: string, result?: object }>}
 */
export async function repair(member, opts = {}) {
    const { command, log = () => {}, platform, arch, shell = '' } = opts;
    if (typeof command !== 'function') {
        return { repaired: false, escalation: 'not-configured: repair() requires an injected command() to run settle' };
    }
    // An operator/tool remediation can rewire this clone's remote and always
    // moves it off whatever tip we last observed, so drop both memos up front
    // (a repair must never be decided against, or leave behind, cached state).
    forgetMemberSyncState(member);
    const settle = typeof opts.settle === 'function'
        ? opts.settle
        : buildSettleCallback(member, { command, log, platform, arch, shell });
    let result = null;
    try {
        result = await settle({ operation: 'repair' });
    } catch (err) {
        log(`[Dolt] repair() failed operationally for member '${member}' (an infra failure, NOT an unresolvable conflict): ${(err && err.message) || err}`);
        return { repaired: false, escalation: 'settle-operational-failure', result: { error: (err && err.message) || String(err) } };
    }
    if (result && result.ok) {
        log(`[Dolt] repair() settled member '${member}' (tables: ${(result.resolvedTables || []).join(', ') || 'none'}).`);
        return { repaired: true, result };
    }
    log(`[Dolt] repair() did NOT settle member '${member}'.`);
    return { repaired: false, escalation: 'unrecovered', result };
}

export const DoltSync = {
    syncBefore,
    syncAfter,
    status,
    refreshView,
    ensureReady,
    flush,
    repair,
    capabilities,
    getDegradedSyncRecords,
    clearDegradedSyncRecords,
    // sync.remote memo (apra-fleet-akuv) -- noteMemberCommand() is the seam the
    // runner's central command() wrapper calls on every member-bound command;
    // noteMemberDispatchCompleted() is the soft seam its central agent()
    // wrapper calls once per settled dispatch (agent-side bd commands never
    // pass through command(), so this is how a member gets marked for the
    // lazy sync.remote re-check before any fingerprint skip).
    noteMemberCommand,
    noteMemberDispatchCompleted,
    invalidateSyncRemoteCache,
    // Remote-tip fingerprint state, exposed for tests and operator tooling.
    getLastSyncedTip,
    setLastSyncedTip,
    clearLastSyncedTip,
};

export default DoltSync;
