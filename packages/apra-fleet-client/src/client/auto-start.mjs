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
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const AUTOSTART_MAX_STARTS = 3;
export const AUTOSTART_WINDOW_MS = 10 * 60 * 1000;
export const AUTOSTART_TIMEOUT_MS = 45 * 1000;
const POLL_MS = 500;

export const AUTOSTART_LEDGER_FILE = 'client-autostart.json';
export const AUTOSTART_LOCK_FILE = 'client-autostart.lock';

/** Typed failure of a client auto-start. code: AUTOSTART_LIMIT | AUTOSTART_TIMEOUT | AUTOSTART_NO_BINARY | SERVER_UNRESPONSIVE */
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

/**
 * The `apra-fleet start` command line, most exact match first:
 *  1. this process IS the apra-fleet binary (the SEA `apra-fleet workflow` trampoline);
 *  2. <dirname>/index.js (bundled layout), <dirname>/../../../dist/index.js
 *     (dev monorepo, keyed off the consumer's dirname) and the repo dist/
 *     relative to this module -- run with node;
 *  3. the installed binary, ~/.apra-fleet/bin/apra-fleet[.exe].
 *
 * @param {{ dirname?: string, exists?: (p: string) => boolean, execPath?: string,
 *           homedir?: () => string, platform?: string }} [deps]
 * @returns {{ command: string, args: string[] }}
 */
export function resolveFleetStartCommand(deps = {}) {
    const exists = deps.exists || fs.existsSync;
    const execPath = deps.execPath || process.execPath;
    const platform = deps.platform || process.platform;
    const homedir = deps.homedir || os.homedir;

    if (/^apra-fleet(\.exe)?$/i.test(path.basename(execPath))) {
        return { command: execPath, args: ['start'] };
    }
    const entries = [];
    if (deps.dirname) {
        entries.push(path.join(deps.dirname, 'index.js'));
        entries.push(path.resolve(deps.dirname, '..', '..', '..', 'dist', 'index.js'));
    }
    entries.push(path.resolve(__dirname, '..', '..', '..', '..', 'dist', 'index.js'));
    for (const entry of entries) {
        if (exists(entry)) return { command: nodeCommand(), args: [entry, 'start'] };
    }
    const installed = path.join(homedir(), '.apra-fleet', 'bin', platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet');
    if (exists(installed)) return { command: installed, args: ['start'] };

    throw new FleetAutoStartError(
        'The apra-fleet HTTP server is not running and no apra-fleet installation was found to start it. Tried:\n' +
            entries.map((e) => `  - ${e}\n`).join('') +
            `  - ${installed}\n` +
            "Install apra-fleet ('apra-fleet install'), start the server yourself ('apra-fleet start'), " +
            'or set APRA_FLEET_TRANSPORT=stdio to run a private stdio server.',
        { code: 'AUTOSTART_NO_BINARY' },
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
        child = runStart(cmd.command, cmd.args, env);
        let startResult = null;
        child.done.then((r) => { startResult = r; });

        while (now() < deadline) {
            await sleep(POLL_MS);
            const inst = await probe({ env });
            if (inst && inst.running) return { ...inst, started: true };
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
