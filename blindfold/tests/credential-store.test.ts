import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initBlindfold, resetConfig } from '../src/config.js';
import {
  credentialSet,
  credentialList,
  credentialDelete,
  credentialResolve,
  credentialUpdate,
  purgeExpiredCredentials,
  _clearSessionStore,
} from '../src/credential-store.js';

describe('credential-store', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blindfold-cred-'));
    resetConfig();
    initBlindfold({ dataDir: testDir });
    _clearSessionStore();
  });

  afterEach(() => {
    _clearSessionStore();
    resetConfig();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('credentialSet + credentialResolve', () => {
    it('stores and resolves a session credential', () => {
      const meta = credentialSet('test-key', 'secret123', false, 'allow');
      expect(meta.scope).toBe('session');
      expect(meta.name).toBe('test-key');

      const result = credentialResolve('test-key');
      expect(result).not.toBeNull();
      expect(result!).toHaveProperty('plaintext', 'secret123');
    });

    it('stores and resolves a persistent credential', () => {
      const meta = credentialSet('persist-key', 'secret456', true, 'deny');
      expect(meta.scope).toBe('persistent');

      const result = credentialResolve('persist-key');
      expect(result).not.toBeNull();
      expect(result!).toHaveProperty('plaintext', 'secret456');
    });

    it('persistent supersedes session', () => {
      credentialSet('dup', 'session-val', false, 'allow');
      credentialSet('dup', 'persist-val', true, 'allow');

      const result = credentialResolve('dup');
      expect(result!).toHaveProperty('plaintext', 'persist-val');
    });

    it('returns null for non-existent credential', () => {
      expect(credentialResolve('nope')).toBeNull();
    });
  });

  describe('credentialList', () => {
    it('lists session and persistent credentials', () => {
      credentialSet('s1', 'v1', false, 'allow');
      credentialSet('p1', 'v2', true, 'deny');

      const list = credentialList();
      expect(list).toHaveLength(2);
      const names = list.map(c => c.name);
      expect(names).toContain('s1');
      expect(names).toContain('p1');
    });

    it('persistent entry overrides session entry with same name', () => {
      credentialSet('same', 'val', false, 'allow');
      credentialSet('same', 'val2', true, 'deny');

      const list = credentialList();
      const entry = list.find(c => c.name === 'same')!;
      expect(entry.scope).toBe('persistent');
    });
  });

  describe('credentialDelete', () => {
    it('deletes session credential', () => {
      credentialSet('del-me', 'val', false, 'allow');
      expect(credentialDelete('del-me')).toBe(true);
      expect(credentialResolve('del-me')).toBeNull();
    });

    it('deletes persistent credential', () => {
      credentialSet('del-persist', 'val', true, 'allow');
      expect(credentialDelete('del-persist')).toBe(true);
      expect(credentialResolve('del-persist')).toBeNull();
    });

    it('returns false for non-existent credential', () => {
      expect(credentialDelete('nope')).toBe(false);
    });
  });

  describe('scoping', () => {
    it('allows access when callingMember is in allowedMembers', () => {
      credentialSet('scoped', 'val', false, 'allow', ['member-a', 'member-b']);
      const result = credentialResolve('scoped', 'member-a');
      expect(result!).toHaveProperty('plaintext', 'val');
    });

    it('denies access when callingMember is not in allowedMembers', () => {
      credentialSet('scoped', 'val', false, 'allow', ['member-a']);
      const result = credentialResolve('scoped', 'member-b');
      expect(result).toHaveProperty('denied');
    });

    it('allows access when allowedMembers is *', () => {
      credentialSet('wildcard', 'val', false, 'allow', '*');
      const result = credentialResolve('wildcard', 'anyone');
      expect(result!).toHaveProperty('plaintext', 'val');
    });

    it('allows access when callingMember is *', () => {
      credentialSet('scoped', 'val', false, 'allow', ['member-a']);
      const result = credentialResolve('scoped', '*');
      expect(result!).toHaveProperty('plaintext', 'val');
    });

    it('allows access when callingMember is undefined', () => {
      credentialSet('scoped', 'val', false, 'allow', ['member-a']);
      const result = credentialResolve('scoped');
      expect(result!).toHaveProperty('plaintext', 'val');
    });
  });

  describe('TTL', () => {
    it('expires a session credential after TTL', async () => {
      credentialSet('ttl-test', 'val', false, 'allow', '*', 0);
      // TTL 0 sets expiresAt to ~now; wait 1 tick to ensure we're past it
      await new Promise(r => setTimeout(r, 5));
      const result = credentialResolve('ttl-test');
      expect(result).toHaveProperty('expired');
    });

    it('expires a persistent credential after TTL', async () => {
      credentialSet('ttl-persist', 'val', true, 'allow', '*', 0);
      await new Promise(r => setTimeout(r, 5));
      const result = credentialResolve('ttl-persist');
      expect(result).toHaveProperty('expired');
    });
  });

  describe('credentialUpdate', () => {
    it('updates network_policy', () => {
      credentialSet('up', 'val', false, 'allow');
      const result = credentialUpdate('up', { network_policy: 'deny' });
      expect(result).not.toBeNull();
      expect(result!.network_policy).toBe('deny');
    });

    it('updates members', () => {
      credentialSet('up', 'val', true, 'allow', '*');
      const result = credentialUpdate('up', { members: 'a,b' });
      expect(result!.members).toBe('a,b');

      const resolve = credentialResolve('up', 'c');
      expect(resolve).toHaveProperty('denied');
    });

    it('returns null for non-existent credential', () => {
      expect(credentialUpdate('nope', { network_policy: 'deny' })).toBeNull();
    });
  });

  describe('purgeExpiredCredentials', () => {
    it('removes expired persistent credentials', () => {
      credentialSet('expired-purge', 'val', true, 'allow', '*', 0);
      purgeExpiredCredentials();
      expect(credentialResolve('expired-purge')).toBeNull();
    });

    it('does not remove non-expired credentials', () => {
      credentialSet('alive', 'val', true, 'allow', '*', 3600);
      purgeExpiredCredentials();
      expect(credentialResolve('alive')).not.toBeNull();
    });
  });

  describe('persistence', () => {
    it('persists credentials to disk', () => {
      credentialSet('disk-test', 'val', true, 'allow');
      const credPath = path.join(testDir, 'credentials.json');
      expect(fs.existsSync(credPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      expect(content.credentials['disk-test']).toBeDefined();
      expect(content.credentials['disk-test'].encryptedValue).not.toBe('val');
    });

    it('credentials.json has 0o600 permissions', () => {
      credentialSet('perm-test', 'val', true, 'allow');
      if (process.platform !== 'win32') {
        const credPath = path.join(testDir, 'credentials.json');
        const stat = fs.statSync(credPath);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });
  });
});
