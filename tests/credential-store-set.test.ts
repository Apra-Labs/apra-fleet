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
      network_policy: 'allow'
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
      network_policy: 'allow'
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
      expect(credentialResolve(name)).toMatchObject({ meta: { scope: 'session', network_policy: 'allow' } });
      expect(fs.existsSync(path.join(TEST_DATA_DIR, 'credentials.json'))).toBe(false);
      credentialDelete(name);
    });

    it('an explicit network_policy is honoured', async () => {
      await credentialStoreSet(credentialStoreSetSchema.parse({ name: 'explicit_deny', prompt: 'test', network_policy: 'deny' }));
      expect(credentialResolve('explicit_deny')).toMatchObject({ meta: { scope: 'persistent', network_policy: 'deny' } });
    });

    it('explicit members are honoured', async () => {
      await credentialStoreSet(credentialStoreSetSchema.parse({ name: 'explicit_members', prompt: 'test', members: 'a,b' }));
      expect(credentialResolve('explicit_members')).toMatchObject({ meta: { scope: 'persistent', network_policy: 'allow', allowedMembers: ['a', 'b'] } });
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

  describe('re-setting an existing secret changes only its value', () => {
    const credsPath = () => path.join(TEST_DATA_DIR, 'credentials.json');
    const onDisk = (name: string) => JSON.parse(fs.readFileSync(credsPath(), 'utf-8')).credentials[name];
    const reset = (args: Record<string, unknown>) => credentialStoreSet(credentialStoreSetSchema.parse({ prompt: 'test', ...args }));
    const stored = (name: string, extra: Record<string, unknown> = {}) => {
      fs.writeFileSync(credsPath(), JSON.stringify({ version: '1.0', credentials: {
        [name]: { name, network_policy: 'deny', created_at: '2026-01-01T00:00:00.000Z', encryptedValue: encryptPassword('old'), allowedMembers: ['a'], ...extra },
      } }));
    };

    beforeEach(() => {
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ password: encryptPassword('new') });
    });

    it('a deny and member-scoped persistent secret keeps both, and its tier', async () => {
      stored('kept');
      expect(await reset({ name: 'kept' })).toContain('kept stored [persistent]');
      expect(onDisk('kept')).toMatchObject({ network_policy: 'deny', allowedMembers: ['a'] });
      expect(credentialResolve('kept', 'a')).toMatchObject({ plaintext: 'new' });
    });

    it('a session secret stays session, with its policy and members', async () => {
      credentialSet('kept_session', 'old', false, 'deny', ['a']);
      expect(await reset({ name: 'kept_session' })).toContain('kept_session stored [session]');
      expect(credentialResolve('kept_session', 'a')).toMatchObject({ plaintext: 'new', meta: { scope: 'session', network_policy: 'deny', allowedMembers: ['a'] } });
      expect(fs.existsSync(credsPath())).toBe(false);
      credentialDelete('kept_session');
    });

    it('an explicit network_policy changes only the policy', async () => {
      stored('p');
      await reset({ name: 'p', network_policy: 'allow' });
      expect(onDisk('p')).toMatchObject({ network_policy: 'allow', allowedMembers: ['a'] });
    });

    it('explicit members change only the members', async () => {
      stored('m');
      await reset({ name: 'm', members: '*' });
      expect(onDisk('m')).toMatchObject({ network_policy: 'deny', allowedMembers: '*' });
    });

    it('an explicit ttl changes only the expiry', async () => {
      stored('t');
      const before = Date.now();
      await reset({ name: 't', ttl_seconds: 60 });
      expect(onDisk('t')).toMatchObject({ network_policy: 'deny', allowedMembers: ['a'] });
      expect(new Date(onDisk('t').expiresAt).getTime()).toBeGreaterThanOrEqual(before + 59_000);
    });

    it('explicit persist: true moves a session secret to the file, keeping policy and members', async () => {
      credentialSet('promote', 'old', false, 'deny', ['a']);
      expect(await reset({ name: 'promote', persist: true })).toContain('stored [persistent]');
      expect(onDisk('promote')).toMatchObject({ network_policy: 'deny', allowedMembers: ['a'] });
    });

    it('explicit persist: false on a persistent secret is refused before a value is asked for, and changes nothing', async () => {
      stored('demote');
      const before = fs.readFileSync(credsPath());
      const out = await reset({ name: 'demote', persist: false });
      expect(out).toContain('[FAIL]');
      expect(out).toContain("'demote' is persistent");
      expect(out).toContain('credential_store_delete');
      expect(authSocket.collectOobApiKey).not.toHaveBeenCalled();
      expect(fs.readFileSync(credsPath()).equals(before)).toBe(true);
      expect(credentialResolve('demote', 'a')).toMatchObject({ plaintext: 'old', meta: { scope: 'persistent' } });
    });

    it('explicit persist: false on a session secret is still allowed', async () => {
      credentialSet('still_session', 'old', false, 'deny');
      expect(await reset({ name: 'still_session', persist: false })).toContain('stored [session]');
      expect(credentialResolve('still_session')).toMatchObject({ plaintext: 'new', meta: { network_policy: 'deny' } });
      credentialDelete('still_session');
    });

    it('an unexpired expiry stays as stored when ttl is omitted', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      stored('live_ttl', { expiresAt });
      await reset({ name: 'live_ttl' });
      expect(onDisk('live_ttl').expiresAt).toBe(expiresAt);
      expect(credentialResolve('live_ttl', 'a')).toMatchObject({ plaintext: 'new' });
    });

    it('an expired record gets a value that does not expire, keeping policy and members', async () => {
      stored('dead_ttl', { expiresAt: new Date(Date.now() - 1000).toISOString() });
      await reset({ name: 'dead_ttl' });
      expect(onDisk('dead_ttl').expiresAt).toBeUndefined();
      expect(onDisk('dead_ttl')).toMatchObject({ network_policy: 'deny', allowedMembers: ['a'] });
      expect(credentialResolve('dead_ttl', 'a')).toMatchObject({ plaintext: 'new' });
    });

    it('an expired record with an explicit ttl takes that ttl', async () => {
      stored('dead_new_ttl', { expiresAt: new Date(Date.now() - 1000).toISOString() });
      const before = Date.now();
      await reset({ name: 'dead_new_ttl', ttl_seconds: 60 });
      expect(new Date(onDisk('dead_new_ttl').expiresAt).getTime()).toBeGreaterThanOrEqual(before + 59_000);
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

    it('persist omitted: a deny, member-scoped bound secret keeps both, and an expired one loses only its expiry', async () => {
      const credsPath = path.join(TEST_DATA_DIR, 'credentials.json');
      credentialSet(bound, 'v', true, 'deny', ['a'], -1);
      await credentialStoreSet(credentialStoreSetSchema.parse({ name: bound, prompt: 'test' }));
      const rec = JSON.parse(fs.readFileSync(credsPath, 'utf-8')).credentials[bound];
      expect(rec).toMatchObject({ network_policy: 'deny', allowedMembers: ['a'] });
      expect(rec.expiresAt).toBeUndefined();
      expect(credentialResolve(bound, 'a')).toMatchObject({ plaintext: 'rotated' });
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


