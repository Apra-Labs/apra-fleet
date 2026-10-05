import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// Phase-level verification of the dedup-evidence gate, driving the real
// Review phase (phases/review.mjs) and Integ Test phase (phases/integ-test.mjs)
// against the mock bd backend (real `bd` on a scratch clone, no network, no
// wall-clock dependence):
//   1. a reviewer newTask WITHOUT dedupCheck is rejected: no bd create, the
//      rejection note on the parent names dedupCheck, and it is resurfaced into
//      the next Plan prompt;
//   2. a reviewer newTask with verdict 'overlap' naming an OPEN bead appends to
//      that bead's notes with no bd create and an unchanged bead count;
//   3. a reviewer newTask with a valid 'no-overlap' dedupCheck issues exactly
//      one bd create;
//   4. an integ-test-runner bugsFiled id lacking a dedupChecks entry gets a
//      WARN and a '[dedup-unverified]' note; a covered id gets nothing.

const NO_OVERLAP = { query: 'open backlog search', candidateIds: [], verdict: 'no-overlap' };
const MISSING_TITLE = 'Missing dedup evidence proposal';
const MERGE_TITLE = 'Overlapping proposal to merge';
const CREATE_TITLE = 'Genuinely new follow-up';
const TASK_A = 'Task: A closes normally (dedup evidence scenario)';
const TASK_B = 'Task: B never closes (dedup evidence scenario)';


let reviewerRun;

before(async () => {
    await withScenarioMarkers('dedup-evidence-reviewer', async () => {
        let planCalls = 0;
        let reviewed = false;
        reviewerRun = await runDevelopLoopScenario('dedupreview', {
            members: ['local'],
            taskSpecs: [{ title: TASK_A }, { title: TASK_B }],
            maxCycles: 2,
            doerHandler: async ({ opts, tempDir: td }) => {
                const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] ?? '')
                    .split(',').map((s) => s.trim()).filter(Boolean);
                const list = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const b = list.find((x) => x.title === TASK_B);
                const closedIds = [];
                for (const id of ids) {
                    if (b && id === b.id) continue; // B stays open: it is the overlap target and forces cycle 2
                    await runCmd(`bd close ${id}`, td);
                    closedIds.push(id);
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'ok' }) }] };
            },
            plannerHandler: async ({ tempDir: td, epicBead }) => {
                planCalls += 1;
                const r = await runCmd(`bd create "Task: filler cycle ${planCalls} (dedup scenario)" -d "progress filler" -p P2 --silent`, td);
                if (r.stdout.trim()) await runCmd(`bd update ${r.stdout.trim()} --parent ${epicBead.id}`, td);
                return { content: [{ text: 'filler ensured' }] };
            },
            reviewerHandler: async ({ tempDir: td }) => {
                let newTasks = [];
                if (!reviewed) {
                    reviewed = true;
                    const list = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                    const b = list.find((x) => x.title === TASK_B);
                    newTasks = [
                        { title: MISSING_TITLE, description: 'No evidence attached.', priority: 'P2' },
                        { title: MERGE_TITLE, description: 'Same as an open bead.', priority: 'P2', dedupCheck: { query: 'task b', candidateIds: [b.id], verdict: 'overlap' } },
                        { title: CREATE_TITLE, description: 'A real new finding.', priority: 'P2', dedupCheck: NO_OVERLAP },
                    ];
                    reviewerRun_overlapTarget = b.id;
                }
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks }) }] };
            },
        });
    });
});
let reviewerRun_overlapTarget;

