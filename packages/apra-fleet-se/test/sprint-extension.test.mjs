import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    runFinalizationBarrier, awaitCiAtBarrier, classifyCiRecord, decideExtension, createExtensionState,
    formatExtensionReport, fixCiBeadTitle, buildFixCiNewTask, isInGoalPriority, EXTENSION_CYCLE_BUDGET,
} from '../fleet-sprint/sprint-extension.mjs';
import { validateNewTask } from '../fleet-sprint/abort.mjs';
import { createSprintState } from '../fleet-sprint/sprint-state.mjs';
import { policyFor } from '../fleet-sprint/role-policies.mjs';
import { validateArgs, validateMaxExtensions, DEFAULT_MAX_EXTENSIONS } from '../fleet-sprint/sprint-args.mjs';
import { buildRunnerArgs, parseMaxExtensionsFlag } from '../bin/cli.mjs';
import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';

// =============================================================================
// Sprint extension (fleet-sprint/sprint-extension.mjs + its runner.js wiring):
// the Finalization barrier, the extension triggers, the one reopenable Fix-CI
// bead, the bounds (max_extensions, no-progress stop), state that survives a
// pause/resume, the PR-body report, and max_extensions on every launch
// surface. The full-runner paths that issue no new bd command (CI PASS, a
// TIMEOUT retry, FAILED-TO-RUN, extensions disabled) are proved end to end by
// the mock-sprint-ci-gate-finalization / mock-sprint-extension-*.test.mjs
// files; a path that EXTENDS needs a bd stream that can only be recorded
// against a real bd, so it is driven here through the same barrier function
// runner.js calls, pass by pass, with fake beads/sync/CI seams.
// ASCII only.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runnerSource = fs.readFileSync(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf8');

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const record = (outcome, { sha = SHA_A, jobs, runId = '1' } = {}) => ({
    outcome, workflow: 'ci.yml', provider: 'github', repo: 'o/r', branch: 'feat/x', headSha: sha,
    runId, runUrl: `https://ci.example/runs/${runId}`, conclusion: outcome === 'PASS' ? 'success' : 'failure',
    jobs: jobs || (outcome === 'PASS'
        ? [{ name: 'build (a)', conclusion: 'success' }]
        : [{ name: 'build (a)', conclusion: 'success' }, { name: 'test (b)', conclusion: 'failure' }]),
    reason: outcome === 'PASS' ? null : `simulated ${outcome}`,
});

/** A gate handle whose promise resolves when `release()` is called (or at once). */
function gateRun(rec, { held = false, events = null, name = 'run' } = {}) {
    let release;
    const gate = new Promise((r) => { release = r; });
    if (!held) release();
    return {
        workflow: 'ci.yml',
        promise: gate.then(() => { if (events) events.push(`${name}-settled`); return rec; }),
        cancel() {},
        settled: () => false,
        release,
    };
}

/** Fake bead/sync world: records every write in order. */
function fakeWorld({ scope = [] } = {}) {
    const ops = [];
    let nextChild = 1;
    return {
        ops,
        scope,
        command: async (cmd, opts) => {
            assert.ok(opts && opts.member_name, `every command carries member_name: ${cmd}`);
            ops.push(`cmd:${cmd.replace(/"[^"]*"/g, '"<file>"')}`);
            if (cmd.startsWith('node -e')) return { ok: true, output: '/tmp/staged-body.txt' };
            return { ok: true, output: '' };
        },
        bdListScoped: async (rest) => { ops.push(`scope:${rest}`); return scope; },
        createChild: async ({ title, priority }) => {
            const id = `root-1.${nextChild++}`;
            ops.push(`create:${id}:${priority}:${title}`);
            scope.push({ id, title, status: 'open', priority: 1 });
            return { childId: id };
        },
        gitSync: {
            syncBeadsBefore: async (m) => { ops.push(`D-pull:${m}`); },
            pushBeadsAfter: async (m, o) => { ops.push(`D-push:${m}:${o && o.pushBeads}`); },
        },
    };
}

