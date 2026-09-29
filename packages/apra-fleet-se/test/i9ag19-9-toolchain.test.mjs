// apra-fleet-i9ag.19.9 -- packages/apra-fleet-se/src/supervisor/toolchain.mjs's
// validateRecordedToolchain(): re-probes the toolchain recorded in
// supervisor.config.json (read ONLY through project-config.mjs's
// readSupervisorConfig()) at supervisor startup, and reports precisely what
// is wrong with it, if anything -- never throwing. See toolchain.mjs's
// file-level doc comment for the full rationale.
//
// Every case below drives a REAL temp supervisor.config.json (via
// writeSupervisorToolchain()/a raw fs.writeFile()) plus an injected `exec` --
// no real node, no real bd, and no real config file under the actual home
// directory are ever touched, matching node-runner.mjs's own
// injected-exec/injected-platform convention this module was written to
// follow.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateRecordedToolchain, TOOLCHAIN_FIX_LINE, TOOLCHAIN_PROBE_TIMEOUT_MS } from '../src/supervisor/toolchain.mjs';
import { writeSupervisorToolchain, supervisorConfigPath } from '../src/supervisor/project-config.mjs';
import { MIN_NODE_VERSION } from '../src/supervisor/node-runner.mjs';

/** Temp dirs created by this file, removed in afterEach. */
const tmpDirs = [];

async function mkTmp(prefix = 'apra-fleet-toolchain-validate-') {
    const dir = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tmpDirs.length) {
        await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
    }
});

/** A fake `exec(file, args, options)` -- `versions` maps the exact string
 * `exec` should receive as `file` to a version string (parsed by the
 * module's own parseVersionString(), so 'vX.Y.Z' or 'X.Y.Z' both work), or
 * `null`/absent to simulate a spawn failure (e.g. ENOENT). Also records
 * every call so a test can assert exactly what was (or was never) probed. */
function fakeExecCapturing(versions) {
    const calls = [];
    const exec = (file, args, options) => {
        calls.push({ file, args, options });
        if (!Object.prototype.hasOwnProperty.call(versions, file) || versions[file] === null) {
            throw new Error(`spawn ENOENT: ${file}`);
        }
        return versions[file];
    };
    return { exec, calls };
}

describe('apra-fleet-i9ag.19.9: validateRecordedToolchain() -- AC1 good recording', () => {
    test('a good recording (real node + real bd) yields ok:true, nodeOk:true, bdOk:true, both versions, and no problems', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain(
            { nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' },
            { filePath },
        );
        const { exec } = fakeExecCapturing({
            '/opt/toolchain/node': `v${MIN_NODE_VERSION}`,
            '/opt/toolchain/bd': 'bd version 1.2.3',
        });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.deepEqual(result, {
            configured: true,
            nodePath: '/opt/toolchain/node',
            nodeVersion: MIN_NODE_VERSION,
            bdPath: '/opt/toolchain/bd',
            bdVersion: '1.2.3',
            source: filePath,
            reason: null,
            ok: true,
            nodeOk: true,
            bdOk: true,
            problems: [],
            fixLine: TOOLCHAIN_FIX_LINE,
        });
    });
});

describe('apra-fleet-i9ag.19.9: validateRecordedToolchain() -- AC2 missing node', () => {
    test('a recorded node that does not exist yields ok:false/nodeOk:false, naming that exact path and the probe failure', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain(
            { nodePath: '/does/not/exist/node', bdPath: '/opt/toolchain/bd' },
            { filePath },
        );
        const { exec } = fakeExecCapturing({ '/opt/toolchain/bd': 'bd version 1.2.3' });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.configured, true);
        assert.equal(result.ok, false);
        assert.equal(result.nodeOk, false);
        assert.equal(result.nodeVersion, null);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /\/does\/not\/exist\/node/);
        assert.match(result.problems[0], /does not resolve to a usable Node\.js runtime/);
        // bd was fine, and stays intact/separately readable despite the node failure.
        assert.equal(result.bdOk, true);
        assert.equal(result.bdVersion, '1.2.3');
    });
});

