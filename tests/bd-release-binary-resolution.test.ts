import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveBdInvocation,
  resolveFleetBinDir,
  execBdSync,
  execBdAsync,
  bdBinaryName,
  BD_PATH_ENV_VAR,
  FLEET_BIN_DIR_ENV_VAR,
} from '../scripts/lib/exec-bd.mjs';
import * as vendoredExecBd from '../packages/apra-fleet-se/src/supervisor/lib/exec-bd.mjs';

// apra-fleet-i9ag.13.5: bd is invocable after a NODE-FREE install, and the
// shell-less invocation invariant survives the switch from npm's Windows shim
// to a real release binary (bug apra-fleet-i9ag.13).
//
// Why this file exists next to tests/exec-bd.test.ts and
// tests/2cc-win-bd-invocation-integ.test.ts rather than inside them: those two
// pin the npm-shim-era behaviour (apra-fleet-2cc.1) and must keep passing
// untouched. This one pins what changed -- `apra-fleet install` now extracts
// the beads RELEASE BINARY into ~/.apra-fleet/bin and deliberately adds
// nothing to PATH and edits no shell profile, so:
//   1. the helpers must find bd by its ABSOLUTE installed path with no bd on
//      PATH anywhere, and
//   2. they must keep spawning it argv-array and SHELL-LESS. On Windows the
//      release binary means there is no npm `bd.cmd` at all, so the pre-fix
//      code's `{ shell: true }` fallback -- the module's one documented
//      injection surface, reached with caller-controlled `--prefix` and
//      `--remote` values -- would silently have become the NORMAL path.
//
// Nothing here downloads a real bd: the "installed binary" is a synthesised
// argv-echoing executable in a temp directory, and every resolution case runs
// on injected platform/env/exists deps so both win32 and POSIX orders are
// asserted from whichever host runs the suite. No test mutates process.env or
// touches the real ~/.apra-fleet. ASCII only.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_COPY = path.join(HERE, '..', 'scripts', 'lib', 'exec-bd.mjs');
const VENDORED_COPY = path.join(
  HERE, '..', 'packages', 'apra-fleet-se', 'src', 'supervisor', 'lib', 'exec-bd.mjs',
);

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      // Best-effort: a leftover directory under os.tmpdir() is OS-reclaimed
      // and must never fail an already-evaluated assertion (same policy as
      // tests/2cc-win-bd-invocation-integ.test.ts).
      // eslint-disable-next-line no-console
      console.warn(`[bd-release-binary-resolution] cleanup left '${dir}' behind: ${(err as Error).message}`);
    }
  }
});

/**
 * Synthesises a stand-in for the extracted beads release binary at
 * `<binDir>/bd[.exe]`: an executable that prints every argv element it
 * received as `ARGV:[<value>]`, one per line, so argv fidelity is observable
 * from the outside.
 *
 * On POSIX that is a two-line shell script. On Windows a script is not
 * directly executable by CreateProcess (exactly the problem the npm shim
 * existed to work around), so the stand-in is a copy of the running node
 * binary plus an echo script handed to it as the first argument -- which is
 * still a real, shell-less argv-array spawn of a real bd.exe-shaped file.
 *
 * Returns the args that must be prepended to the caller's own argv.
 */
function installFakeBdBinary(binDir: string): { binaryPath: string; prefixArgs: string[] } {
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

  fs.writeFileSync(
    binaryPath,
    '#!/bin/sh\nfor a in "$@"; do echo "ARGV:[$a]"; done\n',
  );
  fs.chmodSync(binaryPath, 0o755);
  return { binaryPath, prefixArgs: [] };
}

/** Parses the fake binary's `ARGV:[...]` output back into an argv array. */
function parseEchoedArgv(out: string): string[] {
  return String(out)
    .split(/\r?\n/)
    .filter((l) => l.startsWith('ARGV:['))
    .map((l) => l.slice('ARGV:['.length, -1));
}

/** An env with NO bd reachable on PATH by any means. */
function envWithNoBdOnPath(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: '', Path: '', ...extra };
}

// ---------------------------------------------------------------------------
// 1. Resolution order, asserted for BOTH win32 and POSIX
// ---------------------------------------------------------------------------

