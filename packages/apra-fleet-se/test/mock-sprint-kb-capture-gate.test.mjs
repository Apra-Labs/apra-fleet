import fs from 'node:fs';
import os from 'node:os';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { memberUuid, isWriteTool, createFakeFleet, buildCallTool, buildOnCommand, candidateIds } from './helpers/kb-fake-fleet.mjs';

// =============================================================================
// The engine's capture gate and the reviewer REJECT path, end to end through
// the REAL runner.js on the mock-sprint harness (modelled on
// mock-sprint-kb-write-routing.test.mjs, sharing its fake fleet):
//
//   - the doer returns four kb_captures: one good capture with a trigger and
//     no content, and three bad ones that the output schema accepts but the
//     capture lint refuses (content repeating the summary, first-person
//     narrative, failed-attempt with no Rule/Fix);
//   - the reviewer rejects an existing promotion candidate (kb_rejects) and
//     promotes the good capture (kb_promotions).
//
// A capture with NO trigger never reaches vetKbWork through the runner: the
// role output schema requires trigger, so the dispatch layer rejects the whole
// doer output (schema repair, then degradation) before any KB work is vetted.
// vetKbWork's own trigger check is covered at the client level in
// kb-capture-lint.test.mjs.
//
// Only the good capture may reach kb_capture; every bad one is refused with a
// log line naming its rule; the reject becomes one kb_invalidate {ids, reason}
// on the kb_maintainer and the fake store records the reviewer's reason as
// the retirement note; the promotion still goes through kb_promote.
// =============================================================================

const REPO_URL = 'https://github.com/mock-org/mock-repo.git';
const CITED = 'src/widget-cache.ts';
const TAG = 'kbgate';

const GOOD_SUMMARY = 'WidgetCache keys every entry by tenant id, so tenants never share a hit.';
const CAPTURES = {
    good: {
        type: 'knowledge', title: 'claim a: widget cache keys by tenant', summary: GOOD_SUMMARY,
        trigger: 'hidden-invariant', source_files: [CITED], symbols: ['WidgetCache'],
    },
    repeats: {
        type: 'knowledge', title: 'claim c: content repeats the summary', summary: GOOD_SUMMARY,
        content: `${GOOD_SUMMARY}  `, trigger: 'hidden-invariant', source_files: [CITED],
    },
    firstPerson: {
        type: 'learning', title: 'claim d: first-person narrative',
        summary: 'We found that the widget cache keys by tenant id only.',
        trigger: 'review-finding', source_files: [CITED],
    },
    failedNoFix: {
        type: 'learning', title: 'claim e: failed attempt without Rule/Fix', summary: GOOD_SUMMARY,
        content: 'Cause: the cache key omitted the tenant id, so two tenants shared one cached hit.',
        trigger: 'failed-attempt', source_files: [CITED],
    },
};
const EXPECTED_REFUSALS = [
    [CAPTURES.repeats.title, 'rule content-repeats-summary'],
    [CAPTURES.firstPerson.title, 'rule first-person'],
    [CAPTURES.failedNoFix.title, 'rule failed-attempt-sections'],
];

const SEEDED_TITLE = 'An existing candidate that only restates the diff';
const REJECT_REASON = 'True, but it only restates the diff: fails the capture rubric (what the change does).';
const PROMOTE_REASON = `verified against ${CITED} WidgetCache and the tenant isolation test`;

/** Sandbox entries this scenario's harness creates under the OS temp dir. */
const ownTempEntries = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`apra-fleet-mock-sprint-${TAG}-`) && n.endsWith(`-${process.pid}`));

