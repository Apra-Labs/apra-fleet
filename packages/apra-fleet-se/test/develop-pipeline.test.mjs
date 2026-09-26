// Build pipeline (phases/develop-pipeline.mjs, docs/lazy-parallel-sprints.md).
//
// Real git: a bare origin plus one clone per member, real merges and real
// conflicts. The task database is a small in-memory stand-in (only the
// orchestrator writes it in pipeline mode), and the doer is a stand-in that
// edits and commits real files, so every landing rule is exercised against
// what git actually does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    runBuildPipelinePhase, selectTasksToStart, taskBranchName, predictedFiles, filesOverlap, MAX_LANDING_BOUNCES,
} from '../fleet-sprint/phases/develop-pipeline.mjs';

const SPRINT = 'feat/sprint';

function sh(cmd, cwd) {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** A bare origin with main + the sprint branch, and a clone per member. */
function makeFleet(members) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
    const origin = path.join(root, 'origin.git');
    sh(`git init -q --bare -b main "${origin}"`, root);
    const seed = path.join(root, 'seed');
    sh(`git clone -q "${origin}" seed`, root);
    sh('git config user.email t@example.com && git config user.name Tester', seed);
    fs.writeFileSync(path.join(seed, 'app.txt'), 'line 1\nline 2\nline 3\n');
    sh('git add . && git commit -qm base && git push -q origin HEAD:main', seed);
    const dirs = {};
    for (const m of members) {
        const dir = path.join(root, m);
        sh(`git clone -q "${origin}" "${m}"`, root);
        sh('git config user.email t@example.com && git config user.name Tester', dir);
        sh(`git checkout -q -B ${SPRINT} origin/main`, dir);
        dirs[m] = dir;
    }
    return { root, origin, dirs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** In-memory task database, written only through `bd` commands. */
function makeBeads(tasks) {
    const byId = new Map(tasks.map((t) => [t.id, { status: 'open', deps: [], ...t }]));
    const history = [];
    return {
        byId,
        history,
        ready: () => [...byId.values()]
            .filter((t) => t.status === 'open' && t.deps.every((d) => byId.get(d).status === 'closed'))
            .sort((a, b) => a.id.localeCompare(b.id)),
        run: (cmd) => {
            history.push(cmd);
            let m = /^bd update (\S+) --status (\S+)$/.exec(cmd);
            if (m) { byId.get(m[1]).status = m[2]; return ''; }
            m = /^bd close (\S+) --reason landed$/.exec(cmd);
            if (m) { byId.get(m[1]).status = 'closed'; return ''; }
            throw new Error(`unexpected bd command: ${cmd}`);
        },
    };
}

/**
 * Engine seams wired to real git. `withGitSync` pushes the bound branch after
 * the body, which is what the real bracket's post-dispatch G-push does.
 */
function makeEngine(fleet, beads, { gate } = {}) {
    const logs = [];
    const commands = [];
    const command = async (cmd, opts) => {
        assert.ok(opts && opts.member_name, `command without member_name: ${cmd}`);
        commands.push({ member: opts.member_name, cmd });
        try {
            const out = cmd.startsWith('bd ') ? beads.run(cmd) : sh(cmd, fleet.dirs[opts.member_name]);
            return opts.failSoft ? { ok: true, output: out, error: null } : out;
        } catch (err) {
            const msg = String(err.stderr || err.message || err);
            if (opts.failSoft) return { ok: false, output: String(err.stdout || ''), error: msg };
            throw err;
        }
    };
    const syncFor = (branch) => ({
        withGitSync: async (member, pushCode, fn) => {
            const value = await fn();
            if (pushCode) sh(`git push -q origin ${branch}`, fleet.dirs[member]);
            return value;
        },
        syncBeadsBefore: async () => {},
        syncBeadsAfter: async () => {},
        pushGitAfter: async (member) => sh(`git push -q origin ${branch}`, fleet.dirs[member]),
    });
    return {
        logs,
        commands,
        deps: {
            phase: () => {},
            log: (m) => logs.push(m),
            command,
            dispatchCtx: {},
            cycle: 1,
            gitSync: syncFor(SPRINT),
            makeBranchGitSync: (b) => syncFor(b),
            updateDashboard: async () => {},
            kbPriming: { folderOf: () => '', knowledgeOf: () => [] },
            kbWork: { relevantKnowledge: async () => [] },
            kbQueryTerms: () => [],
            normalizeTierToken: (t) => t,
            listReady: async () => beads.ready(),
            gate,
        },
    };
}

/**
 * A doer that does real work in its member's clone. `work(ctx)` edits files;
 * the doer commits them and returns through the bracket like the real one.
 */
function makeDoer(fleet, work, stats = { inFlight: 0, max: 0, prompts: [] }) {
    const dispatchDoer = async (ctx, opts) => {
        const { prompt, bindings } = await opts.prepare({ dispatch: { kind: 'main' } });
        const member = bindings.doerMember;
        const taskId = /Assigned bead ids \(comma-separated\):\s*(\S+)/.exec(prompt)[1];
        const isFix = prompt.includes('could not land yet');
        stats.prompts.push({ member, taskId, isFix, prompt });
        stats.inFlight += 1;
        stats.max = Math.max(stats.max, stats.inFlight);
        try {
            const value = await ctx.withGitSync(member, true, async () => {
                await new Promise((r) => setTimeout(r, 20)); // let siblings overlap
                const result = await work({ dir: fleet.dirs[member], member, taskId, isFix, prompt });
                if (result && result.error) throw new Error(result.error);
                sh('git add -A', fleet.dirs[member]);
                const dirty = sh('git status --porcelain', fleet.dirs[member]).trim();
                if (dirty) sh(`git commit -qm "work on ${taskId}${isFix ? ' (fix)' : ''}"`, fleet.dirs[member]);
                return { status: 'VERIFY', closedIds: [taskId], notes: 'done' };
            });
            return { value, error: null };
        } catch (err) {
            return { value: null, error: err };
        } finally {
            stats.inFlight -= 1;
        }
    };
    return { dispatchDoer, stats };
}

const writeFile = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
const originLog = (fleet) => sh(`git log --format=%s ${SPRINT}`, fleet.origin);

test('pure scheduling: limit, in-flight, given-up and file overlap', () => {
    const t = (id, files) => ({ id, metadata: files ? { files } : {} });
    const inFlight = new Map([['a', { files: ['x.js'] }]]);
    const ready = [t('a'), t('b', ['x.js']), t('c', ['y.js']), t('d'), t('e')];
    const picks = selectTasksToStart({ ready, inFlight, givenUp: new Set(['e']), freeMembers: 5, limit: Infinity });
    assert.deepEqual(picks.map((p) => p.id), ['c', 'd'], 'a in flight, b overlaps a, e given up');
    assert.deepEqual(selectTasksToStart({ ready, inFlight: new Map(), givenUp: new Set(), freeMembers: 2, limit: Infinity }).map((p) => p.id), ['a', 'b']);
    assert.deepEqual(selectTasksToStart({ ready, inFlight: new Map(), givenUp: new Set(), freeMembers: 9, limit: 3 }).map((p) => p.id), ['a', 'b', 'c']);
    assert.deepEqual(predictedFiles({ metadata: { files: 'a.js, b.js' } }), ['a.js', 'b.js']);
    assert.equal(filesOverlap([], ['a']), false);
    assert.equal(taskBranchName('feat/x', 'app-9cu.1.2'), 'feat/x--task-app-9cu.1.2');
});

test('every ready task builds at once on its own branch and lands one at a time', async () => {
    const fleet = makeFleet(['orch', 'd1', 'd2', 'd3', 'd4']);
    try {
        const beads = makeBeads(['t1', 't2', 't3', 't4'].map((id) => ({ id, title: `Task ${id}` })));
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, taskId }) => writeFile(dir, `${taskId}.txt`, `${taskId}\n`));
        const res = await runBuildPipelinePhase({
            ...engine.deps,
            validated: { branch: SPRINT, pipelineParallel: true },
            orchestratorMember: 'orch',
            doerPool: ['orch', 'd1', 'd2', 'd3', 'd4'],
            dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds.sort(), ['t1', 't2', 't3', 't4']);
        assert.equal(doer.stats.max, 4, 'all four tasks were being built at the same time');
        assert.ok(doer.stats.prompts.every((p) => p.member !== 'orch'), 'the orchestrator only lands, it does not build');
        for (const id of ['t1', 't2', 't3', 't4']) assert.equal(beads.byId.get(id).status, 'closed');
        const files = sh(`git ls-tree --name-only ${SPRINT}`, fleet.origin).split('\n');
        for (const id of ['t1', 't2', 't3', 't4']) assert.ok(files.includes(`${id}.txt`), `${id}.txt is on the sprint branch`);
        assert.equal((originLog(fleet).match(/^Merge (remote-tracking )?branch/gm) || []).length, 4, 'one merge commit per task');
        // Only the orchestrator wrote the task database.
        assert.ok(engine.commands.filter((c) => c.cmd.startsWith('bd ')).every((c) => c.member === 'orch'));
    } finally {
        fleet.cleanup();
    }
});

