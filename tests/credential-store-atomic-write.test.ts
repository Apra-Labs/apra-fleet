/**
 * Atomic credentials.json writes and the server-side named-secret lookup.
 *
 * Test 1 is a real cross-process race: a child process (the store bundled
 * from source with esbuild) rewrites one persistent secret in a tight loop
 * while this process loops lookupServerSecret. Reverting saveCredentialFile
 * to an in-place fs.writeFileSync makes lookups hit a truncated file
 * (JSON.parse failure) and fails the test. A second test also asserts via a
 * spy that rename is used and no temp file is left behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FLEET_DIR } from '../src/paths.js';
import { buildSync } from 'esbuild';
import {
  credentialSet,
  lookupServerSecret,
  lookupServerSecretMeta,
  credentialDelete,
} from '../src/services/credential-store.js';

let dir: string;
const originalDataDir = process.env.APRA_FLEET_DATA_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-cred-atomic-'));
  process.env.APRA_FLEET_DATA_DIR = dir;
});

afterEach(() => {
  process.env.APRA_FLEET_DATA_DIR = originalDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('saveCredentialFile atomicity', () => {
  it('concurrent rewrites by another process never fail a lookup', async () => {
    const bundle = path.join(dir, 'store.mjs');
    buildSync({
      entryPoints: [path.resolve('src/services/credential-store.ts')],
      bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error',
    });

    const A = 'canary-value-A-' + 'a'.repeat(2000);
    const B = 'canary-value-B-' + 'b'.repeat(2000);
    credentialSet('RACE', A, true, 'allow');
    // crypto.ts resolves its key file from FLEET_DIR at import time; share the
    // parent's key with the child (whose FLEET_DIR is `dir`) so both decrypt alike.
    fs.copyFileSync(path.join(FLEET_DIR, 'salt'), path.join(dir, 'salt'));

    const writer = path.join(dir, 'writer.mjs');
    fs.writeFileSync(writer, `
      import { credentialSet } from './store.mjs';
      const vals = [${JSON.stringify(A)}, ${JSON.stringify(B)}];
      for (let i = 0; i < 400; i++) credentialSet('RACE', vals[i % 2], true, 'allow');
    `);
    const child = spawn(process.execPath, [writer], { env: { ...process.env, APRA_FLEET_DATA_DIR: dir }, stdio: 'ignore' });
    const done = new Promise<number | null>((r) => child.on('exit', r));

    let finished = false;
    void done.then(() => { finished = true; });
    let lookups = 0;
    const failures: string[] = [];
    while (!finished) {
      try {
        const r = lookupServerSecret('RACE');
        if (r.status !== "ok") failures.push(`status ${r.status}`);
        else if (r.value !== A && r.value !== B) failures.push('unexpected value');
      } catch (e) {
        failures.push((e as Error).message);
      }
      lookups++;
      await new Promise((r) => setImmediate(r));
    }
    expect(await done).toBe(0);
    expect(lookups).toBeGreaterThan(10);
    expect(failures.slice(0, 3)).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 60000);

  it('writes via temp file + rename, mode 0600, no leftovers', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    credentialSet('X', 'v', true, 'allow');
    const target = path.join(dir, 'credentials.json');
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy.mock.calls[0][1]).toBe(target);
    expect(writeSpy.mock.calls.some((c) => c[0] === target)).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
  });
});

describe('lookupServerSecret semantics', () => {
  it('missing name -> missing', () => {
    expect(lookupServerSecret('NOPE')).toEqual({ status: 'missing' });
    expect(lookupServerSecretMeta('NOPE')).toEqual({ status: 'missing' });
  });

  it('expired -> expired and the record is not deleted', () => {
    credentialSet('EXP', 'val', true, 'allow', '*', 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5000);
    try {
      const first = lookupServerSecret('EXP');
      expect(first.status).toBe('expired');
      expect(lookupServerSecret('EXP').status).toBe('expired');
      expect(lookupServerSecretMeta('EXP').status).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
    expect(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf-8')).toContain('EXP');
  });

  it('ignores allowedMembers', () => {
    credentialSet('RESTRICTED', 'val', true, 'allow', ['someone-else']);
    const r = lookupServerSecret('RESTRICTED');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.value).toBe('val');
  });

  it('persistent wins over session', () => {
    credentialSet('BOTH', 'session-val', false, 'allow');
    const file = path.join(dir, 'credentials.json');
    credentialSet('BOTH', 'persist-val', true, 'allow');
    // persistent set supersedes session; re-add a session entry
    credentialSet('BOTH', 'session-val', false, 'allow');
    expect(fs.existsSync(file)).toBe(true);
    const r = lookupServerSecret('BOTH');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.value).toBe('persist-val');
      expect(r.meta.scope).toBe('persistent');
    }
    credentialDelete('BOTH');
  });

  it('never logs the value', () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'),
      vi.spyOn(process.stderr, 'write'), vi.spyOn(process.stdout, 'write')];
    credentialSet('LEAK', 'SECRET-CANARY-123', true, 'allow');
    lookupServerSecret('LEAK');
    lookupServerSecretMeta('LEAK');
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain('SECRET-CANARY-123');
    }
  });
});
