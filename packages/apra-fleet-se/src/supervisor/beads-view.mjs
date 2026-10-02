// The supervisor's cached beads view.
//
// One in-memory copy of the RAW `bd list --all --limit 0 --json` rows for the
// supervisor's own .beads, kept current through the supervisor's backlog
// member (src/supervisor/backlog-member.mjs): every refresh first runs the
// engine's own D-pull (fleet-sprint/dolt-sync.mjs doltPullBefore()) on that
// member, whose remote-tip fingerprint turns an unchanged shared remote into a
// single `git ls-remote` -- no `bd dolt pull`, and no re-list either.
//
// Design decisions (already made upstream -- see the planning notes):
//
//   * RAW rows only. Never a derived or claim-subtracted tree: claimed scope
//     depends on the live ledger and watchdog classification at READ time.
//   * One bulk list (bdListAllBeadsWithClosed, i.e. `bd list --all --limit 0
//     --json`), never per-root subtree fetches.
//   * The list runs IN-PROCESS with cwd = repoRoot, the same folder the
//     backlog member's work folder is, so the pull and the list provably touch
//     the same clone. A null/degraded backlog member records lastError with
//     the reason and lists nothing (no silent list from an unpulled clone).
//   * maxTransientRetries: 0 on the pull. runDoltStep() otherwise retries a
//     lock/transient failure with backoff for minutes, and one busy lock would
//     stall the single in-flight slot. A lock/busy round is SKIPPED instead
//     (rows kept, lastSkip set, lastError untouched); the next refresh retries
//     and the pull is idempotent.
//   * No `settle`: the supervisor never runs conflict settlement.
//   * ledger.setScopeFreshness() on EVERY successful check (a pull+re-list AND
//     a confirmed unchanged tip) -- lastSyncedAt means "this clone is known
//     current as of that moment". Never on a skip or failure.
//   * Single in-flight: concurrent refresh() callers join one promise.
//   * snapshot() never spawns or waits. refreshIfStale() starts a background
//     refresh and returns immediately. freshForLaunch() is the only reader that
//     waits, and it never returns rows it did not fetch in that very call.
//
// The supervisor performs no bead mutations of its own (only reads), so there
// is no invalidate-on-mutation seam here.

import { doltPullBefore as defaultDoltPullBefore, classifyDoltFailure } from '../../fleet-sprint/dolt-sync.mjs';
import { bdListAllBeadsWithClosed } from './scope-overlap.mjs';

/** refreshIfStale()'s default staleness bound. */
export const DEFAULT_BEADS_VIEW_MAX_AGE_MS = 15_000;

/** Per-step bound handed to doltPullBefore (forwarded to every member
 *  command as timeout_s): short, because a refresh holds the only slot. */
export const DEFAULT_BEADS_VIEW_PULL_TIMEOUT_S = 30;

/** freshForLaunch()'s default wall-clock bound (join + own check). */
export const DEFAULT_FRESH_FOR_LAUNCH_TIMEOUT_MS = 45_000;

/** A lock/busy failure named in error text the dolt classifier left 'unknown'. */
const LOCK_OR_BUSY_RE = /\block(?:ed|s)?\b|\bbusy\b/i;

/**
 * Typed rejection of freshForLaunch(): the launch path answers 503 with
 * `reason`.
 */
export class BeadsViewUnavailableError extends Error {
    /**
     * @param {string} reason - human-readable cause
     * @param {{ kind?: 'timeout'|'skip'|'error'|'stopped' }} [opts]
     */
    constructor(reason, opts = {}) {
        super(`beads view unavailable: ${reason}`);
        this.name = 'BeadsViewUnavailableError';
        this.code = 'BEADS_VIEW_UNAVAILABLE';
        this.reason = reason;
        this.kind = opts.kind ?? 'error';
    }
}

