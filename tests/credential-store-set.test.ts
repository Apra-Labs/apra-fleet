import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  logError: vi.fn(),
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
        // Console-relative, matching what src/services/secret-entry.ts's
        // createSecretEntry() actually hands back post apra-fleet-i9ag.11.2 --
        // collectOobUrl can no longer return an absolute loopback URL.
        url: '/ui/#/secret-entry/abc123',
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
        // apra-fleet-i9ag.11.9: structuredContent.url stays exactly what
        // collectOobApiKey returned (console-relative); absoluteUrl is that
        // same relative path RESOLVED (via new URL(url, baseUrl), not a
        // naked string concat) against the (here, default) console base
        // origin -- see resolveConsoleBaseUrl in src/paths.ts.
        expect(result.structuredContent).toEqual({
          url: '/ui/#/secret-entry/abc123',
          expiresAt: '2026-01-01T00:02:00.000Z',
          absoluteUrl: 'http://127.0.0.1:7523/ui/#/secret-entry/abc123',
        });
        expect(result.text).toContain('http://127.0.0.1:7523/ui/#/secret-entry/abc123');
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

    // apra-fleet-i9ag.11.11: pin the actual token shape createSecretEntry()
    // hands out (src/services/secret-entry.ts: crypto.randomBytes(32).toString
    // ('hex')) end to end through the tool, not just a short placeholder
    // string -- and confirm the relative path never carries a scheme/host/port.
    it('structuredContent.url matches the real 64-hex-char secret-entry token shape and carries no scheme/host/port', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const realToken = crypto.randomBytes(32).toString('hex');
      const relativeUrl = `/ui/#/secret-entry/${realToken}`;
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({
        url: relativeUrl,
        expiresAt: '2026-01-01T00:02:00.000Z',
      });

      const result = await credentialStoreSet({
        name: 'shape_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
        return_url: true,
      });

      expect(typeof result).toBe('object');
      if (typeof result === 'object') {
        expect(result.structuredContent.url).toMatch(/^\/ui\/#\/secret-entry\/[0-9a-f]{64}$/);
        expect(result.structuredContent.url).toBe(relativeUrl);
        // No scheme/host/port anywhere in the relative path itself.
        expect(result.structuredContent.url).not.toContain('://');
        expect(result.structuredContent.url.startsWith('/')).toBe(true);
        // The result text carries BOTH the resolved absolute URL and the
        // expiry, and tells the reader the relative path works on whatever
        // origin they reach the console on.
        expect(result.text).toContain(result.structuredContent.absoluteUrl);
        expect(result.text).toContain(result.structuredContent.expiresAt);
        expect(result.text).toContain(relativeUrl);
        expect(result.text.toLowerCase()).toContain('different host or port');
      }
    });

    // apra-fleet-i9ag.11.11 NON-LEAKAGE: a sentinel secret value submitted
    // through the onOobSubmit callback must never surface in the tool's own
    // result (text or structuredContent -- both already returned to the
    // caller before the browser ever submits anything) nor in any logged
    // line, including a hypothetical logError call.
    it('never leaks the submitted secret value into the tool result or any log line', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const SENTINEL = 'sentinel-secret-value-does-not-leak-9f3c';
      let capturedSubmit: ((value: string) => { ok: boolean; error?: string }) | undefined;
      vi.mocked(authSocket.collectOobApiKey).mockImplementation(async (_name, _tool, opts: any) => {
        capturedSubmit = opts?.onOobSubmit;
        return { url: '/ui/#/secret-entry/leaktest', expiresAt: '2026-01-01T00:02:00.000Z' };
      });

      const result = await credentialStoreSet({
        name: 'leak_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });

      expect(typeof result).toBe('object');
      if (typeof result === 'object') {
        expect(result.text).not.toContain(SENTINEL);
        expect(JSON.stringify(result.structuredContent)).not.toContain(SENTINEL);
      }

      expect(capturedSubmit).toBeTypeOf('function');
      capturedSubmit!(SENTINEL);

      for (const call of vi.mocked(logHelpers.logLine).mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
      expect(logHelpers.logError).not.toHaveBeenCalled();

      credentialDelete('leak_cred');
    });

    it('returns {url, expiresAt} when return_url: true is passed explicitly, even with a TTY attached', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({
        url: '/ui/#/secret-entry/token123',
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
        expect(result.structuredContent.url).toBe('/ui/#/secret-entry/token123');
      }
      const call = vi.mocked(authSocket.collectOobApiKey).mock.calls[0];
      expect(call[2]).toMatchObject({ returnUrl: true });
    });

    it('the onOobSubmit callback stores the credential exactly like the blocking path does', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      let capturedSubmit: ((value: string) => { ok: boolean; error?: string }) | undefined;
      vi.mocked(authSocket.collectOobApiKey).mockImplementation(async (_name, _tool, opts: any) => {
        capturedSubmit = opts?.onOobSubmit;
        return { url: '/ui/#/secret-entry/x', expiresAt: '2026-01-01T00:02:00.000Z' };
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

  // apra-fleet-i9ag.11.9 review follow-up: the bead's headline behaviours
  // (APRA_FLEET_CONSOLE_BASE_URL precedence/trailing-slash stripping, and a
  // loud [FAIL] on a bad value) were exercised only through
  // src/paths.ts's own resolveConsoleBaseUrl in review, never through this
  // tool -- pin them here since credentialStoreSet is the one caller that
  // turns a bad value into a user-visible result.
  describe('resolveConsoleBaseUrl integration (APRA_FLEET_CONSOLE_BASE_URL)', () => {
    const originalBaseUrl = process.env.APRA_FLEET_CONSOLE_BASE_URL;

    afterEach(() => {
      if (originalBaseUrl === undefined) {
        delete process.env.APRA_FLEET_CONSOLE_BASE_URL;
      } else {
        process.env.APRA_FLEET_CONSOLE_BASE_URL = originalBaseUrl;
      }
    });

    it('honours APRA_FLEET_CONSOLE_BASE_URL, stripping a trailing slash, when rendering absoluteUrl', async () => {
      process.env.APRA_FLEET_CONSOLE_BASE_URL = 'https://console.example.com:9443/';
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      vi.mocked(authSocket.collectOobApiKey).mockResolvedValue({
        url: '/ui/#/secret-entry/abc123',
        expiresAt: '2026-01-01T00:02:00.000Z',
      });

      const result = await credentialStoreSet({
        name: 'env_base_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });

      expect(typeof result).toBe('object');
      if (typeof result === 'object') {
        // No double slash from the stripped trailing slash on the env var
        // meeting the leading slash on the console-relative path.
        expect(result.structuredContent.absoluteUrl).toBe('https://console.example.com:9443/ui/#/secret-entry/abc123');
        expect(result.text).toContain('https://console.example.com:9443/ui/#/secret-entry/abc123');
        expect(result.text).toContain('APRA_FLEET_CONSOLE_BASE_URL');
      }
    });

    // apra-fleet-i9ag.11.18/.20: a reverse-proxy sub-path in the base must be
    // JOINED with the console-relative path, not silently discarded by plain
    // `new URL(relative, base)` resolution (see joinConsoleUrl in src/paths.ts).
    it('preserves a reverse-proxy sub-path when joining the base with the console-relative url', async () => {
      process.env.APRA_FLEET_CONSOLE_BASE_URL = 'https://fleet.example.com/fleet';
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const SENTINEL = 'sentinel-subpath-secret-does-not-leak-4d1e';
      let capturedSubmit: ((value: string) => { ok: boolean; error?: string }) | undefined;
      vi.mocked(authSocket.collectOobApiKey).mockImplementation(async (_name, _tool, opts: any) => {
        capturedSubmit = opts?.onOobSubmit;
        return { url: '/ui/#/secret-entry/abc123', expiresAt: '2026-01-01T00:02:00.000Z' };
      });

      const result = await credentialStoreSet({
        name: 'subpath_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });

      expect(typeof result).toBe('object');
      if (typeof result === 'object') {
        expect(result.structuredContent.absoluteUrl).toBe('https://fleet.example.com/fleet/ui/#/secret-entry/abc123');
        expect(result.text).toContain('https://fleet.example.com/fleet/ui/#/secret-entry/abc123');
        // structuredContent.url stays console-relative regardless of the
        // sub-path join applied to absoluteUrl.
        expect(result.structuredContent.url).toBe('/ui/#/secret-entry/abc123');
        expect(result.text).not.toContain(SENTINEL);
        expect(JSON.stringify(result.structuredContent)).not.toContain(SENTINEL);
      }

      expect(capturedSubmit).toBeTypeOf('function');
      capturedSubmit!(SENTINEL);
      for (const call of vi.mocked(logHelpers.logLine).mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
    });

    it('produces the identical absolute URL when the sub-path base has a trailing slash, with no "//" after the scheme', async () => {
      process.env.APRA_FLEET_CONSOLE_BASE_URL = 'https://fleet.example.com/fleet/';
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const SENTINEL = 'sentinel-subpath-trailing-secret-does-not-leak-7b2a';
      let capturedSubmit: ((value: string) => { ok: boolean; error?: string }) | undefined;
      vi.mocked(authSocket.collectOobApiKey).mockImplementation(async (_name, _tool, opts: any) => {
        capturedSubmit = opts?.onOobSubmit;
        return { url: '/ui/#/secret-entry/abc123', expiresAt: '2026-01-01T00:02:00.000Z' };
      });

      const result = await credentialStoreSet({
        name: 'subpath_trailing_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });

      expect(typeof result).toBe('object');
      if (typeof result === 'object') {
        expect(result.structuredContent.absoluteUrl).toBe('https://fleet.example.com/fleet/ui/#/secret-entry/abc123');
        expect(result.text).toContain('https://fleet.example.com/fleet/ui/#/secret-entry/abc123');
        expect(result.structuredContent.url).toBe('/ui/#/secret-entry/abc123');
        // No double slash anywhere after the scheme's own '//', proving the
        // trailing slash on the base did not collide with the leading slash
        // on the console-relative path.
        const afterScheme = result.structuredContent.absoluteUrl.replace(/^https:\/\//, '');
        expect(afterScheme).not.toContain('//');
        expect(result.text).not.toContain(SENTINEL);
        expect(JSON.stringify(result.structuredContent)).not.toContain(SENTINEL);
      }

      expect(capturedSubmit).toBeTypeOf('function');
      capturedSubmit!(SENTINEL);
      for (const call of vi.mocked(logHelpers.logLine).mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
    });

    it('fails loudly, naming the variable, on a malformed APRA_FLEET_CONSOLE_BASE_URL -- never falls through to a guessed origin', async () => {
      process.env.APRA_FLEET_CONSOLE_BASE_URL = 'not-a-url';
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const result = await credentialStoreSet({
        name: 'bad_base_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });

      expect(typeof result).toBe('string');
      expect(result).toContain('[FAIL]');
      expect(result).toContain('APRA_FLEET_CONSOLE_BASE_URL');
      expect(result).toContain('not-a-url');
      // Fails before ever registering a secret-entry token nobody could open.
      expect(authSocket.collectOobApiKey).not.toHaveBeenCalled();
    });

    it('fails loudly on a non-http/https scheme -- never falls through to a guessed origin', async () => {
      process.env.APRA_FLEET_CONSOLE_BASE_URL = 'ftp://example.com';
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const result = await credentialStoreSet({
        name: 'ftp_base_cred',
        prompt: 'Enter key:',
        persist: false,
        network_policy: 'confirm',
        members: '*',
      });

      expect(typeof result).toBe('string');
      expect(result).toContain('[FAIL]');
      expect(result).toContain('APRA_FLEET_CONSOLE_BASE_URL');
      expect(authSocket.collectOobApiKey).not.toHaveBeenCalled();
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


