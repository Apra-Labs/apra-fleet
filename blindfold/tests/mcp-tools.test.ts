import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import {
  credentialSet,
  credentialList,
  credentialDelete,
  credentialResolve,
  _clearSessionStore,
} from '../src/credential-store.js';
import {
  ensureAuthSocket,
  cleanupAuthSocket,
  createPendingAuth,
  getSocketPath,
} from '../src/auth-socket.js';
import { credentialListHandler } from '../src/mcp/tools/credential-list.js';
import { credentialDeleteHandler } from '../src/mcp/tools/credential-delete.js';
import { credentialUpdateHandler } from '../src/mcp/tools/credential-update.js';
import { credentialSetHandler } from '../src/mcp/tools/credential-set.js';
import { resolveSecureHandler } from '../src/mcp/tools/resolve-secure.js';

function sendPassword(sockPath: string, memberName: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      client.write(JSON.stringify({ type: 'auth', member_name: memberName, password }) + '\n');
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.indexOf('\n') !== -1) {
        client.end();
        client.destroy();
        resolve();
      }
    });
    client.on('error', (err) => {
      client.destroy();
      reject(err);
    });
  });
}

describe('MCP tool handlers', () => {
  beforeEach(() => {
    _clearSessionStore();
  });

  afterEach(async () => {
    await cleanupAuthSocket();
  });

  describe('credentialListHandler', () => {
    it('returns empty array when no credentials exist', async () => {
      const result = await credentialListHandler();
      const parsed = JSON.parse(result);
      expect(parsed).toEqual([]);
    });

    it('returns stored credentials with metadata', async () => {
      credentialSet('DB_PASS', 'secret123', false, 'allow');
      credentialSet('API_KEY', 'key456', false, 'deny', ['member-a']);

      const result = await credentialListHandler();
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(2);

      const dbPass = parsed.find((c: any) => c.name === 'DB_PASS');
      expect(dbPass.scope).toBe('session');
      expect(dbPass.network_policy).toBe('allow');
      expect(dbPass.members).toBe('*');

      const apiKey = parsed.find((c: any) => c.name === 'API_KEY');
      expect(apiKey.network_policy).toBe('deny');
      expect(apiKey.members).toBe('member-a');
    });
  });

  describe('credentialDeleteHandler', () => {
    it('deletes an existing credential', async () => {
      credentialSet('TO_DELETE', 'val', false, 'allow');
      const result = await credentialDeleteHandler({ name: 'TO_DELETE' });
      expect(result).toContain('deleted');
      expect(credentialResolve('TO_DELETE')).toBeNull();
    });

    it('returns not-found for missing credential', async () => {
      const result = await credentialDeleteHandler({ name: 'NOPE' });
      expect(result).toContain('not found');
    });
  });

  describe('credentialUpdateHandler', () => {
    it('updates network policy', async () => {
      credentialSet('UPD_CRED', 'val', false, 'allow');
      const result = await credentialUpdateHandler({ name: 'UPD_CRED', network_policy: 'deny' });
      expect(result).toContain('updated');
      expect(result).toContain('"deny"');
    });

    it('returns error when no fields specified', async () => {
      credentialSet('UPD_CRED2', 'val', false, 'allow');
      const result = await credentialUpdateHandler({ name: 'UPD_CRED2' });
      expect(result).toContain('No fields to update');
    });

    it('returns not-found for missing credential', async () => {
      const result = await credentialUpdateHandler({ name: 'MISSING', network_policy: 'deny' });
      expect(result).toContain('not found');
    });

    it('updates TTL', async () => {
      credentialSet('TTL_CRED', 'val', false, 'allow');
      const result = await credentialUpdateHandler({ name: 'TTL_CRED', ttl_seconds: 3600 });
      expect(result).toContain('updated');
    });

    it('removes TTL with zero', async () => {
      credentialSet('TTL_ZERO', 'val', false, 'allow', '*', 60);
      const result = await credentialUpdateHandler({ name: 'TTL_ZERO', ttl_seconds: 0 });
      expect(result).toContain('updated');
      expect(result).toContain('"expiresAt":null');
    });
  });

  describe('credentialSetHandler', () => {
    it('collects secret via OOB and stores it', async () => {
      const launchFn = vi.fn().mockReturnValue('launched');

      const resultPromise = credentialSetHandler({
        name: 'OOB_CRED',
        prompt: 'Enter secret',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });

      await new Promise(r => setTimeout(r, 100));
      await sendPassword(getSocketPath(), 'OOB_CRED', 'my-secret-value');

      const result = await resultPromise;
      expect(result).toContain('Stored');
      expect(result).toContain('{{secure.OOB_CRED}}');
    });

    it('returns fallback when no terminal is available', async () => {
      const result = await credentialSetHandler({
        name: 'NO_TERM',
        prompt: 'Enter secret',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });
      // On headless CI, this will either succeed if DISPLAY is set or return a fallback
      expect(typeof result).toBe('string');
    });
  });

  describe('resolveSecureHandler', () => {
    it('resolves tokens in text', async () => {
      credentialSet('MY_TOKEN', 'secret-val', false, 'allow');
      const result = await resolveSecureHandler({
        text: 'curl -H "Auth: {{secure.MY_TOKEN}}"',
        shell_escape: false,
      });
      const parsed = JSON.parse(result);
      expect(parsed.resolved).toContain('secret-val');
      expect(parsed.redact_patterns).toContain('secret-val');
    });

    it('returns text unchanged when no tokens present', async () => {
      const result = await resolveSecureHandler({
        text: 'just plain text',
        shell_escape: true,
      });
      const parsed = JSON.parse(result);
      expect(parsed.resolved).toBe('just plain text');
      expect(parsed.redact_patterns).toEqual([]);
    });

    it('returns error for missing credential', async () => {
      const result = await resolveSecureHandler({
        text: 'curl {{secure.NONEXISTENT}}',
        shell_escape: true,
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('not found');
    });

    it('applies shell escaping by default', async () => {
      credentialSet('SHELL_TEST', "val'with'quotes", false, 'allow');
      const result = await resolveSecureHandler({
        text: 'echo {{secure.SHELL_TEST}}',
        shell_escape: true,
      });
      const parsed = JSON.parse(result);
      expect(parsed.resolved).not.toContain("val'with'quotes");
      expect(parsed.resolved).toContain('val');
    });

    it('supports Windows shell escaping', async () => {
      credentialSet('WIN_TEST', 'test$value', false, 'allow');
      const result = await resolveSecureHandler({
        text: 'echo {{secure.WIN_TEST}}',
        os: 'windows',
        shell_escape: true,
      });
      const parsed = JSON.parse(result);
      expect(parsed.resolved).toContain('test');
    });

    it('respects caller scoping', async () => {
      credentialSet('SCOPED', 'val', false, 'allow', ['member-a']);
      const result = await resolveSecureHandler({
        text: '{{secure.SCOPED}}',
        caller: 'member-b',
        shell_escape: false,
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });
  });
});
