import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSprintPrBody, buildKbChangesSection, RUN_HISTORY_MARKER } from '../fleet-sprint/pr-body.mjs';

// The "KB changes on merge" PR-body section goes through the shared section
// hook (one budget), right after the merge assessment. ASCII only.

const ID = (n) => `${String(n).padStart(2, '0')}abcdef-0000-4000-8000-000000000000`;
const MERGE = {
    value: 'v'.repeat(380), risk: 'r'.repeat(380), default_path_changes: 'd'.repeat(380),
    blast_radius: 'b'.repeat(380), upgrade_impact: 'u'.repeat(380), proof: 'p'.repeat(380),
    recommendation: 'merge_after_proof', reason: 'z'.repeat(380),
};

describe('buildKbChangesSection', () => {
    test('null when nothing was offered', () => {
        assert.equal(buildKbChangesSection(null), null);
    });

    test('renders the header, per-id lines, no-verdict line and counts line', () => {
        const s = buildKbChangesSection({
            withdrawn: [{ id: ID(1), title: 'Handler never retries', note: 'now retries twice' }, { id: ID(2), title: '', note: '' }],
            noVerdict: [ID(3)], kept: 2, restored: 1, refused: [{ id: ID(4), reason: 'not in the candidate block' }], notPushed: [ID(2)],
        });
        assert.match(s.text, /^Merging withdraws 2 CONFIRMED KB claim\(s\) \(tombstones in \.fleet\/kb-canonical\.json\):/);
        assert.match(s.text, /- 01abcdef "Handler never retries" -- now retries twice/);
        assert.match(s.text, /- 02abcdef \(not in a pushed bible commit\)/);
        assert.ok(s.text.includes('**No verdict (1):** 03abcdef -- still CONFIRMED, not re-checked at HEAD.'), s.text);
        assert.match(s.text, /Re-checked and kept: 2; restored: 1; refused: 1 \(04abcdef not in the candidate block; run log\)/);
        assert.equal(s.placement, 'after-merge-assessment');
    });

    test('a demotion kb_bible_commit did not admit is never claimed as withdrawn', () => {
        const s = buildKbChangesSection({
            withdrawn: [], notRecorded: [{ id: ID(5), title: 'Old claim', note: 'false now' }],
            noVerdict: [], kept: 0, restored: 0, refused: [], notPushed: [],
        });
        assert.doesNotMatch(s.text, /Merging withdraws|withdrawn/i);
        assert.ok(s.text.includes('**Demotion not recorded (1):** 05abcdef'), s.text);
        assert.match(s.text, /still CONFIRMED after merge/);
    });

    test('under budget pressure the per-id lines fall back to ids only -- every id kept while the ids fit', () => {
        const withdrawn = Array.from({ length: 12 }, (_, i) => ({ id: ID(i + 1), title: 'T'.repeat(80), note: 'N'.repeat(200) }));
        const noVerdict = Array.from({ length: 15 }, (_, i) => ID(i + 40));
        const s = buildKbChangesSection({ withdrawn, noVerdict, kept: 1, restored: 0, refused: [], notPushed: [] });
        const idsOnly = s.fit(s.text, 600);
        assert.ok(idsOnly.length <= 600, idsOnly);
        assert.doesNotMatch(idsOnly, /more \(run log\)/, 'the ids alone fit: none is replaced by "+K more"');
        for (const w of withdrawn) assert.ok(idsOnly.includes(w.id.slice(0, 8)), `withdrawn ${w.id.slice(0, 8)} missing:\n${idsOnly}`);
        for (const id of noVerdict) assert.ok(idsOnly.includes(id.slice(0, 8)), `no-verdict ${id.slice(0, 8)} missing:\n${idsOnly}`);
        assert.ok(idsOnly.includes('**No verdict (15):**'), idsOnly);
    });

    test('when even the ids do not fit, each list names as many ids as fit, then "+K more (run log)"; no-verdict ids go last', () => {
        const withdrawn = Array.from({ length: 12 }, (_, i) => ({ id: ID(i + 1), title: 'T', note: 'N' }));
        const noVerdict = Array.from({ length: 15 }, (_, i) => ID(i + 40));
        const s = buildKbChangesSection({ withdrawn, noVerdict, kept: 0, restored: 0, refused: [], notPushed: [] });
        const tight = s.fit(s.text, 420);
        assert.ok(tight.length <= 420, tight);
        const nv = tight.split('\n').find((l) => l.startsWith('**No verdict (15):**'));
        assert.ok(nv, tight);
        for (const id of noVerdict) assert.ok(nv.includes(id.slice(0, 8)), `no-verdict ids are trimmed last:\n${tight}`);
        assert.match(tight, /^- (\d{2}abcdef, )+\+\d+ more \(run log\)$/m, `the withdrawn ids end early, after at least one id:\n${tight}`);
    });
});

