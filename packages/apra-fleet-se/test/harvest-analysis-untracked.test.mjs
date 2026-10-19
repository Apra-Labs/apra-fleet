import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHarvestPhase, SPRINT_ANALYSIS_EXCLUDE_PATTERN } from '../fleet-sprint/phases/harvest.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import { createRecordingCtx } from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// The harvester WRITES docs/sprint-analysis-<slug>.md but never commits it.
// The engine lists docs/sprint-analysis-*.md in the harvester clone's local
// git exclude file before dispatching, so the untracked file never shows as
// dirty, is never auto-stashed, and is never swept into `git add -A`.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARVESTER_MD = path.join(__dirname, '../apra-pm/agents/harvester.md');

function harvestArgs(overrides = {}) {
    return {
        phase: () => {},
        log: () => {},
        validated: { branch: 'feat/x', baseBranch: 'main' },
        targetIssues: ['issue-1'],
        finalCycleLabel: '1',
        budget: {},
        closedCountHistory: [],
        highWaterClosedCount: 0,
        deployFailures: [],
        integFailures: [],
        rejectedNewTasks: [],
        integTestRunnerSpend: 0,
        integTestRunnerDispatchCount: 0,
        finalVerdictResult: { verdict: 'PASS' },
        finalClosedCount: 1,
        finalOpenAtGoalCount: 0,
        finalDeferredAtGoalIds: [],
        regressionResult: null,
        computeBranchSlug: (b) => b.replace(/[^A-Za-z0-9]+/g, '-'),
        buildAnalysisText: () => '# Sprint analysis',
        buildCostAnalysis: () => 'cost',
        ...overrides,
    };
}

describe('Harvest phase: analysis document is git-excluded, never committed', () => {
    test('the exclude runs on the harvester member, per its OS/shell, BEFORE the harvester dispatch', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [{ status: 'OK', notes: 'ok' }] });
        const commands = [];
        const shellFor = [];
        const logs = [];
        await runHarvestPhase(harvestArgs({
            dispatchCtx: ctx,
            log: (m) => logs.push(m),
            memberSeCommands: async (member) => {
                shellFor.push(member);
                return getSeCommands({ os: 'windows', shell: 'powershell' });
            },
            command: async (cmd, opts) => {
                commands.push({ cmd, opts, dispatchesSoFar: rec.dispatches.length });
                return { ok: true, output: '' };
            },
        }));
        const member = ctx.getMemberForRole('harvester');
        assert.deepEqual(shellFor, [member], 'command dialect resolved for the harvester member');
        assert.equal(commands.length, 1, 'exactly one engine-side command');
        assert.equal(commands[0].cmd, getSeCommands({ os: 'windows', shell: 'powershell' }).ensureGitExcluded('docs/sprint-analysis-*.md'));
        assert.equal(commands[0].opts.member_name, member);
        assert.equal(commands[0].dispatchesSoFar, 0, 'exclude ran before the harvester was dispatched');
        assert.equal(rec.dispatches.length, 1, 'harvester still dispatched');
        assert.equal(SPRINT_ANALYSIS_EXCLUDE_PATTERN, 'docs/sprint-analysis-*.md');
        const done = logs.find((l) => l.startsWith('Harvester: wrote sprint analysis'));
        assert.ok(done && /locally/.test(done) && /not committed/.test(done), `log says written locally, not committed: ${done}`);
    });

    test('an exclude failure skips the harvester dispatch and logs loudly', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [{ status: 'OK', notes: 'ok' }] });
        const logs = [];
        const out = await runHarvestPhase(harvestArgs({
            dispatchCtx: ctx,
            log: (m) => logs.push(m),
            memberSeCommands: async () => getSeCommands({ os: 'linux', shell: 'bash' }),
            command: async () => ({ ok: false, error: 'boom' }),
        }));
        assert.equal(rec.dispatches.length, 0, 'harvester must not run without the exclude in place');
        assert.ok(logs.some((l) => /^ERROR Harvester: NOT dispatched/.test(l) && l.includes('boom')), logs.join('\n'));
        assert.equal(out.costAnalysis, 'cost', 'Publish PR still gets its cost block');
    });

    test('harvester.md Step 1 writes the analysis file and never stages or commits it', () => {
        const md = fs.readFileSync(HARVESTER_MD, 'utf8');
        const start = md.indexOf('## Step 1');
        const end = md.indexOf('## Step 2');
        assert.ok(start >= 0 && end > start, 'Step 1 section present');
        const step1 = md.slice(start, end);
        assert.match(step1, /verbatim/);
        assert.doesNotMatch(step1, /git[^\n]*\badd\s+["<]/, 'Step 1 must not git add the artifact');
        assert.doesNotMatch(step1, /git[^\n]*\bcommit\s+-m/, 'Step 1 must not commit the artifact');
        assert.match(step1, /Do NOT `git add` or commit this file/);
    });
});

