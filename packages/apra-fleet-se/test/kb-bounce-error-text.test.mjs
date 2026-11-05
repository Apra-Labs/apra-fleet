import fs from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { createKbInjection } from '../fleet-sprint/kb-injection.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// A bead bounced by the reviewer is re-dispatched to a doer whose KB lookup
// carries the reviewer's finding as kb_query error_text (bounded, bead ids
// stripped); the bead's first dispatch carries none.

const MAINT = Object.freeze({ id: 'id-maint', name: 'maint', type: 'local' });
const REPO = 'example.com/org/repo';
const BEAD = 'apra-fleet-6agk.2.5.3';

function harness() {
    const calls = [];
    const memberCall = async (_m, name, args) => {
        calls.push({ name, args });
        return { content: [{ text: JSON.stringify({ l1_results: [{ id: 'e1', title: 't', summary: 's', confidence: 'CONFIRMED' }], related_claims: [] }) }] };
    };
    const kbWork = createKbWorkClient({
        memberCall,
        maintainers: fakeMaintainerSelector({ repoOf: { maint: REPO, 'doer-1': REPO }, maintainerOf: { [REPO]: MAINT } }),
        log: () => {},
    });
    return { calls, injection: createKbInjection({ kbWork, log: () => {} }) };
}

// The context phases/develop.mjs builds for a lane (see the doerKbBlock call).
const laneContext = (perBeadFeedback) => {
    const laneBeads = [{ id: BEAD, title: 'Wire the thing', description: 'Edit src/wire.ts', acceptance_criteria: 'it wires' }];
    return {
        beadIds: [BEAD],
        beadTitles: laneBeads,
        beadErrorTexts: laneBeads.map((b) => (b && b.id && perBeadFeedback.get(b.id)) || null),
        laneFiles: ['src/wire.ts'],
    };
};

describe('bounce -> error_text on the re-dispatch kb_query', () => {
    test('first dispatch: no error_text; re-dispatch after a bounce: error_text with the failure and no bead id', async () => {
        const first = harness();
        await first.injection.blockFor({ role: 'doer', member: 'doer-1', context: laneContext(new Map()) });
        const firstQueries = first.calls.filter((c) => c.name === 'kb_query');
        assert.ok(firstQueries.length > 0);
        for (const q of firstQueries) assert.equal(q.args.error_text, undefined);

        const feedback = new Map([[BEAD, `Reviewer: ${BEAD} fails: AssertionError: expected 3 to equal 4 at wire.test.mjs:12`]]);
        const second = harness();
        await second.injection.blockFor({ role: 'doer', member: 'doer-1', context: laneContext(feedback) });
        const withError = second.calls.filter((c) => c.name === 'kb_query' && c.args.error_text);
        assert.equal(withError.length, 1, 'the bounced bead\'s query carries error_text');
        assert.match(withError[0].args.error_text, /expected 3 to equal 4/);
        for (const c of second.calls) assert.ok(!JSON.stringify(c.args).includes('6agk'), `bead id in ${JSON.stringify(c.args)}`);
    });

    test('error_text is bounded', async () => {
        const h = harness();
        await h.injection.blockFor({ role: 'doer', member: 'doer-1', context: laneContext(new Map([[BEAD, 'x'.repeat(9000)]])) });
        const q = h.calls.find((c) => c.name === 'kb_query' && c.args.error_text);
        assert.equal(q.args.error_text.length, 2000);
    });

    test('develop.mjs feeds perBeadFeedback into the doer KB context', () => {
        const src = fs.readFileSync(new URL('../fleet-sprint/phases/develop.mjs', import.meta.url), 'utf8');
        assert.match(src, /beadErrorTexts: laneBeads\.map\(\(b\) => \(b && b\.id && perBeadFeedback\.get\(b\.id\)\) \|\| null\)/);
    });
});
