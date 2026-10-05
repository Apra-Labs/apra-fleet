import { test, describe } from 'node:test';
import assert from 'node:assert';
import Ajv from 'ajv';
import { validateNewTask, validateDedupCheck, validateNewTaskWithDedup } from '../fleet-sprint/abort.mjs';
import { reviewerVerdict, finalVerdict } from '../fleet-sprint/contracts.mjs';

// Dedup gate for reviewer-proposed newTasks: every item carries
// dedupCheck { query, candidateIds, verdict }; enforcement is per item in
// validateNewTask, 'overlap' merges into the existing open bead instead of
// creating a duplicate.

const BASE = { title: 'Add retry logic', description: 'Retry 401s up to 3x.', priority: 'P2' };
const NO_OVERLAP = { query: 'retry 401', candidateIds: [], verdict: 'no-overlap' };

function makeCommand(beads) {
    const calls = [];
    const command = async (cmd, opts) => {
        calls.push(cmd);
        const m = /^bd show (\S+) --json$/.exec(cmd);
        if (m) {
            if (!beads[m[1]]) throw new Error('no issues found matching the provided IDs');
            return JSON.stringify([{ id: m[1], status: beads[m[1]] }]);
        }
        if (/^node -e /.test(cmd)) return '/tmp/staged-body.txt';
        return '';
    };
    return { command, calls };
}

describe('validateNewTask dedupCheck enforcement', () => {
    test('missing dedupCheck is rejected with a reason naming dedupCheck', () => {
        const r = validateNewTask(BASE);
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /dedupCheck/);
    });

    test('malformed dedupCheck (blank query, bad verdict, non-array candidateIds) is rejected', () => {
        for (const bad of [
            { ...NO_OVERLAP, query: '   ' },
            { ...NO_OVERLAP, query: undefined },
            { ...NO_OVERLAP, verdict: 'maybe' },
            { ...NO_OVERLAP, candidateIds: 'abc-1' },
            { ...NO_OVERLAP, candidateIds: [1] },
            'no-overlap',
        ]) {
            const r = validateNewTask({ ...BASE, dedupCheck: bad });
            assert.strictEqual(r.ok, false, JSON.stringify(bad));
            assert.match(r.reason, /dedupCheck/);
        }
    });

    test('valid dedupCheck passes and is returned', () => {
        const r = validateNewTask({ ...BASE, dedupCheck: NO_OVERLAP });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.dedupCheck, NO_OVERLAP);
        assert.strictEqual(validateDedupCheck(NO_OVERLAP).ok, true);
    });
});

describe('validateNewTaskWithDedup', () => {
    test('missing dedupCheck: rejected, no bd create and no bead command issued', async () => {
        const { command, calls } = makeCommand({});
        const r = await validateNewTaskWithDedup({ newTask: BASE, command, member: 'm', cycle: 1 });
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /dedupCheck/);
        assert.deepStrictEqual(calls, []);
    });

    test("no-overlap: plain validation returned, nothing dispatched (caller creates as before)", async () => {
        const { command, calls } = makeCommand({});
        const r = await validateNewTaskWithDedup({ newTask: { ...BASE, dedupCheck: NO_OVERLAP }, command, member: 'm', cycle: 1 });
        assert.strictEqual(r.ok, true);
        assert.ok(!r.merged);
        assert.deepStrictEqual(calls, []);
    });

    test("overlap with an open candidate appends to that bead's notes and never bd create", async () => {
        const { command, calls } = makeCommand({ 'x-1': 'open' });
        const logs = [];
        const r = await validateNewTaskWithDedup({
            newTask: { ...BASE, dedupCheck: { query: 'retry', candidateIds: ['x-1', 'x-2'], verdict: 'overlap' } },
            command, member: 'm', cycle: 2, log: (s) => logs.push(s),
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.merged, true);
        assert.strictEqual(r.mergedInto, 'x-1');
        assert.ok(calls.some((c) => /^bd note x-1 --file "/.test(c)), calls.join('\n'));
        assert.ok(!calls.some((c) => /bd create/.test(c)));
        assert.ok(!calls.some((c) => /--notes/.test(c)));
        assert.ok(logs.some((l) => /merged into x-1/.test(l)));
    });

    test('overlap with a closed or missing candidate is rejected naming the candidate', async () => {
        for (const [beads, id] of [[{ 'x-1': 'closed' }, 'x-1'], [{}, 'x-9']]) {
            const { command, calls } = makeCommand(beads);
            const r = await validateNewTaskWithDedup({
                newTask: { ...BASE, dedupCheck: { query: 'q', candidateIds: [id], verdict: 'overlap' } },
                command, member: 'm', cycle: 1,
            });
            assert.strictEqual(r.ok, false);
            assert.match(r.reason, new RegExp(id));
            assert.ok(!calls.some((c) => /bd (create|note)/.test(c)));
        }
    });

    test('overlap with an empty or shell-unsafe candidate id is rejected without any dispatch', async () => {
        for (const ids of [[], ['x-1; rm -rf /']]) {
            const { command, calls } = makeCommand({ 'x-1': 'open' });
            const r = await validateNewTaskWithDedup({
                newTask: { ...BASE, dedupCheck: { query: 'q', candidateIds: ids, verdict: 'overlap' } },
                command, member: 'm', cycle: 1,
            });
            assert.strictEqual(r.ok, false);
            assert.deepStrictEqual(calls, []);
        }
    });
});

describe('schema keeps dedupCheck out of the item required list', () => {
    test('a verdict whose other fields are valid but one newTask lacks dedupCheck still passes schema validation', () => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const verdict = {
            verdict: 'CHANGES_NEEDED', notes: 'n', reopenIds: ['a-1'],
            newTasks: [{ ...BASE, dedupCheck: NO_OVERLAP }, { ...BASE }],
        };
        assert.strictEqual(ajv.compile(reviewerVerdict)(verdict), true);
        const finalV = { verdict: 'PASS', notes: 'n', newTasks: [{ ...BASE }] };
        assert.strictEqual(ajv.compile(finalVerdict)(finalV), true);
    });

    test('dedupCheck is a declared property with the verdict enum on the reviewer schema', () => {
        const dc = reviewerVerdict.properties.newTasks.items.properties.dedupCheck;
        assert.deepStrictEqual(dc.properties.verdict.enum, ['no-overlap', 'overlap']);
        assert.ok(!reviewerVerdict.properties.newTasks.items.required.includes('dedupCheck'));
    });
});
