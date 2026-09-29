// apra-fleet-i9ag.19.7 -- packages/apra-fleet-se/src/supervisor/lib/exec-bd.mjs's
// configured bd invocation: configureBdInvocation()/resolvedBdInvocation()
// plus the CONFIGURED branches of execBdSync/execBdAsync and
// resolveConfiguredWindowsBdScript(). A service started by launchd or a
// Windows task does not inherit the login PATH, so this module accepts an
// explicit, one-time configured { bdPath, nodePath } (set by the supervisor's
// startup, apra-fleet-i9ag.19.10) so bd can still be found and run.
//
// This suite pins two things per acceptance criterion:
//   1. UNCONFIGURED behaviour is asserted exactly (file/args/options), not
//      just "it still works", so a future change cannot silently alter it.
//   2. CONFIGURED behaviour (POSIX, win32 shim, win32 non-shim fallback,
//      assertSafeArgs, the large-output warning, resolvedBdInvocation()) is
//      asserted with the same rigor, using injected platform/exists/readFile
//      deps so every case runs on any host.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    configureBdInvocation,
    resolvedBdInvocation,
    resolveConfiguredWindowsBdScript,
    execBdSync,
    execBdAsync,
    BD_MAX_BUFFER_BYTES,
    BD_LARGE_OUTPUT_WARN_BYTES,
} from '../src/supervisor/lib/exec-bd.mjs';

// The configured invocation is module-level singleton state (by design --
// see configureBdInvocation()'s doc comment); every test that configures it
// must clear it afterward so it cannot leak into an unrelated test.
afterEach(() => {
    configureBdInvocation({});
});

describe('apra-fleet-i9ag.19.7: resolvedBdInvocation()', () => {
    test('reports configured: false with null paths when nothing has been configured', () => {
        assert.deepEqual(resolvedBdInvocation(), { bdPath: null, nodePath: null, configured: false });
    });

    test('reports configured: true with the exact paths once configureBdInvocation() is called', () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd', nodePath: '/opt/node/bin/node' });
        assert.deepEqual(resolvedBdInvocation(), { bdPath: '/opt/bd/bd', nodePath: '/opt/node/bin/node', configured: true });
    });

    test('normalizes blank/whitespace-only/non-string values back to null, and configured follows bdPath only', () => {
        configureBdInvocation({ bdPath: '   ', nodePath: 42 });
        assert.deepEqual(resolvedBdInvocation(), { bdPath: null, nodePath: null, configured: false });

        configureBdInvocation({ bdPath: '/opt/bd/bd' });
        assert.deepEqual(resolvedBdInvocation(), { bdPath: '/opt/bd/bd', nodePath: null, configured: true });
    });

    test('calling configureBdInvocation() with no argument clears any previous configuration', () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd', nodePath: '/opt/node/bin/node' });
        configureBdInvocation();
        assert.deepEqual(resolvedBdInvocation(), { bdPath: null, nodePath: null, configured: false });
    });
});

