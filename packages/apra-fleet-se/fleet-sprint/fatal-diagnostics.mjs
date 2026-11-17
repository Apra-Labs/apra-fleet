// Fatal-diagnostics guard and the terminal-state Dolt-conflict classification
// helpers, extracted out of runner.js (apra-fleet-3swo.6.16); runner.js
// re-exports every symbol it previously exported from this region, so
// existing importers of fleet-sprint/runner.js resolve unchanged.
import { DoltDivergedError } from './errors.mjs';

// ---------------------------------------------------------------------------
// Fatal-diagnostics guard
// ---------------------------------------------------------------------------
//
// main()'s try/catch around runSprintCycle() only ever sees errors that
// propagate up an AWAITED call chain: it can never see a promise that rejects
// with nothing awaiting it, or a synchronous throw that escapes every awaited
// frame. Without this guard such a failure ends the run with no usable signal.
// The guard makes it observable: an explicit [FATAL] line (cause + the last
// phase this run entered) through the run's own log(), plus a best-effort
// publishState('terminal', ...) so a watchdog, dashboard, or human sees a real
// lastError instead of state frozen mid-run with no explanation.
//
// It deliberately does not attempt to recover or continue -- by the time either
// process-level event fires the process's control flow is in an unspecified
// state.
/**
 * @param {{ log?: (msg: string) => void, publishState?: (namespace: string, data: any) => void, phaseOf?: () => string|null }} deps
 * @returns {() => void} uninstall() -- removes both listeners.
 */
export function installFatalDiagnosticsGuard(deps = {}) {
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const publishState = typeof deps.publishState === 'function' ? deps.publishState : null;
    const phaseOf = typeof deps.phaseOf === 'function' ? deps.phaseOf : () => null;

    const handle = (kind) => (err) => {
        const message = (err && err.message) || String(err);
        const stack = (err && err.stack) || null;
        const phase = phaseOf();
        log(`[FATAL] ${kind} (last known phase: ${phase ?? 'unknown'}): ${message}${stack ? `\n${stack}` : ''}`);
        if (publishState) {
            try {
                publishState('terminal', {
                    verdict: 'ABORTED',
                    failed: true,
                    terminalReason: kind,
                    lastError: { message, stack, phase, kind, at: new Date().toISOString() },
                });
            } catch (publishErr) {
                // Diagnostics reporting itself must never crash harder than the
                // failure it is trying to record -- log and move on.
                log(`[FATAL] ${kind}: failed to persist terminal error state: ${(publishErr && publishErr.message) || publishErr}`);
            }
        }
    };

    const onUnhandledRejection = handle('unhandledRejection');
    const onUncaughtException = handle('uncaughtException');
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);

    return function uninstall() {
        process.off('unhandledRejection', onUnhandledRejection);
        process.off('uncaughtException', onUncaughtException);
    };
}

// ---------------------------------------------------------------------------
// Classify an unmergeable Dolt conflict as its own terminal state
// (BEADS_SYNC_CONFLICT), not the generic wrapper/UNKNOWN bucket -- and
// best-effort carry forward the raw conflict diagnostics an operator would
// otherwise have to re-derive by hand.
// ---------------------------------------------------------------------------

/**
 * Walks a thrown error's `.cause` chain (bounded, so a pathological circular
 * cause can never loop forever) looking for a DoltDivergedError -- either
 * the error itself, or wrapped one level down inside a PostDispatchSyncError
 * (withGitSync's post-dispatch D-push bracket wraps a diverged sync failure
 * this way; see PostDispatchSyncError's own doc comment in errors.mjs). A
 * plain `bd dolt pull` divergence (preflightBeadsHealthGate / doltPullBefore,
 * before any dispatch ever ran) throws DoltDivergedError directly, with no
 * wrapper -- also matched here.
 * @param {unknown} err
 * @returns {import('./errors.mjs').DoltDivergedError|null}
 */
export function findDoltDivergedCause(err) {
    let cur = err;
    for (let depth = 0; cur && depth < 5; depth += 1) {
        if (cur instanceof DoltDivergedError) return cur;
        cur = cur.cause;
    }
    return null;
}

/**
 * The terminal-state `terminalReason` main()'s typed-abort catch persists. A
 * genuinely unmergeable Dolt conflict -- surfaced either directly (a
 * pre-dispatch `bd dolt pull` divergence) or wrapped inside a
 * PostDispatchSyncError (a D-push divergence discovered AFTER a dispatch
 * already completed) -- is reported as the distinct 'BEADS_SYNC_CONFLICT', so
 * the supervisor/dashboard shows "beads sync conflict, needs operator
 * resolution" instead of collapsing it into the same generic bucket as every
 * other termination reason. Every other error keeps the
 * `err.code || err.name || 'UNKNOWN_ABORT'` behavior.
 * @param {unknown} err
 * @returns {string}
 */
export function resolveTerminalReason(err) {
    if (findDoltDivergedCause(err)) return 'BEADS_SYNC_CONFLICT';
    return (err && (err.code || err.name)) || 'UNKNOWN_ABORT';
}

/**
 * Best-effort diagnostics for a BEADS_SYNC_CONFLICT terminal state -- the raw
 * `bd dolt pull`/`bd dolt push` stderr
 * (DoltDivergedError.doltOutput) that proved the divergence, captured at the
 * moment `runDoltStep()` observed the failure (i.e. BEFORE any later `bd`
 * invocation's own safe-abort/cleanup could discard whatever state it was
 * describing) and carried on the error object ever since. This is pure
 * plumbing of already-captured data through to the terminal state -- no new
 * `bd`/SQL command is issued here -- so a human resolving the conflict later
 * starts with the actual rejection text in hand instead of having to
 * reproduce it by re-running `bd dolt pull`/`dolt merge --no-commit`
 * themselves. Returns `null` (never throws) when `err` carries no
 * DoltDivergedError cause.
 * @param {unknown} err
 * @returns {{ member: string|null, operation: string|null, doltOutput: string|null }|null}
 */
export function captureDoltConflictDump(err) {
    const diverged = findDoltDivergedCause(err);
    if (!diverged) return null;
    return {
        member: diverged.member ?? null,
        operation: diverged.operation ?? null,
        doltOutput: diverged.doltOutput ?? null,
    };
}
