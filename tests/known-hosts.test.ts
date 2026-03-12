import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { FLEET_DIR } from './test-helpers.js';
import { verifyHostKey, replaceKnownHost, removeKnownHost, HostKeyMismatchError } from '../src/services/known-hosts.js';
const KNOWN_HOSTS_PATH = path.join(FLEET_DIR, 'known_hosts');

let backupContent: string | null = null;

beforeEach(() => {
  if (fs.existsSync(KNOWN_HOSTS_PATH)) {
    backupContent = fs.readFileSync(KNOWN_HOSTS_PATH, 'utf-8');
  }
  // Start with empty known hosts
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
  }
  fs.writeFileSync(KNOWN_HOSTS_PATH, '{}');
});

afterEach(() => {
  if (backupContent !== null) {
    fs.writeFileSync(KNOWN_HOSTS_PATH, backupContent);
    backupContent = null;
  } else if (fs.existsSync(KNOWN_HOSTS_PATH)) {
    fs.writeFileSync(KNOWN_HOSTS_PATH, '{}');
  }
});

function fakeHostKey(): Buffer {
  return crypto.randomBytes(256);
}

describe('known-hosts TOFU', () => {
  it('trusts a new host on first connection (TOFU)', () => {
    const key = fakeHostKey();
    expect(verifyHostKey('10.0.0.1', 22, key)).toBe(true);

    // Verify it was persisted
    const store = JSON.parse(fs.readFileSync(KNOWN_HOSTS_PATH, 'utf-8'));
    expect(store['10.0.0.1:22']).toBeDefined();
    expect(store['10.0.0.1:22']).toMatch(/^sha256:/);
  });

  it('accepts matching host key on subsequent connections', () => {
    const key = fakeHostKey();
    verifyHostKey('10.0.0.2', 22, key);

    // Same key again should pass
    expect(verifyHostKey('10.0.0.2', 22, key)).toBe(true);
  });

  it('throws HostKeyMismatchError on key change', () => {
    const key1 = fakeHostKey();
    const key2 = fakeHostKey();

    verifyHostKey('10.0.0.3', 22, key1);

    expect(() => verifyHostKey('10.0.0.3', 22, key2)).toThrow(HostKeyMismatchError);
    try {
      verifyHostKey('10.0.0.3', 22, key2);
    } catch (err) {
      expect(err).toBeInstanceOf(HostKeyMismatchError);
      const mismatch = err as HostKeyMismatchError;
      expect(mismatch.host).toBe('10.0.0.3');
      expect(mismatch.port).toBe(22);
      expect(mismatch.oldFingerprint).toMatch(/^sha256:/);
      expect(mismatch.newFingerprint).toMatch(/^sha256:/);
      expect(mismatch.oldFingerprint).not.toBe(mismatch.newFingerprint);
    }
  });

  it('differentiates hosts by port', () => {
    const key1 = fakeHostKey();
    const key2 = fakeHostKey();

    verifyHostKey('10.0.0.4', 22, key1);
    // Different port should TOFU independently
    expect(verifyHostKey('10.0.0.4', 2222, key2)).toBe(true);
  });

  it('replaceKnownHost updates fingerprint', () => {
    const key1 = fakeHostKey();
    const key2 = fakeHostKey();

    verifyHostKey('10.0.0.5', 22, key1);

    // Replace with new fingerprint
    const newFp = 'sha256:' + crypto.createHash('sha256').update(key2).digest('base64');
    replaceKnownHost('10.0.0.5', 22, newFp);

    // Now key2 should be accepted
    expect(verifyHostKey('10.0.0.5', 22, key2)).toBe(true);
  });

  it('removeKnownHost deletes the entry', () => {
    const key1 = fakeHostKey();
    verifyHostKey('10.0.0.6', 22, key1);

    removeKnownHost('10.0.0.6', 22);

    // Next connection should TOFU again (even with a different key)
    const key2 = fakeHostKey();
    expect(verifyHostKey('10.0.0.6', 22, key2)).toBe(true);
  });

  it('writes known_hosts file with mode 0o600', () => {
    // Only check on non-Windows
    if (process.platform === 'win32') return;

    const key = fakeHostKey();
    verifyHostKey('10.0.0.7', 22, key);

    const stat = fs.statSync(KNOWN_HOSTS_PATH);
    // 0o600 = 384 decimal, check owner read/write only
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
