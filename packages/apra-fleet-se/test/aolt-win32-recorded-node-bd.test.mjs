// apra-fleet-aolt.1 / apra-fleet-aolt.2 -- on Windows the supervisor's async
// bd call (exec-bd.mjs execBdAsync()) and its startup bd probe (toolchain.mjs
// validateRecordedToolchain()) used to run bd.cmd through the shell. The shim
// body runs a bare `node`, so bd only worked when node was on the system PATH
// (MSI install). Now both run `<recorded node> <bd script> <args>` via
// execFile with no shell when the shim resolves, and keep the old
// `{ shell: true }` route (behind assertSafeArgs) only when it does not.
//
// Every case here injects `platform: 'win32'`, a PATH that holds no node,
// and a fake exec, so it runs on every host.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    execBdAsync, configureBdInvocation, resolveWin32BdShimInvocation,
} from '../src/supervisor/lib/exec-bd.mjs';
import { validateRecordedToolchain, TOOLCHAIN_PROBE_TIMEOUT_MS } from '../src/supervisor/toolchain.mjs';
import { writeSupervisorToolchain, supervisorConfigPath } from '../src/supervisor/project-config.mjs';
import { MIN_NODE_VERSION } from '../src/supervisor/node-runner.mjs';

const RECORDED_NODE = 'C:\\tools\\node22\\node.exe';
const RECORDED_BD = 'C:\\Users\\jane\\AppData\\Roaming\\npm\\bd.cmd';
const BD_SCRIPT = 'C:\\Users\\jane\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.js';
/** A Windows PATH with no node directory on it -- what a scheduled task inherits. */
const NODELESS_PATH = 'C:\\Windows\\system32;C:\\Windows;C:\\Users\\jane\\AppData\\Roaming\\npm';

const tmpDirs = [];
async function mkTmp(prefix) {
    const dir = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    configureBdInvocation({});
    while (tmpDirs.length) {
        await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
    }
});

function capturingExecAsync(stdout = '[]') {
    const calls = [];
    const exec = async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout, stderr: '' };
    };
    return { exec, calls };
}

describe('apra-fleet-aolt.1: execBdAsync() on win32 runs the recorded node plus the bd script, no shell', () => {
    test('configured bd.cmd + recorded node: command is the recorded node, first arg the bd script, shell false', async () => {
        configureBdInvocation({ bdPath: RECORDED_BD, nodePath: RECORDED_NODE });
        const { exec, calls } = capturingExecAsync('[{"id":"x-1"}]');
        const seen = [];
        const result = await execBdAsync(
            ['list', '--json', '--limit', '0'],
            { cwd: 'C:\\repo', env: { Path: NODELESS_PATH } },
            exec,
            undefined,
            'win32',
            { resolveConfiguredWindowsBd: (bdPath, deps) => { seen.push({ bdPath, deps }); return BD_SCRIPT; } },
        );
        assert.equal(result.stdout, '[{"id":"x-1"}]', 'the call succeeds against the fake exec');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, RECORDED_NODE);
        assert.deepEqual(calls[0].args, [BD_SCRIPT, 'list', '--json', '--limit', '0']);
        assert.equal(calls[0].options.shell, false);
        assert.equal(calls[0].options.cwd, 'C:\\repo');
        assert.deepEqual(calls[0].options.env, { Path: NODELESS_PATH }, 'the node-less PATH is passed through untouched -- the recorded node needs no PATH help');
        assert.deepEqual(seen, [{ bdPath: RECORDED_BD, deps: { platform: 'win32' } }]);
    });

    test('unconfigured bdPath + recorded node: the PATH-scanned bd.cmd is run through the recorded node', async () => {
        configureBdInvocation({ nodePath: RECORDED_NODE });
        const { exec, calls } = capturingExecAsync();
        await execBdAsync(['list', '--json'], {}, exec, undefined, 'win32', { resolveWindowsBd: () => BD_SCRIPT });
        assert.equal(calls[0].file, RECORDED_NODE);
        assert.deepEqual(calls[0].args, [BD_SCRIPT, 'list', '--json']);
        assert.equal(calls[0].options.shell, false);
    });

    test('an unresolvable shim keeps the shell fallback, and assertSafeArgs still guards it', async () => {
        configureBdInvocation({ bdPath: RECORDED_BD, nodePath: RECORDED_NODE });
        const { exec, calls } = capturingExecAsync();
        const resolvers = { resolveConfiguredWindowsBd: () => null };
        await execBdAsync(['list', '--json'], {}, exec, undefined, 'win32', resolvers);
        assert.equal(calls[0].file, RECORDED_BD, 'falls back to the configured bdPath itself');
        assert.deepEqual(calls[0].args, ['list', '--json']);
        assert.equal(calls[0].options.shell, true);
        assert.throws(
            () => execBdAsync(['list', '--parent', 'a & echo INJECTED'], {}, exec, undefined, 'win32', resolvers),
            /unsafe bd argument/,
        );
        assert.equal(calls.length, 1, 'the unsafe call never reached exec');
    });

    test('no recorded node: the shim is not used even when it resolves (no process.execPath guess)', async () => {
        configureBdInvocation({ bdPath: RECORDED_BD });
        const { exec, calls } = capturingExecAsync();
        await execBdAsync(['list'], {}, exec, undefined, 'win32', { resolveConfiguredWindowsBd: () => BD_SCRIPT });
        assert.equal(calls[0].file, RECORDED_BD);
        assert.equal(calls[0].options.shell, true);
    });

    test('POSIX is unchanged: a recorded node never reroutes the call', async () => {
        configureBdInvocation({ bdPath: '/opt/npm/bin/bd', nodePath: '/opt/node/bin/node' });
        const { exec, calls } = capturingExecAsync();
        await execBdAsync(['list'], {}, exec, undefined, 'linux', { resolveConfiguredWindowsBd: () => BD_SCRIPT });
        assert.equal(calls[0].file, '/opt/npm/bin/bd');
        assert.equal(calls[0].options.shell, true);
    });
});

