import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateArgs, HARVEST_MODES } from '../fleet-sprint/sprint-args.mjs';
import { planHarvestOutputs, harvesterResumePrompt, parsePorcelainStatus, NO_WRITE_HARVEST_MODES } from '../fleet-sprint/phases/harvest.mjs';
import { ROLE_POLICIES, HARVESTER_NO_WRITE_POLICIES } from '../fleet-sprint/role-policies.mjs';
import { buildHarvesterPrompt } from '../fleet-sprint/prompts.mjs';
import { buildRunnerArgs, parseCliArgs } from '../bin/cli.mjs';
import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { runDevelopLoopScenario, withScenarioMarkers, checkHarvesterContract, mockCmdResult } from './helpers/mock-sprint-harness.mjs';

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
        // A leading '-' (option injection), a trailing '.' (stripped by Windows)
        // and Windows reserved device names, any case, with or without an extension.
        '-docs', 'notes/-rf', 'docs.', 'notes/sub.', 'notes/v1.',
        'con', 'CON', 'nul', 'Nul.md', 'aux', 'prn.txt', 'notes/com1', 'COM9', 'lpt1', 'docs/LPT9.log', 'notes/con/x',
    ]) {
        test(`rejects unsafe harvest_docs_dir ${JSON.stringify(bad.length > 40 ? `${bad.slice(0, 10)}...` : bad)}`, () => {
            assert.throws(
                () => validateArgs({ ...BASE_ARGS, harvest_mode: 'docs-dir', harvest_docs_dir: bad }),
                /Invalid harvest_docs_dir/,
            );
        });
    }
    test('the new segment rules name the reason', () => {
        const reject = (dir) => () => validateArgs({ ...BASE_ARGS, harvest_mode: 'docs-dir', harvest_docs_dir: dir });
        assert.throws(reject('notes/-rf'), /starts with '-'/);
        assert.throws(reject('notes/sub.'), /ends with '\.'/);
        assert.throws(reject('notes/Nul.md'), /reserved Windows device name/);
    });
    for (const good of ['console', 'notes/com10', 'lpt', 'docs.v2', 'a-b/c_d', 'nul-docs', 'auxiliary/x']) {
        test(`still accepts the near-miss harvest_docs_dir ${JSON.stringify(good)}`, () => {
            assert.equal(validateArgs({ ...BASE_ARGS, harvest_mode: 'docs-dir', harvest_docs_dir: good }).harvestDocsDir, good);
        });
    }
});

