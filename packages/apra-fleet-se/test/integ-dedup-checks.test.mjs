import { test, describe } from 'node:test';
import assert from 'node:assert';
import Ajv from 'ajv';
import { flagUnverifiedBugDedup } from '../fleet-sprint/abort.mjs';
import { integReport } from '../fleet-sprint/contracts.mjs';
import { ROLE_POLICIES } from '../fleet-sprint/role-policies.mjs';

// The integ-test-runner files beads directly, so dedup evidence is enforced at
// output-validation time: a required dedupChecks array in the schema, and a
// post-parse cross-check that flags (never fails) filed bugs without a
// no-overlap entry carrying a non-blank query.

const validate = new Ajv({ allErrors: true, strict: false }).compile(integReport);
const BASE = { featuresClosed: 0, issuesCreated: 1, passed: false, summary: 's' };
const ok = (id) => ({ beadId: id, query: 'search open backlog', candidateIds: [], verdict: 'no-overlap' });

function harness() {
    const calls = [];
    const logs = [];
    const command = async (cmd) => {
        calls.push(cmd);
        return /^node -e /.test(cmd) ? '/tmp/staged-note.txt' : '';
    };
    return { calls, logs, command, log: (m) => logs.push(m) };
}

describe('integ-test-runner schema', () => {
    test('a result with bugsFiled but no dedupChecks fails validation naming dedupChecks', () => {
        assert.strictEqual(validate({ ...BASE, bugsFiled: ['X'] }), false);
        assert.ok(validate.errors.some((e) => e.params && e.params.missingProperty === 'dedupChecks'), JSON.stringify(validate.errors));
    });

    test('empty dedupChecks is valid when nothing was filed; a full entry is valid', () => {
        assert.strictEqual(validate({ ...BASE, bugsFiled: [], dedupChecks: [] }), true);
        assert.strictEqual(validate({ ...BASE, bugsFiled: ['X'], dedupChecks: [ok('X')] }), true);
    });

    test("a verdict outside the enum is rejected", () => {
        assert.strictEqual(validate({ ...BASE, bugsFiled: ['X'], dedupChecks: [{ ...ok('X'), verdict: 'dup' }] }), false);
    });

    test('the synthesized fallback result stays schema-valid', () => {
        const synth = ROLE_POLICIES['integ-test-runner'].degrade.synthesized;
        assert.ok(Array.isArray(synth.dedupChecks));
        assert.strictEqual(validate({ ...synth, summary: 'degraded' }), true, JSON.stringify(validate.errors));
    });
});

describe('flagUnverifiedBugDedup', () => {
    test('bugsFiled [X, Y] with an entry only for X flags exactly Y (WARN + appended note)', async () => {
        const h = harness();
        const flagged = await flagUnverifiedBugDedup({
            command: h.command, member: 'm', bugsFiled: ['bug-x', 'bug-y'], dedupChecks: [ok('bug-x')], log: h.log,
        });
        assert.deepStrictEqual(flagged, ['bug-y']);
        assert.strictEqual(h.logs.filter((l) => /WARN/.test(l) && /bug-y/.test(l)).length, 1);
        assert.ok(!h.logs.some((l) => /bug-x/.test(l)));
        assert.ok(h.calls.some((c) => /^bd note bug-y --file "/.test(c)));
        assert.ok(!h.calls.some((c) => /bug-x/.test(c)));
        assert.ok(!h.calls.some((c) => /--notes/.test(c)));
        // the note body travels base64-encoded through the staging command
        const stage = h.calls.find((c) => /^node -e /.test(c));
        const b64 = /[A-Za-z0-9+/=]{40,}/.exec(stage);
        assert.ok(b64 && Buffer.from(b64[0], 'base64').toString().startsWith('[dedup-unverified]'));
    });

    test("verdict 'overlap' for a filed id is flagged", async () => {
        const h = harness();
        const flagged = await flagUnverifiedBugDedup({
            command: h.command, member: 'm', bugsFiled: ['bug-x'],
            dedupChecks: [{ ...ok('bug-x'), candidateIds: ['old-1'], verdict: 'overlap' }], log: h.log,
        });
        assert.deepStrictEqual(flagged, ['bug-x']);
        assert.ok(h.logs.some((l) => /overlap/.test(l)));
    });

    test('blank query is flagged; fully covered ids and an empty bugsFiled flag nothing', async () => {
        const h = harness();
        assert.deepStrictEqual(await flagUnverifiedBugDedup({
            command: h.command, member: 'm', bugsFiled: ['bug-x'], dedupChecks: [{ ...ok('bug-x'), query: '  ' }], log: h.log,
        }), ['bug-x']);
        const h2 = harness();
        assert.deepStrictEqual(await flagUnverifiedBugDedup({
            command: h2.command, member: 'm', bugsFiled: ['bug-x'], dedupChecks: [ok('bug-x')], log: h2.log,
        }), []);
        assert.deepStrictEqual(await flagUnverifiedBugDedup({ command: h2.command, member: 'm', bugsFiled: [], dedupChecks: [], log: h2.log }), []);
        assert.deepStrictEqual(h2.calls, []);
    });

    test('a failing note append is logged, not thrown', async () => {
        const logs = [];
        const flagged = await flagUnverifiedBugDedup({
            command: async () => { throw new Error('boom'); }, member: 'm', bugsFiled: ['bug-x'], dedupChecks: [], log: (m) => logs.push(m),
        });
        assert.deepStrictEqual(flagged, ['bug-x']);
        assert.ok(logs.some((l) => /boom/.test(l)));
    });
});
