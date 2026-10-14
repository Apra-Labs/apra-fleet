import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { privateSecretDir } from '../src/services/strategy.js';

// Local members' staged secret files live in a per-user 0700 directory, never
// directly in a (possibly shared, possibly non-sticky) TMPDIR.
const bases: string[] = [];
function base(): string {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-psd-'));
  bases.push(b);
  return b;
}
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

describe('privateSecretDir', () => {
  it('creates the directory once and reuses it', () => {
    const b = base();
    const d1 = privateSecretDir(b);
    const d2 = privateSecretDir(b);
    expect(d1).toBe(d2);
    expect(fs.statSync(d1).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('is 0700 and refuses a pre-existing directory that others can access', () => {
    const b = base();
    const d = privateSecretDir(b);
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    fs.chmodSync(d, 0o777);
    expect(() => privateSecretDir(b)).toThrow(/private/);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink planted at its path', () => {
    const b = base();
    const target = fs.mkdtempSync(path.join(b, 'elsewhere-'));
    fs.chmodSync(target, 0o700);
    const uid = process.getuid!();
    fs.symlinkSync(target, path.join(b, `apra-fleet-secrets-${uid}`));
    expect(() => privateSecretDir(b)).toThrow(/private/);
  });
});
