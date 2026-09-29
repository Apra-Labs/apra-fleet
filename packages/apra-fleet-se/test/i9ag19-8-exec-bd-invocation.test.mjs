// apra-fleet-i9ag.19.8 -- dedicated regression suite for
// packages/apra-fleet-se/src/supervisor/lib/exec-bd.mjs's bd invocation,
// covering every WHAT TO TEST bullet from the bead as its own named case:
//
//   1. unconfigured execBdSync/execBdAsync: exact file, args, options
//      (including shell and maxBuffer), pinning the no-change claim.
//   2. configured POSIX bdPath used as the file argument, with an emptied
//      PATH (proves the configured branch never falls back to a PATH scan).
//   3. configured win32 .cmd resolved to its wrapped bd.js, invoked with the
//      configured nodePath, not process.execPath (injected platform).
//   4. configured win32 .cmd whose content does not match the shim shape
//      takes the documented fallback -- asserts which one.
//   5. assertSafeArgs still throws synchronously for an unsafe arg in both
//      modes (unconfigured and configured).
//   6. the large-output warning still fires at the documented threshold in
//      both modes (unconfigured and configured), for both execBdSync and
//      execBdAsync.
//   7. resolvedBdInvocation() reports configured and unconfigured states.
//
// exec-bd.mjs is used by every supervisor bd call site (backlog.mjs,
// scope-overlap.mjs, sandbox-seed-beads.mjs et al.), so a regression here is
// a silent supervisor-wide failure -- the unconfigured path in particular
// must be pinned exactly, since every existing caller relies on it staying
// byte-for-byte what it is today (apra-fleet-i9ag.19.7's own acceptance
// criterion #2). This file does not require a real bd install or a real
// Windows host: every exec call is injected, and win32-only branches are
// exercised via the injectable `platform` parameter.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    configureBdInvocation,
    resolvedBdInvocation,
    execBdSync,
    execBdAsync,
    BD_MAX_BUFFER_BYTES,
    BD_LARGE_OUTPUT_WARN_BYTES,
} from '../src/supervisor/lib/exec-bd.mjs';

// The configured invocation is module-level singleton state -- every test
// that configures it must clear it afterward so it cannot leak into an
// unrelated test (including tests outside this file, since test/*.test.mjs
// files can share a worker process).
afterEach(() => {
    configureBdInvocation({});
});

describe('apra-fleet-i9ag.19.8 bullet 1: unconfigured execBdSync/execBdAsync -- exact file/args/options', () => {
    test('execBdSync unconfigured, win32 shim resolved: process.execPath + [scriptPath, ...args], maxBuffer default, shell: false', () => {
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'fake-output';
        };
        const result = execBdSync(
            ['list', '--json'],
            { cwd: '/repo', encoding: 'utf-8' },
            fakeExecFileSync,
            () => 'C:\\fake\\npm\\node_modules\\@beads\\bd\\bin\\bd.js',
        );
        assert.equal(result, 'fake-output');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            cmd: process.execPath,
            args: ['C:\\fake\\npm\\node_modules\\@beads\\bd\\bin\\bd.js', 'list', '--json'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: '/repo', encoding: 'utf-8', shell: false },
        });
    });

    test('execBdSync unconfigured, win32 shim not resolved: bare "bd" + args, maxBuffer default, shell only forced true on win32', () => {
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'fake-output';
        };
        const result = execBdSync(['dolt', 'remote', 'list', '--json'], { cwd: '/repo', encoding: 'utf-8' }, fakeExecFileSync, () => null);
        assert.equal(result, 'fake-output');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            cmd: 'bd',
            args: ['dolt', 'remote', 'list', '--json'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: '/repo', encoding: 'utf-8', shell: process.platform === 'win32' },
        });
    });

    test('execBdAsync unconfigured: bare "bd" + args, maxBuffer default, shell: true unconditionally', async () => {
        const calls = [];
        const fakeExecFileAsync = async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { stdout: 'fake-output', stderr: '' };
        };
        const result = await execBdAsync(['list', '--json', '--limit', '0'], { cwd: '/repo', encoding: 'utf-8' }, fakeExecFileAsync);
        assert.equal(result.stdout, 'fake-output');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            cmd: 'bd',
            args: ['list', '--json', '--limit', '0'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: '/repo', encoding: 'utf-8', shell: true },
        });
    });
});

