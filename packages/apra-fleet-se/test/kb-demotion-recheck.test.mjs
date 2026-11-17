import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, readKbHolds } from '../fleet-sprint/kb.mjs';
import { buildSprintPrBody, formatKbRecheckLines } from '../fleet-sprint/pr-body.mjs';
import { PR_DESCRIPTION_MAX_LENGTH } from '../fleet-sprint/vcs-module.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

// The demotion rule: an offered CONFIRMED entry is demoted if and only if its
// claim is false at the sprint branch HEAD -- already false, or made false by
// this sprint. The engine offers exactly the entries whose cited files the
// diff touched, so a prompt that excused "basis drift" excused every offer and
// reviewers split on claims the sprint itself falsified. Every offered entry
// now needs an explicit verdict (kb_demotions or kb_holds), and the sprint PR
// body lists the verdicts plus any entry left without one.

const REVIEWER = Object.freeze({ id: 'id-rev', name: 'rev', type: 'local' });
const MAINTAINER = Object.freeze({ id: 'id-maint', name: 'maint', type: 'remote' });
const REPO = 'example.com/app';
const selector = () => fakeMaintainerSelector({
    repoOf: { [REVIEWER.name]: REPO, [MAINTAINER.name]: REPO },
    maintainerOf: { [REPO]: MAINTAINER },
});

const ENTRIES = [
    { id: 'kb-false', type: 'knowledge', confidence: 'CONFIRMED', title: 'Titles have no maximum length', summary: 's', source_files: ['src/a.js'] },
    { id: 'kb-true', type: 'knowledge', confidence: 'CONFIRMED', title: 'Create trims the title', summary: 's', source_files: ['src/a.js'] },
    { id: 'kb-silent', type: 'knowledge', confidence: 'CONFIRMED', title: 'Empty body is allowed', summary: 's', source_files: ['src/a.js'] },
];
const REASON = 'src/a.js now rejects titles over 100 characters at HEAD';

function makeClient({ demoteFails = false } = {}) {
    const calls = [];
    const memberCall = async (member, name, args) => {
        calls.push({ name, args });
        if (name === 'kb_query') return { content: [{ type: 'text', text: JSON.stringify({ l1_results: ENTRIES }) }] };
        if (name === 'kb_demote' && demoteFails) return { isError: true, content: [{ type: 'text', text: 'E-DEMOTE-NOT-CONFIRMED' }] };
        return {};
    };
    const client = createKbWorkClient({
        memberCall,
        maintainers: selector(),
        roundChangedFiles: async () => ['src/a.js'],
        sprintChangedFiles: async () => ['src/a.js'],
        log: () => {},
    });
    return { client, calls };
}

// The prompt-rule and schema assertions live in kb-demotion-candidates.test.mjs.

describe('readKbHolds', () => {
    test('keeps {id, note}, skips malformed items', () => {
        assert.deepEqual(readKbHolds({ kb_holds: [{ id: 'a', note: ' ok ' }, { note: 'x' }, null, { id: 'b' }] }),
            [{ id: 'a', note: 'ok' }, { id: 'b', note: '' }]);
        assert.deepEqual(readKbHolds(undefined), []);
    });
});

describe('kbWork records a verdict per offered entry', () => {
    test('demoted, kept and no-verdict entries are reported per review', async () => {
        const { client, calls } = makeClient();
        const offered = await client.demotionCandidates(REVIEWER, { scope: 'round' });
        assert.deepEqual(offered.map((e) => e.id), ['kb-false', 'kb-true', 'kb-silent']);
        await client.apply('reviewer', REVIEWER, {
            kb_demotions: [{ id: 'kb-false', reason: REASON, evidence_files: ['src/a.js'] }],
            kb_holds: [{ id: 'kb-true', note: 'createNote still trims at HEAD' }],
        });
        assert.ok(calls.some((c) => c.name === 'kb_demote' && c.args.id === 'kb-false'), 'kb_demote was never issued');
        const report = client.kbRecheckReport();
        assert.equal(report.length, 1);
        assert.equal(report[0].label, 'review round 1');
        const byId = Object.fromEntries(report[0].entries.map((e) => [e.id, e]));
        assert.equal(byId['kb-false'].verdict, 'demote');
        assert.equal(byId['kb-false'].applied, true);
        assert.equal(byId['kb-false'].text, REASON);
        assert.equal(byId['kb-true'].verdict, 'holds');
        assert.equal(byId['kb-true'].text, 'createNote still trims at HEAD');
        assert.equal(byId['kb-silent'].verdict, null);
    });

    test('a review that returns no KB fields leaves every offered entry without a verdict', async () => {
        const { client } = makeClient();
        await client.demotionCandidates(REVIEWER, { scope: 'round' });
        await client.apply('reviewer', REVIEWER, { verdict: 'APPROVED', notes: 'ok' });
        await client.demotionCandidates(REVIEWER, { scope: 'sprint' });
        await client.apply('reviewer', REVIEWER, { kb_holds: ENTRIES.map((e) => ({ id: e.id, note: 'holds' })) });
        const report = client.kbRecheckReport();
        assert.deepEqual(report.map((o) => o.label), ['review round 1', 'final review']);
        assert.ok(report[0].entries.every((e) => e.verdict === null), 'the round review gave no verdict and must stay visible');
        assert.ok(report[1].entries.every((e) => e.verdict === 'holds'));
    });

    test("the caller's review label names the offering", async () => {
        const { client } = makeClient();
        await client.demotionCandidates(REVIEWER, { scope: 'round', label: 'review C2' });
        assert.equal(client.kbRecheckReport()[0].label, 'review C2');
    });

    test('a demotion kb_demote refused is reported as not applied', async () => {
        const { client } = makeClient({ demoteFails: true });
        await client.demotionCandidates(REVIEWER, { scope: 'sprint' });
        await client.apply('reviewer', REVIEWER, { kb_demotions: [{ id: 'kb-false', reason: REASON, evidence_files: ['src/a.js'] }] });
        const e = client.kbRecheckReport()[0].entries.find((x) => x.id === 'kb-false');
        assert.equal(e.verdict, 'demote');
        assert.equal(e.applied, false);
    });

    test('holds from a non-reviewer role, or for an id never offered, are ignored', async () => {
        const { client } = makeClient();
        await client.demotionCandidates(REVIEWER, { scope: 'round' });
        await client.apply('doer', REVIEWER, { kb_holds: [{ id: 'kb-true', note: 'x' }] });
        await client.apply('reviewer', REVIEWER, { kb_holds: [{ id: 'kb-other', note: 'x' }] });
        const entries = client.kbRecheckReport()[0].entries;
        assert.ok(entries.every((e) => e.verdict === null));
        assert.ok(!entries.some((e) => e.id === 'kb-other'));
    });
});

