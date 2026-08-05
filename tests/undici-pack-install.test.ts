import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNpmAvailable, packAndInstall, type PackInstallResult } from './helpers/pack-install-undici.js';

// apra-fleet-0v0.6 -- PART 2 of the apra-fleet-0v0 reopen: pins the undici
// 7.x fix (apra-fleet-0v0.1 / 0v0.5) in a NON-root, npm-installed copy of
// this package, not just the repo checkout that
// tests/undici-node20-compat.test.ts already covers. A real `npm install`
// resolving the root `overrides` block only happens for a project that has
// its OWN package-lock/overrides handling wired up correctly -- packing and
// installing into a genuinely separate consumer project is the only way to
// catch a pin that "looks locked" in the repo's own lockfile but silently
// fails to propagate once shipped.
//
// Does NOT run the end-to-end 'workflow fleet-sprint gh-toy-4ef' smoke --
// that stays with the integration-test phase per this task's acceptance
// criteria.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('npm-packed install resolves undici 7.x (apra-fleet-0v0.6 regression)', () => {
  if (!isNpmAvailable()) {
    it.skip('npm is unavailable in this environment -- skipping pack/install verification', () => {});
    return;
  }

  let result: PackInstallResult | undefined;

  afterAll(() => {
    result?.cleanup();
  });

  it(
    'installs the packed tarball into a fresh consumer project and resolves undici to 7.x with no markAsUncloneable crash',
    () => {
      result = packAndInstall(repoRoot);
      const { installedRoot, scratchDir } = result;

      expect(fs.existsSync(installedRoot), `installed package root should exist at ${installedRoot}`).toBe(true);

      const undiciPkgPath = path.join(scratchDir, 'consumer', 'node_modules', 'undici', 'package.json');
      expect(fs.existsSync(undiciPkgPath), `installed undici/package.json should exist at ${undiciPkgPath}`).toBe(true);

      const undiciPkg = JSON.parse(fs.readFileSync(undiciPkgPath, 'utf8'));
      // Guard against the pin silently not propagating: fail loudly on 8.x,
      // require an explicit 7.x resolution rather than merely "not 8.x".
      expect(undiciPkg.version.startsWith('8.'), `installed undici must not be 8.x, got ${undiciPkg.version}`).toBe(false);
      expect(undiciPkg.version).toMatch(/^7\./);

      // Import undici resolved from the INSTALLED tree (via cwd, not the repo
      // tree) and assert it does not throw the markAsUncloneable crash.
      const consumerDir = path.join(scratchDir, 'consumer');
      expect(() => {
        execFileSync(
          process.execPath,
          ['-e', "require('undici'); console.log('undici-ok')"],
          { cwd: consumerDir, encoding: 'utf8' }
        );
      }, "require('undici') from the installed tree must not throw (guards the markAsUncloneable crash)").not.toThrow();

      const output = execFileSync(
        process.execPath,
        ['-e', "require('undici'); console.log('undici-ok')"],
        { cwd: consumerDir, encoding: 'utf8' }
      );
      expect(output).toContain('undici-ok');
    },
    5 * 60 * 1000
  );
});
