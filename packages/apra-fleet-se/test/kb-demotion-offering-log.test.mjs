import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// The final review's demotion offering is logged (one offer line listing every
// offered id, one verdict line per id), kept in a record that survives a
// rebuilt client (a resume), and the exit WARN lists unpushed withdrawals and
// restores.

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REASON = 'the handler at src/thing.js:40 now retries twice; the claim says never';
const FILE = 'src/thing.js';
const row = (id) => ({ id, type: 'knowledge', confidence: 'CONFIRMED', title: id, summary: id, source_files: [FILE] });

function build(offered, extra = {}) {
    const logs = [];
    const client = createKbWorkClient({
        memberCall: async (member, tool, args) => {
            if (tool === 'kb_query') return { l1_results: args.own_scope ? [] : offered };
            return {};
        },
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        sprintChangedFiles: async () => [FILE],
        log: (m) => logs.push(m),
        ...extra,
    });
    return { client, logs };
}

describe('demotion offering log', () => {
    test('one offer line lists every offered id; one verdict line per id (demote / holds / none / refused)', async () => {
        const { client, logs } = build([row('kb-1'), row('kb-2'), row('kb-3')]);
        await client.demotionCandidates('reviewer-1');
        assert.equal(logs.filter((l) => /demotion candidates offered to the final review/.test(l)).length, 1);
        assert.ok(logs.some((l) => /offered to the final review for .*: 3 id\(s\): kb-1, kb-2, kb-3$/.test(l)), logs.join('\n'));

        await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [
                { id: 'kb-1', reason: REASON, evidence_files: [FILE] },
                { id: 'kb-stranger', reason: REASON, evidence_files: [FILE] },
            ],
            kb_holds: ['kb-2'],
        });
        const verdicts = logs.filter((l) => /demotion verdict for/.test(l)).map((l) => l.replace(/^.*demotion verdict for /, ''));
        assert.deepEqual(verdicts.sort(), [
            'kb-1: demote', 'kb-2: holds', 'kb-3: none', 'kb-stranger: refused:not in the candidate block',
        ]);
        assert.deepEqual(client.offeringRecord()[0].verdicts, {
            'kb-1': 'demote', 'kb-2': 'holds', 'kb-3': 'none', 'kb-stranger': 'refused:not in the candidate block',
        });
    });

    test('a client rebuilt on a resume keeps the offering through the shared record', async () => {
        const record = new Map();
        const first = build([row('kb-1'), row('kb-2')], { offeringRecord: record });
        await first.client.demotionCandidates('reviewer-1');

        const resumed = build([], { offeringRecord: record });
        const [r] = resumed.client.offeringRecord();
        assert.deepEqual(r.offered, ['kb-1', 'kb-2']);
        // A later empty offer does not erase it.
        await resumed.client.demotionCandidates('reviewer-1');
        assert.deepEqual(resumed.client.offeringRecord()[0].offered, ['kb-1', 'kb-2']);
    });

    test('exit WARN lists withdrawals and restores not in a pushed bible commit', async () => {
        const { client, logs } = build([row('kb-1'), row('kb-2')]);
        await client.demotionCandidates('reviewer-1');
        await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [{ id: 'kb-1', reason: REASON, evidence_files: [FILE] }],
            kb_holds: ['kb-2'],
        });
        client.warnPending();
        assert.ok(logs.some((l) => /WARN: 1 withdrawal\(s\) for .* are not in a pushed bible commit.*: kb-1/.test(l)), logs.join('\n'));
        assert.ok(logs.some((l) => /WARN: 1 restore\(s\) for .* are not in a pushed bible commit.*: kb-2/.test(l)), logs.join('\n'));
    });
});
