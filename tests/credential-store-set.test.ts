import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import * as authSocket from '../src/services/auth-socket.js';
import * as logHelpers from '../src/utils/log-helpers.js';
import { credentialResolve, credentialDelete } from '../src/services/credential-store.js';
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
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    process.env.APRA_FLEET_DATA_DIR = TEST_DATA_DIR;
    if (!fs.existsSync(TEST_DATA_DIR)) {
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    }
    vi.clearAllMocks();
    // apra-fleet-972p.2.1: credentialStoreSet now auto-switches to the
    // return_url path whenever stdin has no TTY (test runners typically run
    // headless, so stdin.isTTY is normally undefined/false here). Force it
    // true for the pre-existing "blocking path" tests below so they keep
    // exercising exactly the behavior they always have; the dedicated
    // non-TTY/return_url tests further down override this explicitly.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    if (originalDataDir) {
      process.env.APRA_FLEET_DATA_DIR = originalDataDir;
    } else {
      delete process.env.APRA_FLEET_DATA_DIR;
    }
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
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

  // apra-fleet-972p.2.1 (F3, DQ-7): non-TTY and return_url:true both route
  // through the same out-of-band-URL path instead of blocking on
  // collectOobApiKey's password promise.
  describe('return_url / non-TTY out-of-band URL path', () => {
    it('returns {url, expiresAt} in structuredContent when stdin has no TTY, without waiting for a password', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({
        url: 'http://127.0.0.1:54321/abc123',
        expiresAt: '2026-01-01T00:02:00.000Z',
      });

      const result = await credentialStoreSet({
        name: 'oob_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
        return_url: false,
      });

      expect(typeof result).toBe('object');
      if (typeof result === 'object') {
        expect(result.structuredContent).toEqual({
          url: 'http://127.0.0.1:54321/abc123',
          expiresAt: '2026-01-01T00:02:00.000Z',
        });
        expect(result.text).toContain('http://127.0.0.1:54321/abc123');
      }

      expect(authSocket.collectOobApiKey).toHaveBeenCalledTimes(1);
      const call = vi.mocked(authSocket.collectOobApiKey).mock.calls[0];
      expect(call[0]).toBe('oob_cred');
      expect(call[1]).toBe('credential_store_set');
      expect(call[2]).toMatchObject({ prompt: 'Enter key:', returnUrl: true });
      expect(typeof call[2]?.onOobSubmit).toBe('function');

      // No credential should be stored yet -- only onOobSubmit (invoked by
      // the real auth-web.ts POST handler, not exercised by this mock) stores it.
      expect(credentialResolve('oob_cred')).toBeNull();
    });

    it('returns {url, expiresAt} when return_url: true is passed explicitly, even with a TTY attached', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({
        url: 'http://127.0.0.1:9999/token',
        expiresAt: '2026-01-01T00:02:00.000Z',
      });

      const result = await credentialStoreSet({
        name: 'explicit_url_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
        return_url: true,
      });

      expect(typeof result).toBe('object');
      if (typeof result === 'object') {
        expect(result.structuredContent.url).toBe('http://127.0.0.1:9999/token');
      }
      const call = vi.mocked(authSocket.collectOobApiKey).mock.calls[0];
      expect(call[2]).toMatchObject({ returnUrl: true });
    });

    it('the onOobSubmit callback stores the credential exactly like the blocking path does', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      let capturedSubmit: ((value: string) => { ok: boolean; error?: string }) | undefined;
      vi.mocked(authSocket.collectOobApiKey).mockImplementation(async (_name, _tool, opts: any) => {
        capturedSubmit = opts?.onOobSubmit;
        return { url: 'http://127.0.0.1:1/x', expiresAt: '2026-01-01T00:02:00.000Z' };
      });

      await credentialStoreSet({
        name: 'submitted_cred',
        prompt: 'Enter key:',
        persist: true,
        network_policy: 'allow',
        members: 'agent1',
      });

      expect(capturedSubmit).toBeTypeOf('function');
      const submitResult = capturedSubmit!('plaintext-from-browser');
      expect(submitResult).toEqual({ ok: true });

      const resolved = credentialResolve('submitted_cred');
      expect(resolved).not.toBeNull();
      if (resolved && 'plaintext' in resolved) {
        expect(resolved.plaintext).toBe('plaintext-from-browser');
        expect(resolved.meta.allowedMembers).toEqual(['agent1']);
      }
      expect(logHelpers.logLine).toHaveBeenCalledWith('credential_store_set', 'name=submitted_cred persist=true via=oob_url');

      credentialDelete('submitted_cred');
    });

    it('returns the fallback message when the web server could not start', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ fallback: 'No display available.' });

      const result = await credentialStoreSet({
        name: 'no_display_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });

      expect(result).toBe('No display available.');
    });
  });

  describe('blocking TTY path is unaffected by the return_url feature', () => {
    it('still calls collectOobApiKey without returnUrl/onOobSubmit when a TTY is attached and return_url is not requested', async () => {
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({ fallback: 'Waiting for secret...' });

      await credentialStoreSet({
        name: 'tty_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
      });

      expect(authSocket.collectOobApiKey).toHaveBeenCalledWith('tty_cred', 'credential_store_set', { prompt: 'Enter key:' });
    });
  });
});


