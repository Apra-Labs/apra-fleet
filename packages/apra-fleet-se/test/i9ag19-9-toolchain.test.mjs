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

import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    validateRecordedToolchain, TOOLCHAIN_FIX_LINE, TOOLCHAIN_PROBE_TIMEOUT_MS,
    TOOLCHAIN_VALIDATION_WORST_CASE_MS,
} from '../src/supervisor/toolchain.mjs';
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

/** The exact "could not be probed within Ns" prefix formatIncompleteProbeProblem()
 * builds from TOOLCHAIN_PROBE_TIMEOUT_MS -- derived here (never hand-copied)
 * so a retune of that ceiling can never desync these wording assertions from
 * the source, per apra-fleet-i9ag.19.21's constraint applied to every case in
 * this file (apra-fleet-i9ag.19.23). */
const PROBE_TIMEOUT_WORDING_RE = new RegExp(`could not be probed within ${TOOLCHAIN_PROBE_TIMEOUT_MS / 1_000}s`);

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

// apra-fleet-i9ag.19.18: a probe that could not COMPLETE (killed at the
// TOOLCHAIN_PROBE_TIMEOUT_MS ceiling, or a transient OS spawn errno under
// load) must never be folded into the same "does not resolve to a usable
// Node.js runtime"/"does not resolve to a usable bd" wording as a probe that
// ran and genuinely found nothing -- see toolchain.mjs's probeVersion() and
// formatIncompleteProbeProblem() doc comments for the full rationale. Every
// case below drives this via a fake exec whose thrown error shape mimics
// Node's own timeout-kill (`err.killed: true`, `err.signal` set) or a
// transient spawn errno (`err.code` one of EAGAIN/ENOMEM/EMFILE/ENFILE).
describe('apra-fleet-i9ag.19.9 / apra-fleet-i9ag.19.18: validateRecordedToolchain() -- a probe that cannot COMPLETE is distinguished from one that completed and said no', () => {
    /** A fake exec whose call `n` (1-based) throws (if `failures[n-1]` is
     * set) or succeeds with `success` (once `n` exceeds `failures.length`).
     * Records every call so a test can assert the retry actually happened. */
    function fakeExecWithFailures(failures, success) {
        const calls = [];
        let n = 0;
        const exec = (file, args, options) => {
            n += 1;
            calls.push({ file, args, options });
            const failure = failures[n - 1];
            if (failure) throw failure;
            return success;
        };
        return { exec, calls };
    }

    function timeoutError() {
        const err = new Error('spawnSync /opt/toolchain/node ETIMEDOUT');
        err.killed = true;
        err.signal = 'SIGTERM';
        return err;
    }

    function transientErrnoError(code) {
        const err = new Error(`spawn ${code}`);
        err.code = code;
        return err;
    }

    test('a node probe killed by the timeout ONCE then succeeding on retry yields nodeOk:true, the parsed version, and exactly 2 exec calls', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' }, { filePath });
        const { exec, calls } = fakeExecWithFailures([timeoutError()], `v${MIN_NODE_VERSION}`);
        // bd's own exec is a separate fake so its single call is not
        // confused with node's retried calls.
        const wrappedExec = (file, args, options) => {
            if (file === '/opt/toolchain/bd') return 'bd version 1.2.3';
            return exec(file, args, options);
        };

        const result = await validateRecordedToolchain({ filePath, exec: wrappedExec, platform: 'linux' });

        assert.equal(result.ok, true);
        assert.equal(result.nodeOk, true);
        assert.equal(result.nodeVersion, MIN_NODE_VERSION);
        assert.deepEqual(result.problems, [], 'a probe that succeeds on its bounded retry reports no problem at all');
        assert.equal(calls.length, 2, 'the node probe was retried exactly once after the timeout-shaped failure');
    });

    test('a node probe killed by the timeout on BOTH attempts yields nodeOk:false with distinct "could not be probed" wording, never the "does not resolve" sentence', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' }, { filePath });
        const { exec, calls } = fakeExecWithFailures([timeoutError(), timeoutError()], null);
        const wrappedExec = (file, args, options) => {
            if (file === '/opt/toolchain/bd') return 'bd version 1.2.3';
            return exec(file, args, options);
        };

        const result = await validateRecordedToolchain({ filePath, exec: wrappedExec, platform: 'linux' });

        assert.equal(result.ok, false);
        assert.equal(result.nodeOk, false);
        assert.equal(result.nodeVersion, null);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /\/opt\/toolchain\/node/);
        assert.match(result.problems[0], PROBE_TIMEOUT_WORDING_RE);
        assert.doesNotMatch(result.problems[0], /does not resolve to a usable Node\.js runtime/, 'a probe that never completed is a DIFFERENT finding from one that resolved and said no');
        assert.equal(calls.length, 2, 'exactly one bounded retry, never more');
        // bd stayed fine and is reported separately.
        assert.equal(result.bdOk, true);
    });

    test('a node probe hit by a transient spawn errno (EAGAIN) on both attempts yields nodeOk:false naming the errno, with the same distinct wording', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node' }, { filePath });
        const { exec, calls } = fakeExecWithFailures([transientErrnoError('EAGAIN'), transientErrnoError('EAGAIN')], null);

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.nodeOk, false);
        assert.match(result.problems[0], PROBE_TIMEOUT_WORDING_RE);
        assert.match(result.problems[0], /EAGAIN/);
        assert.doesNotMatch(result.problems[0], /does not resolve to a usable Node\.js runtime/);
        assert.equal(calls.length, 2);
    });

    test('a genuinely missing node (ENOENT) is NEVER retried and keeps today\'s exact "does not resolve" wording', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/does/not/exist/node' }, { filePath });
        const enoent = new Error('spawn ENOENT');
        enoent.code = 'ENOENT';
        const { exec, calls } = fakeExecWithFailures([enoent], null);

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.nodeOk, false);
        assert.match(result.problems[0], /does not resolve to a usable Node\.js runtime/);
        assert.doesNotMatch(result.problems[0], /could not be probed within/);
        assert.equal(calls.length, 1, 'a genuine failure (ENOENT) is never retried');
    });

    test('a bd probe that cannot complete (timeout twice) yields bdOk:false with the same distinct wording, naming bd (not node), while node stays fine', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' }, { filePath });
        const { exec: bdExec, calls: bdCalls } = fakeExecWithFailures([timeoutError(), timeoutError()], null);
        const wrappedExec = (file, args, options) => {
            if (file === '/opt/toolchain/node') return `v${MIN_NODE_VERSION}`;
            return bdExec(file, args, options);
        };

        const result = await validateRecordedToolchain({ filePath, exec: wrappedExec, platform: 'linux' });

        assert.equal(result.ok, true, '"ok" tracks node only -- bd never flips it, even for this new problem shape');
        assert.equal(result.nodeOk, true);
        assert.equal(result.bdOk, false);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /\/opt\/toolchain\/bd/);
        assert.match(result.problems[0], PROBE_TIMEOUT_WORDING_RE);
        assert.doesNotMatch(result.problems[0], /Node\.js/);
        assert.equal(bdCalls.length, 2, 'bd\'s own probe was retried exactly once');
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
        //
        // apra-fleet-i9ag.19.35: this case used to FAIL on a loaded host (a
        // real `node --version` child that could not finish inside
        // TOOLCHAIN_PROBE_TIMEOUT_MS on either attempt -- 30s, nodeOk:false).
        // It no longer spawns anything for node at all: the recorded path IS
        // this process's own interpreter, so the module reads
        // process.versions.node directly (knownSelfNodeVersion(),
        // node-version.mjs) -- which is why the version assertion below is an
        // exact equality and can no longer be starved by host contention. The
        // dedicated coverage for that shortcut (including the control proving
        // any OTHER path still probes) is in the last describe block of this
        // file.
        await writeSupervisorToolchain({ nodePath: process.execPath }, { filePath });

        const result = await validateRecordedToolchain({ filePath });

        assert.equal(result.configured, true);
        assert.equal(result.nodeOk, true);
        assert.equal(result.nodeVersion, process.versions.node);
        assert.equal(result.bdOk, false, 'no bdPath was recorded');
        assert.deepEqual(result.problems, ['No bd path was recorded for this installation.']);
    });
});

