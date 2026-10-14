import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    createDispatchAccounting,
    parseSessionStats,
    snapshotDelta,
    memberTotals,
    formatDispatchToolCalls,
    UNKNOWN_COUNT,
    DISPATCH_TOOL_CALLS_STATE_NAMESPACE,
} from '../fleet-sprint/dispatch-accounting.mjs';
import { buildAnalysisText } from '../fleet-sprint/sprint-report.mjs';
import { createSprintState } from '../fleet-sprint/sprint-state.mjs';

// Per-dispatch kb_*/code_* call accounting from session_stats snapshots read
// through an injected (fake) memberCall. The fake records every call so the
// tests can prove the reads go through memberCall AS the member -- there is no
// FULL-session callTool anywhere in createDispatchAccounting's dependencies.

const MEMBERS = {
    alpha: { id: 'id-alpha', name: 'alpha', type: 'remote' },
    beta: { id: 'id-beta', name: 'beta', type: 'local' },
};
const SINCE = '2026-10-01T00:00:00.000Z';

function statsResult(kb, code, since = SINCE) {
    return { content: [{ type: 'text', text: JSON.stringify({ member_id: 'x', since, kb, code, total: kb + code, tools: {} }) }] };
}

/** A fake memberCall serving a queue of session_stats answers per member id. */
function fakeMemberCall(queues) {
    const calls = [];
    const memberCall = async (member, tool, args) => {
        calls.push({ member, tool, args });
        const q = queues[member.id];
        const next = q && q.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('no answer queued');
        return next;
    };
    return { calls, memberCall };
}

const fixedNow = () => '2026-10-01T12:00:00.000Z';

function baseAnalysisArgs(extra = {}) {
    return {
        targetIssues: ['X-1'], branch: 'feat/x', baseBranch: 'main', cyclesRun: 1,
        closedCountHistory: [1], highWaterClosedCount: 1,
        deployFailures: [], integFailures: [], rejectedNewTasks: [],
        finalVerdictResult: { verdict: 'APPROVED', notes: '' },
        finalClosedCount: 1, finalOpenAtGoalCount: 0,
        ...extra,
    };
}

describe('session_stats snapshot parsing and deltas', () => {
    test('parses an MCP text result and a plain object; rejects malformed snapshots', () => {
        assert.deepEqual(parseSessionStats(statsResult(3, 2)), { since: SINCE, kb: 3, code: 2 });
        assert.deepEqual(parseSessionStats({ since: SINCE, kb: 0, code: 0 }), { since: SINCE, kb: 0, code: 0 });
        assert.equal(parseSessionStats({ content: [{ text: 'not json' }] }), null);
        assert.equal(parseSessionStats({ isError: true, content: [{ text: '{"since":"a","kb":1,"code":1}' }] }), null);
        assert.equal(parseSessionStats({ since: SINCE, kb: -1, code: 0 }), null);
        assert.equal(parseSessionStats({ kb: 1, code: 1 }), null);
        assert.equal(parseSessionStats(null), null);
    });

    test('delta is after - before; a missing snapshot, a changed since or a negative delta is unknown', () => {
        const b = { since: SINCE, kb: 2, code: 1 };
        assert.deepEqual(snapshotDelta(b, { since: SINCE, kb: 5, code: 1 }), { kb: 3, code: 0, reason: null });
        assert.equal(snapshotDelta(null, b).kb, UNKNOWN_COUNT);
        assert.equal(snapshotDelta(b, null).code, UNKNOWN_COUNT);
        assert.equal(snapshotDelta(b, { since: 'later', kb: 9, code: 9 }).kb, UNKNOWN_COUNT);
        assert.equal(snapshotDelta(b, { since: SINCE, kb: 1, code: 1 }).kb, UNKNOWN_COUNT);
    });
});

