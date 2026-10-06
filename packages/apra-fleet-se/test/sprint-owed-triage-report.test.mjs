import fs from 'fs';
import os from 'os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// End-to-end: the sprint completion report enumerates owed triage, and a PASS
// is only reported clean when that list is empty.
//
// Scenario A (owed) reaches Finalization holding one item of every category:
//   (a) an open task with no lane metadata (streak/model) -- a follow-up the
//       Final Review itself files via a VALID newTask, which the engine
//       creates without lane metadata after every dispatch has run;
//   (b) an open feature whose only child is closed;
//   (c) a Final Review newTask that validateNewTask() rejects (bad priority);
//   (d) a bead the doer closed THIS sprint with a 'blocked:' reason.
// Scenario B (clean) is the same sprint with none of (a)-(d).
// The final reviewer is stubbed PASS in both, so the verdict is fixed and only
// the owed-triage surface may differ: never PASS -> FAIL, only clean -> not
// clean. ASCII only.
// =============================================================================

const MAIN_TASK = 'Task: A owed-triage main work';
const UNROUTED = 'Owed: unrouted follow-up with no lane';
const ROLLUP = 'Owed: stranded rollup feature';
const ROLLUP_CHILD = 'Owed: rollup child already done';
const REJECTED = 'Rejected finding with a bad priority';
const BLOCKED_REASON = 'blocked: missing secret DEMO_TOKEN';

const assignedIds = (prompt) => {
    const m = String(prompt).match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

const passVerdict = (newTasks = []) => async () => ({
    content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Stubbed PASS for the owed-triage scenario.', newTasks }) }],
});

/** The JSON body of the create-PR call, decoded from the mocked curl command. */
function prBodyFrom(commandLog) {
    const cmd = commandLog.find((c) => typeof c === 'string' && c.includes('Sprint verdict'));
    assert.ok(cmd, 'no create-PR command carrying a sprint verdict body was issued');
    const m = /-d '((?:[^']|'\\'')*)'/.exec(cmd);
    assert.ok(m, `no -d payload in the create-PR command: ${cmd.slice(0, 300)}`);
    const payload = JSON.parse(m[1].replace(/'\\''/g, "'"));
    return String(payload.body ?? payload.description ?? '');
}

function mockSprintTempDirs() {
    return new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('apra-fleet-mock-sprint-owedtriage')));
}

async function runScenario(tag, { owed }) {
    const ids = {};
    const run = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [{ title: MAIN_TASK }],
        maxCycles: 1,
        beforeSprint: owed
            ? async ({ tempDir, runCmd, epicBead }) => {
                const create = async (cmd) => {
                    const res = await runCmd(cmd, tempDir);
                    const id = String(res.stdout || '').trim();
                    assert.ok(id, `bd create returned no id for: ${cmd} (${res.stderr})`);
                    return id;
                };
                ids.rollup = await create(`bd create -t feature "${ROLLUP}" -d "Rollup whose children are all closed." -p 3 --silent`);
                await runCmd(`bd update ${ids.rollup} --parent ${epicBead.id}`, tempDir);
                ids.rollupChild = await create(`bd create "${ROLLUP_CHILD}" -d "Done child." -p 3 --silent`);
                await runCmd(`bd update ${ids.rollupChild} --parent ${ids.rollup}`, tempDir);
                await runCmd(`bd close ${ids.rollupChild}`, tempDir);
            }
            : undefined,
        doerHandler: async ({ opts, tempDir, runCmd }) => {
            const closedIds = [];
            for (const id of assignedIds(opts.prompt)) {
                await runCmd(owed ? `bd close ${id} --reason "${BLOCKED_REASON}"` : `bd close ${id}`, tempDir);
                closedIds.push(id);
            }
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: owed ? 'Closed as blocked.' : 'Closed.' }) }] };
        },
        reviewerHandler: async () => ({
            content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }) }],
        }),
        finalReviewHandler: passVerdict(owed
            ? [
                { title: UNROUTED, description: 'Follow-up filed by the final reviewer.', priority: 'P3' },
                { title: REJECTED, description: 'Rejected because its priority is not a P-level.', priority: 'urgent' },
            ]
            : []),
    });
    return { run, ids };
}