describe('resolveBdInvocation: resolution order on win32 and POSIX', () => {
  const cases = [
    {
      platform: 'win32' as const,
      binName: 'bd.exe',
      homeEnv: { USERPROFILE: 'C:\\Users\\Bob' },
      installed: 'C:\\Users\\Bob\\.apra-fleet\\bin\\bd.exe',
      pathEntries: 'C:\\tools;C:\\Users\\Bob\\AppData\\Roaming\\npm',
      pathBd: 'C:\\tools\\bd.exe',
      override: 'D:\\custom\\bd.exe',
    },
    {
      platform: 'linux' as const,
      binName: 'bd',
      homeEnv: { HOME: '/home/bob' },
      installed: '/home/bob/.apra-fleet/bin/bd',
      pathEntries: '/usr/local/bin:/usr/bin',
      pathBd: '/usr/local/bin/bd',
      override: '/opt/beads/bd',
    },
  ];

  for (const c of cases) {
    describe(c.platform, () => {
      it('1st: an explicit APRA_FLEET_BD_PATH override wins over the installed binary and over PATH', () => {
        const inv = resolveBdInvocation({
          platform: c.platform,
          env: { ...c.homeEnv, PATH: c.pathEntries, [BD_PATH_ENV_VAR]: c.override },
          existsFn: (p: string) => p === c.override || p === c.installed || p === c.pathBd,
          resolveWindowsBd: () => 'C:\\npm\\bd.js',
        });
        expect(inv.source).toBe('env');
        expect(inv.command).toBe(c.override);
        expect(inv.prefixArgs).toEqual([]);
        expect(inv.shell).toBe(false);
      });

      it('an APRA_FLEET_BD_PATH pointing at nothing fails loudly instead of silently resolving something else', () => {
        expect(() => resolveBdInvocation({
          platform: c.platform,
          env: { ...c.homeEnv, PATH: c.pathEntries, [BD_PATH_ENV_VAR]: c.override },
          // The override is absent, but the installed binary and a PATH bd
          // both exist -- a silent fall-through would run a DIFFERENT bd than
          // the operator asked for.
          existsFn: (p: string) => p === c.installed || p === c.pathBd,
        })).toThrow(new RegExp(BD_PATH_ENV_VAR));
      });

      it('2nd: the installed fleet-bin binary wins over a bd on PATH and over the npm shim', () => {
        const inv = resolveBdInvocation({
          platform: c.platform,
          env: { ...c.homeEnv, PATH: c.pathEntries },
          existsFn: (p: string) => p === c.installed || p === c.pathBd,
          resolveWindowsBd: () => 'C:\\npm\\bd.js',
        });
        expect(inv.source).toBe('fleet-bin');
        expect(inv.command).toBe(c.installed);
        expect(inv.shell).toBe(false);
      });

      it('2nd: APRA_FLEET_BIN_DIR relocates where the installed binary is looked for', () => {
        const binDir = c.platform === 'win32' ? 'E:\\fleet\\bin' : '/opt/fleet/bin';
        const relocated = c.platform === 'win32' ? 'E:\\fleet\\bin\\bd.exe' : '/opt/fleet/bin/bd';
        expect(resolveFleetBinDir({
          platform: c.platform,
          env: { ...c.homeEnv, [FLEET_BIN_DIR_ENV_VAR]: binDir },
        })).toBe(binDir);
        const inv = resolveBdInvocation({
          platform: c.platform,
          env: { ...c.homeEnv, PATH: c.pathEntries, [FLEET_BIN_DIR_ENV_VAR]: binDir },
          existsFn: (p: string) => p === relocated,
        });
        expect(inv.source).toBe('fleet-bin');
        expect(inv.command).toBe(relocated);
      });

      it('3rd: a bd on PATH is used when nothing is installed under the fleet bin dir', () => {
        const inv = resolveBdInvocation({
          platform: c.platform,
          env: { ...c.homeEnv, PATH: c.pathEntries },
          existsFn: (p: string) => p === c.pathBd,
          resolveWindowsBd: () => 'C:\\npm\\bd.js',
        });
        expect(inv.source).toBe('path');
        // The bare basename, so execFile does its own PATH lookup -- the
        // pre-existing POSIX behaviour, unchanged.
        expect(inv.command).toBe(c.binName);
        expect(inv.shell).toBe(false);
      });

      it('4th: a developer\'s existing npm-installed bd still works (the npm-shim path is preserved, not deleted)', () => {
        const shimScript = 'C:\\Users\\Bob\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.js';
        const inv = resolveBdInvocation({
          platform: c.platform,
          env: { ...c.homeEnv, PATH: c.pathEntries },
          existsFn: () => false,
          // resolveWindowsBdScript itself returns null off win32; model that
          // faithfully so the POSIX case really does fall through to step 5.
          resolveWindowsBd: () => (c.platform === 'win32' ? shimScript : null),
          execPath: '/fake/node',
        });
        if (c.platform === 'win32') {
          expect(inv.source).toBe('npm-shim');
          expect(inv.command).toBe('/fake/node');
          expect(inv.prefixArgs).toEqual([shimScript]);
          expect(inv.shell).toBe(false);
        } else {
          expect(inv.source).toBe('fallback');
        }
      });

      it('5th: with nothing resolvable at all, falls back to bare bd (shell only on win32)', () => {
        const inv = resolveBdInvocation({
          platform: c.platform,
          env: envWithNoBdOnPath(c.homeEnv),
          existsFn: () => false,
          resolveWindowsBd: () => null,
        });
        expect(inv.source).toBe('fallback');
        expect(inv.command).toBe('bd');
        expect(inv.shell).toBe(c.platform === 'win32');
      });

      it('the real npm bd.cmd shim on PATH is NOT mistaken for a directly-executable bd', () => {
        // On win32, step 3 looks for bd.exe only: npm installs bd.cmd (plus an
        // extensionless POSIX shim), neither of which CreateProcess can exec.
        const inv = resolveBdInvocation({
          platform: c.platform,
          env: { ...c.homeEnv, PATH: c.pathEntries },
          existsFn: (p: string) => p.endsWith('bd.cmd'),
          resolveWindowsBd: () => null,
        });
        expect(inv.source).toBe('fallback');
      });
    });
  }

  it('defaults the fleet bin dir to <home>/.apra-fleet/bin -- the BIN_DIR the installer extracts bd into', () => {
    expect(resolveFleetBinDir({ platform: 'linux', env: { HOME: '/home/bob' } }))
      .toBe('/home/bob/.apra-fleet/bin');
    expect(resolveFleetBinDir({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\Bob' } }))
      .toBe('C:\\Users\\Bob\\.apra-fleet\\bin');
  });
});

// ---------------------------------------------------------------------------
// 2. No bd on PATH at all: the installed binary is found AND actually spawned
// ---------------------------------------------------------------------------

describe('a node-free install: no bd on PATH, a real binary at the fleet bin path', () => {
  it('execBdSync resolves the installed binary by absolute path and really spawns it', () => {
    const fleetHome = mkTmp('bd-release-sync-');
    const binDir = path.join(fleetHome, 'bin');
    const { binaryPath, prefixArgs } = installFakeBdBinary(binDir);

    const out = String(execBdSync(
      [...prefixArgs, 'version'],
      { encoding: 'utf-8' },
      undefined,
      undefined,
      // PATH is empty: there is no bd to find anywhere except the installed one.
      { env: envWithNoBdOnPath({ [FLEET_BIN_DIR_ENV_VAR]: binDir }) },
    ));

    expect(parseEchoedArgv(out)).toEqual([...prefixArgs, 'version']);
    expect(resolveBdInvocation({
      env: envWithNoBdOnPath({ [FLEET_BIN_DIR_ENV_VAR]: binDir }),
    })).toMatchObject({ source: 'fleet-bin', command: binaryPath, shell: false });
  });

  it('execBdAsync resolves and spawns the same installed binary, with no bd on PATH', async () => {
    const fleetHome = mkTmp('bd-release-async-');
    const binDir = path.join(fleetHome, 'bin');
    const { prefixArgs } = installFakeBdBinary(binDir);

    const res = await execBdAsync(
      [...prefixArgs, 'version'],
      { encoding: 'utf-8' },
      undefined,
      undefined,
      { env: envWithNoBdOnPath({ [FLEET_BIN_DIR_ENV_VAR]: binDir }) },
    );

    expect(parseEchoedArgv(String(res.stdout))).toEqual([...prefixArgs, 'version']);
  });

  it('finds it via the default <home>/.apra-fleet/bin too, with no APRA_FLEET_BIN_DIR set', () => {
    const fakeHome = mkTmp('bd-release-home-');
    const binDir = path.join(fakeHome, '.apra-fleet', 'bin');
    const { binaryPath, prefixArgs } = installFakeBdBinary(binDir);
    const homeEnv = process.platform === 'win32' ? { USERPROFILE: fakeHome } : { HOME: fakeHome };

    const inv = resolveBdInvocation({ env: envWithNoBdOnPath(homeEnv) });
    expect(inv).toMatchObject({ source: 'fleet-bin', command: binaryPath });

    const out = String(execBdSync(
      [...prefixArgs, 'version'],
      { encoding: 'utf-8' },
      undefined,
      undefined,
      { env: envWithNoBdOnPath(homeEnv) },
    ));
    expect(parseEchoedArgv(out)).toEqual([...prefixArgs, 'version']);
  });
});

// ---------------------------------------------------------------------------
// 3. SECURITY REGRESSION GUARD: the real-binary path is shell-less, always
// ---------------------------------------------------------------------------

describe('security: the release-binary path never takes the shell fallback', () => {
  // The shape of the regression this guards: with bd installed as a release
  // binary there is no npm bd.cmd, so resolveWindowsBdScript() returns null.
  // Before apra-fleet-i9ag.13.4 that meant every Windows invocation fell
  // through to `{ shell: true }` with caller-controlled values -- turning the
  // module's one documented injection surface into the default code path.
  const platforms = ['win32', 'linux'] as const;

  for (const platform of platforms) {
    it(`${platform}: execBdSync spawns the installed binary argv-array and shell-less`, () => {
      const installed = platform === 'win32'
        ? 'C:\\Users\\Bob\\.apra-fleet\\bin\\bd.exe'
        : '/home/bob/.apra-fleet/bin/bd';
      const homeEnv = platform === 'win32' ? { USERPROFILE: 'C:\\Users\\Bob' } : { HOME: '/home/bob' };
      const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
      const fakeExecFileSync = (cmd: string, args: string[], opts: Record<string, unknown>) => {
        calls.push({ cmd, args, opts });
        return '';
      };

      execBdSync(
        ['list', '--parent', 'a & echo INJECTED'],
        // Even a caller explicitly asking for a shell must not get one.
        { shell: true } as never,
        fakeExecFileSync as never,
        () => null,
        { platform, env: envWithNoBdOnPath(homeEnv), existsFn: (p: string) => p === installed },
      );

      expect(calls[0].cmd).toBe(installed);
      expect(calls[0].opts.shell).toBe(false);
    });

    it(`${platform}: execBdAsync spawns the installed binary shell-less too`, async () => {
      const installed = platform === 'win32'
        ? 'C:\\Users\\Bob\\.apra-fleet\\bin\\bd.exe'
        : '/home/bob/.apra-fleet/bin/bd';
      const homeEnv = platform === 'win32' ? { USERPROFILE: 'C:\\Users\\Bob' } : { HOME: '/home/bob' };
      const calls: Array<{ cmd: string; opts: Record<string, unknown> }> = [];
      const fakeExecFileAsync = async (cmd: string, _args: string[], opts: Record<string, unknown>) => {
        calls.push({ cmd, opts });
        return { stdout: '', stderr: '' };
      };

      await execBdAsync(
        ['list', '--json'],
        { shell: true } as never,
        fakeExecFileAsync as never,
        undefined,
        { platform, env: envWithNoBdOnPath(homeEnv), existsFn: (p: string) => p === installed },
      );

      expect(calls[0].cmd).toBe(installed);
      expect(calls[0].opts.shell).toBe(false);
    });
  }

  it('a metacharacter-bearing argument arrives at the real child as ONE unmodified argv entry', () => {
    const fleetHome = mkTmp('bd-release-injection-');
    const binDir = path.join(fleetHome, 'bin');
    const { prefixArgs } = installFakeBdBinary(binDir);

    // Ampersand, semicolon, command substitution and backticks in one value.
    // If any shell ever saw this command line, the argv echo would be split
    // across entries and the marker file below would exist.
    const marker = path.join(fleetHome, 'INJECTED-MARKER');
    const evil = `a & echo INJECTED; $(touch ${marker}) \`touch ${marker}\` | cat`;

    const out = String(execBdSync(
      [...prefixArgs, 'list', '--parent', evil, '--json'],
      { encoding: 'utf-8' },
      undefined,
      undefined,
      { env: envWithNoBdOnPath({ [FLEET_BIN_DIR_ENV_VAR]: binDir }) },
    ));

    expect(parseEchoedArgv(out)).toEqual([...prefixArgs, 'list', '--parent', evil, '--json']);
    expect(fs.existsSync(marker)).toBe(false);
    expect(out).not.toMatch(/^INJECTED$/m);
  });
});

// ---------------------------------------------------------------------------
// 4. Drift guard: the two copies cannot diverge silently
// ---------------------------------------------------------------------------

describe('drift guard: scripts/lib/exec-bd.mjs and the vendored supervisor copy', () => {
  it('expose the same function names', async () => {
    const canonical = await import('../scripts/lib/exec-bd.mjs');
    const canonicalNames = Object.keys(canonical).sort();
    const vendoredNames = Object.keys(vendoredExecBd).sort();
    expect(vendoredNames).toEqual(canonicalNames);
    // Guard the guard: a rename on both sides at once must still keep the
    // names this bug's fix introduced.
    expect(canonicalNames).toEqual(expect.arrayContaining([
      'resolveBdInvocation', 'resolveFleetBinDir', 'bdBinaryName',
      'resolveWindowsBdScript', 'execBdSync', 'execBdAsync',
      'BD_PATH_ENV_VAR', 'FLEET_BIN_DIR_ENV_VAR',
    ]));
  });

  it('agree on the resolution order, case for case', () => {
    const scenarios: Array<Parameters<typeof resolveBdInvocation>[0]> = [
      // override wins
      {
        platform: 'win32',
        env: { USERPROFILE: 'C:\\Users\\Bob', PATH: 'C:\\tools', [BD_PATH_ENV_VAR]: 'D:\\bd.exe' },
        existsFn: () => true,
        resolveWindowsBd: () => 'C:\\npm\\bd.js',
        execPath: '/fake/node',
      },
      // installed binary wins over PATH
      {
        platform: 'win32',
        env: { USERPROFILE: 'C:\\Users\\Bob', PATH: 'C:\\tools' },
        existsFn: (p: string) => p === 'C:\\Users\\Bob\\.apra-fleet\\bin\\bd.exe' || p === 'C:\\tools\\bd.exe',
        resolveWindowsBd: () => 'C:\\npm\\bd.js',
        execPath: '/fake/node',
      },
      // PATH wins over the npm shim
      {
        platform: 'linux',
        env: { HOME: '/home/bob', PATH: '/usr/bin' },
        existsFn: (p: string) => p === '/usr/bin/bd',
        resolveWindowsBd: () => null,
        execPath: '/fake/node',
      },
      // npm shim
      {
        platform: 'win32',
        env: { USERPROFILE: 'C:\\Users\\Bob', PATH: 'C:\\npm' },
        existsFn: () => false,
        resolveWindowsBd: () => 'C:\\npm\\bd.js',
        execPath: '/fake/node',
      },
      // nothing at all
      {
        platform: 'linux',
        env: { HOME: '/home/bob', PATH: '' },
        existsFn: () => false,
        resolveWindowsBd: () => null,
        execPath: '/fake/node',
      },
    ];

    for (const scenario of scenarios) {
      expect(vendoredExecBd.resolveBdInvocation(scenario)).toEqual(resolveBdInvocation(scenario));
    }
  });

  it('are byte-identical apart from the vendored-copy note', () => {
    // apra-fleet-n4lu.1 vendored scripts/lib/exec-bd.mjs into the shipped
    // supervisor tree and asked for hand-syncing; apra-fleet-i9ag.13 then had
    // to fix the SAME bug in both. This makes "fixed one, forgot the other"
    // a red test instead of a silent Windows-only regression.
    const canonical = fs.readFileSync(CANONICAL_COPY, 'utf-8').split('\n');
    const vendored = fs.readFileSync(VENDORED_COPY, 'utf-8').split('\n');

    const noteStart = vendored.findIndex((l) => l.startsWith('// VENDORED COPY'));
    expect(noteStart, 'the vendored copy no longer carries its VENDORED COPY note').toBeGreaterThan(-1);
    let noteEnd = noteStart;
    while (noteEnd < vendored.length && vendored[noteEnd] !== '//') noteEnd += 1;
    const vendoredWithoutNote = [...vendored.slice(0, noteStart), ...vendored.slice(noteEnd + 1)];

    expect(
      vendoredWithoutNote.join('\n'),
      'scripts/lib/exec-bd.mjs and packages/apra-fleet-se/src/supervisor/lib/exec-bd.mjs have drifted. '
        + 'Re-sync the vendored copy: it must be the canonical file with only the VENDORED COPY note added.',
    ).toBe(canonical.join('\n'));
  });
});
