import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    readLocalToken,
    isAuthorized,
    readCookie,
    cookieFor,
    normalizePath,
    TOKEN_BYTES,
} from '../src/auth/local-token.mjs';

// apra-fleet-iywi.1.2: verifies the shared local-token helper DIRECTLY (never
// through the supervisor), so this suite is meaningless against the pre-lift
// supervisor code -- `isAuthorized(req, token, {cookieName})`, `cookieFor`,
// and `normalizePath` as importable standalone functions did not exist
// there. Reverting packages/apra-fleet-client/src/auth/local-token.mjs to
// nothing (or to a stub lacking these exports) makes every test below fail
// with an import error, which is the "helper reverted" check the PR body
// records.
//
// Every case pins `home` to a fresh temp dir (never the real os.homedir())
// and every data dir used is a fresh temp dir too -- this suite must never
// read or write the real ~/.apra-fleet/fleet.key.

const VALID_HEX = 'a'.repeat(TOKEN_BYTES * 2);
const OTHER_VALID_HEX = 'b'.repeat(TOKEN_BYTES * 2);

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

describe('readLocalToken', () => {
    test('fleet.key under the given home dir is preferred over the private/token fallback when both exist', async () => {
        const home = await mkTmp('local-token-home-');
        const dataDir = await mkTmp('local-token-data-');
        const keyPath = await writeFleetKey(home, `${VALID_HEX}\n`);
        // Seed a DIFFERENT well-formed private/token fallback so preference is
        // provable, not just "the only source available".
        await fsp.mkdir(path.join(dataDir, 'private'), { recursive: true });
        await fsp.writeFile(path.join(dataDir, 'private', 'token'), OTHER_VALID_HEX, { mode: 0o600 });

        const result = readLocalToken(dataDir, { home });

        assert.equal(result.token, VALID_HEX);
        assert.equal(result.source, 'fleet-key');
        assert.equal(result.path, keyPath);
    });

    test('a malformed fleet.key is rejected with a warning and the private/token fallback is used', async () => {
        const home = await mkTmp('local-token-home-');
        const dataDir = await mkTmp('local-token-data-');
        const malformed = 'not-a-valid-hex-token';
        await writeFleetKey(home, malformed);

        const warnings = [];
        const result = readLocalToken(dataDir, { home, logger: { warn: (...a) => warnings.push(a.join(' ')) } });

        assert.equal(result.source, 'private-token');
        assert.match(result.token, /^[0-9a-f]{64}$/);
        assert.notEqual(result.token, malformed);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /fleet\.key/);
        assert.match(warnings[0], /malformed/);
    });

    test('readLocalToken with createIfMissing false mints nothing: after the call the temp data dir is still empty on disk', async () => {
        const home = await mkTmp('local-token-home-');
        const dataDir = await mkTmp('local-token-data-');
        // No fleet.key, no private/token: neither source exists.

        const result = readLocalToken(dataDir, { home, createIfMissing: false });

        assert.equal(result, null);
        const entries = await fsp.readdir(dataDir);
        assert.deepEqual(entries, [], 'createIfMissing:false must never write into the data dir');
    });
});

describe('isAuthorized', () => {
    test('accepts a correct bearer header and accepts a correct named cookie', () => {
        const token = VALID_HEX;
        const bearerReq = { headers: { authorization: `Bearer ${token}` } };
        assert.equal(isAuthorized(bearerReq, token, { cookieName: 'my_cookie' }), true);

        const cookieReq = { headers: { cookie: `my_cookie=${token}` } };
        assert.equal(isAuthorized(cookieReq, token, { cookieName: 'my_cookie' }), true);
    });

    test('refuses a wrong token, an empty token, and a missing credential', () => {
        const token = VALID_HEX;
        const wrongReq = { headers: { authorization: `Bearer ${OTHER_VALID_HEX}` } };
        assert.equal(isAuthorized(wrongReq, token, { cookieName: 'my_cookie' }), false);

        const emptyReq = { headers: { authorization: 'Bearer ' } };
        assert.equal(isAuthorized(emptyReq, token, { cookieName: 'my_cookie' }), false);

        const missingReq = { headers: {} };
        assert.equal(isAuthorized(missingReq, token, { cookieName: 'my_cookie' }), false);
    });

    test('the cookie name is genuinely a parameter: a cookie under a caller-chosen name is accepted, and the same value under a different name is refused', () => {
        const token = VALID_HEX;
        const req = { headers: { cookie: `chosen_name=${token}` } };
        assert.equal(isAuthorized(req, token, { cookieName: 'chosen_name' }), true);
        assert.equal(isAuthorized(req, token, { cookieName: 'other_name' }), false);
    });
});

describe('readCookie', () => {
    test('extracts a cookie by exact name from a raw Cookie header', () => {
        assert.equal(readCookie('a=1; my_cookie=abc123; b=2', 'my_cookie'), 'abc123');
        assert.equal(readCookie('a=1; b=2', 'my_cookie'), null);
    });
});

describe('cookieFor', () => {
    test('returns a Set-Cookie value carrying HttpOnly, SameSite=Strict and Path=/', () => {
        const value = cookieFor(VALID_HEX, { cookieName: 'my_cookie' });
        assert.match(value, /^my_cookie=/);
        assert.match(value, /HttpOnly/);
        assert.match(value, /SameSite=Strict/);
        assert.match(value, /Path=\//);
    });
});

describe('normalizePath (fail-closed)', () => {
    test('percent-encoded and dot-segment paths normalise to the same value a dummy-origin URL parse would produce', () => {
        const dotSegment = '/foo/../api/health';
        const expected = new URL(dotSegment, 'http://localhost').pathname;
        assert.equal(normalizePath(dotSegment), expected);
        assert.equal(normalizePath(dotSegment), '/api/health');

        const percentEncoded = '/foo%2Fbar/../baz';
        const expectedPercent = new URL(percentEncoded, 'http://localhost').pathname;
        assert.equal(normalizePath(percentEncoded), expectedPercent);
    });

    test('an unparseable path normalises to the guarded answer (null), never the open one', () => {
        // An absolute-URL-shaped string with a malformed bracketed host is
        // parsed as its own (invalid) URL rather than resolved against the
        // dummy base, and `new URL()` throws -- verified directly against
        // the same dummy origin normalizePath uses.
        const unparseable = 'http://[invalid';
        assert.throws(() => new URL(unparseable, 'http://localhost'));
        assert.equal(normalizePath(unparseable), null);
    });
});
