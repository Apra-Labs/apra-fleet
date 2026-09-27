import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    resolveBdInvocation,
    resolveFleetBinDir,
    execBdSync,
    execBdAsync,
    bdBinaryName,
    BD_PATH_ENV_VAR,
    FLEET_BIN_DIR_ENV_VAR,
} from '../src/supervisor/lib/exec-bd.mjs';

// apra-fleet-i9ag.13.5, supervisor half: the VENDORED copy of the bd
// invocation helper -- the one that actually ships inside
// ~/.apra-fleet/workflows/fleet-sprint and that backlog.mjs,
// scope-overlap.mjs and beads-identity.mjs call -- must find bd after a
// node-free install and must keep spawning it shell-lessly.
//
// The repo-root suite (tests/bd-release-binary-resolution.test.ts) owns the
// cross-copy drift guard; this file proves the SHIPPED copy behaves, because
// that is the copy an installed fleet runs and a vendored file that is never
// exercised on its own can rot unnoticed.
//
// `apra-fleet install` extracts the beads release binary into
// ~/.apra-fleet/bin and adds nothing to PATH, so bd must be reached by its
// absolute installed path. Nothing here downloads a real bd: the stand-in is
// a synthesised argv-echoing executable in a temp dir, and every resolution
// case runs on injected platform/env/exists deps so both win32 and POSIX are
// asserted from either host. No test mutates process.env. ASCII only.

const tmpDirs = [];
function mkTmp(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (err) {
            // Best-effort only: a leftover temp directory is OS-reclaimed and
            // must never fail an already-evaluated assertion.
            console.warn(`[bd-release-binary-resolution] cleanup left '${dir}' behind: ${err.message}`);
        }
    }
});

/**
 * Stand-in for the extracted beads release binary at `<binDir>/bd[.exe]`:
 * prints each received argv element as `ARGV:[<value>]`. On win32 a script is
 * not directly executable by CreateProcess, so the stand-in is the running
 * node binary plus an echo script passed as its first argument -- still a
 * real, shell-less argv-array spawn of a real bd.exe-shaped file.
 */
function installFakeBdBinary(binDir) {
    fs.mkdirSync(binDir, { recursive: true });
    const binaryPath = path.join(binDir, bdBinaryName(process.platform));

    if (process.platform === 'win32') {
        const echoScript = path.join(binDir, 'argv-echo.cjs');
        fs.writeFileSync(
            echoScript,
            'for (const a of process.argv.slice(2)) { process.stdout.write("ARGV:[" + a + "]\\n"); }\n',
        );
        try {
            fs.linkSync(process.execPath, binaryPath);
        } catch {
            fs.copyFileSync(process.execPath, binaryPath);
        }
        return { binaryPath, prefixArgs: [echoScript] };
    }

    fs.writeFileSync(binaryPath, '#!/bin/sh\nfor a in "$@"; do echo "ARGV:[$a]"; done\n');
    fs.chmodSync(binaryPath, 0o755);
    return { binaryPath, prefixArgs: [] };
}

function parseEchoedArgv(out) {
    return String(out)
        .split(/\r?\n/)
        .filter((l) => l.startsWith('ARGV:['))
        .map((l) => l.slice('ARGV:['.length, -1));
}

/** An env with NO bd reachable on PATH by any means. */
function envWithNoBdOnPath(extra = {}) {
    return { PATH: '', Path: '', ...extra };
}

