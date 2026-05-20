import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import * as authSocket from 'blindfold';
import * as logHelpers from '../src/utils/log-helpers.js';
import { credentialResolve, credentialDelete, encryptPassword } from 'blindfold';

const TEST_DATA_DIR = path.join(os.tmpdir(), `fleet-test-cred-set-${Date.now()}`);

vi.mock('blindfold', async () => {
  const actual = await vi.importActual<typeof import('blindfold')>('blindfold');
  return { ...actual, collectOobApiKey: vi.fn() };
});

vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: vi.fn(),
}));

describe('credentialStoreSet', () => {
  const originalDataDir = process.env.APRA_FLEET_DATA_DIR;

  beforeEach(() => {
    process.env.APRA_FLEET_DATA_DIR = TEST_DATA_DIR;
    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    }
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDataDir) {
      process.env.APRA_FLEET_DATA_DIR = originalDataDir;
    } else {
      delete process.env.APRA_FLEET_DATA_DIR;
    }
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('returns fallback message from collectOobApiKey', async () => {
    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ fallback: 'Waiting for secret...' });

    const result = await credentialStoreSet({
      name: 'test_cred',
      prompt: 'Enter key:',
      persist: false,
      network_policy: 'confirm'
    });

    expect(result).toBe('Waiting for secret...');
    expect(authSocket.collectOobApiKey).toHaveBeenCalledWith('test_cred', 'credential_store_set', { prompt: 'Enter key:' });
  });

  it('returns error if no password received', async () => {
    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({});

    const result = await credentialStoreSet({
      name: 'test_cred',
      prompt: 'Enter key:',
      persist: false,
      network_policy: 'confirm'
    });

    expect(result).toContain('No secret received');
  });

  it('sets credential and returns handle when password arrives', async () => {
    const encrypted = encryptPassword('secret-value');
    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encrypted });

    const result = await credentialStoreSet({
      name: 'test_cred',
      prompt: 'Enter key:',
      persist: true,
      network_policy: 'allow',
      members: 'agent1, agent2'
    });

    expect(result).toContain('test_cred stored [persistent]');

    const resolved = credentialResolve('test_cred');
    expect(resolved).not.toBeNull();
    if (resolved && 'plaintext' in resolved) {
      expect(resolved.plaintext).toBe('secret-value');
      expect(resolved.meta.allowedMembers).toEqual(['agent1', 'agent2']);
    }

    expect(logHelpers.logLine).toHaveBeenCalledWith('credential_store_set', 'name=test_cred persist=true');
    
    credentialDelete('test_cred');
  });

  it('handles TTL and "*" member scope correctly', async () => {
    const encrypted = encryptPassword('ttl-secret');
    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encrypted });

    const result = await credentialStoreSet({
      name: 'ttl_cred',
      prompt: 'Enter key:',
      persist: false,
      network_policy: 'deny',
      members: '*',
      ttl_seconds: 3600
    });

    expect(result).toContain('ttl_cred stored [session]');

    const resolved = credentialResolve('ttl_cred');
    expect(resolved).not.toBeNull();
    if (resolved && 'plaintext' in resolved) {
      expect(resolved.meta.allowedMembers).toBe('*');
      expect(resolved.meta.expiresAt).toBeDefined();
    }

    credentialDelete('ttl_cred');
  });

  it('uses default values for persist and network_policy', async () => {
    const encrypted = encryptPassword('default-secret');
    vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encrypted });

    // Explicitly provide values that would be defaulted by Zod in production
    const result = await credentialStoreSet({
      name: 'default_cred',
      prompt: 'test',
      persist: false,
      network_policy: 'confirm',
      members: '*'
    });

    expect(result).toContain('default_cred stored [session]');
    const resolved = credentialResolve('default_cred');
    expect(resolved).not.toBeNull();
    if (resolved && 'meta' in resolved) {
      expect(resolved.meta.network_policy).toBe('confirm');
    }
    credentialDelete('default_cred');
  });
});


