// Robustness of the reviewer demotion loop's guard plumbing, against REAL git
// repositories and REALLY failing commands (no faked command results):
//
//   1. createCurrentFileHashes / createRoundChangedFiles /
//      createSprintChangedFiles log a WARN naming the member and the failed
//      command whenever they degrade to an empty result.
//   2. createRoundChangedFiles advances its "previous round" sha only when
//      the round's diff succeeded, so a failed round's files are not lost.
//   3. kbWork.demotionCandidates() takes the same isBusy/inFlight bracket
//      flushRepo/commitRepo take: it never pulls a maintainer that is
//      mid-dispatch, and a dispatch starting during its read waits it out.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { exec, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import {
    createCurrentFileHashes, createRoundChangedFiles, createSprintChangedFiles,
} from '../fleet-sprint/runner.js';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';

const MEMBER = 'guard-maint';
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function tempDir(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(d);
    return d;
}

// Identity and isolation for every git call these tests make: no user/system
// config is read, and git never walks up out of the temp tree.
function gitEnv(root) {
    return {
        ...process.env,
        GIT_AUTHOR_NAME: 'Guard Test', GIT_AUTHOR_EMAIL: 'guard@example.com',
        GIT_COMMITTER_NAME: 'Guard Test', GIT_COMMITTER_EMAIL: 'guard@example.com',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
        GIT_CEILING_DIRECTORIES: root,
    };
}

function git(cwd, root, ...args) {
    return execFileSync('git', args, { cwd, env: gitEnv(root), encoding: 'utf8' }).trim();
}

// A real member-command executor: the exact command string runs in a real
// shell in `cwd`, and failure is the command's real exit status. Output on
// failure is stdout+stderr, as a member command reports it.
function shellCommand(cwd, env) {
    const calls = [];
    const command = (cmd, opts) => new Promise((resolve) => {
        calls.push({ cmd, member: opts && opts.member_name });
        exec(cmd, { cwd, env, encoding: 'utf8' }, (err, stdout, stderr) => {
            resolve(err ? { ok: false, output: `${stdout}${stderr}` } : { ok: true, output: stdout });
        });
    });
    return { command, calls };
}

/**
 * origin (bare, branches main + feat), a doer clone that pushes to feat, and
 * the maintainer's clone on feat. `pull` is the maintainer's real
 * fetch + fast-forward merge of the sprint branch -- it deliberately fetches
 * ONLY feat, so a remote-tracking ref the test deletes stays deleted.
 */