test('a task starts as soon as the task it depends on lands', async () => {
    const fleet = makeFleet(['orch', 'd1', 'd2']);
    try {
        const beads = makeBeads([{ id: 'a', title: 'A' }, { id: 'b', title: 'B', deps: ['a'] }]);
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, taskId }) => {
            if (taskId === 'b') assert.ok(fs.existsSync(path.join(dir, 'a.txt')), "b's branch starts from a sprint branch that already has a's work");
            writeFile(dir, `${taskId}.txt`, taskId);
        });
        const res = await runBuildPipelinePhase({
            ...engine.deps, validated: { branch: SPRINT, pipelineParallel: true }, orchestratorMember: 'orch',
            doerPool: ['orch', 'd1', 'd2'], dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds, ['a', 'b']);
        assert.equal(doer.stats.max, 1);
    } finally {
        fleet.cleanup();
    }
});

test('tasks predicted to touch the same file never build at the same time', async () => {
    const fleet = makeFleet(['orch', 'd1', 'd2']);
    try {
        const beads = makeBeads([
            { id: 'x1', title: 'X1', metadata: { files: ['app.txt'] } },
            { id: 'x2', title: 'X2', metadata: { files: ['app.txt'] } },
        ]);
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, taskId }) => fs.appendFileSync(path.join(dir, 'app.txt'), `${taskId}\n`));
        const res = await runBuildPipelinePhase({
            ...engine.deps, validated: { branch: SPRINT, pipelineParallel: true }, orchestratorMember: 'orch',
            doerPool: ['orch', 'd1', 'd2'], dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds, ['x1', 'x2']);
        assert.equal(doer.stats.max, 1, 'x2 waited for x1 to land');
        assert.ok(doer.stats.prompts.every((p) => !p.isFix), 'no conflict, so no fix round');
    } finally {
        fleet.cleanup();
    }
});

