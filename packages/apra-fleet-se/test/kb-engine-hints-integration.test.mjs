import fs from 'node:fs';
import path from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createKbWorkClient, KB_MAX_KNOWLEDGE_ENTRIES, mergeRankedLists } from '../fleet-sprint/kb.mjs';
import { createKbInjection } from '../fleet-sprint/kb-injection.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// End to end through the engine KB path (kb-injection blockFor -> roleHints ->
// kbWork.knowledgeFor -> memberCall) with a recording fake memberCall.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAINT = Object.freeze({ id: 'id-maint', name: 'maint', type: 'local' });
const REPO = 'example.com/org/repo';
const BEAD_A = 'apra-fleet-6agk.2.5.1';
const BEAD_B = 'apra-fleet-6agk.2.5.2';

/** Every kb_query answers with 12 distinct CONFIRMED entries (distinct per call). */
function harness({ perQuery = 12 } = {}) {
    const calls = [];
    const memberCall = async (_m, name, args) => {
        calls.push({ name, args });
        if (name === 'kb_query') {
            const n = calls.filter((c) => c.name === 'kb_query').length;
            const l1 = Array.from({ length: perQuery }, (_, i) => ({ id: `q${n}-${i}`, title: `entry ${n}-${i}`, summary: 's', confidence: 'CONFIRMED' }));
            return { content: [{ text: JSON.stringify({ l1_results: l1, related_claims: [] }) }] };
        }
        return { content: [{ text: JSON.stringify({ top_entries: [] }) }] };
    };
    const kbWork = createKbWorkClient({
        memberCall,
        maintainers: fakeMaintainerSelector({ repoOf: { maint: REPO, 'doer-1': REPO, 'rev-1': REPO }, maintainerOf: { [REPO]: MAINT } }),
        log: () => {},
    });
    return { calls, injection: createKbInjection({ kbWork, log: () => {} }) };
}
const queriesOf = (calls) => calls.filter((c) => c.name === 'kb_query').map((c) => c.args);
const count = (block) => (block.match(/"title":/g) || []).length;

const doerContext = (feedback = new Map()) => {
    const beads = [
        { id: BEAD_A, title: 'Harden the zone binder', description: `Make resolveZoneBinding in src/zones/binding.ts reject orphans (${BEAD_A})`, acceptance_criteria: 'orphaned polygons raise a typed error' },
        { id: BEAD_B, title: 'Cache the roi lookup', description: 'Add a cache to loadRoiTable in src/roi/table.ts', acceptance_criteria: 'second lookup avoids disk reads' },
    ];
    return {
        beadIds: beads.map((b) => b.id),
        beadTitles: beads,
        beadErrorTexts: beads.map((b) => feedback.get(b.id) || null),
        laneFiles: ['src/zones/binding.ts', 'src/roi/table.ts'],
    };
};