describe('apra-fleet-i9ag.19.9: validateRecordedToolchain() -- AC3 node below minimum', () => {
    test('a recorded node below MIN_NODE_VERSION yields ok:false/nodeOk:false, naming the found version and the minimum from the existing constant', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain(
            { nodePath: '/opt/toolchain/old-node', bdPath: '/opt/toolchain/bd' },
            { filePath },
        );
        const { exec } = fakeExecCapturing({
            '/opt/toolchain/old-node': 'v20.0.0',
            '/opt/toolchain/bd': 'bd version 1.2.3',
        });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.ok, false);
        assert.equal(result.nodeOk, false);
        assert.equal(result.nodeVersion, '20.0.0');
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /\/opt\/toolchain\/old-node/);
        assert.match(result.problems[0], /20\.0\.0/, 'names the found version');
        assert.match(result.problems[0], new RegExp(MIN_NODE_VERSION.replace(/\./g, '\\.')), 'names the required minimum, sourced from MIN_NODE_VERSION');
        assert.doesNotMatch(result.problems[0], /does not resolve to a usable Node\.js runtime/, 'a too-old version is a DIFFERENT problem from an unprobeable one');
    });
});

describe('apra-fleet-i9ag.19.9: validateRecordedToolchain() -- AC4 bd broken, node intact', () => {
    test('a recorded bd that cannot be probed yields bdOk:false as its own problem entry, while node stays ok:true/nodeOk:true and separately readable', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain(
            { nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/broken-bd' },
            { filePath },
        );
        const { exec } = fakeExecCapturing({ '/opt/toolchain/node': `v${MIN_NODE_VERSION}` });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        // Node is entirely unaffected by bd's failure.
        assert.equal(result.ok, true, '"ok" tracks node health only -- bd never flips it');
        assert.equal(result.nodeOk, true);
        assert.equal(result.nodeVersion, MIN_NODE_VERSION);
        // bd's failure is machine-readable (bdOk) AND has its own worded entry.
        assert.equal(result.bdOk, false);
        assert.equal(result.bdVersion, null);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /\/opt\/toolchain\/broken-bd/);
        assert.match(result.problems[0], /does not resolve to a usable bd/);
        // The node problem wording and the bd problem wording must never be
        // confusable by a consumer -- distinct sentences, distinct fields.
        assert.doesNotMatch(result.problems[0], /Node\.js/);
    });

    test('no bd path recorded at all (bdPath: null) yields bdOk:false with its own distinct wording, node still fine', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node' }, { filePath });
        const { exec, calls } = fakeExecCapturing({ '/opt/toolchain/node': `v${MIN_NODE_VERSION}` });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.ok, true);
        assert.equal(result.nodeOk, true);
        assert.equal(result.bdOk, false);
        assert.equal(result.bdPath, null);
        assert.equal(result.bdVersion, null);
        assert.deepEqual(result.problems, ['No bd path was recorded for this installation.']);
        // No bd probe should ever have been attempted -- there was nothing to probe.
        assert.equal(calls.length, 1, 'only the node probe ran');
        assert.equal(calls[0].file, '/opt/toolchain/node');
    });
});

describe('apra-fleet-i9ag.19.9: validateRecordedToolchain() -- AC5 nothing recorded', () => {
    test('an empty data dir (no config file at all) yields configured:false, no problems, nodeOk/bdOk null, and never throws', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const { exec, calls } = fakeExecCapturing({});

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.configured, false);
        assert.equal(result.nodePath, null);
        assert.equal(result.nodeVersion, null);
        assert.equal(result.bdPath, null);
        assert.equal(result.bdVersion, null);
        assert.equal(result.ok, true);
        assert.equal(result.nodeOk, null);
        assert.equal(result.bdOk, null);
        assert.deepEqual(result.problems, []);
        assert.equal(result.fixLine, TOOLCHAIN_FIX_LINE);
        assert.match(result.reason, /no supervisor\.config\.json/);
        assert.equal(calls.length, 0, 'nothing recorded means nothing is ever probed');
    });
});

