import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { validateArgs, HARVEST_MODES } from '../fleet-sprint/sprint-args.mjs';
import { planHarvestOutputs } from '../fleet-sprint/phases/harvest.mjs';
import { buildHarvesterPrompt } from '../fleet-sprint/prompts.mjs';
import { buildRunnerArgs, parseCliArgs } from '../bin/cli.mjs';
import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { runDevelopLoopScenario, withScenarioMarkers, checkHarvesterContract } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// harvest_mode launch option: what the end-of-sprint harvester may write into
// the TARGET repo.
//
//   full (default)  -- today's behaviour: sprint analysis under docs/, durable
//                      docs under docs/, README edits.
//   docs-dir        -- analysis + docs under harvest_docs_dir only, no README.
//   pr-body-only    -- no harvester file writes or commits; the engine puts
//                      the sprint analysis in the PR body.
//   off             -- no harvester file writes or commits, no analysis in the
//                      PR body; KB capture and low-priority deferral still run.
//
// In EVERY mode the engine's cost block stays out of anything committed: it
// goes to the PR body and the run log only.
//
// Threading mirrors skip_regression end to end:
//   supervisor POST /api/sprints { harvestMode, harvestDocsDir }
//   -> spawner argv --harvest-mode/--harvest-docs-dir -> cli.mjs
//   -> runner args harvest_mode/harvest_docs_dir -> validateArgs.
//
// ASCII only.
// =============================================================================