describe('apra-fleet-i9ag.19.8 bullet 2: configured POSIX bdPath used as the file argument, with an emptied PATH', () => {
    test('execBdSync: configured bdPath is invoked directly while process.env.PATH is empty (no PATH lookup possible)', () => {
        const originalPath = process.env.PATH;
        process.env.PATH = '';
        try {
            configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
            const calls = [];
            const fakeExecFileSync = (cmd, args, opts) => {
                calls.push({ cmd, args, opts });
                return 'fake-output';
            };
            // Not win32 (or the .cmd resolver finds nothing) -> falls through
            // to the configured-fallback branch, which invokes bdPath
            // directly -- never consults process.env.PATH at all.
            const result = execBdSync(['list', '--json'], { cwd: '/repo' }, fakeExecFileSync, () => null, () => null);
            assert.equal(result, 'fake-output');
            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0], {
                cmd: '/opt/apra-fleet/bin/bd',
                args: ['list', '--json'],
                opts: { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: '/repo', shell: process.platform === 'win32' },
            });
        } finally {
            process.env.PATH = originalPath;
        }
    });

    test('execBdAsync: configured bdPath is used as the file argument while process.env.PATH is empty (no PATH lookup possible)', async () => {
        const originalPath = process.env.PATH;
        process.env.PATH = '';
        try {
            configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
            const calls = [];
            const fakeExecFileAsync = async (cmd, args, opts) => {
                calls.push({ cmd, args, opts });
                return { stdout: 'fake-output', stderr: '' };
            };
            const result = await execBdAsync(['list', '--json'], { cwd: '/repo' }, fakeExecFileAsync, undefined, 'linux');
            assert.equal(result.stdout, 'fake-output');
            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0], {
                cmd: '/opt/apra-fleet/bin/bd',
                args: ['list', '--json'],
                opts: { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: '/repo', shell: true },
            });
        } finally {
            process.env.PATH = originalPath;
        }
    });
});

