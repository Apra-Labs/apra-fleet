/**
 * Auto-start of the SHARED apra-fleet HTTP server for clients that find it
 * verifiably gone (GitHub #585 recovery).
 *
 * The client runs the same `apra-fleet start` the user would: same binary,
 * same verb, same environment -- so the server comes up exactly as a manual
 * start brings it up (through the user-level OS service when one is
 * installed, else a detached direct spawn), with every server-side singleton
 * / port / startup-lock check applying. The started server is NOT a child of
 * the client: `start` detaches it and exits, so it outlives the client.
 *
 * Guards:
 *  - a client lock file in the data dir serialises racing clients -- one
 *    runs `start`, the others wait for /health;
 *  - a ledger in the data dir caps auto-starts (default 3 per 10 minutes);
 *    past that the client fails with an error naming the newest server log
 *    instead of restarting a crashing server forever.
 *
 * All filesystem/process/clock access is injectable for tests.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AUTOSTART_MAX_STARTS = 3;
export const AUTOSTART_WINDOW_MS = 10 * 60 * 1000;
export const AUTOSTART_TIMEOUT_MS = 45 * 1000;
const POLL_MS = 500;

export const AUTOSTART_LEDGER_FILE = 'client-autostart.json';
export const AUTOSTART_LOCK_FILE = 'client-autostart.lock';
/** Written by `apra-fleet stop` (src/services/stopped-marker.ts); keep the name and fields in sync. */
export const STOPPED_BY_USER_FILE = 'stopped-by-user.json';

/**
 * The "stopped by user" marker in a data dir, or null. While present the
 * client never starts the server (the user stopped it deliberately).
 * @param {string} dataDir
 * @returns {{stoppedAt: string, by?: string, user?: string}|null}
 */
export function readStoppedByUser(dataDir) {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(dataDir, STOPPED_BY_USER_FILE), 'utf8'));
        return m && typeof m.stoppedAt === 'string' ? m : null;
    } catch {
        return null;
    }
}

/** The actionable refusal for a server the user stopped. code SERVER_STOPPED_BY_USER. */
export function stoppedByUserError(marker) {
    return new FleetAutoStartError(
        `apra-fleet was stopped by the user at ${marker.stoppedAt}${marker.user ? ` (${marker.user}, via '${marker.by || 'apra-fleet stop'}')` : ''}; ` +
            "run 'apra-fleet start' to start it again. Clients do not restart a server that was stopped on purpose.",
        { code: 'SERVER_STOPPED_BY_USER', details: marker },
    );
}

/**
 * Typed failure of a client auto-start. code: AUTOSTART_LIMIT | AUTOSTART_TIMEOUT |
 * AUTOSTART_NO_BINARY | AUTOSTART_VERSION_SKEW | AUTOSTART_VERSION_UNKNOWN |
 * AUTOSTART_TEST_UNINJECTED | SERVER_UNRESPONSIVE | SERVER_STOPPED_BY_USER
 */
export class FleetAutoStartError extends Error {
    constructor(message, { code, details } = {}) {
        super(message);
        this.name = 'FleetAutoStartError';
        this.code = code || 'AUTOSTART_FAILED';
        this.details = details;
    }
}

function dataDirOf(env) {
    return env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');
}

