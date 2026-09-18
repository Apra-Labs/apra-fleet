import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    loadOrCreateToken,
    isAuthorized,
    requiresAuth,
    readCookie,
    tokenFilePath,
    TOKEN_COOKIE_NAME,
    TOKEN_FILE_MODE,
    TOKEN_ACL_UNVERIFIED_WARNING,
} from '../src/supervisor/auth.mjs';

// =============================================================================
// Supervisor service token + per-request auth guard.
//
// Acceptance criteria proved here:
//   1. Two starts on one data root reuse the same token.
//   2. POSIX: the token file's mode is exactly 0600. Windows: the returned
//      descriptor reports aclVerified === false (no mode claim is made).
//   3. requiresAuth truth table (see REQUIRES_AUTH_TABLE below).
// Plus isAuthorized, which the 401 wiring task consumes.
// =============================================================================

const IS_WINDOWS = process.platform === 'win32';

let dir;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'se-auth-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('loadOrCreateToken', () => {
    test('mints a 64-char hex token at <dir>/private/token', () => {
        const first = loadOrCreateToken(dir);
        assert.match(first.token, /^[0-9a-f]{64}$/);
        assert.equal(first.created, true);
        assert.equal(first.path, path.join(dir, 'private', 'token'));
        assert.equal(first.path, tokenFilePath(dir));
        assert.equal(fs.readFileSync(first.path, 'utf8').trim(), first.token);
    });

    test('two starts on one dir reuse the same token', () => {
        const first = loadOrCreateToken(dir);
        const second = loadOrCreateToken(dir);
        assert.equal(second.token, first.token);
        assert.equal(first.created, true);
        assert.equal(second.created, false);
    });

    test('distinct dirs get distinct tokens', async () => {
        const other = await mkdtemp(path.join(tmpdir(), 'se-auth-'));
        try {
            assert.notEqual(loadOrCreateToken(dir).token, loadOrCreateToken(other).token);
        } finally {
            await rm(other, { recursive: true, force: true });
        }
    });

    test('an empty token file (torn write) is re-minted, not returned as ""', () => {
        const file = tokenFilePath(dir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
        const result = loadOrCreateToken(dir);
        assert.match(result.token, /^[0-9a-f]{64}$/);
        assert.equal(result.created, true);
    });

    test('a malformed non-empty token file is a hard error, not a silent replace', () => {
        const file = tokenFilePath(dir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'not-a-token');
        assert.throws(() => loadOrCreateToken(dir), /malformed/);
        assert.equal(fs.readFileSync(file, 'utf8'), 'not-a-token');
    });

    test('the token never appears in the thrown error text', () => {
        const minted = loadOrCreateToken(dir).token;
        const file = tokenFilePath(dir);
        fs.writeFileSync(file, `${minted}-trailing-garbage`);
        try {
            loadOrCreateToken(dir);
            assert.fail('expected a malformed-token error');
        } catch (err) {
            assert.ok(!String(err.message).includes(minted), 'error text leaked the token');
        }
    });

    test('platform protection: POSIX proves 0600, Windows reports aclVerified false', () => {
        const result = loadOrCreateToken(dir);
        if (IS_WINDOWS) {
            assert.equal(result.aclVerified, false);
            assert.equal(TOKEN_ACL_UNVERIFIED_WARNING, 'token-file-acl-unverified');
        } else {
            assert.equal(result.aclVerified, true);
            assert.equal(fs.statSync(result.path).mode & 0o777, TOKEN_FILE_MODE);
            assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
        }
    });

    test('POSIX: a loosened token file is healed back to 0600 on the next load', { skip: IS_WINDOWS }, () => {
        const first = loadOrCreateToken(dir);
        fs.chmodSync(first.path, 0o644);
        const second = loadOrCreateToken(dir);
        assert.equal(second.token, first.token);
        assert.equal(fs.statSync(second.path).mode & 0o777, 0o600);
    });

    test('rejects an empty dir argument', () => {
        assert.throws(() => loadOrCreateToken(''), TypeError);
    });
});

