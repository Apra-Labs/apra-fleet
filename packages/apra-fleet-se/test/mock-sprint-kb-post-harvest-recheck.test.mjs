import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { memberUuid, createFakeFleet, buildCallTool, buildOnCommand } from './helpers/kb-bible-fake-fleet.mjs';

// =============================================================================
// A sprint's own bible entries are re-checked after its LAST tree-changing
// commit -- the harvest phase.
//
// The final review's re-check runs before the harvester, and the harvester
// commits docs edits after it. A harvester edit to a file one of the sprint's
// own bible entries cites would leave that entry's recorded basis drifted at
// the pushed head. After the harvest round's bible commit the engine re-sends
// the sprint's merged ids once more; no review is left to re-verify a drifted
// one, so it is dropped from the branch bible (a withdrawal) with a WARN naming
// it and its changed files, and the KB entry itself is neither deleted nor
// demoted. An entry the branch does not own (already in the base bible) is
// never re-sent, dropped or named, even when the harvester changes a file it
// cites.
//
// Driven through the REAL runner with the mock-sprint harness and the fake
// per-member KB fleet (helpers/kb-bible-fake-fleet.mjs).
// =============================================================================

const REPO_URL = 'https://github.com/mock-org/mock-repo.git';
const CITED = 'src/report-format.ts';
const ENTRY_ID = 'eeee7777-kb-report-dates-are-utc';
const BASE_ID = 'aaaa1111-kb-base-owned-report-claim';

/**
 * One cycle. The doer publishes CITED v1; the round-1 reviewer promotes
 * ENTRY_ID (stamped at v1) and approves, so the round's bible commit merges
 * it. The bible already holds BASE_ID (from the base branch), also citing
 * CITED at v1. The harvester then publishes CITED at `harvestVersion`
 * (2: its docs commit edits the cited file; 1: it does not).
 */
async function runHarvestSprint(label, { harvestVersion, entryId = ENTRY_ID }) {
    const fleet = createFakeFleet();
    fleet.published.set(CITED, 1);
    fleet.bible.entries.set(BASE_ID, { [CITED]: 1 });
    const baseBible = new Map([...fleet.bible.entries].map(([id, basis]) => [id, JSON.stringify(basis)]));
    for (const [id, basis] of fleet.bible.entries) fleet.baseEntries.set(id, { ...basis });
    let doerCalls = 0;
    const doerHandler = async ({ opts, tempDir, runCmd: run }) => {
        doerCalls += 1;
        if (doerCalls === 1) {
            fleet.seedEntry('maint', {
                id: entryId, type: 'knowledge', title: 'Report dates are rendered in UTC', summary: 'The report formatter converts every date to UTC.',
                source_files: [CITED], created_at: new Date().toISOString(),
            });
        }
        const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const id of ids) await run(`bd close ${id}`, tempDir);
        return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'done' }) }] };
    };
    const reviewerHandler = async ({ opts }) => {
        const offered = opts.prompt.includes(`"id": "${entryId}"`);
        return { content: [{ text: JSON.stringify({
            verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [],
            ...(offered ? { kb_promotions: [{ id: entryId, reason: `verified against ${CITED}:21, every date goes through toUTC` }] } : {}),
        }) }] };
    };
    let harvested = false;
    const harvesterHandler = async () => {
        harvested = true;
        fleet.published.set(CITED, harvestVersion);
        return { content: [{ text: JSON.stringify({ status: 'OK', notes: 'Harvested docs.' }) }] };
    };
    const finalReviewHandler = async () => ({ content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'All goal beads closed.' }) }] });
    const r = await runDevelopLoopScenario(label, {
        members: ['maint', 'dev'],
        roleMap: { doer: ['dev'], reviewer: ['dev'] },
        beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
        taskSpecs: [{ title: `Task: kb post-harvest recheck ${label}` }],
        doerHandler, reviewerHandler, finalReviewHandler, harvesterHandler,
        maxCycles: 1,
        callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
        onCommand: buildOnCommand(fleet, { changedFiles: [CITED] }),
    });
    /** Entries in the final bible the branch owns: absent from the base bible, or different there. */
    const owned = () => [...fleet.bible.entries].filter(([id, basis]) => baseBible.get(id) !== JSON.stringify(basis));
    return { r, fleet, owned, harvested: () => harvested };
}

const kbLog = (r) => r.logs.filter((l) => l.includes('[kb-work]')).join('\n');