describe('vendored exec-bd: bd resolution after a node-free install', () => {
    const cases = [
        {
            platform: 'win32',
            binName: 'bd.exe',
            homeEnv: { USERPROFILE: 'C:\\Users\\Bob' },
            installed: 'C:\\Users\\Bob\\.apra-fleet\\bin\\bd.exe',
            pathEntries: 'C:\\tools;C:\\npm',
            pathBd: 'C:\\tools\\bd.exe',
            override: 'D:\\custom\\bd.exe',
        },
        {
            platform: 'linux',
            binName: 'bd',
            homeEnv: { HOME: '/home/bob' },
            installed: '/home/bob/.apra-fleet/bin/bd',
            pathEntries: '/usr/local/bin:/usr/bin',
            pathBd: '/usr/local/bin/bd',
            override: '/opt/beads/bd',
        },
    ];

    for (const c of cases) {
        test(`${c.platform}: order is override -> fleet bin -> PATH -> npm shim -> bare bd`, () => {
            const shim = 'C:\\npm\\node_modules\\@beads\\bd\\bin\\bd.js';
            const base = {
                platform: c.platform,
                env: { ...c.homeEnv, PATH: c.pathEntries },
                execPath: '/fake/node',
                resolveWindowsBd: () => (c.platform === 'win32' ? shim : null),
            };

            // 1. explicit override
            assert.deepStrictEqual(
                resolveBdInvocation({
                    ...base,
                    env: { ...base.env, [BD_PATH_ENV_VAR]: c.override },
                    existsFn: () => true,
                }),
                { source: 'env', command: c.override, prefixArgs: [], shell: false },
            );

            // 2. the installed release binary, even with a bd on PATH
            assert.deepStrictEqual(
                resolveBdInvocation({ ...base, existsFn: (p) => p === c.installed || p === c.pathBd }),
                { source: 'fleet-bin', command: c.installed, prefixArgs: [], shell: false },
            );

            // 3. a bd on PATH when nothing is installed
            assert.deepStrictEqual(
                resolveBdInvocation({ ...base, existsFn: (p) => p === c.pathBd }),
                { source: 'path', command: c.binName, prefixArgs: [], shell: false },
            );

            // 4. a developer's npm-installed bd (win32 shim) still works
            const noneOnDisk = resolveBdInvocation({ ...base, existsFn: () => false });
            if (c.platform === 'win32') {
                assert.deepStrictEqual(noneOnDisk, {
                    source: 'npm-shim', command: '/fake/node', prefixArgs: [shim], shell: false,
                });
            } else {
                // 5. POSIX with nothing anywhere: bare bd, and NO shell.
                assert.deepStrictEqual(noneOnDisk, {
                    source: 'fallback', command: 'bd', prefixArgs: [], shell: false,
                });
            }

            // 5. win32 with not even a shim: the legacy fallback, shell and all
            const nothingAtAll = resolveBdInvocation({
                ...base, existsFn: () => false, resolveWindowsBd: () => null,
            });
            assert.deepStrictEqual(nothingAtAll, {
                source: 'fallback', command: 'bd', prefixArgs: [], shell: c.platform === 'win32',
            });
        });

        test(`${c.platform}: APRA_FLEET_BD_PATH pointing at nothing fails loudly`, () => {
            assert.throws(
                () => resolveBdInvocation({
                    platform: c.platform,
                    env: { ...c.homeEnv, PATH: c.pathEntries, [BD_PATH_ENV_VAR]: c.override },
                    existsFn: (p) => p === c.installed,
                }),
                new RegExp(BD_PATH_ENV_VAR),
            );
        });
    }

    test('the fleet bin dir defaults to <home>/.apra-fleet/bin and is overridable', () => {
        assert.strictEqual(
            resolveFleetBinDir({ platform: 'linux', env: { HOME: '/home/bob' } }),
            '/home/bob/.apra-fleet/bin',
        );
        assert.strictEqual(
            resolveFleetBinDir({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\Bob' } }),
            'C:\\Users\\Bob\\.apra-fleet\\bin',
        );
        assert.strictEqual(
            resolveFleetBinDir({ platform: 'linux', env: { HOME: '/home/bob', [FLEET_BIN_DIR_ENV_VAR]: '/opt/fleet/bin' } }),
            '/opt/fleet/bin',
        );
    });

    test('with no bd on PATH, execBdSync resolves the installed binary and really spawns it', () => {
        const binDir = path.join(mkTmp('se-bd-release-sync-'), 'bin');
        const { binaryPath, prefixArgs } = installFakeBdBinary(binDir);
        const env = envWithNoBdOnPath({ [FLEET_BIN_DIR_ENV_VAR]: binDir });

        assert.deepStrictEqual(resolveBdInvocation({ env }), {
            source: 'fleet-bin', command: binaryPath, prefixArgs: [], shell: false,
        });

        const out = execBdSync([...prefixArgs, 'version'], { encoding: 'utf-8' }, undefined, undefined, { env });
        assert.deepStrictEqual(parseEchoedArgv(out), [...prefixArgs, 'version']);
    });

    test('with no bd on PATH, execBdAsync (the supervisor call path) resolves and spawns it too', async () => {
        const binDir = path.join(mkTmp('se-bd-release-async-'), 'bin');
        const { prefixArgs } = installFakeBdBinary(binDir);
        const env = envWithNoBdOnPath({ [FLEET_BIN_DIR_ENV_VAR]: binDir });

        const res = await execBdAsync(
            [...prefixArgs, 'version'], { encoding: 'utf-8' }, undefined, undefined, { env },
        );
        assert.deepStrictEqual(parseEchoedArgv(res.stdout), [...prefixArgs, 'version']);
    });
});

describe('vendored exec-bd: the shell-less invariant survives the release-binary switch', () => {
    // Before apra-fleet-i9ag.13.4 the vendored execBdAsync forced shell: true
    // on EVERY call, and execBdSync fell through to { shell: true } on win32
    // as soon as no npm bd.cmd existed -- which is precisely the state a
    // release-binary install leaves Windows in.
    for (const platform of ['win32', 'linux']) {
        const installed = platform === 'win32'
            ? 'C:\\Users\\Bob\\.apra-fleet\\bin\\bd.exe'
            : '/home/bob/.apra-fleet/bin/bd';
        const homeEnv = platform === 'win32' ? { USERPROFILE: 'C:\\Users\\Bob' } : { HOME: '/home/bob' };
        const resolveDeps = {
            platform,
            env: envWithNoBdOnPath(homeEnv),
            existsFn: (p) => p === installed,
            resolveWindowsBd: () => null,
        };

        test(`${platform}: execBdAsync spawns the installed binary argv-array and shell-less`, async () => {
            const calls = [];
            const fakeExecFileAsync = async (cmd, args, opts) => {
                calls.push({ cmd, args, opts });
                return { stdout: '', stderr: '' };
            };

            await execBdAsync(
                ['list', '--all', '--limit', '0', '--json'],
                // A caller asking for a shell must not be able to get one back.
                { shell: true },
                fakeExecFileAsync,
                () => {},
                resolveDeps,
            );

            assert.strictEqual(calls[0].cmd, installed);
            assert.deepStrictEqual(calls[0].args, ['list', '--all', '--limit', '0', '--json']);
            assert.strictEqual(calls[0].opts.shell, false);
        });

        test(`${platform}: execBdSync spawns the installed binary shell-less`, () => {
            const calls = [];
            const fakeExecFileSync = (cmd, args, opts) => {
                calls.push({ cmd, args, opts });
                return '';
            };

            execBdSync(['list', '--parent', 'a & echo INJECTED'], { shell: true }, fakeExecFileSync, () => null, resolveDeps);

            assert.strictEqual(calls[0].cmd, installed);
            assert.strictEqual(calls[0].opts.shell, false);
            // One opaque argv element, not a concatenated command line.
            assert.deepStrictEqual(calls[0].args, ['list', '--parent', 'a & echo INJECTED']);
        });
    }

    test('a metacharacter-bearing argument reaches the real child as ONE unmodified argv entry', () => {
        const fleetHome = mkTmp('se-bd-release-injection-');
        const binDir = path.join(fleetHome, 'bin');
        const { prefixArgs } = installFakeBdBinary(binDir);
        const env = envWithNoBdOnPath({ [FLEET_BIN_DIR_ENV_VAR]: binDir });

        const marker = path.join(fleetHome, 'INJECTED-MARKER');
        const evil = `a & echo INJECTED; $(touch ${marker}) \`touch ${marker}\` | cat`;

        const out = execBdSync(
            [...prefixArgs, 'list', '--parent', evil, '--json'],
            { encoding: 'utf-8' }, undefined, undefined, { env },
        );

        assert.deepStrictEqual(parseEchoedArgv(out), [...prefixArgs, 'list', '--parent', evil, '--json']);
        assert.strictEqual(fs.existsSync(marker), false, 'a shell interpreted the argument and ran the injected command');
    });

    test('execBdAsync keeps rejecting unsafe args outright, whichever source resolved', () => {
        const env = envWithNoBdOnPath({ [FLEET_BIN_DIR_ENV_VAR]: '/nowhere' });
        for (const unsafe of ['a; rm -rf /', 'a & b', '$(touch pwned)', '`touch pwned`']) {
            assert.throws(
                () => execBdAsync(['list', '--parent', unsafe], {}, async () => ({ stdout: '', stderr: '' }), () => {}, { env }),
                TypeError,
            );
        }
    });
});