test('a merge conflict goes back to its doer, which merges the latest work and lands', async () => {
    const fleet = makeFleet(['orch', 'd1', 'd2']);
    try {
        // No predicted files, so both edit line 2 of app.txt at the same time.
        const beads = makeBeads([{ id: 'p', title: 'P' }, { id: 'q', title: 'Q' }]);
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, taskId, isFix, prompt }) => {
            if (!isFix) {
                writeFile(dir, 'app.txt', `line 1\nline 2 by ${taskId}\nline 3\n`);
                return;
            }
            assert.match(prompt, /conflicts with work that already landed/);
            assert.match(prompt, /conflicting files: app\.txt/);
            const mergeRef = /git merge (\S+?)"/.exec(prompt)[1];
            try { sh(`git merge ${mergeRef}`, dir); } catch { /* conflict expected */ }
            writeFile(dir, 'app.txt', 'line 1\nline 2 by p\nline 2 by q\nline 3\n');
        });
        const res = await runBuildPipelinePhase({
            ...engine.deps, validated: { branch: SPRINT, pipelineParallel: true }, orchestratorMember: 'orch',
            doerPool: ['orch', 'd1', 'd2'], dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds.sort(), ['p', 'q']);
        assert.equal(doer.stats.prompts.filter((p) => p.isFix).length, 1, 'exactly one fix round');
        assert.equal(sh(`git show ${SPRINT}:app.txt`, fleet.origin), 'line 1\nline 2 by p\nline 2 by q\nline 3\n');
        assert.ok(engine.logs.some((l) => l.includes('could not land (conflict: app.txt)')));
    } finally {
        fleet.cleanup();
    }
});

test('a failing gate undoes the merge and hands the task back with the output', async () => {
    const fleet = makeFleet(['orch', 'd1']);
    try {
        const beads = makeBeads([{ id: 'g', title: 'G' }]);
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, isFix, prompt }) => {
            if (isFix) assert.match(prompt, /project check failed/);
            writeFile(dir, 'result.txt', isFix ? 'good\n' : 'bad\n');
        });
        const res = await runBuildPipelinePhase({
            ...engine.deps,
            validated: { branch: SPRINT, pipelineParallel: true, gateCommand: 'grep -q good result.txt' },
            orchestratorMember: 'orch', doerPool: ['orch', 'd1'], dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds, ['g']);
        assert.equal(doer.stats.prompts.filter((p) => p.isFix).length, 1);
        assert.equal(sh(`git show ${SPRINT}:result.txt`, fleet.origin), 'good\n');
        assert.equal((originLog(fleet).match(/^Merge (remote-tracking )?branch/gm) || []).length, 1, 'the failed merge was undone, not pushed');
    } finally {
        fleet.cleanup();
    }
});

