import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    setupMinimal, teardown, runCmd, buildMockFleetApi, withScenarioMarkers, uniqueMockBranch,
} from './helpers/mock-sprint-harness.mjs';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.79.2 -- mock-sprint coverage for mode (ii) RESUMED SEQUENCE
// (the default): when a develop round has more ready streaks than doers, each
// doer gets an ORDERED worklist and its 2nd..Nth streaks dispatch as RESUMES
// of that doer's own streak-1 session (explicit session id), with git/dolt
// sync brackets kept BETWEEN streaks; mixed tiers (capability-gated via
// resume_model_switch) dispatch each streak at its own tier on the SAME
// session id; and the context-headroom admission check falls back to a fresh
// session.
//
// Uses a local scenario runner (instead of runDevelopLoopScenario) so that
// executeCommand and executePrompt land in ONE ordered `timeline` -- the only
// way to assert "a sync bracket ran BETWEEN streak 1 and streak 2 of the same
// doer's worklist" rather than just "brackets ran at some point".
// =============================================================================

const idsForPrompt = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

async function runWorklistScenario(tag, { members, taskSpecs, lanes, doerHandler, extraArgs = {} }) {
    const { tempDir, epicBead, tasks } = await setupMinimal(tag, taskSpecs);
    // Stamp planner lane metadata (streak/streakOrder/model) so the round
    // takes the deterministic groupStreaksFromLaneMetadata path -- one lane
    // per entry here means one STREAK per entry.
    for (const lane of lanes) {
        const t = tasks.find((x) => x.title === lane.title);
        const modelFlag = lane.model ? ` --set-metadata model=${lane.model}` : '';
        await runCmd(`bd update ${t.id} --set-metadata streak=${lane.streak} --set-metadata streakOrder=${lane.order}${modelFlag}`, tempDir);
    }

    const dispatched = [];
    const commandLog = [];
    const timeline = [];
    const logs = [];
    const priorBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
    process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';
    try {
        const api = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
            planReviewerMode: 'approve-immediately',
            addExtraTaskDuringPlan: false,
            doerHandler,
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
            }),
        });
        // Single ordered timeline across BOTH dispatch channels.
        const fleetApi = {
            executeCommand: async (opts) => {
                timeline.push({ kind: 'command', member: opts.member_name, command: opts.command });
                return api.executeCommand(opts);
            },
            executePrompt: async (opts) => {
                timeline.push({ kind: 'prompt', agent: opts.agent, member: opts.member_name, resume: opts.resume, model: opts.model, prompt: opts.prompt });
                return api.executePrompt(opts);
            },
        };
        const workflow = new FleetWorkflow(fleetApi, { targetRepo: tempDir });
        workflow.on('log', (e) => logs.push(e.msg));
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');
        let error = null;
        let result = null;
        try {
            result = await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members,
                branch: uniqueMockBranch(tag),
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 1,
                ...extraArgs,
            }, true);
        } catch (err) {
            error = err;
        }
        const finalBeadsById = new Map(JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]').map((b) => [b.id, b]));
        return { dispatched, commandLog, timeline, logs, error, result, tasks, finalBeadsById };
    } finally {
        if (priorBackoff === undefined) delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        else process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorBackoff;
        await teardown(tempDir);
    }
}

// A doer handler that closes its assigned beads and reports a per-member,
// per-dispatch session id (what execute_prompt's structuredContent.sessionId
// carries on a resume-capable provider), optionally with usage telemetry.
function makeSessionDoerHandler({ usage } = {}) {
    const perMemberCount = new Map();
    const handler = async ({ opts, runCmd: rc, tempDir: td }) => {
        const ids = idsForPrompt(opts.prompt);
        for (const id of ids) {
            await rc(`bd close ${id}`, td);
        }
        const m = opts.member_name;
        const n = (perMemberCount.get(m) || 0) + 1;
        perMemberCount.set(m, n);
        return {
            content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' }) }],
            structuredContent: {
                sessionId: `sess-${m}-${n}`,
                ...(usage ? { usage } : {}),
            },
        };
    };
    return handler;
}

