// Helper for apra-fleet-0v0.6 -- verifies the undici 7.x pin (apra-fleet-0v0.1
// / 0v0.5) actually propagates into a NON-root, npm-installed copy of this
// package, not just the repo checkout that tests/undici-node20-compat.test.ts
// already covers.
//
// This helper is self-contained: it creates its own fresh temp scratch
// directory, packs the repo into it, `npm init`s a throwaway consumer
// project there, and installs the packed tarball into that project. Callers
// are responsible for invoking `cleanup()` (e.g. in a `finally` block) so the
// scratch dir never lingers.
//
// `shell: true` is required below to resolve the `npm.cmd` shim on Windows
// (plain `execFileSync('npm', ...)` throws ENOENT there); every argument
// passed to execFileSync here is either a static literal or a path derived
// from `fs.mkdtempSync`/`npm pack`'s own JSON output, never caller-controlled
// user input, so this carries no shell-injection risk. Same hazard/rationale
// as scripts/check-pack-size.mjs and tests/undici-node20-compat.test.ts.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PackInstallResult {
  /** The fresh temp scratch dir containing the throwaway consumer project. */
  scratchDir: string;
  /** scratchDir/node_modules/<packageName> -- the installed copy under test. */
  installedRoot: string;
  /** Removes the entire scratch dir (tarball + consumer project + node_modules). */
  cleanup: () => void;
}

/**
 * Returns true if `npm` is resolvable in this environment, false otherwise.
 * Callers should skip (with an explicit message) rather than silently pass
 * when this returns false -- per apra-fleet-0v0.6's acceptance criteria.
 */
export function isNpmAvailable(): boolean {
  try {
    execFileSync('npm', ['--version'], { shell: true, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * `npm pack`s `repoRoot` into a fresh temp scratch dir, then installs the
 * resulting tarball into a freshly `npm init -y`'d throwaway project inside
 * that same scratch dir -- i.e. a genuine non-root, npm-installed copy.
 *
 * Throws if `npm` is unavailable; check `isNpmAvailable()` first if you want
 * to skip instead of fail.
 */
export function packAndInstall(repoRoot: string): PackInstallResult {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-0v06-pack-install-'));

  // 1. Pack the repo straight into the scratch dir so nothing is left behind
  // in repoRoot.
  const packOutputRaw = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', scratchDir],
    { cwd: repoRoot, encoding: 'utf8', shell: true }
  );
  const packStart = packOutputRaw.indexOf('[');
  const packEnd = packOutputRaw.lastIndexOf(']');
  if (packStart === -1 || packEnd === -1 || packEnd < packStart) {
    throw new Error(`could not locate a JSON array in 'npm pack' output: ${packOutputRaw.slice(0, 200)}`);
  }
  const packResult = JSON.parse(packOutputRaw.slice(packStart, packEnd + 1));
  const tarballName: string | undefined = packResult?.[0]?.filename;
  if (!tarballName) {
    throw new Error(`'npm pack --json' output did not include a filename: ${packOutputRaw.slice(0, 200)}`);
  }
  const tarballPath = path.join(scratchDir, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`expected packed tarball at '${tarballPath}' but it does not exist`);
  }

  // 2. Create a throwaway consumer project inside a subdirectory of the
  // scratch dir (kept separate from the tarball itself for clarity).
  const consumerDir = path.join(scratchDir, 'consumer');
  fs.mkdirSync(consumerDir, { recursive: true });
  execFileSync('npm', ['init', '-y'], { cwd: consumerDir, encoding: 'utf8', shell: true });

  // 3. Install the packed tarball as a real dependency of the consumer project.
  execFileSync('npm', ['install', tarballPath], { cwd: consumerDir, encoding: 'utf8', shell: true, timeout: 5 * 60 * 1000 });

  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const packageName: string = pkgJson.name;
  const installedRoot = path.join(consumerDir, 'node_modules', ...packageName.split('/'));

  return {
    scratchDir,
    installedRoot,
    cleanup: () => {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}
