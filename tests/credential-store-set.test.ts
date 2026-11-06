import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { credentialStoreSet, credentialStoreSetSchema } from '../src/tools/credential-store-set.js';
import * as authSocket from '../src/services/auth-socket.js';
import * as logHelpers from '../src/utils/log-helpers.js';
import { credentialResolve, credentialDelete, credentialSet, prepareLiveSecret, saveLiveSecret } from '../src/services/credential-store.js';
import { encryptPassword } from '../src/utils/crypto.js';

const TEST_DATA_DIR = path.join(os.tmpdir(), `fleet-test-cred-set-${Date.now()}`);

vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: vi.fn(),
}));

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

  // The defaults exist only after the schema parse, which is what the MCP layer does.
  describe('defaults, as a caller that omits the arguments gets them', () => {
    const omitted = (name: string) => credentialStoreSetSchema.parse({ name, prompt: 'test' });

    beforeEach(() => {
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encryptPassword('default-secret') });
    });

    it('persist defaults to true: the value is on disk, and credential_store_set says persistent', async () => {
      const result = await credentialStoreSet(omitted('default_persist'));
      expect(result).toContain('default_persist stored [persistent]');
      const file = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'credentials.json'), 'utf-8'));
      expect(Object.keys(file.credentials)).toEqual(['default_persist']);
    });

    it('network_policy defaults to allow and members to all', async () => {
      await credentialStoreSet(omitted('default_policy'));
      const resolved = credentialResolve('default_policy');
      expect(resolved).toMatchObject({ meta: { network_policy: 'allow', allowedMembers: '*' } });
    });

    it('an explicit persist: false is honoured and stays off disk', async () => {
      const name = 'explicit_session';
      const input = credentialStoreSetSchema.parse({ name, prompt: 'test', persist: false });
      expect(await credentialStoreSet(input)).toContain(`${name} stored [session]`);
      expect(fs.existsSync(path.join(TEST_DATA_DIR, 'credentials.json'))).toBe(false);
      credentialDelete(name);
    });

    it('an explicit network_policy is honoured', async () => {
      await credentialStoreSet(credentialStoreSetSchema.parse({ name: 'explicit_deny', prompt: 'test', network_policy: 'deny' }));
      expect(credentialResolve('explicit_deny')).toMatchObject({ meta: { network_policy: 'deny' } });
    });

    it('explicit members are honoured', async () => {
      await credentialStoreSet(credentialStoreSetSchema.parse({ name: 'explicit_members', prompt: 'test', members: 'a,b' }));
      expect(credentialResolve('explicit_members')).toMatchObject({ meta: { allowedMembers: ['a', 'b'] } });
    });

    it('storing a new name leaves a record already on disk untouched', async () => {
      const existing = { name: 'older', network_policy: 'deny', created_at: '2026-01-01T00:00:00.000Z', encryptedValue: encryptPassword('old'), allowedMembers: ['a'] };
      fs.writeFileSync(path.join(TEST_DATA_DIR, 'credentials.json'), JSON.stringify({ version: '1.0', credentials: { older: existing } }));
      await credentialStoreSet(omitted('newer'));
      const file = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'credentials.json'), 'utf-8'));
      expect(file.credentials.older).toEqual(existing);
      expect(file.credentials.newer).toMatchObject({ network_policy: 'allow', allowedMembers: '*' });
    });
  });

  describe('a name bound to a live secret', () => {
    const bound = 'bound_input';

    beforeEach(() => {
      const js = path.join(TEST_DATA_DIR, 'mint.js');
      fs.writeFileSync(js, '');
      credentialSet(bound, 'v', true, 'allow');
      saveLiveSecret(prepareLiveSecret('consumer_live', { program: process.execPath, args: [js], env: [{ env: 'R', value: `{{secret.${bound}}}` }] }));
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encryptPassword('rotated') });
    });

    it('persist omitted: asks for the value and stores it, with no refusal', async () => {
      const result = await credentialStoreSet(credentialStoreSetSchema.parse({ name: bound, prompt: 'test' }));
      expect(authSocket.collectOobApiKey).toHaveBeenCalledOnce();
      expect(result).toContain(`${bound} stored [persistent]`);
      expect(credentialResolve(bound)).toMatchObject({ plaintext: 'rotated' });
    });

    it('explicit persist: false: refused before any value is asked for', async () => {
      const result = await credentialStoreSet(credentialStoreSetSchema.parse({ name: bound, prompt: 'test', persist: false }));
      expect(result).toContain('cannot have a session value');
      expect(result).toContain('consumer_live');
      expect(authSocket.collectOobApiKey).not.toHaveBeenCalled();
      expect(credentialResolve(bound)).toMatchObject({ plaintext: 'v' });
    });
  });
});


