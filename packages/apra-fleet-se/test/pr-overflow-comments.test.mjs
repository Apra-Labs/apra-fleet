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

// ---------------------------------------------------------------------------
// Paginated comment listing: the lister follows the provider's pages, stops on
// the last one, and is bounded.
// ---------------------------------------------------------------------------

import { buildListCommentsCommand } from '../fleet-sprint/vcs-module.mjs';
import { MAX_COMMENT_LIST_PAGES } from '../fleet-sprint/pr-overflow-comments.mjs';

const BB_COORDS = { provider: 'bitbucket', repoRef: { workspace: 'acme', repo: 'widgets' }, token: 't', os: 'linux' };
const GH_COORDS = { provider: 'github', repo: 'acme/widgets', token: 't', os: 'linux' };
const human = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i + 1, body: `human ${from + i + 1}` }));

describe('list-comments pagination', () => {
    test('github: page 1 has no page param, a full page points at page 2, a short page ends the walk', () => {
        const p1 = buildListCommentsCommand({ ...GH_COORDS, pull_request_id: 42 });
        assert.ok(p1.command.includes('per_page=100') && !p1.command.includes('page=2'));
        assert.deepEqual(p1.nextPage(human(100)), { page: 2 });
        assert.equal(p1.nextPage(human(99)), null);
        const p2 = buildListCommentsCommand({ ...GH_COORDS, pull_request_id: 42, page: 2 });
        assert.ok(p2.command.includes('per_page=100&page=2'), p2.command);
        assert.deepEqual(p2.nextPage(human(100)), { page: 3 });
        assert.equal(p2.nextPage(human(50)), null);
    });

    test('bitbucket: follows the response next URL, only when it stays under the PR comments endpoint', () => {
        const first = buildListCommentsCommand({ ...BB_COORDS, pull_request_id: 9 });
        const base = 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/9/comments';
        const nextUrl = `${base}?pagelen=100&page=2`;
        assert.deepEqual(first.nextPage({ values: [], next: nextUrl }), { page_url: nextUrl });
        assert.equal(first.nextPage({ values: [] }), null);
        assert.equal(first.nextPage({ values: [], next: 'https://evil.example/x' }), null);
        const second = buildListCommentsCommand({ ...BB_COORDS, pull_request_id: 9, page_url: nextUrl });
        assert.ok(second.command.includes(nextUrl), second.command);
        const ignored = buildListCommentsCommand({ ...BB_COORDS, pull_request_id: 9, page_url: 'https://evil.example/x' });
        assert.ok(!ignored.command.includes('evil.example'));
    });

    /** A store whose list answers `pages` full pages of non-engine comments. */
    function pagedRun(provider, pages, calls) {
        return async (buildFn, what) => {
            const built = buildFn();
            calls.push({ what, command: built.command });
            if (what !== 'list-comments') throw new Error(`unexpected ${what}`);
            const page = calls.length;
            if (provider === 'github') return { ok: true, built, body: page < pages ? human(100, (page - 1) * 100) : human(3) };
            const base = 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/9/comments';
            return {
                ok: true, built,
                body: { values: human(2).map((c) => ({ ...c, content: { raw: c.body } })), ...(page < pages ? { next: `${base}?pagelen=100&page=${page + 1}` } : {}) },
            };
        };
    }
    const publishPaged = (provider, pages, calls, logs = []) => publishPrOverflowComments({
        comments: [], prId: provider === 'github' ? 42 : 9, existing: true,
        run: pagedRun(provider, pages, calls),
        coords: () => (provider === 'github' ? GH_COORDS : BB_COORDS),
        payloadPath: () => '/work/x.json', log: (m) => logs.push(m), logPrefix: '[T]',
    });

    for (const provider of ['github', 'bitbucket']) {
        test(`${provider}: walks every page and stops on the last one`, async () => {
            const calls = [];
            const res = await publishPaged(provider, 3, calls);
            assert.equal(res.ok, true);
            assert.equal(calls.length, 3);
        });

        test(`${provider}: a misbehaving API that always has a next page stops at the page cap`, async () => {
            const calls = [];
            const logs = [];
            const res = await publishPaged(provider, Number.MAX_SAFE_INTEGER, calls, logs);
            assert.equal(res.ok, true);
            assert.equal(calls.length, MAX_COMMENT_LIST_PAGES);
            assert.ok(logs.some((l) => /more than \d+ pages of comments/.test(l)), logs.join('\n'));
        });
    }
});

describe('partial failure pointer', () => {
    test('names how many comments were posted; a total failure keeps the could-not-be-posted wording', () => {
        const partial = overflowFailedPointer(900, 1, 3);
        assert.match(partial, /^Reviewer notes continued: 900 characters did not fit this description; 1 of 3 overflow comment\(s\) were posted and 2 could not be /);
        assert.ok(bodyHasOverflowPointer(partial));
        assert.equal(overflowFailedPointer(900, 0, 3), overflowFailedPointer(900));
        assert.match(overflowFailedPointer(900), /could not be posted as PR comments/);
    });
});