async function barrier(world, state, extra = {}) {
    const logs = [];
    const out = await runFinalizationBarrier({
        log: (l) => logs.push(l),
        state,
        maxExtensions: 1,
        cycleLabel: 3,
        goalMax: 'P2',
        command: world.command, backlogMember: 'orch', parentId: 'root-1',
        bdListScoped: world.bdListScoped, createChild: world.createChild, gitSync: world.gitSync, settle: () => {},
        ...extra,
    });
    return { ...out, logs };
}

describe('the Finalization barrier waits for CI after Final Review, then decides', () => {
    test('barrier ordering: Final Review completes, then the barrier waits for the in-flight CI run, then decides', async () => {
        const events = [];
        const run = gateRun(record('PASS'), { held: true, events, name: 'ci' });
        // Final Review (simulated) completes while CI is still running.
        events.push('final-review-done');
        const pending = awaitCiAtBarrier({ ciGateRun: run, restartCiGate: async () => null, log: (l) => events.push(l.includes('barrier') ? 'barrier-waiting' : 'log') });
        await new Promise((r) => setTimeout(r, 10));
        events.push('ci-released');
        run.release();
        const out = await pending;
        events.push('decided');
        assert.deepEqual(events.filter((e) => e !== 'log'), ['final-review-done', 'barrier-waiting', 'ci-released', 'ci-settled', 'decided']);
        assert.equal(out.record.outcome, 'PASS');
        assert.equal(out.doubleTimeout, false);
    });

    test('no ci_gate and no in-goal finding: no await, no write, no log line (unconfigured sprints unchanged)', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        const out = await barrier(world, state, { finalReview: { newTasks: [{ id: 'root-1.9', title: 'Polish', priority: 'P3' }], reopenedIds: [] } });
        assert.equal(out.extend, false);
        assert.deepEqual(world.ops, []);
        assert.deepEqual(out.logs, []);
        assert.equal(state.count, 0);
        assert.deepEqual(formatExtensionReport({ state, finalDecision: out.decision, ciUnfixable: out.ciUnfixable, ciRecord: out.ciRecord, maxExtensions: 1 }), []);
    });
});

describe('CI outcomes', () => {
    test('TIMEOUT is retried once on the same commit; the retry PASS means no extension', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        let restarts = 0;
        const out = await barrier(world, state, {
            ciGateRun: gateRun(record('TIMEOUT', { runId: '1' })),
            restartCiGate: async () => { restarts += 1; return gateRun(record('PASS', { runId: '1' })); },
        });
        assert.equal(restarts, 1);
        assert.equal(out.extend, false);
        assert.equal(out.ciRecord.outcome, 'PASS');
        assert.equal(out.ciRecord.headSha, SHA_A);
        assert.ok(out.logs.some((l) => l.includes('retrying the CI gate once on the same commit')));
        assert.deepEqual(world.ops, []);
    });

    test('TIMEOUT twice is treated like FAIL: a Fix-CI bead naming the timeout, and an extension', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        let restarts = 0;
        const out = await barrier(world, state, {
            ciGateRun: gateRun(record('TIMEOUT', { jobs: [] })),
            restartCiGate: async () => { restarts += 1; return gateRun(record('TIMEOUT', { jobs: [] })); },
        });
        assert.equal(restarts, 1, 'only one retry');
        assert.equal(out.extend, true);
        const create = world.ops.find((o) => o.startsWith('create:'));
        assert.ok(create && create.includes(':P1:'), world.ops.join('\n'));
        assert.match(out.entry.triggerText, /CI TIMEOUT twice/);
    });

    test('FAILED-TO-RUN never extends, even with budget left: loud log, PR line, no bead', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        const out = await barrier(world, state, { ciGateRun: gateRun(record('FAILED-TO-RUN', { jobs: [] })), maxExtensions: 3 });
        assert.equal(out.extend, false);
        assert.equal(out.ciUnfixable, true);
        assert.deepEqual(world.ops, []);
        assert.ok(out.logs.some((l) => l.includes('ERROR') && l.includes('does NOT trigger a sprint extension')));
        const lines = formatExtensionReport({ state, finalDecision: out.decision, ciUnfixable: out.ciUnfixable, ciRecord: out.ciRecord, maxExtensions: 3 });
        assert.ok(lines.some((l) => l.includes('FAILED-TO-RUN cannot be fixed by a code change')), lines.join('\n'));
    });

    test('classifyCiRecord: PASS/none -> nothing; FAIL -> trigger with failing jobs; single TIMEOUT -> not a trigger', () => {
        assert.deepEqual(classifyCiRecord(null), { trigger: null, unfixable: false });
        assert.deepEqual(classifyCiRecord(record('PASS')), { trigger: null, unfixable: false });
        const fail = classifyCiRecord(record('FAIL'));
        assert.deepEqual(fail.trigger.failingJobs, ['test (b)']);
        assert.equal(fail.trigger.headSha, SHA_A);
        assert.equal(classifyCiRecord(record('TIMEOUT')).trigger, null);
        assert.ok(classifyCiRecord(record('TIMEOUT'), { doubleTimeout: true }).trigger);
    });
});