const BASE_ARGS = { target_issues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', base_branch: 'main' };

describe('runner arg contract: harvest_mode / harvest_docs_dir', () => {
    test('unset means full, with no docs dir', () => {
        const v = validateArgs({ ...BASE_ARGS });
        assert.equal(v.harvestMode, 'full');
        assert.equal(v.harvestDocsDir, null);
    });
    test('the documented mode set', () => {
        assert.deepEqual([...HARVEST_MODES].sort(), ['docs-dir', 'full', 'off', 'pr-body-only']);
    });
    for (const mode of ['off', 'pr-body-only', 'full']) {
        test(`accepts ${mode} without a docs dir`, () => {
            const v = validateArgs({ ...BASE_ARGS, harvest_mode: mode });
            assert.equal(v.harvestMode, mode);
            assert.equal(v.harvestDocsDir, null);
        });
    }
    test('accepts docs-dir with a safe relative dir', () => {
        for (const dir of ['notes', 'notes/sprints', '.github/sprint-notes', 'a_b-c.d/e']) {
            const v = validateArgs({ ...BASE_ARGS, harvest_mode: 'docs-dir', harvest_docs_dir: dir });
            assert.equal(v.harvestMode, 'docs-dir');
            assert.equal(v.harvestDocsDir, dir);
        }
    });
    test('a single trailing slash is normalized away', () => {
        assert.equal(validateArgs({ ...BASE_ARGS, harvest_mode: 'docs-dir', harvest_docs_dir: 'notes/' }).harvestDocsDir, 'notes');
    });
    test('rejects an unknown mode loudly', () => {
        assert.throws(() => validateArgs({ ...BASE_ARGS, harvest_mode: 'docs' }), /Invalid harvest_mode/);
        assert.throws(() => validateArgs({ ...BASE_ARGS, harvest_mode: true }), /Invalid harvest_mode/);
    });
    test('docs-dir without a dir is rejected', () => {
        assert.throws(() => validateArgs({ ...BASE_ARGS, harvest_mode: 'docs-dir' }), /harvest_docs_dir is required/);
        assert.throws(() => validateArgs({ ...BASE_ARGS, harvest_mode: 'docs-dir', harvest_docs_dir: '' }), /Invalid harvest_docs_dir/);
    });
    test('a dir without docs-dir is rejected (required if and only if)', () => {
        assert.throws(() => validateArgs({ ...BASE_ARGS, harvest_docs_dir: 'notes' }), /harvest_docs_dir is only valid with harvest_mode "docs-dir"/);
        assert.throws(() => validateArgs({ ...BASE_ARGS, harvest_mode: 'full', harvest_docs_dir: 'notes' }), /harvest_docs_dir is only valid/);
    });
    for (const bad of [
        '/abs/path', '\\abs', 'C:\\docs', 'C:/docs', 'c:docs', '\\\\server\\share', '//server/share',
        '..', '../docs', 'docs/..', 'docs/../etc', 'a/..b', 'docs\\sub', 'my docs', '$HOME/docs', '~/docs',
        'docs//sub', '.', './docs', 'docs/./sub', '.git', 'sub/.git/hooks', 'docs;rm', 'docs`x`', 'docs"x',
        'x'.repeat(201),
    ]) {
        test(`rejects unsafe harvest_docs_dir ${JSON.stringify(bad.length > 40 ? `${bad.slice(0, 10)}...` : bad)}`, () => {
            assert.throws(
                () => validateArgs({ ...BASE_ARGS, harvest_mode: 'docs-dir', harvest_docs_dir: bad }),
                /Invalid harvest_docs_dir/,
            );
        });
    }
});

describe('cli.mjs: --harvest-mode / --harvest-docs-dir', () => {
    const base = { targetIssues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', maxCycles: 1 };
    test('parseCliArgs accepts both flags', () => {
        const { values } = parseCliArgs(['-i', 'PROJ-1', '-m', 'm1', '-b', 'feat/x', '-B', 'main', '--harvest-mode', 'docs-dir', '--harvest-docs-dir', 'notes']);
        assert.equal(values['harvest-mode'], 'docs-dir');
        assert.equal(values['harvest-docs-dir'], 'notes');
    });
    test('buildRunnerArgs forwards them only when set', () => {
        const a = buildRunnerArgs({ ...base, harvestMode: 'docs-dir', harvestDocsDir: 'notes' });
        assert.equal(a.harvest_mode, 'docs-dir');
        assert.equal(a.harvest_docs_dir, 'notes');
        const d = buildRunnerArgs({ ...base });
        assert.equal('harvest_mode' in d, false);
        assert.equal('harvest_docs_dir' in d, false);
    });
});

describe('spawner buildSprintArgv: --harvest-mode / --harvest-docs-dir', () => {
    const base = { issue: 'PROJ-1', members: 'm1', branch: 'feat/x', base: 'main', viewerPort: 9100 };
    test('emits the flags only when set', () => {
        const argv = buildSprintArgv({ ...base, harvestMode: 'docs-dir', harvestDocsDir: 'notes/sprints' });
        assert.deepEqual(argv.slice(argv.indexOf('--harvest-mode'), argv.indexOf('--harvest-mode') + 2), ['--harvest-mode', 'docs-dir']);
        assert.deepEqual(argv.slice(argv.indexOf('--harvest-docs-dir'), argv.indexOf('--harvest-docs-dir') + 2), ['--harvest-docs-dir', 'notes/sprints']);
        const plain = buildSprintArgv({ ...base });
        assert.equal(plain.includes('--harvest-mode'), false);
        assert.equal(plain.includes('--harvest-docs-dir'), false);
    });
});

describe('supervisor POST /api/sprints: harvestMode / harvestDocsDir', () => {
    async function makeController(captured) {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harvestmode-api-'));
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

    test('harvestMode + harvestDocsDir reach the child argv', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        await controller.launch({ ...LAUNCH, harvestMode: 'docs-dir', harvestDocsDir: 'notes/sprints' });
        assert.equal(captured.length, 1);
        const args = captured[0].args;
        assert.equal(args[args.indexOf('--harvest-mode') + 1], 'docs-dir');
        assert.equal(args[args.indexOf('--harvest-docs-dir') + 1], 'notes/sprints');
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('omitted leaves both flags off (the child defaults to full)', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        await controller.launch({ ...LAUNCH });
        assert.equal(captured[0].args.includes('--harvest-mode'), false);
        assert.equal(captured[0].args.includes('--harvest-docs-dir'), false);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    for (const [label, body, field] of [
        ['an unknown mode', { harvestMode: 'sometimes' }, 'harvestMode'],
        ['docs-dir with no dir', { harvestMode: 'docs-dir' }, 'harvestDocsDir'],
        ['an absolute dir', { harvestMode: 'docs-dir', harvestDocsDir: '/etc' }, 'harvestDocsDir'],
        ['a dir with ..', { harvestMode: 'docs-dir', harvestDocsDir: 'docs/../..' }, 'harvestDocsDir'],
        ['a dir with a non-docs-dir mode', { harvestMode: 'full', harvestDocsDir: 'notes' }, 'harvestDocsDir'],
    ]) {
        test(`rejects ${label} with a 400 and spawns nothing`, async () => {
            const captured = [];
            const { controller, dir } = await makeController(captured);
            await assert.rejects(
                () => controller.launch({ ...LAUNCH, ...body }),
                (err) => err instanceof ApiError && err.status === 400 && err.field === field,
            );
            assert.equal(captured.length, 0);
            await fsp.rm(dir, { recursive: true, force: true });
        });
    }
});

describe('planHarvestOutputs: what each mode writes and where the analysis goes', () => {
    const reportText = '# Sprint Analysis: feat/x\n\n## Progress\n\nFinal closed count: 2.';
    const common = { branchSlug: 'feat-x-1234abcd', reportText };

    test('full: analysis under docs/, nothing extra in the PR body', () => {
        const p = planHarvestOutputs({ ...common, harvestMode: 'full', harvestDocsDir: null });
        assert.equal(p.analysisArtifactFile, 'docs/sprint-analysis-feat-x-1234abcd.md');
        assert.equal(p.harvesterAnalysisText, reportText);
        assert.equal(p.prAnalysis, '');
    });
    test('docs-dir: analysis under the configured dir', () => {
        const p = planHarvestOutputs({ ...common, harvestMode: 'docs-dir', harvestDocsDir: 'notes/sprints' });
        assert.equal(p.analysisArtifactFile, 'notes/sprints/sprint-analysis-feat-x-1234abcd.md');
        assert.equal(p.prAnalysis, '');
    });
    test('pr-body-only: no artifact file; the analysis goes to the PR body', () => {
        const p = planHarvestOutputs({ ...common, harvestMode: 'pr-body-only', harvestDocsDir: null });
        assert.equal(p.analysisArtifactFile, null);
        assert.equal(p.prAnalysis, reportText);
    });
    test('off: no artifact file and no PR-body analysis', () => {
        const p = planHarvestOutputs({ ...common, harvestMode: 'off', harvestDocsDir: null });
        assert.equal(p.analysisArtifactFile, null);
        assert.equal(p.prAnalysis, '');
    });
    test('an unknown mode is a loud error, never a silent default', () => {
        assert.throws(() => planHarvestOutputs({ ...common, harvestMode: 'bogus', harvestDocsDir: null }), /harvest mode/);
    });
});

describe('buildHarvesterPrompt: per-mode instructions', () => {
    const base = { branch: 'feat/x', baseBranch: 'main', targetIssues: ['PROJ-1'], analysisText: '# Sprint Analysis: feat/x\n\nbody of the analysis' };

    test('full (and unset) keeps the docs/ + README instruction and the artifact path', () => {
        for (const p of [
            buildHarvesterPrompt({ ...base, analysisArtifactFile: 'docs/sprint-analysis-x.md' }),
            buildHarvesterPrompt({ ...base, analysisArtifactFile: 'docs/sprint-analysis-x.md', harvestMode: 'full' }),
        ]) {
            assert.match(p, /^harvestMode: full$/m);
            assert.match(p, /Update docs\/ and README/);
            assert.match(p, /^analysisArtifactFile: docs\/sprint-analysis-x\.md$/m);
            assert.deepEqual(checkHarvesterContract(p), []);
        }
    });
    test('docs-dir names the dir, forbids README edits and docs/', () => {
        const p = buildHarvesterPrompt({ ...base, analysisArtifactFile: 'notes/sprint-analysis-x.md', harvestMode: 'docs-dir', harvestDocsDir: 'notes' });
        assert.match(p, /^harvestMode: docs-dir$/m);
        assert.match(p, /^harvestDocsDir: notes$/m);
        assert.match(p, /only under notes\//);
        assert.match(p, /NO README edits/);
        assert.doesNotMatch(p, /Update docs\/ and README/);
        assert.deepEqual(checkHarvesterContract(p), []);
    });
    for (const mode of ['pr-body-only', 'off']) {
        test(`${mode}: no file writes, no commits, KB + deferral still asked for`, () => {
            const p = buildHarvesterPrompt({ ...base, analysisArtifactFile: null, harvestMode: mode });
            assert.match(p, new RegExp(`^harvestMode: ${mode}$`, 'm'));
            assert.match(p, /^analysisArtifactFile: none$/m);
            assert.match(p, /Do NOT create, modify or delete any file/);
            assert.match(p, /do NOT commit or push/);
            assert.match(p, /knowledge-bank step/);
            assert.match(p, /low-priority issues/);
            assert.doesNotMatch(p, /Update docs\/ and README/);
            assert.doesNotMatch(p, /write verbatim to analysisArtifactFile/);
            assert.deepEqual(checkHarvesterContract(p), []);
        });
    }
});

// ---------------------------------------------------------------------------
// Mock sprints: the real runner end to end.
// ---------------------------------------------------------------------------

function harvesterPrompt(run) {
    const d = run.dispatched.find((x) => x.agent === 'harvester');
    assert.ok(d, 'the harvester is still dispatched');
    return d.prompt;
}

function prCreateCommand(run) {
    return run.commandLog.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));
}

test('mock sprint: unset harvest_mode is full -- docs/ analysis path, and no Cost block in what the harvester commits', { timeout: 300000 }, async () => {
    const run = await withScenarioMarkers('harvestfull', async () => runDevelopLoopScenario('harvestfull', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode full scenario work' }],
        maxCycles: 1,
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    const p = harvesterPrompt(run);
    assert.match(p, /^harvestMode: full$/m);
    assert.match(p, /^analysisArtifactFile: docs\/sprint-analysis-\S+\.md$/m);
    assert.doesNotMatch(p, /## Cost/, 'the cost block must never reach a committed file');
    assert.doesNotMatch(p, /Tracked spend/, 'no spend figure in the harvester input');
    assert.ok(run.logs.some((l) => /Tracked spend/.test(l)), 'the cost block is kept in the run log');
    const pr = prCreateCommand(run);
    assert.ok(pr, 'a PR is raised');
    assert.ok(pr.includes('### Cost'), 'the cost block is kept in the PR body');
    assert.equal(pr.includes('### Sprint analysis'), false, 'full mode does not duplicate the analysis into the PR body');
});

test('mock sprint: harvest_mode pr-body-only -- no harvester writes/commits, the PR body carries the analysis', { timeout: 300000 }, async () => {
    const run = await withScenarioMarkers('harvestprbody', async () => runDevelopLoopScenario('harvestprbody', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode pr-body-only scenario work' }],
        maxCycles: 1,
        harvestMode: 'pr-body-only',
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    const p = harvesterPrompt(run);
    assert.match(p, /^harvestMode: pr-body-only$/m);
    assert.match(p, /^analysisArtifactFile: none$/m);
    assert.match(p, /do NOT commit or push/);
    assert.doesNotMatch(p, /## Cost/);
    const pr = prCreateCommand(run);
    assert.ok(pr, 'a PR is raised');
    assert.ok(pr.includes('### Sprint analysis'), 'the PR body carries the sprint analysis');
    assert.ok(pr.includes('Final closed count'), 'with the analysis content itself');
    assert.ok(pr.includes('Harvest mode: pr-body-only'), 'the mode is stated in the PR body, never silent');
    assert.ok(pr.includes('### Cost'), 'the cost block is still in the PR body');
    assert.ok(run.logs.some((l) => /Harvest mode pr-body-only/.test(l)), 'the mode is logged');
});

test('mock sprint: harvest_mode off -- harvester still runs (KB capture + deferral) with no target-repo writes', { timeout: 300000 }, async () => {
    const run = await withScenarioMarkers('harvestoff', async () => runDevelopLoopScenario('harvestoff', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode off scenario work' }],
        maxCycles: 1,
        harvestMode: 'off',
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    const p = harvesterPrompt(run);
    assert.match(p, /^harvestMode: off$/m);
    assert.match(p, /^analysisArtifactFile: none$/m);
    assert.match(p, /Do NOT create, modify or delete any file/);
    assert.match(p, /knowledge-bank step/);
    assert.match(p, /low-priority issues/);
    const pr = prCreateCommand(run);
    assert.ok(pr, 'a PR is raised');
    assert.equal(pr.includes('### Sprint analysis'), false, 'off puts no analysis in the PR body');
    assert.ok(pr.includes('Harvest mode: off'), 'the mode is stated in the PR body');
});

test('mock sprint: harvest_mode docs-dir -- analysis under the configured dir, no README edits', { timeout: 300000 }, async () => {
    const run = await withScenarioMarkers('harvestdocsdir', async () => runDevelopLoopScenario('harvestdocsdir', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode docs-dir scenario work' }],
        maxCycles: 1,
        harvestMode: 'docs-dir',
        harvestDocsDir: 'notes/sprints',
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    const p = harvesterPrompt(run);
    assert.match(p, /^harvestMode: docs-dir$/m);
    assert.match(p, /^analysisArtifactFile: notes\/sprints\/sprint-analysis-\S+\.md$/m);
    assert.match(p, /NO README edits/);
    assert.doesNotMatch(p, /## Cost/);
});
