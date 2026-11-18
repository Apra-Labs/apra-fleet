// =============================================================================
// fleet-sprint supervisor -- final exit log line.
//
// The supervisor's console tee (self-log.mjs) writes through an async
// createWriteStream, so Node's default fatal-error output and anything written
// at process exit never reach supervisor.log: a supervisor that died (its
// launching terminal closed, an uncaught error) left no trace. This module
// records WHY the process is exiting and writes exactly ONE final line, with
// the cause and exit code, using a SYNCHRONOUS append, on every observable
// exit path: SIGINT, SIGTERM, SIGHUP, SIGBREAK, uncaughtException,
// unhandledRejection, POST /api/shutdown and the forced-exit timeout.
//
// Installable in-process: `proc` (process-like emitter), `appendSync`, `exit`
// and `now` are seams so tests drive it with a fake emitter.
// =============================================================================

import fs from 'node:fs';
import { formatLocalTimestamp } from './self-log.mjs';

/** Signals that request a clean stop. SIGBREAK is Windows' Ctrl+Break / console close. */
export const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

/** One line: newlines in a stack are folded so the final record stays a single log line. */
function oneLine(text) {
    return String(text).replace(/\r?\n/g, ' | ');
}

function describeError(err) {
    if (err instanceof Error) return `${err.message} | stack: ${oneLine(err.stack || '')}`;
    return `${oneLine(typeof err === 'string' ? err : JSON.stringify(err))}`;
}

/**
 * @param {{
 *   logPath: string,
 *   proc?: NodeJS.EventEmitter & { exit?: (code?: number) => never },
 *   appendSync?: (file: string, data: string) => void,
 *   now?: () => Date,
 *   exit?: (code: number) => void,
 *   onSignal?: (signal: string) => void,
 *   causeProvider?: () => string | null | undefined,
 *   canStop?: () => boolean,
 *   stopOnSighup?: () => boolean,
 *   platform?: string,
 * }} opts
 * @returns {{ finalize: (code: number, cause?: string) => boolean, setCause: (cause: string) => void,
 *            exitFn: (code: number) => void, uninstall: () => void, readonly finalized: boolean }}
 */
export function installExitLogging(opts) {
    const { logPath } = opts;
    if (!logPath) throw new TypeError('installExitLogging requires a logPath');
    const proc = opts.proc ?? process;
    const appendSync = opts.appendSync ?? ((f, d) => fs.appendFileSync(f, d));
    const now = opts.now ?? (() => new Date());
    const exit = opts.exit ?? ((code) => proc.exit(code));
    const onSignal = opts.onSignal ?? (() => {});
    const causeProvider = opts.causeProvider ?? (() => null);
    const canStop = opts.canStop ?? (() => true);
    const platform = opts.platform ?? process.platform;
    const isWin = platform === 'win32';
    // Stop on SIGHUP only when attached to a terminal (the terminal closing is
    // the hangup). A detached POSIX launch (nohup, no TTY on stdio) keeps
    // running. Windows never ignores it: SIGHUP there means the console window
    // closed and the OS force-kills the process shortly after, whatever stdio is.
    const stopOnSighup = opts.stopOnSighup
        ?? (() => isWin || Boolean(proc.stdout?.isTTY || proc.stdin?.isTTY));

    let cause = null;
    let detail = null;
    let finalized = false;

    /** Write the one final line. Idempotent: only the first call writes. */
    function finalize(code, forcedCause) {
        if (finalized) return false;
        finalized = true;
        const why = forcedCause ?? cause ?? causeProvider() ?? 'exit';
        const level = code === 0 ? 'info' : 'error';
        const line = `[${formatLocalTimestamp(now())}] [${level}] [supervisor] final: cause=${why} exit_code=${code}${detail ? ` ${detail}` : ''}\n`;
        try { appendSync(logPath, line); } catch { /* never let a logging failure mask the exit */ }
        return true;
    }

    const handlers = [];
    const on = (event, fn) => { proc.on(event, fn); handlers.push([event, fn]); };

    for (const sig of EXIT_SIGNALS) {
        on(sig, () => {
            // A listener overrides the SIG_IGN that `nohup` sets, so a SIGHUP on a
            // detached launch (no controlling terminal on stdio) is logged and
            // survived rather than turned into a stop.
            if (sig === 'SIGHUP' && !stopOnSighup()) {
                try { console.log('[supervisor] received SIGHUP; ignored (detached launch, not stopping)'); } catch { /* ignore */ }
                return;
            }
            cause ??= `signal:${sig}`;
            if (sig === 'SIGHUP' && isWin) {
                // The forced kill can land before the 'exit' event, so write the
                // final line now, before starting the (slower) logged stop.
                detail ??= 'note: written before stop completes (console closed, forced kill imminent)';
                finalize(0);
            }
            if (!canStop()) {
                // Still starting up (no supervisor to stop): our listener has
                // suppressed Node's default terminate, so finalize and exit now.
                onSignal(sig);
                const code = sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 1;
                finalize(code);
                exit(code);
                return;
            }
            onSignal(sig);
        });
    }

    const fatal = (kind) => (err) => {
        cause ??= kind;
        detail ??= `message: ${describeError(err)}`;
        try { console.error(`[supervisor] ${kind}:`, err); } catch { /* ignore */ }
        finalize(1);
        exit(1);
    };
    on('uncaughtException', fatal('uncaughtException'));
    on('unhandledRejection', fatal('unhandledRejection'));

    // Backstop and the normal path: the real exit code is only known here.
    on('exit', (code) => { finalize(typeof code === 'number' ? code : 0); });

    return {
        finalize,
        setCause(c) { cause ??= c; },
        /** Exit function for the supervisor's forced-exit timer: logs, then exits. */
        exitFn(code) {
            finalize(code, 'forced-exit-timeout');
            exit(code);
        },
        uninstall() {
            for (const [event, fn] of handlers.splice(0)) proc.removeListener(event, fn);
        },
        get finalized() { return finalized; },
    };
}