describe('the Fix-CI bead: one reopenable P1 bead per sprint, written by the orchestrator inside a sync bracket', () => {
    test('CI FAIL -> one P1 Fix-CI child of the first target, its description carries workflow, run url, sha, failing jobs and reason', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        const ciRecord = record('FAIL');
        const out = await barrier(world, state, { ciGateRun: gateRun(ciRecord) });
        assert.equal(out.extend, true);
        assert.deepEqual(world.ops, [
            'D-pull:orch',
            'scope:',
            `create:root-1.1:P1:${fixCiBeadTitle('ci.yml')}`,
            'D-push:orch:true',
        ]);
        assert.equal(state.fixCiBeadId, 'root-1.1');
        assert.equal(state.count, 1);
        assert.deepEqual(out.entry.beads, ['root-1.1']);
        const task = buildFixCiNewTask(classifyCiRecord(ciRecord).trigger, { cycleLabel: 3 });
        const v = validateNewTask(task);
        assert.ok(v.ok, v.reason);
        for (const needle of ['Workflow: ci.yml', ciRecord.runUrl, SHA_A, 'Failing jobs: test (b)', 'simulated FAIL']) {
            assert.ok(v.description.includes(needle), `description carries ${needle}:\n${v.description}`);
        }
        assert.match(v.description, /^[\t\n\r\x20-\x7E]+$/, 'ASCII only');
        assert.doesNotMatch(v.description, /apra-fleet|npm test|deploy\.md/i, 'generic engine text');
    });

    test('a later CI failure reopens and refreshes the SAME bead (recorded in state) instead of creating a duplicate', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        await barrier(world, state, { ciGateRun: gateRun(record('FAIL')), maxExtensions: 2 });
        world.ops.length = 0;
        // Extension 1 ran; a DIFFERENT job fails now (progress, not a repeat).
        const out = await barrier(world, state, {
            ciGateRun: gateRun(record('FAIL', { sha: SHA_B, runId: '2', jobs: [{ name: 'lint', conclusion: 'failure' }] })),
            maxExtensions: 2,
        });
        assert.equal(out.extend, true);
        assert.ok(!world.ops.some((o) => o.startsWith('create:')), world.ops.join('\n'));
        assert.deepEqual(world.ops.filter((o) => o.startsWith('cmd:bd')), ['cmd:bd update root-1.1 --status=open', 'cmd:bd note root-1.1 --file "<file>"']);
        assert.equal(world.ops[0], 'D-pull:orch');
        assert.equal(world.ops[world.ops.length - 1], 'D-push:orch:true');
        assert.equal(state.count, 2);
        assert.match(state.history[0].outcome, /^not resolved/);
    });

    test('resume: a resumed sprint (state carried) or a relaunched one (bead already in scope) never duplicates the Fix-CI bead', async () => {
        // In-process pause/resume: the state object is the sprint's own and is
        // carried through; a second barrier for the same failure reopens.
        const sprintState = createSprintState({});
        assert.deepEqual(sprintState.extension, createExtensionState(), 'createSprintState owns the extension state');
        sprintState.extension.fixCiBeadId = 'root-1.4';
        const resumed = fakeWorld();
        await barrier(resumed, sprintState.extension, { ciGateRun: gateRun(record('FAIL')) });
        assert.ok(!resumed.ops.some((o) => o.startsWith('create:')));
        assert.ok(resumed.ops.includes('cmd:bd update root-1.4 --status=open'));
        assert.equal(sprintState.extension.count, 1, 'counted once');
        // Relaunch: fresh state, but the bead with the same title is in scope.
        const relaunched = fakeWorld({ scope: [{ id: 'root-1.7', title: fixCiBeadTitle('ci.yml'), status: 'closed' }] });
        const fresh = createExtensionState();
        const out = await barrier(relaunched, fresh, { ciGateRun: gateRun(record('FAIL')) });
        assert.equal(out.extend, true);
        assert.ok(!relaunched.ops.some((o) => o.startsWith('create:')), relaunched.ops.join('\n'));
        assert.ok(relaunched.ops.includes('cmd:bd update root-1.7 --status=open'));
        assert.equal(fresh.fixCiBeadId, 'root-1.7');
    });

    test('a Fix-CI bead that cannot be written does not start an empty extension', async () => {
        const world = fakeWorld();
        world.createChild = async () => { throw new Error('bd create refused'); };
        const state = createExtensionState();
        const out = await barrier(world, state, { ciGateRun: gateRun(record('FAIL')) });
        assert.equal(out.extend, false);
        assert.equal(state.count, 0);
        assert.ok(out.logs.some((l) => l.includes('NOT extending the sprint (the Fix-CI bead could not be written')));
        assert.ok(world.ops.includes('D-push:orch:true'), 'the notes fallback is still pushed');
    });
});

