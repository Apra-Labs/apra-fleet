// serve.mjs launch mode: with neither --detach nor --foreground, an
// interactive console launch (stdin or stdout is a TTY) detaches by default so
// the supervisor survives the console closing; a non-TTY launch (service
// manager, CI, a parent holding pipes) stays in the foreground; --foreground
// forces the foreground on a TTY; --detach --foreground is a usage error.
//
// Pure unit tests: the streams and platform are injected, and serveMain's
// detach path is driven with a fake detachSupervisor, so nothing is spawned.
// Regression guard: if serveMain ever falls through to the foreground boot
// here, FLEET_SE_DATA_DIR points at a temp dir and --beads-dir names a path
// that does not exist, so the boot fails fast inside the temp dir instead of
// serving against the real data dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLaunchMode, isInteractiveConsole, detachedChildArgs } from '../src/supervisor/detach.mjs';
import { serveMain, parseServeArgs } from '../bin/serve.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-mode-'));
const savedDataDir = process.env.FLEET_SE_DATA_DIR;
process.env.FLEET_SE_DATA_DIR = path.join(TMP, 'se-data');
const MISSING_BEADS = path.join(TMP, 'no-such-project');
after(() => {
    if (savedDataDir === undefined) delete process.env.FLEET_SE_DATA_DIR; else process.env.FLEET_SE_DATA_DIR = savedDataDir;
    fs.rmSync(TMP, { recursive: true, force: true });
});

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

test('isInteractiveConsole: either stream being a TTY counts', () => {
    assert.equal(isInteractiveConsole({ stdin: TTY, stdout: PIPE }), true);
    assert.equal(isInteractiveConsole({ stdin: PIPE, stdout: TTY }), true);
    assert.equal(isInteractiveConsole({ stdin: PIPE, stdout: PIPE }), false);
    assert.equal(isInteractiveConsole({}), false);
});

test('resolveLaunchMode: no flags on a TTY detaches (every platform)', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
        assert.deepEqual(resolveLaunchMode({ stdin: TTY, stdout: TTY, platform }), { mode: 'detach', reason: 'interactive-console', platform });
    }
});

test('resolveLaunchMode: no flags without a TTY stays in the foreground', () => {
    assert.equal(resolveLaunchMode({ stdin: PIPE, stdout: PIPE, platform: 'win32' }).mode, 'foreground');
    assert.equal(resolveLaunchMode({ platform: 'linux' }).reason, 'non-interactive');
});

test('resolveLaunchMode: --foreground on a TTY stays in the foreground; --detach without a TTY detaches', () => {
    assert.deepEqual(resolveLaunchMode({ foreground: true, stdin: TTY, stdout: TTY, platform: 'win32' }), { mode: 'foreground', reason: 'flag', platform: 'win32' });
    assert.deepEqual(resolveLaunchMode({ detach: true, stdin: PIPE, stdout: PIPE, platform: 'linux' }), { mode: 'detach', reason: 'flag', platform: 'linux' });
});

test('resolveLaunchMode: --detach with --foreground is refused', () => {
    assert.throws(() => resolveLaunchMode({ detach: true, foreground: true }), /cannot be used together/);
});

test('parseServeArgs / serveMain refuse --detach --foreground with a usage error', async () => {
    assert.throws(() => parseServeArgs(['--detach', '--foreground']), /--detach and --foreground cannot be used together[\s\S]*Usage:/);
    await assert.rejects(serveMain(['--foreground', '--detach'], { stdio: { stdin: TTY, stdout: TTY } }), /cannot be used together/);
});

test('detachedChildArgs: the child always runs --foreground, never --detach', () => {
    assert.deepEqual(detachedChildArgs(['--port', '1', '--detach']), ['--port', '1', '--foreground']);
    assert.deepEqual(detachedChildArgs(['--port', '1']), ['--port', '1', '--foreground']);
});

test('serveMain on an injected TTY with no flags takes the detach path and exits 0', async () => {
    const calls = [];
    const fakeDetach = async (opts) => { calls.push(opts); return { exitCode: 0, pid: 4242 }; };
    for (const platform of ['linux', 'win32']) {
        calls.length = 0;
        // eslint-disable-next-line no-await-in-loop
        const r = await serveMain(['--port', '18999', '--beads-dir', MISSING_BEADS], { installExitLog: false, stdio: { stdin: TTY, stdout: PIPE }, platform, detachSupervisor: fakeDetach });
        assert.equal(r.exitCode, 0, platform);
        assert.equal(calls.length, 1, `${platform}: detachSupervisor must be invoked`);
        assert.equal(calls[0].port, 18999);
        assert.deepEqual(calls[0].argv, ['--port', '18999', '--beads-dir', MISSING_BEADS]);
    }
});

test('serveMain propagates a failed detach as a non-zero exit', async () => {
    const r = await serveMain(['--beads-dir', MISSING_BEADS], { installExitLog: false, stdio: { stdin: TTY, stdout: TTY }, detachSupervisor: async () => ({ exitCode: 1 }) });
    assert.equal(r.exitCode, 1);
});
