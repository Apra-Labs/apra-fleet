import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createDispatchAccounting,
    KB_ACCOUNTING_TOOLS,
    CODE_CALLS_NOT_OBSERVABLE,
} from '../fleet-sprint/dispatch-accounting.mjs';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';

// =============================================================================
// apra-fleet-b4g.33 -- data-collection half of the Knowledge and Code
// Intelligence panel. Pins the nine acceptance criteria: kb_* counts are a
// side effect of the actual kb.mjs call sites (AC1); code_* is a named
// NOT-OBSERVABLE marker, never 0 (AC2); the preflight code outcome is
// readable per member from the same store (AC3); capture kept/rejected with
// cause covers both the isError and throw paths (AC4); the preflight readback
// carries exactly the real per-member fields (AC5); recording never fails a
// dispatch (AC6); kb_* counts are zero-initialized (AC7).
// =============================================================================

describe('createDispatchAccounting: kb_* counts (AC1, AC7)', () => {
    test('a record is zero-initialized for every KB_ACCOUNTING_TOOLS entry on first touch', () => {
        const accounting = createDispatchAccounting();
        const rec = accounting.forDispatch({ role: 'doer', member: 'm1' });
        for (const tool of KB_ACCOUNTING_TOOLS) {
            assert.equal(rec.kbCounts[tool], 0, `${tool} must start at an explicit 0, not an absent key`);
        }
    });

    test('recordKbCall counts a real kb.mjs call site as a side effect of the call happening', async () => {
        const accounting = createDispatchAccounting();
        const calls = [];
        const callTool = async (name, args) => {
            calls.push(name);
            if (name === 'kb_query') {
                return { content: [{ text: JSON.stringify({ l1_results: [{ id: 'e1', title: 't' }] }) }] };
            }
            return { content: [{ text: '{}' }] };
        };
        const kbWork = createKbWorkClient({ callTool, accounting });
        const dispatch = { role: 'doer', member: 'm1' };
        await kbWork.relevantKnowledge('/repo', ['term'], dispatch);

        const rec = accounting.dispatchRecordFor('doer', 'm1');
        assert.ok(rec, 'a record must exist for the (role, member) pair after a real call');
        assert.equal(rec.kbCounts.kb_query, 1, 'kb_query must be counted once');
        assert.equal(rec.kbCounts.kb_capture, 0, 'an untouched tool stays at its zero-init, not absent');
        assert.deepEqual(calls, ['kb_query']);
    });

    test('kb_list (promotionCandidates) and kb_export are counted at their real call sites too', async () => {
        const accounting = createDispatchAccounting();
        const callTool = async (name) => {
            if (name === 'kb_list') return { content: [{ text: JSON.stringify({ results: [] }) }] };
            return { content: [{ text: '{}' }] };
        };
        const kbWork = createKbWorkClient({ callTool, accounting });
        const dispatch = { role: 'reviewer', member: 'm2' };
        await kbWork.promotionCandidates('/repo', dispatch);
        await kbWork.exportBible('/repo', dispatch);

        const rec = accounting.dispatchRecordFor('reviewer', 'm2');
        assert.equal(rec.kbCounts.kb_list, 1);
        assert.equal(rec.kbCounts.kb_export, 1);
    });

    test('a call attempt is counted even when the tool rejects (isError) or throws', async () => {
        const accounting = createDispatchAccounting();
        let mode = 'reject';
        const callTool = async (name) => {
            if (name === 'kb_query' && mode === 'reject') return { isError: true, content: [{ text: 'nope' }] };
            if (name === 'kb_query' && mode === 'throw') throw new Error('transport down');
            return { content: [{ text: '{}' }] };
        };
        const kbWork = createKbWorkClient({ callTool, accounting });
        const dispatch = { role: 'doer', member: 'm3' };

        await kbWork.relevantKnowledge('/repo', ['term'], dispatch);
        assert.equal(accounting.dispatchRecordFor('doer', 'm3').kbCounts.kb_query, 1, 'a rejected call still counts as an attempt');

        mode = 'throw';
        await kbWork.relevantKnowledge('/repo', ['term'], dispatch);
        assert.equal(accounting.dispatchRecordFor('doer', 'm3').kbCounts.kb_query, 2, 'a throwing call still counts as an attempt');
    });

    test('(role, member) records accumulate across repeated dispatches of the same pair, keyed exactly as AC1 names', async () => {
        const accounting = createDispatchAccounting();
        const callTool = async () => ({ content: [{ text: JSON.stringify({ l1_results: [] }) }] });
        const kbWork = createKbWorkClient({ callTool, accounting });
        const dispatch = { role: 'doer', member: 'm4' };

        await kbWork.relevantKnowledge('/repo', ['a'], dispatch);
        await kbWork.relevantKnowledge('/repo', ['b'], dispatch);

        assert.equal(accounting.dispatchRecordFor('doer', 'm4').kbCounts.kb_query, 2);
        assert.equal(accounting.dispatchRecords().length, 1, 'one record per (role, member), not one per call');
    });
});

