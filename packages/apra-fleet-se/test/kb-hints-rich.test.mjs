import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roleHints, parseDiffHunks, KB_ROLE_HINT_SOURCES, KB_HINT_LIMITS, stripTrackerIds } from '../fleet-sprint/kb-hints.mjs';

// Rich KB hint sources: bead description and acceptance criteria, changed
// files, changed symbols and diff hunks feed the per-bead / per-file situations
// the query fan-out consumes. Bead ids never reach any output.

const BEAD_ID = 'apra-fleet-6agk.2.5.1';
const HUNKS = [
    'diff --git a/src/zones/binding.ts b/src/zones/binding.ts',
    '--- a/src/zones/binding.ts',
    '+++ b/src/zones/binding.ts',
    '@@ -10,4 +10,6 @@ export class ZoneIndex {',
    '-export function resolveZoneBinding(zone) {',
    '+export async function resolveZoneBinding(zone, opts) {',
    '+const defaultRoiLimit = 4;',
    '',
].join('\n');

describe('roleHints: rich sources', () => {
    test('doer: description and acceptance words reach terms and situations', () => {
        const h = roleHints('doer', {
            beadTitles: [{ id: BEAD_ID, title: `Fix ${BEAD_ID} zone collapsing`, description: 'Stop unbound roi from collapsing in src/zones/binding.ts', acceptance_criteria: 'Reject orphaned polygons with a typed error' }],
            laneFiles: ['src/zones/binding.ts'],
            beadIds: [BEAD_ID],
        });
        for (const w of ['collapsing', 'orphaned', 'polygons']) assert.ok(h.terms.includes(w), `terms carry ${w}: ${h.terms}`);
        const bead = h.situations.find((s) => s.kind === 'bead');
        assert.match(bead.situation, /collapsing/);
        assert.match(bead.situation, /orphaned polygons/);
        assert.deepEqual(bead.files, ['src/zones/binding.ts']);
        assert.ok(h.situations.some((s) => s.kind === 'file' && s.files[0] === 'src/zones/binding.ts'));
    });

    test('doer: parallel description / acceptance arrays work too', () => {
        const h = roleHints('doer', { beadTitles: ['Handle widgets'], beadDescriptions: ['The widgetFactory leaks'], beadAcceptance: ['No leaked handles remain'] });
        assert.match(h.situations[0].situation, /widgetFactory leaks/);
        assert.match(h.situations[0].situation, /leaked handles/);
        assert.ok(h.situations[0].symbols.includes('widgetFactory'));
    });

    test('reviewer: a hunk changing a function puts that function in symbols', () => {
        const h = roleHints('reviewer', { beadTitles: ['Fix zones'], diffFiles: ['src/zones/binding.ts'], diffHunks: HUNKS });
        assert.ok(h.hintSymbols.includes('resolveZoneBinding'));
        assert.ok(h.hintSymbols.includes('ZoneIndex'), 'hunk-header context counts');
        assert.ok(h.hintSymbols.includes('defaultRoiLimit'));
        const file = h.situations.find((s) => s.kind === 'file');
        assert.ok(file.symbols.includes('resolveZoneBinding'));
        assert.deepEqual(file.files, ['src/zones/binding.ts']);
        assert.ok(h.situations.find((s) => s.kind === 'bead').symbols.includes('resolveZoneBinding'));
    });

    test('harvester: changed symbols come from the hunks; it keeps the joined-terms query (no situations)', () => {
        const h = roleHints('harvester', { diffFiles: ['src/zones/binding.ts'], closedBeadTitles: ['Retry ingest'], diffHunks: HUNKS });
        assert.ok(h.hintSymbols.includes('resolveZoneBinding'));
        assert.deepEqual(h.situations, []);
    });

    test('planner / runners get no situations', () => {
        assert.deepEqual(roleHints('planner', { goals: ['g'], beadTitles: ['t'] }).situations, []);
        assert.deepEqual(roleHints('deployer', { deployTargets: ['deploy/x.yml'] }).situations, []);
    });

    test('source table wires the new fields', () => {
        assert.deepEqual([...KB_ROLE_HINT_SOURCES.doer], ['beadTitles', 'beadDescriptions', 'beadAcceptance', 'laneFiles']);
        for (const f of ['beadDescriptions', 'beadAcceptance', 'diffFiles', 'diffHunks', 'changedSymbols']) assert.ok(KB_ROLE_HINT_SOURCES.reviewer.includes(f), f);
        for (const f of ['diffFiles', 'closedBeadTitles', 'changedSymbols']) assert.ok(KB_ROLE_HINT_SOURCES.harvester.includes(f), f);
    });

    test('bead ids in any field never appear in the output', () => {
        const h = roleHints('reviewer', {
            beadIds: [BEAD_ID, 'custom-id'],
            beadTitles: [{ id: BEAD_ID, title: `T ${BEAD_ID}`, description: `see ${BEAD_ID} and bd-12 and custom-id (P1)`, acceptance_criteria: `closes ${BEAD_ID}.` }],
            beadErrorTexts: [`failed for ${BEAD_ID}: boom custom-id`],
            diffHunks: `+++ b/src/a.ts\n+// ${BEAD_ID}\n+function realFn() {`,
            diffFiles: ['src/a.ts'],
        });
        const dump = JSON.stringify(h);
        for (const bad of [BEAD_ID, 'custom-id', 'bd-12', '6agk']) assert.ok(!dump.includes(bad), `${bad} leaked: ${dump}`);
        assert.ok(h.hintSymbols.includes('realFn'));
    });

    test('hunks are size-capped before use', () => {
        const big = `+++ b/src/a.ts\n${'+// filler\n'.repeat(5000)}+function lateFn() {\n`;
        assert.ok(big.length > KB_HINT_LIMITS.maxHunkChars);
        assert.deepEqual(parseDiffHunks(big).flatMap((f) => f.symbols), [], 'a declaration past the cap is ignored');
    });

    test('errorText is bounded and id-stripped; a first dispatch has none', () => {
        const long = `${BEAD_ID} ${'x'.repeat(5000)}`;
        const h = roleHints('doer', { beadTitles: ['A', 'B'], beadErrorTexts: [long, null], laneFiles: ['src/a.ts'] });
        const bounced = h.situations.find((s) => s.kind === 'bead' && s.errorText);
        assert.ok(bounced.errorText.length <= KB_HINT_LIMITS.maxErrorTextChars);
        assert.ok(!bounced.errorText.includes('6agk'));
        assert.equal(h.situations.filter((s) => s.kind === 'bead')[1].errorText, undefined);
        assert.equal(roleHints('doer', { beadTitles: ['A'], laneFiles: ['src/a.ts'] }).situations.some((s) => s.errorText), false);
    });

    test('stripTrackerIds keeps ordinary words and paths', () => {
        assert.equal(stripTrackerIds(`error in kb-hints.mjs at src/a.ts ${BEAD_ID}`), 'error in kb-hints.mjs at src/a.ts');
    });

    test('legacy callers: a titles-only context keeps terms / hintSymbols / hintModules', () => {
        const h = roleHints('planner', { goals: ['Ship resolveZoneBinding fix'], beadTitles: [{ title: 'Stop unknown_zone' }] });
        assert.deepEqual(h.hintSymbols.sort(), ['resolveZoneBinding', 'unknown_zone']);
        assert.deepEqual(h.hintModules, []);
    });
});