// -----------------------------------------------------------------------------
// AC: 4 streaks, 2 doers -> each doer gets an ordered 2-streak assignment;
// streak 2 dispatches as a RESUME of that doer's streak-1 session, with sync
// brackets between them.
// -----------------------------------------------------------------------------
test('mock sprint (mode ii): 4 streaks / 2 doers -> ordered 2-streak worklists; streak 2 resumes streak 1\'s session with sync brackets between', async () => {
    await withScenarioMarkers('worklist resume 4x2', async () => {
        const scenario = await runWorklistScenario('wlresume', {
            members: ['m1', 'm2'],
            taskSpecs: [
                { title: 'Task: WL lane A' },
                { title: 'Task: WL lane B' },
                { title: 'Task: WL lane C' },
                { title: 'Task: WL lane D' },
            ],
            lanes: [
                { title: 'Task: WL lane A', streak: 'la', order: 1, model: 'standard' },
                { title: 'Task: WL lane B', streak: 'lb', order: 2, model: 'standard' },
                { title: 'Task: WL lane C', streak: 'lc', order: 3, model: 'standard' },
                { title: 'Task: WL lane D', streak: 'ld', order: 4, model: 'standard' },
            ],
            doerHandler: makeSessionDoerHandler(),
        });

        check(!scenario.error, `Scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected sprint success, got: ${JSON.stringify(scenario.result)}`);

        // The packing log line fired and describes per-doer ordered worklists.
        check(
            scenario.logs.some((m) => m.includes('Doer worklists (apra-fleet-eft.79): 4 ready streak(s) > 2 doer(s)') && m.includes('mode: resume')),
            `Expected the worklist packing log line, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Doer worklists')))}`
        );

        // Each doer got exactly 2 streak dispatches, in worklist order.
        const doerPrompts = scenario.timeline.filter((e) => e.kind === 'prompt' && e.agent === 'doer');
        check(doerPrompts.length === 4, `Expected 4 doer dispatches, got ${doerPrompts.length}`);
        for (const member of ['m1', 'm2']) {
            const forMember = doerPrompts.filter((e) => e.member === member);
            check(forMember.length === 2, `Expected 2 doer dispatches on '${member}', got ${forMember.length}`);

            // Streak 1 is a fresh session; streak 2 resumes streak 1's EXPLICIT
            // session id (the one the mock returned for this member's 1st turn).
            check(forMember[0].resume === false, `Expected '${member}' streak 1 to be fresh, got resume=${JSON.stringify(forMember[0].resume)}`);
            check(
                forMember[1].resume === `sess-${member}-1`,
                `Expected '${member}' streak 2 to RESUME session 'sess-${member}-1', got resume=${JSON.stringify(forMember[1].resume)}`
            );
            // The resumed dispatch restates its FULL scope (never a bare delta).
            check(forMember[1].prompt.startsWith('WORKLIST CONTINUATION'), `Expected the continuation preamble on '${member}' streak 2`);
            check(/Sprint track branch to work on:\s*\S+/.test(forMember[1].prompt), `Expected the full doer prompt (branch restated) on '${member}' streak 2`);
            check(idsForPrompt(forMember[1].prompt).length === 1, `Expected streak 2's OWN scope only, got ${JSON.stringify(idsForPrompt(forMember[1].prompt))}`);

            // SYNC BRACKETS BETWEEN THE TWO STREAKS: in the single ordered
            // timeline, this member's post-streak-1 G-push comes after
            // streak 1's dispatch, and its pre-streak-2 G-pull (fetch +
            // ff-only merge) comes after that push and before streak 2's
            // dispatch.
            const i1 = scenario.timeline.indexOf(forMember[0]);
            const i2 = scenario.timeline.indexOf(forMember[1]);
            const between = scenario.timeline.slice(i1 + 1, i2).filter((e) => e.kind === 'command' && e.member === member);
            const pushIdx = between.findIndex((e) => /^git push/.test(e.command));
            const fetchIdx = between.findIndex((e) => /^git fetch/.test(e.command));
            const mergeIdx = between.findIndex((e) => /^git merge --ff-only/.test(e.command));
            check(pushIdx !== -1, `Expected a post-streak-1 'git push' for '${member}' BETWEEN its two streak dispatches, got: ${JSON.stringify(between.map((e) => e.command))}`);
            check(fetchIdx !== -1 && mergeIdx !== -1, `Expected a pre-streak-2 'git fetch' + ff-only merge for '${member}' between its two streak dispatches, got: ${JSON.stringify(between.map((e) => e.command))}`);
            check(pushIdx < fetchIdx, `Expected streak 1's G-push before streak 2's G-pull for '${member}'`);
        }

        // The per-streak resume decision was logged.
        check(
            scenario.logs.some((m) => m.includes('dispatching streak 2/2') && m.includes('as a RESUME of session')),
            `Expected the worklist resume log line, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('RESUME')))}`
        );

        // All 4 beads closed for real.
        for (const task of scenario.tasks) {
            const b = scenario.finalBeadsById.get(task.id);
            check(b && b.status === 'closed', `Expected '${task.id}' closed, got: ${JSON.stringify(b)}`);
        }
    });
});

