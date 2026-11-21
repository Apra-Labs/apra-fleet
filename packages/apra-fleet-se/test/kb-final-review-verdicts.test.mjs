import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKbWorkClient, kbDemotionBlock } from '../fleet-sprint/kb.mjs';
import { finalVerdict } from '../fleet-sprint/contracts.mjs';
import { selfMaintainer, currentServerKbWork } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// The final review's demotion verdict: the prompt rule, the output schema,
// and how apply() resolves kb_demotions / kb_holds against the offer.
//
//   - Demotion candidates are judged at the FINAL review only: kb_demotions
//     (and kb_holds) from a review that was offered none are logged and
//     dropped, never executed.
//   - Every offered id belongs in exactly one of kb_demotions and kb_holds.
//     An id in neither (omitted) or in both is recorded as no-verdict -- the
//     engine never stalls or re-dispatches for it.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REASON = 'the handler at src/thing.js:40 now retries twice; the claim says never';
const CHANGED_FILE = 'src/thing.js';
const row = (id) => ({ id, type: 'knowledge', confidence: 'CONFIRMED', title: id, summary: id, source_files: [CHANGED_FILE] });

function harness(offered = []) {
    const events = [];
    const logs = [];
    const client = currentServerKbWork(createKbWorkClient, {
        memberCall: async (member, tool, args) => {
            if (tool === 'kb_query') return { l1_results: args.own_scope ? [] : offered };
            events.push({ ev: tool, args });
            return {};
        },
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        sprintChangedFiles: async () => [CHANGED_FILE],
        log: (m) => logs.push(m),
    });
    return { client, events, logs };
}

describe('final-review demotion rule text', () => {
    const text = kbDemotionBlock([row('kb-1')]).join('\n');

    test('states the iff rule at the sprint branch HEAD, including a claim this sprint made false', () => {
        assert.match(text, /if and only if its claim is false at the sprint branch HEAD/);
        assert.match(text, /including when this sprint's own changes made it false/);
    });

    test('says a demotion is recorded on the branch and takes effect only on merge', () => {
        assert.match(text, /recorded on this branch and takes effect only if the branch merges/);
    });

    test('requires every offered id in exactly one of kb_demotions and kb_holds', () => {
        assert.match(text, /exactly one of `kb_demotions` and `kb_holds`/);
        assert.match(text, /in neither, gets no verdict/);
    });

    test('no longer exempts a drifted or removed basis (that sentence must go for the final verdict)', () => {
        assert.ok(!/drifted or removed basis/.test(text), text);
    });

    test('the reviewer role prompt carries the same rule, final-verdict only', () => {
        const md = fs.readFileSync(path.join(__dirname, '..', 'apra-pm', 'agents', 'reviewer.md'), 'utf8');
        assert.match(md, /\*\*Demote or hold\*\* \(final verdict only\)/);
        assert.match(md, /if\s+and only if its claim is false at the sprint branch HEAD/);
        assert.match(md, /exactly one of `kb_demotions` and `kb_holds`/);
        assert.match(md, /any `kb_demotions` it returns are logged and dropped/);
        assert.ok(!/is NOT a demote case/.test(md), 'the drifted-basis exemption must be gone');
    });
});

describe('final-review output schemas carry kb_holds', () => {
    test('the final verdict schema declares kb_holds as an id list next to kb_demotions', () => {
        assert.ok(finalVerdict.properties.kb_demotions);
        assert.equal(finalVerdict.properties.kb_holds.type, 'array');
        assert.equal(finalVerdict.properties.kb_holds.items.type, 'string');
        assert.ok(!(finalVerdict.required || []).includes('kb_holds'), 'kb_holds stays optional');
        assert.match(finalVerdict.properties.kb_demotions.description, /false at the sprint branch HEAD/);
    });

    test('reviewer-output.json declares kb_holds and keeps kb_demotions optional', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apra-pm', 'agents', 'schemas', 'reviewer-output.json'), 'utf8'));
        assert.equal(schema.properties.kb_holds.type, 'array');
        assert.ok(!schema.required.includes('kb_demotions'));
        assert.ok(!schema.required.includes('kb_holds'));
        assert.match(schema.properties.kb_demotions.description, /logged and dropped/);
    });
});

