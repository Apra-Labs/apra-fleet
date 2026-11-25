// =============================================================================
// `serve.mjs --detach`: respawn the supervisor as a detached child and return
// only once it is really serving.
// =============================================================================
//
// The child is the same entry point without --detach, spawned `detached: true`
// with stdin ignored, stdout/stderr appended to <dataDir>/logs/
// supervisor-launch.log, windowsHide, and unref()'d so it outlives the
// launcher and the launching console.
//
// Readiness is a PID IDENTITY check, not "something answers": the supervisor
// has no fallback port, so when the port is already taken the child dies at
// bind time while an older process keeps answering /api/health. Only a health
// reply whose `pid` is the CHILD's pid proves the new supervisor is up.
//
// Default launch mode: serve.mjs with neither --detach nor --foreground
// detaches when stdin or stdout is a TTY (an interactive console launch, any
// OS), because a foreground supervisor dies with its console (SIGHUP, or the
// Windows console-close event, which exit-log.mjs deliberately honours). With
// no TTY on either stream (systemd, launchd, schtasks, nssm, CI, a parent
// process holding pipes) it stays in the foreground, so service-manager
// recipes are unchanged. resolveLaunchMode() takes the streams and platform as
// arguments so the decision is testable on any host.
//
// Failure policy (documented): on timeout, pid mismatch or early child exit
// the launcher prints the reason and the log path, KILLS the child it spawned
// (so no half-started supervisor is left behind), and returns a non-zero
// exit code.
// =============================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const DETACH_TIMEOUT_ENV = 'FLEET_SE_DETACH_TIMEOUT_MS';
export const DEFAULT_DETACH_TIMEOUT_MS = 30000;
export const DETACH_LOG_NAME = 'supervisor-launch.log';

export function resolveDetachTimeoutMs(env = process.env) {
    const n = Number(env[DETACH_TIMEOUT_ENV]);
    return Number.isFinite(n) && n >= 100 ? Math.floor(n) : DEFAULT_DETACH_TIMEOUT_MS;
}

export const DETACH_FLAG = '--detach';
export const FOREGROUND_FLAG = '--foreground';

/** True when either stream is a terminal (an interactive console launch). */
export function isInteractiveConsole({ stdin, stdout } = {}) {
    return Boolean(stdin && stdin.isTTY) || Boolean(stdout && stdout.isTTY);
}

/**
 * Decide how serve.mjs runs this invocation.
 *
 * @param {{ detach?: boolean, foreground?: boolean, stdin?: { isTTY?: boolean }|null,
 *           stdout?: { isTTY?: boolean }|null, platform?: string }} opts
 * @returns {{ mode: 'detach'|'foreground', reason: 'flag'|'interactive-console'|'non-interactive', platform: string }}
 * @throws {Error} when both --detach and --foreground are given (a usage error).
 */
export function resolveLaunchMode({ detach = false, foreground = false, stdin = null, stdout = null, platform = process.platform } = {}) {
    if (detach && foreground) {
        throw new Error(`${DETACH_FLAG} and ${FOREGROUND_FLAG} cannot be used together`);
    }
    if (detach) return { mode: 'detach', reason: 'flag', platform };
    if (foreground) return { mode: 'foreground', reason: 'flag', platform };
    if (isInteractiveConsole({ stdin, stdout })) return { mode: 'detach', reason: 'interactive-console', platform };
    return { mode: 'foreground', reason: 'non-interactive', platform };
}

/**
 * The detached child's argv: the launcher's argv without --detach/--foreground,
 * plus an explicit --foreground so the child never re-detaches whatever its
 * stdio turns out to be.
 */
export function detachedChildArgs(argv) {
    return [...stripDetachArgs(argv).filter((a) => a !== FOREGROUND_FLAG && !a.startsWith(`${FOREGROUND_FLAG}=`)), FOREGROUND_FLAG];
}

/** argv minus every --detach flag (the child must run in the foreground of its own process). */
export function stripDetachArgs(argv) {
    return argv.filter((a) => a !== '--detach' && !a.startsWith('--detach='));
}

/** GET /api/health -> { status, body } or null (refused / timeout). */
export function probeHealth({ host, port, timeoutMs = 1500 }) {
    return new Promise((resolve) => {
        const req = http.get({ host, port, path: '/api/health', timeout: timeoutMs }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, body: null }); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * @param {{ argv: string[], scriptPath: string, dataDir: string, port: number, host?: string,
 *           timeoutMs?: number, pollMs?: number, out?: (s: string) => void, err?: (s: string) => void }} opts
 * @returns {Promise<{ exitCode: number, pid?: number, reason?: string }>}
 */
export async function detachSupervisor(opts) {
    const { argv, scriptPath, dataDir, port, timeoutMs = resolveDetachTimeoutMs(), pollMs = 150 } = opts;
    const out = opts.out ?? ((s) => console.log(s));
    const err = opts.err ?? ((s) => console.error(s));
    const probeHost = !opts.host || opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;

    const logDir = path.join(dataDir, 'logs');
    const logPath = path.join(logDir, DETACH_LOG_NAME);
    fs.mkdirSync(logDir, { recursive: true });
    const logFd = fs.openSync(logPath, 'a');

    let child;
    let exited = null;
    try {
        child = spawn(process.execPath, [scriptPath, ...detachedChildArgs(argv)], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            windowsHide: true,
            env: process.env,
        });
    } finally {
        fs.closeSync(logFd);
    }
    child.on('error', (e) => { exited = { error: e.message }; });
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    const fail = (reason) => {
        try { if (child.pid && !exited) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
        child.unref();
        err(`[fleet-se serve --detach] ${reason}\n  log: ${logPath}`);
        return { exitCode: 1, reason };
    };

    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (exited) {
            // A child that died at bind time usually means the port is taken:
            // say so when something else is answering there.
            // eslint-disable-next-line no-await-in-loop
            const other = await probeHealth({ host: probeHost, port });
            if (other && other.status === 200 && other.body && Number.isInteger(other.body.pid) && other.body.pid !== child.pid) {
                return fail(`port ${port} is already served by a different process (pid ${other.body.pid}); the child just started (pid ${child.pid}) could not bind it and exited`);
            }
            return fail(`supervisor child (pid ${child.pid}) exited before answering /api/health (${exited.error ?? `code ${exited.code}${exited.signal ? `, signal ${exited.signal}` : ''}`})`);
        }
        // eslint-disable-next-line no-await-in-loop
        const res = await probeHealth({ host: probeHost, port });
        if (res && res.status === 200 && res.body && Number.isInteger(res.body.pid)) {
            if (res.body.pid === child.pid) {
                child.unref();
                out(`supervisor started: pid ${child.pid}, port ${port}, log ${path.join(logDir, 'supervisor.log')}`);
                return { exitCode: 0, pid: child.pid };
            }
            // Something else owns the port; the child cannot bind it.
            return fail(`port ${port} is already served by a different process (pid ${res.body.pid}), not the child just started (pid ${child.pid})`);
        }
        if (Date.now() > deadline) {
            return fail(`timed out after ${timeoutMs} ms waiting for /api/health on ${probeHost}:${port} to answer with the child's pid ${child.pid}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(pollMs);
    }
}
