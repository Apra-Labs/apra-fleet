// apra-fleet-i9ag.19.7 (and consolidated i9ag.19.8, apra-fleet-i9ag.19.17) --
// packages/apra-fleet-se/src/supervisor/lib/exec-bd.mjs's bd invocation:
// configureBdInvocation()/resolvedBdInvocation() plus the UNCONFIGURED and
// CONFIGURED branches of execBdSync/execBdAsync and
// resolveConfiguredWindowsBdScript(). A service started by launchd or a
// Windows task does not inherit the login PATH, so this module accepts an
// explicit, one-time configured { bdPath, nodePath } (set by the supervisor's
// startup, apra-fleet-i9ag.19.10) so bd can still be found and run.
//
// exec-bd.mjs is used by every supervisor bd call site (backlog.mjs,
// scope-overlap.mjs, sandbox-seed-beads.mjs et al.), so a regression here is
// a silent supervisor-wide failure. This single suite (i9ag.19.7 and
// i9ag.19.8 were merged by i9ag.19.17 to remove duplicate coverage) pins:
//   1. UNCONFIGURED behaviour is asserted exactly (file/args/options), not
//      just "it still works", so a future change cannot silently alter it.
//   2. CONFIGURED behaviour (POSIX, win32 shim, win32 non-shim fallback,
//      assertSafeArgs, the large-output warning, resolvedBdInvocation()) is
//      asserted with the same rigor, using injected platform/exists/readFile
//      deps so every case runs on any host.
//   3. Configured POSIX bdPath invocation with an emptied process.env.PATH,
//      proving the configured branch never falls back to a PATH scan.
//   4. assertSafeArgs and the large-output warning are pinned in BOTH modes
//      (unconfigured and configured) for both execBdSync and execBdAsync,
//      including a below-threshold negative case that stays silent.
//
// This file does not require a real bd install or a real Windows host: every
// exec call is injected, and win32-only branches are exercised via the
// injectable `platform` parameter.

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

    test('(i9ag.19.8 bullet 6) the large-output warning still fires in the unconfigured path', () => {
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

    test('AC1 (i9ag.19.8 bullet 2): configured bdPath is invoked directly while process.env.PATH is actually emptied (never consults PATH)', () => {
        const originalPath = process.env.PATH;
        process.env.PATH = '';
        try {
            configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
            const calls = [];
            const fakeExecFileSync = (cmd, args, opts) => {
                calls.push({ cmd, args, opts });
                return 'fake-output';
            };
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

// apra-fleet-i9ag.19.26: execBdSync()'s CONFIGURED non-shim fallback (the
// branch reached when resolveConfiguredWindowsBd() returns null -- a
// recorded bdPath that is NOT an npm .cmd shim, e.g. a native bd.exe, or a
// .cmd whose content does not match the shim regex) sets
// { shell: true } on win32, and Node's shell:true joins file+args with plain
// UNQUOTED spaces before handing the result to cmd.exe -- so a recorded
// bdPath containing a space (the common npm-global-install "Jane Doe"
// home-directory case, same as execBdAsync's already-fixed defect,
// apra-fleet-i9ag.19.7 follow-up) used to be word-split into multiple shell
// tokens and fail to resolve. This block pins the fix (quoteShellFile()
// applied on that one shell:true branch) and the new injectable `platform`
// parameter (mirroring execBdAsync's shape) that makes it exercisable here
// on any host.
describe('apra-fleet-i9ag.19.26: execBdSync() configured non-shim fallback quotes a spaced bdPath on win32', () => {
    test('AC1/AC2/AC3: a spaced configured bdPath is double-quoted for the { shell: true } invocation on injected win32', () => {
        configureBdInvocation({ bdPath: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bd.exe' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'fake-output';
        };
        // resolveConfiguredWindowsBd returns null -> falls through to the
        // non-shim fallback branch this bead is about.
        const result = execBdSync(['--version'], {}, fakeExecFileSync, () => null, () => null, 'win32');
        assert.equal(result, 'fake-output');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            cmd: '"C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bd.exe"',
            args: ['--version'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, shell: true },
        }, 'the quoted file must be handed to a { shell: true } invocation, matching execBdAsync\'s already-fixed shape');
    });

    test('a configured bdPath with no whitespace is passed through unquoted on injected win32 (quoteShellFile is a no-op)', () => {
        configureBdInvocation({ bdPath: 'C:\\opt\\bd.exe' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'ok';
        };
        execBdSync(['--version'], {}, fakeExecFileSync, () => null, () => null, 'win32');
        assert.equal(calls[0].cmd, 'C:\\opt\\bd.exe');
        assert.equal(calls[0].opts.shell, true);
    });

    test('AC4: the SAME spaced bdPath on injected POSIX is passed through UNQUOTED, shell-less (byte-for-byte unchanged -- quoting a shell-less argv-array file would corrupt it)', () => {
        configureBdInvocation({ bdPath: '/Users/Jane Doe/.npm-global/bin/bd' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'fake-output';
        };
        const result = execBdSync(['--version'], {}, fakeExecFileSync, () => null, () => null, 'darwin');
        assert.equal(result, 'fake-output');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            cmd: '/Users/Jane Doe/.npm-global/bin/bd',
            args: ['--version'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, shell: false },
        });
    });

    test('AC2: omitting the platform argument defaults to process.platform, same as every other execBdSync param', () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'ok';
        };
        execBdSync(['--version'], {}, fakeExecFileSync, () => null, () => null);
        assert.equal(calls[0].opts.shell, process.platform === 'win32');
    });
});

// D1 fix (bead reopened after judge of PR #561): a configured bdPath is
// typically an npm-installed '#!/usr/bin/env node' script, and under a
// service's PATH (launchd, a Windows task) that PATH may contain no `node`
// at all -- `env` then fails with 'env: node: No such file or directory'
// (exit 127), verified on fleet-mac1 with
// `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`. These pin the chosen fix
// (amended AC A1-A3, A6): on POSIX, when a nodePath is ALSO configured,
// dirname(nodePath) is prepended to the child's PATH.
describe('apra-fleet-i9ag.19.7 (D1 fix): POSIX PATH composition for a configured nodePath', () => {
    test('A1/A3: execBdSync configured bdPath+nodePath on POSIX prepends dirname(nodePath) to PATH; every other option is untouched', { skip: process.platform === 'win32' ? 'POSIX-only PATH-prepend fix' : false }, () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd', nodePath: '/opt/apra-fleet/node/bin/node' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'fake-output';
        };
        const originalPath = process.env.PATH;
        process.env.PATH = '/usr/bin:/bin';
        try {
            const result = execBdSync(['list', '--json'], { cwd: '/repo' }, fakeExecFileSync, () => null, () => null);
            assert.equal(result, 'fake-output');
            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0], {
                cmd: '/opt/apra-fleet/bin/bd',
                args: ['list', '--json'],
                opts: {
                    maxBuffer: BD_MAX_BUFFER_BYTES,
                    cwd: '/repo',
                    shell: false,
                    env: { ...process.env, PATH: '/opt/apra-fleet/node/bin:/usr/bin:/bin' },
                },
            });
        } finally {
            process.env.PATH = originalPath;
        }
    });

    test('A4/A5: without a configured nodePath, the configured POSIX path stays exactly as before -- no env key added at all', () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd' });
        const calls = [];
        const fakeExecFileSync = (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return 'fake-output';
        };
        execBdSync(['list', '--json'], { cwd: '/repo' }, fakeExecFileSync, () => null, () => null);
        assert.deepEqual(calls[0], {
            cmd: '/opt/apra-fleet/bin/bd',
            args: ['list', '--json'],
            opts: { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: '/repo', shell: process.platform === 'win32' },
        });
        assert.ok(!('env' in calls[0].opts), 'no env key must be added when nodePath is not configured');
    });

    test('A6: execBdAsync mirrors the same POSIX PATH-prepend strategy for a configured bdPath+nodePath', async () => {
        configureBdInvocation({ bdPath: '/opt/apra-fleet/bin/bd', nodePath: '/opt/apra-fleet/node/bin/node' });
        const calls = [];
        const fakeExecFileAsync = async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { stdout: 'fake-output', stderr: '' };
        };
        await execBdAsync(['list', '--json'], { cwd: '/repo', env: { PATH: '/usr/bin:/bin' } }, fakeExecFileAsync, undefined, 'linux');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            cmd: '/opt/apra-fleet/bin/bd',
            args: ['list', '--json'],
            opts: {
                maxBuffer: BD_MAX_BUFFER_BYTES,
                cwd: '/repo',
                shell: true,
                env: { PATH: '/opt/apra-fleet/node/bin:/usr/bin:/bin' },
            },
        });
    });

    test('execBdAsync configured with nodePath on injected win32 adds no env key (this fix targets POSIX only)', async () => {
        configureBdInvocation({ bdPath: 'C:\\a\\bd', nodePath: 'C:\\recorded\\node.exe' });
        const calls = [];
        const fakeExecFileAsync = async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { stdout: '', stderr: '' };
        };
        await execBdAsync(['--version'], {}, fakeExecFileAsync, undefined, 'win32');
        assert.ok(!('env' in calls[0].opts), 'no env key must be added on win32');
    });

    test('A1 end-to-end (sync): a real "#!/usr/bin/env node" script is invoked successfully via execBdSync with PATH emptied of node', { skip: process.platform === 'win32' ? 'POSIX shebang script' : false }, () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'exec-bd-node-shebang-sync-'));
        const scriptPath = path.join(dir, 'fake-bd');
        writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("bd-fake-output-sync");\n');
        chmodSync(scriptPath, 0o755);
        const originalPath = process.env.PATH;
        try {
            configureBdInvocation({ bdPath: scriptPath, nodePath: process.execPath });
            // Deliberately no directory containing `node` on PATH -- the exact
            // launchd-style broken-PATH shape D1 was filed against.
            process.env.PATH = '/usr/bin:/bin';
            const out = execBdSync([], { encoding: 'utf-8' });
            assert.equal(String(out).trim(), 'bd-fake-output-sync');
        } finally {
            process.env.PATH = originalPath;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // apra-fleet-i9ag.19.28 AC1 CONTROL (sync): the IDENTICAL stub and the
    // IDENTICAL node-less PATH as the end-to-end case immediately above, but
    // with nodePath NOT configured -- this must FAIL with the exact env/127
    // shape D1 was filed against. Without this control, a passing end-to-end
    // case above could just as easily be an accident of the test harness's
    // own PATH still having a node on it somewhere; this proves the PASS
    // above is actually caused by the PATH-prepend fix.
    test('CONTROL (sync): the SAME node-shebang stub with NO configured nodePath FAILS under the SAME node-less PATH (env: node: No such file, exit 127)', { skip: process.platform === 'win32' ? 'POSIX shebang script' : false }, () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'exec-bd-node-shebang-control-sync-'));
        const scriptPath = path.join(dir, 'fake-bd');
        writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("bd-fake-output-sync");\n');
        chmodSync(scriptPath, 0o755);
        const originalPath = process.env.PATH;
        try {
            // Deliberately no nodePath configured this time -- everything
            // else (the stub, the restricted PATH) is identical to the A1
            // end-to-end (sync) case above.
            configureBdInvocation({ bdPath: scriptPath });
            process.env.PATH = '/usr/bin:/bin';
            assert.throws(
                () => execBdSync([], { encoding: 'utf-8' }),
                (err) => {
                    assert.equal(err.status, 127, 'exit code must be the exact env-cannot-find-interpreter code');
                    // GNU coreutils env quotes the name -- ASCII 'node' under C locale,
                    // U+2018/U+2019 curly quotes under a UTF-8 locale (ubuntu CI);
                    // BSD/macOS env does not quote.
                    assert.match(String(err.stderr), /env: ['\u2018]?node['\u2019]?: No such file or directory/);
                    return true;
                },
            );
        } finally {
            process.env.PATH = originalPath;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('A1 end-to-end (async): the same node-shebang script is invocable via execBdAsync with PATH emptied of node', { skip: process.platform === 'win32' ? 'POSIX shebang script' : false }, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'exec-bd-node-shebang-async-'));
        const scriptPath = path.join(dir, 'fake-bd');
        writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("bd-fake-output-async");\n');
        chmodSync(scriptPath, 0o755);
        const originalPath = process.env.PATH;
        try {
            configureBdInvocation({ bdPath: scriptPath, nodePath: process.execPath });
            process.env.PATH = '/usr/bin:/bin';
            const { stdout } = await execBdAsync([], { encoding: 'utf-8' });
            assert.equal(String(stdout).trim(), 'bd-fake-output-async');
        } finally {
            process.env.PATH = originalPath;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // apra-fleet-i9ag.19.28 AC1 CONTROL (async): same reasoning as the sync
    // control above, for execBdAsync. execBdAsync always forces
    // { shell: true }, so the failure surfaces through the shell's own exit
    // code (execFileAsync's promisified err.code) rather than execFileSync's
    // err.status -- both are the same underlying 127.
    test('CONTROL (async): the SAME node-shebang script with NO configured nodePath FAILS under the SAME node-less PATH (env: node: No such file, exit 127)', { skip: process.platform === 'win32' ? 'POSIX shebang script' : false }, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'exec-bd-node-shebang-control-async-'));
        const scriptPath = path.join(dir, 'fake-bd');
        writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("bd-fake-output-async");\n');
        chmodSync(scriptPath, 0o755);
        const originalPath = process.env.PATH;
        try {
            configureBdInvocation({ bdPath: scriptPath });
            process.env.PATH = '/usr/bin:/bin';
            await assert.rejects(
                () => execBdAsync([], { encoding: 'utf-8' }),
                (err) => {
                    assert.equal(err.code, 127, 'exit code must be the exact env-cannot-find-interpreter code');
                    // GNU coreutils env quotes the name -- ASCII 'node' under C locale,
                    // U+2018/U+2019 curly quotes under a UTF-8 locale (ubuntu CI);
                    // BSD/macOS env does not quote.
                    assert.match(String(err.stderr), /env: ['\u2018]?node['\u2019]?: No such file or directory/);
                    return true;
                },
            );
        } finally {
            process.env.PATH = originalPath;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // WHAT TO TEST bullet: "a configured bdPath that is a real native binary
    // (not a node script) still runs shell-less and unchanged". A real
    // shebang-less-relevant POSIX binary (/bin/echo -- present on every
    // macOS/Linux CI runner this suite targets, never a node script) proves
    // the PATH-prepend fix is harmless to a bdPath that never shells out to
    // `env`: execBdSync's configured-fallback branch never sets
    // `shell: true` on POSIX (see the byte-for-byte AC1/A3 argv/opts pins
    // above), so a real absolute-path binary invocation via execFileSync
    // never even consults PATH -- this is the end-to-end proof that holds
    // regardless, complementing (not duplicating) those opts-shape pins.
    test('a configured bdPath that is a real native binary (not a node script) still runs, unaffected by an ALSO-configured nodePath\'s PATH-prepend', { skip: process.platform === 'win32' ? 'POSIX-only /bin/echo binary' : false }, () => {
        configureBdInvocation({ bdPath: '/bin/echo', nodePath: process.execPath });
        try {
            const out = execBdSync(['bd-fake-output-native'], { encoding: 'utf-8' });
            assert.equal(String(out).trim(), 'bd-fake-output-native');
        } finally {
            configureBdInvocation({});
        }
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

    test('(i9ag.19.8 bullet 5) throws synchronously (before any exec) for an unsafe arg', () => {
        let execCalled = false;
        const fakeExecFileAsync = async () => {
            execCalled = true;
            return { stdout: '', stderr: '' };
        };
        assert.throws(() => execBdAsync(['list', '--parent', 'a & echo INJECTED'], {}, fakeExecFileAsync), TypeError);
        assert.equal(execCalled, false, 'exec must never run once an unsafe arg is rejected');
    });

    test('(i9ag.19.8 bullet 6) the large-output warning still fires in the unconfigured path', async () => {
        const big = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES + 1);
        const fakeExecFileAsync = async () => ({ stdout: big, stderr: '' });
        const warnings = [];
        await execBdAsync(['list', '--json'], {}, fakeExecFileAsync, (msg) => warnings.push(msg));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /bd list --json/);
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

    test('AC1 (i9ag.19.8 bullet 2): configured bdPath is used as the file argument while process.env.PATH is actually emptied (never consults PATH)', async () => {
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

// i9ag.19.8's original version of this case asserted "in both modes" but
// only actually exercised sync-unconfigured and async-configured (plus a
// dead execBdSync call made before console.warn was even patched, whose
// result was discarded and never asserted on -- a copy-paste artifact).
// Fixed here (apra-fleet-i9ag.19.17) to genuinely cover all four
// combinations: both entry points, both configuration modes.
describe('apra-fleet-i9ag.19.8 bullet 6 (fixed): stays silent just below BD_LARGE_OUTPUT_WARN_BYTES, in all four sync/async x configured/unconfigured combinations', () => {
    test('execBdSync unconfigured stays silent just below the threshold', () => {
        const justUnder = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES);
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);
        try {
            execBdSync(['list'], {}, () => justUnder, () => null);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(warnings.length, 0);
    });

    test('execBdSync configured stays silent just below the threshold', () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd' });
        const justUnder = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES);
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);
        try {
            execBdSync(['list'], {}, () => justUnder, () => null, () => null);
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(warnings.length, 0);
    });

    test('execBdAsync unconfigured stays silent just below the threshold', async () => {
        const justUnder = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES);
        const warnings = [];
        await execBdAsync(['list'], {}, async () => ({ stdout: justUnder, stderr: '' }), (msg) => warnings.push(msg));
        assert.equal(warnings.length, 0);
    });

    test('execBdAsync configured stays silent just below the threshold', async () => {
        configureBdInvocation({ bdPath: '/opt/bd/bd' });
        const justUnder = 'x'.repeat(BD_LARGE_OUTPUT_WARN_BYTES);
        const warnings = [];
        await execBdAsync(['list'], {}, async () => ({ stdout: justUnder, stderr: '' }), (msg) => warnings.push(msg));
        assert.equal(warnings.length, 0);
    });
});
