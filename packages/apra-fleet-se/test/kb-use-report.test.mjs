// D4 engine half: every role report's kb_used/kb_wrong is read by the
// 'kb-report' postResult step (reportKbUse). Each well-formed kb_wrong item is
// forwarded to kb_feedback through the kb_maintainer queue; a malformed item
// and a kb_feedback failure are logged and never fail the dispatch; a report
// showing no KB query is logged once and never gated.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createKbWorkClient, extractKbUse, reportKbUse, KB_MAINTAINER_CALL } from '../fleet-sprint/kb.mjs';
import { ROLE_POLICIES, POST_RESULT_STEPS } from '../fleet-sprint/role-policies.mjs';
import { selfMaintainer, fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';
import { driveEngineDispatch } from './helpers/dispatch-role-harness.mjs';

const RUNNER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fleet-sprint', 'runner.js'), 'utf8');

const MAINT = { id: 'm-1', name: 'maint', type: 'remote' };

/** Every distinct role persona the engine dispatches (rows without one have no report). */
const PERSONAS = [...new Set(Object.values(ROLE_POLICIES).map((p) => p.agentType).filter(Boolean))];

function client({ calls, logs, memberCall } = {}) {
    return createKbWorkClient({
        maintainers: selfMaintainer(MAINT, ['worker', 'maint']),
        memberCall: memberCall || (async (member, tool, args, opts) => {
            calls.push({ member: member.name, tool, args, opts });
            return {};
        }),
        gPull: async () => {},
        log: (m) => logs.push(m),
    });
}

describe('kb-report is a postResult step of every role row with a persona', () => {
    test('the step is in the vocabulary and the runner implements it with reportKbUse', () => {
        assert.ok(POST_RESULT_STEPS.includes('kb-report'));
        assert.match(RUNNER, /'kb-report': async \(\{ policy, value, member \}\) => reportKbUse\(\{/);
    });

    test('at least the planner, plan-reviewer, doer, reviewer, harvester, deployer and both test runners are covered', () => {
        for (const p of ['planner', 'plan-reviewer', 'doer', 'reviewer', 'harvester', 'deployer', 'integ-test-runner', 'regression-test-runner']) {
            assert.ok(PERSONAS.includes(p), p);
        }
    });

    for (const [name, p] of Object.entries(ROLE_POLICIES)) {
        test(`${name}: ${p.agentType ? 'carries' : 'has no persona, so does not carry'} 'kb-report'`, () => {
            assert.equal(p.postResult.includes('kb-report'), Boolean(p.agentType));
            if (p.secondary) assert.equal(p.secondary.postResult.includes('kb-report'), Boolean(p.agentType));
        });
    }

    test('the engine hands the step the dispatch result and returns its outcome on stepResults', async () => {
        const seen = [];
        const { rec, outcome } = await driveEngineDispatch('harvester', 'main', {
            ctx: { steps: { 'kb-report': (args) => { seen.push(args.value); return { used: ['e-1'], wrong: [] }; } } },
        });
        assert.equal(seen.length, 1);
        assert.ok(rec.steps.some((s) => s.step === 'kb-report'));
        assert.deepEqual(outcome.stepResults['kb-report'], { used: ['e-1'], wrong: [] });
    });
});

describe('extractKbUse', () => {
    test('keeps well-formed items and describes each malformed one', () => {
        const out = extractKbUse({
            kb_used: [{ id: 'u-1', how: 'followed it' }, 'u-2', { id: 7, how: 'x' }],
            kb_wrong: [{ id: 'w-1', reason: 'flag was removed' }, { id: 'w-2' }],
        });
        assert.deepEqual(out.used, [{ id: 'u-1', how: 'followed it' }]);
        assert.deepEqual(out.wrong, [{ id: 'w-1', reason: 'flag was removed' }]);
        assert.equal(out.malformed.length, 3);
    });

    test('absent fields and non-object results are empty, a non-array field is malformed', () => {
        assert.deepEqual(extractKbUse({}), { used: [], wrong: [], malformed: [] });
        assert.deepEqual(extractKbUse(null), { used: [], wrong: [], malformed: [] });
        assert.equal(extractKbUse({ kb_wrong: 'w-1' }).malformed.length, 1);
    });
});

for (const role of PERSONAS) {
    describe(`${role}: kb_wrong reaches kb_feedback`, () => {
        test('exactly one kb_feedback call per well-formed item, with its id and reason, as the maintainer', async () => {
            const calls = [];
            const logs = [];
            const value = {
                notes: 'done',
                kb_used: [{ id: 'u-1', how: 'followed its retry rule' }],
                kb_wrong: [{ id: 'w-1', reason: 'the flag it names was removed' }, { id: 'w-2', reason: 'the path moved' }],
            };
            const out = await reportKbUse({ role, member: 'worker', value, kbWork: client({ calls, logs }), log: (m) => logs.push(m) });
            const feedback = calls.filter((c) => c.tool === 'kb_feedback');
            assert.deepEqual(feedback.map((c) => [c.args.id, c.args.reason]), [
                ['w-1', 'the flag it names was removed'],
                ['w-2', 'the path moved'],
            ]);
            for (const c of feedback) {
                assert.equal(c.member, 'maint');
                assert.deepEqual(c.opts, KB_MAINTAINER_CALL);
                assert.equal(c.args.role, role === 'harvester' ? 'harvest' : role);
            }
            assert.deepEqual(out, { used: ['u-1'], wrong: ['w-1', 'w-2'], malformed: 0, noKbQuery: false });
            assert.ok(logs.some((l) => l.includes('used u-1')), logs.join('\n'));
        });
    });
}

describe('failures are logged and never fail the dispatch', () => {
    test('a malformed kb_wrong item is logged and dropped; the well-formed one next to it is still forwarded', async () => {
        const calls = [];
        const logs = [];
        const out = await reportKbUse({
            role: 'doer',
            member: 'worker',
            value: { status: 'VERIFY', kb_wrong: ['w-bare', { id: 'w-1', reason: 'stale' }] },
            kbWork: client({ calls, logs }),
            log: (m) => logs.push(m),
        });
        assert.deepEqual(calls.filter((c) => c.tool === 'kb_feedback').map((c) => c.args.id), ['w-1']);
        assert.ok(logs.some((l) => l.includes('dropped malformed item') && l.includes('w-bare')), logs.join('\n'));
        assert.equal(out.malformed, 1);
    });

    test('a thrown kb_feedback error is logged and reportKbUse still resolves', async () => {
        const logs = [];
        const kbWork = client({
            logs,
            memberCall: async () => { throw new Error('boom'); },
        });
        const out = await reportKbUse({ role: 'reviewer', member: 'worker', value: { kb_wrong: [{ id: 'w-1', reason: 'r' }] }, kbWork, log: (m) => logs.push(m) });
        assert.deepEqual(out.wrong, ['w-1']);
        assert.ok(logs.some((l) => l.includes('kb_feedback failed for w-1') && l.includes('boom')), logs.join('\n'));
    });

    test('a kb_feedback tool-level refusal (isError) is logged and reportKbUse still resolves', async () => {
        const logs = [];
        const kbWork = client({
            logs,
            memberCall: async () => ({ isError: true, content: [{ type: 'text', text: 'E-MEMBER-VIEW-READ-ONLY' }] }),
        });
        await reportKbUse({ role: 'planner', member: 'worker', value: { kb_wrong: [{ id: 'w-1', reason: 'r' }] }, kbWork, log: (m) => logs.push(m) });
        assert.ok(logs.some((l) => l.includes('kb_feedback rejected for w-1')), logs.join('\n'));
    });

    test('a kbWork.feedback that throws is caught and logged', async () => {
        const logs = [];
        const kbWork = { feedback: async () => { throw new Error('queue exploded'); } };
        const out = await reportKbUse({ role: 'doer', member: 'worker', value: { kb_wrong: [{ id: 'w-1', reason: 'r' }] }, kbWork, log: (m) => logs.push(m) });
        assert.deepEqual(out.wrong, ['w-1']);
        assert.ok(logs.some((l) => l.includes('forwarding failed') && l.includes('queue exploded')), logs.join('\n'));
    });

    test('no maintainer for the member: the items are logged as dropped, nothing is called', async () => {
        const calls = [];
        const logs = [];
        // Two repositories, the member in neither: no own maintainer and no
        // single-maintainer fallback.
        const kbWork = createKbWorkClient({
            maintainers: fakeMaintainerSelector({
                repoOf: { maint: 'example.com/org/a', other: 'example.com/org/b' },
                maintainerOf: { 'example.com/org/a': MAINT, 'example.com/org/b': { id: 'm-2', name: 'other', type: 'remote' } },
            }),
            memberCall: async (m, tool) => { calls.push(tool); return {}; },
            gPull: async () => {},
            log: (m) => logs.push(m),
        });
        assert.deepEqual(await kbWork.feedback('doer', 'stranger', [{ id: 'w-1', reason: 'r' }]), { forwarded: 0, dropped: 1 });
        assert.deepEqual(calls, []);
        assert.ok(logs.some((l) => l.includes('kb_feedback item(s) dropped')), logs.join('\n'));
    });
});

describe('a dispatch with no KB query is logged once and never gated', () => {
    test('toolUse.kb other than used: one log line naming role and member', async () => {
        const logs = [];
        const out = await reportKbUse({ role: 'doer', member: 'worker', value: { status: 'VERIFY', toolUse: { kb: 'unavailable', code: 'used' } }, kbWork: client({ calls: [], logs }), log: (m) => logs.push(m) });
        assert.equal(out.noKbQuery, true);
        const lines = logs.filter((l) => l.includes('no KB query reported'));
        assert.equal(lines.length, 1);
        assert.match(lines[0], /doer on worker/);
        assert.match(lines[0], /never gated/);
    });

    test('no toolUse and no kb_used/kb_wrong: logged; toolUse.kb used: not logged', async () => {
        const logs = [];
        const a = await reportKbUse({ role: 'deployer', member: 'worker', value: { deployed: true, notes: 'ok' }, log: (m) => logs.push(m) });
        assert.equal(a.noKbQuery, true);
        const b = await reportKbUse({ role: 'doer', member: 'worker', value: { toolUse: { kb: 'used', code: 'used' } }, log: (m) => logs.push(m) });
        assert.equal(b.noKbQuery, false);
        assert.equal(logs.filter((l) => l.includes('no KB query reported')).length, 1);
    });

    test('a schema-less role report delivered as text (the planner) is parsed for kb_wrong', async () => {
        const calls = [];
        const logs = [];
        const report = { status: 'OK', notes: 'planned', kb_wrong: [{ id: 'w-p', reason: 'module was renamed' }] };
        const kbWork = client({ calls, logs });
        const plain = await reportKbUse({ role: 'planner', member: 'worker', value: JSON.stringify(report), kbWork, log: (m) => logs.push(m) });
        const fenced = await reportKbUse({ role: 'planner', member: 'worker', value: `Plan done.\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`, kbWork, log: (m) => logs.push(m) });
        assert.deepEqual(plain.wrong, ['w-p']);
        assert.deepEqual(fenced.wrong, ['w-p']);
        assert.equal(calls.filter((c) => c.tool === 'kb_feedback').length, 2);
        const prose = await reportKbUse({ role: 'planner', member: 'worker', value: 'Planned three tasks.', kbWork, log: (m) => logs.push(m) });
        assert.equal(prose.noKbQuery, true, 'text with no JSON report is a report with no KB fields');
    });

    test('a null or engine-fabricated result is skipped silently', async () => {
        const logs = [];
        await reportKbUse({ role: 'reviewer', member: 'worker', value: null, log: (m) => logs.push(m) });
        await reportKbUse({ role: 'reviewer', member: 'worker', value: { dispatchFailed: true }, log: (m) => logs.push(m) });
        assert.deepEqual(logs, []);
    });

    test('through the engine: a zero-query result still succeeds with one dispatch (no retry)', async () => {
        const logs = [];
        const { rec, outcome } = await driveEngineDispatch('deployer', 'main', {
            opts: { prompt: 'DEPLOYER PROMPT sprint-self-id-sentinel' },
            responses: [{ deployed: true, notes: 'deployed' }],
            ctx: {
                steps: {
                    'sprint-self-id-in-prompt': () => undefined,
                    'kb-report': ({ policy, value, member }) => reportKbUse({ role: policy.agentType, member, value, log: (m) => logs.push(m) }),
                },
            },
        });
        assert.equal(rec.dispatches.length, 1);
        assert.ok(outcome.stepResults['kb-report'].noKbQuery);
        assert.equal(logs.filter((l) => l.includes('no KB query reported')).length, 1);
    });
});
