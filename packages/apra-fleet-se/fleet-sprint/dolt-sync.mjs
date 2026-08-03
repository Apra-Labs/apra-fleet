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
 * RECOVERY-LADDER DISPOSITION (apra-fleet-417.2.1 AC3; coordinates with
 * apra-fleet-vkc.1, which owns executing it)
 * -------------------------------------------------------------------------
 * Decision: WIRE, not decommission. dolt-recovery.mjs (Path A: gated
 * allowlist auto-resolve), dolt-recovery-path-b.mjs (Path B: re-clone from the
 * shared remote) and dolt-recovery-tier2.mjs (Tier 2: human/agent escalation
 * against docs/dolt-tier2-runbook.md) are today imported only by their own
 * tests -- doltPushAfter()'s diverged path throws DoltDivergedError with no
 * recovery attempt. They are NOT decommissioned because the failure they
 * handle is real and currently sprint-fatal: a wedged beads clone stops the
 * whole sprint, and the ladder is the only written-down remedy for it.
 *
 * Rationale for wiring them BEHIND this module rather than at the call sites:
 * the ladder must run at exactly one place -- the diverged terminal of
 * syncAfter() (and of syncBefore()'s reconcile pull) -- so that every one of
 * runner.js's dolt call sites inherits recovery without opting in, and so that
 * "attempted Path A -> Path B -> Tier 2, each logged with its outcome" has a
 * single implementation to audit.
 *
 * Status of that wiring: NOT DONE IN THIS FILE YET, deliberately. This bead
 * (417.2.1) is a no-behavior-change consolidation; apra-fleet-vkc.1 owns the
 * decision's execution (and apra-fleet-417.3.1 owns classification/bounded
 * retry/degraded-path hardening on the same seam). If vkc.1 lands a DIFFERENT
 * disposition, vkc.1 wins and this comment must be updated to match -- it is
 * recorded here only so the seam and its rationale are not lost, and so the
 * wiring lands here rather than being sprayed back across runner.js.
 *
 * ASCII only.
 */

import { DoltDivergedError, DoltSyncError } from './errors.mjs';

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

// Substrings that mark a `bd dolt` failure as NO-REMOTE: this local beads clone
// has no configured dolt remote at all (e.g. a temp fixture repo with no
// 'origin'), so there is nothing to pull or push. This is a benign, non-error
// condition -- distinct from both a genuine divergence and a transient
// network/server hiccup -- and is checked FIRST so its text always wins. A
// remote that IS configured but unreachable/diverged/auth-failing never matches
// these patterns and still falls through to the diverged/transient/unknown
// classification.
const DOLT_NO_REMOTE_PATTERNS = [
    /error 1105.*no remote/i,
    /\bno remote\b/i,
];

// Substrings that mark a `bd dolt pull` failure as an EMPTY-REMOTE: the
// sync.remote IS configured (unlike no-remote above) but has never had anything
// pushed into it -- e.g. a sync.remote derived from a bare git-only mirror that
// Dolt itself has never pushed a branch into. Distinct from BOTH no-remote
// (nothing configured at all) and a genuine divergence/conflict (something IS
// there, but disagrees with the local clone): a remote with zero branches has
// nothing to reconcile, so pulling it is a benign no-op, not a fatal sync
// failure. Matched on Dolt's specific Error 1105 wording so it can never
// swallow a real pull failure that merely mentions "remote", and checked before
// the diverged/transient patterns for the same reason as
// DOLT_NO_REMOTE_PATTERNS.
const DOLT_EMPTY_REMOTE_PATTERNS = [
    /error 1105.*no branches found in remote/i,
    /no branches found in remote/i,
];

// Substrings that mark a `bd dolt` failure as a DIVERGENCE (the remote moved
// under us / a data or merge conflict). Reconciled once by the push loser, or
// surfaced as DoltDivergedError -- never retried blindly.
const DOLT_DIVERGED_PATTERNS = [
    /conflict/i,
    /would (be )?overwrit/i,
    /cannot fast[- ]forward/i,
    /not possible to fast[- ]forward/i,
    /non-fast-forward/i,
    /\[rejected\]/i,
    /failed to push/i,
    /updates were rejected/i,
    /remote (is )?ahead/i,
    /behind the remote/i,
    /not up[- ]to[- ]date/i,
    /have diverged/i,
    /merge (is )?required/i,
    /working set (is )?not clean/i,
];

