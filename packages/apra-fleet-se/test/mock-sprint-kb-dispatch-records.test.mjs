import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, mockCmdResult } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { memberUuid, createFakeFleet, buildCallTool, buildOnCommand, candidateIds } from './helpers/kb-fake-fleet.mjs';
import { DISPATCH_TOOL_CALLS_STATE_NAMESPACE } from '../fleet-sprint/dispatch-accounting.mjs';

// =============================================================================
// D5 end to end, through the REAL runner.js on the mock-sprint harness with a
// fake fleet whose kb_maintainer ('maint') answers the per-dispatch kb_query
// with three CONFIRMED entries, so every role's prompt carries a pushed
// KNOWLEDGE BANK block:
//
//   1. A sprint whose scripted role reports cite some of those entries (one
//      entry is cited by two dispatches), report one kb_wrong item, and carry
//      one accepted and one refused capture. Every persisted dispatch record
//      carries pushed ids and bytes, cited ids, wrong ids, captures with
//      triggers and rejects; the harvester's sprint analysis has the
//      Knowledge bank this sprint section with every aggregate; and the fake
//      maintainer received the pushed and cited ids through kb_usage.
//
//   2. A sprint that STALLS (its only open bead is reported BLOCKED) after a
//      review round that confirmed an entry whose bible commit could not run
//      (the base commit was unresolvable then). The KB step still runs on the
//      stall: the fake maintainer receives kb_bible_commit for that entry.
//      Without the stall/abort KB step no bible commit call is ever made.
// =============================================================================