test('sprint completion report enumerates owed triage and only reports clean when empty', async () => {
    await withScenarioMarkers('owedtriage (owed vs clean completion report)', async () => {
        const tempBefore = mockSprintTempDirs();

        // ---- Scenario A: one item in every category ----
        const { run: owed, ids } = await runScenario('owedtriage', { owed: true });
        assert.equal(owed.error, null, `owed scenario threw: ${owed.error && owed.error.stack}`);
        const r = owed.result;
        assert.ok(r, 'owed scenario returned no result');
        assert.equal(r.verdict, 'PASS', 'the stubbed PASS verdict must survive owed triage');
        assert.equal(r.status, 'success');
        assert.ok(r.owedTriage, `result carries no owedTriage: ${JSON.stringify(r)}`);
        const t = r.owedTriage;
        const mainTaskId = owed.tasks.find((x) => x.title === MAIN_TASK).id;

        const unrouted = t.unroutedFollowUps.find((x) => x.title === UNROUTED);
        assert.ok(unrouted && unrouted.id, `unrouted: ${JSON.stringify(t.unroutedFollowUps)}`);
        ids.unrouted = unrouted.id;
        // It really is an open bead in scope, filed under the sprint target.
        const unroutedBead = owed.finalBeadsById.get(ids.unrouted);
        assert.ok(unroutedBead && unroutedBead.status === 'open', `unrouted bead state: ${JSON.stringify(unroutedBead)}`);
        assert.ok(t.strandedRollups.some((x) => x.id === ids.rollup && x.title === ROLLUP), `stranded: ${JSON.stringify(t.strandedRollups)}`);
        assert.ok(t.rejectedFindings.some((x) => x.title === REJECTED), `rejected: ${JSON.stringify(t.rejectedFindings)}`);
        assert.ok(t.blockedClosures.some((x) => x.id === mainTaskId && x.reason === BLOCKED_REASON), `blocked: ${JSON.stringify(t.blockedClosures)}`);
        // The sprint's own target is never owed triage, and a child that was
        // closed with a normal reason is never a blocked closure.
        for (const list of [t.unroutedFollowUps, t.strandedRollups, t.blockedClosures]) {
            assert.ok(!list.some((x) => x.id === owed.epicBeadId), 'the sprint target must not be listed');
            assert.ok(!list.some((x) => x.id === ids.rollupChild), 'the normally-closed rollup child must not be listed');
        }
        assert.equal(t.total, t.unroutedFollowUps.length + t.strandedRollups.length + t.rejectedFindings.length + t.blockedClosures.length);
        assert.equal(r.clean, false, 'a PASS that owes triage must not be clean');

        const owedBody = prBodyFrom(owed.commandLog);
        assert.match(owedBody, /^## Sprint verdict: PASS \(owed triage: \d+ item\(s\) -- PASS is NOT clean\)/);
        assert.ok(owedBody.includes('### Owed triage'), owedBody);
        for (const needle of [ids.unrouted, UNROUTED, ids.rollup, ROLLUP, REJECTED, mainTaskId, BLOCKED_REASON]) {
            assert.ok(owedBody.includes(needle), `PR body does not name ${needle}:\n${owedBody}`);
        }
        assert.ok(owed.logs.some((l) => /owed triage: \d+ item\(s\)/.test(l)), 'the run log names the owed triage');

        // ---- Scenario B: none of (a)-(d) ----
        const { run: clean } = await runScenario('owedtriageclean', { owed: false });
        assert.equal(clean.error, null, `clean scenario threw: ${clean.error && clean.error.stack}`);
        const c = clean.result;
        assert.equal(c.verdict, 'PASS');
        assert.equal(c.status, 'success');
        assert.ok(c.owedTriage, `clean result carries no owedTriage: ${JSON.stringify(c)}`);
        assert.equal(c.owedTriage.total, 0, `clean scenario owes triage: ${JSON.stringify(c.owedTriage)}`);
        assert.equal(c.clean, true);
        const cleanBody = prBodyFrom(clean.commandLog);
        assert.ok(!cleanBody.includes('Owed triage') && !cleanBody.includes('owed triage'), cleanBody);
        assert.ok(cleanBody.startsWith('## Sprint verdict: PASS\n'));
        assert.ok(clean.logs.includes('owed triage: none'), 'the run log states an explicit empty triage');

        // ---- The verdict is identical across both runs ----
        assert.equal(r.verdict, c.verdict);
        assert.equal(r.status, c.status);

        // ---- No leftover scenario temp dirs ----
        const leaked = [...mockSprintTempDirs()].filter((n) => !tempBefore.has(n));
        assert.deepEqual(leaked, [], 'scenario temp dirs were left behind');
    });
});