describe('createDispatchAccounting: code_* NOT-OBSERVABLE marker (AC2, AC3)', () => {
    test('every dispatch record carries the named marker, never a number, and it is never touched by kb_* calls', async () => {
        const accounting = createDispatchAccounting();
        const callTool = async () => ({ content: [{ text: JSON.stringify({ l1_results: [] }) }] });
        const kbWork = createKbWorkClient({ callTool, accounting });
        const dispatch = { role: 'doer', member: 'm5' };

        const recBefore = accounting.forDispatch(dispatch);
        assert.equal(recBefore.code.status, CODE_CALLS_NOT_OBSERVABLE);
        assert.notEqual(typeof recBefore.code.status, 'number');

        await kbWork.relevantKnowledge('/repo', ['x'], dispatch);
        const recAfter = accounting.dispatchRecordFor('doer', 'm5');
        assert.equal(recAfter.code.status, CODE_CALLS_NOT_OBSERVABLE, 'a kb_* call must never turn the marker into a count');
    });

    test('preflightCodeOutcomeFor reads the ONE real engine-visible code signal per member from the same store', () => {
        const accounting = createDispatchAccounting();
        accounting.setPreflightRecords([
            {
                member: 'alice',
                repoPath: '/r/alice',
                remoteUrl: null,
                mcpScope: null,
                kbEntryCount: 3,
                checks: { index: { check: 'index', outcome: 'analyze-started' }, kb: { check: 'kb', outcome: 'ok' }, code: { check: 'code', outcome: 'index-not-ready' } },
                warnings: [],
            },
        ]);
        assert.equal(accounting.preflightCodeOutcomeFor('alice'), 'index-not-ready');
        assert.equal(accounting.preflightCodeOutcomeFor('unknown-member'), null, 'a member with no preflight record reads as null, not a fabricated outcome');
    });
});