describe('engine KB hints, end to end', () => {
    test('doer, two beads: per-bead kb_query calls carry description/criteria words and files/symbols', async () => {
        const h = harness();
        await h.injection.blockFor({ role: 'doer', member: 'doer-1', context: doerContext() });
        const beadQs = queriesOf(h.calls).filter((q) => /zone binder|roi lookup/.test(q.query));
        assert.equal(beadQs.length, 2);
        assert.match(beadQs[0].query, /orphaned polygons/);
        assert.match(beadQs[1].query, /avoids disk reads/);
        assert.deepEqual(beadQs[0].files, ['src/zones/binding.ts']);
        assert.ok(beadQs[0].symbols.includes('resolveZoneBinding'));
        assert.deepEqual(beadQs[1].files, ['src/roi/table.ts']);
        assert.ok(beadQs[1].symbols.includes('loadRoiTable'));
    });

    test('reviewer with a diff hunk passes the changed symbol in symbols', async () => {
        const h = harness();
        const hunks = ['diff --git a/src/zones/binding.ts b/src/zones/binding.ts', '--- a/src/zones/binding.ts', '+++ b/src/zones/binding.ts', '@@ -1,2 +1,3 @@', '+export function sealOrphanZones(zone) {'].join('\n');
        await h.injection.blockFor({ role: 'reviewer', member: 'rev-1', context: { beadTitles: ['Harden the zone binder'], diffFiles: ['src/zones/binding.ts'], diffHunks: hunks } });
        assert.ok(queriesOf(h.calls).some((q) => (q.symbols || []).includes('sealOrphanZones')), JSON.stringify(queriesOf(h.calls)));
    });

    test('the pushed KNOWLEDGE BANK block holds at most 8 entries even when the fake returns 12 per query', async () => {
        const h = harness({ perQuery: 12 });
        const [block] = await h.injection.blockFor({ role: 'doer', member: 'doer-1', context: doerContext() });
        assert.ok(queriesOf(h.calls).length >= 2);
        assert.ok(count(block) > 0);
        assert.ok(count(block) <= 8, `block carries ${count(block)} entries`);
        assert.equal(count(block), 8);
    });

    test('falsifiable: a cap of 12 breaks the at-most-8 assertion', async () => {
        assert.equal(KB_MAX_KNOWLEDGE_ENTRIES, 8);
        const src = fs.readFileSync(path.join(HERE, '..', 'fleet-sprint', 'kb.mjs'), 'utf8');
        assert.match(src, /export const KB_MAX_KNOWLEDGE_ENTRIES = 8;/);
        const lists = [1, 2].map((n) => ({ entries: Array.from({ length: 12 }, (_, i) => ({ id: `l${n}-${i}`, confidence: 'CONFIRMED' })) }));
        assert.equal(mergeRankedLists(lists, KB_MAX_KNOWLEDGE_ENTRIES).length, 8);
        const uncapped = mergeRankedLists(lists, 12).length;
        assert.equal(uncapped, 12);
        assert.throws(() => assert.ok(uncapped <= 8), 'the cap assertion fails at 12');
    });

    test('a bounced bead\'s re-dispatch passes error_text; the first dispatch does not', async () => {
        const first = harness();
        await first.injection.blockFor({ role: 'doer', member: 'doer-1', context: doerContext() });
        assert.ok(queriesOf(first.calls).every((q) => q.error_text === undefined));

        const bounced = harness();
        const feedback = new Map([[BEAD_A, `${BEAD_A}: TypeError: cannot read properties of undefined (reading 'zone') in binding.ts`]]);
        await bounced.injection.blockFor({ role: 'doer', member: 'doer-1', context: doerContext(feedback) });
        const withErr = queriesOf(bounced.calls).filter((q) => q.error_text);
        assert.equal(withErr.length, 1);
        assert.match(withErr[0].error_text, /cannot read properties of undefined/);
    });

    test('no bead id appears in any kb_query argument', async () => {
        const h = harness();
        const feedback = new Map([[BEAD_A, `${BEAD_A} failed; see ${BEAD_B}`]]);
        await h.injection.blockFor({ role: 'doer', member: 'doer-1', context: doerContext(feedback) });
        await h.injection.blockFor({ role: 'reviewer', member: 'rev-1', context: { beadIds: [BEAD_A], beadTitles: [{ id: BEAD_A, title: `Fix ${BEAD_A}`, description: BEAD_B }], diffFiles: ['src/a.ts'] } });
        for (const q of queriesOf(h.calls)) assert.ok(!/6agk/.test(JSON.stringify(q)), JSON.stringify(q));
    });

    test('role prompts and the fleet skill carry the failure-time rule and the 401/403 rule', () => {
        const agents = path.join(HERE, '..', 'apra-pm', 'agents');
        const files = [...fs.readdirSync(agents).filter((f) => f.endsWith('.md')).map((f) => path.join(agents, f)), path.join(HERE, '..', '..', '..', 'skills', 'fleet', 'SKILL.md')];
        assert.ok(files.length >= 12);
        for (const f of files) {
            const t = fs.readFileSync(f, 'utf8').replace(/\s+/g, ' ');
            assert.match(t, /BEFORE diagnosing or escalating/, f);
            assert.match(t, /401\/403 that is about scope or access/, f);
        }
    });
});
