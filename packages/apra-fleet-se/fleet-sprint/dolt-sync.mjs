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
 *                                `opts.healthGate: true` selects the
 *                                pre-flight beads-health variant, which
 *                                additionally composes the actionable
 *                                "beads DB diverged" diagnosis line.
 *   syncAfter(member, opts)   -- publish `member`'s beads mutations (D-push
 *                                bracket, mutex-serialized, with the single
 *                                bounded first-successful-pusher-wins
 *                                reconcile).
 *   status(member, opts)      -- read-only probe: is this clone actually wired
 *                                to a shared beads remote? Issues no dolt
 *                                command and never throws.
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
// Checked after 'diverged' (which must never be misclassified) but before
// 'transient', so an auth failure is never blindly retried without
// re-provisioning credentials first.
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
 * checked next, for the same reason. Divergence follows: a remote-moved/conflict state
 * must never be misread as transient and retried blindly, even if its message
 * also contains a lock/network word. 'auth' is checked after 'diverged' but
 * before 'transient', same ordering rationale as classifyGitFailure -- a
 * credential failure must never be misread as a conflict, and retrying it
 * without re-provisioning credentials cannot succeed.
 *
 * @param {string} output - the raw stderr/stdout of the failed `bd dolt` command
 * @returns {'no-remote'|'empty-remote'|'remote-unreachable'|'diverged'|'auth'|'transient'|'unknown'}
 */
export function classifyDoltFailure(output) {
    const text = String(output == null ? '' : output);
    for (const re of DOLT_NO_REMOTE_PATTERNS) if (re.test(text)) return 'no-remote';
    for (const re of DOLT_EMPTY_REMOTE_PATTERNS) if (re.test(text)) return 'empty-remote';
    for (const re of DOLT_REMOTE_UNREACHABLE_PATTERNS) if (re.test(text)) return 'remote-unreachable';
    for (const re of DOLT_DIVERGED_PATTERNS) if (re.test(text)) return 'diverged';
    for (const re of DOLT_AUTH_PATTERNS) if (re.test(text)) return 'auth';
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

/**
 * Run a single `bd dolt` command via the injected command() with failSoft,
 * retrying ONLY transient failures up to `maxTransientRetries` times. A
 * diverged (or unknown) failure is returned immediately, never retried.
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
async function runDoltStep({ command, member, cmd, label, log, maxTransientRetries, onAuthFailure }) {
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
            log(`[Dolt] transient failure for member '${member}' (${label}); retry ${attempt}/${maxTransientRetries}: ${error}`);
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
    const { command, log = () => {}, maxTransientRetries = 1, checkSyncRemoteConfigured, skipPull = false, onAuthFailure } = opts;
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
        label: `D-pull for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
    const { command, pushBeads = true, log = () => {}, maxTransientRetries = 1, mutex, sprintId, checkSyncRemoteConfigured, onAuthFailure } = opts;
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
        label: `D-push for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
        label: `D-push reconcile pull for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
        label: `D-push re-push after reconcile for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
// Public API -- the only supported entry points (see the module header)
// ---------------------------------------------------------------------------

/**
 * BEFORE bracket. Freshen `member`'s beads clone so whatever happens next --
 * a dispatch, or an orchestrator-side read of cross-member beads state --
 * sees the shared remote's current truth rather than a stale local copy.
 *
 * `opts.healthGate: true` selects the pre-flight variant used once per run
 * before any mutating git/PR command: identical probe, but a divergence is
 * re-thrown with the composed, actionable "beads DB diverged" line (workspace
 * path + conflicting tables + remediation) that the dashboard persists.
 *
 * All other opts are passed through unchanged to doltPullBefore():
 * `command` (required), `log`, `maxTransientRetries`, `skipPull`,
 * `onAuthFailure`, `checkSyncRemoteConfigured`.
 *
 * @param {string} member
 * @param {{ command: Function, healthGate?: boolean, log?: Function, maxTransientRetries?: number, checkSyncRemoteConfigured?: Function, skipPull?: boolean, onAuthFailure?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, skipped?: true, reason?: 'no-remote'|'empty-remote'|'already-fresh' }>}
 * @throws {DoltDivergedError|DoltSyncError}
 */
export async function syncBefore(member, opts = {}) {
    const { healthGate = false, ...rest } = opts;
    return healthGate
        ? preflightBeadsHealthGate(member, rest)
        : doltPullBefore(member, rest);
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
 * This is the seam the recovery ladder is to be wired behind -- see the
 * RECOVERY-LADDER DISPOSITION note in the module header (apra-fleet-vkc.1).
 *
 * @param {string} member
 * @param {{ command: Function, pushBeads?: boolean, log?: Function, maxTransientRetries?: number, mutex?: { acquire: Function, release: Function }, sprintId?: string, checkSyncRemoteConfigured?: Function, onAuthFailure?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, reconciled: boolean, skipped?: true, reason?: 'no-remote' }>}
 * @throws {DoltDivergedError|DoltSyncError}
 */
export async function syncAfter(member, opts = {}) {
    return doltPushAfter(member, opts);
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

export const DoltSync = { syncBefore, syncAfter, status };

export default DoltSync;