describe('apra-fleet-i9ag.19.9: validateRecordedToolchain() -- AC6 malformed config file', () => {
    test('a config file that is not valid JSON yields configured:false with the reader\'s own reason, never a throw', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, 'not valid json {{{', 'utf-8');
        const { exec, calls } = fakeExecCapturing({});

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.configured, false);
        assert.equal(result.ok, true);
        assert.equal(result.nodeOk, null);
        assert.equal(result.bdOk, null);
        assert.deepEqual(result.problems, []);
        assert.match(result.reason, /is not valid JSON/);
        assert.equal(calls.length, 0);
    });

    test('a config file whose toolchain block is malformed (not an object) yields configured:false with that specific reason, never a throw', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify({ projectDir: '/some/project', toolchain: 'not-an-object' }), 'utf-8');
        const { exec, calls } = fakeExecCapturing({});

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.configured, false);
        assert.equal(result.ok, true);
        assert.equal(result.nodeOk, null);
        assert.equal(result.bdOk, null);
        assert.match(result.reason, /toolchain.*that is not an object/);
        assert.equal(calls.length, 0);
    });

    test('never throws even when a real path does not exist at all under a nonexistent data dir', async () => {
        const filePath = path.join(await mkTmp(), 'nested', 'does-not-exist', 'supervisor.config.json');
        const { exec } = fakeExecCapturing({});
        await assert.doesNotReject(validateRecordedToolchain({ filePath, exec, platform: 'linux' }));
    });
});

describe('apra-fleet-i9ag.19.9: validateRecordedToolchain() -- win32 spaced-path probing', () => {
    // NOTE: project-config.mjs's readToolchainBlock() validates `nodePath`
    // via the REAL (non-injectable) `node:path` module's path.isAbsolute(),
    // which follows the actual host platform, not this test's injected
    // `platform: 'win32'` -- a literal 'C:\...' path is therefore rejected as
    // "not absolute" when this suite runs on a POSIX CI runner. A leading
    // '/' is considered absolute on both POSIX and win32 (Node's own
    // path.win32.isAbsolute() treats a forward-slash-rooted path as
    // absolute too), so these spaced paths are POSIX-shaped while still
    // exercising toolchain.mjs's own win32 shell-quoting branch via the
    // injected `platform`.
    test('a spaced recorded node path is quoted before the win32 shell probe, and resolves', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const spacedNode = '/opt/Program Files/nodejs/node.exe';
        const spacedBd = '/opt/Some User/AppData/Roaming/npm/bd.cmd';
        await writeSupervisorToolchain({ nodePath: spacedNode, bdPath: spacedBd }, { filePath });
        const { exec, calls } = fakeExecCapturing({
            [`"${spacedNode}"`]: `v${MIN_NODE_VERSION}`,
            [`"${spacedBd}"`]: 'bd version 1.2.3',
        });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'win32' });

        assert.equal(result.ok, true);
        assert.equal(result.nodeOk, true);
        assert.equal(result.bdOk, true);
        // The result reports the ORIGINAL unquoted paths back to the caller.
        assert.equal(result.nodePath, spacedNode);
        assert.equal(result.bdPath, spacedBd);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].file, `"${spacedNode}"`, 'the node probe itself was quoted for the win32 shell');
        assert.equal(calls[0].options.shell, true);
        assert.equal(calls[1].file, `"${spacedBd}"`, 'the bd probe itself was quoted for the win32 shell');
        assert.equal(calls[1].options.shell, true);
    });

    test('a spaced recorded node path on non-win32 is probed unquoted and without a shell', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const spacedNode = '/usr/local/my node/bin/node';
        await writeSupervisorToolchain({ nodePath: spacedNode }, { filePath });
        const { exec, calls } = fakeExecCapturing({ [spacedNode]: `v${MIN_NODE_VERSION}` });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'darwin' });

        assert.equal(result.nodeOk, true);
        assert.equal(calls[0].file, spacedNode, 'non-win32 never quotes -- no shell is used there');
        assert.equal(calls[0].options.shell, false);
    });
});

