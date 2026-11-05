// D5 report half: the sprint analysis gets a "Knowledge bank this sprint"
// section computed by the engine from the per-dispatch records -- pushed vs
// cited per role, captures by trigger, promoted/rejected/wrong counts, and
// entries cited by more than one dispatch -- and a one-line none statement
// when there are no records.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeBankAggregates, formatKnowledgeBankSection, buildAnalysisText } from '../fleet-sprint/sprint-report.mjs';

const rec = (index, role, fields) => ({
    index, member: 'm1', role, label: null, startedAt: 'a', endedAt: 'b', kb: 0, code: 0, reason: null, ...fields,
});

const RECORDS = [
    rec(1, 'doer', {
        pushed: { ids: ['kb-a', 'kb-b', 'kb-c'], bytes: 900 }, kb_used: ['kb-a', 'kb-b'], kb_wrong: [],
        captures: [{ title: 'cap one title', trigger: 'hidden-invariant' }, { title: 'cap two title', trigger: 'test-failure' }],
        rejects: [{ title: 'bad capture', rule: 'trigger', reason: 'x' }], promoted: [],
    }),
    rec(2, 'doer', {
        pushed: { ids: ['kb-a', 'kb-d'], bytes: 500 }, kb_used: ['kb-a'], kb_wrong: ['kb-d'],
        captures: [{ title: 'cap three title', trigger: 'hidden-invariant' }], rejects: [], promoted: [],
    }),
    rec(3, 'reviewer', {
        pushed: { ids: ['kb-a', 'kb-b'], bytes: 700 }, kb_used: ['kb-b'], kb_wrong: [],
        captures: [], rejects: [{ title: 'another bad', rule: 'first-person', reason: 'y' }], promoted: ['kb-new-1', 'kb-new-2'],
    }),
    // A record from before the KB fields existed: counts toward its role's dispatches only.
    rec(4, 'planner', {}),
];

describe('Knowledge bank this sprint', () => {
    test('aggregates: pushed vs cited per role', () => {
        const a = knowledgeBankAggregates(RECORDS);
        const doer = a.roles.find((r) => r.role === 'doer');
        assert.deepEqual(doer, { role: 'doer', dispatches: 2, pushed: 5, pushedBytes: 1400, cited: 3, wrong: 1 });
        const reviewer = a.roles.find((r) => r.role === 'reviewer');
        assert.deepEqual(reviewer, { role: 'reviewer', dispatches: 1, pushed: 2, pushedBytes: 700, cited: 1, wrong: 0 });
        const planner = a.roles.find((r) => r.role === 'planner');
        assert.deepEqual(planner, { role: 'planner', dispatches: 1, pushed: 0, pushedBytes: 0, cited: 0, wrong: 0 });
    });

    test('aggregates: captures by trigger', () => {
        assert.deepEqual(knowledgeBankAggregates(RECORDS).capturesByTrigger, { 'hidden-invariant': 2, 'test-failure': 1 });
    });

    test('aggregates: promoted, rejected and wrong counts', () => {
        const a = knowledgeBankAggregates(RECORDS);
        assert.equal(a.promoted, 2);
        assert.equal(a.rejected, 2);
        assert.equal(a.wrong, 1);
    });

    test('aggregates: entries cited by more than one dispatch', () => {
        assert.deepEqual(knowledgeBankAggregates(RECORDS).multiplyCited, [
            { id: 'kb-a', dispatches: 2 },
            { id: 'kb-b', dispatches: 2 },
        ]);
    });

    test('the rendered section carries every aggregate', () => {
        const text = formatKnowledgeBankSection(RECORDS).join('\n');
        assert.match(text, /^## Knowledge bank this sprint$/m);
        assert.match(text, /- doer: 2 dispatch\(es\), pushed 5 entr\(ies\) \(1400 bytes\), cited 3, wrong 1\./);
        assert.match(text, /- reviewer: 1 dispatch\(es\), pushed 2 entr\(ies\) \(700 bytes\), cited 1, wrong 0\./);
        assert.match(text, /Captures by trigger: hidden-invariant 2, test-failure 1\./);
        assert.match(text, /Promoted: 2\. Rejected \(captures refused by the engine\): 2\. Wrong \(kb_wrong reports\): 1\./);
        assert.match(text, /Entries cited by more than one dispatch: kb-a \(2 dispatches\), kb-b \(2 dispatches\)\./);
    });

    test('no records: a one-line none statement, not an empty table', () => {
        for (const none of [[], null, undefined]) {
            const lines = formatKnowledgeBankSection(none);
            assert.deepEqual(lines.filter((l) => l && !l.startsWith('## ')).length, 1, JSON.stringify(lines));
            assert.match(lines.join('\n'), /No dispatch was recorded this sprint/);
            assert.doesNotMatch(lines.join('\n'), /^- /m);
        }
    });

    test('the analysis text includes the section', () => {
        const text = buildAnalysisText({
            targetIssues: ['x'], branch: 'b', baseBranch: 'main', cyclesRun: 1,
            closedCountHistory: [], highWaterClosedCount: 0, deployFailures: [], integFailures: [], rejectedNewTasks: [],
            finalVerdictResult: { verdict: 'PASS' }, finalClosedCount: 0, finalOpenAtGoalCount: 0,
            dispatchToolCalls: RECORDS,
        });
        assert.match(text, /## Knowledge bank this sprint/);
        assert.match(text, /Entries cited by more than one dispatch: kb-a/);
    });
});