describe('sprint PR body: KB entries re-checked', () => {
    const OFFERINGS = [{
        label: 'final review',
        repo: REPO,
        entries: [
            { id: 'kb-false', title: 'Titles have no maximum length', verdict: 'demote', text: REASON, applied: true },
            { id: 'kb-true', title: 'Create trims the title', verdict: 'holds', text: 'still trims at HEAD', applied: false },
            { id: 'kb-silent', title: 'Empty body is allowed', verdict: null, text: '', applied: false },
        ],
    }];

    test('lists demoted, kept and no-verdict entries with a loud warning', () => {
        const body = buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', baseBranch: 'main', runId: 'r1', now: new Date('2026-11-17T00:00:00Z'), notes: 'n', kbRecheck: OFFERINGS });
        assert.match(body, /### KB entries re-checked/);
        assert.match(body, /\*\*WARNING: 1 offered KB entry got no re-check verdict/);
        assert.ok(body.includes(`- demoted [final review] kb-false "Titles have no maximum length": ${REASON}`), body);
        assert.ok(body.includes('- kept [final review] kb-true "Create trims the title": still trims at HEAD'), body);
        assert.ok(body.includes('- **NO VERDICT** [final review] kb-silent "Empty body is allowed"'), body);
    });

    test('a demotion that did not apply says so', () => {
        const lines = formatKbRecheckLines([{ label: 'review round 1', entries: [{ id: 'k', verdict: 'demote', text: 'r', applied: false }] }]);
        assert.match(lines.join('\n'), /kb_demote did not apply/);
    });

    test('a large record stays bounded: the body fits the provider limit and no-verdict entries are never cut', () => {
        const long = 'x'.repeat(2000);
        const big = Array.from({ length: 4 }, (_, o) => ({
            label: `review C${o + 1}`,
            entries: Array.from({ length: 20 }, (_, i) => ({
                id: `kb-${o}-${i}`, title: long, verdict: i === 19 ? null : (i % 2 ? 'holds' : 'demote'), text: long, applied: true,
            })),
        }));
        const body = buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', runId: 'r1', now: new Date('2026-11-17T00:00:00Z'), notes: long, kbRecheck: big });
        assert.ok(body.length <= PR_DESCRIPTION_MAX_LENGTH, `body is ${body.length} characters`);
        assert.match(body, /\*\*WARNING: 4 offered KB entries got no re-check verdict/);
        for (let o = 0; o < 4; o++) assert.ok(body.includes(`**NO VERDICT** [review C${o + 1}] kb-${o}-19`), `no-verdict entry ${o} was cut`);
        assert.match(body, /more entries not shown -- see the run log/);
    });

    test('section is omitted when nothing was offered', () => {
        const body = buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', runId: 'r1', now: new Date('2026-11-17T00:00:00Z'), notes: 'n' });
        assert.doesNotMatch(body, /KB entries re-checked/);
    });

    test('reviewer text cannot inject markup', () => {
        const lines = formatKbRecheckLines([{ label: 'final review', entries: [{ id: 'k', verdict: 'holds', text: '<!-- x {{secure.T}}\n# h' }] }]);
        const out = lines.join('\n');
        assert.doesNotMatch(out, /<!--|\{\{|\n#/);
    });
});
