import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildOverflowComments, parseOverflowComment, bodyHasOverflowPointer, overflowPointer, overflowFailedPointer,
    OVERFLOW_MAX_COMMENTS, OVERFLOW_SUPERSEDED_COMMENT,
} from '../fleet-sprint/pr-body.mjs';
import { publishPrOverflowComments } from '../fleet-sprint/pr-overflow-comments.mjs';

// =============================================================================
// Units of the PR-body overflow comments: chunking (pr-body.mjs
// buildOverflowComments / parseOverflowComment) and the relaunch upsert
// decisions (pr-overflow-comments.mjs publishPrOverflowComments) driven
// through a scripted `run` -- no builders' network shapes are asserted here
// (test/vcs-pr-comment-builders.test.mjs pins those).
//
// ASCII only.
// =============================================================================

const text = (n, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i} ${'w'.repeat(40)}`).join('\n');

describe('buildOverflowComments', () => {
    test('every comment is within the limit, carries its index, and the pieces concatenate to the overflow', () => {
        const overflow = `\n${text(300)}`;
        const { comments, notPosted } = buildOverflowComments(overflow, { commentMaxLength: 2000 });
        assert.equal(notPosted, 0);
        assert.ok(comments.length > 1);
        const parsed = comments.map(parseOverflowComment);
        comments.forEach((c, i) => {
            assert.ok(c.length <= 2000, `comment ${i + 1} is ${c.length}`);
            assert.equal(parsed[i].index, i + 1);
            assert.equal(parsed[i].total, comments.length);
        });
        assert.equal(parsed.map((p) => p.text).join(''), overflow);
    });

    test('past the ceiling the last comment names how many characters were not posted', () => {
        const overflow = text(2000);
        const { comments, notPosted } = buildOverflowComments(overflow, { commentMaxLength: 1000 });
        assert.equal(comments.length, OVERFLOW_MAX_COMMENTS);
        assert.ok(notPosted > 0);
        const last = parseOverflowComment(comments[comments.length - 1]);
        assert.match(last.text, new RegExp(`\\*\\[\\.\\.\\. ${notPosted} characters of reviewer notes not posted: the ${OVERFLOW_MAX_COMMENTS}-comment limit was reached -- the full notes are in the sprint run log \\.\\.\\.\\]\\*$`));
        assert.ok(comments.every((c) => c.length <= 1000));
        const posted = comments.map((c) => parseOverflowComment(c).text).join('').replace(/\n\n\*\[\.\.\. \d+ characters of reviewer notes not posted[^\n]*$/, '');
        assert.equal(posted.length + notPosted, overflow.length);
        assert.ok(overflow.startsWith(posted));
    });

    test('no overflow, or a limit too small to carry anything, yields no comments', () => {
        assert.deepEqual(buildOverflowComments('', { commentMaxLength: 1000 }), { comments: [], notPosted: 0 });
        assert.deepEqual(buildOverflowComments('abc', { commentMaxLength: 20 }), { comments: [], notPosted: 3 });
    });

    test('parse: other comments are null, superseded stubs are recognised, CRLF bodies read back', () => {
        assert.equal(parseOverflowComment('LGTM'), null);
        assert.deepEqual(parseOverflowComment(OVERFLOW_SUPERSEDED_COMMENT), { superseded: true });
        const [c] = buildOverflowComments('a\nb', { commentMaxLength: 1000 }).comments;
        assert.deepEqual(parseOverflowComment(c.replace(/\n/g, '\r\n')), { index: 1, total: 1, text: 'a\nb' });
    });

    test('pointer lines are recognised in a description', () => {
        assert.ok(bodyHasOverflowPointer(`x\n${overflowPointer(3)}\n`));
        assert.ok(bodyHasOverflowPointer(`x\n${overflowFailedPointer(120)}\n`));
        assert.ok(!bodyHasOverflowPointer('x\nno pointer here'));
    });
});

/** A scripted GitHub-shaped PR comment store answering
 *  publishPrOverflowComments' `run`: it reads the REAL built request (staged
 *  JSON payload, comment id from the URL) like the provider would. */
function scriptedStore({ initial = [], fail = {} } = {}) {
    const comments = new Map(initial.map((b, i) => [i + 1, b]));
    let next = initial.length + 1;
    const calls = [];
    const idOf = (built) => Number(/\/issues\/comments\/(\d+)$/.exec(built.command.trim())[1]);
    const run = async (buildFn, what) => {
        const built = buildFn();
        calls.push({ what, command: built.command });
        if (fail[what]) return { ok: false, error: `${what} failed: HTTP 500` };
        if (what === 'list-comments') {
            return { ok: true, built, body: [...comments.entries()].map(([id, body]) => ({ id, body })) };
        }
        if (what === 'comment') { comments.set(next++, JSON.parse(built.payload.content).body); return { ok: true, built }; }
        if (what === 'update-comment') { comments.set(idOf(built), JSON.parse(built.payload.content).body); return { ok: true, built }; }
        if (what === 'delete-comment') { comments.delete(idOf(built)); return { ok: true, built }; }
        throw new Error(`unexpected ${what}`);
    };
    return { comments, calls, run };
}

async function publishWith(store, comments, { existing = true, logs = [] } = {}) {
    return publishPrOverflowComments({
        comments, prId: 42, prLabel: 'https://example.invalid/pr/42', existing,
        run: store.run,
        coords: () => ({ provider: 'github', repo: 'acme/widgets', token: 't', os: 'linux' }),
        payloadPath: () => '/work/repo/.apra-call/x.json',
        log: (m) => logs.push(m),
        logPrefix: '[T]',
    });
}

describe('publishPrOverflowComments (scripted provider)', () => {
    const first = buildOverflowComments(text(200, 'a'), { commentMaxLength: 2000 }).comments;
    const second = buildOverflowComments(text(90, 'b'), { commentMaxLength: 2000 }).comments;

    test('a new PR posts every chunk in order without listing', async () => {
        const store = scriptedStore();
        const res = await publishWith(store, first, { existing: false });
        assert.equal(res.ok, true);
        assert.equal(res.posted, first.length);
        assert.ok(!store.calls.some((c) => c.what === 'list-comments'));
        assert.deepEqual([...store.comments.values()], first);
    });

    test('relaunch: marked comments are updated in place, identical ones skipped, surplus deleted; human comments untouched', async () => {
        const store = scriptedStore({ initial: ['human review comment', ...first] });
        const replay = [first[0], ...second.slice(1)];
        const res = await publishWith(store, replay);
        assert.equal(res.ok, true);
        assert.equal(res.posted, 0, 'no new comment while a marked one can be reused');
        assert.equal(res.unchanged, 1);
        assert.equal(res.updated, replay.length - 1);
        assert.equal(res.removed, first.length - replay.length);
        const marked = [...store.comments.values()].filter((b) => parseOverflowComment(b));
        assert.deepEqual(marked, replay, 'exactly the new chunks remain, no duplicates');
        assert.ok([...store.comments.values()].includes('human review comment'));
    });

    test('relaunch with more chunks than before posts only the extra ones', async () => {
        const store = scriptedStore({ initial: second });
        const res = await publishWith(store, first);
        assert.equal(res.updated + res.unchanged, second.length);
        assert.equal(res.posted, first.length - second.length);
        assert.deepEqual([...store.comments.values()].filter((b) => parseOverflowComment(b)), first);
    });

    test('a surplus chunk that cannot be deleted is emptied to a superseded stub and reused next time', async () => {
        const store = scriptedStore({ initial: first, fail: { 'delete-comment': true } });
        const res = await publishWith(store, second);
        assert.equal(res.ok, true);
        assert.equal(res.removed, first.length - second.length);
        const stubs = [...store.comments.values()].filter((b) => b === OVERFLOW_SUPERSEDED_COMMENT);
        assert.equal(stubs.length, first.length - second.length);
        const again = await publishWith(scriptedStore({ initial: [...store.comments.values()] }), first);
        assert.equal(again.posted, 0, 'stubs are reused before anything new is posted');
    });

    test('a failed post is returned (never thrown) and logged as a WARNING naming the PR and the chunk', async () => {
        const store = scriptedStore({ fail: { comment: true } });
        const logs = [];
        const res = await publishWith(store, first, { existing: false, logs });
        assert.equal(res.ok, false);
        assert.match(res.error, /could not post reviewer-notes overflow comment 1 of \d+ on PR https:\/\/example\.invalid\/pr\/42/);
        assert.ok(logs.some((l) => /^\[T\]: WARNING: could not post reviewer-notes overflow comment 1 of/.test(l) && l.includes('full notes are in this run log')), logs.join('\n'));
    });

    test('a failed list on a relaunch posts nothing (no blind duplicates) and reports the failure', async () => {
        const store = scriptedStore({ initial: first, fail: { 'list-comments': true } });
        const logs = [];
        const res = await publishWith(store, second, { logs });
        assert.equal(res.ok, false);
        assert.ok(!store.calls.some((c) => c.what === 'comment'));
        assert.ok(logs.some((l) => l.includes('WARNING: could not list the comments of PR')));
    });
});