// =============================================================================
// apra-fleet-i9ag.19.21 -- pinning tests for apra-fleet-i9ag.19.20's two
// independent fixes to validateRecordedToolchain(): (1) the TOTAL wall-clock
// of the whole validation is bounded by the module's own exported
// `TOOLCHAIN_VALIDATION_WORST_CASE_MS` (concurrent node/bd probing, chosen
// over shrinking any per-attempt timeout -- see toolchain.mjs's file header);
// (2) `classifyIncompleteProbe()` keys the timeout branch on `err.killed
// === true` alone, so a genuine crash (SIGSEGV, or SIGKILL from the OOM
// killer) reads as a crash and is never retried as a timeout.
//
// The TOTAL-budget cases below never sleep for a real 15s/30s wall-clock
// wait: the injected `exec` fakes a wedged process by registering its OWN
// `setTimeout` (honoring `options.timeout` the same way Node's real
// `execFileAsync` would), and the test drives that clock deterministically
// via `node:test`'s built-in `mock.timers` (the same fake-clock convention
// dispatch-watchdog.test.mjs and watchdog-armed-roles-runtime.test.mjs already
// use for this exact "budget elapses" shape).
//
// apra-fleet-i9ag.19.21 JUDGE FIX (PR #561, ubuntu run 36579143337, '0 !== 2'
// in the 'concurrency' case below): this block used to advance past each
// case's async config read by draining a FIXED number (20) of real
// `setImmediate` turns before checking `calls.length`. That fixed count was
// racing a REAL `fs.readFile()` (this file's own `writeSupervisorToolchain()`
// + real temp file convention) whose completion time depends on actual OS
// I/O scheduling -- on a loaded CI host, 20 turns is not a guaranteed upper
// bound on "the read has completed", so the assertion could run before both
// probes had even started. NOTHING below counts event-loop turns anymore:
// `withCallSignal()` wraps an exec so a test can `await waitForCalls(n)` --
// an explicit deferred the wrapped exec itself resolves synchronously the
// instant its n-th call is recorded, whatever real or simulated latency
// preceded it. Where a case only needs to flush an already-fired fake
// timer's own promise-rejection microtasks (no real I/O in flight at that
// point), `waitForCalls()` on the resulting call count serves that too --
// there is no longer any place in this describe block that advances by
// counting turns; the only case that also needs to prove FAILURE (a
// regression back to sequential probing must still fail, never hang
// forever) races `waitForCalls()` against `waitForCallsOrFail()`'s short REAL
// wall-clock timer captured via `realSetTimeout` before this file's
// `mock.timers.enable()` call ever runs, so it can never itself be faked.
// =============================================================================
describe('apra-fleet-i9ag.19.21: validateRecordedToolchain() -- TOTAL wall-clock budget and crash-vs-timeout classification', () => {
    /** The genuine global setTimeout, captured before any `mock.timers.enable()`
     * call in this file ever runs, so a hang-guard built from it can never be
     * faked by a test that mocks the clock the CODE UNDER TEST sees. */
    const realSetTimeout = globalThis.setTimeout;

    /** Wraps `exec` so a test can wait for an ACTUAL call count rather than
     * counting event-loop turns (see this describe block's file-level note).
     * `waitForCalls(n)` resolves the instant the wrapped exec's n-th
     * invocation is recorded -- driven by an explicit deferred the wrapper
     * itself resolves synchronously inside that call, never by a fixed
     * number of turns/ticks.
     */
    function withCallSignal(exec) {
        const calls = [];
        const waiters = [];
        function notify() {
            for (let i = waiters.length - 1; i >= 0; i -= 1) {
                if (calls.length >= waiters[i].count) {
                    waiters[i].resolve();
                    waiters.splice(i, 1);
                }
            }
        }
        const wrapped = (file, args, options) => {
            calls.push({ file, args, options });
            notify();
            return exec(file, args, options);
        };
        function waitForCalls(count) {
            if (calls.length >= count) return Promise.resolve();
            return new Promise((resolve) => waiters.push({ count, resolve }));
        }
        return { exec: wrapped, calls, waitForCalls };
    }

    /** Races `waitForCalls(count)` against a short, REAL (never fake-clock)
     * wall-clock guard, so a case whose whole point is proving CONCURRENCY
     * fails loudly -- instead of hanging the suite forever -- if a
     * regression ever makes the probes sequential again (in which case the
     * second probe would never even start without a manual `tick()`, and
     * `waitForCalls()` alone would never settle). A healthy concurrent
     * implementation always settles this near-instantly; `guardMs` is never
     * what a PASSING run waits on, only a bound on the FAILING one -- well
     * under the "no real 15s/30s/60s wait" constraint this suite must honor.
     */
    function waitForCallsOrFail(waitForCalls, count, guardMs, label) {
        return Promise.race([
            waitForCalls(count),
            new Promise((_resolve, reject) => {
                realSetTimeout(() => reject(new Error(
                    `${label}: exec was not called ${count} time(s) within ${guardMs}ms of real wall-clock time -- `
                    + 'this almost always means the probes regressed from concurrent to sequential.',
                )), guardMs);
            }),
        ]);
    }

    /** A fake exec that never produces a version -- it hangs until
     * `options.timeout` elapses (the SAME ceiling toolchain.mjs passes to
     * every probe, first attempt or retry), then rejects with the exact
     * shape Node's real `execFileAsync` produces when ITS OWN `timeout`
     * option fires (`err.killed: true`). Driving that via `setTimeout` (not
     * an immediately-thrown error) is what lets the test advance a FAKE
     * clock through the module's real retry loop instead of asserting on a
     * synchronous shortcut. */
    function fakeExecTimesOutForever() {
        const exec = (file, args, options) => new Promise((_resolve, reject) => {
            setTimeout(() => {
                const err = new Error(`simulated timeout kill: ${file}`);
                err.killed = true;
                err.signal = 'SIGTERM';
                reject(err);
            }, options.timeout);
        });
        return withCallSignal(exec);
    }

    /** A fake exec whose single call throws `err` synchronously -- used for
     * the non-retryable outcomes (a crash, ENOENT) where no timer/retry is
     * ever involved. */
    function fakeExecThrowsOnce(err) {
        const calls = [];
        const exec = (file, args, options) => {
            calls.push({ file, args, options });
            throw err;
        };
        return { exec, calls };
    }

    /** A fake exec whose call `n` (1-based) throws `failures[n-1]` (when
     * set) or returns `success` once `n` exceeds `failures.length` -- used
     * to drive `probeVersion()`'s bounded retry with a SYNCHRONOUS failure
     * (a genuine timeout signature that does not need the fake clock). */
    function fakeExecWithFailures(failures, success) {
        const calls = [];
        let n = 0;
        const exec = (file, args, options) => {
            n += 1;
            calls.push({ file, args, options });
            const failure = failures[n - 1];
            if (failure) throw failure;
            return success;
        };
        return { exec, calls };
    }

    /** The timeout's OWN signature: `err.killed === true` (see
     * classifyIncompleteProbe()'s doc comment) -- the ONLY shape this module
     * ever produces by killing a child itself. */
    function timeoutKillError() {
        const err = new Error('simulated timeout kill');
        err.killed = true;
        err.signal = 'SIGTERM';
        return err;
    }

    /** A crash: killed by a signal the module's OWN timeout did NOT send --
     * `err.killed` stays `false` because Node did not initiate this kill
     * (see toolchain.mjs's classifyIncompleteProbe() doc comment for why a
     * genuine SIGSEGV or an OOM-killer SIGKILL both look like this). */
    function crashError(signal) {
        const err = new Error(`simulated crash: killed by ${signal}`);
        err.killed = false;
        err.signal = signal;
        return err;
    }

    test('TOTAL budget: the two-tool worst case (both recorded node AND bd unresponsive) settles at exactly TOOLCHAIN_VALIDATION_WORST_CASE_MS, never before, driven entirely by the fake clock', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const dataDir = await mkTmp();
            const filePath = supervisorConfigPath({ dataDir });
            await writeSupervisorToolchain(
                { nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' },
                { filePath },
            );
            const { exec, calls, waitForCalls } = fakeExecTimesOutForever();

            let resolved = false;
            const pending = validateRecordedToolchain({ filePath, exec, platform: 'linux' });
            pending.then(() => { resolved = true; });

            // Both probes are started before either's first attempt has any
            // chance to settle -- see the dedicated concurrency test below
            // for the named pin of this fact; asserted here too as a
            // sanity precondition for the timing math that follows. Waits on
            // the ACTUAL call count (an explicit signal the wrapped exec
            // fires on every invocation), never a fixed number of
            // event-loop turns -- this is what raced the real config-file
            // read and flaked in CI (see this describe block's file-level
            // note) -- raced against a short REAL wall-clock guard so a
            // regression back to sequential probing FAILS this case instead
            // of hanging forever (sequential would leave calls.length stuck
            // at 1 with no tick ever advancing it).
            await waitForCallsOrFail(waitForCalls, 2, 2_000, 'TOTAL budget precondition');
            assert.equal(calls.length, 2, 'node and bd probes both started (their first attempts are in flight concurrently)');

            // Just BEFORE the first attempt's own timeout: nothing has
            // fired, so there is nothing to wait for -- mock.timers.tick()
            // itself is synchronous and this assertion is true immediately.
            mock.timers.tick(TOOLCHAIN_PROBE_TIMEOUT_MS - 1);
            assert.equal(resolved, false, 'must not settle before even the first attempt times out');

            // Cross the first attempt's timeout: probeVersion() retries once
            // for both node and bd (its own bounded, single retry). Waiting
            // for the call count to reach 4 (rather than draining a fixed
            // number of turns) is what actually proves the retry's own new
            // exec() invocation has happened, however many promise-chain
            // microtask hops that took.
            mock.timers.tick(1);
            await waitForCalls(4);
            assert.equal(calls.length, 4, 'both node and bd were retried exactly once after their first attempt timed out');
            assert.equal(resolved, false, 'the retry\'s own timeout has not elapsed yet');

            // Just BEFORE the retry's own timeout, i.e. one tick short of the
            // module's own named total budget: still not settled -- again
            // nothing new has fired, so nothing needs draining.
            mock.timers.tick(TOOLCHAIN_VALIDATION_WORST_CASE_MS - TOOLCHAIN_PROBE_TIMEOUT_MS - 1);
            assert.equal(resolved, false, 'must not settle one tick before the module\'s own exported total budget elapses');

            // The final tick crosses TOOLCHAIN_VALIDATION_WORST_CASE_MS
            // exactly (TOOLCHAIN_PROBE_TIMEOUT_MS - 1 + 1 + (WORST_CASE -
            // PROBE_TIMEOUT - 1) + 1 === WORST_CASE) -- derived entirely from
            // the module's own exported constants, never a hand-copied
            // 15000/30000 literal.
            mock.timers.tick(1);
            const result = await pending;

            assert.equal(resolved, true, 'validateRecordedToolchain() settled once the module\'s own total budget elapsed');
            assert.equal(result.ok, false);
            assert.equal(result.nodeOk, false);
            assert.equal(result.bdOk, false);
            assert.equal(calls.length, 4, '2 tools x (1 attempt + 1 retry) -- never more');
            assert.match(result.problems.find((p) => p.includes('node')), /could not be probed within/);
            assert.match(result.problems.find((p) => p.includes('bd')), /could not be probed within/);
        } finally {
            mock.timers.reset();
        }
    });

    test('concurrency: node and bd probes overlap -- both exec invocations are observed before either one settles', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const dataDir = await mkTmp();
            const filePath = supervisorConfigPath({ dataDir });
            await writeSupervisorToolchain(
                { nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' },
                { filePath },
            );
            const { exec, calls, waitForCalls } = fakeExecTimesOutForever();

            const pending = validateRecordedToolchain({ filePath, exec, platform: 'linux' });

            // Neither probe's fake timer has fired yet (no tick at all), so
            // if BOTH calls are already recorded, they were started
            // concurrently -- a sequential implementation could only ever
            // have made the second call after the first one settled, which
            // (with a wedged exec) would never happen without a manual
            // tick(). Waits on the ACTUAL call count via an explicit signal
            // the wrapped exec fires on every invocation (never a fixed
            // number of event-loop turns -- see this describe block's
            // file-level note for the CI flake that pattern caused), raced
            // against a short REAL wall-clock guard so a genuine regression
            // to sequential probing FAILS this case instead of hanging the
            // suite forever (a sequential implementation would leave
            // `calls.length` stuck at 1 with no tick ever advancing it).
            await waitForCallsOrFail(waitForCalls, 2, 2_000, 'concurrency overlap');
            assert.equal(calls.length, 2, 'both node and bd were invoked before either had any chance to settle');
            assert.equal(calls[0].file, '/opt/toolchain/node');
            assert.equal(calls[1].file, '/opt/toolchain/bd');

            // Let the pending validation finish so no promise is left
            // dangling once this test's fake clock is torn down -- ticking
            // through both the first attempt's timeout AND the retry's own
            // timeout, waiting for the retry's own exec() invocations (call
            // count reaching 4) between each so the retry loop's own
            // `await`s (and the second `setTimeout` registration they gate)
            // actually run before the next tick -- again driven by the
            // actual call count, never a fixed turn count.
            mock.timers.tick(TOOLCHAIN_PROBE_TIMEOUT_MS);
            await waitForCalls(4);
            mock.timers.tick(TOOLCHAIN_VALIDATION_WORST_CASE_MS - TOOLCHAIN_PROBE_TIMEOUT_MS);
            await pending;
        } finally {
            mock.timers.reset();
        }
    });

    test('crash vs timeout: a node probe killed by SIGSEGV (not this module\'s own timeout) is reported with the non-retryable "does not resolve" wording, never retried and never worded as a timeout', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain(
            { nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' },
            { filePath },
        );
        const { exec: nodeExec, calls: nodeCalls } = fakeExecThrowsOnce(crashError('SIGSEGV'));
        const wrappedExec = (file, args, options) => {
            if (file === '/opt/toolchain/bd') return 'bd version 1.2.3';
            return nodeExec(file, args, options);
        };

        const result = await validateRecordedToolchain({ filePath, exec: wrappedExec, platform: 'linux' });

        assert.equal(result.ok, false);
        assert.equal(result.nodeOk, false);
        assert.equal(result.nodeVersion, null);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /does not resolve to a usable Node\.js runtime/, 'a crash is reported with the genuine non-retryable wording');
        assert.doesNotMatch(result.problems[0], /could not be probed within/, 'a crash must never be worded as a timeout');
        assert.equal(nodeCalls.length, 1, 'a crash is never retried -- exactly one exec invocation');
        // bd stayed fine and is reported separately, unaffected by node's crash.
        assert.equal(result.bdOk, true);
    });

    test('crash vs timeout: a bd probe killed by SIGKILL from the OOM killer (not this module\'s own timeout) is reported the same non-retryable way, naming bd, never retried', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain(
            { nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' },
            { filePath },
        );
        const { exec: bdExec, calls: bdCalls } = fakeExecThrowsOnce(crashError('SIGKILL'));
        const wrappedExec = (file, args, options) => {
            if (file === '/opt/toolchain/node') return `v${MIN_NODE_VERSION}`;
            return bdExec(file, args, options);
        };

        const result = await validateRecordedToolchain({ filePath, exec: wrappedExec, platform: 'linux' });

        assert.equal(result.ok, true, '"ok" tracks node health only -- an OOM-killed bd never flips it');
        assert.equal(result.nodeOk, true);
        assert.equal(result.bdOk, false);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /\/opt\/toolchain\/bd/);
        assert.match(result.problems[0], /does not resolve to a usable bd/, 'an OOM-killed bd is reported with the genuine non-retryable wording');
        assert.doesNotMatch(result.problems[0], /could not be probed within/, 'an OOM-killed bd must never be worded as a timeout');
        assert.equal(bdCalls.length, 1, 'a crash is never retried -- exactly one exec invocation');
    });

    test('genuine timeout: a node probe killed by this module\'s own timeout (err.killed===true) on both attempts still produces the "could not be probed" wording, and retries exactly once (the chosen strategy\'s own ceiling)', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain(
            { nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' },
            { filePath },
        );
        const { exec, calls } = fakeExecWithFailures([timeoutKillError(), timeoutKillError()], null);
        const wrappedExec = (file, args, options) => {
            if (file === '/opt/toolchain/bd') return 'bd version 1.2.3';
            return exec(file, args, options);
        };

        const result = await validateRecordedToolchain({ filePath, exec: wrappedExec, platform: 'linux' });

        assert.equal(result.nodeOk, false);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], PROBE_TIMEOUT_WORDING_RE);
        assert.doesNotMatch(result.problems[0], /does not resolve to a usable Node\.js runtime/, 'a genuine timeout must never be worded as a crash/resolve failure');
        assert.equal(calls.length, 2, 'a genuine timeout is retried exactly once -- never zero, never more than one retry');
    });

    test('ENOENT stays non-retryable: exactly one injected exec invocation, existing "does not resolve" wording preserved', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain(
            { nodePath: '/does/not/exist/node', bdPath: '/opt/toolchain/bd' },
            { filePath },
        );
        const enoent = new Error('spawn ENOENT');
        enoent.code = 'ENOENT';
        const { exec: nodeExec, calls: nodeCalls } = fakeExecThrowsOnce(enoent);
        const wrappedExec = (file, args, options) => {
            if (file === '/opt/toolchain/bd') return 'bd version 1.2.3';
            return nodeExec(file, args, options);
        };

        const result = await validateRecordedToolchain({ filePath, exec: wrappedExec, platform: 'linux' });

        assert.equal(result.nodeOk, false);
        assert.match(result.problems[0], /does not resolve to a usable Node\.js runtime/);
        assert.doesNotMatch(result.problems[0], /could not be probed within/);
        assert.equal(nodeCalls.length, 1, 'ENOENT is never retried -- exactly one exec invocation');
    });

    test('totality: validateRecordedToolchain() RETURNS a report and never throws for a crash, a genuine timeout, ENOENT, or a transient spawn errno', async () => {
        const shapes = [
            ['SIGSEGV crash', crashError('SIGSEGV')],
            ['OOM SIGKILL crash', crashError('SIGKILL')],
            ['genuine timeout', timeoutKillError()],
            ['ENOENT', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })],
            ['transient EAGAIN', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })],
        ];

        for (const [label, err] of shapes) {
            const dataDir = await mkTmp();
            const filePath = supervisorConfigPath({ dataDir });
            await writeSupervisorToolchain(
                { nodePath: '/opt/toolchain/node', bdPath: '/opt/toolchain/bd' },
                { filePath },
            );
            // A retryable shape (timeout/EAGAIN) needs the SAME failure
            // queued twice so the module's own bounded retry still sees a
            // failure on its second attempt too -- a non-retryable shape
            // (crash/ENOENT) only ever consumes the first entry.
            const { exec } = fakeExecWithFailures([err, err], null);
            const wrappedExec = (file, args, options) => {
                if (file === '/opt/toolchain/bd') return 'bd version 1.2.3';
                return exec(file, args, options);
            };

            let result;
            await assert.doesNotReject(
                async () => { result = await validateRecordedToolchain({ filePath, exec: wrappedExec, platform: 'linux' }); },
                `validateRecordedToolchain() must never throw for: ${label}`,
            );
            assert.ok(result && typeof result === 'object', `expected a report object for: ${label}`);
            assert.equal(result.configured, true, `expected a configured report for: ${label}`);
            assert.equal(typeof result.ok, 'boolean', `expected a boolean 'ok' verdict for: ${label}`);
            assert.equal(result.nodeOk, false, `expected node to be reported unhealthy for: ${label}`);
        }
    });

    test('exactly one operator fix line is present for a broken recording, matched via the module\'s own exported TOOLCHAIN_FIX_LINE (never a copied string literal)', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/does/not/exist/node' }, { filePath });
        const enoent = new Error('spawn ENOENT');
        enoent.code = 'ENOENT';
        const { exec } = fakeExecThrowsOnce(enoent);

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.fixLine, TOOLCHAIN_FIX_LINE, 'the report\'s fix line must be the module\'s own exported constant');
        assert.equal(typeof result.fixLine, 'string');
    });
});