describe('Final Review findings as triggers', () => {
    test('an in-goal newTask (priority at or above the goal ceiling) extends; it is already a bead, so nothing is written', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        const out = await barrier(world, state, { finalReview: { newTasks: [{ id: 'root-1.5', title: 'Handle the empty list', priority: 'P2' }], reopenedIds: [] } });
        assert.equal(out.extend, true);
        assert.deepEqual(world.ops, [], 'no bead write and no bracket: Final Review already persisted it');
        assert.deepEqual(out.entry.beads, ['root-1.5']);
        assert.match(out.entry.triggerText, /in-goal Final Review finding\(s\): "Handle the empty list" \(P2, root-1\.5\)/);
    });

    test('a guarded Final Review reopen extends', async () => {
        const out = await barrier(fakeWorld(), createExtensionState(), { finalReview: { newTasks: [], reopenedIds: ['root-1.2'] } });
        assert.equal(out.extend, true);
        assert.deepEqual(out.entry.beads, ['root-1.2']);
    });

    test('a below-goal newTask does NOT extend (it stays owed triage)', async () => {
        const out = await barrier(fakeWorld(), createExtensionState(), { finalReview: { newTasks: [{ id: 'root-1.6', title: 'Nice to have', priority: 'P3' }], reopenedIds: [] } });
        assert.equal(out.extend, false);
        assert.equal(out.decision.hasTrigger, false);
        assert.equal(isInGoalPriority('P1', 'P2'), true);
        assert.equal(isInGoalPriority('P2', 'P2'), true);
        assert.equal(isInGoalPriority('P3', 'P2'), false);
        assert.equal(isInGoalPriority('P0', 'P1'), true);
    });
});