// Substrings that mark a `bd dolt` failure as an AUTH (credential) failure --
// mirrors GIT_AUTH_PATTERNS above. `bd dolt push` shells out to git under the
// hood, so it surfaces the same credential-prompt text a plain git push does.
//
// ORDERING (apra-fleet-spp, apra-fleet-417.3.1): these are checked BEFORE the
// diverged patterns, not after. The live 2026-08-02 fleet-mac failure
//
//   Error: push to origin/main: Error 1105: unknown push error; addTableFiles,
//   updateManifestAddFiles: fatal: could not read Username for
//   'https://github.com': Device not configured
//
// was reported to the operator as data divergence and hard-aborted an
// otherwise healthy sprint, when in fact nothing had diverged and the fix was
// simply to re-provision the member's VCS credentials. The auth patterns below
// are narrow and credential-shaped; the divergence patterns are deliberately
// loose (they include bare /conflict/i, and the transient set includes bare
// /lock/i), so a credential message that happens to mention either word would
// be swallowed by the looser class. Specific beats loose: AUTH wins, always.
// A credential failure must NEVER be classified 'diverged'.
const DOLT_AUTH_PATTERNS = [
    /could not read Username for/i,
    /could not read Password for/i,
    /Authentication failed/i,
    /Permission denied \(publickey\)/i,
    /remote: Invalid username or (token|password)/i,
    /terminal prompts disabled/i,
    /support for password authentication was removed/i,
    /Bad credentials/i,
];

// Substrings that mark a `bd dolt` failure as TRANSIENT (network / server /
// lock) -- safe to retry a bounded number of times.
const DOLT_TRANSIENT_PATTERNS = [
    /could not resolve host/i,
    /unable to (access|connect)/i,
    /connection (timed out|reset|refused)/i,
    /operation timed out/i,
    /\btimed out\b/i,
    /\btimeout\b/i,
    /temporary failure/i,
    /early eof/i,
    /rpc failed/i,
    /the remote end hung up/i,
    /server (is )?(starting|not ready|unavailable)/i,
    /connection refused/i,
    /dial tcp/i,
    /i\/o timeout/i,
    /database is locked/i,
    /lock/i,
];

// Substrings that mark a `bd dolt` failure as REMOTE-UNREACHABLE: the
// configured sync remote itself cannot be opened (deleted directory behind a
// file:// remote, dead path, missing remote db). Distinct from 'transient'
// (retrying cannot help: the target is gone, not busy) and from 'no-remote'
// (here a remote IS configured, it just points at nothing). Checked before
// 'diverged'/'transient' so a stat/open failure is never misread as a conflict
// or retried blindly.
const DOLT_REMOTE_UNREACHABLE_PATTERNS = [
    /could not be accessed/i,
    /failed to get remote db/i,
    /stat [^:]+: no such file or directory/i,
];

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
 * Dolt brackets route differently. no-remote is checked FIRST: a local clone
 * with no configured dolt remote has nothing to pull/push, which is a benign
 * skip, never a divergence or a retryable transient failure. empty-remote (a
 * configured sync.remote with zero branches ever pushed into it) and
 * remote-unreachable (a configured remote that cannot be opened at all) are
 * checked next, for the same reason.
 *
 * 'auth' is then checked BEFORE 'diverged' (apra-fleet-spp / apra-fleet-417.3.1
 * -- see the DOLT_AUTH_PATTERNS comment for the live incident this ordering
 * exists to prevent): the credential patterns are narrow, the divergence and
 * transient patterns are deliberately loose, and a credential failure reported
 * as data divergence both misleads the operator and sends the push down a
 * reconcile ladder that cannot possibly fix it.
 *
 * Divergence follows: a remote-moved/conflict state must never be misread as
 * transient and retried blindly, even if its message also contains a
 * lock/network word.
 *
 * @param {string} output - the raw stderr/stdout of the failed `bd dolt` command
 * @returns {'no-remote'|'empty-remote'|'remote-unreachable'|'auth'|'diverged'|'transient'|'unknown'}
 */
