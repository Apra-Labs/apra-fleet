// D5 record half: every per-dispatch record (sprint state's dispatchToolCalls)
// carries what the KNOWLEDGE BANK did for that dispatch -- the pushed block's
// entry ids and byte length, the report's kb_used and kb_wrong ids, the
// captures the engine accepted (with their trigger) and the ones it refused
// (with the rule) -- and the pushed and cited ids reach the KB server's usage
// report through the kb_maintainer (kb_usage). A record from before these
// fields existed still formats.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createDispatchAccounting, formatDispatchToolCalls, kbFieldsOf, normalizePushed,
} from '../fleet-sprint/dispatch-accounting.mjs';
import { createKbInjection, withWrapperKbBlock, pushedInfo } from '../fleet-sprint/kb-injection.mjs';
import { createKbWorkClient, reportKbUse, vetKbWork, kbKnowledgeBlockIds, KB_MAINTAINER_CALL } from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

const MAINT = { id: 'm-1', name: 'maint', type: 'remote' };
const WORKER = { id: 'w-1', name: 'worker', type: 'remote' };
const SINCE = '2026-10-01T00:00:00.000Z';

const entry = (id, extra = {}) => ({
    id,
    confidence: 'CONFIRMED',
    title: `Entry ${id} durable title`,
    summary: `Summary of entry ${id}, long enough to read.`,
    source_files: ['src/a.ts'],
    ...extra,
});
const ENTRIES = [entry('kb-a'), entry('kb-b'), entry('kb-x', { confidence: 'INFERRED' }), entry('kb-c')];

const ACCEPTED = {
    type: 'knowledge',
    title: 'A durable claim title',
    summary: 'A summary long enough to be meaningful about the repo.',
    trigger: 'hidden-invariant',
    source_files: ['src/real.ts'],
    symbols: ['realSymbol'],
};
const REFUSED = { ...ACCEPTED, title: 'A capture without any trigger', trigger: undefined };

/** A fake kb_maintainer member: records every memberCall it receives. */
function fakeMaintainer() {
    const calls = [];
    const kbWork = createKbWorkClient({
        maintainers: selfMaintainer(MAINT, ['worker', 'maint']),
        memberCall: async (member, tool, args, opts) => {
            calls.push({ member: member.name, tool, args, opts });
            return {};
        },
        gPull: async () => {},
        log: () => {},
    });
    return { calls, kbWork };
}

function accountingFor({ store, kbWork, logs = [] }) {
    let reads = 0;
    return createDispatchAccounting({
        store,
        memberOf: (name) => (name === 'worker' ? WORKER : null),
        memberCall: async () => {
            const n = reads++;
            return { since: SINCE, kb: 2 * n, code: n };
        },
        reportUsage: ({ memberName, pushed, cited }) => kbWork.reportUsage(memberName, { pushed, cited }),
        log: (m) => logs.push(m),
        now: () => '2026-11-05T00:00:00.000Z',
    });
}

