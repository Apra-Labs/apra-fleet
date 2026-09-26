// =============================================================================
// Auto-sprint supervisor -- the supervisor's OWN stdout/stderr, captured and
// served (companion to log-view.mjs, which does the same for a sprint CHILD's
// output). Before this, the supervisor's own console.log/error output only
// existed wherever the launching shell happened to redirect it (or nowhere,
// for an interactive run) -- there was no operator-facing way to see it, and
// no timestamps on individual lines to correlate against sprint activity.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir, SPRINT_LOG_SUBDIR } from './spawner.mjs';
import { sendPlain } from './history-view.mjs';
import { tailLines } from './log-view.mjs';

/** Filename for the supervisor's own log, under the same logs/ dir sprint children's raw logs live in. */
export const SELF_LOG_FILE_NAME = 'supervisor.log';

/**
 * @param {string} [dataDir]
 * @returns {string} `<dataDir>/logs/supervisor.log`
 */
export function resolveSelfLogPath(dataDir = defaultDataDir()) {
    return path.join(dataDir, SPRINT_LOG_SUBDIR, SELF_LOG_FILE_NAME);
}

/**
 * Local-time (not UTC) timestamp for a log line, `YYYY-MM-DD HH:mm:ss.sss`.
 * `Date#toISOString()` is deliberately not used here -- it is always UTC,
 * which is the wrong read for an operator correlating this log against
 * their own wall clock while watching a live sprint.
 * @param {Date} [d]
 * @returns {string}
 */
export function formatLocalTimestamp(d = new Date()) {
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    );
}

/**
 * Installs a timestamped tee on console.log/warn/error: every call still
 * reaches the original console method (so an interactive run or a shell
 * redirect still sees output as before) AND is appended, prefixed with a
 * local-time timestamp, to the self-log file. Returns a `stop()` that
 * restores the original console methods and closes the file.
 *
 * @param {{ dataDir?: string, consoleObj?: Console, now?: () => Date, fsImpl?: typeof fs }} [opts]
 * @returns {{ logPath: string, stop: () => void }}
 */
export function installSelfLogTee(opts = {}) {
    const dataDir = opts.dataDir ?? defaultDataDir();
    const consoleObj = opts.consoleObj ?? console;
    const now = opts.now ?? (() => new Date());
    const fsImpl = opts.fsImpl ?? fs;

    const logPath = resolveSelfLogPath(dataDir);
    fsImpl.mkdirSync(path.dirname(logPath), { recursive: true });
    const stream = fsImpl.createWriteStream(logPath, { flags: 'a' });

    const original = { log: consoleObj.log, warn: consoleObj.warn, error: consoleObj.error };
    const wrap = (level, orig) => (...args) => {
        orig.apply(consoleObj, args);
        try {
            const line = args.map((a) => (typeof a === 'string' ? a : inspectArg(a))).join(' ');
            stream.write(`[${formatLocalTimestamp(now())}] [${level}] ${line}\n`);
        } catch {
            // Never let a formatting/write failure take down the supervisor
            // over a logging side channel -- the original console call above
            // already happened either way.
        }
    };
    consoleObj.log = wrap('info', original.log);
    consoleObj.warn = wrap('warn', original.warn);
    consoleObj.error = wrap('error', original.error);

    return {
        logPath,
        stop() {
            consoleObj.log = original.log;
            consoleObj.warn = original.warn;
            consoleObj.error = original.error;
            stream.end();
        },
    };
}

/** Minimal stand-in for util.inspect for the rare non-string console arg (an Error, an object), without pulling in the full module. */
function inspectArg(a) {
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
}

/**
 * Create the self-log HTTP view: `GET /supervisor/log`, mirroring log-view.mjs's
 * per-sprint route (same `?tail=N` support, same plain-text response).
 * @param {{ logPath: string, readFile?: (p: string, enc: string) => Promise<string> }} deps
 */
export function createSelfLogView({ logPath, readFile } = {}) {
    if (!logPath) throw new TypeError('createSelfLogView requires a logPath');
    const read = readFile ?? ((p, enc) => fs.promises.readFile(p, enc));

    async function handleGet(req, res, ctx) {
        let content;
        try {
            content = await read(logPath, 'utf-8');
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                sendPlain(res, 404, 'Supervisor log not found yet -- nothing has been logged since this route was registered.');
                return;
            }
            sendPlain(res, 500, `failed to read supervisor log: ${err.message}`);
            return;
        }
        const tailParam = ctx?.url?.searchParams?.get('tail');
        const tailN = tailParam != null ? Number(tailParam) : NaN;
        const body = Number.isInteger(tailN) && tailN > 0 ? tailLines(content, tailN) : content;
        sendPlain(res, 200, body);
    }

    return { name: 'self-log', handleGet };
}

/**
 * Registers `GET /supervisor/log` against a supervisor (server.mjs).
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {ReturnType<typeof createSelfLogView>} view
 */
export function registerSelfLogRoutes(supervisor, view) {
    supervisor.route('GET', '/supervisor/log', view.handleGet);
}