export function classifyDoltFailure(output) {
    const text = String(output == null ? '' : output);
    for (const re of DOLT_NO_REMOTE_PATTERNS) if (re.test(text)) return 'no-remote';
    for (const re of DOLT_EMPTY_REMOTE_PATTERNS) if (re.test(text)) return 'empty-remote';
    for (const re of DOLT_REMOTE_UNREACHABLE_PATTERNS) if (re.test(text)) return 'remote-unreachable';
    for (const re of DOLT_AUTH_PATTERNS) if (re.test(text)) return 'auth';
    for (const re of DOLT_DIVERGED_PATTERNS) if (re.test(text)) return 'diverged';
    for (const re of DOLT_TRANSIENT_PATTERNS) if (re.test(text)) return 'transient';
    return 'unknown';
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
    const { command, log = () => {} } = opts;
    let res;
    try {
        res = await command('bd config get sync.remote --json', { member_name: member, silent: true, failSoft: true });
    } catch (err) {
        log(`[Dolt] could not query bd-level sync.remote for member '${member}' (fail-safe: treating as configured): ${err.message}`);
        return true;
    }
    if (res && typeof res === 'object' && res.ok === false) {
        log(`[Dolt] 'bd config get sync.remote' failed for member '${member}' (fail-safe: treating as configured): ${res.error}`);
        return true;
    }
    const output = res && typeof res === 'object' ? res.output : res;
    if (!output) {
        // No output to positively parse (e.g. a no-op/unmocked command()):
        // sync.remote cannot be confirmed absent, so do not treat it as
        // neutralized.
        return true;
    }
    try {
        const parsed = JSON.parse(output);
        return !(typeof parsed.value === 'string' && parsed.value.trim().length === 0);
    } catch (err) {
        log(`[Dolt] could not parse 'bd config get sync.remote --json' output for member '${member}' (fail-safe: treating as configured): ${err.message}`);
        return true;
    }
}

// Bounded exponential backoff between TRANSIENT retries (apra-fleet-417.3.1).
// A network blip, a busy dolt-server or a held row lock is not cleared by an
// instant re-issue -- the previous code retried with zero delay, which turned
// the bound into "fail twice as fast". Delay is attempt-indexed and capped, and
// `sleep` is injectable so unit suites never actually wait.
const DOLT_BACKOFF_BASE_MS = 500;
const DOLT_BACKOFF_MAX_MS = 8000;

/**
 * Delay before transient retry #`attempt` (1-based): base * 2^(attempt-1),
 * capped at DOLT_BACKOFF_MAX_MS.
 *
 * @param {number} attempt
 * @param {number} [baseMs]
 * @param {number} [maxMs]
 * @returns {number}
 */
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
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, kind?: 'no-remote'|'empty-remote'|'remote-unreachable'|'diverged'|'auth'|'transient'|'unknown' }>}
 */
