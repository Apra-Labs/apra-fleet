import fs from 'fs';
import os from 'os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// Features whose children are all closed are never silently stranded when the
// Integration Test phase is skipped: they stay OPEN (nothing closes them),
// are named in the run log at the skip point, and carry the skip reason in
// owedTriage.strandedRollups and the PR body. ASCII only.
// =============================================================================

const MAIN_TASK = 'Task: A stranded-rollup main work';
const ROLLUP = 'Stranded: feature with all children closed';
const ROLLUP_CHILD = 'Stranded: child already done';

const assignedIds = (prompt) => {
    const m = String(prompt).match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

function prBodyFrom(commandLog) {
    const cmd = commandLog.find((c) => typeof c === 'string' && c.includes('Sprint verdict'));
    assert.ok(cmd, 'no create-PR command carrying a sprint verdict body was issued');
    const m = /-d '((?:[^']|'\\'')*)'/.exec(cmd);
    assert.ok(m, 'no -d payload in the create-PR command');
    const payload = JSON.parse(m[1].replace(/'\\''/g, "'"));
    return String(payload.body ?? payload.description ?? '');
}

const tempDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('apra-fleet-mock-sprint-integskip')));

async function runScenario(tag, { withRunbooks, deployFails, maxCycles = 1, deployFailsOnlyFirst = false }) {
    const ids = {};
    let deployCalls = 0;
    const run = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [{ title: MAIN_TASK }],
        maxCycles,
        withRunbooks,
        beforeSprint: async ({ tempDir, runCmd, epicBead }) => {
            const create = async (cmd) => {
                const res = await runCmd(cmd, tempDir);
                const id = String(res.stdout || '').trim();
                assert.ok(id, `bd create returned no id for: ${cmd}`);
                return id;
            };
            ids.rollup = await create(`bd create -t feature "${ROLLUP}" -d "Rollup whose children are all closed." -p 3 --silent`);
            await runCmd(`bd update ${ids.rollup} --parent ${epicBead.id}`, tempDir);
            ids.child = await create(`bd create "${ROLLUP_CHILD}" -d "Done child." -p 3 --silent`);
            await runCmd(`bd update ${ids.child} --parent ${ids.rollup}`, tempDir);
            await runCmd(`bd close ${ids.child}`, tempDir);
        },
        doerHandler: async ({ opts, tempDir, runCmd }) => {
            const closedIds = [];
            for (const id of assignedIds(opts.prompt)) {
                await runCmd(`bd close ${id}`, tempDir);
                closedIds.push(id);
            }
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed.' }) }] };
        },
        deployHandler: deployFails
            ? async () => {
                deployCalls += 1;
                const ok = deployFailsOnlyFirst && deployCalls > 1;
                return { content: [{ text: JSON.stringify({ deployed: ok, notes: ok ? 'Deployed.' : 'Deploy blew up.' }) }] };
            }
            : undefined,
        // Verifier runs but leaves every bead open (no bd close).
        integHandler: deployFailsOnlyFirst
            ? async () => ({ content: [{ text: JSON.stringify({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Ran; closed nothing.' }) }] })
            : undefined,
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }) }],
        }),
        finalReviewHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Stubbed PASS.', newTasks: [] }) }],
        }),
    });
    return { run, ids };
}

function assertStranded({ run, ids }, reasonRe) {
    assert.equal(run.error, null, `scenario threw: ${run.error && run.error.stack}`);
    const t = run.result && run.result.owedTriage;
    assert.ok(t, 'result carries no owedTriage');
    const entry = t.strandedRollups.find((x) => x.id === ids.rollup);
    assert.ok(entry, `rollup not listed: ${JSON.stringify(t.strandedRollups)}`);
    assert.match(entry.reason, reasonRe);
    // No false close.
    const bead = run.finalBeadsById.get(ids.rollup);
    assert.ok(bead && bead.status !== 'closed', `rollup was closed: ${JSON.stringify(bead)}`);
    // Named at the skip point, before Finalization's owed triage line.
    const skipIdx = run.logs.findIndex((l) => l.includes('Skipping Integration Test Phase'));
    const nameIdx = run.logs.findIndex((l) => l.includes('Integration Test skipped') && l.includes(ids.rollup));
    assert.ok(skipIdx >= 0, 'no skip line logged');
    assert.ok(nameIdx > skipIdx, `stranded rollup not named after the skip line (skip=${skipIdx}, named=${nameIdx})`);
    const owedIdx = run.logs.findIndex((l) => /owed triage: \d+ item\(s\)/.test(l));
    assert.ok(owedIdx > nameIdx, 'skip-point naming must precede the Finalization report');
    const body = prBodyFrom(run.commandLog);
    assert.ok(body.includes(ids.rollup) && body.includes(ROLLUP), `PR body does not name the rollup:\n${body}`);
    // Nothing the integration-skip path issued closes the rollup.
    assert.ok(!run.commandLog.some((c) => typeof c === 'string' && new RegExp(`bd (close|update)\\b[^\\n]*${ids.rollup}\\b[^\\n]*(close|--status)`).test(c)),
        'a bd command closing the rollup was issued');
}

test('stranded all-children-closed feature is listed with a missing-playbook reason', async () => {
    await withScenarioMarkers('integskip (no playbook)', async () => {
        const before = tempDirs();
        const res = await runScenario('integskipnoplaybook', { withRunbooks: false, deployFails: false });
        assertStranded(res, /integ-test-playbook\.md/);
        assert.deepEqual([...tempDirs()].filter((n) => !before.has(n)), [], 'scenario temp dirs were left behind');
    });
});

test('stranded all-children-closed feature is listed with a deploy-failure reason', async () => {
    await withScenarioMarkers('integskip (deploy fails)', async () => {
        const before = tempDirs();
        const res = await runScenario('integskipdeployfail', { withRunbooks: true, deployFails: true });
        assertStranded(res, /deploy did not succeed/);
        assert.deepEqual([...tempDirs()].filter((n) => !before.has(n)), [], 'scenario temp dirs were left behind');
    });
});

test('a stale skip reason is dropped once a later cycle actually runs Integration Test', async () => {
    await withScenarioMarkers('integskip (deploy fails then runs)', async () => {
        const before = tempDirs();
        const { run, ids } = await runScenario('integskipstale', { withRunbooks: true, deployFails: true, maxCycles: 2, deployFailsOnlyFirst: true });
        assert.equal(run.error, null, `scenario threw: ${run.error && run.error.stack}`);
        assert.ok(run.logs.some((l) => l.includes('Skipping Integration Test Phase')), 'cycle 1 did not skip Integration Test');
        assert.ok(run.logs.some((l) => /Integration Test|integ-test-runner/i.test(l) && !l.includes('Skipping')), 'cycle 2 did not run Integration Test');
        const t = run.result && run.result.owedTriage;
        const entry = t && t.strandedRollups.find((x) => x.id === ids.rollup);
        if (entry) assert.doesNotMatch(entry.reason, /skipped/, `stale skip reason survived: ${entry.reason}`);
        const bead = run.finalBeadsById.get(ids.rollup);
        assert.ok(bead && bead.status !== 'closed', 'rollup was closed');
        assert.deepEqual([...tempDirs()].filter((n) => !before.has(n)), [], 'scenario temp dirs were left behind');
    });
});
