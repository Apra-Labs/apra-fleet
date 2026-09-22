import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveServiceToken, TOKEN_BYTES } from '../src/supervisor/auth.mjs';
import { createSupervisor, sendJson } from '../src/supervisor/server.mjs';

// apra-fleet-ky2l.1.2 (DQ-20): the supervisor's service token now prefers the
// shared ~/.apra-fleet/fleet.key (the same key src/services/jwt.ts signs
// JWTs with) over the private/token file it used to always mint under its
// own data root. resolveServiceToken() is the single seam every caller
// (bin/serve.mjs, scripts/check-foreign-sprints.mjs, scripts/sandbox-
// deploy.mjs) now goes through -- this suite proves the seam itself and that
// no caller in scripts/ bypasses it with a direct tokenFilePath/
// loadOrCreateToken call.
//
// Every case below pins `home` to a fresh temp dir (never the real
// os.homedir()) -- jwt.ts's own KEY_PATH has no such override, so this is
// the ONLY way to keep the suite from depending on (or mutating) whatever
// the developer machine's real ~/.apra-fleet/fleet.key happens to hold.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VALID_HEX = 'a'.repeat(TOKEN_BYTES * 2);

const tmpDirs = new Set();
async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    return dir;
}
after(async () => {
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.clear();
});

async function writeFleetKey(home, contents) {
    const dir = path.join(home, '.apra-fleet');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'fleet.key'), contents, 'utf8');
    return path.join(dir, 'fleet.key');
}

/** Snapshot of the REAL ~/.apra-fleet directory: names + mtimes, so a test
 *  that forgets to pin `home` gets caught rather than silently reading or
 *  minting into the developer's real fleet.key. */
function snapshotRealApraFleet() {
    const dir = path.join(os.homedir(), '.apra-fleet');
    let entries;
    try {
        entries = fs.readdirSync(dir).sort();
    } catch {
        return null; // directory does not exist on this machine -- fine, still comparable
    }
    return entries.map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = null;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* raced away, ignore */ }
        return `${name}:${mtimeMs}`;
    });
}

describe('resolveServiceToken (apra-fleet-ky2l.1.2, DQ-20)', () => {
    test('(a) a temp home containing .apra-fleet/fleet.key -> resolver returns that value with source fleet-key', async () => {
        const home = await mkTmp('auth-token-source-home-');
        const dataDir = await mkTmp('auth-token-source-data-');
        const keyPath = await writeFleetKey(home, `${VALID_HEX}\n`);

        const result = resolveServiceToken(dataDir, { home });

        assert.equal(result.token, VALID_HEX);
        assert.equal(result.source, 'fleet-key');
        assert.equal(result.path, keyPath);
        assert.equal(result.created, false);
    });

    test('(b) a temp home without fleet.key -> falls back to <dir>/private/token (minted 0600) with source private-token', async () => {
        const home = await mkTmp('auth-token-source-home-');
        const dataDir = await mkTmp('auth-token-source-data-');

        const result = resolveServiceToken(dataDir, { home });

        assert.equal(result.source, 'private-token');
        assert.match(result.token, /^[0-9a-f]{64}$/);
        assert.equal(result.path, path.join(dataDir, 'private', 'token'));
        assert.equal(result.created, true);
        if (process.platform !== 'win32') {
            const mode = fs.statSync(result.path).mode & 0o777;
            assert.equal(mode, 0o600);
        }
    });

    test('(c) a malformed fleet.key (not 64 hex) is rejected in favour of the fallback, with a logged warning, and is NEVER used as the token', async () => {
        const home = await mkTmp('auth-token-source-home-');
        const dataDir = await mkTmp('auth-token-source-data-');
        const malformed = 'not-a-valid-hex-token';
        await writeFleetKey(home, malformed);

        const warnings = [];
        const logger = { warn: (...a) => warnings.push(a.join(' ')) };

        const result = resolveServiceToken(dataDir, { home, logger });

        assert.equal(result.source, 'private-token');
        assert.notEqual(result.token, malformed);
        assert.match(result.token, /^[0-9a-f]{64}$/);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /fleet\.key/);
        assert.match(warnings[0], /malformed/);
        // Never used as the token, anywhere -- not even a substring.
        assert.ok(!result.token.includes(malformed));
    });

    test('a fleet.key of the wrong length (not exactly 64 chars) is also rejected', async () => {
        const home = await mkTmp('auth-token-source-home-');
        const dataDir = await mkTmp('auth-token-source-data-');
        await writeFleetKey(home, 'a'.repeat(63)); // one short of 64

        const warnings = [];
        const result = resolveServiceToken(dataDir, { home, logger: { warn: (...a) => warnings.push(a.join(' ')) } });

        assert.equal(result.source, 'private-token');
        assert.equal(warnings.length, 1);
    });

    test('default logger (console) is used when no logger dep is supplied -- resolveServiceToken never throws for a malformed key', async () => {
        const home = await mkTmp('auth-token-source-home-');
        const dataDir = await mkTmp('auth-token-source-data-');
        await writeFleetKey(home, 'malformed');

        assert.doesNotThrow(() => resolveServiceToken(dataDir, { home }));
    });

    test('default `home` (no override) resolves against the real os.homedir() -- verified by comparing against an explicit os.homedir() call, never mutating it', () => {
        const before = snapshotRealApraFleet();
        const withDefault = resolveServiceToken(path.join(os.tmpdir(), 'auth-token-source-unused'), {});
        const withExplicitRealHome = resolveServiceToken(path.join(os.tmpdir(), 'auth-token-source-unused'), { home: os.homedir() });
        const after1 = snapshotRealApraFleet();

        assert.equal(withDefault.source, withExplicitRealHome.source);
        assert.equal(withDefault.token, withExplicitRealHome.token);
        assert.deepEqual(before, after1, 'the default-home call must not have mutated the real ~/.apra-fleet directory');
    });
});