describe('apra-fleet-i9ag.19.9: validateRecordedToolchain() -- never throws on a broken injected exec', () => {
    test('an exec that throws a non-Error value is still absorbed into a problem entry, not a rethrow', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node' }, { filePath });
        const exec = () => { throw 'not-an-error-object'; }; // eslint-disable-line no-throw-literal

        await assert.doesNotReject(validateRecordedToolchain({ filePath, exec, platform: 'linux' }));
    });
});

// apra-fleet-i9ag.19.11 AC6: branches of validateRecordedToolchain() this
// file's own AC1-AC6 coverage above did not yet exercise -- every case above
// drives it through `filePath` plus an injected `exec`/`platform`; the four
// below cover the remaining injectable seams (`dataDir`, `fs`, the probe
// timeout actually threaded through to `exec`) and the REAL default `exec`
// (execFileSync), which no case above ever calls.
describe('apra-fleet-i9ag.19.9 / apra-fleet-i9ag.19.11: validateRecordedToolchain() -- remaining injectable seams', () => {
    test('deps.dataDir (not filePath) resolves to the SAME supervisor.config.json readSupervisorConfig() would use', async () => {
        const dataDir = await mkTmp();
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' }, { dataDir });
        const { exec } = fakeExecCapturing({
            '/opt/toolchain/node': `v${MIN_NODE_VERSION}`,
            '/opt/toolchain/bd': 'bd version 1.2.3',
        });

        const result = await validateRecordedToolchain({ dataDir, exec, platform: 'linux' });

        assert.equal(result.configured, true);
        assert.equal(result.ok, true);
        assert.equal(result.source, supervisorConfigPath({ dataDir }), 'source must be the SAME path a dataDir-based caller would resolve');
    });

    test('deps.fs (an injected reader, no real file on disk) is honored, exactly like readSupervisorConfig() itself', async () => {
        const filePath = path.join(await mkTmp(), 'supervisor.config.json');
        const fakeFs = {
            readFile: async (p, enc) => {
                assert.equal(p, filePath);
                assert.equal(enc, 'utf-8');
                return JSON.stringify({ toolchain: { nodePath: '/opt/toolchain/node' } });
            },
        };
        const { exec, calls } = fakeExecCapturing({ '/opt/toolchain/node': `v${MIN_NODE_VERSION}` });

        const result = await validateRecordedToolchain({ filePath, fs: fakeFs, exec, platform: 'linux' });

        assert.equal(result.configured, true);
        assert.equal(result.ok, true);
        assert.equal(result.nodePath, '/opt/toolchain/node');
        assert.equal(calls.length, 1, 'the injected fs reader must be what fed the probe, not a real file on disk');
    });

    test('every probe carries TOOLCHAIN_PROBE_TIMEOUT_MS as its exec options.timeout, so a wedged binary can never hang startup', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' }, { filePath });
        const { exec, calls } = fakeExecCapturing({
            '/opt/toolchain/node': `v${MIN_NODE_VERSION}`,
            '/opt/toolchain/bd': 'bd version 1.2.3',
        });

        await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(calls.length, 2);
        for (const call of calls) {
            assert.equal(call.options.timeout, TOOLCHAIN_PROBE_TIMEOUT_MS, `probe of ${call.file} did not carry the wall-clock ceiling`);
        }
    });

    test('the REAL default exec (execFileSync) resolves a real absolute node path when no exec is injected', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        // process.execPath is a real, absolute, spawnable Node.js runtime --
        // exactly the shape a genuine recording would carry -- and this is
        // this test file's ONLY case that lets validateRecordedToolchain()
        // fall through to its own real defaultExec()/process.platform
        // instead of an injected fake.
        await writeSupervisorToolchain({ nodePath: process.execPath }, { filePath });

        const result = await validateRecordedToolchain({ filePath });

        assert.equal(result.configured, true);
        assert.equal(result.nodeOk, true);
        assert.equal(result.nodeVersion, process.versions.node);
        assert.equal(result.bdOk, false, 'no bdPath was recorded');
        assert.deepEqual(result.problems, ['No bd path was recorded for this installation.']);
    });
});