function makeRepos() {
    const root = tempDir('demotion-guard-');
    fs.writeFileSync(path.join(root, 'empty-gitconfig'), '');
    const origin = path.join(root, 'origin.git');
    const doer = path.join(root, 'doer');
    const maint = path.join(root, 'maint');
    git(root, root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, root, 'init', '-q', '-b', 'main', doer);
    git(doer, root, 'remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(doer, 'README.md'), 'base\n');
    git(doer, root, 'add', '.');
    git(doer, root, 'commit', '-q', '-m', 'base');
    git(doer, root, 'push', '-q', 'origin', 'HEAD:main');
    git(doer, root, 'checkout', '-q', '-b', 'feat');
    git(doer, root, 'push', '-q', 'origin', 'feat');
    git(root, root, 'clone', '-q', '-b', 'feat', origin, maint);
    const doerCommit = (file) => {
        fs.writeFileSync(path.join(doer, file), `${file}\n`);
        git(doer, root, 'add', file);
        git(doer, root, 'commit', '-q', '-m', `add ${file}`);
        git(doer, root, 'push', '-q', 'origin', 'feat');
    };
    const pull = async () => {
        git(maint, root, 'fetch', '-q', 'origin', 'feat');
        git(maint, root, 'merge', '-q', '--ff-only', 'origin/feat');
    };
    return { root, maint, doerCommit, pull, env: gitEnv(root) };
}

function collectLog() {
    const lines = [];
    return { lines, log: (l) => lines.push(String(l)) };
}

function assertWarned(lines, ...needles) {
    const hit = lines.find((l) => l.includes('WARN') && needles.every((n) => l.includes(n)));
    assert.ok(hit, `no WARN line containing ${JSON.stringify(needles)}; log was:\n${lines.join('\n')}`);
}

describe('createRoundChangedFiles: real git, real failures', () => {
    test('a failed diff WARNs with the member and command, and does not advance the round sha -- the next round still sees the failed round\'s files', async () => {
        const repos = makeRepos();
        // The base-branch ref the first round diffs from is missing on the
        // maintainer: the diff really fails.
        git(repos.maint, repos.root, 'update-ref', '-d', 'refs/remotes/origin/main');
        const { command } = shellCommand(repos.maint, repos.env);
        const { lines, log } = collectLog();
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore: repos.pull, baseBranch: 'main', log });

        repos.doerCommit('round1.js');
        const round1 = await roundChangedFiles(MEMBER);
        const round1Head = git(repos.maint, repos.root, 'rev-parse', 'HEAD');
        assert.deepEqual(round1, []);
        assertWarned(lines, MEMBER, `git diff --name-only origin/main...${round1Head}`);

        // The base ref is back; round 2 commits another file.
        git(repos.maint, repos.root, 'fetch', '-q', 'origin', 'main');
        repos.doerCommit('round2.js');
        const round2 = await roundChangedFiles(MEMBER);

        // Diffing from the failed round's head would return only round2.js.
        assert.deepEqual(round2.sort(), ['round1.js', 'round2.js'],
            "the failed round's files were lost: the round sha advanced past a diff that never succeeded");
    });

    test('a successful diff does advance the round sha (round 2 diffs from round 1\'s tip)', async () => {
        const repos = makeRepos();
        const { command } = shellCommand(repos.maint, repos.env);
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore: repos.pull, baseBranch: 'main', log: () => {} });

        repos.doerCommit('round1.js');
        assert.deepEqual(await roundChangedFiles(MEMBER), ['round1.js']);
        repos.doerCommit('round2.js');
        assert.deepEqual(await roundChangedFiles(MEMBER), ['round2.js']);
    });

    test('a failed rev-parse (not a git checkout) WARNs with the member and command', async () => {
        const root = tempDir('demotion-guard-norepo-');
        const { command } = shellCommand(root, gitEnv(root));
        const { lines, log } = collectLog();
        const roundChangedFiles = createRoundChangedFiles({ command, pullGitBefore: async () => {}, baseBranch: 'main', log });

        assert.deepEqual(await roundChangedFiles(MEMBER), []);
        assertWarned(lines, MEMBER, 'git rev-parse HEAD');
    });
});

describe('createSprintChangedFiles: real git, real failures', () => {
    test('a failed diff (sprint branch ref missing) WARNs with the member and command', async () => {
        const repos = makeRepos();
        const { command } = shellCommand(repos.maint, repos.env);
        const { lines, log } = collectLog();
        const sprintChangedFiles = createSprintChangedFiles({
            command, pullGitBefore: repos.pull, baseBranch: 'main', branch: 'no-such-branch', log,
        });

        assert.deepEqual(await sprintChangedFiles(MEMBER), []);
        assertWarned(lines, MEMBER, 'git diff --name-only origin/main...no-such-branch');
    });
});

describe('createCurrentFileHashes: real failures', () => {
    // A directory holding one executable named `node` that prints `text` --
    // a member whose PATH resolves `node` to something that is not Node.js.
    function binDirWithNodePrinting(text) {
        const dir = tempDir('demotion-guard-bin-');
        if (process.platform === 'win32') {
            fs.writeFileSync(path.join(dir, 'node.cmd'), `@echo ${text}\r\n`);
        } else {
            fs.writeFileSync(path.join(dir, 'node'), `#!/bin/sh\necho '${text}'\n`, { mode: 0o755 });
        }
        return dir;
    }

    test('no node on the member WARNs with the member and the command', async () => {
        const cwd = tempDir('demotion-guard-hash-');
        fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
        const emptyBin = tempDir('demotion-guard-emptybin-');
        const { command } = shellCommand(cwd, { ...process.env, PATH: emptyBin, Path: emptyBin });
        const { lines, log } = collectLog();

        const hashes = await createCurrentFileHashes({ command, log })(MEMBER, ['a.txt']);

        assert.deepEqual(hashes, {});
        assertWarned(lines, MEMBER, 'node -e', 'failed');
    });

    test('output that is not JSON WARNs with the member and the command', async () => {
        const cwd = tempDir('demotion-guard-hash-');
        fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
        const bin = binDirWithNodePrinting('not-node banner');
        const pathVar = `${bin}${path.delimiter}${process.env.PATH || process.env.Path || ''}`;
        const { command } = shellCommand(cwd, { ...process.env, PATH: pathVar, Path: pathVar });
        const { lines, log } = collectLog();

        const hashes = await createCurrentFileHashes({ command, log })(MEMBER, ['a.txt']);

        assert.deepEqual(hashes, {});
        assertWarned(lines, MEMBER, 'node -e', 'not JSON');
    });
});

