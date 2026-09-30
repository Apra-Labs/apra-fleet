// apra-fleet-i9ag.19.16 -- direct coverage for the shared node/bd
// version-probe helpers (src/supervisor/node-version.mjs): parseVersionString,
// compareVersions, quoteForWindowsShell, probeVersion. apra-fleet-i9ag.19.15
// deduped these out of node-runner.mjs and toolchain.mjs into this one shared
// module -- before this suite, the only coverage for them was indirect,
// through each caller's own test file. That leaves exactly the semantics
// this module's own doc comment calls out as fragile under a refactor
// (numeric-vs-lexicographic version compare, win32 shell quoting) with no
// suite whose FAILURE would specifically point at node-version.mjs. This
// suite is that direct coverage; it does not touch or duplicate
// i9ag15-node-runner.test.mjs or i9ag19-9-toolchain.test.mjs, which stay
// exactly as they were and remain part of the evidence that this dedupe was
// behavior-preserving for both callers.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    parseVersionString,
    compareVersions,
    quoteForWindowsShell,
    probeVersion,
} from '../src/supervisor/node-version.mjs';
import { resolveSprintRunnerCommand, MIN_NODE_VERSION, SPRINT_RUNNER_SOURCE } from '../src/supervisor/node-runner.mjs';
import { validateRecordedToolchain } from '../src/supervisor/toolchain.mjs';
import { writeSupervisorToolchain, supervisorConfigPath } from '../src/supervisor/project-config.mjs';

/** A fake `exec(file, args, options)` -- `versions` maps the exact string
 * `exec` should receive as `file` to a version string (parsed by
 * parseVersionString(), so 'vX.Y.Z' or 'X.Y.Z' both work), or `null`/absent
 * to simulate a spawn failure (e.g. ENOENT). Also records every call so a
 * test can assert exactly what was (or was never) probed -- mirrors the
 * fakeExecCapturing() convention already used by i9ag15-node-runner.test.mjs
 * and i9ag19-9-toolchain.test.mjs. */
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

describe('apra-fleet-i9ag.19.16: compareVersions is numeric, not lexicographic', () => {
    test('22.16.0 is newer than 22.9.0 -- a lexicographic compare would say the opposite ("9" > "1")', () => {
        assert.ok(compareVersions('22.16.0', '22.9.0') > 0);
        assert.ok(compareVersions('22.9.0', '22.16.0') < 0);
    });

    test('22.9.0 compared against MIN_NODE_VERSION sorts OLDER -- the exact drift a string compare would introduce', () => {
        assert.ok(
            compareVersions('22.9.0', MIN_NODE_VERSION) < 0,
            `a string compare would wrongly conclude "22.9.0" > "${MIN_NODE_VERSION}" because the character "9" sorts after "1"`,
        );
    });

    test('equal versions compare as 0', () => {
        assert.equal(compareVersions('22.16.0', '22.16.0'), 0);
    });

    test('differing patch levels, same major.minor, compare deterministically', () => {
        assert.ok(compareVersions('22.16.1', '22.16.0') > 0);
        assert.ok(compareVersions('22.16.0', '22.16.1') < 0);
    });

    test('differing segment counts (22.16 vs 22.16.0) compare as equal -- a missing segment defaults to 0', () => {
        assert.equal(compareVersions('22.16', '22.16.0'), 0);
        assert.equal(compareVersions('22.16.0', '22.16'), 0);
    });
});

describe('apra-fleet-i9ag.19.16: parseVersionString', () => {
    test('extracts from a leading-"v" node --version shape with a trailing newline', () => {
        assert.equal(parseVersionString('v22.16.0\n'), '22.16.0');
    });

    test('extracts from a bare-digit shape with no leading "v"', () => {
        assert.equal(parseVersionString('22.16.0'), '22.16.0');
    });

    test('extracts from a bd --version shape carrying extra surrounding text', () => {
        assert.equal(parseVersionString('bd version 1.2.3\n'), '1.2.3');
    });

    test('extracts from output with trailing build metadata/extra text after the version', () => {
        assert.equal(parseVersionString('v22.16.0 (V8 12.4.254.21-node.22)\n'), '22.16.0');
    });

    test('unparseable output returns null, never throws', () => {
        assert.equal(parseVersionString('command not found\n'), null);
        assert.doesNotThrow(() => parseVersionString('command not found\n'));
    });

    test('null/undefined input returns null, never throws', () => {
        assert.equal(parseVersionString(null), null);
        assert.equal(parseVersionString(undefined), null);
    });
});

