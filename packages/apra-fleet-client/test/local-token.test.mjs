import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import crypto from 'node:crypto';

import {
    readLocalToken,
    isAuthorized,
    readCookie,
    cookieFor,
    normalizePath,
    TOKEN_BYTES,
    UPSTREAM_CREDENTIAL_LABEL,
    deriveUpstreamCredential,
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

// -----------------------------------------------------------------------------
// deriveUpstreamCredential -- lifted here from src/console/proxy.ts.
//
// The point of these cases is BYTE COMPATIBILITY. Every already-registered
// workflow package holds a credential derived by the pre-lift proxy.ts code;
// if the lift changed the derivation by even one byte, every one of those
// credentials would silently stop authenticating. The fixed vector below was
// computed by running the PRE-LIFT implementation (from the parent commit's
// src/console/proxy.ts) directly, NOT by calling the function under test --
// so it is an independent pin, not a self-fulfilling snapshot.
// -----------------------------------------------------------------------------

const FIXED_VECTOR_KEY = 'a'.repeat(64);

describe('deriveUpstreamCredential', () => {
    test('matches the fixed vector produced by the previous proxy.ts derivation', () => {
        // Produced by the pre-lift src/console/proxy.ts implementation.
        assert.equal(
            deriveUpstreamCredential(FIXED_VECTOR_KEY, 'pkg-fixed-vector'),
            '6e681ec649db16e1749acf6b7ed66cbdacaab787aa1a8ad65d46f587f8fa60a8',
        );
        assert.equal(
            deriveUpstreamCredential(FIXED_VECTOR_KEY, 'pkg-other'),
            '06926cad18b9629721cbfd18e9d37380273ec6b80c31e060a3a4626f2791e3ff',
        );
    });

    test('differs per package id under the same fleet key, and per fleet key for the same id', () => {
        const a = deriveUpstreamCredential(FIXED_VECTOR_KEY, 'pkg-fixed-vector');
        const b = deriveUpstreamCredential(FIXED_VECTOR_KEY, 'pkg-other');
        assert.notEqual(a, b);

        // One package must not be able to derive another's credential, and a
        // different fleet key must not reproduce the same credential.
        const otherKey = deriveUpstreamCredential('b'.repeat(64), 'pkg-fixed-vector');
        assert.notEqual(a, otherKey);
    });

    test('never returns the fleet key itself and is a fixed-width hex sha256 digest', () => {
        const credential = deriveUpstreamCredential(FIXED_VECTOR_KEY, 'pkg-fixed-vector');
        assert.match(credential, /^[0-9a-f]{64}$/);
        assert.notEqual(credential, FIXED_VECTOR_KEY);
        assert.ok(!credential.includes(FIXED_VECTOR_KEY));
    });

    test('the length prefix is part of the HMAC input, so ids carrying the separator stay unambiguous', () => {
        // Pin the EXACT input encoding by recomputing it here independently:
        // `<label>:<id.length>:<id>`. Dropping the length prefix (the
        // length-free encoding below) yields a different digest, so this
        // case fails loudly if the prefix is ever removed -- that is what
        // makes the prefix testable rather than merely asserted.
        const id = 'a:b';
        const withLength = crypto
            .createHmac('sha256', FIXED_VECTOR_KEY)
            .update(`${UPSTREAM_CREDENTIAL_LABEL}:${id.length}:${id}`)
            .digest('hex');
        const withoutLength = crypto
            .createHmac('sha256', FIXED_VECTOR_KEY)
            .update(`${UPSTREAM_CREDENTIAL_LABEL}:${id}`)
            .digest('hex');

        assert.equal(deriveUpstreamCredential(FIXED_VECTOR_KEY, id), withLength);
        assert.notEqual(withLength, withoutLength);

        // Ids that embed the ':' separator still map to distinct credentials
        // -- no id can be crafted to collide with another id's input.
        assert.notEqual(
            deriveUpstreamCredential(FIXED_VECTOR_KEY, 'a:b'),
            deriveUpstreamCredential(FIXED_VECTOR_KEY, 'a'),
        );
        assert.equal(
            deriveUpstreamCredential(FIXED_VECTOR_KEY, 'a'),
            '6480d9f8b84cff7698805db18a95b1ce66b50558437ecf85c487c9cec8d1d9c9',
        );
    });

    test('the label is domain-separating: changing it changes every credential', () => {
        // The label must stay distinct from any cookie/session label signed
        // with the same fleet key -- equal labels would let a package replay
        // its upstream credential as a console credential.
        assert.equal(UPSTREAM_CREDENTIAL_LABEL, 'apra-fleet-ext-upstream-v1');
        const underDifferentLabel = crypto
            .createHmac('sha256', FIXED_VECTOR_KEY)
            .update(`some-other-label:16:pkg-fixed-vector`)
            .digest('hex');
        assert.notEqual(deriveUpstreamCredential(FIXED_VECTOR_KEY, 'pkg-fixed-vector'), underDifferentLabel);
    });
});