describe('bounds', () => {
    test('max_extensions 0: a trigger is reported but never extended (today\'s behaviour)', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        const out = await barrier(world, state, { ciGateRun: gateRun(record('FAIL')), maxExtensions: 0 });
        assert.equal(out.extend, false);
        assert.deepEqual(world.ops, []);
        const lines = formatExtensionReport({ state, finalDecision: out.decision, ciUnfixable: false, ciRecord: out.ciRecord, maxExtensions: 0 });
        assert.deepEqual(lines, ['No further extension: sprint extensions are disabled (max_extensions 0)', 'Extensions used: 0 of at most 0.']);
    });

    test('no-progress stop: the same failing job set after an extension stops extending, says why, even with budget left', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        await barrier(world, state, { ciGateRun: gateRun(record('FAIL', { runId: '1' })), maxExtensions: 3 });
        const out = await barrier(world, state, { ciGateRun: gateRun(record('FAIL', { sha: SHA_B, runId: '2' })), maxExtensions: 3, cycleLabel: 4 });
        assert.equal(out.extend, false);
        assert.equal(out.decision.noProgress, true);
        assert.equal(out.decision.reason, 'Extension 1 did not resolve: CI still failing on the same jobs (test (b)); not extending again (no progress).');
        assert.equal(state.count, 1);
        const lines = formatExtensionReport({ state, finalDecision: out.decision, ciUnfixable: false, ciRecord: out.ciRecord, maxExtensions: 3 });
        assert.match(lines[0], /^Extension 1 \(after cycle 3\): trigger: CI FAIL on workflow 'ci\.yml'.*beads: root-1\.1; outcome: not resolved -- Extension 1 did not resolve/);
        assert.equal(lines[1], `No further extension: ${out.decision.reason}`);
    });

    test('no-progress stop on the same in-goal finding titles', () => {
        const state = createExtensionState();
        const findings = { newTasks: [{ id: 'a', title: 'Fix the parser', priority: 'P1' }], reopenedIds: [] };
        state.count = 1;
        state.history.push({ index: 1, ciKey: null, findingKey: 'task:Fix the parser', outcome: null });
        const d = decideExtension({ state, maxExtensions: 5, ciTrigger: null, findings: { ...findings, newTasks: [{ id: 'b', title: 'Fix the parser', priority: 'P1' }] } });
        assert.equal(d.extend, false);
        assert.equal(d.noProgress, true);
        assert.match(d.reason, /the same in-goal Final Review finding\(s\) remain/);
    });

    test('budget spent: max_extensions 1 allows exactly one extension', () => {
        const state = createExtensionState();
        state.count = 1;
        state.history.push({ index: 1, ciKey: 'FAIL:x', findingKey: null, outcome: null });
        const d = decideExtension({ state, maxExtensions: 1, ciTrigger: { outcome: 'FAIL', failingJobs: ['y'] }, findings: { newTasks: [], reopenedIds: [] } });
        assert.equal(d.extend, false);
        assert.match(d.reason, /extension budget is spent \(max_extensions 1, 1 used\)/);
    });
});

