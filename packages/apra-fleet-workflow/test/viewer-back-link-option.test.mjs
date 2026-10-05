// Unit coverage for the viewer's optional caller-supplied back link
// (createDashboardViewer opts.backLink / HTML_TEMPLATE opts.backLink).
//
// Pins: (1) with the option, the served GET / page has exactly one anchor
// with the configured href/text, located inside the real <body> (not in
// head/style/script/comment); (2) without it, the template output is
// byte-identical to the pre-feature output; (3) invalid values throw from
// createDashboardViewer naming the option; (4) HTML metacharacters are
// escaped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { createDashboardViewer, HTML_TEMPLATE, VIEWER_BACK_LINK_ATTR } from '../src/viewer/index.mjs';

// sha256 of HTML_TEMPLATE([]) and HTML_TEMPLATE([], { history: true,
// state: { workflowName: 'x' } }) captured BEFORE the backLink option
// existed. If the template is edited for unrelated reasons these hashes
// must be re-captured -- but the "no option" vs "explicit undefined"
// equality assertions below still hold independently.
const PRE_CHANGE_LIVE_SHA256 = '0fd2c9d5e72c31f922356dc00afb2b11e2ac0fef2edf3f86c8d905979809e2f9';
const PRE_CHANGE_HISTORY_SHA256 = '6276e1441a3ac969b8d029d08d0b9a701a65bb9b347b321212cbf19e4ff72ca2';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Self-contained DOM-ish anchor reader: drop comments, <head>, <style>,
// <script>, then keep only what follows the real <body ...> start tag.
function browserVisibleAnchors(html) {
    let s = html.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<head[\s>][\s\S]*?<\/head>/i, '');
    s = s.replace(/<style[\s>][\s\S]*?<\/style>/gi, '');
    s = s.replace(/<script[\s>][\s\S]*?<\/script>/gi, '');
    const bodyStart = s.search(/<body[\s>]/i);
    assert.ok(bodyStart >= 0, 'page must have a <body> start tag');
    s = s.slice(bodyStart);
    const anchors = [];
    const re = /<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
        const hrefM = /\shref="([^"]*)"/.exec(' ' + m[1]);
        anchors.push({ attrs: m[1], href: hrefM ? hrefM[1] : null, text: m[2] });
    }
    return anchors;
}

function fakeWorkflow() {
    return new EventEmitter();
}

function tmpStatePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-back-link-'));
    return { dir, file: path.join(dir, 'state.json') };
}

async function withViewer(opts, fn) {
    const { dir, file } = tmpStatePath();
    const server = createDashboardViewer(fakeWorkflow(), { port: 0, debouncedStatePath: file, ...opts });
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        return await fn(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function httpGet(port, p) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

describe('viewer opts.backLink', () => {
    test('without the option the template output is byte-identical to the pre-change output', () => {
        assert.equal(sha256(HTML_TEMPLATE([])), PRE_CHANGE_LIVE_SHA256);
        assert.equal(sha256(HTML_TEMPLATE([], { history: true, state: { workflowName: 'x' } })), PRE_CHANGE_HISTORY_SHA256);
        assert.equal(HTML_TEMPLATE([], { backLink: undefined }), HTML_TEMPLATE([]));
        assert.equal(browserVisibleAnchors(HTML_TEMPLATE([])).filter((a) => a.attrs.includes(VIEWER_BACK_LINK_ATTR)).length, 0);
    });

    test('without the option the served GET / equals the plain template', async () => {
        await withViewer({}, async (port) => {
            const res = await httpGet(port, '/');
            assert.equal(res.status, 200);
            assert.equal(res.body, HTML_TEMPLATE([]));
        });
    });

    test('with the option the served GET / has exactly one back anchor, inside the real body', async () => {
        const backLink = { href: 'http://localhost:9999/dash/#card-1', text: 'Back to list' };
        await withViewer({ backLink }, async (port) => {
            const res = await httpGet(port, '/');
            assert.equal(res.status, 200);
            const anchors = browserVisibleAnchors(res.body);
            const matching = anchors.filter((a) => a.href === backLink.href);
            assert.equal(matching.length, 1, `expected exactly one anchor with the configured href, got ${JSON.stringify(anchors)}`);
            assert.equal(matching[0].text, backLink.text);
            assert.ok(matching[0].attrs.includes(VIEWER_BACK_LINK_ATTR), 'anchor carries the stable marker attribute');
            // Exactly one marked anchor in the whole raw document too.
            assert.equal(res.body.split(`<a ${VIEWER_BACK_LINK_ATTR}`).length - 1, 1);
            // Located after the real body start tag (the head's CSS comment
            // contains the literal text "<body>" -- it must not be there).
            const realBody = res.body.indexOf('<body data-view=');
            assert.ok(realBody > 0);
            assert.ok(res.body.indexOf(`<a ${VIEWER_BACK_LINK_ATTR}`) > realBody);
            assert.ok(res.body.indexOf(`<a ${VIEWER_BACK_LINK_ATTR}`) > res.body.indexOf('</head>'));
        });
    });

    test('href and text containing HTML metacharacters are escaped', () => {
        const html = HTML_TEMPLATE([], { backLink: { href: 'http://h/?a=1&b="x"<y>', text: '<b>Back</b> & "go"' } });
        assert.ok(html.includes('href="http://h/?a=1&amp;b=&quot;x&quot;&lt;y&gt;"'));
        assert.ok(html.includes('&lt;b&gt;Back&lt;/b&gt; &amp; &quot;go&quot;</a>'));
        assert.ok(!html.includes('<b>Back</b>'));
    });

    test('invalid backLink throws from createDashboardViewer naming the option', () => {
        const bad = [
            { href: 'javascript:alert(1)', text: 'x' },
            { href: '/relative/path', text: 'x' },
            { href: 'ftp://h/x', text: 'x' },
            { href: '', text: 'x' },
            { href: 'http://h/x', text: '' },
            { href: 'http://h/x', text: '   ' },
            { href: 'http://h/x' },
            'http://h/x',
        ];
        for (const backLink of bad) {
            assert.throws(
                () => createDashboardViewer(fakeWorkflow(), { port: 0, backLink }),
                /opts\.backLink/,
                `expected throw for ${JSON.stringify(backLink)}`,
            );
        }
    });

    test('https href is accepted', () => {
        const html = HTML_TEMPLATE([], { backLink: { href: 'https://h.example/x', text: 'Back' } });
        assert.equal(browserVisibleAnchors(html).filter((a) => a.href === 'https://h.example/x').length, 1);
    });
});