describe('kbWork.demotionCandidates: isBusy/inFlight bracket', () => {
    const REVIEWER = { id: 'id-guard-reviewer', name: 'guard-reviewer', type: 'local' };
    const MAINT = { id: 'id-guard-maint', name: MEMBER, type: 'local' };
    const selector = () => fakeMaintainerSelector({
        repoOf: { [REVIEWER.name]: 'example.com/guard', [MAINT.name]: 'example.com/guard' },
        maintainerOf: { 'example.com/guard': MAINT },
    });
    const CONFIRMED = { id: 'kb-1', type: 'knowledge', confidence: 'CONFIRMED', title: 't', summary: 's', source_files: ['round1.js'] };

    test('a maintainer that is mid-dispatch is not pulled and gets no read: [] with a log line', async () => {
        const repos = makeRepos();
        const { command } = shellCommand(repos.maint, repos.env);
        const reads = [];
        const { lines, log } = collectLog();
        const client = createKbWorkClient({
            memberCall: async (member, name) => { reads.push(name); return { l1_results: [CONFIRMED] }; },
            maintainers: selector(),
            roundChangedFiles: createRoundChangedFiles({ command, pullGitBefore: repos.pull, baseBranch: 'main', log }),
            log,
        });
        repos.doerCommit('round1.js');
        const headBefore = git(repos.maint, repos.root, 'rev-parse', 'HEAD');

        await client.dispatchStarted(MAINT.name);
        const offered = await client.demotionCandidates(REVIEWER);

        assert.deepEqual(offered, []);
        assert.equal(git(repos.maint, repos.root, 'rev-parse', 'HEAD'), headBefore, 'the busy maintainer\'s checkout was pulled');
        assert.deepEqual(reads, [], 'kb_query ran on a maintainer that is mid-dispatch');
        assert.ok(lines.some((l) => l.includes(`'${MAINT.name}' is mid-dispatch`)), `no mid-dispatch log line:\n${lines.join('\n')}`);

        // Once the dispatch ends the same read goes through.
        await client.dispatchEnded(MAINT.name);
        const afterEnd = await client.demotionCandidates(REVIEWER);
        assert.deepEqual(afterEnd.map((e) => e.id), ['kb-1']);
        assert.notEqual(git(repos.maint, repos.root, 'rev-parse', 'HEAD'), headBefore, 'the idle maintainer was never pulled');
    });

    test('a dispatch starting during the read waits until the read has finished', async () => {
        const repos = makeRepos();
        const { command } = shellCommand(repos.maint, repos.env);
        const events = [];
        let releaseRead;
        const readGate = new Promise((r) => { releaseRead = r; });
        let readStarted;
        const readStartedP = new Promise((r) => { readStarted = r; });
        const client = createKbWorkClient({
            memberCall: async (member, name) => {
                events.push(`${name}:start`);
                readStarted();
                await readGate;
                events.push(`${name}:end`);
                return { l1_results: [CONFIRMED] };
            },
            maintainers: selector(),
            roundChangedFiles: createRoundChangedFiles({ command, pullGitBefore: repos.pull, baseBranch: 'main', log: () => {} }),
            log: () => {},
        });
        repos.doerCommit('round1.js');

        const read = client.demotionCandidates(REVIEWER);
        await readStartedP;
        const started = client.dispatchStarted(MAINT.name).then(() => events.push('dispatchStarted:resolved'));
        // Give dispatchStarted every chance to resolve early.
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(events, ['kb_query:start'], 'dispatchStarted resolved while the demotion read was still in flight');

        releaseRead();
        const offered = await read;
        await started;
        assert.deepEqual(offered.map((e) => e.id), ['kb-1']);
        assert.deepEqual(events, ['kb_query:start', 'kb_query:end', 'dispatchStarted:resolved']);
        await client.dispatchEnded(MAINT.name);
    });
});