describe('the full extension path, pass by pass (CI FAIL -> Fix-CI -> extension -> second Finalization, new CI run -> PASS)', () => {
    test('each Finalization pass awaits its OWN gate run; the second PASS closes the extension as resolved', async () => {
        const world = fakeWorld();
        const state = createExtensionState();
        const started = [];
        const startRun = (rec) => { started.push(rec.headSha); return gateRun(rec); };
        // Pass 1: Finalization after cycle 1, CI FAIL on SHA_A.
        const pass1 = await barrier(world, state, { ciGateRun: startRun(record('FAIL', { sha: SHA_A, runId: '1' })), cycleLabel: 1 });
        assert.equal(pass1.extend, true);
        // runner.js: the extension's cycles follow the last cycle run, with
        // their own budget independent of max_cycles.
        const nextCycle = 1 + 1;
        const ceiling = nextCycle + EXTENSION_CYCLE_BUDGET - 1;
        assert.equal(ceiling, 2, 'one extension cycle');
        // ...the extension cycle fixes the code and closes the Fix-CI bead...
        // Pass 2: Finalization after cycle 2 starts a NEW run on the new head.
        const pass2 = await barrier(world, state, { ciGateRun: startRun(record('PASS', { sha: SHA_B, runId: '2' })), cycleLabel: 2 });
        assert.equal(pass2.extend, false);
        assert.deepEqual(started, [SHA_A, SHA_B], 'two runs, each on its own head');
        assert.match(state.history[0].outcome, /^resolved -- the next Finalization found CI PASS/);
        const lines = formatExtensionReport({ state, finalDecision: pass2.decision, ciUnfixable: pass2.ciUnfixable, ciRecord: pass2.ciRecord, maxExtensions: 1 });
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^Extension 1 \(after cycle 1\): trigger: CI FAIL on workflow 'ci\.yml' \(failing jobs: test \(b\); run https:\/\/ci\.example\/runs\/1; commit a+\); beads: root-1\.1; outcome: resolved/);
        assert.equal(lines[1], 'Extensions used: 1 of at most 1.');
    });

    test('the re-run Final Review is a NEW reviewer session, never a resume of the earlier one', () => {
        const p = policyFor('final-review');
        assert.deepEqual(p.resumeArg, { kind: 'fresh-session' });
    });
});

describe('runner.js wiring (source pins)', () => {
    test('the cycle loop runs under a per-Finalization-pass loop with its own ceiling; an extension re-enters it with EXTENSION_CYCLE_BUDGET, independent of MAX_CYCLES', () => {
        assert.ok(runnerSource.includes('    for (;;) {\n    while (cycle <= cycleCeiling) {'));
        assert.ok(!runnerSource.includes('while (cycle <= MAX_CYCLES)'), 'the loop reads cycleCeiling, not MAX_CYCLES');
        const barrierIdx = runnerSource.indexOf('await runFinalizationBarrier({');
        const tail = runnerSource.slice(barrierIdx, runnerSource.indexOf('\n    break;\n    }\n', barrierIdx));
        assert.match(tail, /cycle = finalCycleLabel \+ 1;\n\s+cycleCeiling = cycle \+ EXTENSION_CYCLE_BUDGET - 1;/);
        assert.match(tail, /continue;/);
        assert.ok(runnerSource.includes('finalCycleLabel = Math.min(cycle, cycleCeiling);'));
    });

    test('the barrier sits between Final Review and Regression/Harvest/Publish, and Publish PR gets the awaited record, never the in-flight handle', () => {
        const fr = runnerSource.indexOf('await runFinalReviewPhase({');
        const b = runnerSource.indexOf('await runFinalizationBarrier({');
        const reg = runnerSource.indexOf('await runRegressionTestPhase({');
        const harvest = runnerSource.indexOf('await runHarvestPhase({');
        const publish = runnerSource.indexOf('await runPublishPrPhase({');
        assert.ok(fr > 0 && fr < b && b < reg && reg < harvest && harvest < publish);
        const publishCall = runnerSource.slice(publish, runnerSource.indexOf('});', publish));
        assert.match(publishCall, /ciGateRecord: lastCiGateRecord/);
        assert.doesNotMatch(publishCall, /ciGateRun/);
    });
});