describe('createDispatchAccounting', () => {
    test('records calls per member per dispatch from before/after snapshots read through memberCall', async () => {
        const { calls, memberCall } = fakeMemberCall({
            'id-alpha': [statsResult(1, 0), statsResult(4, 2), statsResult(4, 2), statsResult(4, 3)],
            'id-beta': [statsResult(0, 0), statsResult(0, 0)],
        });
        const store = [];
        const published = [];
        const acct = createDispatchAccounting({
            memberCall,
            memberOf: (n) => MEMBERS[n] || null,
            store,
            publishState: (ns, payload) => published.push({ ns, payload }),
            now: fixedNow,
        });

        const r1 = await acct.around({ memberName: 'alpha', role: 'doer', label: 'Doer C1' }, async () => 'one');
        await acct.around({ memberName: 'beta', role: 'reviewer' }, async () => 'two');
        await acct.around({ memberName: 'alpha', role: 'doer' }, async () => 'three');

        assert.equal(r1, 'one', "the dispatch's own result passes through");
        assert.deepEqual(store.map((r) => [r.index, r.member, r.role, r.kb, r.code]), [
            [1, 'alpha', 'doer', 3, 2],
            [2, 'beta', 'reviewer', 0, 0],
            [3, 'alpha', 'doer', 0, 1],
        ]);
        assert.equal(store[0].label, 'Doer C1');
        // Every read went through memberCall, as the dispatched member, for session_stats.
        assert.equal(calls.length, 6);
        for (const c of calls) {
            assert.equal(c.tool, 'session_stats');
            assert.deepEqual(c.args, {});
        }
        assert.deepEqual(calls.map((c) => c.member.id), ['id-alpha', 'id-alpha', 'id-beta', 'id-beta', 'id-alpha', 'id-alpha']);
        // Published to the viewer after every dispatch.
        assert.equal(published.length, 3);
        assert.equal(published[2].ns, DISPATCH_TOOL_CALLS_STATE_NAMESPACE);
        assert.equal(published[2].payload.dispatches.length, 3);
    });

    test('a failed read yields unknown, never 0, and the dispatch still runs', async () => {
        const { memberCall } = fakeMemberCall({
            'id-alpha': [new Error('member unreachable'), statsResult(5, 5)],
            'id-beta': [statsResult(1, 1), { content: [{ text: 'garbage' }] }],
        });
        const acct = createDispatchAccounting({ memberCall, memberOf: (n) => MEMBERS[n] || null, now: fixedNow });
        let ran = 0;
        await acct.around({ memberName: 'alpha', role: 'doer' }, async () => { ran++; });
        await acct.around({ memberName: 'beta', role: 'doer' }, async () => { ran++; });
        assert.equal(ran, 2);
        const [a, b] = acct.records();
        assert.equal(a.kb, UNKNOWN_COUNT);
        assert.equal(a.code, UNKNOWN_COUNT);
        assert.match(a.reason, /before/);
        assert.equal(b.kb, UNKNOWN_COUNT);
        assert.equal(b.code, UNKNOWN_COUNT);
        assert.match(b.reason, /after/);
    });

    test('a member server restart between snapshots (since changed) is unknown', async () => {
        const { memberCall } = fakeMemberCall({ 'id-alpha': [statsResult(7, 7), statsResult(1, 0, '2026-10-01T06:00:00.000Z')] });
        const acct = createDispatchAccounting({ memberCall, memberOf: (n) => MEMBERS[n] || null, now: fixedNow });
        await acct.around({ memberName: 'alpha' }, async () => {});
        assert.equal(acct.records()[0].kb, UNKNOWN_COUNT);
        assert.match(acct.records()[0].reason, /restarted/);
    });

    test('no memberCall or no member record records unknown without any read', async () => {
        const noCall = createDispatchAccounting({ memberOf: (n) => MEMBERS[n] || null, now: fixedNow });
        await noCall.around({ memberName: 'alpha' }, async () => {});
        assert.equal(noCall.records()[0].kb, UNKNOWN_COUNT);

        const { calls, memberCall } = fakeMemberCall({});
        const noRecord = createDispatchAccounting({ memberCall, memberOf: () => null, now: fixedNow });
        await noRecord.around({ memberName: 'ghost' }, async () => {});
        assert.equal(noRecord.records()[0].code, UNKNOWN_COUNT);
        assert.equal(calls.length, 0);
    });

    test("a failing dispatch is still recorded and its error passes through", async () => {
        const { memberCall } = fakeMemberCall({ 'id-alpha': [statsResult(0, 0), statsResult(2, 0)] });
        const acct = createDispatchAccounting({ memberCall, memberOf: (n) => MEMBERS[n] || null, now: fixedNow });
        await assert.rejects(acct.around({ memberName: 'alpha' }, async () => { throw new Error('dispatch boom'); }), /dispatch boom/);
        assert.equal(acct.records()[0].kb, 2);
    });

    test('a hung read is bounded by the read timeout and recorded unknown', async () => {
        const memberCall = () => new Promise(() => {});
        const acct = createDispatchAccounting({ memberCall, memberOf: (n) => MEMBERS[n] || null, readTimeoutMs: 20, now: fixedNow });
        await acct.around({ memberName: 'alpha' }, async () => {});
        assert.equal(acct.records()[0].kb, UNKNOWN_COUNT);
    });

    test('sprint state carries the dispatchToolCalls store', () => {
        const state = createSprintState({});
        assert.deepEqual(state.dispatchToolCalls, []);
    });
});

