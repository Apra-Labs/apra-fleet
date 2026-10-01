import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// KB write routing (createKbWorkClient): every KB write for a repository is
// queued per repository and applied in that repository's kb_maintainer's
// MEMBER session, after a G-pull on the maintainer, never while the
// maintainer is mid-dispatch, and never lost when the maintainer is
// unreachable. Unit level, with an injected memberCall and a fake G-pull; the
// mock-sprint test through runner.js lives in mock-sprint-kb-write-routing.
// =============================================================================

const REPO_A = 'github.com/org/repo-a';
const REPO_B = 'github.com/org/repo-b';
const MAINT_A = Object.freeze({ id: 'id-maint-a', name: 'maint-a', type: 'remote' });
const MAINT_B = Object.freeze({ id: 'id-maint-b', name: 'maint-b', type: 'remote' });

const CAPTURE = Object.freeze({
    type: 'knowledge',
    title: 'The widget cache is keyed per tenant',
    summary: 'WidgetCache.get keys every entry by tenant id, so tenants never share a hit.',
    content: 'src/widget-cache.ts builds its key as `${tenant}:${id}`; a cross-tenant read always misses.',
    source_files: ['src/widget-cache.ts'],
});
const capture = (title) => ({ ...CAPTURE, title });
const REASON = 'Verified against src/widget-cache.ts:42 and the tenant isolation test.';

function selector() {
    return fakeMaintainerSelector({
        repoOf: { 'doer-a': REPO_A, 'maint-a': REPO_A, 'doer-b': REPO_B, 'maint-b': REPO_B },
        maintainerOf: { [REPO_A]: MAINT_A, [REPO_B]: MAINT_B },
        nonRepo: ['scratch'],
    });
}

/** A recording harness: one ordered event list across G-pulls and member calls. */
function harness({ memberCall, gPull, maintainers = selector() } = {}) {
    const events = [];
    const logs = [];
    const client = createKbWorkClient({
        maintainers,
        memberCall: async (member, tool, args) => {
            events.push({ type: 'call', member: member.name, tool, args });
            return memberCall ? memberCall(member, tool, args) : {};
        },
        gPull: async (name) => {
            events.push({ type: 'gpull', member: name });
            if (gPull) await gPull(name);
        },
        log: (m) => logs.push(m),
    });
    const calls = () => events.filter((e) => e.type === 'call');
    const shape = () => events.map((e) => (e.type === 'gpull' ? `gpull:${e.member}` : `${e.tool}@${e.member}`));
    return { client, events, logs, calls, shape };
}