test('a task that keeps bouncing is given back after the cap; others still land', async () => {
    const fleet = makeFleet(['orch', 'd1', 'd2']);
    try {
        const beads = makeBeads([{ id: 'bad', title: 'Bad' }, { id: 'ok', title: 'Ok' }]);
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, taskId }) => writeFile(dir, `${taskId}.txt`, taskId === 'bad' ? 'bad\n' : 'good\n'));
        const res = await runBuildPipelinePhase({
            ...engine.deps,
            validated: { branch: SPRINT, pipelineParallel: true, gateCommand: '! grep -rqs bad bad.txt' },
            orchestratorMember: 'orch', doerPool: ['orch', 'd1', 'd2'], dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds, ['ok']);
        assert.deepEqual(res.givenUpIds, ['bad']);
        assert.equal(doer.stats.prompts.filter((p) => p.taskId === 'bad').length, MAX_LANDING_BOUNCES);
        assert.equal(beads.byId.get('bad').status, 'open', 'given back for the next cycle');
        assert.equal(beads.byId.get('ok').status, 'closed');
    } finally {
        fleet.cleanup();
    }
});

test('a doer that fails is given back without blocking the rest', async () => {
    const fleet = makeFleet(['orch', 'd1', 'd2']);
    try {
        const beads = makeBeads([{ id: 'boom', title: 'Boom' }, { id: 'fine', title: 'Fine' }]);
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, taskId }) => (taskId === 'boom' ? { error: 'crashed' } : writeFile(dir, 'fine.txt', 'ok')));
        const res = await runBuildPipelinePhase({
            ...engine.deps, validated: { branch: SPRINT, pipelineParallel: true }, orchestratorMember: 'orch',
            doerPool: ['orch', 'd1', 'd2'], dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds, ['fine']);
        assert.deepEqual(res.givenUpIds, ['boom']);
        assert.equal(beads.byId.get('boom').status, 'open');
        assert.ok(res.streakOutcomes.some((o) => o.beadIds[0] === 'boom' && o.outcome === 'failed' && /crashed/.test(o.error)));
    } finally {
        fleet.cleanup();
    }
});

test('a doer that commits nothing does not land', async () => {
    const fleet = makeFleet(['orch', 'd1']);
    try {
        const beads = makeBeads([{ id: 'noop', title: 'Noop' }]);
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, () => {});
        const res = await runBuildPipelinePhase({
            ...engine.deps, validated: { branch: SPRINT, pipelineParallel: true }, orchestratorMember: 'orch',
            doerPool: ['orch', 'd1'], dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds, []);
        assert.match(res.streakOutcomes[0].error, /^no-commits/);
    } finally {
        fleet.cleanup();
    }
});

test('max_doers caps how many tasks build at once', async () => {
    const fleet = makeFleet(['orch', 'd1', 'd2', 'd3']);
    try {
        const beads = makeBeads(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, title: id })));
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, taskId }) => writeFile(dir, `${taskId}.txt`, taskId));
        const res = await runBuildPipelinePhase({
            ...engine.deps, validated: { branch: SPRINT, pipelineParallel: true, maxDoers: 2 }, orchestratorMember: 'orch',
            doerPool: ['orch', 'd1', 'd2', 'd3'], dispatchDoer: doer.dispatchDoer,
        });
        assert.equal(res.landedIds.length, 5);
        assert.equal(doer.stats.max, 2);
    } finally {
        fleet.cleanup();
    }
});

test('shared workspace (no --sync): one task at a time in the one checkout', async () => {
    const fleet = makeFleet(['solo']);
    try {
        const beads = makeBeads(['a', 'b', 'c'].map((id) => ({ id, title: id })));
        const engine = makeEngine(fleet, beads);
        const doer = makeDoer(fleet, ({ dir, taskId }) => writeFile(dir, `${taskId}.txt`, taskId));
        const res = await runBuildPipelinePhase({
            ...engine.deps, validated: { branch: SPRINT, pipelineParallel: false }, orchestratorMember: 'solo',
            doerPool: ['solo'], dispatchDoer: doer.dispatchDoer,
        });
        assert.deepEqual(res.landedIds, ['a', 'b', 'c']);
        assert.equal(doer.stats.max, 1);
        assert.equal(sh('git rev-parse --abbrev-ref HEAD', fleet.dirs.solo).trim(), SPRINT, 'left on the sprint branch');
        const files = sh(`git ls-tree --name-only ${SPRINT}`, fleet.origin).split('\n');
        for (const id of ['a', 'b', 'c']) assert.ok(files.includes(`${id}.txt`));
    } finally {
        fleet.cleanup();
    }
});