describe('apra-fleet-aolt.1: resolveWin32BdShimInvocation()', () => {
    test('returns null off win32, without a node path, or when the shim does not resolve', () => {
        const ok = () => BD_SCRIPT;
        assert.equal(resolveWin32BdShimInvocation({ platform: 'darwin', nodePath: RECORDED_NODE, bdPath: RECORDED_BD, resolveConfiguredWindowsBd: ok }), null);
        assert.equal(resolveWin32BdShimInvocation({ platform: 'win32', nodePath: '', bdPath: RECORDED_BD, resolveConfiguredWindowsBd: ok }), null);
        assert.equal(resolveWin32BdShimInvocation({ platform: 'win32', nodePath: RECORDED_NODE, bdPath: RECORDED_BD, resolveConfiguredWindowsBd: () => null }), null);
        assert.equal(resolveWin32BdShimInvocation({ platform: 'win32', nodePath: RECORDED_NODE, bdPath: RECORDED_BD, resolveConfiguredWindowsBd: () => { throw new Error('boom'); } }), null);
        assert.deepEqual(
            resolveWin32BdShimInvocation({ platform: 'win32', nodePath: RECORDED_NODE, bdPath: RECORDED_BD, resolveConfiguredWindowsBd: ok }),
            { nodePath: RECORDED_NODE, scriptPath: BD_SCRIPT },
        );
    });
});

describe('apra-fleet-aolt.1: startup bd probe on win32 runs the recorded node plus the bd script, no shell', () => {
    // writeSupervisorToolchain() validates paths as absolute for the HOST
    // platform, so the recorded paths are forward-slash rooted (absolute on
    // both POSIX and win32), as in i9ag19-9-toolchain.test.mjs's win32 block.
    const nodePath = '/tools/node22/node.exe';
    const bdPath = '/npm/bd.cmd';
    const bdScript = '/npm/node_modules/@beads/bd/bin/bd.js';

    function fakeExec() {
        const calls = [];
        const exec = async (file, args, options) => {
            calls.push({ file, args, options });
            if (file === nodePath && args[0] === '--version') return `v${MIN_NODE_VERSION}`;
            if (file === nodePath && args[0] === bdScript) return 'bd version 1.2.3';
            throw new Error(`spawn ENOENT: ${file}`);
        };
        return { exec, calls };
    }

    test('a resolvable shim is probed as <recorded node> <bd script> --version with shell false', async () => {
        const dataDir = await mkTmp('aolt-toolchain-');
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath, bdPath }, { filePath });
        const { exec, calls } = fakeExec();
        const originalPath = process.env.PATH;
        process.env.PATH = NODELESS_PATH;
        let result;
        try {
            result = await validateRecordedToolchain({
                filePath, exec, platform: 'win32',
                resolveConfiguredWindowsBd: (p) => (p === bdPath ? bdScript : null),
            });
        } finally {
            process.env.PATH = originalPath;
        }
        assert.equal(result.bdOk, true, `bd must probe ok: ${result.problems.join(' ')}`);
        assert.equal(result.bdVersion, '1.2.3');
        const bdCall = calls.find((c) => c.args[0] === bdScript);
        assert.ok(bdCall, 'the bd probe ran through the bd script');
        assert.equal(bdCall.file, nodePath);
        assert.deepEqual(bdCall.args, [bdScript, '--version']);
        assert.deepEqual(bdCall.options, { shell: false, timeout: TOOLCHAIN_PROBE_TIMEOUT_MS });
    });

    test('an unresolvable shim keeps the win32 shell probe of the recorded bd path', async () => {
        const dataDir = await mkTmp('aolt-toolchain-');
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath, bdPath }, { filePath });
        const { exec, calls } = fakeExec();
        await validateRecordedToolchain({ filePath, exec, platform: 'win32', resolveConfiguredWindowsBd: () => null });
        const bdCall = calls.find((c) => c.file === bdPath);
        assert.ok(bdCall, 'the bd probe ran against the recorded bd path');
        assert.deepEqual(bdCall.options, { shell: true, timeout: TOOLCHAIN_PROBE_TIMEOUT_MS });
    });
});