describe('apra-fleet-i9ag.19.16: quoteForWindowsShell', () => {
    test('a path containing a space is wrapped in double quotes', () => {
        assert.equal(quoteForWindowsShell('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
    });

    test('a space-free path is left unchanged', () => {
        assert.equal(quoteForWindowsShell('C:\\nodejs\\node.exe'), 'C:\\nodejs\\node.exe');
        assert.equal(quoteForWindowsShell('node'), 'node');
    });
});

describe('apra-fleet-i9ag.19.16: probeVersion platform branching', () => {
    test('win32: the quoted form is what exec receives when the file contains a space', () => {
        const spaced = 'C:\\Program Files\\nodejs\\node.exe';
        const quoted = `"${spaced}"`;
        const { exec, calls } = fakeExecCapturing({ [quoted]: 'v22.16.0' });

        const result = probeVersion(exec, 'win32', spaced, ['--version'], {});

        assert.deepEqual(result, { version: '22.16.0', incomplete: null });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, quoted, 'exec must receive the QUOTED candidate on win32');
        assert.equal(calls[0].options.shell, true);
    });

    test('posix: the RAW file is what exec receives, even when it contains a space, with no shell', () => {
        const spaced = '/usr/local/my node/bin/node';
        const { exec, calls } = fakeExecCapturing({ [spaced]: 'v22.16.0' });

        const result = probeVersion(exec, 'linux', spaced, ['--version'], {});

        assert.deepEqual(result, { version: '22.16.0', incomplete: null });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, spaced, 'exec must receive the RAW (unquoted) candidate on posix');
        assert.equal(calls[0].options.shell, false);
    });
});

describe('apra-fleet-i9ag.19.16: probeVersion failure surfacing', () => {
    test('no-retry contract (node-runner.mjs): any failure on the one attempt collapses to version:null, incomplete:null', () => {
        const exec = () => { throw new Error('spawn ENOENT: node'); };
        const result = probeVersion(exec, 'linux', 'node', ['--version'], {});
        assert.deepEqual(result, { version: null, incomplete: null });
    });

    test('retry contract (toolchain.mjs): a timeout-classified failure that persists through the bounded retry surfaces incomplete:"timeout"', () => {
        let attempts = 0;
        const exec = () => {
            attempts += 1;
            throw Object.assign(new Error('probe timed out'), { killed: true });
        };
        const result = probeVersion(exec, 'linux', 'node', ['--version'], { retry: true });
        assert.deepEqual(result, { version: null, incomplete: 'timeout' });
        assert.equal(attempts, 2, 'exactly one bounded retry -- the original attempt plus one, never a retry-until-pass loop');
    });

    test('retry contract: a genuine (non-transient) failure is NOT retried, and surfaces incomplete:null', () => {
        let attempts = 0;
        const exec = () => {
            attempts += 1;
            throw new Error('spawn ENOENT: node');
        };
        const result = probeVersion(exec, 'linux', 'node', ['--version'], { retry: true });
        assert.deepEqual(result, { version: null, incomplete: null });
        assert.equal(attempts, 1, 'a genuine failure (e.g. ENOENT) is not retryable -- a retry could never change it');
    });

    test('an async exec (thenable) drives probeVersion through a real Promise, preserving success and failure shapes', async () => {
        const exec = async (file) => {
            if (file === 'node') return 'v22.16.0\n';
            throw new Error(`spawn ENOENT: ${file}`);
        };
        // apra-fleet-i9ag.19.24: the thenable half of the dual contract now
        // requires an explicit { async: true } opt-in -- without it,
        // probeVersion() throws ProbeVersionAsyncContractError rather than
        // silently returning the in-flight Promise as if it were the result
        // object (see node-version.mjs's file header and the dedicated
        // apra-fleet-i9ag.19.24 case in test/i9ag15-node-runner.test.mjs for
        // the loud-failure side of this contract).
        const ok = probeVersion(exec, 'linux', 'node', ['--version'], { async: true });
        assert.ok(typeof ok.then === 'function', 'an async exec must yield a genuine Promise, not a plain object');
        assert.deepEqual(await ok, { version: '22.16.0', incomplete: null });

        const failed = probeVersion(exec, 'linux', 'missing', ['--version'], { async: true });
        assert.deepEqual(await failed, { version: null, incomplete: null });
    });

    test('apra-fleet-i9ag.19.24: an async exec handed to probeVersion() WITHOUT { async: true } throws ProbeVersionAsyncContractError, never a silent success', () => {
        const exec = async () => 'v22.16.0\n';
        assert.throws(
            () => probeVersion(exec, 'linux', 'node', ['--version'], {}),
            (err) => {
                assert.equal(err.name, 'ProbeVersionAsyncContractError');
                assert.match(err.message, /did not opt into the async contract/);
                return true;
            },
        );
    });
});