describe('(d)/(e) a supervisor booted with the fleet-key source (apra-fleet-ky2l.1.2)', () => {
    test('GET /api/health is 401 without a header and 200 with Authorization: Bearer <fleet.key contents>; GET / body never contains the token', async () => {
        const home = await mkTmp('auth-token-source-home-');
        const dataDir = await mkTmp('auth-token-source-data-');
        await writeFleetKey(home, VALID_HEX);

        const { token, source } = resolveServiceToken(dataDir, { home });
        assert.equal(source, 'fleet-key');

        const supervisor = createSupervisor({ port: 0, token, logger: { log() {}, error() {} } });
        supervisor.route('GET', '/api/health-check', async (req, res) => sendJson(res, 200, { ok: true }));
        supervisor.route('GET', '/', async (req, res) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html><body>dashboard shell, no token here</body></html>');
        });
        await supervisor.start();
        const { port } = supervisor.server.address();
        try {
            const request = (method, reqPath, headers) => new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: headers ?? {} }, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
                });
                req.on('error', reject);
                req.end();
            });

            const noHeader = await request('GET', '/api/health-check');
            assert.equal(noHeader.status, 401);

            const withFleetKey = await request('GET', '/api/health-check', { authorization: `Bearer ${token}` });
            assert.equal(withFleetKey.status, 200);

            const root = await request('GET', '/');
            assert.notEqual(root.status, 401);
            assert.ok(!root.body.includes(token), 'GET / body must never contain the service token');
        } finally {
            await supervisor.stop();
        }
    });
});

describe('scripts/ callers all resolve the token through resolveServiceToken (apra-fleet-ky2l.1.2)', () => {
    test('check-foreign-sprints.mjs and sandbox-deploy.mjs contain no direct tokenFilePath()/loadOrCreateToken() call', () => {
        for (const rel of ['scripts/check-foreign-sprints.mjs', 'scripts/sandbox-deploy.mjs']) {
            const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            assert.ok(!/\btokenFilePath\s*\(/.test(source), `${rel} must not call tokenFilePath() directly`);
            assert.ok(!/\bloadOrCreateToken\s*\(/.test(source), `${rel} must not call loadOrCreateToken() directly`);
            assert.match(source, /resolveServiceToken/, `${rel} must resolve its token via resolveServiceToken()`);
        }
    });
});

describe('fleet-supervisor SKILL.md documents the fleet-key token source (apra-fleet-ky2l.1.2)', () => {
    test('the auth paragraph and curl examples name the fleet key path', () => {
        const skillPath = path.join(REPO_ROOT, 'packages', 'apra-fleet-se', 'fleet-sprint', 'skills', 'fleet-supervisor', 'SKILL.md');
        const source = fs.readFileSync(skillPath, 'utf8');
        assert.match(source, /\.apra-fleet[\\/]fleet\.key/, 'SKILL.md auth section must name the fleet key path');
        assert.match(source, /private\/token/, 'SKILL.md must still describe private\\token as the fallback');
    });
});
