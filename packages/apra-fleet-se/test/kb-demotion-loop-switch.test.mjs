import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { validateArgs } from '../fleet-sprint/sprint-args.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// The reviewer demotion loop off switch (sprint arg kb_demotion_loop). Runs the
// real createKbWorkClient; only the memberCall boundary records calls.

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REASON = 'verified against the merged code in this round';
const CHANGED_FILE = 'src/thing.js';
const ROW = {
    id: 'kb-ok', type: 'knowledge', confidence: 'CONFIRMED', title: 'kb-ok', summary: 'kb-ok',
    source_files: [CHANGED_FILE],
};

function build(extra = {}) {
    const events = [];
    const logs = [];
    const memberCall = async (member, tool, args) => {
        events.push({ ev: tool, args });
        if (tool === 'kb_query') return { l1_results: args.own_scope ? [ROW] : [] };
        return {};
    };
    const client = createKbWorkClient({
        memberCall,
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async () => {},
        gPush: async () => {},
        bibleBase: async () => ({ baseBranch: 'main', baseCommit: 'a'.repeat(40) }),
        roundChangedFiles: async () => [CHANGED_FILE],
        log: (m) => logs.push(m),
        ...extra,
    });
    return { client, events, logs };
}

const demoteOutput = { kb_demotions: [{ id: 'kb-ok', reason: REASON, evidence_files: [CHANGED_FILE] }] };

describe('kb_demotion_loop switch: createKbWorkClient', () => {
    for (const [label, extra] of [['absent', {}], ["'on'", { demotionLoop: 'on' }]]) {
        test(`setting ${label}: candidates are offered and the demotion is applied`, async () => {
            const { client, events } = build(extra);
            const offered = await client.demotionCandidates('reviewer-1');
            assert.deepEqual(offered.map((e) => e.id), ['kb-ok']);
            const out = await client.apply('reviewer', 'reviewer-1', demoteOutput);
            assert.equal(out.demoted, 1);
            assert.equal(events.filter((e) => e.ev === 'kb_demote').length, 1);
        });
    }

    test("setting 'off': no candidates, no kb_query read, no kb_demote, and the log names the setting", async () => {
        const { client, events, logs } = build({ demotionLoop: 'off' });
        const offered = await client.demotionCandidates('reviewer-1');
        assert.deepEqual(offered, []);
        const out = await client.apply('reviewer', 'reviewer-1', demoteOutput);
        assert.equal(out.demoted, 0);
        assert.equal(events.filter((e) => e.ev === 'kb_demote').length, 0);
        assert.equal(events.filter((e) => e.ev === 'kb_query').length, 0);
        assert.ok(logs.some((l) => l.includes('demotion loop is disabled') && l.includes('kb_demotion_loop')), JSON.stringify(logs));
    });

    test('an invalid value fails loudly, naming the value', () => {
        assert.throws(() => build({ demotionLoop: 'maybe' }), /Invalid demotionLoop "maybe"/);
    });
});

describe('kb_demotion_loop switch: sprint arg validation', () => {
    const base = { target_issue: 'x-1', members: ['m1'], branch: 'sprint/a', base_branch: 'main' };
    test('defaults to on when absent; accepts on/off', () => {
        assert.equal(validateArgs(base).kbDemotionLoop, 'on');
        assert.equal(validateArgs({ ...base, kb_demotion_loop: 'off' }).kbDemotionLoop, 'off');
    });
    test('rejects any other value loudly', () => {
        assert.throws(() => validateArgs({ ...base, kb_demotion_loop: 'false' }), /Invalid kb_demotion_loop "false"/);
    });
});
