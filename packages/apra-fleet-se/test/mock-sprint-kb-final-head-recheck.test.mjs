import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, runCmd } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { memberUuid, createFakeFleet, buildCallTool, buildOnCommand } from './helpers/kb-bible-fake-fleet.mjs';

// =============================================================================
// A sprint's own bible entries are re-checked at the branch's final head.
//
// The sprint commits a bible entry before its last code commits, so a later
// commit can change a file the entry cites and leave the PR's bible with a
// drifted basis. Before the final review the engine re-sends every id this
// sprint's bible commits merged; one whose cited files changed comes back as
// a basis_mismatch skip and is offered to the final reviewer for
// re-verification. CONFIRM: kb_promote re-stamps it at HEAD and the final
// review's bible commit re-merges it with the fresh basis. Refusal: it is
// withdrawn from the branch bible with a WARN. Nothing drifted: no extra
// bible commit.
//
// Driven through the REAL runner with the mock-sprint harness. Every member
// is REMOTE; each member-scoped kb_* call is answered by a fake per-member KB
// that versions files: a G-pull copies the published file versions into the
// member's checkout, kb_promote stamps an entry's basis from the maintainer's
// checkout (re-stamping a CONFIRMED one, rebased: true when it moved), and
// kb_bible_commit merges an id only while its basis matches the checkout.
// =============================================================================

const REPO_URL = 'https://github.com/mock-org/mock-repo.git';
const CITED = 'src/widget-cache.ts';
const ENTRY_ID = 'ffff6666-kb-cache-keys-by-tenant';

/**
 * One sprint, two cycles. Cycle 1's doer publishes CITED v1; the round-1
 * reviewer promotes ENTRY_ID (stamped at v1) and reopens the bead, so the
 * round's bible commit merges the entry at v1. Cycle 2's doer publishes
 * CITED at `secondVersion` (2: a later commit changes the cited file; 1:
 * nothing drifts). `finalVerdict` decides what the final reviewer returns
 * for a re-verification candidate: 'confirm', 'refuse', or null (none).
 */
async function runRecheckSprint(label, { secondVersion, finalVerdict }) {
    const fleet = createFakeFleet();
    let doerCalls = 0;
    const doerHandler = async ({ opts, tempDir, runCmd: run }) => {
        doerCalls += 1;
        // The entry is captured during the sprint (inside the promotion
        // window), as an INFERRED entry on the maintainer.
        if (doerCalls === 1) {
            fleet.seedEntry('maint', {
                id: ENTRY_ID, type: 'knowledge', title: 'Cache keys carry the tenant id', summary: 'Every widget cache key starts with the tenant id.',
                source_files: [CITED], created_at: new Date().toISOString(),
            });
        }
        const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const id of ids) await run(`bd close ${id}`, tempDir);
        fleet.published.set(CITED, doerCalls === 1 ? 1 : secondVersion);
        return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'done' }) }] };
    };
    const reviewerHandler = async ({ reviewRound, tempDir, opts }) => {
        if (reviewRound === 1) {
            const list = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
            const task = list.find((b) => /^Task: kb final head recheck/.test(b.title));
            const offered = opts.prompt.includes(`"id": "${ENTRY_ID}"`);
            return { content: [{ text: JSON.stringify({
                verdict: 'CHANGES_NEEDED', notes: 'One more change needed.', reopenIds: [task.id], newTasks: [],
                ...(offered ? { kb_promotions: [{ id: ENTRY_ID, reason: `verified against ${CITED}:12, the key builder prefixes the tenant id` }] } : {}),
            }) }] };
        }
        return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }] };
    };
    let finalPrompt = null;
    const finalReviewHandler = async ({ opts }) => {
        finalPrompt = opts.prompt;
        const at = opts.prompt.indexOf('KNOWLEDGE BANK -- re-verification candidates');
        const offered = at >= 0 && opts.prompt.slice(at).includes(`"id": "${ENTRY_ID}"`);
        const kb = !offered || !finalVerdict ? {}
            : finalVerdict === 'confirm'
                ? { kb_promotions: [{ id: ENTRY_ID, reason: `re-checked ${CITED}:14 at HEAD, the tenant prefix is still applied` }] }
                : { kb_discards: [{ id: ENTRY_ID, reason: `${CITED}:14 now keys by region; the tenant claim no longer holds` }] };
        return { content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'All goal beads closed.', ...kb }) }] };
    };
    const r = await runDevelopLoopScenario(label, {
        members: ['maint', 'dev'],
        roleMap: { doer: ['dev'], reviewer: ['dev'] },
        beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
        taskSpecs: [{ title: `Task: kb final head recheck ${label}` }],
        doerHandler, reviewerHandler, finalReviewHandler,
        maxCycles: 2,
        callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
        onCommand: buildOnCommand(fleet, { changedFiles: [CITED] }),
    });
    return { r, fleet, finalPrompt: () => finalPrompt, doerCalls: () => doerCalls };
}