function nodeCommand() {
    return /^node(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : 'node';
}

/** "v0.4.3_95435e" / "0.4.4" -> "0.4.3" / "0.4.4" (null when absent). */
export function versionCore(v) {
    const m = /(\d+\.\d+\.\d+)/.exec(String(v || ''));
    return m ? m[1] : null;
}

function readJsonVersion(file, exists, readFile) {
    try {
        if (!exists(file)) return null;
        const v = JSON.parse(readFile(file)).version;
        return typeof v === 'string' && v ? v : null;
    } catch {
        return null;
    }
}

/**
 * The apra-fleet version this client package ships with: the nearest
 * version.json above this module (dev monorepo) or the workflows/.installed.json
 * written by the install that extracted it (~/.apra-fleet/node_modules/...).
 * @param {{ expectedVersion?: string|null, clientDir?: string,
 *           exists?: (p: string) => boolean, readFile?: (p: string) => string }} [deps]
 * @returns {string|null}
 */
export function clientServerVersion(deps = {}) {
    if (deps.expectedVersion !== undefined) return deps.expectedVersion;
    const exists = deps.exists || fs.existsSync;
    const readFile = deps.readFile || ((f) => fs.readFileSync(f, 'utf8'));
    let dir = deps.clientDir || __dirname;
    try { dir = fs.realpathSync(dir); } catch { /* keep */ }
    for (let i = 0; i < 8; i++) {
        const v = readJsonVersion(path.join(dir, 'version.json'), exists, readFile)
            || readJsonVersion(path.join(dir, 'workflows', '.installed.json'), exists, readFile);
        if (v) return v;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

/**
 * Version of a start candidate: <root>/version.json for a node entry
 * (<root>/dist/index.js), `<binary> --version` for a binary.
 */
function defaultProbeVersion(candidate, env) {
    if (candidate.kind === 'entry') {
        return readJsonVersion(path.join(path.dirname(path.dirname(candidate.entry)), 'version.json'), fs.existsSync, (f) => fs.readFileSync(f, 'utf8'));
    }
    try {
        const out = execFileSync(candidate.command, ['--version'], { env, stdio: 'pipe', windowsHide: true, timeout: 15_000 }).toString();
        const m = /apra-fleet\s+(v?\S+)/i.exec(out);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/**
 * The `apra-fleet start` command line. Candidates, most exact first:
 *  1. this process IS the apra-fleet binary (the SEA `apra-fleet workflow` trampoline);
 *  2. <dirname>/index.js (bundled layout), <dirname>/../../../dist/index.js
 *     (dev monorepo, keyed off the consumer's dirname) and the repo dist/
 *     relative to this module -- run with node;
 *  3. the installed binary, ~/.apra-fleet/bin/apra-fleet[.exe].
 * The first candidate whose version matches this client's apra-fleet version
 * (clientServerVersion) wins. A different version is NEVER started: an older
 * server can lack guards the client relies on (e.g. a pre-#584 server binds a
 * random port beside the real one -- a split fleet). With no match the client
 * fails with AUTOSTART_VERSION_SKEW naming both versions and 'apra-fleet install'.
 *
 * Inside the test sandbox (APRA_TEST_SANDBOX_ROOT) the lookup must be
 * injected (exists + homedir): a test may never fall through to a real
 * installed binary.
 *
 * @param {{ env?: object, dirname?: string, exists?: (p: string) => boolean, execPath?: string,
 *           homedir?: () => string, platform?: string, expectedVersion?: string|null,
 *           probeVersion?: (candidate: object) => string|null }} [deps]
 * @returns {{ command: string, args: string[], version: string }}
 */
export function resolveFleetStartCommand(deps = {}) {
    const env = deps.env || process.env;
    if (env.APRA_TEST_SANDBOX_ROOT && !(deps.exists && deps.homedir)) {
        throw new FleetAutoStartError(
            'auto-start binary resolution was not injected in a test run (pass startCommand, or exists + homedir) -- ' +
                'a test must never start a real installed apra-fleet binary.',
            { code: 'AUTOSTART_TEST_UNINJECTED' },
        );
    }
    const exists = deps.exists || fs.existsSync;
    const execPath = deps.execPath || process.execPath;
    const platform = deps.platform || process.platform;
    const homedir = deps.homedir || os.homedir;
    const probeVersion = deps.probeVersion || ((c) => defaultProbeVersion(c, env));

    const candidates = [];
    if (/^apra-fleet(\.exe)?$/i.test(path.basename(execPath))) {
        candidates.push({ kind: 'binary', label: 'this apra-fleet binary', command: execPath, args: ['start'] });
    }
    const entries = [];
    if (deps.dirname) {
        entries.push(path.join(deps.dirname, 'index.js'));
        entries.push(path.resolve(deps.dirname, '..', '..', '..', 'dist', 'index.js'));
    }
    entries.push(path.resolve(__dirname, '..', '..', '..', '..', 'dist', 'index.js'));
    for (const entry of entries) {
        if (exists(entry)) candidates.push({ kind: 'entry', label: 'build', entry, command: nodeCommand(), args: [entry, 'start'] });
    }
    const installed = path.join(homedir(), '.apra-fleet', 'bin', platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet');
    if (exists(installed)) candidates.push({ kind: 'binary', label: 'installed binary', command: installed, args: ['start'] });

    if (candidates.length === 0) {
        throw new FleetAutoStartError(
            'The apra-fleet HTTP server is not running and no apra-fleet installation was found to start it. Tried:\n' +
                entries.map((e) => `  - ${e}\n`).join('') +
                `  - ${installed}\n` +
                "Install apra-fleet ('apra-fleet install'), start the server yourself ('apra-fleet start'), " +
                'or set APRA_FLEET_TRANSPORT=stdio to run a private stdio server.',
            { code: 'AUTOSTART_NO_BINARY' },
        );
    }

    const expected = clientServerVersion(deps);
    if (!versionCore(expected)) {
        throw new FleetAutoStartError(
            'The apra-fleet HTTP server is not running, and this client cannot tell which apra-fleet version it ' +
                "belongs to, so it will not start one. Start the server yourself ('apra-fleet start').",
            { code: 'AUTOSTART_VERSION_UNKNOWN' },
        );
    }
    const seen = [];
    for (const c of candidates) {
        const v = probeVersion(c);
        if (versionCore(v) === versionCore(expected)) return { command: c.command, args: c.args, version: v };
        seen.push(`${c.label} ${c.entry || c.command}: ${v || 'unknown version'}`);
    }
    throw new FleetAutoStartError(
        `The apra-fleet HTTP server is not running. This client belongs to apra-fleet ${expected}, but the only apra-fleet ` +
            `found to start it is a different version (${seen.join('; ')}) -- not starting a mismatched server. ` +
            "Run 'apra-fleet install' to install the matching version, or start the server yourself ('apra-fleet start').",
        { code: 'AUTOSTART_VERSION_SKEW', details: { expected, found: seen } },
    );
}

/** Newest fleet-<pid>.log in <data dir>/logs, else <data dir>/fleet.log. */
export function lastServerLog(dataDir) {
    let best = null;
    try {
        const dir = path.join(dataDir, 'logs');
        for (const name of fs.readdirSync(dir)) {
            if (!/^fleet-\d+\.log$/.test(name)) continue;
            const p = path.join(dir, name);
            const m = fs.statSync(p).mtimeMs;
            if (!best || m > best.m) best = { p, m };
        }
    } catch { /* no logs dir */ }
    return best ? best.p : path.join(dataDir, 'fleet.log');
}

function readLedger(file) {
    try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(v.starts) ? v.starts.filter((t) => typeof t === 'number') : [];
    } catch {
        return [];
    }
}

function tryLock(file, now) {
    try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
        fs.closeSync(fd);
        return true;
    } catch {
        return false;
    }
}

function lockIsStale(file, now, maxAgeMs) {
    try {
        const { pid, at } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof at !== 'number' || now - at > maxAgeMs) return true;
        try { process.kill(pid, 0); } catch (err) { return !(err && err.code === 'EPERM'); }
        return false;
    } catch {
        return true; // unreadable/half-written lock: treat as stale
    }
}

/**
 * After an auto-start: the server that answered must be this client's
 * apra-fleet version. Unknown on either side -> no verdict (a server too old to
 * report a version is still caught by the start-candidate check).
 */
async function assertServerVersion(inst, deps) {
    const expected = versionCore(clientServerVersion(deps));
    const reported = await (deps.healthVersion || defaultHealthVersion)(inst.url);
    const got = versionCore(reported);
    if (expected && got && expected !== got) {
        throw new FleetAutoStartError(
            `Started the apra-fleet HTTP server, but it reports version ${reported} while this client belongs to ` +
                `apra-fleet ${clientServerVersion(deps)} (the registered service runs a different apra-fleet build). ` +
                'That server is still running and other clients will attach to it: stop it (\'apra-fleet stop\'), ' +
                "then run 'apra-fleet install' to install the matching version, then 'apra-fleet start'.",
            { code: 'AUTOSTART_VERSION_SKEW', details: { expected: clientServerVersion(deps), found: reported, url: inst.url, pid: inst.pid } },
        );
    }
}

/** The version a running server reports on GET /health, or null. */
function defaultHealthVersion(url) {
    return new Promise((resolve) => {
        const req = http.get(url.replace(/\/mcp$/, '/health'), { timeout: 3000 }, (res) => {
            let body = '';
            res.on('data', (d) => { if (body.length < 8192) body += d; });
            res.on('end', () => {
                try { resolve(JSON.parse(body).version || null); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

/** Runs `start`, collecting a bounded amount of its output. */
function defaultRunStart(command, args, env) {
    let output = '';
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const collect = (d) => { if (output.length < 4096) output += d.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const done = new Promise((resolve) => {
        child.once('error', (err) => resolve({ code: -1, output: output + String(err && err.message) }));
        child.once('exit', (code) => resolve({ code, output }));
    });
    return { done, kill: () => { try { child.kill(); } catch { /* gone */ } } };
}

/**
 * Start the shared HTTP server (it was found gone) and wait for /health.
 *
 * @param {{ env?: object, checkRunningInstance: (deps: {env: object}) => Promise<object>,
 *           dirname?: string, exists?: (p: string) => boolean,
 *           startCommand?: {command: string, args: string[]},
 *           runStart?: (command: string, args: string[], env: object) => {done: Promise<{code: number, output: string}>, kill?: () => void},
 *           now?: () => number, sleep?: (ms: number) => Promise<void>,
 *           timeoutMs?: number, maxStarts?: number, windowMs?: number }} deps
 * @returns {Promise<{running: true, url: string, pid: number, started: boolean}>}
 *   started=false when another client started it while this one waited.
 */
export async function autoStartFleetServer(deps) {
    const env = deps.env || process.env;
    const probe = deps.checkRunningInstance;
    const now = deps.now || Date.now;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const runStart = deps.runStart || defaultRunStart;
    const timeoutMs = deps.timeoutMs ?? (Number(env.APRA_FLEET_AUTOSTART_TIMEOUT_MS) || AUTOSTART_TIMEOUT_MS);
    const maxStarts = deps.maxStarts ?? AUTOSTART_MAX_STARTS;
    const windowMs = deps.windowMs ?? AUTOSTART_WINDOW_MS;

    const dataDir = dataDirOf(env);
    // Never undo a deliberate 'apra-fleet stop'.
    const stopped = readStoppedByUser(dataDir);
    if (stopped) throw stoppedByUserError(stopped);
    fs.mkdirSync(dataDir, { recursive: true });
    const lockFile = path.join(dataDir, AUTOSTART_LOCK_FILE);
    const ledgerFile = path.join(dataDir, AUTOSTART_LEDGER_FILE);
    const deadline = now() + timeoutMs;

    const unresponsive = (inst) => new FleetAutoStartError(
        `The apra-fleet HTTP server (pid ${inst.pid} at ${inst.url}) is alive but not answering /health -- ` +
            "not starting a second one. Run 'apra-fleet stop' and retry.",
        { code: 'SERVER_UNRESPONSIVE', details: { pid: inst.pid, url: inst.url } },
    );

    // Racing clients: exactly one runs `start`; the others wait for /health.
    while (!tryLock(lockFile, now())) {
        const inst = await probe({ env });
        if (inst && inst.running) return { ...inst, started: false };
        if (inst && inst.state === 'unresponsive') throw unresponsive(inst);
        if (lockIsStale(lockFile, now(), timeoutMs + 15_000)) {
            try { fs.unlinkSync(lockFile); } catch { /* raced */ }
            continue;
        }
        if (now() >= deadline) {
            throw new FleetAutoStartError(
                `Timed out after ${timeoutMs}ms waiting for another client to start the apra-fleet HTTP server. ` +
                    `Check ${lastServerLog(dataDir)}.`,
                { code: 'AUTOSTART_TIMEOUT', details: { log: lastServerLog(dataDir) } },
            );
        }
        await sleep(POLL_MS);
    }

    let child = null; // the 'start' process (it exits on its own after launching the server)
    try {
        // Re-check under the lock: a 'apra-fleet stop' may have raced us.
        const stoppedNow = readStoppedByUser(dataDir);
        if (stoppedNow) throw stoppedByUserError(stoppedNow);
        const first = await probe({ env });
        if (first && first.running) return { ...first, started: false };
        if (first && first.state === 'unresponsive') throw unresponsive(first);

        const recent = readLedger(ledgerFile).filter((t) => now() - t < windowMs);
        if (recent.length >= maxStarts) {
            const log = lastServerLog(dataDir);
            throw new FleetAutoStartError(
                `The apra-fleet HTTP server was auto-started ${recent.length} times in the last ` +
                    `${Math.round(windowMs / 60000)} minutes and is gone again -- not starting it again. ` +
                    `Check the last server log: ${log}. Then start it yourself with 'apra-fleet start'.`,
                { code: 'AUTOSTART_LIMIT', details: { log, starts: recent.length } },
            );
        }
        try {
            fs.writeFileSync(ledgerFile, JSON.stringify({ starts: [...recent, now()] }));
        } catch { /* best-effort */ }

        const cmd = deps.startCommand || resolveFleetStartCommand(deps);
        // APRA_FLEET_AUTOSTART=1: the started `apra-fleet start` refuses (instead
        // of clearing the marker) if a user stop lands in the meantime.
        child = runStart(cmd.command, cmd.args, { ...env, APRA_FLEET_AUTOSTART: '1' });
        let startResult = null;
        child.done.then((r) => { startResult = r; });

        while (now() < deadline) {
            await sleep(POLL_MS);
            const inst = await probe({ env });
            if (inst && inst.running) {
                // With a service installed, `apra-fleet start` runs whatever binary the
                // task/plist/unit points at -- verify what actually came up.
                await assertServerVersion(inst, deps);
                return { ...inst, started: true };
            }
        }
        if (!startResult && child.kill) child.kill(); // never the server: 'start' detached it
        const log = lastServerLog(dataDir);
        const out = startResult && startResult.output ? `\n'${[cmd.command, ...cmd.args].join(' ')}' said: ${startResult.output.trim()}` : '';
        throw new FleetAutoStartError(
            `Started the apra-fleet HTTP server but it did not answer /health within ${timeoutMs}ms. ` +
                `Check the last server log: ${log}.${out}`,
            { code: 'AUTOSTART_TIMEOUT', details: { log, start: startResult } },
        );
    } finally {
        try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
    }
}