/**
 * Normalize an executeFleetCommand() result into the `{ ok, output }` /
 * `{ ok: false, error }` shape doltPullBefore's command() contract expects.
 *
 * The fleet server's execute_command does not flag a non-zero exit as an
 * error, so `ok` is derived from the real exit code: structured `exitCode`
 * (with clean stdout) when the server sent it, else the `Exit code: N` prefix
 * of the display text. Without this a failed `bd dolt pull` would read as a
 * success, and `bd config get sync.remote --json` would never parse (the
 * prefix is not JSON), silently disabling the remote-tip fingerprint.
 *
 * @param {any} res
 * @returns {{ ok: true, output: string } | { ok: false, error: string }}
 */
export function normalizeFleetCommandResult(res) {
    if (!res || typeof res !== 'object') return { ok: false, error: 'no result from execute_command' };
    if (res.ok === false) return { ok: false, error: String(res.error ?? 'unknown error') };
    if (typeof res.exitCode === 'number') {
        const stdout = typeof res.stdout === 'string' ? res.stdout : '';
        const stderr = typeof res.stderr === 'string' ? res.stderr : '';
        if (res.exitCode !== 0) {
            const body = [stderr, stdout].filter((s) => s && s.trim()).join('\n').trim();
            return { ok: false, error: `Exit code ${res.exitCode}: ${body || '(no output)'}` };
        }
        return { ok: true, output: stdout };
    }
    const text = String(res.output ?? '');
    const m = /^Exit code:\s*(-?\d+)\r?\n?/.exec(text);
    if (m) {
        const code = Number(m[1]);
        const body = text.slice(m[0].length);
        if (code !== 0) return { ok: false, error: `Exit code ${code}: ${body.trim() || '(no output)'}` };
        return { ok: true, output: body };
    }
    // No recoverable exit code means the command never ran: every such
    // execute_command reply is the tool's own refusal/failure text (`Member
    // "<x>" not found.`, a credential refusal, `Failed to execute command on
    // "<member>": ...`). Fail CLOSED -- reading it as success would let an
    // unpulled clone be listed and reported fresh.
    return { ok: false, error: text.trim() || 'execute_command returned no exit code and no output' };
}

/**
 * Build the command() doltPullBefore expects -- `command(cmd, { member_name,
 * silent, failSoft, label, timeout_s })` -> `{ ok, output }` / `{ ok: false,
 * error }` -- over executeFleetCommand (fleet-members.mjs). `timeout_s` MUST
 * be forwarded: executeFleetCommand's own default is 60s, which would cut off
 * every real pull at 60s regardless of the step bound.
 *
 * @param {{ executeFleetCommand: Function, resolveConnection: Function, logger?: object }} deps
 * @returns {(cmd: string, opts?: object) => Promise<{ ok: boolean, output?: string, error?: string }>}
 */
