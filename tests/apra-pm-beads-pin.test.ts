import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BEADS_PACKAGE, BEADS_VERSION } from '../src/cli/beads-pin.js';

// bd is pinned to one version everywhere. This reads the real files: every
// tracked file naming an @beads/bd@X.Y.Z specifier or a BEADS_REQ value must
// name BEADS_VERSION, so a stale pin added anywhere fails here.

const repoRoot = path.resolve(__dirname, '..');
const SPECIFIER = /@beads\/bd@(\d+\.\d+\.\d+)/g;
const WORKFLOW_REQ = /^\s*BEADS_REQ:\s*"?(\d+\.\d+\.\d+)"?/gm;

// A record of a past migration: it names the version that migration was for.
const HISTORICAL = new Set(['packages/apra-fleet-se/apra-pm/docs/beads-1.1.0-migration.md']);

function pinsIn(file: string): string[] {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
  return [...text.matchAll(SPECIFIER), ...text.matchAll(WORKFLOW_REQ)].map((m) => m[1]);
}

function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((f) => /\.(?:m?js|cjs|ts|ya?ml|sh|ps1|md)$/.test(f) && !HISTORICAL.has(f) && fs.existsSync(path.join(repoRoot, f)));
}

describe('bd version pin', () => {
  it('every install site the owner named is on BEADS_VERSION', () => {
    for (const file of [
      'packages/apra-fleet-se/apra-pm/install.mjs',
      '.github/e2e/fleet-setup.mjs',
      '.github/workflows/pm-e2e.yml',
      '.github/workflows/ci.yml',
    ]) {
      const pins = pinsIn(file);
      expect(pins.length, `${file} no longer names a bd version`).toBeGreaterThan(0);
      for (const pin of pins) expect(pin, file).toBe(BEADS_VERSION);
    }
  });

  it('no tracked file names any other bd version', () => {
    const stale = trackedTextFiles().flatMap((file) =>
      pinsIn(file).filter((pin) => pin !== BEADS_VERSION).map((pin) => `${file}: ${pin}`),
    );
    expect(stale).toEqual([]);
  });

  it('BEADS_PACKAGE is built from BEADS_VERSION', () => {
    expect(BEADS_PACKAGE).toBe(`@beads/bd@${BEADS_VERSION}`);
  });
});