describe('KB write routing: the queue and the maintainer session', () => {
    test("a doer's capture is applied in the maintainer's session, not the producing member's", async () => {
        const h = harness();
        const out = await h.client.apply('doer', { id: 'id-doer-a', name: 'doer-a', type: 'remote' }, { kb_captures: [CAPTURE] });
        assert.equal(out.captured, 1);
        assert.deepEqual(h.shape(), ['gpull:maint-a', 'kb_capture@maint-a']);
        assert.equal(h.calls()[0].args.title, CAPTURE.title);
        assert.equal(h.client.pendingCount(), 0);
    });

    test('a bare member name routes the same way as a member record', async () => {
        const h = harness();
        await h.client.apply('doer', 'doer-a', { kb_captures: [CAPTURE] });
        assert.deepEqual(h.shape(), ['gpull:maint-a', 'kb_capture@maint-a']);
    });

    test('writes are queued per repository: each repository goes to its own maintainer after its own G-pull', async () => {
        const h = harness();
        await h.client.apply('doer', 'doer-a', { kb_captures: [capture('first claim about repo a')] });
        await h.client.apply('doer', 'doer-b', { kb_captures: [capture('first claim about repo b')] });
        assert.deepEqual(h.shape(), ['gpull:maint-a', 'kb_capture@maint-a', 'gpull:maint-b', 'kb_capture@maint-b']);
    });

    test('a G-pull precedes EVERY batch, and a batch carries captures and promotions together', async () => {
        const h = harness();
        await h.client.apply('reviewer', 'doer-a', {
            kb_captures: [capture('claim one'), capture('claim two')],
            kb_promotions: [{ id: 'entry-1', reason: REASON }],
        });
        await h.client.apply('doer', 'doer-a', { kb_captures: [capture('claim three')] });
        assert.deepEqual(h.shape(), [
            'gpull:maint-a', 'kb_capture@maint-a', 'kb_capture@maint-a', 'kb_promote@maint-a',
            'gpull:maint-a', 'kb_capture@maint-a',
        ]);
        assert.deepEqual(h.calls()[2].args, { id: 'entry-1', reason: REASON });
    });

    test('no write is made without a maintainer selection -- dropped with a WARN, never sent to the producer', async () => {
        const h = harness({ maintainers: null });
        const out = await h.client.apply('doer', 'doer-a', { kb_captures: [CAPTURE] });
        assert.equal(out.captured, 0);
        assert.deepEqual(h.events, []);
        assert.ok(h.logs.some((l) => /^\[kb-work\] WARN: no kb_maintainer for member 'doer-a' \(doer\)/.test(l)), JSON.stringify(h.logs));
    });

    test('a capture from a member whose work folder is not a repository is dropped with a WARN', async () => {
        const h = harness();
        const out = await h.client.apply('doer', 'scratch', { kb_captures: [CAPTURE] });
        assert.equal(out.captured, 0);
        assert.deepEqual(h.events, [], 'no G-pull and no kb_* call for a non-repository member');
        assert.ok(h.logs.includes("[kb-work] WARN: member 'scratch' (doer): work folder is not a repository -- 1 capture(s) dropped"), JSON.stringify(h.logs));
        assert.equal(h.client.pendingCount(), 0, 'dropped, not queued');
    });

    test('a tool-level rejection is logged and consumed, not re-queued', async () => {
        const h = harness({
            memberCall: async (m, tool, args) => (args.title === 'rejected claim'
                ? { isError: true, content: [{ type: 'text', text: 'an entry must cite at least one source file' }] }
                : {}),
        });
        const out = await h.client.apply('doer', 'doer-a', { kb_captures: [capture('rejected claim'), capture('accepted claim')] });
        assert.equal(out.captured, 1);
        assert.equal(h.client.pendingCount(), 0);
        assert.ok(h.logs.some((l) => l === '[kb-work] kb_capture rejected for "rejected claim" (non-fatal): an entry must cite at least one source file'), JSON.stringify(h.logs));
    });
});

describe('KB write routing: busy maintainer', () => {
    test('writes for a maintainer that is mid-dispatch stay queued and are applied when its dispatch ends', async () => {
        const h = harness();
        await h.client.dispatchStarted('maint-a');
        const out = await h.client.apply('doer', 'doer-a', { kb_captures: [CAPTURE] });
        assert.equal(out.captured, 0);
        assert.deepEqual(h.events, [], 'no G-pull and no write while the maintainer is mid-dispatch');
        assert.equal(h.client.pendingCount(REPO_A), 1);
        assert.ok(h.logs.some((l) => l.startsWith("[kb-work] maintainer 'maint-a' is mid-dispatch -- 1 KB write(s)")), JSON.stringify(h.logs));

        await h.client.dispatchEnded('maint-a');
        assert.deepEqual(h.shape(), ['gpull:maint-a', 'kb_capture@maint-a']);
        assert.equal(h.client.pendingCount(), 0);
    });

    test('nested dispatch brackets: the queue waits for the LAST one to end', async () => {
        const h = harness();
        await h.client.dispatchStarted('maint-a'); // the sync bracket
        await h.client.dispatchStarted('maint-a'); // the agent() call inside it
        await h.client.apply('doer', 'doer-a', { kb_captures: [CAPTURE] });
        await h.client.dispatchEnded('maint-a');
        assert.deepEqual(h.events, [], 'still inside the outer bracket');
        await h.client.dispatchEnded('maint-a');
        assert.deepEqual(h.shape(), ['gpull:maint-a', 'kb_capture@maint-a']);
    });

    test("another member's dispatch does not hold a repository's writes", async () => {
        const h = harness();
        await h.client.dispatchStarted('doer-a');
        await h.client.apply('doer', 'doer-b', { kb_captures: [CAPTURE] });
        assert.deepEqual(h.shape(), ['gpull:maint-b', 'kb_capture@maint-b']);
    });

    test('a dispatch that starts mid-batch stops the batch: no write begins during it', async () => {
        let h;
        h = harness({
            memberCall: async (m, tool, args) => {
                // The maintainer's next dispatch opens while the first write is in flight.
                if (args.title === 'first') await h.client.dispatchStarted('maint-a');
                return {};
            },
        });
        const out = await h.client.apply('doer', 'doer-a', { kb_captures: [capture('first'), capture('second')] });
        assert.equal(out.captured, 1);
        assert.deepEqual(h.shape(), ['gpull:maint-a', 'kb_capture@maint-a']);
        assert.equal(h.client.pendingCount(REPO_A), 1);
        await h.client.dispatchEnded('maint-a');
        assert.deepEqual(h.shape(), ['gpull:maint-a', 'kb_capture@maint-a', 'gpull:maint-a', 'kb_capture@maint-a']);
        assert.equal(h.calls()[1].args.title, 'second');
    });

    test('dispatchStarted waits out a write already in flight to the maintainer', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const order = [];
        const h = harness({ memberCall: async () => { await gate; order.push('write-done'); return {}; } });
        const applying = h.client.apply('doer', 'doer-a', { kb_captures: [CAPTURE] });
        await new Promise((r) => setImmediate(r));
        const starting = h.client.dispatchStarted('maint-a').then(() => order.push('dispatch-start'));
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(order, [], 'the dispatch must not start while the write is in flight');
        release();
        await Promise.all([applying, starting]);
        assert.deepEqual(order, ['write-done', 'dispatch-start']);
    });

    test('dispatchStarted waits out a queue G-pull already in flight to the maintainer', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const order = [];
        const h = harness({ gPull: async () => { await gate; order.push('gpull-done'); } });
        const applying = h.client.apply('doer', 'doer-a', { kb_captures: [CAPTURE] });
        await new Promise((r) => setImmediate(r));
        const starting = h.client.dispatchStarted('maint-a').then(() => order.push('dispatch-start'));
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(order, [], 'the dispatch must not start while the queue G-pull is in flight');
        release();
        await Promise.all([applying, starting]);
        assert.deepEqual(order, ['gpull-done', 'dispatch-start']);
        assert.equal(h.calls().length, 0, 'no write lands once the dispatch has started');
        assert.equal(h.client.pendingCount(REPO_A), 1);
    });
});