describe('sprint summary: calls per member per dispatch', () => {
    const records = [
        { index: 1, member: 'alpha', role: 'doer', label: null, kb: 3, code: 2, reason: null },
        { index: 2, member: 'beta', role: 'reviewer', label: null, kb: UNKNOWN_COUNT, code: UNKNOWN_COUNT, reason: 'after-snapshot read failed' },
        { index: 3, member: 'alpha', role: 'doer', label: null, kb: 0, code: 1, reason: null },
    ];

    test('the analysis text shows each dispatch with its member and counts, and per-member totals', () => {
        const text = buildAnalysisText(baseAnalysisArgs({ dispatchToolCalls: records }));
        assert.match(text, /## KB and code tool calls per member per dispatch/);
        assert.match(text, /Dispatch 1: doer on member 'alpha' -- kb_\* calls: 3, code_\* calls: 2\./);
        assert.match(text, /Dispatch 3: doer on member 'alpha' -- kb_\* calls: 0, code_\* calls: 1\./);
        assert.match(text, /member 'alpha': 2 dispatch\(es\), kb_\* calls: 3, code_\* calls: 3\./);
    });

    test('an unknown count is shown as unknown, never 0 -- per dispatch and in the member total', () => {
        const text = buildAnalysisText(baseAnalysisArgs({ dispatchToolCalls: records }));
        const line = text.split('\n').find((l) => l.includes('Dispatch 2:'));
        assert.match(line, /kb_\* calls: unknown, code_\* calls: unknown \(unknown: after-snapshot read failed\)/);
        assert.doesNotMatch(line, /calls: 0/);
        const total = text.split('\n').find((l) => l.includes("member 'beta':"));
        assert.match(total, /kb_\* calls: unknown, code_\* calls: unknown \(1 dispatch\(es\) with unknown counts\)/);
    });

    test('memberTotals sums known counts and turns any unknown into unknown', () => {
        assert.deepEqual(memberTotals(records).map((t) => [t.member, t.kb, t.code]), [
            ['alpha', 3, 3],
            ['beta', UNKNOWN_COUNT, UNKNOWN_COUNT],
        ]);
    });

    test('no records -> an explicit line; section absent when the caller passes none', () => {
        assert.deepEqual(formatDispatchToolCalls([]), ['No member dispatch was recorded this sprint.']);
        assert.doesNotMatch(buildAnalysisText(baseAnalysisArgs()), /KB and code tool calls/);
    });
});
