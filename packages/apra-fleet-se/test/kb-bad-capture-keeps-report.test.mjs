import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerdict } from '../fleet-sprint/contracts.mjs';
import { createKbWorkClient, reportKbUse } from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// A bad capture costs that one capture and never the role's report. Each role's
// report goes through the same two gates a real dispatch does: the ajv report
// schema (validateVerdict), then the engine's per-capture gate (kbWork.apply).

const GOOD = Object.freeze({
    type: 'knowledge',
    title: 'Retry budget is read once at startup',
    summary: 'The retry budget is read once at boot; editing it needs a service restart.',
    trigger: 'hidden-invariant',
    source_files: ['src/retry.ts'],
    symbols: ['loadRetryBudget'],
});

const { trigger: _dropped, ...NO_TRIGGER } = GOOD;

const BAD = [
    ['a missing trigger', { ...NO_TRIGGER, title: 'Capture with no trigger field' }, 'rule trigger'],
    ['an unknown trigger', { ...GOOD, title: 'Capture with an unknown trigger', trigger: 'describes-the-change' }, 'rule trigger'],
    ['content under the minimum', { ...GOOD, title: 'Capture with short content', content: 'too short' }, 'rule length'],
    ['content over the cap', { ...GOOD, title: 'Capture with long content', content: 'c'.repeat(2001) }, 'rule length'],
    ['a title under the minimum', { ...GOOD, title: 'short' }, 'rule length'],
    ['no source files', { ...GOOD, title: 'Capture citing no files', source_files: [] }, 'cites no source files'],
    ['an unknown type', { ...GOOD, title: 'Capture of an unknown type', type: 'nonsense' }, 'unsupported type'],
    ['cues that are not an array', { ...GOOD, title: 'Capture with string cues', recall_cues: 'retry' }, 'rule cues'],
    // The wrong JSON types: the report schema admits every shape under the KB
    // fields, so each of these reaches the per-capture gate and stops there.
    ['type: 42', { ...GOOD, title: 'Capture with a number type', type: 42 }, 'unsupported type'],
    ['type: null', { ...GOOD, title: 'Capture with a null type', type: null }, 'unsupported type'],
    ['title: 42', { ...GOOD, title: 42 }, 'missing title/summary'],
    ['title: null', { ...GOOD, title: null }, 'missing title/summary'],
    ['summary: 42', { ...GOOD, title: 'Capture with a number summary', summary: 42 }, 'missing title/summary'],
    ['trigger: 42', { ...GOOD, title: 'Capture with a number trigger', trigger: 42 }, 'rule trigger'],
    ['trigger: null', { ...GOOD, title: 'Capture with a null trigger', trigger: null }, 'rule trigger'],
    ['symbols: "x"', { ...GOOD, title: 'Capture with string symbols', symbols: 'x' }, 'rule symbols'],
    ['symbols: [1]', { ...GOOD, title: 'Capture with number symbols', symbols: [1] }, 'rule symbols'],
    ['source_files: [1]', { ...GOOD, title: 'Capture with number source files', source_files: [1] }, 'rule source-files'],
    ['source_files: null', { ...GOOD, title: 'Capture with null source files', source_files: null }, 'cites no source files'],
    ['content: {}', { ...GOOD, title: 'Capture with object content', content: {} }, 'rule content'],
    ['recall_cues: [1]', { ...GOOD, title: 'Capture with number cues', recall_cues: [1] }, 'rule cues'],
    ['recall_cues: null', { ...GOOD, title: 'Capture with null cues', recall_cues: null }, 'rule cues'],
    ['error_signatures: null', { ...GOOD, title: 'Capture with null signatures', error_signatures: null }, 'rule cues'],
    ['a null item', null, 'missing title/summary'],
    ['a number item', 42, 'missing title/summary'],
    ['a string item', 'just text', 'missing title/summary'],
    ['an array item', [], 'missing title/summary'],
];

// null on an optional field reads as "not given": the report stands and the
// capture is kept without the field. content is optional by the capture rubric.
const ABSENT = [
    ['content: null', { ...GOOD, title: 'Capture with null content', content: null }, 'content'],
    ['symbols: null', { ...GOOD, title: 'Capture with null symbols', symbols: null }, 'symbols'],
];

const ROLES = [
    ['doerReport', 'doer', { status: 'VERIFY', closedIds: ['T-1'], notes: 'done' }, (r) => assert.equal(r.status, 'VERIFY')],
    ['reviewerVerdict', 'reviewer', { verdict: 'APPROVED', notes: 'looks right', reopenIds: [], newTasks: [] }, (r) => assert.equal(r.verdict, 'APPROVED')],
    ['harvesterReport', 'harvester', { status: 'OK', notes: 'harvested' }, (r) => assert.equal(r.status, 'OK')],
];

