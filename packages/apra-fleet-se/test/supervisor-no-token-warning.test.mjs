import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisor, NO_TOKEN_SOURCE_WARNING } from '../src/supervisor/server.mjs';

// apra-fleet-ky2l.25 -- createSupervisor() with no token source at all serves
// /api unauthenticated (deliberate back-compat for header-less unit tests);
// it must say so with exactly one warning line through the injected logger,
// and stay silent whenever any token source is supplied.

const TOKEN = 't'.repeat(64);
const tmpDirs = [];
after(async () => {
    for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});

function fakeLogger() {
    const lines = [];
    return {
        lines,
        log: (...a) => lines.push(a.map(String).join(' ')),
        error: (...a) => lines.push(a.map(String).join(' ')),
    };
}
const warnings = (logger) => logger.lines.filter((l) => l.includes('auth guard is DISABLED'));

describe('createSupervisor no-token-source warning (apra-fleet-ky2l.25)', () => {
    test('no token source -> exactly one warning line stating the /api guard is disabled', () => {
        const logger = fakeLogger();
        createSupervisor({ port: 0, logger });
        const w = warnings(logger);
        assert.equal(w.length, 1, `expected exactly one warning, got ${JSON.stringify(logger.lines)}`);
        assert.equal(w[0], NO_TOKEN_SOURCE_WARNING);
        assert.match(w[0], /\/api auth guard is DISABLED/);
    });

    test('a static deps.token logs no warning, and the token value never appears', () => {
        const logger = fakeLogger();
        createSupervisor({ port: 0, token: TOKEN, logger });
        assert.equal(warnings(logger).length, 0);
        assert.ok(logger.lines.every((l) => !l.includes(TOKEN)));
    });

    test('a deps.dataDir logs no warning', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ky2l25-'));
        tmpDirs.push(dir);
        const logger = fakeLogger();
        createSupervisor({ port: 0, dataDir: dir, logger });
        assert.equal(warnings(logger).length, 0);
    });

    test('a token provider (deps.resolveToken) logs no warning, even before it has a token', () => {
        const withToken = fakeLogger();
        createSupervisor({ port: 0, resolveToken: () => ({ token: TOKEN, source: 'fleet-key' }), logger: withToken });
        assert.equal(warnings(withToken).length, 0);
        assert.ok(withToken.lines.every((l) => !l.includes(TOKEN)));

        const noTokenYet = fakeLogger();
        createSupervisor({ port: 0, resolveToken: () => null, logger: noTokenYet });
        assert.equal(warnings(noTokenYet).length, 0);
    });

    test('the warning text carries no token-shaped value', () => {
        assert.doesNotMatch(NO_TOKEN_SOURCE_WARNING, /[0-9a-f]{32,}/i);
    });
});