const REPO_URL = 'https://github.com/mock-org/mock-repo.git';
const CITED = 'src/widget-cache.ts';
const TIMEOUT = scaledTimeout(240000, { concurrency: TEST_CONCURRENCY });
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const assignedIds = (prompt) => {
    const m = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

const PUSHED = ['kb-p1', 'kb-p2', 'kb-p3'];
const pushedEntry = (id) => ({
    id, type: 'knowledge', confidence: 'CONFIRMED', tags: [],
    title: `Pushed entry ${id} durable title`,
    summary: `What entry ${id} says about the widget cache, long enough to read.`,
    source_files: [CITED], flagged_for_review: false, contradiction_of: null,
});

const GOOD = {
    type: 'knowledge', title: 'claim a: widget cache keys by tenant',
    summary: 'WidgetCache keys every entry by tenant id, so tenants never share a hit.',
    trigger: 'hidden-invariant', source_files: [CITED], symbols: ['WidgetCache'],
};
const NO_TRIGGER = { ...GOOD, title: 'claim b: a capture with no trigger', trigger: undefined };

/** The fake fleet with the maintainer's per-dispatch kb_query answering PUSHED. */
function fleetWithPushedEntries() {
    const fleet = createFakeFleet();
    const memberTool = fleet.memberTool;
    fleet.memberTool = (name, id, tool, args) => {
        if (tool === 'kb_query' && typeof args.tag !== 'string') {
            return { l1_results: PUSHED.map(pushedEntry), related_claims: [] };
        }
        if (tool === 'kb_bible_commit') return { committed: true, ids: args.ids || [] };
        return memberTool(name, id, tool, args);
    };
    return fleet;
}

/** The last persisted per-dispatch record list. */
function dispatchRecords(run) {
    const states = run.states.filter((s) => s.namespace === DISPATCH_TOOL_CALLS_STATE_NAMESPACE);
    assert.ok(states.length > 0, 'the dispatch records are published to sprint state');
    return states[states.length - 1].data.dispatches;
}

describe('mock sprint: per-dispatch KB records and the Knowledge bank section', () => {
    test('every dispatch record carries the KB fields, the analysis has the section, and the maintainer gets the usage report', { timeout: TIMEOUT }, async () => {
        await withScenarioMarkers('kb dispatch records', async () => {
            const fleet = fleetWithPushedEntries();
            let promoted = 0;
            const doerHandler = async ({ opts, tempDir, runCmd }) => {
                const ids = assignedIds(opts.prompt);
                for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
                fleet.published.add(CITED);
                return report({
                    status: 'VERIFY', closedIds: ids, notes: 'done',
                    kb_used: [{ id: 'kb-p1', how: 'followed its cache-key rule' }, { id: 'kb-p2', how: 'skipped a known dead end' }],
                    kb_wrong: [{ id: 'kb-p3', reason: 'the cache no longer evicts on write' }],
                    kb_captures: [GOOD, NO_TRIGGER],
                });
            };
            const reviewerHandler = async ({ opts }) => {
                const offered = candidateIds(opts.prompt) || [];
                const good = fleet.kbOf(memberUuid('maint')).find((e) => e.title === GOOD.title && offered.includes(e.id));
                if (good) promoted += 1;
                return report({
                    verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [],
                    kb_used: [{ id: 'kb-p1', how: 'checked the change against it' }],
                    kb_rejects: [{ id: 'kb-cand-rejected', reason: 'true but only restates the diff, fails the rubric' }],
                    ...(good ? { kb_promotions: [{ id: good.id, reason: `verified against ${CITED} WidgetCache and the tenant test` }] } : {}),
                });
            };
            const run = await runDevelopLoopScenario('kbrecords', {
                members: ['maint', 'dev'],
                roleMap: { doer: ['dev'], reviewer: ['dev'] },
                beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
                taskSpecs: [{ title: 'Task: per-dispatch KB records' }],
                doerHandler, reviewerHandler,
                finalReviewHandler: async () => report({ verdict: 'PASS', notes: 'All goal beads closed.' }),
                maxCycles: 1,
                callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
                onCommand: buildOnCommand(fleet),
            });
            assert.equal(run.error, null, `sprint error: ${run.error && run.error.message}`);

            // Every persisted record carries every KB field.
            const records = dispatchRecords(run);
            assert.ok(records.length > 0);
            for (const r of records) {
                const where = `record ${r.index} (${r.role} on ${r.member})`;
                assert.ok(r.pushed && Array.isArray(r.pushed.ids) && Number.isInteger(r.pushed.bytes), `${where}: pushed {ids, bytes}`);
                assert.ok(Array.isArray(r.kb_used), `${where}: kb_used`);
                assert.ok(Array.isArray(r.kb_wrong), `${where}: kb_wrong`);
                assert.ok(Array.isArray(r.captures) && r.captures.every((c) => 'trigger' in c), `${where}: captures with triggers`);
                assert.ok(Array.isArray(r.rejects), `${where}: rejects`);
            }
            const doer = records.filter((r) => r.role === 'doer');
            assert.equal(doer.length, 1, JSON.stringify(records.map((r) => r.role)));
            assert.deepEqual(doer[0].pushed.ids, PUSHED);
            assert.ok(doer[0].pushed.bytes > 0);
            assert.deepEqual(doer[0].kb_used, ['kb-p1', 'kb-p2']);
            assert.deepEqual(doer[0].kb_wrong, ['kb-p3']);
            assert.deepEqual(doer[0].captures, [{ title: GOOD.title, trigger: 'hidden-invariant' }]);
            assert.equal(doer[0].rejects.length, 1);
            assert.equal(doer[0].rejects[0].title, NO_TRIGGER.title);
            assert.equal(doer[0].rejects[0].rule, 'trigger');
            const reviewer = records.filter((r) => r.role === 'reviewer' && r.kb_used.length > 0);
            assert.ok(reviewer.length >= 1, 'the reviewer dispatch cited an entry');
            assert.deepEqual(reviewer[0].kb_used, ['kb-p1']);
            assert.deepEqual(reviewer[0].pushed.ids, PUSHED);
            // The reviewer's kb_rejects reach the record as well as the engine's refusals.
            assert.ok(reviewer[0].rejects.some((x) => x.id === 'kb-cand-rejected' && x.rule === 'kb_rejects' && /fails the rubric/.test(x.reason)), JSON.stringify(reviewer[0].rejects));
            const reviewerRejected = records.flatMap((r) => r.rejects).filter((x) => x.rule === 'kb_rejects').length;
            const citingP1 = records.filter((r) => r.kb_used.includes('kb-p1')).length;

            // The harvester's sprint analysis carries the section and every aggregate.
            const harvest = run.dispatched.filter((d) => d.agent === 'harvester');
            assert.equal(harvest.length, 1);
            const analysis = harvest[0].prompt;
            assert.match(analysis, /## Knowledge bank this sprint/);
            assert.match(analysis, new RegExp(`- doer: 1 dispatch\\(es\\), pushed 3 entr\\(ies\\) \\(${doer[0].pushed.bytes} bytes\\), cited 2, wrong 1\\.`));
            assert.match(analysis, /- reviewer: \d+ dispatch\(es\), pushed \d+ entr\(ies\) \(\d+ bytes\), cited [1-9]\d*, wrong 0\./);
            assert.match(analysis, /Captures by trigger: hidden-invariant 1\./);
            assert.ok(reviewerRejected >= 1);
            assert.match(analysis, new RegExp(`Promoted: ${promoted}\\. Rejected \\(captures refused by the engine\\): 1\\. Rejected by a reviewer \\(kb_rejects\\): ${reviewerRejected}\\. Wrong \\(kb_wrong reports\\): 1\\.`));
            assert.match(analysis, new RegExp(`Entries cited by more than one dispatch: kb-p1 \\(${citingP1} dispatches\\)`));
            assert.ok(citingP1 >= 2, 'kb-p1 is cited by the doer and the reviewer');

            // The fake maintainer received the pushed and cited ids, with the grant.
            const usage = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_usage');
            assert.ok(usage.length > 0, 'kb_usage reached the maintainer');
            for (const u of usage) {
                assert.equal(u.member, 'maint');
                assert.equal(u.grant, true, 'kb_usage runs with the kb_maintainer grant');
            }
            const pushedReported = new Set(usage.flatMap((u) => (u.args && u.args.pushed) || []));
            const citedReported = usage.flatMap((u) => (u.args && u.args.cited) || []);
            for (const id of PUSHED) assert.ok(pushedReported.has(id), `pushed ${id} reported: ${JSON.stringify(usage.map((u) => u.args))}`);
            assert.ok(citedReported.includes('kb-p1') && citedReported.includes('kb-p2'), JSON.stringify(usage.map((u) => u.args)));
            assert.equal(citedReported.filter((id) => id === 'kb-p1').length, citingP1, 'each citing dispatch reports its cited ids');
        });
    });

    test('a stalled sprint still runs the KB step: the maintainer receives the bible commit', { timeout: TIMEOUT }, async () => {
        await withScenarioMarkers('kb dispatch records stall', async () => {
            const fleet = fleetWithPushedEntries();
            const onCommand = buildOnCommand(fleet);
            // The bible commit's base commit cannot be resolved the first time
            // (the review round), so the confirmation stays queued; afterwards
            // it resolves and the maintainer is on the sprint branch.
            let baseReads = 0;
            const BRANCH = 'auto-sprint/mock-kbrecstall';
            const commandHook = async (c) => {
                if (c.member_name === 'maint' && /^git merge-base HEAD origin\//.test(c.command)) {
                    baseReads += 1;
                    return baseReads === 1 ? mockCmdResult(1, '', 'fatal: no merge base') : mockCmdResult(0, 'c0ffee0000000000000000000000000000c0ffee\n', '');
                }
                if (c.member_name === 'maint' && c.command === 'git rev-parse --abbrev-ref HEAD' && baseReads > 1) {
                    return mockCmdResult(0, `${BRANCH}\n`, '');
                }
                return onCommand(c);
            };
            let seeded = false;
            const T = { a: 'Task: closes in cycle one', b: 'Task: needs a missing toolchain' };
            const run = await runDevelopLoopScenario('kbrecstall', {
                members: ['maint', 'dev'],
                roleMap: { doer: ['dev'], reviewer: ['dev'] },
                beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
                taskSpecs: Object.values(T).map((title) => ({ title })),
                maxCycles: 3,
                beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                    const id = (title) => tasks.find((x) => x.title === title).id;
                    await rc(`bd update ${id(T.a)} --set-metadata streak=lane-a --set-metadata streakOrder=1`, td);
                    await rc(`bd update ${id(T.b)} --set-metadata streak=lane-b --set-metadata streakOrder=1`, td);
                },
                doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                    const ids = assignedIds(opts.prompt);
                    const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                    const blocked = ids.filter((x) => (list.find((b) => b.id === x) || {}).title === T.b);
                    fleet.published.add(CITED);
                    if (!seeded) {
                        seeded = true;
                        fleet.seedEntry('maint', {
                            id: 'kb-cand', type: 'knowledge', title: 'A candidate the reviewer confirms',
                            summary: 'WidgetCache keys every entry by tenant id only.', source_files: [CITED],
                            created_at: new Date().toISOString(),
                        });
                    }
                    if (blocked.length > 0) return report({ status: 'BLOCKED', closedIds: [], blockedIds: blocked, notes: 'Missing toolchain: cargo is not installed.' });
                    for (const x of ids) await rc(`bd close ${x}`, td);
                    return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
                },
                reviewerHandler: async ({ opts }) => {
                    const offered = candidateIds(opts.prompt) || [];
                    return report({
                        verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [],
                        ...(offered.includes('kb-cand') ? { kb_promotions: [{ id: 'kb-cand', reason: `verified against ${CITED} WidgetCache tenant keying` }] } : {}),
                    });
                },
                callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
                onCommand: commandHook,
            });
            assert.ok(run.error, 'the run must end in a stall');
            assert.equal(run.error.code, 'SPRINT_STALLED', run.error.message);
            assert.ok(run.logs.some((l) => l.includes('[kb-work] promote kb-cand (reviewer)')), 'the review round confirmed the entry');
            assert.ok(baseReads >= 2, `the stall's KB step retried the bible commit (base reads: ${baseReads})`);

            // The KB step on the stall reached the maintainer's bible commit.
            const bible = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_bible_commit');
            assert.ok(bible.length >= 1, `the stalled sprint's KB step must call kb_bible_commit: ${run.logs.filter((l) => l.includes('[kb-work]')).join('\n')}`);
            assert.equal(bible[0].member, 'maint');
            assert.equal(bible[0].grant, true);
            assert.ok(bible[0].args.ids.includes('kb-cand'), JSON.stringify(bible[0].args));
            assert.ok(run.logs.some((l) => l.includes("[kb-work] KB step 'harvest (sprint stalled)' ran:")), 'the KB step ran on the stall');

            // The stalled sprint's records carry the KB fields too.
            for (const r of dispatchRecords(run)) {
                assert.ok(r.pushed && Array.isArray(r.kb_used) && Array.isArray(r.kb_wrong) && Array.isArray(r.captures) && Array.isArray(r.rejects));
            }
        });
    });
});