describe('requiresAuth', () => {
    // The acceptance-criteria truth table, verbatim, plus the two rows that pin
    // the trailing slash in /^\/sprints\/[^/]+\/live\// (without them the table
    // still passes with a looser pattern).
    const REQUIRES_AUTH_TABLE = [
        ['GET', '/api/health', true],
        ['GET', '/', false],
        ['GET', '/state', false],
        ['GET', '/events', false],
        ['GET', '/sprints/x/live', false],
        ['POST', '/sprints/x/live/stop', true],
        ['GET', '/sprints/x/history', false],
        // Trailing-slash discrimination: the live view itself is never guarded.
        ['POST', '/sprints/x/live', false],
        ['GET', '/sprints/x/live/stop', false],
        // /api/ is guarded for every method, not just mutations.
        ['POST', '/api/sprints', true],
        ['GET', '/api/health?verbose=1', true],
        // A path that merely mentions api/ or live/ deeper down is not guarded.
        ['GET', '/static/api/thing', false],
        ['POST', '/sprints/x/dead/stop', false],
    ];

    for (const [method, urlPath, expected] of REQUIRES_AUTH_TABLE) {
        test(`${method} ${urlPath} -> ${expected ? 'guarded' : 'open'}`, () => {
            assert.equal(requiresAuth(method, urlPath), expected);
        });
    }

    test('method match is case-insensitive', () => {
        assert.equal(requiresAuth('post', '/sprints/x/live/stop'), true);
    });

    test('non-string arguments do not throw', () => {
        assert.equal(requiresAuth(undefined, undefined), false);
        assert.equal(requiresAuth(null, null), false);
    });
});

describe('isAuthorized', () => {
    const TOKEN = 'a'.repeat(64);
    const req = (headers) => ({ headers });

    test('accepts Authorization: Bearer <token>', () => {
        assert.equal(isAuthorized(req({ authorization: `Bearer ${TOKEN}` }), TOKEN), true);
    });

    test('accepts a lowercase bearer scheme', () => {
        assert.equal(isAuthorized(req({ authorization: `bearer ${TOKEN}` }), TOKEN), true);
    });

    test('accepts the se_token cookie', () => {
        assert.equal(isAuthorized(req({ cookie: `${TOKEN_COOKIE_NAME}=${TOKEN}` }), TOKEN), true);
    });

    test('accepts se_token among other cookies', () => {
        const header = `theme=dark; ${TOKEN_COOKIE_NAME}=${TOKEN}; other=1`;
        assert.equal(isAuthorized(req({ cookie: header }), TOKEN), true);
    });

    test('rejects a cookie whose name merely ends in se_token', () => {
        assert.equal(isAuthorized(req({ cookie: `foo_${TOKEN_COOKIE_NAME}=${TOKEN}` }), TOKEN), false);
    });

    test('rejects a wrong token of the same length', () => {
        assert.equal(isAuthorized(req({ authorization: `Bearer ${'b'.repeat(64)}` }), TOKEN), false);
    });

    test('rejects a token that is a prefix of the real one', () => {
        assert.equal(isAuthorized(req({ authorization: `Bearer ${TOKEN.slice(0, 32)}` }), TOKEN), false);
    });

    test('rejects a missing, empty or non-bearer Authorization header', () => {
        assert.equal(isAuthorized(req({}), TOKEN), false);
        assert.equal(isAuthorized(req({ authorization: '' }), TOKEN), false);
        assert.equal(isAuthorized(req({ authorization: TOKEN }), TOKEN), false);
        assert.equal(isAuthorized(req({ authorization: `Basic ${TOKEN}` }), TOKEN), false);
    });

    test('rejects everything when no expected token is configured', () => {
        assert.equal(isAuthorized(req({ authorization: `Bearer ${TOKEN}` }), ''), false);
        assert.equal(isAuthorized(req({ authorization: 'Bearer ' }), ''), false);
    });

    test('tolerates a request with no headers bag at all', () => {
        assert.equal(isAuthorized({}, TOKEN), false);
        assert.equal(isAuthorized(undefined, TOKEN), false);
    });

    test('accepts the freshly minted token end to end', () => {
        const { token } = loadOrCreateToken(dir);
        assert.equal(isAuthorized(req({ authorization: `Bearer ${token}` }), token), true);
        assert.equal(isAuthorized(req({ cookie: `${TOKEN_COOKIE_NAME}=${token}` }), token), true);
    });
});

describe('readCookie', () => {
    test('matches by exact parsed name', () => {
        assert.equal(readCookie('a=1; se_token=xyz', 'se_token'), 'xyz');
        assert.equal(readCookie('xse_token=xyz', 'se_token'), null);
        assert.equal(readCookie('se_token=', 'se_token'), null);
        assert.equal(readCookie('', 'se_token'), null);
        assert.equal(readCookie(undefined, 'se_token'), null);
    });

    test('percent-decodes the value', () => {
        assert.equal(readCookie('se_token=a%20b', 'se_token'), 'a b');
    });
});
