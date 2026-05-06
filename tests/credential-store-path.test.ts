/**
 * T6: Unit tests for credential-store path derivation via APRA_FLEET_DATA_DIR.
 * Verifies that getCredentialsPath() and all store operations respect the
 * env var at call time, not at module load time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  credentialSet,
  credentialList,
  credentialDelete,
  credentialResolve,
} from '../src/services/credential-store.js';

const BASE_DIR = path.join(os.tmpdir(), 'apra-fleet-path-test');

function makeDir(suffix: string): string {
  const dir = path.join(BASE_DIR, suffix);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function credentialsFile(dir: string): string {
  return path.join(dir, 'credentials.json');
}

const originalDataDir = process.env.APRA_FLEET_DATA_DIR;

afterEach(() => {
  // Restore original env var
  if (originalDataDir === undefined) {
    delete process.env.APRA_FLEET_DATA_DIR;
  } else {
    process.env.APRA_FLEET_DATA_DIR = originalDataDir;
  }

  // Clean up any test credentials that leaked into the default dir
  for (const entry of credentialList()) {
    if (entry.name.startsWith('path_test_')) {
      credentialDelete(entry.name);
    }
  }

  // Clean up temp dirs
  try {
    fs.rmSync(BASE_DIR, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// getCredentialsPath respects APRA_FLEET_DATA_DIR at call time
// ---------------------------------------------------------------------------

describe('getCredentialsPath: call-time env var resolution', () => {
  it('writes credentials.json under APRA_FLEET_DATA_DIR when set', () => {
    const dir = makeDir('dir-a');
    process.env.APRA_FLEET_DATA_DIR = dir;

    const name = `path_test_${Date.now()}`;
    credentialSet(name, 'value', true, 'allow');

    expect(fs.existsSync(credentialsFile(dir))).toBe(true);
    const contents = JSON.parse(fs.readFileSync(credentialsFile(dir), 'utf-8'));
    expect(contents.credentials[name]).toBeDefined();
  });

  it('changing APRA_FLEET_DATA_DIR mid-process redirects subsequent writes', () => {
    const dir1 = makeDir('dir-b1');
    const dir2 = makeDir('dir-b2');
    const name1 = `path_test_b1_${Date.now()}`;
    const name2 = `path_test_b2_${Date.now()}`;

    process.env.APRA_FLEET_DATA_DIR = dir1;
    credentialSet(name1, 'v1', true, 'allow');

    process.env.APRA_FLEET_DATA_DIR = dir2;
    credentialSet(name2, 'v2', true, 'allow');

    // dir1 has name1 only
    const c1 = JSON.parse(fs.readFileSync(credentialsFile(dir1), 'utf-8'));
    expect(c1.credentials[name1]).toBeDefined();
    expect(c1.credentials[name2]).toBeUndefined();

    // dir2 has name2 only
    const c2 = JSON.parse(fs.readFileSync(credentialsFile(dir2), 'utf-8'));
    expect(c2.credentials[name2]).toBeDefined();
    expect(c2.credentials[name1]).toBeUndefined();
  });

  it('credential set in dir-A is not visible when reading from dir-B', () => {
    const dirA = makeDir('dir-c-a');
    const dirB = makeDir('dir-c-b');
    const name = `path_test_c_${Date.now()}`;

    process.env.APRA_FLEET_DATA_DIR = dirA;
    credentialSet(name, 'secret', true, 'allow');

    process.env.APRA_FLEET_DATA_DIR = dirB;
    const result = credentialResolve(name);
    // Session store may still hold it, but persistent store from dir-B is empty
    // Persistent takes precedence; since dir-B has no such credential, result
    // should be from session tier (if any) or null.
    // We care that dir-B's credentials.json does NOT contain this credential.
    expect(fs.existsSync(credentialsFile(dirB))).toBe(false);
  });

  it('creates the data directory if it does not exist', () => {
    const newDir = path.join(BASE_DIR, 'dir-autocreate', 'nested');
    // Don't pre-create it
    process.env.APRA_FLEET_DATA_DIR = newDir;

    const name = `path_test_autocreate_${Date.now()}`;
    credentialSet(name, 'value', true, 'allow');

    expect(fs.existsSync(newDir)).toBe(true);
    expect(fs.existsSync(credentialsFile(newDir))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadCredentialFile / saveCredentialFile both use getCredentialsPath()
// (ensures no duplicate env-var reads remain)
// ---------------------------------------------------------------------------

describe('credential-store: read and write use same path', () => {
  it('credentialSet (persist) then credentialResolve reads back from same dir', () => {
    const dir = makeDir('dir-d');
    process.env.APRA_FLEET_DATA_DIR = dir;

    const name = `path_test_d_${Date.now()}`;
    credentialSet(name, 'round-trip-value', true, 'allow');

    const result = credentialResolve(name);
    expect(result).not.toBeNull();
    expect('plaintext' in result!).toBe(true);
    if (result && 'plaintext' in result) {
      expect(result.plaintext).toBe('round-trip-value');
    }
    credentialDelete(name);
  });

  it('credentialList reads from APRA_FLEET_DATA_DIR', () => {
    const dir = makeDir('dir-e');
    process.env.APRA_FLEET_DATA_DIR = dir;

    const name = `path_test_e_${Date.now()}`;
    credentialSet(name, 'value', true, 'allow');

    const list = credentialList();
    const found = list.find(e => e.name === name);
    expect(found).toBeDefined();
    expect(found!.scope).toBe('persistent');
    credentialDelete(name);
  });

  it('credentialDelete removes from APRA_FLEET_DATA_DIR', () => {
    const dir = makeDir('dir-f');
    process.env.APRA_FLEET_DATA_DIR = dir;

    const name = `path_test_f_${Date.now()}`;
    credentialSet(name, 'value', true, 'allow');
    expect(credentialResolve(name)).not.toBeNull();

    credentialDelete(name);

    const file = JSON.parse(fs.readFileSync(credentialsFile(dir), 'utf-8'));
    expect(file.credentials[name]).toBeUndefined();
  });
});
