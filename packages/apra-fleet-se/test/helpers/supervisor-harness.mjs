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
//   {supervisor, token, headers(), dispose()} so a caller can register routes and drive
//   supervisor.handleRequest() directly with mock req/res objects (the
//   pattern the existing supervisor-api.test.mjs suite uses throughout).
//
// Both resolve the token via auth.mjs's resolveServiceToken(dataDir, {home})
// -- never via deps.token directly -- so BOTH constructors always end up
// with a non-null token and the per-request 401 guard in server.mjs is
// genuinely exercised (see server.mjs:170-182: a supervisor built with
// neither deps.token nor deps.dataDir leaves token null and the guard is
// skipped entirely). A harness that ever built a supervisor with no token
// would silently disable auth and make every migrated test pass vacuously.
//
// apra-fleet-ky2l.1.2 (DQ-20): resolveServiceToken() prefers the shared
// ~/.apra-fleet/fleet.key over dataDir's own private/token. This harness
// ALWAYS pins the lookup to a fresh (or caller-supplied) temp `home` dir --
// never the real os.homedir() -- so every test built on this harness stays
// isolated from the developer machine's real fleet.key (a harness that
// leaked the real home would make every consuming test's outcome depend on
// whether that machine happens to have one) and, absent a fleet.key at that
// temp home, deterministically exercises the private-token fallback exactly
// as this harness always has.
// =============================================================================

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisor } from '../../src/supervisor/server.mjs';
import { resolveServiceToken } from '../../src/supervisor/auth.mjs';

/**
 * apra-fleet-50j6.8: resolves dataDir/home, recording every dir the harness
 * ITSELF mkdtemp'd so the matching cleanup removes exactly those -- never a
 * caller-supplied path.
 * @param {string|undefined} dataDirOpt
 * @param {string|undefined} homeOpt
 * @returns {Promise<{ dataDir: string, home: string, cleanup: () => Promise<void> }>}
 */
async function resolveDirs(dataDirOpt, homeOpt) {
    const created = [];
    const ownOrTemp = async (supplied, prefix) => {
        if (typeof supplied === 'string' && supplied.length > 0) return supplied;
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
        created.push(dir);
        return dir;
    };
    const dataDir = await ownOrTemp(dataDirOpt, 'eft-supervisor-harness-');
    const home = await ownOrTemp(homeOpt, 'eft-supervisor-harness-home-');
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        for (const dir of created) {
            // eslint-disable-next-line no-await-in-loop
            await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    };
    return { dataDir, home, cleanup };
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
 *   `stop()` stops the supervisor, then removes every dir the harness created.
 */
export async function startTestSupervisor(opts = {}) {
    const { dataDir: dataDirOpt, home: homeOpt, port = 0, ...deps } = opts;
    const { dataDir, home, cleanup } = await resolveDirs(dataDirOpt, homeOpt);
    let token;
    let supervisor;
    let boundPort;
    try {
        ({ token } = resolveServiceToken(dataDir, { home }));
        supervisor = createSupervisor({ ...deps, port, token });
        ({ port: boundPort } = await supervisor.start());
    } catch (err) {
        await cleanup();
        throw err;
    }

    return {
        baseUrl: `http://127.0.0.1:${boundPort}`,
        token,
        headers: headersFor(token),
        // apra-fleet-50j6.8: removes the harness-created dirs AFTER the
        // supervisor has stopped; a caller-supplied dataDir/home is untouched.
        stop: async () => {
            try {
                await supervisor.stop('test-harness');
            } finally {
                await cleanup();
            }
        },
    };
}

/**
 * Constructs an auth-enforcing supervisor WITHOUT starting a real listener --
 * for tests that register routes and call supervisor.handleRequest()
 * directly with mock req/res objects. Never used by 50j6.1.3/50j6.2.5; those
 * consume startTestSupervisor() above.
 * @param {{dataDir?: string, [key: string]: any}} [opts]
 * @returns {Promise<{supervisor: object, token: string, headers: () => {authorization: string}, dispose: () => Promise<void>}>}
 */
export async function createTestSupervisor(opts = {}) {
    const { dataDir: dataDirOpt, home: homeOpt, ...deps } = opts;
    const { dataDir, home, cleanup } = await resolveDirs(dataDirOpt, homeOpt);
    let token;
    let supervisor;
    try {
        ({ token } = resolveServiceToken(dataDir, { home }));
        supervisor = createSupervisor({ ...deps, token });
    } catch (err) {
        await cleanup();
        throw err;
    }

    // apra-fleet-50j6.8: `dispose()` removes only the dirs the harness itself
    // created (never a caller-supplied dataDir/home). It does not stop the
    // supervisor -- a caller that called supervisor.start() stops it first.
    return { supervisor, token, headers: headersFor(token), dispose: cleanup };
}