describe('per-dispatch KB record', () => {
    test('one dispatch: pushed block, kb_used/kb_wrong, one accepted and one refused capture -- every new field is stored and the maintainer gets the usage report', async () => {
        const { calls, kbWork } = fakeMaintainer();
        const store = [];
        const accounting = accountingFor({ store, kbWork });
        const kbInjection = createKbInjection({
            kbWork: { knowledgeFor: async () => ({ entries: ENTRIES, source: 'query' }) },
        });

        // The dispatch wrapper's step: the block is appended and its pushed info reported.
        let pushed = null;
        const prompt = await withWrapperKbBlock('Do the work.', {
            kbInjection, agentType: 'harvester', member: 'worker', onPushed: (p) => { pushed = p; },
        });
        assert.ok(prompt.includes('KNOWLEDGE BANK'), 'the block is still injected');
        assert.deepEqual(pushed.ids, ['kb-a', 'kb-b', 'kb-c'], 'only the CONFIRMED entries the block carries');
        const block = prompt.slice('Do the work.\n\n'.length);
        assert.equal(pushed.bytes, Buffer.byteLength(block, 'utf8'));

        const report = {
            kb_used: [{ id: 'kb-a', how: 'followed its rule' }, { id: 'kb-c', how: 'skipped a dead end' }],
            kb_wrong: [{ id: 'kb-b', reason: 'the code no longer does this' }],
            kb_captures: [ACCEPTED, REFUSED],
        };
        await accounting.around({ memberName: 'worker', role: 'harvester', label: 'Harvest', pushed }, async () => report);

        // The two postResult steps, as runner.js runs them.
        const use = await reportKbUse({ role: 'harvester', member: 'worker', value: report, kbWork });
        await accounting.noteKbReport({ memberName: 'worker', role: 'harvester' }, use);
        const vetted = vetKbWork('harvester', report);
        accounting.noteKbCaptures({ memberName: 'worker', role: 'harvester' }, { captures: vetted.captures, rejects: vetted.refusedCaptures });

        assert.equal(store.length, 1);
        const rec = store[0];
        assert.equal(rec.kb, 2, 'existing counts unchanged');
        assert.equal(rec.code, 1);
        assert.deepEqual(rec.pushed, { ids: ['kb-a', 'kb-b', 'kb-c'], bytes: pushed.bytes });
        assert.ok(rec.pushed.bytes > 0);
        assert.deepEqual(rec.kb_used, ['kb-a', 'kb-c']);
        assert.deepEqual(rec.kb_wrong, ['kb-b']);
        assert.deepEqual(rec.captures, [{ title: ACCEPTED.title, trigger: 'hidden-invariant' }]);
        assert.equal(rec.rejects.length, 1);
        assert.equal(rec.rejects[0].title, REFUSED.title);
        assert.equal(rec.rejects[0].rule, 'trigger');
        assert.match(rec.rejects[0].reason, /rule trigger/);

        // The fake maintainer received the pushed and the cited ids, as the maintainer.
        const usage = calls.filter((c) => c.tool === 'kb_usage');
        assert.deepEqual(usage.map((c) => c.args), [
            { pushed: ['kb-a', 'kb-b', 'kb-c'] },
            { cited: ['kb-a', 'kb-c'] },
        ]);
        for (const c of usage) {
            assert.equal(c.member, 'maint');
            assert.deepEqual(c.opts, KB_MAINTAINER_CALL);
        }

        const lines = formatDispatchToolCalls(store);
        assert.match(lines[0], /pushed 3 entr\(ies\) \(\d+ bytes\), cited 2, wrong 1, captures 1 \(hidden-invariant\), rejects 1 \(trigger\)/);
    });

    test('nothing pushed: pushed is empty, and the usage report is not sent', async () => {
        const { calls, kbWork } = fakeMaintainer();
        const store = [];
        const accounting = accountingFor({ store, kbWork });
        await accounting.around({ memberName: 'worker', role: 'deployer' }, async () => ({}));
        assert.deepEqual(store[0].pushed, { ids: [], bytes: 0 });
        assert.deepEqual(store[0].kb_used, []);
        assert.deepEqual(store[0].kb_wrong, []);
        assert.deepEqual(store[0].captures, []);
        assert.deepEqual(store[0].rejects, []);
        assert.equal(calls.filter((c) => c.tool === 'kb_usage').length, 0);
    });

    test('a failing usage report is logged and never fails the dispatch', async () => {
        const store = [];
        const logs = [];
        const accounting = createDispatchAccounting({
            store,
            reportUsage: async () => { throw new Error('maintainer gone'); },
            log: (m) => logs.push(m),
        });
        const out = await accounting.around({ memberName: 'worker', role: 'doer', pushed: { ids: ['kb-a'], bytes: 10 } }, async () => 'result');
        assert.equal(out, 'result');
        await accounting.noteKbReport({ memberName: 'worker', role: 'doer' }, { used: ['kb-a'], wrong: [] });
        assert.deepEqual(store[0].kb_used, ['kb-a']);
        assert.ok(logs.some((l) => /usage report .*failed \(non-fatal\): maintainer gone/.test(l)), logs.join('\n'));
    });

    test('the report fields land on the latest record of that member and role, not an earlier dispatch', async () => {
        const store = [];
        const accounting = createDispatchAccounting({ store });
        await accounting.around({ memberName: 'worker', role: 'doer' }, async () => ({}));
        await accounting.around({ memberName: 'other', role: 'reviewer' }, async () => ({}));
        await accounting.around({ memberName: 'worker', role: 'doer' }, async () => ({}));
        await accounting.noteKbReport({ memberName: 'worker', role: 'doer' }, { used: ['kb-z'], wrong: [] });
        assert.deepEqual(store.map((r) => r.kb_used), [[], [], ['kb-z']]);
    });

    test('a record of the previous shape (no KB fields) still formats and reads with empty defaults', () => {
        const old = [{ index: 1, member: 'worker', role: 'doer', label: null, startedAt: 'a', endedAt: 'b', kb: 3, code: 'unknown', reason: 'counters went backwards' }];
        let lines;
        assert.doesNotThrow(() => { lines = formatDispatchToolCalls(old); });
        assert.match(lines[0], /kb_\* calls: 3, code_\* calls: unknown/);
        assert.doesNotMatch(lines[0], /pushed/, 'an old record gets no KB detail');
        assert.deepEqual(kbFieldsOf(old[0]), { pushed: { ids: [], bytes: 0 }, kb_used: [], kb_wrong: [], captures: [], rejects: [], promoted: [] });
        assert.deepEqual(normalizePushed({ ids: ['a', 'a', 7], bytes: -1 }), { ids: ['a'], bytes: 0 });
    });

    test('a prompt-builder role: pushedIn attributes the block only when the prompt carries it', async () => {
        const kbInjection = createKbInjection({
            kbWork: { knowledgeFor: async () => ({ entries: ENTRIES, source: 'query' }) },
        });
        const [block] = await kbInjection.blockFor({ role: 'doer', member: 'worker' });
        const info = kbInjection.pushedIn(`prompt\n\n${block}`, 'worker');
        assert.deepEqual(info, { ids: kbKnowledgeBlockIds(ENTRIES), bytes: Buffer.byteLength(block, 'utf8') });
        assert.deepEqual(kbInjection.pushedIn('a resume prompt without the block', 'worker'), { ids: [], bytes: 0 });
        assert.deepEqual(kbInjection.pushedIn(`prompt\n\n${block}`, 'someone-else'), { ids: [], bytes: 0 });
        assert.deepEqual(pushedInfo(ENTRIES, ''), { ids: [], bytes: 0 });
    });
});