describe('apra-fleet-i9ag.19.16: one shared implementation observably serves both callers', () => {
    /** Temp dirs created by this suite, removed in afterEach. */
    const tmpDirs = [];

    afterEach(async () => {
        while (tmpDirs.length) {
            await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
        }
    });

    async function mkTmp() {
        const dir = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-node-version-shared-')));
        tmpDirs.push(dir);
        return dir;
    }

    test('resolveSprintRunnerCommand() (CONFIGURED tier) and validateRecordedToolchain() parse the SAME version for the same recorded node path', async () => {
        // An absolute POSIX-style path so writeSupervisorToolchain()'s own
        // path.isAbsolute() check accepts it on any test host, while still
        // containing a space so platform:'win32' below exercises the exact
        // same quoting decision in both callers -- quoteForWindowsShell()
        // only ever inspects whitespace, never drive-letter syntax.
        const nodePath = '/opt/my node/bin/node';
        const quoted = `"${nodePath}"`;

        const runnerExec = fakeExecCapturing({ [quoted]: 'v22.16.0' });
        const runnerResult = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec: runnerExec.exec,
            platform: 'win32',
            configuredNodePath: nodePath,
        });

        const dataDir = await mkTmp();
        const filePath = supervisorConfigPath({ dataDir });
        await writeSupervisorToolchain({ nodePath, bdPath: '/opt/my node/bin/bd' }, { filePath });
        const toolchainExec = fakeExecCapturing({ [quoted]: 'v22.16.0', [`"${'/opt/my node/bin/bd'}"`]: 'bd version 1.2.3' });
        const toolchainResult = await validateRecordedToolchain({
            dataDir,
            exec: toolchainExec.exec,
            platform: 'win32',
        });

        // Same parsed version out of both callers for the same recorded path.
        assert.equal(runnerResult.version, '22.16.0');
        assert.equal(toolchainResult.nodeVersion, '22.16.0');
        assert.equal(runnerResult.version, toolchainResult.nodeVersion);
        assert.equal(runnerResult.source, SPRINT_RUNNER_SOURCE.CONFIGURED);
        assert.equal(toolchainResult.nodeOk, true);

        // Same win32 quoting decision: both callers' exec received the
        // QUOTED candidate for the identical spaced nodePath, never the raw
        // string -- proving one shared probeVersion()/quoteForWindowsShell()
        // implementation serves both, rather than two implementations that
        // happen to agree today.
        assert.equal(runnerExec.calls[0].file, quoted);
        assert.equal(toolchainExec.calls.find((c) => c.file === quoted)?.file, quoted);
    });
});
