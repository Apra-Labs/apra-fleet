import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { validateArgs } from '../fleet-sprint/sprint-args.mjs';
import { buildAnalysisText } from '../fleet-sprint/sprint-report.mjs';
import { buildRunnerArgs } from '../bin/cli.mjs';
import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// The regression pass can be skipped by an explicit LAUNCH OPTION:
//   supervisor POST /api/sprints  { phases: { regression: "skip" } }
//   -> spawner argv --skip-regression -> cli.mjs -> runner arg skip_regression
//   -> the engine skips the phase and says so in the log, the sprint analysis
//      and the PR body (never silently).

const BASE_ARGS = { target_issues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', base_branch: 'main' };

describe('runner arg contract: skip_regression', () => {
    test('defaults to false when omitted', () => {
        assert.equal(validateArgs({ ...BASE_ARGS }).skipRegression, false);
    });
    test('accepts true', () => {
        assert.equal(validateArgs({ ...BASE_ARGS, skip_regression: true }).skipRegression, true);
    });
    test('rejects a non-boolean value loudly', () => {
        assert.throws(() => validateArgs({ ...BASE_ARGS, skip_regression: 'yes' }), /Invalid skip_regression/);
    });
});

describe('cli.mjs buildRunnerArgs: --skip-regression', () => {
    const base = { targetIssues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', maxCycles: 1 };
    test('forwards skip_regression only when set', () => {
        assert.equal(buildRunnerArgs({ ...base, skipRegression: true }).skip_regression, true);
        assert.equal('skip_regression' in buildRunnerArgs({ ...base, skipRegression: false }), false);
        assert.equal('skip_regression' in buildRunnerArgs({ ...base }), false);
    });
});

describe('spawner buildSprintArgv: --skip-regression', () => {
    const base = { issue: 'PROJ-1', members: 'm1', branch: 'feat/x', base: 'main', viewerPort: 9100 };
    test('emits the flag only when skipRegression is true', () => {
        assert.ok(buildSprintArgv({ ...base, skipRegression: true }).includes('--skip-regression'));
        assert.equal(buildSprintArgv({ ...base }).includes('--skip-regression'), false);
    });
});

describe('supervisor POST /api/sprints: phases.regression', () => {
    async function makeController(captured) {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'skipreg-api-'));
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-10-01T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-10-01T00:00:00.000Z' });
        await history.start();
        let nextPid = 7000;
        const spawner = createSpawner({
            basePort: 9300,
            isPortAvailable: async () => true,
            dataDir: 'fake-data-dir',
            fs: { mkdirSync() {}, openSync() { return 3; }, closeSync() {} },
            spawn: (command, args) => {
                const pid = nextPid++;
                captured.push({ command, args, pid });
                return { pid, once() { return this; }, unref() {} };
            },
        });
        const controller = createSprintController({
            ledger, history, spawner,
            listMembers: () => ({ members: [] }),
            getBacklog: () => ({ tasks: [] }),
        });
        return { controller, dir };
    }
    const LAUNCH = { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' };

    test('phases.regression "skip" reaches the child argv as --skip-regression', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        await controller.launch({ ...LAUNCH, phases: { regression: 'skip' } });
        assert.equal(captured.length, 1);
        assert.ok(captured[0].args.includes('--skip-regression'));
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('no phases, or phases.regression "run", leaves the flag off', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        await controller.launch({ ...LAUNCH, branch: 'feat/a' });
        await controller.launch({ ...LAUNCH, branch: 'feat/b', issue: 'PROJ-2', members: ['bob'], phases: { regression: 'run' } });
        assert.equal(captured.length, 2);
        for (const c of captured) assert.equal(c.args.includes('--skip-regression'), false);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    for (const [label, phases] of [
        ['an unknown regression value', { regression: 'later' }],
        ['an unknown phase key', { integration: 'skip' }],
        ['a non-object', 'skip'],
    ]) {
        test(`rejects ${label} with a 400 and spawns nothing`, async () => {
            const captured = [];
            const { controller, dir } = await makeController(captured);
            await assert.rejects(
                () => controller.launch({ ...LAUNCH, phases }),
                (err) => err instanceof ApiError && err.status === 400 && err.field === 'phases',
            );
            assert.equal(captured.length, 0);
            await fsp.rm(dir, { recursive: true, force: true });
        });
    }
});

describe('sprint analysis: a skipped pass is reported as skipped', () => {
    const base = {
        targetIssues: ['PROJ-1'], branch: 'feat/x', baseBranch: 'main', cyclesRun: 1,
        closedCountHistory: [1], highWaterClosedCount: 1, deployFailures: [], integFailures: [],
        rejectedNewTasks: [], finalVerdictResult: { status: 'PASS', notes: '' },
        finalClosedCount: 1, finalOpenAtGoalCount: 0,
    };
    test('says "skipped by launch option", not "no playbook"', () => {
        const text = buildAnalysisText({ ...base, regressionSkippedBy: 'launch option' });
        assert.match(text, /Regression pass: skipped by launch option -- not run this sprint\./);
        assert.doesNotMatch(text, /no regression-test-playbook\.md/);
    });
    test('unchanged when not skipped', () => {
        assert.match(buildAnalysisText({ ...base }), /no regression-test-playbook\.md/);
    });
});

test('mock sprint: skip_regression skips the phase even though the regression playbook exists', { timeout: 300000 }, async () => {
    const run = await withScenarioMarkers('skipregression', async () => runDevelopLoopScenario('skipregression', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: skip-regression scenario work' }],
        maxCycles: 1,
        withRegressionPlaybook: true,
        skipRegression: true,
        regressionHandler: () => { throw new Error('regression-test-runner must not be dispatched when skip_regression is set'); },
    }));

    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    assert.equal(run.dispatched.some((d) => d.agent === 'regression-test-runner'), false, 'no regression-test-runner dispatch');
    assert.ok(run.logs.some((l) => /Skipping Regression Test Phase: skipped by launch option/.test(l)), 'loud skip log line');
    assert.equal(run.logs.some((l) => /no regression-test-playbook\.md found/.test(l)), false, 'not misreported as a missing playbook');
});