// apra-fleet-i9ag.19.30 -- the bd probe runs THROUGH the recorded node (D1
// fix, second half): a recorded bd installed by npm is typically a
// '#!/usr/bin/env node' shebang script, so probing it directly under a
// service PATH with no `node` at all makes `env` fail with exit 127 before
// bd itself ever runs, reporting a perfectly good recording as broken. See
// toolchain.mjs's withNodeFirstBdExec() doc comment for the chosen strategy
// (mirrors exec-bd.mjs's withConfiguredNodeDirOnPath()) and why it is
// POSIX-only (a real Windows backslash nodePath would make
// path.posix.dirname() silently return '.', prepending the supervisor's own
// cwd instead of the recorded node's directory).
//
// A dedicated, comprehensive suite for this composition lives in
// apra-fleet-i9ag.19.31; the cases below are the minimal set this [impl]
// bead's own acceptance criteria require directly (exact-invocation proof
// for AC1, the win32 platform gate for D1 defect 1, and the bd-problem-still-
// names-bdPath proof for AC6) so the fix does not ship unverified.
//
// AC2 ("with no recorded nodePath, the bd probe is byte-for-byte the direct
// probe it is today") describes a state readToolchainBlock() (project-
// config.mjs) can never produce: `nodePath` is required for `toolchain` to
// be non-null at all, so "recorded bd, no recorded node" cannot occur --
// the "no bd path recorded at all" case above (AC4 describe block) is the
// closest reachable neighbor, and already shows the wrapper is applied only
// when a bd path is actually recorded (calls.length === 1, only the node
// probe ran).
describe('apra-fleet-i9ag.19.30: bd probe runs THROUGH the recorded node (D1 fix, second half)', () => {
    test('AC1: with a recorded node and a recorded node-shebang bd, the bd probe exec receives dirname(nodePath) prepended onto PATH -- exact invocation, bdOk:true even though PATH itself carries no node', { skip: process.platform === 'win32' ? 'POSIX-only PATH-prepend fix' : false }, async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const nodePath = '/opt/toolchain/node';
        const bdPath = '/opt/toolchain/bd';
        await writeSupervisorToolchain({ nodePath, bdPath }, { filePath });
        const { exec, calls } = fakeExecCapturing({
            [nodePath]: `v${MIN_NODE_VERSION}`,
            [bdPath]: 'bd version 1.2.3',
        });

        const originalPath = process.env.PATH;
        process.env.PATH = '/usr/bin:/bin'; // deliberately no node directory on it
        try {
            const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

            assert.equal(result.bdOk, true, 'bd resolves through the recorded node dir even though PATH itself carries no node');
            assert.equal(result.nodeOk, true);
            assert.equal(calls.length, 2);

            assert.equal(calls[0].file, nodePath, 'the node probe itself is unchanged');
            assert.equal('env' in calls[0].options, false, 'the node probe is never composed through this wrapper -- it is a real binary, never a shebang script');

            assert.equal(calls[1].file, bdPath, 'bd is still invoked as itself, never wrapped as "<nodePath> <bdPath>"');
            assert.deepEqual(calls[1].args, ['--version']);
            assert.deepEqual(calls[1].options, {
                shell: false,
                timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
                env: { ...process.env, PATH: `/opt/toolchain${path.delimiter}/usr/bin:/bin` },
            }, 'the bd probe exec receives EXACTLY probeVersion\'s own {shell,timeout} plus dirname(nodePath) prepended onto PATH -- nothing else changed');
        } finally {
            process.env.PATH = originalPath;
        }
    });

    test('D1 defect 1 regression guard: on win32, the bd probe exec is NOT wrapped at all -- no env key is added', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const nodePath = '/opt/toolchain/node';
        const bdPath = '/opt/toolchain/bd';
        await writeSupervisorToolchain({ nodePath, bdPath }, { filePath });
        const { exec, calls } = fakeExecCapturing({
            [nodePath]: `v${MIN_NODE_VERSION}`,
            [bdPath]: 'bd version 1.2.3',
        });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'win32' });

        assert.equal(result.bdOk, true);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].file, bdPath, 'no whitespace to quote for the win32 shell probe');
        assert.deepEqual(calls[1].options, { shell: true, timeout: TOOLCHAIN_PROBE_TIMEOUT_MS }, 'win32 must never get an env key added by this composition -- path.posix.dirname() on a real backslash nodePath would silently resolve to "." (the cwd), not the recorded node directory, which is both a no-op for the D1 fix and a preference-hijack surface');
    });

    test('AC6: a bd problem message still names the recorded bdPath even when probed through the node-first wrapped exec', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const nodePath = '/opt/toolchain/node';
        const bdPath = '/opt/toolchain/broken-bd';
        await writeSupervisorToolchain({ nodePath, bdPath }, { filePath });
        const { exec, calls } = fakeExecCapturing({ [nodePath]: `v${MIN_NODE_VERSION}` });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.bdOk, false);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /\/opt\/toolchain\/broken-bd/, 'the operator must still see WHICH recording is suspect, even though the interpreter is now node\'s path');
        assert.match(result.problems[0], /does not resolve to a usable bd/);
        const bdCall = calls.find((c) => c.file === bdPath);
        assert.ok(bdCall, 'the bd probe was still invoked with the unmodified bdPath as file');
        assert.ok(bdCall.options.env, 'the bd probe was composed through the node-first wrapper (env present) -- proves this exercises the FIXED code path, not the pre-fix direct probe');
    });
});