// ---- real git: the exclude makes the untracked file invisible --------------

const tmpRoots = [];
after(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

const isWin = process.platform === 'win32';
const shellRunner = isWin
    ? (spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0']).status === 0 ? 'powershell' : null)
    : 'bash';

function git(cwd, args, env) {
    return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

function runMemberCommand(command, cwd, env) {
    if (shellRunner === 'bash') return spawnSync('bash', ['-c', command], { cwd, env, encoding: 'utf8' });
    const b64 = command.split(' ').pop();
    return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { cwd, env, encoding: 'utf8' });
}

describe('real git: excluded untracked analysis file is clean', { skip: shellRunner ? false : 'no member shell available on this host' }, () => {
    const cmds = getSeCommands(isWin ? { os: 'windows', shell: 'powershell' } : { os: 'linux', shell: 'bash' });

    function setupRepo() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-untracked-'));
        tmpRoots.push(root);
        const repo = path.join(root, 'repo');
        const env = {
            ...process.env,
            GIT_CEILING_DIRECTORIES: root,
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
        };
        assert.equal(git(root, ['init', '-q', repo], env).status, 0);
        fs.mkdirSync(path.join(repo, 'docs'));
        fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), 'guide\n');
        assert.equal(git(repo, ['add', '-A'], env).status, 0);
        assert.equal(git(repo, ['commit', '-q', '-m', 'init'], env).status, 0);
        return { repo, env };
    }

    test('exclude applied twice -> pattern listed exactly once in .git/info/exclude', () => {
        const { repo, env } = setupRepo();
        for (let i = 0; i < 2; i++) {
            const r = runMemberCommand(cmds.ensureGitExcluded(SPRINT_ANALYSIS_EXCLUDE_PATTERN), repo, env);
            assert.equal(r.status, 0, r.stderr);
        }
        const excl = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'info/exclude'], env).stdout.trim());
        const lines = fs.readFileSync(excl, 'utf8').split(/\r?\n/).filter((l) => l === SPRINT_ANALYSIS_EXCLUDE_PATTERN);
        assert.equal(lines.length, 1);
    });

    test('status is clean, add -A stages nothing, stash -u finds nothing, add docs/ skips it', () => {
        const { repo, env } = setupRepo();
        const r = runMemberCommand(cmds.ensureGitExcluded(SPRINT_ANALYSIS_EXCLUDE_PATTERN), repo, env);
        assert.equal(r.status, 0, r.stderr);
        fs.writeFileSync(path.join(repo, 'docs', 'sprint-analysis-feat-x-1234abcd.md'), '# analysis\n');

        assert.equal(git(repo, ['status', '--porcelain'], env).stdout, '', 'excluded file is not dirty');
        assert.equal(git(repo, ['add', '-A'], env).status, 0);
        assert.equal(git(repo, ['add', 'docs/'], env).status, 0);
        assert.equal(git(repo, ['diff', '--cached', '--name-only'], env).stdout, '', 'nothing staged');
        const stash = git(repo, ['stash', 'push', '-u', '-m', 'probe'], env);
        assert.match(stash.stdout + stash.stderr, /No local changes to save/);
        assert.ok(fs.existsSync(path.join(repo, 'docs', 'sprint-analysis-feat-x-1234abcd.md')), 'file left in place');
    });
});

describe('ensureGitExcluded accepts the glob pattern; file primitives stay strict', () => {
    for (const target of [{ os: 'linux', shell: 'bash' }, { os: 'windows', shell: 'powershell' }, { os: 'windows', shell: 'gitbash' }]) {
        const cmds = getSeCommands(target);
        test(`${target.os}/${target.shell}`, () => {
            assert.doesNotThrow(() => cmds.ensureGitExcluded(SPRINT_ANALYSIS_EXCLUDE_PATTERN));
            assert.throws(() => cmds.removeFile('docs/*.md'), /unsafe file path/);
            assert.throws(() => cmds.ensureGitExcluded("docs/a'*.md"), /unsafe git-exclude entry/);
        });
    }
});