describe('mock sprint: the sprint\'s own bible entries are re-checked after the harvest phase', () => {
    test('the harvester edits a cited file -> the owned entry is dropped from the bible with a WARN; zero owned drift at the final head; the base entry is untouched', { timeout: scaledTimeout(240000, { concurrency: TEST_CONCURRENCY }) }, async () => {
        await withScenarioMarkers('kb post-harvest recheck drift', async () => {
            const { r, fleet, owned, harvested } = await runHarvestSprint('postharvestdrift', { harvestVersion: 2 });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.ok(harvested(), 'sanity: the harvester ran');
            assert.ok(fleet.bibleCommits.length >= 1 && fleet.bibleCommits[0].merged.includes(ENTRY_ID), `sanity: the review-round bible commit merged the entry; log:\n${kbLog(r)}`);
            assert.ok(r.logs.some((l) => /final head: every bible entry this sprint committed for .* still matches the branch head/.test(l)), `sanity: nothing had drifted at the final review; log:\n${kbLog(r)}`);

            // Zero owned drift at the final head: every owned entry left in
            // the bible matches the cited files as published.
            const drifted = owned().filter(([, basis]) => Object.entries(basis).some(([f, v]) => fleet.published.get(f) !== v));
            assert.deepEqual(drifted, [], `owned entries drifted at the final head; log:\n${kbLog(r)}`);

            // The drifted entry took the drop path: out of the bible, a WARN
            // naming it and the changed file.
            assert.ok(!fleet.bible.entries.has(ENTRY_ID), 'the final branch bible no longer carries the drifted entry');
            assert.ok(!fleet.bible.tombstones.has(ENTRY_ID), 'the branch added it, so no tombstone is left: a later sprint can capture it again');
            assert.ok(fleet.bibleCommits.some((c) => c.withdrawn.includes(ENTRY_ID)), 'it was withdrawn by a bible commit first');
            const warn = r.logs.find((l) => /\[kb-work\] WARN: dropping /.test(l) && l.includes(ENTRY_ID));
            assert.ok(warn, kbLog(r));
            assert.ok(warn.includes(CITED), 'the WARN names the changed cited file');
            assert.match(warn, /post-harvest head/);
            assert.match(warn, /no review is left to re-verify it/);
            const lastCommit = fleet.bibleCommits[fleet.bibleCommits.length - 1];
            assert.deepEqual(lastCommit.restored, [ENTRY_ID], 'the tombstone is lifted by the last bible commit of the sprint');
            assert.ok(r.logs.some((l) => l.includes(ENTRY_ID) && /added to the branch bible by this sprint alone/.test(l)), kbLog(r));

            // Never deleted or demoted locally.
            const row = fleet.kbOf(memberUuid('maint')).find((e) => e.id === ENTRY_ID);
            assert.equal(row.confidence, 'CONFIRMED', 'the maintainer\'s local entry is neither deleted nor demoted');
            assert.equal(row.superseded_at, null);
            const kbTools = fleet.events.filter((e) => e.type === 'kb').map((e) => e.tool);
            assert.ok(!kbTools.includes('kb_invalidate') && !kbTools.includes('kb_demote'), `no delete or demote: ${kbTools.join(', ')}`);

            // The entry the branch does not own: never re-sent, dropped or
            // named, though the harvester changed the file it cites.
            assert.deepEqual(fleet.bible.entries.get(BASE_ID), { [CITED]: 1 }, 'the base entry is not re-stamped or dropped');
            const bibleCalls = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_bible_commit');
            assert.ok(bibleCalls.length > 0);
            for (const c of bibleCalls) {
                assert.ok(!(c.args.ids || []).includes(BASE_ID), `the base entry is never sent: ${JSON.stringify(c.args)}`);
                assert.ok(!(c.args.withdrawals || []).some((w) => w.id === BASE_ID), `the base entry is never withdrawn: ${JSON.stringify(c.args)}`);
            }
            assert.ok(!r.logs.some((l) => l.includes(BASE_ID)), 'the base entry is never named in the run log');
        });
    });

    test('the drifted entry is one the BASE bible carries -> its withdrawal (tombstone) is kept', { timeout: scaledTimeout(240000, { concurrency: TEST_CONCURRENCY }) }, async () => {
        await withScenarioMarkers('kb post-harvest recheck base entry', async () => {
            const { r, fleet } = await runHarvestSprint('postharvestbase', { harvestVersion: 2, entryId: BASE_ID });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.ok(r.logs.some((l) => /\[kb-work\] WARN: dropping /.test(l) && l.includes(BASE_ID)), kbLog(r));
            assert.ok(fleet.bible.tombstones.has(BASE_ID), 'the base-carried id keeps its withdrawal');
            assert.ok(!fleet.bible.entries.has(BASE_ID));
            assert.ok(fleet.bibleCommits.every((c) => !c.restored.includes(BASE_ID)), 'no restore for an id the base bible carries');
        });
    });

    test('the harvester leaves the cited files alone -> the post-harvest recheck makes no bible commit and the entry keeps its basis', { timeout: scaledTimeout(240000, { concurrency: TEST_CONCURRENCY }) }, async () => {
        await withScenarioMarkers('kb post-harvest recheck clean', async () => {
            const { r, fleet, owned } = await runHarvestSprint('postharvestclean', { harvestVersion: 1 });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.equal(fleet.bibleCommits.length, 1, `only the review-round bible commit changed the bible: ${JSON.stringify(fleet.bibleCommits)}`);
            assert.ok(r.logs.some((l) => /post-harvest head: re-checking 1 bible entr\(ies\)/.test(l)), kbLog(r));
            assert.ok(r.logs.some((l) => /post-harvest head: every bible entry this sprint committed for .* still matches the branch head/.test(l)), kbLog(r));
            assert.deepEqual(fleet.bible.entries.get(ENTRY_ID), { [CITED]: 1 });
            assert.deepEqual(owned().map(([id]) => id), [ENTRY_ID]);
            assert.ok(!r.logs.some((l) => /WARN: dropping /.test(l)), kbLog(r));
        });
    });
});