describe('apra-fleet-i9ag.19.7: resolveConfiguredWindowsBdScript()', () => {
    const npmShimContent = [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@beads\\bd\\bin\\bd.js" %*',
        '',
    ].join('\r\n');

    test('resolves the wrapped bin/bd.js next to a configured npm-shim-shaped .cmd, on injected win32', () => {
        const scriptPath = resolveConfiguredWindowsBdScript('C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bd.cmd', {
            platform: 'win32',
            existsFn: (p) => p === 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bd.cmd',
            readFileFn: () => npmShimContent,
        });
        assert.equal(scriptPath, 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.js');
    });

    test('returns null when the configured path does not exist', () => {
        const scriptPath = resolveConfiguredWindowsBdScript('C:\\nope\\bd.cmd', {
            platform: 'win32',
            existsFn: () => false,
            readFileFn: () => { throw new Error('should never be called'); },
        });
        assert.equal(scriptPath, null);
    });

    test('returns null when the configured .cmd content does not match the npm-shim shape', () => {
        const scriptPath = resolveConfiguredWindowsBdScript('C:\\a\\bd.cmd', {
            platform: 'win32',
            existsFn: () => true,
            readFileFn: () => '@ECHO off\r\necho not an npm shim\r\n',
        });
        assert.equal(scriptPath, null);
    });

    test('always returns null on a non-win32 platform, regardless of what exists/readFile would otherwise resolve', () => {
        const scriptPath = resolveConfiguredWindowsBdScript('/opt/bd/bd.cmd', {
            platform: 'linux',
            existsFn: () => true,
            readFileFn: () => npmShimContent,
        });
        assert.equal(scriptPath, null);
    });
});

describe('apra-fleet-i9ag.19.7: execBdSync() unconfigured (AC2 -- byte-for-byte regression pin)', () => {
    test('win32 safe path (bd.cmd resolved): invokes process.execPath + [scriptPath, ...args], shell: false', () => {
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

    test('fallback path (bd.cmd not resolved): invokes "bd" + args directly, shell only forced true on win32', () => {
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
});

describe('apra-fleet-i9ag.19.7: execBdSync() configured (AC1, AC3, AC4)', () => {
    test('AC1: configured POSIX bdPath is used as the file argument, invoked exactly (empty-PATH-safe: no PATH lookup involved)', () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'fake-output';
        };
        // Not on win32 (or a .cmd not resolved) -> falls through to the
        // configured-fallback branch, which invokes bdPath directly.
        const result = execBdSync(['list', '--json'], { cwd: '/repo' }, fakeExecFileSync, () => null, () => null);
        assert.equal(result, 'fake-output');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            cmd: '/opt/apra-fleet/bin/bd',
            args: ['list', '--json'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: '/repo', shell: process.platform === 'win32' },
        });
    });

    test('AC3: configured win32 .cmd shim resolves to its bd.js and is invoked with the configured nodePath, NOT process.execPath', () => {
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
        const result = execBdSync(['list', '--json'], {}, fakeExecFileSync, () => { throw new Error('unconfigured resolver must not run'); }, resolveConfiguredWindowsBd);
        assert.equal(result, 'fake-output');
        assert.equal(calls.length, 1);
        assert.notEqual(calls[0].cmd, process.execPath, 'must use the configured nodePath, not process.execPath');
        assert.deepEqual(calls[0], {
            cmd: 'C:\\recorded\\node.exe',
            args: ['C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.js', 'list', '--json'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, shell: false },
        });
    });

    test('AC3 fallback: configured nodePath missing falls back to process.execPath for the resolved shim', () => {
        configureBdInvocation({ bdPath: 'C:\\a\\bd.cmd' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'ok';
        };
        execBdSync(['--version'], {}, fakeExecFileSync, () => null, () => 'C:\\a\\node_modules\\@beads\\bd\\bin\\bd.js');
        assert.equal(calls[0].cmd, process.execPath);
    });

    test('configured .cmd not matching the shim shape (or non-win32) keeps the documented fallback: invoke bdPath directly', () => {
        configureBdInvocation({ bdPath: 'C:\\a\\bd.cmd', nodePath: 'C:\\recorded\\node.exe' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'ok';
        };
        execBdSync(['--version'], {}, fakeExecFileSync, () => null, () => null);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cmd, 'C:\\a\\bd.cmd', 'falls back to invoking the configured bdPath directly, not the nodePath');
        assert.equal(calls[0].args[0], '--version');
    });

    test('AC4: assertSafeArgs is execBdAsync-only, but the array-shape guard still throws synchronously in the configured path', () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd' });
        assert.throws(() => execBdSync('not-an-array'), TypeError);
    });

    test('AC4: the large-output warning still fires in the configured path', () => {
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
});

describe('apra-fleet-i9ag.19.7: execBdAsync() unconfigured (AC2 -- byte-for-byte regression pin)', () => {
    test('invokes "bd" with the exact args/options, shell: true, maxBuffer defaulted', async () => {
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

describe('apra-fleet-i9ag.19.7: execBdAsync() configured (AC1, AC4)', () => {
    test('AC1: configured bdPath (empty PATH scenario) is used as the file argument, exact args/options preserved', async () => {
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
    });

    test('AC4: assertSafeArgs still throws synchronously for an unsafe arg in the configured path', () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
        const fakeExecFileAsync = async () => ({ stdout: '', stderr: '' });
        assert.throws(() => execBdAsync(['list', '--parent', 'a & echo INJECTED'], {}, fakeExecFileAsync), TypeError);
    });

    test('AC4: the large-output warning still fires in the configured path', async () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
        const big = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES + 1);
        const fakeExecFileAsync = async () => ({ stdout: big, stderr: '' });
        const warnings = [];
        await execBdAsync(['list', '--json'], {}, fakeExecFileAsync, (msg) => warnings.push(msg));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /bd list --json/);
    });

    // Substantive defect fix (2026-09-29 review round): execBdAsync forces
    // { shell: true } on every platform, and Node's shell:true joins file +
    // args with plain, UNQUOTED spaces before handing the result to sh/
    // cmd.exe -- so a configured bdPath containing a space (the common
    // npm-global-install case, e.g. an npm-global "Jane Doe" home directory
    // on either macOS or Windows) used to be word-split into multiple shell
    // tokens and fail. These pin the fix: the file exec-bd.mjs hands to the
    // injected execFileAsyncImpl is quoted for the (injectable) target
    // platform's shell.
    test('a configured bdPath containing a space is quoted for a POSIX shell (single-quoted, no interpolation)', async () => {
        configureBdInvocation({ bdPath: '/Users/Jane Doe/.npm-global/bin/bd' });
        const calls = [];
        const fakeExecFileAsync = async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { stdout: '', stderr: '' };
        };
        await execBdAsync(['--version'], {}, fakeExecFileAsync, undefined, 'darwin');
        assert.equal(calls[0].cmd, "'/Users/Jane Doe/.npm-global/bin/bd'");
    });

    test('a configured bdPath containing a space is quoted for cmd.exe (double-quoted) on injected win32', async () => {
        configureBdInvocation({ bdPath: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bd' });
        const calls = [];
        const fakeExecFileAsync = async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { stdout: '', stderr: '' };
        };
        await execBdAsync(['--version'], {}, fakeExecFileAsync, undefined, 'win32');
        assert.equal(calls[0].cmd, '"C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bd"');
    });

    test('a configured bdPath with no whitespace is passed through unquoted, on any platform', async () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
        const calls = [];
        const fakeExecFileAsync = async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { stdout: '', stderr: '' };
        };
        await execBdAsync(['--version'], {}, fakeExecFileAsync, undefined, 'win32');
        assert.equal(calls[0].cmd, '/opt/apra-fleet/bin/bd');
    });

    test('end-to-end: a real spaced-path script is actually invocable through execBdAsync + shell: true', { skip: process.platform === 'win32' ? 'POSIX-shebang script; covered on POSIX runners' : false }, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'exec-bd i9ag19-7 '));
        const scriptPath = path.join(dir, 'fake-bd');
        writeFileSync(scriptPath, '#!/bin/sh\necho bd-fake-output\n');
        chmodSync(scriptPath, 0o755);
        try {
            configureBdInvocation({ bdPath: scriptPath });
            const { stdout } = await execBdAsync([], { encoding: 'utf-8' });
            assert.equal(String(stdout).trim(), 'bd-fake-output');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
