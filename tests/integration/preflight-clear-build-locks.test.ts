/**
 * apra-fleet-i8qj.14: verifies the widened out-of-tree detection landed by
 * apra-fleet-i8qj.9 in scripts/preflight-clear-build-locks.mjs.
 *
 * Real-world case being reproduced: a native addon under a package's
 * node_modules (e.g. node_modules/@rollup/*.node) gets mapped into the
 * address space of an OUT-OF-TREE process (e.g. the system node.exe under
 * "Program Files", not the repo checkout). The pre-fix detector only ever
 * matched a holder whose OWN Win32_Process.ExecutablePath lived inside the
 * target directory, so this class of holder was invisible to it and `npm ci`
 * failed with a silent EPERM unlink. apra-fleet-i8qj.9 added a "modules"
 * enumeration pass (every accessible process's loaded-module list) that
 * finds this case; assertion 2 below would FAIL against the pre-fix
 * exe-path-only matcher because it never inspects loaded modules at all.
 *
 * Win32-only: this whole file is skipped on non-Windows CI matrix legs.
 * Live-PowerShell harness note: apra-fleet-ot2z.15.1 (the shared live-
 * PowerShell harness for tests/windows-powershell-error-handling.test.ts)
 * is still open/unimplemented as of this writing -- there is nothing to
 * reuse from it yet, so this file spawns and probes real Windows processes
 * directly rather than inventing a second copy of that not-yet-existing
 * harness.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = path.join(repoRoot, 'scripts', 'preflight-clear-build-locks.mjs');

// The exact real-world artifact class the script's own comments call out:
// a native addon under this repo's own node_modules. Copying it into an
// isolated fixture and require()-ing it from an out-of-tree node.exe child
// mimics a genuinely mapped image, not just an open file descriptor --
// required for probeLockedFiles()'s r+ open to actually fail (Windows maps
// executable images with a deny-write share mode; a plain fs.open with
// default sharing would NOT reproduce that).
const NATIVE_ADDON_SRC = path.join(
  repoRoot,
  'node_modules', '@rollup', 'rollup-win32-x64-msvc', 'rollup.win32-x64-msvc.node',
);

const isWin32 = process.platform === 'win32';
const hasNativeAddon = isWin32 && fs.existsSync(NATIVE_ADDON_SRC);

interface RunResult {
  code: number;
  stdout: string;
}

function runPreflight(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 40_000,
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe.runIf(isWin32)('preflight-clear-build-locks.mjs: out-of-tree holder detection (apra-fleet-i8qj.14)', () => {
  const spawned: ChildProcess[] = [];
  const fixtureDirs: string[] = [];

  function makeFixtureDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fixtureDirs.push(dir);
    return dir;
  }

  function trackSpawned(child: ChildProcess): ChildProcess {
    spawned.push(child);
    return child;
  }

  // Unconditional teardown, even on assertion failure: kill every spawned
  // holder process and remove every fixture dir.
  afterEach(() => {
    for (const child of spawned.splice(0)) {
      if (child.pid) {
        try {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        } catch {
          // already dead -- fine
        }
      }
    }
    for (const dir of fixtureDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('clean fixture with no holder exits 0', () => {
    const dir = makeFixtureDir('preflight-clean-');
    // A candidate-extension file present but never opened by anyone else.
    fs.writeFileSync(path.join(dir, 'idle.node'), 'not a real addon, never locked');

    const { code, stdout } = runPreflight(['--dir', dir, '--report-only']);

    expect(code).toBe(0);
    expect(stdout).toContain('no locked files found');
  }, 40_000);

  (hasNativeAddon ? it : it.skip)(
    'names the out-of-tree node.exe holder by PID + image name + locked file path, and stays non-zero (unclearable under --report-only)',
    async () => {
      const dir = makeFixtureDir('preflight-holder-');
      const pkgDir = path.join(dir, 'some-pkg');
      fs.mkdirSync(pkgDir);
      const addonPath = path.join(pkgDir, 'fake.node');
      fs.copyFileSync(NATIVE_ADDON_SRC, addonPath);

      // Out-of-tree node.exe (process.execPath, e.g. under "Program Files",
      // NOT under the fixture dir) requires() the copied addon so the OS
      // actually maps it as a loaded module, then stays alive so the
      // enumeration below can see it.
      const holder = trackSpawned(
        spawn(
          process.execPath,
          ['-e', `require(${JSON.stringify(addonPath)}); setInterval(() => {}, 60000);`],
          { stdio: 'ignore' },
        ),
      );
      expect(holder.pid, 'holder process should have spawned with a PID').toBeTruthy();

      // Give the module load a moment to land before probing.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // --report-only: never kill, so the "unclearable" (locks still held
      // after the run) case is deterministic and this test never
      // taskkills its own fixture process via the script under test.
      const { code, stdout } = runPreflight(['--dir', dir, '--report-only']);

      // Assertion 3: unclearable case is non-zero.
      expect(code).not.toBe(0);
      // Assertion 2: holder is named -- PID, image name, and locked file path
      // all present in the output. This is exactly what the pre-fix
      // own-executable-path-only matcher could never produce for an
      // out-of-tree holder: node.exe's own ExecutablePath lives under
      // "Program Files", not under `dir`, so only the widened "modules"
      // enumeration pass (apra-fleet-i8qj.9) can attribute it.
      expect(stdout).toContain(String(holder.pid));
      expect(stdout.toLowerCase()).toContain('node.exe');
      expect(stdout).toContain(addonPath);
    },
    40_000,
  );

  it('holder-unknown path fails loudly with the locked file path and attempted enumeration methods', async () => {
    const dir = makeFixtureDir('preflight-unknown-');
    const lockedPath = path.join(dir, 'mystery.dll');
    fs.writeFileSync(lockedPath, 'placeholder');

    // Exclusive OS-level lock (FileShare.None) held by powershell.exe: this
    // is a plain file handle, not a loaded module and not the holder's own
    // executable path, so NEITHER enumeration method (exe-path or modules)
    // can attribute it -- exactly the "holder unknown" path.
    const psSafePath = lockedPath.replace(/'/g, "''");
    const psScript = [
      `$fs = [System.IO.File]::Open('${psSafePath}', 'Open', 'ReadWrite', 'None')`,
      'Start-Sleep -Seconds 300',
    ].join('; ');
    const holder = trackSpawned(
      spawn('powershell', ['-NoProfile', '-Command', psScript], { stdio: 'ignore' }),
    );
    expect(holder.pid, 'holder process should have spawned with a PID').toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const { code, stdout } = runPreflight(['--dir', dir, '--report-only']);

    // Exit code 2 is the script's dedicated "holder unknown" code.
    expect(code).toBe(2);
    expect(stdout).toContain('holder unknown');
    expect(stdout).toContain(lockedPath);
    // Names at least one attempted enumeration method so failure is loud,
    // not silent.
    expect(stdout).toMatch(/probe/i);
  }, 40_000);

  (hasNativeAddon ? it : it.skip)(
    'enumeration returns within its documented timeout',
    async () => {
      const dir = makeFixtureDir('preflight-timing-');
      const pkgDir = path.join(dir, 'some-pkg');
      fs.mkdirSync(pkgDir);
      const addonPath = path.join(pkgDir, 'fake.node');
      fs.copyFileSync(NATIVE_ADDON_SRC, addonPath);

      const holder = trackSpawned(
        spawn(
          process.execPath,
          ['-e', `require(${JSON.stringify(addonPath)}); setInterval(() => {}, 60000);`],
          { stdio: 'ignore' },
        ),
      );
      expect(holder.pid).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Documented worst case per the script's own header comment: PROBE
      // (10s) + ENUM (20s) + a bounded post-kill retry backoff, "~45s far
      // under any deploy budget". --report-only never enters the retry
      // path at all, so this run should be well inside PROBE+ENUM (~30s);
      // assert a generous 35s ceiling to absorb CI jitter without loosening
      // the check to the point of being meaningless.
      const start = Date.now();
      const { code } = runPreflight(['--dir', dir, '--report-only']);
      const elapsedMs = Date.now() - start;

      expect(code).not.toBe(0);
      expect(elapsedMs, `enumeration took ${elapsedMs}ms, expected well under the documented bound`).toBeLessThan(35_000);
    },
    45_000,
  );
});