describe('max_extensions on every launch surface', () => {
    const RUNNER_BASE = { targetIssues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', maxCycles: 1 };

    test('runner validateArgs: default 1, 0 allowed, non-integer/negative/string rejected', () => {
        assert.equal(DEFAULT_MAX_EXTENSIONS, 1);
        assert.equal(validateArgs(buildRunnerArgs(RUNNER_BASE)).maxExtensions, 1);
        assert.equal(validateArgs(buildRunnerArgs({ ...RUNNER_BASE, maxExtensions: 0 })).maxExtensions, 0);
        assert.equal(validateArgs(buildRunnerArgs({ ...RUNNER_BASE, maxExtensions: 3 })).maxExtensions, 3);
        for (const bad of [-1, 1.5, '1', Number.NaN, true]) {
            assert.throws(() => validateMaxExtensions(bad), /\[Arg Contract\] Invalid max_extensions/);
            assert.throws(() => validateArgs({ ...buildRunnerArgs(RUNNER_BASE), max_extensions: bad }), /Invalid max_extensions/);
        }
    });

    test('CLI: --max-extensions is parsed strictly and forwarded only when set', () => {
        assert.equal(parseMaxExtensionsFlag(undefined), undefined);
        assert.equal(parseMaxExtensionsFlag('0'), 0);
        assert.equal(parseMaxExtensionsFlag(' 2 '), 2);
        for (const bad of ['', '-1', '1.5', '1e0', 'two']) assert.ok(Number.isNaN(parseMaxExtensionsFlag(bad)), bad);
        assert.equal('max_extensions' in buildRunnerArgs(RUNNER_BASE), false);
        assert.equal(buildRunnerArgs({ ...RUNNER_BASE, maxExtensions: 0 }).max_extensions, 0);
    });

    test('spawner: --max-extensions in argv only when set', () => {
        const base = { issue: 'PROJ-1', members: 'm1', branch: 'feat/x', base: 'main', viewerPort: 9100 };
        const argv = buildSprintArgv({ ...base, maxExtensions: 0 });
        assert.equal(argv[argv.indexOf('--max-extensions') + 1], '0');
        assert.equal(buildSprintArgv(base).includes('--max-extensions'), false);
    });

    async function makeController(captured) {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maxext-api-'));
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-10-15T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-10-15T00:00:00.000Z' });
        await history.start();
        let nextPid = 7300;
        const spawner = createSpawner({
            basePort: 9500,
            isPortAvailable: async () => true,
            dataDir: 'fake-data-dir',
            fs: { mkdirSync() {}, openSync() { return 3; }, closeSync() {} },
            spawn: (command, args) => {
                const pid = nextPid++;
                captured.push({ command, args, pid });
                return { pid, once() { return this; }, unref() {} };
            },
        });
        const controller = createSprintController({ ledger, history, spawner, listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }) });
        return { controller, dir };
    }
    const LAUNCH = { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' };
    const argOf = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

    test('supervisor POST /api/sprints: max_extensions (or maxExtensions) reaches the child as --max-extensions; absent leaves it off', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        await controller.launch({ ...LAUNCH, branch: 'feat/a', max_extensions: 0 });
        await controller.launch({ ...LAUNCH, branch: 'feat/b', issue: 'PROJ-2', members: ['bob'], maxExtensions: 2 });
        await controller.launch({ ...LAUNCH, branch: 'feat/c', issue: 'PROJ-3', members: ['carol'] });
        assert.equal(argOf(captured[0].args, '--max-extensions'), '0');
        assert.equal(argOf(captured[1].args, '--max-extensions'), '2');
        assert.equal(captured[2].args.includes('--max-extensions'), false);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    for (const bad of [-1, 1.5, '1', 'many', true]) {
        test(`supervisor rejects max_extensions ${JSON.stringify(bad)} with a 400 on field max_extensions and spawns nothing`, async () => {
            const captured = [];
            const { controller, dir } = await makeController(captured);
            await assert.rejects(
                () => controller.launch({ ...LAUNCH, max_extensions: bad }),
                (err) => err instanceof ApiError && err.status === 400 && err.field === 'max_extensions',
            );
            assert.equal(captured.length, 0);
            await fsp.rm(dir, { recursive: true, force: true });
        });
    }
});