export function createBeadsViewCommand(deps = {}) {
    const { executeFleetCommand, resolveConnection, logger } = deps;
    if (typeof executeFleetCommand !== 'function') throw new TypeError('createBeadsViewCommand requires an executeFleetCommand() collaborator');
    if (typeof resolveConnection !== 'function') throw new TypeError('createBeadsViewCommand requires a resolveConnection() collaborator');
    return async function beadsViewCommand(cmd, opts = {}) {
        const req = { member: opts.member_name, command: cmd, resolveConnection };
        if (opts.timeout_s !== undefined && opts.timeout_s !== null) req.timeoutSeconds = opts.timeout_s;
        if (logger) req.logger = logger;
        let res;
        try {
            res = await executeFleetCommand(req);
        } catch (err) {
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
        return normalizeFleetCommandResult(res);
    };
}

function errorText(err) {
    if (!err) return 'unknown error';
    const parts = [];
    if (typeof err.doltOutput === 'string' && err.doltOutput) parts.push(err.doltOutput);
    if (typeof err.stderr === 'string' && err.stderr) parts.push(err.stderr);
    parts.push(err.message ? err.message : String(err));
    return parts.join('\n');
}

/**
 * Is `err` a lock/busy/transient failure (skip the round) rather than a real
 * failure (record lastError)? The dolt classifier decides first; only when it
 * cannot place the text at all does a lock/busy mention count.
 */
export function isBusyFailure(err) {
    const text = errorText(err);
    const kind = classifyDoltFailure(text);
    if (kind === 'transient') return true;
    return kind === 'unknown' && LOCK_OR_BUSY_RE.test(text);
}

/**
 * Create the cached beads view.
 *
 * @param {{
 *   backlogMember: { get: () => { member: { name: string }|null, status: string, reason?: string|null } },
 *   ledger?: { setScopeFreshness: (timestamp?: string) => Promise<unknown> } | null,
 *   command: Function,
 *   repoRoot?: string|null,
 *   listAllBeads?: (opts: { cwd?: string }) => Promise<object[]>,
 *   doltPullBefore?: Function,
 *   now?: () => number,
 *   logger?: { log?: Function, warn?: Function, error?: Function },
 *   pullTimeoutS?: number,
 *   setTimeout?: Function,
 *   clearTimeout?: Function,
 * }} deps
 */
export function createBeadsView(deps = {}) {
    const { backlogMember, command } = deps;
    if (!backlogMember || typeof backlogMember.get !== 'function') {
        throw new TypeError('createBeadsView requires a backlogMember handle with get()');
    }
    if (typeof command !== 'function') throw new TypeError('createBeadsView requires a command() collaborator');
    const ledger = deps.ledger ?? null;
    const repoRoot = deps.repoRoot ?? null;
    const listAllBeads = deps.listAllBeads ?? bdListAllBeadsWithClosed;
    const pull = deps.doltPullBefore ?? defaultDoltPullBefore;
    const now = deps.now ?? Date.now;
    const logger = deps.logger ?? console;
    const log = (...a) => (logger.log ?? (() => {}))(...a);
    const warn = (...a) => (logger.warn ?? logger.log ?? (() => {}))(...a);
    const logError = (...a) => (logger.error ?? logger.log ?? (() => {}))(...a);
    const pullTimeoutS = Number.isFinite(deps.pullTimeoutS) && deps.pullTimeoutS > 0 ? deps.pullTimeoutS : DEFAULT_BEADS_VIEW_PULL_TIMEOUT_S;
    const setTimer = deps.setTimeout ?? setTimeout;
    const clearTimer = deps.clearTimeout ?? clearTimeout;

    let rows = null;
    let asOf = null;
    let lastCheckedAt = null;
    let lastError = null;
    let lastSkip = null;
    let inFlight = null;
    let stopped = false;

    function snapshot() {
        return { rows, asOf, lastCheckedAt, lastError, lastSkip, refreshing: inFlight !== null };
    }

    function recordSkip(reason) {
        const at = now();
        lastCheckedAt = at;
        lastSkip = { reason, at };
        warn(`[beads-view] refresh skipped (will retry on the next refresh): ${reason}`);
        return { kind: 'skip', reason };
    }

    function recordError(reason) {
        const at = now();
        lastCheckedAt = at;
        lastError = { message: reason, at };
        logError(`[beads-view] ERROR: refresh failed; keeping the previously cached rows: ${reason}`);
        return { kind: 'error', reason };
    }

    /**
     * One check. `forceList` re-lists rows even when the remote tip is
     * unchanged (freshForLaunch). Never throws.
     */
    async function runCheck({ forceList }) {
        const st = backlogMember.get() || {};
        const memberName = st.member && typeof st.member.name === 'string' ? st.member.name : null;
        if (st.status !== 'ready' || !memberName) {
            return recordError(`backlog member not ready (${st.reason || st.status || 'no backlog member'}); the beads clone cannot be pulled`);
        }

        let pullRes;
        try {
            pullRes = await pull(memberName, { command, log, maxTransientRetries: 0, timeoutS: pullTimeoutS });
        } catch (err) {
            if (isBusyFailure(err)) return recordSkip(`D-pull on backlog member '${memberName}' hit a lock/busy/transient failure: ${err && err.message ? err.message : err}`);
            return recordError(`D-pull on backlog member '${memberName}' failed: ${err && err.message ? err.message : err}`);
        }

        const tipUnchanged = !!(pullRes && pullRes.skipped && pullRes.reason === 'remote-unchanged');
        const needList = forceList || rows === null || !tipUnchanged;
        let listed = null;
        if (needList) {
            try {
                listed = await listAllBeads(repoRoot ? { cwd: repoRoot } : {});
            } catch (err) {
                if (isBusyFailure(err)) return recordSkip(`bd list hit a lock/busy failure: ${err && err.message ? err.message : err}`);
                return recordError(`bd list --all failed: ${err && err.message ? err.message : err}`);
            }
            if (!Array.isArray(listed)) return recordError('bd list --all returned a non-array result');
            rows = listed;
        }

        const at = now();
        asOf = at;
        lastCheckedAt = at;
        lastError = null;
        lastSkip = null;
        if (ledger && typeof ledger.setScopeFreshness === 'function') {
            try {
                await ledger.setScopeFreshness(new Date(at).toISOString());
            } catch (err) {
                logError(`[beads-view] ERROR: could not record scope freshness in the ledger: ${err && err.message ? err.message : err}`);
            }
        }
        return { kind: 'ok', rows: listed, listed: listed !== null, tipUnchanged };
    }

    /** Occupy the single in-flight slot with `fn`; the slot frees when it settles. */
    function occupy(fn) {
        const p = (async () => {
            try {
                return await fn();
            } catch (err) {
                // runCheck never throws; this is a last-resort guard so the
                // slot can never hold a rejected promise that callers see.
                return recordError(`unexpected beads view failure: ${err && err.message ? err.message : err}`);
            } finally {
                if (inFlight === p) inFlight = null;
            }
        })();
        inFlight = p;
        return p;
    }

    /** Refresh now (or join the refresh in flight). Resolves the snapshot; never rejects. */
    async function refresh() {
        if (!inFlight && !stopped) occupy(() => runCheck({ forceList: false }));
        if (inFlight) await inFlight;
        return snapshot();
    }

    /**
     * Start a background refresh when the last check is older than
     * `maxAgeMs` (or never happened) and nothing is in flight. Returns
     * immediately: true when a refresh was started. Never rejects.
     */
    function refreshIfStale(maxAgeMs = DEFAULT_BEADS_VIEW_MAX_AGE_MS) {
        if (stopped || inFlight) return false;
        if (lastCheckedAt !== null && now() - lastCheckedAt < maxAgeMs) return false;
        occupy(() => runCheck({ forceList: false })).catch(() => {});
        return true;
    }

    /**
     * Rows fetched by THIS call, for the launch overlap guard. Joins any
     * in-flight refresh first (never a second concurrent one), then runs its
     * own check, which always re-lists. Rejects with BeadsViewUnavailableError
     * on timeout, skip, failure, or a not-ready backlog member.
     *
     * @param {{ timeoutMs?: number }} [opts]
     * @returns {Promise<object[]>}
     */
    function freshForLaunch(opts = {}) {
        const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_FRESH_FOR_LAUNCH_TIMEOUT_MS;
        if (stopped) return Promise.reject(new BeadsViewUnavailableError('the supervisor is shutting down', { kind: 'stopped' }));
        let abandoned = false;
        const work = (async () => {
            // Join whatever is in flight; loop because another caller may
            // have taken the slot again by the time we resume.
            while (inFlight) await inFlight;
            if (abandoned) return null;
            if (stopped) throw new BeadsViewUnavailableError('the supervisor is shutting down', { kind: 'stopped' });
            const outcome = await occupy(() => runCheck({ forceList: true }));
            if (outcome.kind === 'ok' && Array.isArray(outcome.rows)) return outcome.rows;
            if (outcome.kind === 'skip') throw new BeadsViewUnavailableError(outcome.reason, { kind: 'skip' });
            throw new BeadsViewUnavailableError(outcome.reason || 'fresh beads check failed', { kind: 'error' });
        })();
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimer(() => {
                abandoned = true;
                reject(new BeadsViewUnavailableError(`fresh beads check did not finish within ${timeoutMs}ms`, { kind: 'timeout' }));
            }, timeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
        });
        // If the timeout wins, the work keeps holding the slot until it
        // settles (so no second pull starts); its own outcome is discarded.
        work.catch(() => {});
        return Promise.race([work, timeout]).finally(() => clearTimer(timer));
    }

    function stop() {
        stopped = true;
    }

    return { snapshot, refresh, refreshIfStale, freshForLaunch, stop };
}