describe('buildSprintPrBody with the KB section', () => {
    test('set-aside-heavy FAIL relaunch: body <= 3500, ends with the marker, all 20 no-verdict ids present, section right after the merge assessment', () => {
        const report = {
            withdrawn: [1, 2, 3, 4, 5, 6].map((n) => ({ id: ID(n), title: 'T'.repeat(80), note: 'N'.repeat(200) })),
            noVerdict: Array.from({ length: 20 }, (_, i) => ID(i + 10)),
            kept: 4, restored: 1, refused: [], notPushed: [],
        };
        const setAside = Array.from({ length: 12 }, (_, i) => ({ id: `bead-${i}`, title: 'x'.repeat(90), reason: 'y'.repeat(120) }));
        const { body } = buildSprintPrBody({
            verdict: 'FAIL', goal: 'P2', branch: 'feat/x', baseBranch: 'main', runId: 'r1',
            notes: 'n'.repeat(4000), mergeAssessment: MERGE, setAside, maxLength: 3500,
            sections: [buildKbChangesSection(report)],
        });
        assert.ok(body.length <= 3500, `body is ${body.length}`);
        assert.ok(body.trimEnd().endsWith('-->'), body.slice(-200));
        assert.ok(body.includes(RUN_HISTORY_MARKER));
        for (let i = 0; i < 20; i++) assert.ok(body.includes(ID(i + 10).slice(0, 8)), `no-verdict id ${i} missing`);
        assert.ok(body.indexOf('### KB changes on merge') > body.indexOf('### Merge assessment'));
        assert.ok(body.indexOf('### KB changes on merge') < body.indexOf('### Reviewer notes'));
        assert.match(body, /Re-checked and kept: 4; restored: 1; refused: 0 \(run log\)/);
    });

    test('more than the cap of no-verdict ids says "+K more (run log)"', () => {
        const s = buildKbChangesSection({ withdrawn: [], noVerdict: Array.from({ length: 45 }, (_, i) => ID(i)), kept: 0, restored: 0, refused: [], notPushed: [] });
        assert.match(s.text, /\*\*No verdict \(45\):\*\* .*39abcdef, \+5 more \(run log\) -- still CONFIRMED, not re-checked at HEAD\./);
    });

    test('a budget that forces the KB section to shrink keeps every withdrawn id and every no-verdict id', () => {
        const report = {
            withdrawn: Array.from({ length: 20 }, (_, i) => ({ id: ID(i + 1), title: 'T'.repeat(80), note: 'N'.repeat(200) })),
            noVerdict: Array.from({ length: 20 }, (_, i) => ID(i + 40)),
            kept: 3, restored: 0, refused: [], notPushed: [],
        };
        const section = buildKbChangesSection(report);
        assert.ok(section.text.length > 3500, 'the full section alone exceeds the budget');
        const { body } = buildSprintPrBody({
            verdict: 'PASS', goal: 'G', branch: 'feat/x', baseBranch: 'main', runId: 'r1',
            notes: 'n'.repeat(4000), mergeAssessment: MERGE, maxLength: 3500,
            sections: [section],
        });
        assert.ok(body.length <= 3500, `body is ${body.length}`);
        assert.ok(body.trimEnd().endsWith('-->'), body.slice(-200));
        assert.ok(body.split('N'.repeat(97)).length - 1 < 20, 'the per-id lines were compacted');
        for (const w of report.withdrawn) assert.ok(body.includes(w.id.slice(0, 8)), `withdrawn ${w.id.slice(0, 8)} missing`);
        for (const id of report.noVerdict) assert.ok(body.includes(id.slice(0, 8)), `no-verdict ${id.slice(0, 8)} missing`);
        assert.ok(body.includes('**No verdict (20):**'), 'the no-verdict line is never cut');
        assert.ok(body.includes('still CONFIRMED, not re-checked at HEAD.'));
    });
});
