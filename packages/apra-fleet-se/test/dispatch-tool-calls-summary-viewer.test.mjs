import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchAccounting, DISPATCH_TOOL_CALLS_STATE_NAMESPACE, UNKNOWN_COUNT } from '../fleet-sprint/dispatch-accounting.mjs';
import { buildAnalysisText } from '../fleet-sprint/sprint-report.mjs';
import { renderKbCodeIntelHtml } from '../fleet-sprint/viewer-extensions.mjs';

// One accounting run (fake memberCall returning before/after session_stats
// snapshots, one read failing), consumed by BOTH outputs: the sprint summary
// text and the viewer tab. Both must show the same per-member, per-dispatch
// numbers, and the failed read as unknown (never 0) in both.

const SINCE = '2026-10-01T00:00:00.000Z';
const MEMBERS = {
    alpha: { id: 'id-alpha', name: 'alpha', type: 'remote' },
    beta: { id: 'id-beta', name: 'beta', type: 'local' },
};
const stats = (kb, code) => ({ content: [{ type: 'text', text: JSON.stringify({ member_id: 'x', since: SINCE, kb, code, total: kb + code, tools: {} }) }] });

/** Cell texts of every <tr> of the viewer's per-dispatch table. */
function viewerDispatchRows(html) {
    const m = /<table data-kb-panel-dispatches="true"[^>]*>(.*?)<\/table>/.exec(html);
    assert.ok(m, 'viewer per-dispatch table');
    return [...m[1].matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].slice(1)
        .map((r) => [...r[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1]));
}

test('the sprint summary and the viewer tab show the same calls per member per dispatch, unknown as unknown', async () => {
    const queues = {
        'id-alpha': [stats(10, 4), stats(13, 5), stats(13, 5), stats(13, 7)],
        'id-beta': [stats(0, 0), new Error('member unreachable')],
    };
    const memberCallLog = [];
    const memberCall = async (member, tool, args) => {
        memberCallLog.push({ id: member.id, tool, args });
        const next = queues[member.id].shift();
        if (next instanceof Error) throw next;
        return next;
    };
    const published = [];
    const store = [];
    const acct = createDispatchAccounting({
        memberCall,
        memberOf: (n) => MEMBERS[n] || null,
        store,
        publishState: (ns, data) => published.push({ ns, data }),
    });
    await acct.around({ memberName: 'alpha', role: 'doer' }, async () => {});
    await acct.around({ memberName: 'beta', role: 'reviewer' }, async () => {});
    await acct.around({ memberName: 'alpha', role: 'doer' }, async () => {});

    assert.ok(memberCallLog.every((c) => c.tool === 'session_stats'), 'every read is session_stats via memberCall');

    // Summary text.
    const text = buildAnalysisText({
        targetIssues: ['X-1'], branch: 'feat/x', baseBranch: 'main', cyclesRun: 1,
        closedCountHistory: [1], highWaterClosedCount: 1, deployFailures: [], integFailures: [], rejectedNewTasks: [],
        finalVerdictResult: { verdict: 'APPROVED', notes: '' }, finalClosedCount: 1, finalOpenAtGoalCount: 0,
        dispatchToolCalls: store,
    });
    const summary = text.split('\n').filter((l) => l.startsWith('- Dispatch '))
        .map((l) => /^- Dispatch (\d+): (\S+) on member '([^']+)' -- kb_\* calls: (\S+), code_\* calls: (\S+?)[.( ]/.exec(l).slice(1));
    assert.deepEqual(summary, [
        ['1', 'doer', 'alpha', '3', '1'],
        ['2', 'reviewer', 'beta', 'unknown', 'unknown'],
        ['3', 'doer', 'alpha', '0', '2'],
    ]);

    // Viewer tab, from the payload the engine actually published.
    const last = published[published.length - 1];
    assert.equal(last.ns, DISPATCH_TOOL_CALLS_STATE_NAMESPACE);
    const viewer = viewerDispatchRows(renderKbCodeIntelHtml(last.data))
        .map(([index, member, role, , kb, code]) => [index, role, member, kb, code]);
    assert.deepEqual(viewer, summary, 'the viewer tab renders the same numbers as the summary');
    assert.equal(store[1].kb, UNKNOWN_COUNT);
});
