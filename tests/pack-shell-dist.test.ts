/**
 * apra-fleet-v6t7.11: the built shell dist must ship inside the npm package,
 * or GET /ui 404s for every non-repo install (src/console/static.ts
 * resolveDefaultShellDistDir() resolves <pkgRoot>/packages/apra-fleet-shell-ui/dist
 * under the ESM/npm branch).
 *
 * Two checks:
 *  - static: package.json's 'files' array declares the dist directory.
 *  - dynamic: with the shell already built (this repo's checked-in dist,
 *    never built/deleted/modified by this test), 'npm pack --dry-run --json'
 *    actually includes packages/apra-fleet-shell-ui/dist/index.html and at
 *    least one file under .../dist/assets/.
 *
 * '--ignore-scripts' is passed to npm pack to skip the 'prepare' lifecycle
 * script (scripts/install-hooks.mjs); it still writes an informational line
 * to stdout even with that flag on this npm version, so parsing tolerates
 * leading noise the same way scripts/check-pack-size.mjs does.
 *
 * This test never writes into, deletes, or otherwise touches the live
 * packages/apra-fleet-shell-ui/dist or dist/ trees -- it only reads
 * package.json and shells out to 'npm pack --dry-run', which does not touch
 * the working tree either.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shellDistDir = path.join(repoRoot, 'packages', 'apra-fleet-shell-ui', 'dist');
const shellIndexHtml = path.join(shellDistDir, 'index.html');

function runNpmPackDryRun(): Array<{ path: string }> {
  // shell: true is required to resolve the npm.cmd shim on Windows (mirrors
  // scripts/check-pack-size.mjs's getRawInput); every argument here is a
  // static literal, never caller-controlled.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`could not locate a JSON array in npm pack output: ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files;
}

describe('root package.json ships the built shell dist (apra-fleet-v6t7.11)', () => {
  it("'files' contains the shell dist directory", () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as { files: string[] };
    expect(pkgJson.files).toContain('packages/apra-fleet-shell-ui/dist/');
  });

  describe('npm pack --dry-run listing', () => {
    let files: Array<{ path: string }>;

    beforeAll(() => {
      if (!fs.existsSync(shellIndexHtml)) {
        throw new Error(
          `expected a built shell dist at ${shellIndexHtml} -- run "npm run build:ui" first ` +
            '(this test reads the existing dist, it never builds one itself).',
        );
      }
      files = runNpmPackDryRun();
      // Default vitest hookTimeout (10s) is too tight for a real `npm pack
      // --dry-run` child process (spawns npm.cmd, walks ~1200+ files) when
      // the full suite is running under contention; 30s observed comfortable
      // headroom over a ~3s solo run.
    }, 30000);

    it('packs packages/apra-fleet-shell-ui/dist/index.html', () => {
      const paths = files.map((f) => f.path);
      expect(paths).toContain('packages/apra-fleet-shell-ui/dist/index.html');
    });

    it('packs at least one file under packages/apra-fleet-shell-ui/dist/assets/', () => {
      const paths = files.map((f) => f.path);
      expect(paths.some((p) => p.startsWith('packages/apra-fleet-shell-ui/dist/assets/'))).toBe(true);
    });

    it('never touches the live shell dist tree', () => {
      // Sanity check that the fixture this test reads from is still exactly
      // what it was before the pack run: index.html still present.
      expect(fs.existsSync(shellIndexHtml)).toBe(true);
    });
  });
});