describe('reviewer newTasks dedup gate (phases/review.mjs)', () => {
    test('1. a newTask without dedupCheck issues no bd create, notes the parent, and resurfaces in the next Plan prompt', () => {
        assert.ok(!reviewerRun.error, reviewerRun.error && reviewerRun.error.message);
        assert.ok(!reviewerRun.commandLog.some((c) => c.startsWith('bd create') && c.includes(MISSING_TITLE)));
        const rej = reviewerRun.logs.filter((m) => m.includes('REJECTED (not sent to bd create)') && m.includes('dedupCheck'));
        assert.equal(rej.length, 1, JSON.stringify(reviewerRun.logs.filter((m) => m.includes('REJECTED'))));
        assert.ok(reviewerRun.logs.some((m) => m.includes('appended verbatim') && m.includes(reviewerRun.epicBeadId)));
        const planPrompts = reviewerRun.dispatched.filter((d) => d.agent === 'planner' && !d.prompt.includes('Ready bead ids:'));
        assert.ok(planPrompts.length >= 2, `expected a second Plan dispatch, got ${planPrompts.length}`);
        assert.ok(!planPrompts[0].prompt.includes(MISSING_TITLE));
        assert.ok(planPrompts[1].prompt.includes(MISSING_TITLE), 'rejected proposal must resurface');
        assert.ok(/dedupCheck/.test(planPrompts[1].prompt), 'resurfaced reason must name dedupCheck');
    });

    test("2. an 'overlap' newTask naming an open bead appends to that bead and creates nothing", () => {
        const target = reviewerRun_overlapTarget;
        assert.ok(reviewerRun.commandLog.some((c) => c.startsWith(`bd note ${target} --file`)), JSON.stringify(reviewerRun.commandLog.filter((c) => c.startsWith('bd note'))));
        assert.ok(reviewerRun.logs.some((m) => m.includes(`merged into ${target}`)));
        assert.ok(!reviewerRun.commandLog.some((c) => c.startsWith('bd create') && c.includes(MERGE_TITLE)));
        const titles = [...reviewerRun.finalBeadsById.values()].map((b) => b.title);
        assert.ok(!titles.includes(MERGE_TITLE), `no bead may be created for the merged proposal: ${JSON.stringify(titles)}`);
    });

    test("3. a valid 'no-overlap' newTask issues exactly one bd create", () => {
        const creates = reviewerRun.commandLog.filter((c) => c.startsWith('bd create') && c.includes(CREATE_TITLE));
        assert.equal(creates.length, 1, JSON.stringify(creates));
        assert.ok([...reviewerRun.finalBeadsById.values()].some((b) => b.title === CREATE_TITLE));
    });
});

describe('integ-test-runner dedupChecks cross-check (phases/integ-test.mjs)', () => {
    test("4. a filed bug without a dedupChecks entry is WARNed and noted '[dedup-unverified]'; a covered id is untouched", async () => {
        await withScenarioMarkers('dedup-evidence-integ', async () => {
            let covered; let uncovered;
            const run = await runDevelopLoopScenario('dedupinteg', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: integ dedup scenario work' }],
                maxCycles: 1,
                withRunbooks: true,
                doerHandler: async ({ opts, tempDir: td }) => {
                    const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] ?? '')
                        .split(',').map((s) => s.trim()).filter(Boolean);
                    for (const id of ids) await runCmd(`bd close ${id}`, td);
                    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'ok' }) }] };
                },
                reviewerHandler: async () => ({ content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }) }] }),
                integHandler: async ({ tempDir: td, epicBead }) => {
                    const mk = async (t) => {
                        const r = await runCmd(`bd create "${t}" -d "integ bug" -p P2 --silent`, td);
                        const id = r.stdout.trim();
                        await runCmd(`bd update ${id} --parent ${epicBead.id}`, td);
                        return id;
                    };
                    covered = await mk('Integ bug covered by dedup evidence');
                    uncovered = await mk('Integ bug without dedup evidence');
                    return { content: [{ text: JSON.stringify({
                        featuresClosed: 0, issuesCreated: 2, passed: false, bugsFiled: [covered, uncovered],
                        dedupChecks: [{ beadId: covered, query: 'integ bug search', candidateIds: [], verdict: 'no-overlap' }],
                        summary: 'two failures filed',
                    }) }] };
                },
            });
            assert.ok(!run.error, run.error && run.error.message);
            const warns = run.logs.filter((m) => m.includes('dedup-unverified'));
            assert.equal(warns.length, 1, JSON.stringify(warns));
            assert.ok(warns[0].includes('WARN') && warns[0].includes(uncovered));
            assert.ok(run.commandLog.some((c) => c.startsWith(`bd note ${uncovered} --file`)));
            assert.ok(!run.commandLog.some((c) => c.startsWith(`bd note ${covered}`)));
            assert.ok(!run.logs.some((m) => m.includes('dedup-unverified') && m.includes(covered)));
            // the staged note body starts with the marker
            const stage = run.commandLog.filter((c) => c.startsWith('node -e ')).map((c) => /[A-Za-z0-9+/=]{40,}/.exec(c)?.[0]).filter(Boolean)
                .map((b) => Buffer.from(b, 'base64').toString());
            assert.ok(stage.some((s) => s.startsWith('[dedup-unverified]')), JSON.stringify(stage));
        });
    });
});
