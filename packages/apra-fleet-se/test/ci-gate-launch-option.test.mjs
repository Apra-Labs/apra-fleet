import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { validateArgs } from '../fleet-sprint/sprint-args.mjs';
import { buildRunnerArgs } from '../bin/cli.mjs';
import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { buildLaunchRequestBody } from '../src/supervisor/launch-form.mjs';

// =============================================================================
// The ci_gate launch option on every launch surface: CLI (--ci-gate ->
// buildRunnerArgs -> runner validateArgs), supervisor POST /api/sprints
// (ci_gate -> validated 400 -> child --ci-gate argv) and the dashboard launch
// form (optional CI workflow field -> body.ci_gate). Each forwards it only
// when set, so a launch without it is byte-identical to before.
// ASCII only.
// =============================================================================

const RUNNER_BASE = { targetIssues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', maxCycles: 1 };

describe('cli.mjs buildRunnerArgs: --ci-gate', () => {
    test('forwards the raw JSON as ci_gate only when set, and the runner validates it', () => {
        const raw = '{"workflow":"ci.yml","timeout_s":1200}';
        const args = buildRunnerArgs({ ...RUNNER_BASE, ciGate: raw });
        assert.equal(args.ci_gate, raw);
        assert.deepEqual(validateArgs(args).ciGate, { workflow: 'ci.yml', timeoutS: 1200 });
        assert.equal('ci_gate' in buildRunnerArgs({ ...RUNNER_BASE }), false);
        assert.equal(validateArgs(buildRunnerArgs({ ...RUNNER_BASE })).ciGate, undefined);
    });
});

describe('spawner buildSprintArgv: --ci-gate', () => {
    const base = { issue: 'PROJ-1', members: 'm1', branch: 'feat/x', base: 'main', viewerPort: 9100 };
    test('emits the flag and its JSON only when ciGate is set', () => {
        const argv = buildSprintArgv({ ...base, ciGate: '{"workflow":"ci.yml","timeout_s":3600}' });
        const i = argv.indexOf('--ci-gate');
        assert.ok(i >= 0);
        assert.equal(argv[i + 1], '{"workflow":"ci.yml","timeout_s":3600}');
        assert.equal(buildSprintArgv({ ...base }).includes('--ci-gate'), false);
    });
});

describe('supervisor POST /api/sprints: ci_gate', () => {
    async function makeController(captured) {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cigate-api-'));
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-10-01T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-10-01T00:00:00.000Z' });
        await history.start();
        let nextPid = 7100;
        const spawner = createSpawner({
            basePort: 9400,
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
    const argOf = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

    test('an object or JSON-string ci_gate (or the ciGate alias) reaches the child as normalized --ci-gate JSON', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        await controller.launch({ ...LAUNCH, branch: 'feat/a', ci_gate: { workflow: 'ci.yml' } });
        await controller.launch({ ...LAUNCH, branch: 'feat/b', issue: 'PROJ-2', members: ['bob'], ci_gate: '{"workflow":"ci.yml","timeout_s":900}' });
        await controller.launch({ ...LAUNCH, branch: 'feat/c', issue: 'PROJ-3', members: ['carol'], ciGate: { workflow: '12345', timeout_s: 60 } });
        assert.equal(captured.length, 3);
        assert.equal(argOf(captured[0].args, '--ci-gate'), '{"workflow":"ci.yml","timeout_s":3600}');
        assert.equal(argOf(captured[1].args, '--ci-gate'), '{"workflow":"ci.yml","timeout_s":900}');
        assert.equal(argOf(captured[2].args, '--ci-gate'), '{"workflow":"12345","timeout_s":60}');
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('no ci_gate leaves the flag off', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        await controller.launch({ ...LAUNCH });
        assert.equal(captured[0].args.includes('--ci-gate'), false);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    for (const [label, ciGate] of [
        ['a missing workflow', { timeout_s: 60 }],
        ['an unsafe workflow name', { workflow: 'ci.yml; rm -rf /' }],
        ['a non-positive timeout', { workflow: 'ci.yml', timeout_s: 0 }],
        ['bad JSON', '{nope'],
        ['an unknown key', { workflow: 'ci.yml', on: 'push' }],
    ]) {
        test(`rejects ${label} with a 400 on field ci_gate and spawns nothing`, async () => {
            const captured = [];
            const { controller, dir } = await makeController(captured);
            await assert.rejects(
                () => controller.launch({ ...LAUNCH, ci_gate: ciGate }),
                (err) => err instanceof ApiError && err.status === 400 && err.field === 'ci_gate',
            );
            assert.equal(captured.length, 0);
            await fsp.rm(dir, { recursive: true, force: true });
        });
    }
});

describe('dashboard launch form: optional CI workflow', () => {
    const input = { selectedRoots: ['PROJ-1'], members: ['alice'], goal: 'P1/P2', branch: 'feat/x', base: 'main' };
    test('a filled-in workflow becomes body.ci_gate; empty or whitespace leaves the body unchanged', () => {
        assert.deepEqual(buildLaunchRequestBody({ ...input, ciWorkflow: ' ci.yml ' }).body.ci_gate, { workflow: 'ci.yml' });
        assert.equal('ci_gate' in buildLaunchRequestBody({ ...input, ciWorkflow: '   ' }).body, false);
        assert.equal('ci_gate' in buildLaunchRequestBody({ ...input }).body, false);
    });
});

describe('dashboard launch form: fix-up rounds (max_extensions)', () => {
    const input = { selectedRoots: ['PROJ-1'], members: ['alice'], goal: 'P1/P2', branch: 'feat/x', base: 'main' };
    test('a filled-in whole number becomes body.max_extensions, 0 included; empty leaves the body unchanged', () => {
        assert.equal(buildLaunchRequestBody({ ...input, fixUpRounds: ' 2 ' }).body.max_extensions, 2);
        assert.equal(buildLaunchRequestBody({ ...input, fixUpRounds: '0' }).body.max_extensions, 0);
        assert.equal('max_extensions' in buildLaunchRequestBody({ ...input, fixUpRounds: '' }).body, false);
        assert.equal('max_extensions' in buildLaunchRequestBody({ ...input }).body, false);
    });
    test('a negative, fractional or non-numeric value is rejected before any request is sent', () => {
        for (const bad of ['-1', '1.5', 'two']) {
            const r = buildLaunchRequestBody({ ...input, fixUpRounds: bad });
            assert.equal(r.ok, false, bad);
            assert.match(r.error, /Fix-up rounds/);
        }
    });
});
