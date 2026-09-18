// =============================================================================
// Test harness for building an auth-enforcing supervisor without hand-rolling
// loadOrCreateToken()/createSupervisor() wiring at every call site.
// =============================================================================
//
// apra-fleet-50j6.2.3: two exports, deliberately different shapes for two
// different kinds of caller:
//
//   startTestSupervisor({dataDir?, port:0, ...deps}) -- starts a REAL HTTP
//   listener (calls supervisor.start()) and returns exactly {baseUrl, token,
//   headers(), stop()}. This is the downstream contract 50j6.1.3 and
//   50j6.2.5 build on -- its shape must not change after this task closes.
//
//   createTestSupervisor({dataDir?, ...deps}) -- constructs a supervisor with
//   a minted/loaded token WITHOUT starting a real listener, and returns
//   {supervisor, token, headers()} so a caller can register routes and drive
//   supervisor.handleRequest() directly with mock req/res objects (the
//   pattern the existing supervisor-api.test.mjs suite uses throughout).
//
// Both mint the token via auth.mjs's loadOrCreateToken(dataDir) -- never via
// deps.token directly -- so BOTH constructors always end up with a non-null
// token and the per-request 401 guard in server.mjs is genuinely exercised
// (see server.mjs:170-182: a supervisor built with neither deps.token nor
// deps.dataDir leaves token null and the guard is skipped entirely). A
// harness that ever built a supervisor with no token would silently disable
// auth and make every migrated test pass vacuously.
// =============================================================================

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisor } from '../../src/supervisor/server.mjs';
import { loadOrCreateToken } from '../../src/supervisor/auth.mjs';

/**
 * @param {string} [dataDir]
 * @returns {Promise<string>}
 */
async function resolveDataDir(dataDir) {
    if (typeof dataDir === 'string' && dataDir.length > 0) return dataDir;
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-supervisor-harness-'));
}

/**
 * Builds the `Authorization: Bearer <token>` header bag every guarded
 * request needs.
 * @param {string} token
 * @returns {() => { authorization: string }}
 */
function headersFor(token) {
    return () => ({ authorization: `Bearer ${token}` });
}

/**
 * Starts a REAL supervisor HTTP listener with auth enforced, for tests that
 * make actual network requests against it.
 * @param {{dataDir?: string, port?: number, [key: string]: any}} [opts]
 * @returns {Promise<{baseUrl: string, token: string, headers: () => {authorization: string}, stop: () => Promise<void>}>}
 */
export async function startTestSupervisor(opts = {}) {
    const { dataDir: dataDirOpt, port = 0, ...deps } = opts;
    const dataDir = await resolveDataDir(dataDirOpt);
    const { token } = loadOrCreateToken(dataDir);

    const supervisor = createSupervisor({ ...deps, port, token });
    const { port: boundPort } = await supervisor.start();

    return {
        baseUrl: `http://127.0.0.1:${boundPort}`,
        token,
        headers: headersFor(token),
        stop: () => supervisor.stop('test-harness'),
    };
}

/**
 * Constructs an auth-enforcing supervisor WITHOUT starting a real listener --
 * for tests that register routes and call supervisor.handleRequest()
 * directly with mock req/res objects. Never used by 50j6.1.3/50j6.2.5; those
 * consume startTestSupervisor() above.
 * @param {{dataDir?: string, [key: string]: any}} [opts]
 * @returns {Promise<{supervisor: object, token: string, headers: () => {authorization: string}}>}
 */
export async function createTestSupervisor(opts = {}) {
    const { dataDir: dataDirOpt, ...deps } = opts;
    const dataDir = await resolveDataDir(dataDirOpt);
    const { token } = loadOrCreateToken(dataDir);

    const supervisor = createSupervisor({ ...deps, token });

    return { supervisor, token, headers: headersFor(token) };
}