describe('createDispatchAccounting: capture kept vs rejected, cause retained (AC4)', () => {
    test('a kept capture is recorded with outcome "kept"', async () => {
        const accounting = createDispatchAccounting();
        const callTool = async () => ({ content: [{ text: '{}' }] });
        const kbWork = createKbWorkClient({ callTool, accounting });
        const result = {
            kb_captures: [{
                type: 'knowledge', title: 'T1', summary: 'S', content: 'C', source_files: ['a.ts'],
            }],
        };
        await kbWork.apply('doer', '/repo', result, { member: 'm6' });
        const rec = accounting.dispatchRecordFor('doer', 'm6');
        assert.equal(rec.captureOutcomes.length, 1);
        assert.equal(rec.captureOutcomes[0].outcome, 'kept');
        assert.equal(rec.captureOutcomes[0].title, 'T1');
    });

    test('an isError-rejected capture is recorded "rejected" with its cause, and does not vanish into the count', async () => {
        const accounting = createDispatchAccounting();
        const callTool = async () => ({ isError: true, content: [{ text: 'zod validation failed' }] });
        const kbWork = createKbWorkClient({ callTool, accounting });
        const result = {
            kb_captures: [{
                type: 'knowledge', title: 'T2', summary: 'S', content: 'C', source_files: ['a.ts'],
            }],
        };
        const { captured } = await kbWork.apply('doer', '/repo', result, { member: 'm7' });
        assert.equal(captured, 0);
        const rec = accounting.dispatchRecordFor('doer', 'm7');
        assert.equal(rec.captureOutcomes.length, 1, 'the rejected capture must still be recorded, not dropped');
        assert.equal(rec.captureOutcomes[0].outcome, 'rejected');
        assert.match(rec.captureOutcomes[0].cause, /zod validation failed/);
        assert.equal(rec.captureOutcomes[0].source, 'isError');
    });

    test('a throwing kb_capture call is ALSO recorded "rejected" with its cause (the second path AC4 requires)', async () => {
        const accounting = createDispatchAccounting();
        const callTool = async () => { throw new Error('transport reset'); };
        const kbWork = createKbWorkClient({ callTool, accounting });
        const result = {
            kb_captures: [{
                type: 'knowledge', title: 'T3', summary: 'S', content: 'C', source_files: ['a.ts'],
            }],
        };
        const { captured } = await kbWork.apply('doer', '/repo', result, { member: 'm8' });
        assert.equal(captured, 0);
        const rec = accounting.dispatchRecordFor('doer', 'm8');
        assert.equal(rec.captureOutcomes.length, 1);
        assert.equal(rec.captureOutcomes[0].outcome, 'rejected');
        assert.match(rec.captureOutcomes[0].cause, /transport reset/);
        assert.equal(rec.captureOutcomes[0].source, 'throw');
    });
});

describe('createDispatchAccounting: recording is best-effort and non-fatal (AC6)', () => {
    test('a broken accounting object never fails the kb_* call it was merely counting', async () => {
        const brokenAccounting = {
            forDispatch() { throw new Error('accounting is on fire'); },
            recordKbCall() { throw new Error('also on fire'); },
            recordCaptureOutcome() { throw new Error('still on fire'); },
        };
        const callTool = async () => ({ content: [{ text: JSON.stringify({ l1_results: [{ id: 'e1' }] }) }] });
        const kbWork = createKbWorkClient({ callTool, accounting: brokenAccounting });
        const out = await kbWork.relevantKnowledge('/repo', ['term'], { role: 'doer', member: 'm9' });
        assert.equal(out.length, 1, 'the real kb_query result must still come back despite a broken accounting object');
    });

    test('a null/undefined dispatch record is a silent no-op for every mutator', () => {
        const accounting = createDispatchAccounting();
        assert.doesNotThrow(() => accounting.recordKbCall(null, 'kb_query'));
        assert.doesNotThrow(() => accounting.recordCaptureOutcome(undefined, { title: 't', outcome: 'kept' }));
    });

    test('setPreflightRecords degrades to an empty list for non-array input rather than throwing', () => {
        const accounting = createDispatchAccounting();
        assert.doesNotThrow(() => accounting.setPreflightRecords(null));
        assert.deepEqual(accounting.preflightRecords(), []);
        assert.doesNotThrow(() => accounting.setPreflightRecords('not-an-array'));
        assert.deepEqual(accounting.preflightRecords(), []);
    });
});

describe('createDispatchAccounting: preflight readback is the SAME structured store (AC5)', () => {
    test('setPreflightRecords/preflightRecords carry the records unchanged -- no field renamed, dropped or invented', () => {
        const accounting = createDispatchAccounting();
        const records = [
            {
                member: 'bob', repoPath: '/r/bob', remoteUrl: 'https://example.invalid/bob.git',
                mcpScope: { scoped: true }, kbEntryCount: 5,
                checks: { index: { outcome: 'analyze-started' }, kb: { outcome: 'ok' }, code: { outcome: 'ok' } },
                warnings: [],
            },
        ];
        accounting.setPreflightRecords(records);
        assert.deepEqual(accounting.preflightRecords(), records);
    });
});