// -----------------------------------------------------------------------------
// AC (mode ii, mixed tiers): a standard streak resumed after a cheap streak
// dispatches with model=standard on the SAME session id; per-streak model
// values visible; no streak ever dispatches below its required tier.
// -----------------------------------------------------------------------------
test('mock sprint (mode ii, mixed tiers): standard streak resumes the cheap streak\'s session with model=standard (capability-gated)', async () => {
    await withScenarioMarkers('worklist mixed tiers', async () => {
        const scenario = await runWorklistScenario('wlmixed', {
            members: ['solo'],
            taskSpecs: [
                { title: 'Task: WL cheap work' },
                { title: 'Task: WL standard work' },
            ],
            lanes: [
                { title: 'Task: WL cheap work', streak: 'lane-cheap', order: 1, model: 'cheap' },
                { title: 'Task: WL standard work', streak: 'lane-std', order: 2, model: 'standard' },
            ],
            doerHandler: makeSessionDoerHandler(),
            // The model-switch-on-resume CAPABILITY opt-in: only with it may a
            // resumed sequence carry mixed tiers.
            extraArgs: { resume_model_switch: true },
        });

        check(!scenario.error, `Scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected sprint success, got: ${JSON.stringify(scenario.result)}`);

        const doerPrompts = scenario.timeline.filter((e) => e.kind === 'prompt' && e.agent === 'doer');
        check(doerPrompts.length === 2, `Expected 2 doer dispatches, got ${doerPrompts.length}`);

        // Streak 1: the cheap streak, fresh session, model=cheap.
        check(doerPrompts[0].resume === false, `Expected streak 1 fresh, got resume=${JSON.stringify(doerPrompts[0].resume)}`);
        check(doerPrompts[0].model === 'cheap', `Expected streak 1 model=cheap, got ${JSON.stringify(doerPrompts[0].model)}`);

        // Streak 2: the standard streak, resumed on the SAME session id, at
        // ITS OWN tier -- never below its requirement, never silently kept on
        // the session's previous (cheap) tier.
        check(doerPrompts[1].resume === 'sess-solo-1', `Expected streak 2 to resume 'sess-solo-1', got resume=${JSON.stringify(doerPrompts[1].resume)}`);
        check(doerPrompts[1].model === 'standard', `Expected streak 2 model=standard on the resumed session, got ${JSON.stringify(doerPrompts[1].model)}`);

        // The dispatch log shows per-streak model values.
        check(
            scenario.logs.some((m) => m.includes('as a RESUME of session') && m.includes('(model=standard)')),
            `Expected the per-streak model in the worklist resume log, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('RESUME')))}`
        );

        for (const task of scenario.tasks) {
            const b = scenario.finalBeadsById.get(task.id);
            check(b && b.status === 'closed', `Expected '${task.id}' closed, got: ${JSON.stringify(b)}`);
        }
    });
});