function client(calls, logs) {
    return createKbWorkClient({
        maintainers: selfMaintainer({ id: 'm-1', name: 'maint', type: 'remote' }, ['doer', 'reviewer', 'harvester', 'maint']),
        memberCall: async (member, tool, args) => { calls.push({ tool, args }); return {}; },
        gPull: async () => {},
        log: (m) => logs.push(m),
    });
}

for (const [schemaName, role, base, keepsVerdict] of ROLES) {
    describe(`${schemaName}: one bad capture keeps the report`, () => {
        for (const [name, bad, rule] of BAD) {
            test(`${name}: the report validates, keeps its verdict and its other captures`, async () => {
                const report = { ...base, kb_captures: [bad, GOOD] };
                const checked = validateVerdict(schemaName, report);
                assert.equal(checked.valid, true, JSON.stringify(checked.errors));
                keepsVerdict(report);

                const calls = [];
                const logs = [];
                const out = await client(calls, logs).apply(role, role, report);
                assert.equal(out.captured, 1, 'the good capture is kept');
                assert.equal(out.refused, 1, 'only the bad capture is refused');
                const captures = calls.filter((c) => c.tool === 'kb_capture');
                assert.deepEqual(captures.map((c) => c.args.title), [GOOD.title]);
                assert.ok(logs.some((l) => l.includes('refused') && l.includes(rule)), logs.join('\n'));
            });
        }

        for (const [name, shape, field] of ABSENT) {
            test(`${name}: the report validates and the capture is kept without the field`, async () => {
                const report = { ...base, kb_captures: [shape, GOOD] };
                const checked = validateVerdict(schemaName, report);
                assert.equal(checked.valid, true, JSON.stringify(checked.errors));
                keepsVerdict(report);

                const calls = [];
                const logs = [];
                const out = await client(calls, logs).apply(role, role, report);
                assert.equal(out.captured, 2);
                assert.equal(out.refused, 0);
                const sent = calls.filter((c) => c.tool === 'kb_capture')[0].args;
                assert.ok(sent[field] === undefined || (Array.isArray(sent[field]) && sent[field].length === 0), JSON.stringify(sent));
            });
        }

        // kb_used / kb_wrong: each bad item is dropped and logged by the
        // engine's report step; the well-formed items and the verdict stand.
        test('bad kb_used and kb_wrong items keep the report and their well-formed neighbours', async () => {
            const report = {
                ...base,
                kb_used: [{ id: 'kb-good', how: 'relied on it' }, { id: 5, how: null }, { id: 'kb-x', how: null }, null, 42, 'text', []],
                kb_wrong: [{ id: 'kb-bad', reason: 'proved wrong' }, { id: 'x', reason: {} }, { id: null, reason: 'r' }, null, 42],
            };
            const checked = validateVerdict(schemaName, report);
            assert.equal(checked.valid, true, JSON.stringify(checked.errors));
            keepsVerdict(report);

            const logs = [];
            const forwarded = [];
            const use = await reportKbUse({
                role, member: role, value: report, log: (m) => logs.push(m),
                kbWork: { feedback: async (_role, _member, items) => { forwarded.push(...items); } },
            });
            assert.deepEqual(use.used, ['kb-good']);
            assert.deepEqual(use.wrong, ['kb-bad']);
            assert.equal(use.malformed, 10);
            assert.deepEqual(forwarded.map((w) => w.id), ['kb-bad']);
            assert.equal(logs.filter((l) => l.includes('dropped malformed item')).length, 10, logs.join('\n'));
        });

        for (const field of ['kb_captures', 'kb_used', 'kb_wrong']) {
            for (const [label, value] of [['a string', 'abc'], ['null', null], ['a number', 7], ['an object', { id: 'x' }]]) {
                test(`${field} as ${label}: the report validates and nothing is applied`, async () => {
                    const report = { ...base, [field]: value };
                    const checked = validateVerdict(schemaName, report);
                    assert.equal(checked.valid, true, JSON.stringify(checked.errors));
                    keepsVerdict(report);
                    const calls = [];
                    const out = await client(calls, []).apply(role, role, report);
                    assert.equal(out.captured, 0);
                    assert.equal(calls.filter((c) => c.tool === 'kb_capture').length, 0);
                });
            }
        }
    });
}