describe('mock sprint: the capture gate and kb_rejects', () => {
    test('bad captures are refused and logged by rule; kb_rejects retires the entry with the reviewer reason', { timeout: scaledTimeout(240000, { concurrency: TEST_CONCURRENCY }) }, async () => {
        await withScenarioMarkers('kb capture gate', async () => {
            const tempBefore = ownTempEntries();
            const fleet = createFakeFleet();
            const MAINT = memberUuid('maint');
            let seededId = null;
            let reviewerJudged = false;

            const doerHandler = async ({ opts, tempDir, runCmd }) => {
                fleet.events.push({ type: 'dispatch', member: opts.member_name, role: 'doer' });
                const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
                for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
                fleet.published.add(CITED);
                // An existing in-window promotion candidate on the maintainer
                // (captured earlier this sprint), for the reviewer to reject.
                if (!seededId) {
                    seededId = 'kb-existing-candidate';
                    fleet.seedEntry('maint', {
                        id: seededId, type: 'knowledge', title: SEEDED_TITLE,
                        summary: 'The change adds a tenant id to the widget cache key.',
                        source_files: [CITED], created_at: new Date().toISOString(),
                    });
                }
                return { content: [{ text: JSON.stringify({
                    status: 'VERIFY', closedIds: ids, notes: 'done',
                    kb_captures: Object.values(CAPTURES),
                }) }] };
            };
            const reviewerHandler = async ({ opts }) => {
                fleet.events.push({ type: 'dispatch', member: opts.member_name, role: 'reviewer' });
                const offered = candidateIds(opts.prompt) || [];
                const good = fleet.kbOf(MAINT).find((e) => e.title === CAPTURES.good.title && offered.includes(e.id));
                const judge = !reviewerJudged && good && offered.includes(seededId);
                if (judge) reviewerJudged = true;
                return { content: [{ text: JSON.stringify({
                    verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [],
                    ...(judge ? {
                        kb_promotions: [{ id: good.id, reason: PROMOTE_REASON }],
                        kb_rejects: [{ id: seededId, reason: REJECT_REASON }],
                    } : {}),
                }) }] };
            };

            const r = await runDevelopLoopScenario(TAG, {
                members: ['maint', 'dev'],
                roleMap: { doer: ['dev'], reviewer: ['dev'] },
                beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
                taskSpecs: [{ title: 'Task: kb capture gate and reviewer reject' }],
                doerHandler, reviewerHandler,
                finalReviewHandler: async () => ({ content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'All goal beads closed.' }) }] }),
                maxCycles: 1,
                callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
                onCommand: buildOnCommand(fleet),
            });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            const kbLogs = r.logs.filter((l) => l.includes('[kb-work]'));
            const writes = fleet.events.filter((e) => e.type === 'kb' && isWriteTool(e.tool));

            // Only capture (a) reaches kb_capture, carrying its trigger and no content key.
            const captures = writes.filter((e) => e.tool === 'kb_capture');
            assert.equal(captures.length, 1, JSON.stringify({ captures: captures.map((e) => e.args && e.args.title), kbLogs }));
            assert.equal(captures[0].member, 'maint');
            assert.equal(captures[0].args.title, CAPTURES.good.title);
            assert.equal(captures[0].args.trigger, 'hidden-invariant');
            assert.ok(!('content' in captures[0].args), 'a contentless capture is forwarded with no content key');

            // One refusal line per bad capture, naming the rule it failed.
            for (const [title, rule] of EXPECTED_REFUSALS) {
                const hits = kbLogs.filter((l) => l.includes('refused') && l.includes(`"${title}"`));
                assert.equal(hits.length, 1, `exactly one refusal line for "${title}": ${JSON.stringify(kbLogs)}`);
                assert.ok(hits[0].includes(rule), `the refusal for "${title}" names ${rule}: ${hits[0]}`);
            }
            assert.ok(!kbLogs.some((l) => l.includes('refused') && l.includes(`"${CAPTURES.good.title}"`)), 'the good capture is not refused');

            // kb_rejects: exactly one kb_invalidate, on the maintainer, with the id and the reviewer reason.
            assert.ok(reviewerJudged, 'the reviewer saw both candidates and judged them');
            const invalidates = writes.filter((e) => e.tool === 'kb_invalidate');
            assert.equal(invalidates.length, 1, JSON.stringify(invalidates));
            assert.equal(invalidates[0].member, 'maint');
            assert.equal(invalidates[0].grant, true, 'the reject runs with the kb_maintainer grant');
            assert.deepEqual(invalidates[0].args, { ids: [seededId], reason: REJECT_REASON });
            assert.ok(kbLogs.some((l) => l.includes(`reject ${seededId} (reviewer): ${REJECT_REASON}`)), JSON.stringify(kbLogs));

            // The promotion still goes through kb_promote.
            const good = fleet.kbOf(MAINT).find((e) => e.title === CAPTURES.good.title);
            const promotes = writes.filter((e) => e.tool === 'kb_promote');
            assert.equal(promotes.length, 1);
            assert.deepEqual(promotes[0].args, { id: good.id, reason: PROMOTE_REASON });
            assert.equal(good.confidence, 'CONFIRMED');

            // The store retired the rejected entry and kept the reviewer reason.
            const rejected = fleet.kbOf(MAINT).find((e) => e.id === seededId);
            assert.ok(rejected.superseded_at, 'the rejected entry is retired on the maintainer');
            assert.equal(rejected.retired_reason, REJECT_REASON);
            assert.equal(rejected.confidence, 'INFERRED', 'a rejected entry is never promoted');
            // Nothing else was stored: the four refused captures never reached the KB.
            assert.deepEqual(fleet.kbOf(MAINT).map((e) => e.id).sort(), [good.id, seededId].sort());
            assert.deepEqual(fleet.kbOf(memberUuid('dev')), []);
            assert.deepEqual(fleet.orchestratorKbCalls, [], 'no kb_* call goes through the orchestrator session');

            // The scenario leaves nothing behind outside its sandbox.
            assert.ok(!fs.existsSync(r.tempDir), `the scenario sandbox ${r.tempDir} is removed`);
            assert.deepEqual(ownTempEntries(), tempBefore, 'no scenario sandbox is left under the OS temp dir');
        });
    });
});
