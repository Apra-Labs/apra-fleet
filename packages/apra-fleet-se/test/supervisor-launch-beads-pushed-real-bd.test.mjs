// Real-bd integration test for the unpushed-beads launch preflight: a real
// beads clone with a real Dolt remote (a local bare git repo, git+file://),
// the real createSprintController launch handler with the real probe, and a
// stubbed child spawner.
//
// Falsifiability: reverting the preflight in src/supervisor/api.mjs makes
// scenario 1 fail (the launch is accepted and the spawner is called).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec, execFileSync } from 'node:child_process';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSprintController } from '../src/supervisor/api.mjs';
import { createBeadsPushedProbe } from '../src/supervisor/beads-pushed-check.mjs';
import { createBeadsFixture, envWithoutBeadsDir } from './helpers/beads-fixture.mjs';

const LAUNCH = { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' };
const cleanups = [];
after(async () => { for (const c of cleanups.splice(0)) await c(); });

function bd(args, cwd) {
    return new Promise((resolve, reject) => {
        exec(`bd ${args}`, { cwd, env: envWithoutBeadsDir(), windowsHide: true }, (err, stdout, stderr) => (
            err ? reject(new Error(`bd ${args} failed: ${err.message}\n${stderr}`)) : resolve(stdout)));
    });
}

async function bareRemote() {
    const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'bdpush-remote-')));
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const bare = path.join(dir, 'remote.git');
    const seed = path.join(dir, 'seed');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['clone', '-q', bare, seed], { stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: seed });
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: seed });
    return bare;
}

async function makeController(cwd) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bdpush-ctl-'));
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    const now = () => '2026-10-01T00:00:00.000Z';
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now });
    await history.start();
    const spawned = [];
    const spawner = { spawnSprint: async (o) => { spawned.push(o); return { pid: 4242, port: 9999, logPath: 'x.log' }; } };
    const controller = createSprintController({
        ledger, history, spawner, listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }),
        checkBeadsPushed: createBeadsPushedProbe({ cwd }),
    });
    return { controller, ledger, spawned };
}

// bd's push to a local file remote fails on the windows-latest CI runner
// ("update_ref failed for ref 'refs/dolt/blobstore/origin/...'", Error 1105)
// although it works on a Windows dev box; the refusal/accept logic is covered
// by supervisor-launch-beads-pushed-preflight.test.mjs (injected probe) and by
// scenario 2 below (real bd, no remote). Skipped only for Windows CI.
const SKIP_WIN_CI_PUSH = (process.platform === 'win32' && process.env.CI)
    ? 'real bd cannot push to a local file remote on the windows-latest runner (update_ref on refs/dolt/blobstore)'
    : false;

test('unpushed beads: launch refused with the push remedy, then accepted after commit + push (real bd)', { skip: SKIP_WIN_CI_PUSH }, async () => {
    const fx = await createBeadsFixture();
    cleanups.push(fx.cleanup);
    const remote = await bareRemote();
    await bd(`dolt remote add origin git+file:///${remote.split(path.sep).join('/').replace(/^[/]/, '')}`, fx.dir);
    await bd('dolt push', fx.dir);
    const t = await makeController(fx.dir);

    await bd('create "unpushed work" -t task -p 2 --silent', fx.dir);
    await assert.rejects(() => t.controller.launch({ ...LAUNCH }), (err) => {
        assert.equal(err.statusCode ?? err.status, 409);
        assert.match(err.message, /`bd dolt commit`, then `bd dolt push`/);
        return true;
    });
    assert.equal(t.spawned.length, 0, 'no child spawned');
    assert.equal(t.ledger.list().length, 0, 'no ledger reservation');

    await bd('dolt commit', fx.dir).catch(() => {}); // bd may have auto-committed already
    await bd('dolt push', fx.dir);
    const res = await t.controller.launch({ ...LAUNCH });
    assert.equal(t.spawned.length, 1, 'launch accepted after the push');
    assert.equal(res.beadsPushWarning, undefined);
});

test('a clone with no remote-tracking branch: launch accepted with an inconclusive-check warning (real bd)', async () => {
    const fx = await createBeadsFixture();
    cleanups.push(fx.cleanup);
    const t = await makeController(fx.dir);
    const res = await t.controller.launch({ ...LAUNCH });
    assert.equal(t.spawned.length, 1);
    assert.match(String(res.beadsPushWarning), /could not verify/);
    assert.match(String(res.beadsPushWarning), /bd diff failed|could not read/);
});