describe('cli.mjs: --harvest-mode / --harvest-docs-dir', () => {
    const base = { targetIssues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', maxCycles: 1 };
    for (const bad of ['notes/-rf', 'notes/sub.', 'notes/nul.md', 'COM1']) {
        test(`the CLI rejects --harvest-docs-dir ${JSON.stringify(bad)} before connecting to the fleet`, () => {
            const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs');
            const res = spawnSync(process.execPath, [cli, '-i', 'PROJ-1', '-m', 'm1', '-b', 'feat/x', '-B', 'main',
                '--harvest-mode', 'docs-dir', '--harvest-docs-dir', bad], {
                // NODE_TEST_CONTEXT would make cli.mjs treat itself as imported
                // by the test runner and skip main(); the child is a real CLI run.
                env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')),
                encoding: 'utf8',
                timeout: 60000,
            });
            assert.equal(res.status, 1, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
            assert.match(res.stderr, /Invalid harvest_docs_dir/);
        });
    }
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
        ['a dir segment starting with -', { harvestMode: 'docs-dir', harvestDocsDir: 'notes/-rf' }, 'harvestDocsDir'],
        ['a dir segment ending with .', { harvestMode: 'docs-dir', harvestDocsDir: 'notes/sub.' }, 'harvestDocsDir'],
        ['a reserved Windows device name', { harvestMode: 'docs-dir', harvestDocsDir: 'notes/Aux.md' }, 'harvestDocsDir'],
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

describe('no-write harvest modes: engine enforcement pieces', () => {
    test('HARVESTER_NO_WRITE_POLICIES swaps only the harvester bracket to no code push (main and resume)', () => {
        assert.deepEqual([...NO_WRITE_HARVEST_MODES].sort(), ['off', 'pr-body-only']);
        const real = ROLE_POLICIES.harvester;
        const variant = HARVESTER_NO_WRITE_POLICIES.harvester;
        assert.equal(real.bracket.pushCode, true, 'the default harvester row still pushes code');
        for (const row of [variant, variant.secondary]) {
            assert.equal(row.bracket.wrapped, true);
            assert.equal(row.bracket.pushCode, false);
            assert.equal(row.bracket.pushBeads, true, 'backlog confirmation still D-pushes beads');
        }
        const strip = ({ bracket, secondary, ...rest }) => rest;
        assert.deepEqual(strip(variant), strip(real), 'every other field of the main row is unchanged');
        assert.deepEqual(strip(variant.secondary), strip(real.secondary), 'every other field of the resume row is unchanged');
        for (const role of Object.keys(ROLE_POLICIES)) {
            if (role !== 'harvester') assert.equal(HARVESTER_NO_WRITE_POLICIES[role], ROLE_POLICIES[role]);
        }
        assert.ok(Object.isFrozen(HARVESTER_NO_WRITE_POLICIES) && Object.isFrozen(variant.secondary.bracket));
    });

    test('the resume prompt keeps the ladder anchor and never says commit in a no-write mode', () => {
        const anchor = ROLE_POLICIES.harvester.secondary.ladderAnchor;
        for (const mode of HARVEST_MODES) {
            assert.ok(harvesterResumePrompt(mode).startsWith(anchor), mode);
        }
        for (const mode of NO_WRITE_HARVEST_MODES) {
            assert.doesNotMatch(harvesterResumePrompt(mode), /commit them/, mode);
            assert.match(harvesterResumePrompt(mode), /do not create, edit or commit any repository file/, mode);
        }
        assert.match(harvesterResumePrompt('full'), /commit them/);
        assert.match(harvesterResumePrompt('docs-dir'), /commit them/);
    });

    test('parsePorcelainStatus reads porcelain, ignores .beads/, and refuses non-porcelain output', () => {
        assert.deepEqual(parsePorcelainStatus(''), []);
        assert.deepEqual(parsePorcelainStatus(' M .beads/issues.jsonl\n'), []);
        assert.deepEqual(parsePorcelainStatus(' M README.md\r\n?? notes/new.md\nR  a.md -> b.md\n').map((e) => [e.code, e.path]),
            [[' M', 'README.md'], ['??', 'notes/new.md'], ['R ', 'b.md']]);
        assert.equal(parsePorcelainStatus('ok (mocked -- no real git remote)'), null);
        assert.equal(parsePorcelainStatus('fatal: not a git repository'), null);
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

/**
 * A model of the harvester member's checkout, answering the engine's no-write
 * check (`git rev-parse HEAD`, `git status --porcelain`, `git reset`,
 * `git checkout <sha> -- :/<path>`, `git clean`) from state and recording
 * every `git push` with the HEAD it would have published. `tracked` maps a
 * modified tracked path to its porcelain XY code; `preTracked` seeds it with
 * edits already on the member before the sprint. `commitFiles` are the paths
 * a rogue harvester commit touched: `git reset --keep` refuses (like git)
 * when one of them also has a local change. `git reset --hard` is modelled
 * destructively (it drops every tracked change) so a test can prove it is
 * never issued. `seq` interleaves those git commands with a 'HARVESTER'
 * marker for the dispatch itself.
 */
const BASE_SHA = 'a'.repeat(40);
const ROGUE_SHA = 'b'.repeat(40);
function memberRepoModel({ preTracked = {} } = {}) {
    const state = {
        head: BASE_SHA, tracked: new Map(Object.entries(preTracked)), untracked: new Set(), commitFiles: new Set(),
        pushes: [], resets: [], cleans: [], checkouts: [], seq: [],
    };
    const porcelain = () => [
        ...[...state.tracked].map(([p, code]) => `${code} ${p}`),
        ...[...state.untracked].map((p) => `?? ${p}`),
    ].join('\n');
    const ok = (out = '') => mockCmdResult(0, out, '');
    const gitCommandHandler = ({ command, member }) => {
        if (command === 'git rev-parse HEAD') {
            state.seq.push('rev-parse');
            return ok(`${state.head}\n`);
        }
        if (command === 'git status --porcelain') return ok(porcelain());
        let m = /^git reset --(hard|keep|soft) ([0-9a-f]{7,64})$/.exec(command);
        if (m) {
            const mode = m[1];
            state.seq.push('reset');
            state.resets.push({ member, mode, sha: m[2] });
            if (mode === 'keep' && [...state.commitFiles].some((p) => state.tracked.has(p))) {
                return mockCmdResult(1, '', 'error: Entry would be overwritten by merge. Cannot merge.');
            }
            if (mode === 'hard') state.tracked.clear();
            if (mode === 'soft') for (const p of state.commitFiles) state.tracked.set(p, state.tracked.has(p) ? 'MM' : 'M ');
            state.head = m[2];
            state.commitFiles.clear();
            return ok();
        }
        m = /^git clean -f -d -- :\/(\S+)$/.exec(command);
        if (m) {
            state.cleans.push(m[1]);
            state.untracked.delete(m[1]);
            return ok();
        }
        m = /^git checkout ([0-9a-f]{7,64}) -- :\/(\S+)$/.exec(command);
        if (m) {
            state.checkouts.push({ sha: m[1], path: m[2] });
            state.tracked.delete(m[2]);
            return ok();
        }
        if (/^git push\b/.test(command)) {
            state.seq.push('push');
            state.pushes.push({ command, head: state.head });
        }
        return null;
    };
    return { state, gitCommandHandler, porcelain };
}

/** The git commands between the harvester dispatch and the engine's post-dispatch HEAD read. */
function harvestBracketTail(state) {
    const start = state.seq.indexOf('HARVESTER');
    assert.ok(start !== -1, 'the harvester was dispatched');
    const end = state.seq.indexOf('rev-parse', start);
    assert.ok(end !== -1, 'the engine re-read HEAD after the dispatch');
    return state.seq.slice(start + 1, end);
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
    // This scenario's generic git mock answers HEAD with non-sha text, so the
    // engine cannot verify the member: it must say so, never claim no commits.
    assert.ok(pr.includes('the engine could not verify the harvester'), 'an unverifiable member is stated as unverified');
    assert.equal(pr.includes('no harvester commits'), false, 'no unverified "no harvester commits" claim');
    assert.ok(run.logs.some((l) => l.includes('[Harvest Write Check Unverified]')), 'the unverified check is logged loudly');
});

test('mock sprint: harvest_mode pr-body-only -- a harvester that COMMITS anyway is detected, reset and never pushed', { timeout: 300000 }, async () => {
    const repo = memberRepoModel();
    const run = await withScenarioMarkers('harvestprbodycommit', async () => runDevelopLoopScenario('harvestprbodycommit', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode pr-body-only rogue commit scenario work' }],
        maxCycles: 1,
        harvestMode: 'pr-body-only',
        gitCommandHandler: repo.gitCommandHandler,
        harvestHandler: async () => {
            repo.state.seq.push('HARVESTER');
            repo.state.head = ROGUE_SHA;
        },
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    assert.ok(run.logs.some((l) => l.includes('[Harvest Write Violation]') && l.includes(`HEAD moved from ${BASE_SHA} to ${ROGUE_SHA}`)),
        'the engine detects the commit and logs it loudly');
    assert.deepEqual(repo.state.resets.map((r) => [r.member, r.mode, r.sha]), [['local', 'keep', BASE_SHA]], 'the member is moved back to its pre-harvest HEAD with reset --keep, never --hard');
    assert.equal(repo.state.head, BASE_SHA);
    assert.equal(repo.state.pushes.some((p) => p.head === ROGUE_SHA), false, 'the rogue commit is never pushed');
    assert.equal(harvestBracketTail(repo.state).includes('push'), false, 'the no-write harvester bracket issues no git push');
    const pr = prCreateCommand(run);
    assert.ok(pr, 'a PR is raised');
    assert.ok(pr.includes('Harvest mode: pr-body-only -- VIOLATION'), 'the PR body states the violation');
    assert.ok(pr.includes(`HEAD moved from ${BASE_SHA} to ${ROGUE_SHA}`), 'with what the harvester did');
    assert.equal(pr.includes('no harvester commits'), false, 'no false "no harvester commits" claim');
    assert.ok(pr.includes('### Sprint analysis'), 'the analysis is still published in the PR body');
});

test('mock sprint: harvest_mode pr-body-only -- a harvester that leaves a DIRTY tree is detected and cleaned', { timeout: 300000 }, async () => {
    const repo = memberRepoModel();
    const run = await withScenarioMarkers('harvestprbodydirty', async () => runDevelopLoopScenario('harvestprbodydirty', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode pr-body-only dirty tree scenario work' }],
        maxCycles: 1,
        harvestMode: 'pr-body-only',
        gitCommandHandler: repo.gitCommandHandler,
        harvestHandler: async () => {
            repo.state.seq.push('HARVESTER');
            repo.state.tracked.set('README.md', ' M');
            repo.state.untracked.add('notes/new.md');
        },
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    assert.ok(run.logs.some((l) => l.includes('[Harvest Write Violation]') && l.includes('working tree changed: README.md, notes/new.md')),
        'the engine detects the dirty tree and logs it loudly');
    assert.deepEqual(repo.state.resets, [], 'HEAD did not move, so nothing is reset');
    assert.deepEqual(repo.state.checkouts, [{ sha: BASE_SHA, path: 'README.md' }], 'the tracked change is restored path by path from the pre-harvest HEAD');
    assert.deepEqual(repo.state.cleans, ['notes/new.md'], 'the new untracked file is removed');
    assert.equal(repo.porcelain(), '', 'the member tree is clean again');
    assert.ok(run.logs.some((l) => l.includes(`member 'local' reset to ${BASE_SHA}`)), 'the restore is confirmed in the log');
    assert.equal(harvestBracketTail(repo.state).includes('push'), false, 'the no-write harvester bracket issues no git push');
    const pr = prCreateCommand(run);
    assert.ok(pr, 'a PR is raised');
    assert.ok(pr.includes('Harvest mode: pr-body-only -- VIOLATION'), 'the PR body states the violation');
    assert.ok(pr.includes('working tree changed: README.md, notes/new.md'), 'with the paths');
    assert.equal(pr.includes('no harvester commits'), false);
});

// The three scenarios below start with an uncommitted edit ALREADY on the
// member (the G-pull fast-forward succeeds on a dirty tree): undoing the
// harvester must never destroy it, and the engine may only claim the member
// was reset when its working tree matches the pre-harvest state exactly.
const PRE_EXISTING = { 'some/file': ' M' };

function assertNoHardReset(repo) {
    assert.equal(repo.state.resets.some((r) => r.mode === 'hard'), false, 'git reset --hard is never issued');
}

test('mock sprint: harvest_mode pr-body-only -- a rogue commit on a member with pre-existing edits is undone with reset --keep, keeping the edits', { timeout: 300000 }, async () => {
    const repo = memberRepoModel({ preTracked: PRE_EXISTING });
    const run = await withScenarioMarkers('harvestprbodykeep', async () => runDevelopLoopScenario('harvestprbodykeep', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode pr-body-only keep pre-existing edits scenario work' }],
        maxCycles: 1,
        harvestMode: 'pr-body-only',
        gitCommandHandler: repo.gitCommandHandler,
        harvestHandler: async () => {
            repo.state.seq.push('HARVESTER');
            repo.state.head = ROGUE_SHA;
            repo.state.commitFiles.add('docs/sprint-analysis.md');
        },
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    assertNoHardReset(repo);
    assert.deepEqual(repo.state.resets.map((r) => [r.mode, r.sha]), [['keep', BASE_SHA]], 'HEAD is moved back with reset --keep');
    assert.equal(repo.state.head, BASE_SHA);
    assert.equal(repo.state.tracked.get('some/file'), ' M', 'the pre-existing edit survives');
    assert.deepEqual(repo.state.checkouts, [], 'the pre-existing edit is never checked out over');
    assert.equal(repo.state.pushes.some((p) => p.head === ROGUE_SHA), false, 'the rogue commit is never pushed');
    assert.ok(run.logs.some((l) => l.includes(`member 'local' reset to ${BASE_SHA}`) && l.includes('matches its pre-harvest state')),
        'a restore is claimed only because the tree matches the pre-harvest state');
    const pr = prCreateCommand(run);
    assert.ok(pr, 'a PR is raised');
    assert.ok(pr.includes('Harvest mode: pr-body-only -- VIOLATION'), 'the PR body states the violation');
    assert.ok(pr.includes('The engine discarded the change and did not push it.'));
});

test('mock sprint: harvest_mode pr-body-only -- a rogue commit overlapping a pre-existing edit is NOT reported as reset', { timeout: 300000 }, async () => {
    const repo = memberRepoModel({ preTracked: PRE_EXISTING });
    const run = await withScenarioMarkers('harvestprbodykeeprefused', async () => runDevelopLoopScenario('harvestprbodykeeprefused', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode pr-body-only keep refused scenario work' }],
        maxCycles: 1,
        harvestMode: 'pr-body-only',
        gitCommandHandler: repo.gitCommandHandler,
        harvestHandler: async () => {
            repo.state.seq.push('HARVESTER');
            repo.state.head = ROGUE_SHA;
            repo.state.commitFiles.add('some/file');
        },
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    assertNoHardReset(repo);
    assert.deepEqual(repo.state.resets.map((r) => r.mode), ['keep', 'soft'], 'a refused reset --keep falls back to reset --soft, which keeps every file');
    assert.equal(repo.state.head, BASE_SHA, 'the rogue commit is off the branch');
    assert.equal(repo.state.tracked.has('some/file'), true, 'the pre-existing edit is still on the member');
    assert.equal(repo.state.pushes.some((p) => p.head === ROGUE_SHA), false, 'the rogue commit is never pushed');
    assert.ok(run.logs.some((l) => l.includes('[Harvest Write Violation]') && l.includes(`git reset --keep ${BASE_SHA} refused`)), 'the refusal is logged loudly');
    assert.ok(run.logs.some((l) => l.includes('was NOT restored') && l.includes('residual paths: some/file')), 'the residual path is logged');
    assert.equal(run.logs.some((l) => l.includes(`member 'local' reset to ${BASE_SHA}`)), false, 'no false restore claim in the log');
    const pr = prCreateCommand(run);
    assert.ok(pr, 'a PR is raised');
    assert.ok(pr.includes('Harvest mode: pr-body-only -- VIOLATION'), 'the PR body states the violation');
    assert.ok(pr.includes('NOT restored') && pr.includes('residual paths: some/file'), 'the PR body says the member was not restored');
    assert.equal(pr.includes('member reset to'), false, 'no false restore claim in the PR body');
    assert.equal(pr.includes('discarded the change'), false);
});

test('mock sprint: harvest_mode pr-body-only -- a harvester edit to an already-dirty file is left and reported as not restored', { timeout: 300000 }, async () => {
    const repo = memberRepoModel({ preTracked: PRE_EXISTING });
    const run = await withScenarioMarkers('harvestprbodyredirty', async () => runDevelopLoopScenario('harvestprbodyredirty', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode pr-body-only already-dirty file scenario work' }],
        maxCycles: 1,
        harvestMode: 'pr-body-only',
        gitCommandHandler: repo.gitCommandHandler,
        harvestHandler: async () => {
            repo.state.seq.push('HARVESTER');
            repo.state.tracked.set('some/file', 'MM');
            repo.state.tracked.set('README.md', ' M');
        },
    }));
    assert.equal(run.error, null, `sprint errored: ${run.error && run.error.message}`);
    assertNoHardReset(repo);
    assert.deepEqual(repo.state.resets, [], 'HEAD did not move, so nothing is reset');
    assert.deepEqual(repo.state.checkouts, [{ sha: BASE_SHA, path: 'README.md' }], 'only the path the harvester first touched is restored');
    assert.equal(repo.state.tracked.get('some/file'), 'MM', 'the already-dirty file is left as is, never checked out over');
    assert.ok(run.logs.some((l) => l.includes('was NOT restored') && l.includes('residual paths: some/file')
        && l.includes("'some/file' was already modified before the harvest")), 'the already-dirty file is reported as not restored');
    assert.equal(run.logs.some((l) => l.includes(`member 'local' reset to ${BASE_SHA}`)), false, 'no false restore claim in the log');
    const pr = prCreateCommand(run);
    assert.ok(pr, 'a PR is raised');
    assert.ok(pr.includes('NOT restored') && pr.includes('residual paths: some/file'), 'the PR body says the member was not restored');
    assert.equal(pr.includes('member reset to'), false, 'no false restore claim in the PR body');
    assert.equal(pr.includes('discarded the change'), false);
});

test('mock sprint: harvest_mode off -- harvester still runs (KB capture + deferral) with no target-repo writes', { timeout: 300000 }, async () => {
    const repo = memberRepoModel();
    const run = await withScenarioMarkers('harvestoff', async () => runDevelopLoopScenario('harvestoff', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: harvest-mode off scenario work' }],
        maxCycles: 1,
        harvestMode: 'off',
        gitCommandHandler: repo.gitCommandHandler,
        harvestHandler: async () => { repo.state.seq.push('HARVESTER'); },
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
    assert.ok(pr.includes('Harvest mode: off -- the harvester wrote nothing to the repository (engine-verified'), 'the verified mode is stated in the PR body');
    assert.ok(run.logs.some((l) => l.includes(`verified the harvester left member 'local' unchanged (HEAD ${BASE_SHA}`)), 'the check is logged');
    assert.deepEqual(repo.state.resets, [], 'a clean harvest is not reset');
    assert.ok(repo.state.pushes.length > 0, 'the model does see this sprint\'s git pushes (doer brackets, Publish PR)');
    // The harvester bracket still runs its beads D-push (the deferral beads
    // publish): it is attempted between the harvest analysis log and the
    // harvester outcome log (this mock has no beads remote, so it is skipped
    // pre-attempt -- the point is that the bracket issues it).
    const from = run.logs.findIndex((l) => l.startsWith('Harvest: sprint analysis (not committed in harvest mode off)'));
    const to = run.logs.findIndex((l) => l.startsWith('Harvester: completed in harvest mode off'));
    assert.ok(from !== -1 && to > from, 'both harvest log anchors are present');
    assert.ok(run.logs.slice(from, to).some((l) => l.includes("D-push for member 'local'")), 'the harvester bracket D-pushes beads');
    assert.equal(harvestBracketTail(repo.state).includes('push'), false, 'the no-write harvester bracket issues no git push');
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