describe('apra-fleet-i9ag.19.8 bullet 3: configured win32 .cmd resolves to its wrapped bd.js, invoked with the configured nodePath', () => {
    test('uses the configured nodePath as the exec file, never process.execPath, on injected win32', () => {
        configureBdInvocation({ bdPath: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bd.cmd', nodePath: 'C:\\recorded\\node.exe' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'fake-output';
        };
        const resolveConfiguredWindowsBd = (bdPath) => {
            assert.equal(bdPath, 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bd.cmd');
            return 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.js';
        };
        const result = execBdSync(
            ['list', '--json'],
            {},
            fakeExecFileSync,
            () => { throw new Error('unconfigured resolver must not run when a bdPath is configured'); },
            resolveConfiguredWindowsBd,
        );
        assert.equal(result, 'fake-output');
        assert.equal(calls.length, 1);
        assert.notEqual(calls[0].cmd, process.execPath, 'must use the configured nodePath, not process.execPath');
        assert.deepEqual(calls[0], {
            cmd: 'C:\\recorded\\node.exe',
            args: ['C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.js', 'list', '--json'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, shell: false },
        });
    });
});

describe('apra-fleet-i9ag.19.8 bullet 4: configured win32 .cmd not matching the shim shape takes the documented fallback', () => {
    test('falls back to invoking the configured bdPath directly (not the nodePath, not a bd.js path)', () => {
        configureBdInvocation({ bdPath: 'C:\\a\\bd.cmd', nodePath: 'C:\\recorded\\node.exe' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'ok';
        };
        // resolveConfiguredWindowsBd returning null models a .cmd whose
        // content does not match npm's shim shape.
        execBdSync(['--version'], {}, fakeExecFileSync, () => null, () => null);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cmd, 'C:\\a\\bd.cmd', 'documented fallback: invoke the configured bdPath directly');
        assert.notEqual(calls[0].cmd, 'C:\\recorded\\node.exe', 'must not fall back to the configured nodePath');
        assert.deepEqual(calls[0].args, ['--version']);
    });
});

describe('apra-fleet-i9ag.19.8 bullet 5: assertSafeArgs still throws synchronously for an unsafe arg in both modes', () => {
    test('unconfigured execBdAsync throws synchronously (before any exec) for an unsafe arg', () => {
        let execCalled = false;
        const fakeExecFileAsync = async () => {
            execCalled = true;
            return { stdout: '', stderr: '' };
        };
        assert.throws(() => execBdAsync(['list', '--parent', 'a & echo INJECTED'], {}, fakeExecFileAsync), TypeError);
        assert.equal(execCalled, false, 'exec must never run once an unsafe arg is rejected');
    });

    test('configured execBdAsync throws synchronously (before any exec) for an unsafe arg', () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
        let execCalled = false;
        const fakeExecFileAsync = async () => {
            execCalled = true;
            return { stdout: '', stderr: '' };
        };
        assert.throws(() => execBdAsync(['list', '--parent', 'a & echo INJECTED'], {}, fakeExecFileAsync), TypeError);
        assert.equal(execCalled, false, 'exec must never run once an unsafe arg is rejected');
    });
});

describe('apra-fleet-i9ag.19.8 bullet 6: the large-output warning fires at the documented threshold in both modes', () => {
    test('execBdSync unconfigured: fires once output crosses BD_LARGE_OUTPUT_WARN_BYTES', () => {
        const big = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES + 1);
        const fakeExecFileSync = () => big;
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);
        try {
            execBdSync(['list', '--json'], {}, fakeExecFileSync, () => null);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /bd list --json/);
    });

    test('execBdSync configured: fires once output crosses BD_LARGE_OUTPUT_WARN_BYTES', () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd' });
        const big = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES + 1);
        const fakeExecFileSync = () => big;
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);
        try {
            execBdSync(['list', '--json'], {}, fakeExecFileSync, () => null, () => null);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /bd list --json/);
    });

    test('execBdAsync unconfigured: fires once stdout crosses BD_LARGE_OUTPUT_WARN_BYTES', async () => {
        const big = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES + 1);
        const fakeExecFileAsync = async () => ({ stdout: big, stderr: '' });
        const warnings = [];
        await execBdAsync(['list', '--json'], {}, fakeExecFileAsync, (msg) => warnings.push(msg));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /bd list --json/);
    });

    test('execBdAsync configured: fires once stdout crosses BD_LARGE_OUTPUT_WARN_BYTES', async () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
        const big = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES + 1);
        const fakeExecFileAsync = async () => ({ stdout: big, stderr: '' });
        const warnings = [];
        await execBdAsync(['list', '--json'], {}, fakeExecFileAsync, (msg) => warnings.push(msg));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /bd list --json/);
    });

    test('stays silent just below the threshold, in both modes', async () => {
        const justUnder = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES);

        const warningsSyncUnconfigured = [];
        execBdSync(['list'], {}, () => justUnder, () => null);
        const originalWarn = console.warn;
        console.warn = (msg) => warningsSyncUnconfigured.push(msg);
        try {
            execBdSync(['list'], {}, () => justUnder, () => null);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(warningsSyncUnconfigured.length, 0);

        const warningsAsyncConfigured = [];
        configureBdInvocation({ bdPath: '/opt/bd/bd' });
        await execBdAsync(['list'], {}, async () => ({ stdout: justUnder, stderr: '' }), (msg) => warningsAsyncConfigured.push(msg));
        assert.equal(warningsAsyncConfigured.length, 0);
    });
});

describe('apra-fleet-i9ag.19.8 bullet 7: resolvedBdInvocation() reports configured and unconfigured states', () => {
    test('reports configured: false with null paths when nothing has been configured', () => {
        assert.deepEqual(resolvedBdInvocation(), { bdPath: null, nodePath: null, configured: false });
    });

    test('reports configured: true with the exact paths once configureBdInvocation() is called', () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd', nodePath: '/opt/node/bin/node' });
        assert.deepEqual(resolvedBdInvocation(), { bdPath: '/opt/bd/bd', nodePath: '/opt/node/bin/node', configured: true });
    });

    test('reverts to configured: false after configureBdInvocation({}) clears it', () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd', nodePath: '/opt/node/bin/node' });
        configureBdInvocation({});
        assert.deepEqual(resolvedBdInvocation(), { bdPath: null, nodePath: null, configured: false });
    });
});