describe('apply(): demotion verdicts are judged at the final review only', () => {
    test('a round review kb_demotions (no offer was made) is logged and dropped -- nothing is executed', async () => {
        const { client, events, logs } = harness([row('kb-1')]);

        const out = await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [{ id: 'kb-1', reason: REASON, evidence_files: [CHANGED_FILE] }],
            kb_holds: ['kb-2'],
        });

        assert.equal(out.demoted, 0);
        assert.equal(out.refused, 2);
        assert.deepEqual(events, [], 'a round demotion must never reach the KB');
        assert.ok(logs.some((l) => /offered no demotion candidates -- demotions are judged at the final review only; logged and dropped: kb-1, kb-2/.test(l)), logs.join('\n'));
        assert.deepEqual(client.demotionVerdicts(), []);
    });

    test('a final reviewer that omits kb_holds: the unjudged ids are recorded as no-verdict, nothing stalls', async () => {
        const { client, logs } = harness([row('kb-1'), row('kb-2'), row('kb-3')]);
        await client.demotionCandidates('reviewer-1');

        await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [{ id: 'kb-1', reason: REASON, evidence_files: [CHANGED_FILE] }],
        });

        const [v] = client.demotionVerdicts();
        assert.deepEqual(v.offered, ['kb-1', 'kb-2', 'kb-3']);
        assert.deepEqual(v.demoted, ['kb-1']);
        assert.deepEqual(v.held, []);
        assert.deepEqual(v.noVerdict, ['kb-2', 'kb-3']);
        assert.ok(logs.some((l) => /3 offered, 1 demoted, 0 held, 2 with no verdict \(kb-2, kb-3\)/.test(l)), logs.join('\n'));
    });

    test('a final reviewer that returns neither field records every offered id as no-verdict', async () => {
        const { client } = harness([row('kb-1'), row('kb-2')]);
        await client.demotionCandidates('reviewer-1');

        const out = await client.apply('reviewer', 'reviewer-1', { verdict: 'PASS' });

        assert.equal(out.demoted, 0);
        assert.deepEqual(client.demotionVerdicts()[0].noVerdict, ['kb-1', 'kb-2']);
    });

    test('an id in both kb_demotions and kb_holds gets no verdict; holds and demotions of other ids stand', async () => {
        const { client, logs } = harness([row('kb-1'), row('kb-2'), row('kb-3')]);
        await client.demotionCandidates('reviewer-1');

        await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [
                { id: 'kb-1', reason: REASON, evidence_files: [CHANGED_FILE] },
                { id: 'kb-2', reason: REASON, evidence_files: [CHANGED_FILE] },
            ],
            kb_holds: ['kb-1', 'kb-3'],
        });

        const [v] = client.demotionVerdicts();
        assert.deepEqual(v.demoted, ['kb-2']);
        assert.deepEqual(v.held, ['kb-3']);
        assert.deepEqual(v.noVerdict, ['kb-1']);
        assert.ok(logs.some((l) => /kb-1 is in both kb_demotions and kb_holds -- no verdict/.test(l)), logs.join('\n'));
    });

    test('a hold or a demotion of an id that was not offered is refused and does not count as a verdict', async () => {
        const { client } = harness([row('kb-1')]);
        await client.demotionCandidates('reviewer-1');

        const out = await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [{ id: 'kb-stranger', reason: REASON, evidence_files: [CHANGED_FILE] }],
            kb_holds: ['kb-other-stranger'],
        });

        assert.equal(out.refused, 2);
        const [v] = client.demotionVerdicts();
        assert.deepEqual(v.demoted, []);
        assert.deepEqual(v.held, []);
        assert.deepEqual(v.noVerdict, ['kb-1']);
    });

    test('kb_holds from a non-reviewer role is refused', async () => {
        const { client, logs } = harness([row('kb-1')]);
        await client.demotionCandidates('reviewer-1');

        await client.apply('doer', 'reviewer-1', { kb_holds: ['kb-1'] });

        assert.ok(logs.some((l) => /doer: kb_holds refused -- a hold is reviewer-only/.test(l)), logs.join('\n'));
        assert.deepEqual(client.demotionVerdicts(), [], 'a doer cannot settle the final review\'s offer');
    });
});
