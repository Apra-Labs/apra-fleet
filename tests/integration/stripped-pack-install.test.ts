import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTgz } from '../helpers/tgz.js';
import { runSmoke } from '../../scripts/ci/pack-install-smoke.mjs';
import { DEFAULT_THRESHOLD_BYTES, tarballUnpackedSize } from '../../scripts/check-pack-size.mjs';
import { isExempt } from '../../scripts/pack-stripped.mjs';

// apra-fleet-kc3e.4 part B (slow, gated): runs the REAL pack script on the
// built repo and smoke-installs the tarball. Needs `npm run build` and
// `npm run dist-pm` first. Excluded from the default run by
// vitest.config.ts NIGHTLY_ONLY_TESTS unless APRA_RUN_PACK_INSTALL=1; it runs
// in .github/workflows/regression.yml (job undici-pack-install).
// Part A (tests/integration/stripped-pack.test.ts) is the repo-sources-only
// proof that runs in every `npm test`.

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
}

function lineCount(s: string): number {
  return s.split('\n').length;
}

function npmDryRunFiles(): string[] {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  const entry = JSON.parse(raw.slice(raw.indexOf('[')))[0];
  return entry.files.map((f: { path: string }) => f.path);
}

describe('stripped npm pack of the built repo (apra-fleet-kc3e.4 part B)', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stripped-pack-install-'));
  afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  it('packs, verifies the tarball against the repo, and smoke-installs it', () => {
    expect(fs.existsSync(path.join(repoRoot, 'dist', 'index.js')), 'run npm run build and npm run dist-pm first').toBe(true);

    const statusBefore = git('status', '--porcelain');
    const outDir = path.join(sandbox, 'out');
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'pack-stripped.mjs'), '--out', outDir], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tgzs = fs.readdirSync(outDir).filter((n) => n.endsWith('.tgz'));
    expect(tgzs).toHaveLength(1);
    const tarball = path.join(outDir, tgzs[0]);

    const extractDir = path.join(sandbox, 'extracted');
    const packed = extractTgz(tarball, extractDir).map((p) => p.replace(/^package\//, ''));
    const pkg = path.join(extractDir, 'package');

    // Same file list as the repo's own dry-run pack.
    expect([...packed].sort()).toEqual([...new Set([...npmDryRunFiles(), 'package.json'])].sort());

    const problems: string[] = [];
    for (const f of packed) {
      if (f === 'package.json') continue; // staged copy drops pack-time lifecycle scripts
      const repoBuf = fs.readFileSync(path.join(repoRoot, f));
      const packedBuf = fs.readFileSync(path.join(pkg, f));
      if (isExempt(f)) {
        if (!repoBuf.equals(packedBuf)) problems.push(`exempt file differs: ${f}`);
      } else if (/\.(?:js|mjs|cjs)$/.test(f)) {
        if (lineCount(repoBuf.toString('utf-8')) !== lineCount(packedBuf.toString('utf-8'))) {
          problems.push(`line count differs: ${f}`);
        }
      } else if (!repoBuf.equals(packedBuf)) {
        problems.push(`non-JS file differs: ${f}`);
      }
    }
    expect(problems).toEqual([]);

    const wf = fs.readFileSync(path.join(pkg, 'dist', 'workflows', 'auto-sprint.js'), 'utf-8');
    expect(wf).toContain('// PURE_FUNCTIONS_BEGIN');
    expect(wf).toContain('// PURE_FUNCTIONS_END');
    expect(fs.readFileSync(path.join(pkg, 'packages', 'apra-fleet-se', 'bin', 'cli.mjs'), 'utf-8').startsWith('#!')).toBe(true);

    expect(tarballUnpackedSize(fs.readFileSync(tarball))).toBeLessThan(DEFAULT_THRESHOLD_BYTES);
    expect(git('status', '--porcelain')).toBe(statusBefore);

    // Smoke install: HOME/USERPROFILE/APRA_FLEET_DATA_DIR (and temp) stay inside the sandbox.
    const savedTmp = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const smokeTmp = path.join(sandbox, 'smoke-tmp');
    fs.mkdirSync(smokeTmp);
    process.env.TMPDIR = smokeTmp;
    process.env.TEMP = smokeTmp;
    process.env.TMP = smokeTmp;
    try {
      // runSmoke throws unless install, --version and fleet-sprint --help all succeed.
      const res = runSmoke({ tarball, log: () => {} });
      expect(res.version).toMatch(/\d+\.\d+\.\d+/);
      expect(res.schemaCount).toBeGreaterThan(0);
    } finally {
      for (const [k, v] of Object.entries(savedTmp)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 600000);
});
