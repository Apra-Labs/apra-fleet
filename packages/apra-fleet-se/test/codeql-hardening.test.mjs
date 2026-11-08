// Regression tests for the CodeQL fixes on the supervisor request guard:
// (a) bearer parsing is linear, (b) the mini-dom open-tag scan is linear,
// (c) supervisor error responses never carry a stack trace.
//
// Checked locally: reverting stripStacks in sendJson makes the stack-trace tests
// fail. Restoring the old /^Bearer\s+(.+)$/i regex in presentedToken does NOT
// fail the timing test on current V8 (the header is trimmed first and any
// header value is newline-free, so no input found makes it backtrack); the
// timing test is a guard against a future backtracking-prone parse.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkMutatingRequest } from '@apralabs/apra-fleet-workflow/viewer/request-guard';
import { parseDocument } from './helpers/mini-dom.mjs';
import { createSupervisor, sendJson, stripStacks } from '../src/supervisor/server.mjs';

const TOKEN = 'tok-0123456789';
const post = (headers) => ({ method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:1', ...headers } });
const STACK_RE = /\n\s+at\s|\.mjs:\d+/;

describe('bearer token parsing', () => {
    test('Bearer, bearer and BEARER with surrounding whitespace are accepted', () => {
        for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
            assert.equal(checkMutatingRequest(post({ authorization: `  ${scheme}   ${TOKEN}  ` }), { token: TOKEN }), null, scheme);
        }
        assert.equal(checkMutatingRequest(post({ authorization: 'Bearer wrong' }), { token: TOKEN })?.status, 403);
    });

    test('an empty bearer value counts as no token', () => {
        // No token presented -> falls through to the same-origin check and passes.
        assert.equal(checkMutatingRequest(post({ authorization: 'Bearer    ' }), { token: TOKEN }), null);
        assert.equal(checkMutatingRequest(post({ authorization: 'Bearer' }), { token: TOKEN }), null);
    });

    test('a hostile 50k-space header returns quickly', () => {
        const t0 = Date.now();
        const withTail = checkMutatingRequest(post({ authorization: 'Bearer' + ' '.repeat(50000) + 'x' }), { token: TOKEN });
        const noToken = checkMutatingRequest(post({ authorization: 'Bearer' + ' '.repeat(50000) }), { token: TOKEN });
        const elapsed = Date.now() - t0;
        assert.equal(withTail?.status, 403);
        assert.equal(noToken, null);
        assert.ok(elapsed < 500, `took ${elapsed}ms`);
    });
});

describe('mini-dom open-tag scan', () => {
    test('a hostile open tag with a long attribute run and no closing > finishes fast and does not throw', () => {
        const hostile = '<div' + ' a=b'.repeat(12500) + ' =' + ' ='.repeat(5000);
        const t0 = Date.now();
        assert.doesNotThrow(() => parseDocument(`<body>${hostile}</body>`));
        const hostile2 = '<div' + ' '.repeat(50000) + '=';
        assert.doesNotThrow(() => parseDocument(hostile2));
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 1000, `took ${elapsed}ms`);
    });

    test('well-formed tags still parse attributes, quoted values and self-closing', () => {
        const doc = parseDocument('<body><div id="a" class=\'b c\' data-x=1 hidden><br/><input value = "v"/></div></body>');
        assert.ok(doc.getElementById('a'));
        assert.ok(doc.querySelector('input'));
    });
});

describe('supervisor error bodies carry no stack trace', () => {
    function fakeRes() {
        const r = { status: 0, body: '' };
        r.writeHead = (s) => { r.status = s; };
        r.end = (b) => { r.body = b; };
        return r;
    }

    test('sendJson reduces an Error payload and stack-bearing strings to their message', () => {
        const err = new Error('boom');
        const res = fakeRes();
        sendJson(res, 500, { error: err, detail: err.stack, nested: { stack: err.stack, msg: 'ok' } });
        assert.doesNotMatch(res.body, STACK_RE);
        const j = JSON.parse(res.body);
        assert.equal(j.error, 'boom');
        assert.equal(j.nested.msg, 'ok');
        assert.equal(stripStacks('plain message'), 'plain message');
    });

    test('a route handler that throws answers the fixed message, no stack', async () => {
        const sup = createSupervisor({ port: 0, apiToken: null, host: '127.0.0.1', logger: { log() {}, error() {} } });
        sup.route('GET', '/api/test-throw', () => { throw new Error('secret internals'); });
        await sup.start();
        try {
            const out = await new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port: sup.port, path: '/api/test-throw' }, (res) => {
                    let t = '';
                    res.on('data', (c) => { t += c; });
                    res.on('end', () => resolve({ status: res.statusCode, text: t }));
                }).on('error', reject);
            });
            assert.equal(out.status, 500);
            assert.equal(JSON.parse(out.text).error, 'internal supervisor error');
            assert.doesNotMatch(out.text, STACK_RE);
        } finally {
            await sup.stop();
        }
    });
});