// =============================================================================
// apra-fleet-i9ag.19.31 -- dedicated, comprehensive coverage for the
// node-first bd probe composition apra-fleet-i9ag.19.30 introduced
// (withNodeFirstBdExec(), above). The i9ag.19.30 describe block just above
// carries only the MINIMAL set that bead's own acceptance criteria required
// directly; every bullet below is its own named case with its own
// assertion, so this strategy is pinned by ASSERTIONS ON THE EXACT
// FILE/ARGS/ENV the injected exec receives, never "it passed".
//
// Bullet 2 ("with no recorded nodePath, the bd probe is the direct probe it
// is today") describes a state project-config.mjs's readToolchainBlock()
// can never produce standalone: `nodePath` is required for `toolchain` to be
// non-null AT ALL (see that function's own doc comment), so "recorded bd,
// no recorded node" cannot occur independently of "nothing recorded at
// all". The case below is that state's one reachable analog: a raw config
// carrying `toolchain.bdPath` with no `toolchain.nodePath` degrades the
// WHOLE toolchain to unconfigured, so neither probe -- composed or direct --
// ever runs at all. That IS "today's" (and every day's) behavior for this
// shape, and is exactly what a bug that tried to apply the node-first
// composition unconditionally (bypassing the `!toolchain` early return)
// would break.
// =============================================================================
describe('apra-fleet-i9ag.19.31: dedicated coverage for the recorded bd probe running through the recorded node', () => {
    test('bullet 1: with a recorded node and a recorded bd, the bd probe exec receives the EXACT node-first invocation -- pinning the chosen strategy explicitly, not "it passed"', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const nodePath = '/opt/toolchain/node';
        const bdPath = '/opt/toolchain/bd';
        await writeSupervisorToolchain({ nodePath, bdPath }, { filePath });
        const { exec, calls } = fakeExecCapturing({
            [nodePath]: `v${MIN_NODE_VERSION}`,
            [bdPath]: 'bd version 1.2.3',
        });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.nodeOk, true);
        assert.equal(result.bdOk, true);
        assert.equal(calls.length, 2);
        const bdCall = calls.find((c) => c.file === bdPath);
        assert.ok(bdCall, 'bd is invoked as itself, never as "<nodePath> <bdPath>"');
        assert.deepEqual(bdCall.args, ['--version']);
        assert.deepEqual(bdCall.options, {
            shell: false,
            timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
            env: { ...process.env, PATH: `${path.posix.dirname(nodePath)}${path.delimiter}${process.env.PATH}` },
        }, 'the bd probe exec receives EXACTLY probeVersion\'s own {shell,timeout} plus dirname(nodePath) prepended onto PATH -- nothing else');
    });

    test('bullet 2: a recorded bdPath with NO recorded nodePath degrades the WHOLE toolchain to unconfigured -- neither the composed nor the direct bd probe ever runs', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(
            filePath,
            JSON.stringify({ projectDir: '/some/project', toolchain: { bdPath: '/opt/toolchain/bd' } }),
            'utf-8',
        );
        const { exec, calls } = fakeExecCapturing({ '/opt/toolchain/bd': 'bd version 1.2.3' });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.configured, false, 'nodePath is required for readToolchainBlock() to produce a toolchain object at all -- a bdPath alone is not enough');
        assert.equal(result.nodeOk, null);
        assert.equal(result.bdOk, null);
        assert.equal(result.ok, true);
        assert.deepEqual(result.problems, []);
        assert.match(result.reason, /nodePath/);
        assert.equal(calls.length, 0, 'without a recorded nodePath there is no toolchain object for the bd branch to reference -- bd is never probed, composed or direct');
    });

    test('bullet 3: a recorded node that itself fails validation does not stop bd from being composed against that exact recorded (still unvalidated) node path', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const nodePath = '/does/not/exist/node';
        const bdPath = '/opt/toolchain/bd';
        await writeSupervisorToolchain({ nodePath, bdPath }, { filePath });
        const { exec, calls } = fakeExecCapturing({ [bdPath]: 'bd version 1.2.3' }); // nodePath absent -> node's own probe fails

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        // Node genuinely failed to validate -- confirmed here so the next
        // assertions are meaningfully testing "bd is composed against a
        // BAD/unvalidated node", not a good one.
        assert.equal(result.nodeOk, false);
        assert.equal(result.ok, false, '"ok" tracks node alone');
        assert.match(result.problems.find((p) => p.includes('node')), /does not resolve to a usable Node\.js runtime/);

        // bd is STILL probed through the composed exec, using dirname() of
        // the exact recorded (failing) nodePath -- the composition never
        // waits for, or substitutes a different path for, node's own
        // validation outcome.
        assert.equal(result.bdOk, true, 'bd is its own separate finding, unaffected by node\'s failure');
        const bdCall = calls.find((c) => c.file === bdPath);
        assert.ok(bdCall, 'bd was probed as itself');
        assert.ok(bdCall.options.env, 'bd was composed through the node-first wrapper even though node failed validation');
        assert.equal(
            bdCall.options.env.PATH.split(path.delimiter)[0],
            path.posix.dirname(nodePath),
            'bd\'s composed PATH is prefixed with dirname() of the exact RECORDED node path, unvalidated -- never a different/fallback path',
        );
    });

    test('bullet 4: the node probe\'s own invocation is unchanged whether bd\'s recorded node validates or fails -- never wrapped, never given an env key', async () => {
        const dataDir = await mkTmp();
        const filePathGood = supervisorConfigPath({ dataDir: await mkTmp() });
        const goodNodePath = '/opt/toolchain/node';
        const bdPath = '/opt/toolchain/bd';
        await writeSupervisorToolchain({ nodePath: goodNodePath, bdPath }, { filePath: filePathGood });
        const { exec: goodExec, calls: goodCalls } = fakeExecCapturing({
            [goodNodePath]: `v${MIN_NODE_VERSION}`,
            [bdPath]: 'bd version 1.2.3',
        });
        const goodResult = await validateRecordedToolchain({ filePath: filePathGood, exec: goodExec, platform: 'linux' });
        assert.equal(goodResult.nodeOk, true);
        const goodNodeCall = goodCalls.find((c) => c.file === goodNodePath);
        assert.ok(goodNodeCall);
        assert.equal('env' in goodNodeCall.options, false, 'node\'s own probe never carries an env key, whether or not bd is recorded alongside it');
        assert.deepEqual(goodNodeCall.args, ['--version']);

        const filePathBad = supervisorConfigPath({ dataDir: await mkTmp() });
        const badNodePath = '/does/not/exist/node';
        await writeSupervisorToolchain({ nodePath: badNodePath, bdPath }, { filePath: filePathBad });
        const { exec: badExec, calls: badCalls } = fakeExecCapturing({ [bdPath]: 'bd version 1.2.3' });
        const badResult = await validateRecordedToolchain({ filePath: filePathBad, exec: badExec, platform: 'linux' });
        assert.equal(badResult.nodeOk, false);
        const badNodeCall = badCalls.find((c) => c.file === badNodePath);
        assert.ok(badNodeCall);
        assert.equal('env' in badNodeCall.options, false, 'node\'s own probe is unchanged even when it itself fails -- the fix only ever touches bd\'s exec');
        assert.deepEqual(badNodeCall.args, ['--version']);
    });

    test('bullet 5: bd stays its own separately-worded problem, "ok" still tracks node alone, and nodeOk/bdOk keep their documented values across a good-node/bad-bd and a bad-node/good-bd case', async () => {
        const nodePath = '/opt/toolchain/node';

        // Good node, broken bd: ok/nodeOk stay true; bdOk flips false with its
        // own distinct entry.
        const dataDir1 = await mkTmp();
        const filePath1 = supervisorConfigPath({ dataDir: dataDir1 });
        const brokenBdPath = '/opt/toolchain/broken-bd';
        await writeSupervisorToolchain({ nodePath, bdPath: brokenBdPath }, { filePath: filePath1 });
        const { exec: exec1 } = fakeExecCapturing({ [nodePath]: `v${MIN_NODE_VERSION}` });
        const result1 = await validateRecordedToolchain({ filePath: filePath1, exec: exec1, platform: 'linux' });
        assert.equal(result1.ok, true, '"ok" tracks node alone -- a broken bd probed through the node-first wrapper still never flips it');
        assert.equal(result1.nodeOk, true);
        assert.equal(result1.bdOk, false);
        assert.equal(result1.problems.length, 1);
        assert.match(result1.problems[0], /does not resolve to a usable bd/);
        assert.doesNotMatch(result1.problems[0], /Node\.js/, 'bd\'s problem entry is never confusable with a node one');

        // Bad node, good bd (composed through it anyway): ok/nodeOk false;
        // bdOk stays true and is unaffected.
        const dataDir2 = await mkTmp();
        const filePath2 = supervisorConfigPath({ dataDir: dataDir2 });
        const badNodePath = '/does/not/exist/node';
        const goodBdPath = '/opt/toolchain/bd';
        await writeSupervisorToolchain({ nodePath: badNodePath, bdPath: goodBdPath }, { filePath: filePath2 });
        const { exec: exec2 } = fakeExecCapturing({ [goodBdPath]: 'bd version 1.2.3' });
        const result2 = await validateRecordedToolchain({ filePath: filePath2, exec: exec2, platform: 'linux' });
        assert.equal(result2.ok, false);
        assert.equal(result2.nodeOk, false);
        assert.equal(result2.bdOk, true, 'bd stays its own, independently-tracked finding');
        assert.equal(result2.problems.length, 1);
        assert.match(result2.problems[0], /does not resolve to a usable Node\.js runtime/);
        assert.doesNotMatch(result2.problems[0], /does not resolve to a usable bd/);
    });

    test('bullet 6: the report still carries exactly one operator fix line, matched via the module\'s exported TOOLCHAIN_FIX_LINE, for a recording composed through the node-first wrapper', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const nodePath = '/opt/toolchain/node';
        const bdPath = '/opt/toolchain/broken-bd';
        await writeSupervisorToolchain({ nodePath, bdPath }, { filePath });
        const { exec } = fakeExecCapturing({ [nodePath]: `v${MIN_NODE_VERSION}` });

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux' });

        assert.equal(result.bdOk, false, 'sanity: this case does exercise the node-first composed wrapper (a broken recorded bd)');
        assert.equal(result.fixLine, TOOLCHAIN_FIX_LINE, 'the report\'s fix line must be the module\'s own exported constant, never a copied string literal');
        assert.equal(typeof result.fixLine, 'string');
    });
});