describe('KB write routing: unreachable maintainer', () => {
    test('a failing G-pull keeps the batch queued with a WARN; the next flush applies it', async () => {
        let down = true;
        const h = harness({ gPull: async () => { if (down) throw new Error('ssh: connect to host maint-a: Connection refused'); } });
        const out = await h.client.apply('doer', 'doer-a', { kb_captures: [CAPTURE] });
        assert.equal(out.captured, 0);
        assert.equal(h.calls().length, 0, 'no write without a successful G-pull');
        assert.equal(h.client.pendingCount(REPO_A), 1);
        assert.ok(h.logs.some((l) => /^\[kb-work\] WARN: G-pull on maintainer 'maint-a' failed \(ssh: connect to host maint-a: Connection refused\) -- maintainer unreachable; 1 KB write\(s\) for github\.com\/org\/repo-a stay queued$/.test(l)), JSON.stringify(h.logs));

        down = false;
        const later = await h.client.flushAll();
        assert.equal(later.captured, 1);
        assert.equal(h.client.pendingCount(), 0);
        assert.deepEqual(h.shape(), ['gpull:maint-a', 'gpull:maint-a', 'kb_capture@maint-a']);
    });

    test('a maintainer lost mid-batch keeps the unapplied writes queued, in order, with a WARN', async () => {
        let down = false;
        let tripped = false;
        const h = harness({
            memberCall: async (m, tool, args) => {
                if (!tripped && args.title === 'second') { tripped = true; down = true; }
                if (down) {
                    const err = new Error(`member ${m.name} unreachable`);
                    err.code = 'E-CONNECT';
                    throw err;
                }
                return {};
            },
        });
        const out = await h.client.apply('doer', 'doer-a', { kb_captures: [capture('first'), capture('second'), capture('third')] });
        assert.equal(out.captured, 1);
        assert.equal(h.client.pendingCount(REPO_A), 2, 'nothing is lost');
        assert.ok(h.logs.some((l) => l.startsWith("[kb-work] WARN: maintainer 'maint-a' unreachable during kb_capture for \"second\"") && l.endsWith('2 KB write(s) for github.com/org/repo-a stay queued')), JSON.stringify(h.logs));

        h.client.warnPending();
        assert.ok(h.logs.includes('[kb-work] WARN: 2 KB write(s) for github.com/org/repo-a are still queued (maintainer busy or unreachable) -- not applied'));

        down = false;
        const before = h.calls().length;
        const later = await h.client.flushAll();
        assert.equal(later.captured, 2);
        assert.deepEqual(h.calls().slice(before).map((c) => c.args.title), ['second', 'third']);
    });
});