// -----------------------------------------------------------------------------
// Context-headroom admission (apra-fleet-eft.81 seam): a session near the
// context ceiling is NOT resumed -- the next streak starts a FRESH session
// with the FULL prompt (never a delta prompt into a fresh session).
// -----------------------------------------------------------------------------
test('mock sprint (mode ii): insufficient context headroom -> next streak starts a FRESH session with the full prompt', async () => {
    await withScenarioMarkers('worklist headroom refusal', async () => {
        const scenario = await runWorklistScenario('wlheadroom', {
            members: ['solo'],
            taskSpecs: [
                { title: 'Task: WL heavy first' },
                { title: 'Task: WL second' },
            ],
            lanes: [
                { title: 'Task: WL heavy first', streak: 'lane-1', order: 1, model: 'standard' },
                { title: 'Task: WL second', streak: 'lane-2', order: 2, model: 'standard' },
            ],
            // Streak 1 reports usage at/above the admission threshold
            // (150000 x 0.9 = 135000), so its session must NOT be resumed.
            doerHandler: makeSessionDoerHandler({ usage: { total_tokens: 149000, input_tokens: 140000, output_tokens: 9000 } }),
        });

        check(!scenario.error, `Scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected sprint success, got: ${JSON.stringify(scenario.result)}`);

        const doerPrompts = scenario.timeline.filter((e) => e.kind === 'prompt' && e.agent === 'doer');
        check(doerPrompts.length === 2, `Expected 2 doer dispatches, got ${doerPrompts.length}`);
        check(doerPrompts[0].resume === false, 'Expected streak 1 fresh');
        // Admission REFUSED: streak 2 is fresh, not a resume of sess-solo-1.
        check(doerPrompts[1].resume === false, `Expected streak 2 to be FRESH (headroom refused), got resume=${JSON.stringify(doerPrompts[1].resume)}`);
        // Never a delta prompt into a fresh session: the full doer prompt,
        // no continuation preamble.
        check(!doerPrompts[1].prompt.startsWith('WORKLIST CONTINUATION'), 'Fresh fallback must NOT carry the continuation preamble');
        check(/Sprint track branch to work on:\s*\S+/.test(doerPrompts[1].prompt), 'Fresh fallback must carry the FULL prompt');
        check(
            scenario.logs.some((m) => m.includes('context headroom insufficient to resume session')),
            `Expected the headroom-refusal log line, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('headroom')))}`
        );
    });
});

// -----------------------------------------------------------------------------
// Capability fallback at the ENGINE level: WITHOUT resume_model_switch, a
// mixed-tier round never produces a mixed worklist -- each tier dispatches as
// its own tier-pure worklist (separate sessions), still all in one round.
// -----------------------------------------------------------------------------
test('mock sprint (mode ii): without the model-switch capability, mixed tiers dispatch as separate tier-pure worklists (no cross-tier resume)', async () => {
    await withScenarioMarkers('worklist capability fallback', async () => {
        const scenario = await runWorklistScenario('wlfallback', {
            members: ['solo'],
            taskSpecs: [
                { title: 'Task: WL cheap fallback' },
                { title: 'Task: WL standard fallback' },
            ],
            lanes: [
                { title: 'Task: WL cheap fallback', streak: 'lane-cheap', order: 1, model: 'cheap' },
                { title: 'Task: WL standard fallback', streak: 'lane-std', order: 2, model: 'standard' },
            ],
            doerHandler: makeSessionDoerHandler(),
            // NO resume_model_switch: the capability check must fall back to
            // tier-homogeneous grouping.
        });

        check(!scenario.error, `Scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected sprint success, got: ${JSON.stringify(scenario.result)}`);

        const doerPrompts = scenario.timeline.filter((e) => e.kind === 'prompt' && e.agent === 'doer');
        check(doerPrompts.length === 2, `Expected 2 doer dispatches, got ${doerPrompts.length}`);
        // Both dispatches are FRESH sessions: the streaks sit in two separate
        // tier-pure worklists, and sessions never carry across worklists --
        // a cheap session is never resumed for standard-tier work.
        check(doerPrompts[0].resume === false && doerPrompts[1].resume === false,
            `Expected two fresh tier-pure dispatches, got resumes ${JSON.stringify(doerPrompts.map((e) => e.resume))}`);
        check(doerPrompts[0].model === 'cheap' && doerPrompts[1].model === 'standard',
            `Expected per-worklist tiers cheap then standard, got ${JSON.stringify(doerPrompts.map((e) => e.model))}`);
        check(
            scenario.logs.some((m) => m.includes('Doer worklists (apra-fleet-eft.79): 2 ready streak(s) > 1 doer(s)') && m.includes('tier-homogeneous')),
            `Expected the tier-homogeneous packing log, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Doer worklists')))}`
        );
    });
});