// =============================================================================
// apra-fleet-i9ag.19.35 -- the recorded node that IS this process's own
// interpreter is never probed with a child process.
//
// A `--version` spawn can only fail for reasons that say nothing about the
// recording (host load, fd/process exhaustion, a timeout); executing ON a
// binary is strictly stronger evidence that it is a usable Node.js runtime of
// that version than asking it. So when `nodePath` is literally
// `process.execPath` and this process is not a SEA build,
// validateRecordedToolchain() takes `process.versions.node` and spawns
// nothing -- removing the single most load-sensitive step of supervisor
// startup, and with it the "healthy at boot, 503 at launch" disagreement this
// bead was filed for (see toolchain.mjs's and node-runner.mjs's headers).
//
// Every case below proves it the only way that counts: with an injected exec
// that would FAIL the probe outright, so a result of nodeOk:true can only mean
// the probe never ran.
// =============================================================================
describe('apra-fleet-i9ag.19.35: the recorded node that is this process\'s own interpreter is never probed', () => {
    /** An exec that fails every probe of `file` with a timeout-shaped error
     * (Node's own kill shape: `killed: true`), and records every call. Any
     * result of nodeOk:true under this exec proves node was never probed. */
    function poisonedExec(bdVersion = 'bd version 1.2.3') {
        const calls = [];
        const exec = (file, args, options) => {
            calls.push({ file, args, options });
            if (bdVersion !== null && file.includes('bd')) return Promise.resolve(bdVersion);
            const err = new Error(`spawn ${file} ETIMEDOUT`);
            err.killed = true;
            err.signal = 'SIGTERM';
            return Promise.reject(err);
        };
        return { exec, calls };
    }

    test('nodePath === process.execPath: nodeOk true with process.versions.node, and the injected exec is NEVER called for node', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: process.execPath }, { filePath });
        const { exec, calls } = poisonedExec();

        const result = await validateRecordedToolchain({ filePath, exec, isSea: () => false });

        assert.equal(result.nodeOk, true, 'an exec that times out every probe cannot produce nodeOk:true unless node was never probed');
        assert.equal(result.nodeVersion, process.versions.node);
        assert.equal(result.ok, true);
        assert.deepEqual(
            calls.filter((c) => c.file === process.execPath), [],
            'the recorded node is the binary this process is running on -- nothing may be spawned to ask it its version',
        );
        assert.doesNotMatch(result.problems.join(' '), PROBE_TIMEOUT_WORDING_RE, 'no probe ran, so no probe can have been incomplete');
    });

    test('CONTROL: any OTHER recorded path is still probed exactly as before -- the shortcut is not a blanket skip', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: '/opt/toolchain/node' }, { filePath });
        const { exec, calls } = poisonedExec();

        const result = await validateRecordedToolchain({ filePath, exec, platform: 'linux', isSea: () => false });

        assert.equal(result.nodeOk, false);
        assert.equal(calls.filter((c) => c.file === '/opt/toolchain/node').length, 2, 'a path that is NOT this process\'s own interpreter is probed, and retried once');
        assert.match(result.problems[0], PROBE_TIMEOUT_WORDING_RE);
    });

    test('CONTROL: under a SEA build (isSea true) process.execPath is the apra-fleet binary, not node -- so the shortcut is off and the probe runs', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath: process.execPath }, { filePath });
        const { exec, calls } = poisonedExec();

        const result = await validateRecordedToolchain({ filePath, exec, isSea: () => true });

        assert.equal(result.nodeOk, false, 'nothing may be concluded from execPath matching when execPath is not a node runtime');
        assert.equal(calls.filter((c) => c.file === process.execPath).length, 2, 'the probe must run (and retry) exactly as it does for any other path');
    });

    test('the shortcut only ever covers node: a recorded bd is still probed normally alongside it', async () => {
        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        const bdPath = path.join(await mkTmp(), 'bd');
        await writeSupervisorToolchain({ nodePath: process.execPath, bdPath }, { filePath });
        const { exec, calls } = poisonedExec();

        const result = await validateRecordedToolchain({ filePath, exec, isSea: () => false });

        assert.equal(result.nodeOk, true);
        assert.equal(result.bdOk, true);
        assert.equal(result.bdVersion, '1.2.3');
        assert.deepEqual(calls.map((c) => c.file), [bdPath], 'exactly one probe ran, and it was bd\'s');
    });
});
