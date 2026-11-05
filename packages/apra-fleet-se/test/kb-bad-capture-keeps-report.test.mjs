import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerdict } from '../fleet-sprint/contracts.mjs';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
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
    });
}