describe('mock sprint: the sprint\'s own bible entries are re-checked at the final head', () => {
    test('a later commit drifts an entry; the final reviewer confirms it -> the branch bible carries its basis at the final head', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb final head recheck confirm', async () => {
            const { r, fleet, finalPrompt, doerCalls } = await runRecheckSprint('recheckconfirm', { secondVersion: 2, finalVerdict: 'confirm' });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.equal(doerCalls(), 2, 'sanity: the cited file changed in a second develop round');
            assert.ok(fleet.bibleCommits.length >= 1 && fleet.bibleCommits[0].merged.includes(ENTRY_ID), `sanity: the round-1 bible commit merged the entry; log:\n${r.logs.filter((l) => l.includes('[kb-work]')).join('\n')}`);

            const at = finalPrompt().indexOf('KNOWLEDGE BANK -- re-verification candidates');
            assert.ok(at >= 0, 'the final reviewer is offered the drifted entry for re-verification');
            assert.ok(finalPrompt().slice(at).includes(`"path": "${CITED}"`), 'naming the changed cited file');

            const promotes = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_promote' && e.args.id === ENTRY_ID);
            assert.equal(promotes.length, 2, 'promoted once in round 1, re-stamped once at the final review');
            assert.ok(promotes.every((e) => e.member === 'maint' && e.grant), 'both on the maintainer as kb_maintainer');

            assert.ok(fleet.bible.entries.has(ENTRY_ID), 'the branch bible still carries the entry');
            assert.deepEqual(fleet.bible.entries.get(ENTRY_ID), { [CITED]: fleet.published.get(CITED) }, 'its basis matches the cited file at the final head');
            assert.equal(fleet.published.get(CITED), 2);
            assert.ok(!r.logs.some((l) => /WARN: dropping /.test(l)), r.logs.filter((l) => l.includes('[kb-work]')).join('\n'));
        });
    });

    test('a later commit drifts an entry; the final reviewer refuses it -> the branch bible no longer carries it and a WARN names it', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb final head recheck refuse', async () => {
            const { r, fleet } = await runRecheckSprint('recheckrefuse', { secondVersion: 2, finalVerdict: 'refuse' });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.ok(fleet.bibleCommits[0] && fleet.bibleCommits[0].merged.includes(ENTRY_ID), 'sanity: the round-1 bible commit merged the entry');

            assert.ok(!fleet.bible.entries.has(ENTRY_ID), 'the final branch bible does not carry the refused entry');
            const warn = r.logs.find((l) => /\[kb-work\] WARN: dropping /.test(l) && l.includes(ENTRY_ID));
            assert.ok(warn, r.logs.filter((l) => l.includes('[kb-work]')).join('\n'));
            assert.ok(warn.includes(CITED), 'the WARN names the changed cited file');
            assert.match(warn, /withdrawal is queued/);
            const row = fleet.kbOf(memberUuid('maint')).find((e) => e.id === ENTRY_ID);
            assert.equal(row.confidence, 'CONFIRMED', 'the maintainer\'s local entry is neither deleted nor demoted');
            assert.equal(row.superseded_at, null);
            const kbTools = fleet.events.filter((e) => e.type === 'kb').map((e) => e.tool);
            assert.ok(!kbTools.includes('kb_invalidate') && !kbTools.includes('kb_demote'), `no delete or demote: ${kbTools.join(', ')}`);
        });
    });

    test('nothing drifts after the sprint\'s bible commit -> no extra bible commit', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb final head recheck no drift', async () => {
            const { r, fleet, finalPrompt, doerCalls } = await runRecheckSprint('recheckclean', { secondVersion: 1, finalVerdict: 'confirm' });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.equal(doerCalls(), 2, 'sanity: a second develop round ran');
            assert.equal(fleet.bibleCommits.length, 1, `only the round-1 bible commit changed the bible: ${JSON.stringify(fleet.bibleCommits)}`);
            assert.ok(!finalPrompt().includes('KNOWLEDGE BANK -- re-verification candidates'), 'nothing to re-verify');
            assert.ok(r.logs.some((l) => /final head: every bible entry this sprint committed for .* still matches the branch head/.test(l)),
                r.logs.filter((l) => l.includes('[kb-work]')).join('\n'));
            assert.deepEqual(fleet.bible.entries.get(ENTRY_ID), { [CITED]: 1 });
        });
    });
});