async function runDoltStep({ command, member, cmd, label, log, maxTransientRetries, onAuthFailure, sleep = defaultSleep, backoffBaseMs = DOLT_BACKOFF_BASE_MS }) {
    let attempt = 0;
    let authHealAttempted = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await command(cmd, { member_name: member, silent: true, failSoft: true, label });
        if (res && res.ok) return res;
        const error = res ? res.error : 'unknown command failure';
        const kind = classifyDoltFailure(error);
        if (kind === 'transient' && attempt < maxTransientRetries) {
            attempt += 1;
            const delayMs = doltBackoffDelayMs(attempt, backoffBaseMs);
            log(`[Dolt] transient failure for member '${member}' (${label}); retry ${attempt}/${maxTransientRetries} after ${delayMs}ms backoff: ${error}`);
            if (delayMs > 0 && typeof sleep === 'function') await sleep(delayMs);
            continue;
        }
        if (kind === 'auth' && typeof onAuthFailure === 'function' && !authHealAttempted) {
            authHealAttempted = true;
            log(`[Dolt] auth failure for member '${member}' (${label}); invoking self-heal (provision_vcs_auth) once before a single bounded retry: ${error}`);
            try {
                await onAuthFailure({ member, label, cmd, error, kind: 'dolt' });
            } catch (healErr) {
                log(`[Dolt] self-heal for member '${member}' (${label}) failed; not retrying further: ${healErr.message}`);
                return { ok: false, output: res ? res.output : '', error, kind };
            }
            log(`[Dolt] self-heal for member '${member}' (${label}) completed; retrying the failed dolt command once.`);
            continue;
        }
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
 * Two distinct benign no-op skips return `{ ok: true, skipped: true }` rather
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
 * @returns {Promise<{ ok: true, member: string, skipped?: true, reason?: 'no-remote'|'empty-remote'|'already-fresh' }>}
 */
export async function doltPullBefore(member, opts = {}) {
    const { command, log = () => {}, maxTransientRetries = 1, checkSyncRemoteConfigured, skipPull = false, onAuthFailure, sleep, backoffBaseMs } = opts;
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

    const pull = await runDoltStep({
        command, member, cmd: 'bd dolt pull',
        label: `D-pull for '${member}'`, log, maxTransientRetries, onAuthFailure, sleep, backoffBaseMs,
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
            throw new DoltDivergedError(
                `[Dolt] D-pull for member '${member}' hit an unmergeable beads conflict and must not be auto-resolved by judgment: ${pull.error}`,
                { member, doltOutput: pull.error, operation: 'pull' },
            );
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
 * @returns {Promise<{ ok: true, member: string, skipped?: true, reason?: 'no-remote'|'empty-remote'|'already-fresh' }>}
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
 * @param {string} member
 * @param {{ command: Function, pushBeads?: boolean, log?: Function, maxTransientRetries?: number, mutex?: { acquire: Function, release: Function }, sprintId?: string, checkSyncRemoteConfigured?: Function, onAuthFailure?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, reconciled: boolean, skipped?: true, reason?: 'no-remote' }>}
 */
export async function doltPushAfter(member, opts = {}) {
    const { command, pushBeads = true, log = () => {}, maxTransientRetries = 1, mutex, sprintId, checkSyncRemoteConfigured, onAuthFailure, sleep, backoffBaseMs } = opts;
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
    if (!(await preGateCheckFn(member, { command, log }))) {
        log(`[Dolt] D-push for member '${member}' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no push command issued`);
        return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
    }

    // Serialize this push behind the global mutex: acquire (waiting our FIFO
    // turn) before touching the remote; release on every exit.
    let grant = null;
    if (mutex && typeof mutex.acquire === 'function') {
        grant = await mutex.acquire(sprintId || member, { pid: process.pid });
    }
    try {
        return await doltPushGuarded();
    } finally {
        if (grant && mutex && typeof mutex.release === 'function') {
            try {
                await mutex.release(grant.token);
            } catch (relErr) {
                log(`[Dolt] mutex release after D-push for member '${member}' failed (non-fatal; lease will expire): ${relErr.message}`);
            }
        }
    }

    async function doltPushGuarded() {
    let push = await runDoltStep({
        command, member, cmd: 'bd dolt push',
        label: `D-push for '${member}'`, log, maxTransientRetries, onAuthFailure, sleep, backoffBaseMs,
    });
    if (push.ok) {
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
        const checkFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
        const syncRemoteConfigured = await checkFn(member, { command, log });
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
        label: `D-push reconcile pull for '${member}'`, log, maxTransientRetries, onAuthFailure, sleep, backoffBaseMs,
    });
    if (!reconcile.ok) {
        if (reconcile.kind === 'diverged') {
            throw new DoltDivergedError(
                `[Dolt] D-push reconcile pull for member '${member}' hit an unmergeable beads conflict -- must not be retried blindly: ${reconcile.error}`,
                { member, doltOutput: reconcile.error, operation: 'push-reconcile' },
            );
        }
        throw new DoltSyncError(
            `[Dolt] D-push reconcile pull for member '${member}' failed: ${reconcile.error}`,
            { member, doltOutput: reconcile.error },
        );
    }

    push = await runDoltStep({
        command, member, cmd: 'bd dolt push',
        label: `D-push re-push after reconcile for '${member}'`, log, maxTransientRetries, onAuthFailure, sleep, backoffBaseMs,
    });
    if (push.ok) {
        return { ok: true, member, pushed: true, reconciled: true };
    }

    // Still rejected after the one bounded reconcile.
    throw new DoltDivergedError(
        `[Dolt] D-push for member '${member}' still rejected after one reconcile pull -- refusing to retry further: ${push.error}`,
        { member, doltOutput: push.error, operation: 'push' },
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
//                | 'diverged' | 'auth' | 'transient' | 'remote-unreachable'
//                | 'unknown'
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
 * `supportsRepair: false` reflects that `repair()` below is a named seam, not
 * a wired recovery ladder yet -- apra-fleet-vkc.1 owns that wiring (see the
 * RECOVERY-LADDER DISPOSITION note in this file's header). `supportsRepair`
 * will become `true` once vkc.1 lands.
 *
 * @returns {{ wholeStatePublish: boolean, supportsRepair: boolean, supportsCoordinationLock: boolean, kinds: string[] }}
 */
export function capabilities() {
    return {
        wholeStatePublish: true,
        supportsRepair: false,
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
 * `checkSyncRemoteConfigured`, `sleep`, `backoffBaseMs`.
 *
 * @param {string} member
 * @param {{ command: Function, readinessGate?: boolean, fatal?: boolean, onDegraded?: Function, log?: Function, maxTransientRetries?: number, checkSyncRemoteConfigured?: Function, skipRefresh?: boolean, onAuthFailure?: Function, sleep?: Function, backoffBaseMs?: number }} opts
 * @returns {Promise<object>} structured outcome
 * @throws {DoltDivergedError|DoltSyncError} only when `fatal`/`readinessGate` is set
 */
export async function syncBefore(member, opts = {}) {
    const { readinessGate = false, skipRefresh, fatal, onDegraded, healthGate, skipPull, ...rest } = opts;
    if (healthGate !== undefined) {
        throw new Error(
            "DoltSync.syncBefore: opts.healthGate is retired -- pass opts.readinessGate instead " +
            "(docs/adr-taskdb-backend-neutral-interface.md Decision 2, apra-fleet-417.5).",
        );
    }
    if (skipPull !== undefined) {
        throw new Error(
            "DoltSync.syncBefore: opts.skipPull is retired -- pass opts.skipRefresh instead " +
            "(docs/adr-taskdb-backend-neutral-interface.md Decision 2, apra-fleet-417.5).",
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
 * This is the seam the recovery ladder is to be wired behind -- see the
 * RECOVERY-LADDER DISPOSITION note in the module header (apra-fleet-vkc.1).
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
 * NOT YET WIRED (apra-fleet-417.5): this is the named seam only.
 * apra-fleet-vkc.1 owns wiring the actual recovery ladder (dolt-recovery.mjs
 * Path A / dolt-recovery-path-b.mjs Path B / dolt-recovery-tier2.mjs Tier 2)
 * behind this entry point -- see the RECOVERY-LADDER DISPOSITION note in this
 * file's header for why that wiring belongs here and not at call sites, and
 * why it is deliberately not done in this bead. `capabilities().
 * supportsRepair` stays `false` until vkc.1 lands.
 *
 * @param {string} member
 * @returns {Promise<{ repaired: boolean, escalation?: string }>}
 */
export async function repair(member) {
    void member;
    return { repaired: false, escalation: 'not-implemented: recovery ladder wiring is owned by apra-fleet-vkc.1' };
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
};

export default DoltSync;
