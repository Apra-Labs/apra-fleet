import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import {
  getSocketPath,
  ensureAuthSocket,
  createPendingAuth,
  getPendingPassword,
  hasPendingAuth,
  waitForPassword,
  cleanupAuthSocket,
  collectOobPassword,
  collectOobApiKey,
  hasGraphicalDisplay,
  hasInteractiveDesktop,
  launchAuthTerminal,
} from '../src/services/auth-socket.js';

describe('auth-socket', () => {
  afterEach(async () => {
    await cleanupAuthSocket();
  });

  describe('getSocketPath', () => {
    it('returns a path under FLEET_DIR on non-Windows', () => {
      if (process.platform !== 'win32') {
        const p = getSocketPath();
        expect(p).toContain('auth.sock');
        expect(p).toContain('apra-fleet');
      }
    });

    it('returns a named pipe path on Windows', () => {
      // Can only truly test on Windows, but we can verify the function exists
      expect(typeof getSocketPath()).toBe('string');
    });
  });

  describe('pending auth lifecycle', () => {
    it('creates and checks pending auth', () => {
      createPendingAuth('test-member');
      expect(hasPendingAuth('test-member')).toBe(true);
      expect(hasPendingAuth('other-member')).toBe(false);
    });

    it('returns null for unresolved pending auth', () => {
      createPendingAuth('test-member');
      expect(getPendingPassword('test-member')).toBeNull();
      // Entry should still exist (not consumed since it was unresolved)
      expect(hasPendingAuth('test-member')).toBe(true);
    });

    it('returns null for unknown member', () => {
      expect(getPendingPassword('unknown')).toBeNull();
      expect(hasPendingAuth('unknown')).toBe(false);
    });

    it('replaces old pending request for same member name', () => {
      createPendingAuth('test-member');
      const before = hasPendingAuth('test-member');
      createPendingAuth('test-member'); // replace
      const after = hasPendingAuth('test-member');
      expect(before).toBe(true);
      expect(after).toBe(true);
    });

    it('cleans up on cleanupAuthSocket', async () => {
      createPendingAuth('test-member');
      await cleanupAuthSocket();
      expect(hasPendingAuth('test-member')).toBe(false);
    });
  });

  describe('socket server and client', () => {
    it('starts socket server, accepts auth, and returns encrypted password', async () => {
      await ensureAuthSocket();
      createPendingAuth('web1');

      const sockPath = getSocketPath();

      // Simulate CLI client sending password
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sockPath, () => {
          client.write(JSON.stringify({ type: 'auth', member_name: 'web1', password: 'secret123' }) + '\n');
        });

        let buffer = '';
        client.on('data', (chunk) => {
          buffer += chunk.toString();
          const nl = buffer.indexOf('\n');
          if (nl === -1) return;
          const resp = JSON.parse(buffer.slice(0, nl));
          expect(resp.ok).toBe(true);
          client.end();
          resolve();
        });
        client.on('error', reject);
      });

      // Password should now be resolved (encrypted)
      const encPw = getPendingPassword('web1');
      expect(encPw).not.toBeNull();
      expect(encPw).toContain(':'); // encrypted format is iv:authTag:ciphertext

      // Entry consumed � should be gone
      expect(hasPendingAuth('web1')).toBe(false);
    });

    it('returns error for unknown member name via socket', async () => {
      await ensureAuthSocket();
      // No pending auth created for 'unknown'

      const sockPath = getSocketPath();

      const resp = await new Promise<any>((resolve, reject) => {
        const client = net.connect(sockPath, () => {
          client.write(JSON.stringify({ type: 'auth', member_name: 'unknown', password: 'test' }) + '\n');
        });

        let buffer = '';
        client.on('data', (chunk) => {
          buffer += chunk.toString();
          const nl = buffer.indexOf('\n');
          if (nl === -1) return;
          resolve(JSON.parse(buffer.slice(0, nl)));
          client.end();
        });
        client.on('error', reject);
      });

      expect(resp.ok).toBe(false);
      expect(resp.error).toContain('unknown');
    });

    it('returns error for invalid JSON via socket', async () => {
      await ensureAuthSocket();
      const sockPath = getSocketPath();

      const resp = await new Promise<any>((resolve, reject) => {
        const client = net.connect(sockPath, () => {
          client.write('not json\n');
        });

        let buffer = '';
        client.on('data', (chunk) => {
          buffer += chunk.toString();
          const nl = buffer.indexOf('\n');
          if (nl === -1) return;
          resolve(JSON.parse(buffer.slice(0, nl)));
          client.end();
        });
        client.on('error', reject);
      });

      expect(resp.ok).toBe(false);
      expect(resp.error).toContain('Invalid JSON');
    });

    it('returns error for invalid message format via socket', async () => {
      await ensureAuthSocket();
      const sockPath = getSocketPath();

      const resp = await new Promise<any>((resolve, reject) => {
        const client = net.connect(sockPath, () => {
          client.write(JSON.stringify({ type: 'auth' }) + '\n'); // missing member_name and password
        });

        let buffer = '';
        client.on('data', (chunk) => {
          buffer += chunk.toString();
          const nl = buffer.indexOf('\n');
          if (nl === -1) return;
          resolve(JSON.parse(buffer.slice(0, nl)));
          client.end();
        });
        client.on('error', reject);
      });

      expect(resp.ok).toBe(false);
      expect(resp.error).toContain('Invalid message');
    });

    it('is idempotent � calling ensureAuthSocket twice does not error', async () => {
      await ensureAuthSocket();
      await ensureAuthSocket(); // should be no-op
      createPendingAuth('test');
      expect(hasPendingAuth('test')).toBe(true);
    });

    it('cleans up socket file on close', async () => {
      await ensureAuthSocket();
      const sockPath = getSocketPath();

      if (process.platform !== 'win32') {
        expect(fs.existsSync(sockPath)).toBe(true);
      }

      await cleanupAuthSocket();

      if (process.platform !== 'win32') {
        expect(fs.existsSync(sockPath)).toBe(false);
      }
    });
  });

  describe('TTL expiry', () => {
    it('expires pending auth after TTL', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      createPendingAuth('expired-member');
      expect(hasPendingAuth('expired-member')).toBe(true);

      // Advance past 10-minute TTL
      vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000 + 1);

      expect(hasPendingAuth('expired-member')).toBe(false);
      expect(getPendingPassword('expired-member')).toBeNull();

      vi.restoreAllMocks();
    });
  });

  describe('waitForPassword', () => {
    it('resolves when password arrives via socket', async () => {
      await ensureAuthSocket();
      createPendingAuth('wait-test');

      const sockPath = getSocketPath();

      // Start waiting, then send password after a short delay
      const passwordPromise = waitForPassword('wait-test', 5000);

      await new Promise(r => setTimeout(r, 50));

      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sockPath, () => {
          client.write(JSON.stringify({ type: 'auth', member_name: 'wait-test', password: 'secret' }) + '\n');
        });
        let buffer = '';
        client.on('data', (chunk) => {
          buffer += chunk.toString();
          if (buffer.indexOf('\n') !== -1) { client.end(); resolve(); }
        });
        client.on('error', reject);
      });

      const encPw = await passwordPromise;
      expect(encPw).not.toBeNull();
      expect(encPw).toContain(':'); // iv:authTag:ciphertext
    });

    it('times out when no password arrives', async () => {
      await ensureAuthSocket();
      createPendingAuth('timeout-test');

      await expect(waitForPassword('timeout-test', 100)).rejects.toThrow('timed out');
    });

    it('resolves immediately if password already arrived', async () => {
      await ensureAuthSocket();
      createPendingAuth('fast-test');

      const sockPath = getSocketPath();

      // Send password first
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sockPath, () => {
          client.write(JSON.stringify({ type: 'auth', member_name: 'fast-test', password: 'pw' }) + '\n');
        });
        let buffer = '';
        client.on('data', (chunk) => {
          buffer += chunk.toString();
          if (buffer.indexOf('\n') !== -1) { client.end(); resolve(); }
        });
        client.on('error', reject);
      });

      // Now wait � should resolve immediately since password is already there
      const encPw = await waitForPassword('fast-test', 1000);
      expect(encPw).toContain(':');
    });

    it('rejects when cleanupAuthSocket is called during wait', async () => {
      await ensureAuthSocket();
      createPendingAuth('cleanup-test');

      const passwordPromise = waitForPassword('cleanup-test', 5000);

      await new Promise(r => setTimeout(r, 50));
      await cleanupAuthSocket();

      await expect(passwordPromise).rejects.toThrow('Auth socket closed');
    });
  });

  describe('collectOobPassword', () => {
    afterEach(async () => {
      await cleanupAuthSocket();
    });

    it('returns immediately when pending auth already has password', async () => {
      await ensureAuthSocket();
      createPendingAuth('oob-ready');
      await sendPassword(getSocketPath(), 'oob-ready', 'secret');

      const launchFn = vi.fn();
      const result = await collectOobPassword('oob-ready', 'test_tool', { launchFn });

      expect(launchFn).not.toHaveBeenCalled();
      expect('password' in result).toBe(true);
      if ('password' in result) expect(result.password).toContain(':');
    });

    it('waits and resolves when pending without password', async () => {
      await ensureAuthSocket();
      createPendingAuth('oob-wait');

      const resultPromise = collectOobPassword('oob-wait', 'test_tool');

      await new Promise(r => setTimeout(r, 50));
      await sendPassword(getSocketPath(), 'oob-wait', 'delayed-secret');

      const result = await resultPromise;
      expect('password' in result).toBe(true);
      if ('password' in result) expect(result.password).toContain(':');
    });

    it('returns fallback on timeout', async () => {
      await ensureAuthSocket();
      createPendingAuth('oob-timeout');

      // Use a short waitTimeoutMs so the test doesn't hang for 5 minutes
      const result = await collectOobPassword('oob-timeout', 'test_tool', { waitTimeoutMs: 100 });
      expect('fallback' in result).toBe(true);
      if ('fallback' in result) {
        expect(result.fallback).toContain('timed out');
        expect(result.fallback).toContain('test_tool');
      }
    });

    it('launches terminal and resolves when password arrives', async () => {
      const launchFn = vi.fn().mockReturnValue('launched');

      const resultPromise = collectOobPassword('oob-fresh', 'test_tool', { launchFn });

      await new Promise(r => setTimeout(r, 50));
      await sendPassword(getSocketPath(), 'oob-fresh', 'fresh-secret');

      const result = await resultPromise;
      expect(launchFn).toHaveBeenCalledWith('oob-fresh', [], expect.any(Function));
      expect('password' in result).toBe(true);
      if ('password' in result) expect(result.password).toContain(':');
    });

    it('returns fallback when terminal launch fails', async () => {
      const launchFn = vi.fn().mockReturnValue('fallback:Could not find a terminal emulator');

      const result = await collectOobPassword('oob-noterm', 'test_tool', { launchFn });
      expect('fallback' in result).toBe(true);
      if ('fallback' in result) {
        expect(result.fallback).toContain('Could not find a terminal emulator');
        expect(result.fallback).toContain('test_tool');
      }
    });
  });
  describe('collectOobApiKey', () => {
    afterEach(async () => {
      await cleanupAuthSocket();
    });

    it('launches terminal with --api-key flag', async () => {
      const launchFn = vi.fn().mockReturnValue('launched');

      const resultPromise = collectOobApiKey('api-member', 'provision_llm_auth', { launchFn });

      await new Promise(r => setTimeout(r, 50));
      await sendPassword(getSocketPath(), 'api-member', 'my-api-key');

      const result = await resultPromise;
      expect(launchFn).toHaveBeenCalledWith('api-member', ['--api-key'], expect.any(Function));
      expect('password' in result).toBe(true);
      if ('password' in result) expect(result.password).toContain(':');
    });

    it('returns encrypted key when pending auth already has password', async () => {
      await ensureAuthSocket();
      createPendingAuth('api-ready');
      await sendPassword(getSocketPath(), 'api-ready', 'pre-entered-key');

      const launchFn = vi.fn();
      const result = await collectOobApiKey('api-ready', 'provision_llm_auth', { launchFn });

      expect(launchFn).not.toHaveBeenCalled();
      expect('password' in result).toBe(true);
      if ('password' in result) expect(result.password).toContain(':');
    });

    it('returns fallback on timeout', async () => {
      await ensureAuthSocket();
      createPendingAuth('api-timeout');

      const result = await collectOobApiKey('api-timeout', 'provision_llm_auth', { waitTimeoutMs: 100 });
      expect('fallback' in result).toBe(true);
      if ('fallback' in result) {
        expect(result.fallback).toContain('timed out');
        expect(result.fallback).toContain('provision_llm_auth');
      }
    });

    it('returns fallback when terminal launch fails', async () => {
      const launchFn = vi.fn().mockReturnValue('fallback:Could not find a terminal emulator');

      const result = await collectOobApiKey('api-noterm', 'provision_llm_auth', { launchFn });
      expect('fallback' in result).toBe(true);
      if ('fallback' in result) {
        expect(result.fallback).toContain('Could not find a terminal emulator');
        expect(result.fallback).toContain('provision_llm_auth');
      }
    });

    it('Bug 1: cleans up stale state after fallback so retry launches a fresh terminal', async () => {
      // First call: terminal cannot be launched (fallback path)
      const launchFn = vi.fn().mockReturnValue('fallback:No terminal available');
      const result1 = await collectOobApiKey('retry-cred', 'credential_store_set', { launchFn });
      expect('fallback' in result1).toBe(true);

      // pendingRequests must be cleared so hasPendingAuth returns false on retry
      expect(hasPendingAuth('retry-cred')).toBe(false);

      // Second call: should launch a fresh terminal (not hit the re-entrant guard)
      const launchFn2 = vi.fn().mockReturnValue('launched');
      const result2Promise = collectOobApiKey('retry-cred', 'credential_store_set', { launchFn: launchFn2, waitTimeoutMs: 500 });
      await new Promise(r => setTimeout(r, 50));
      await sendPassword(getSocketPath(), 'retry-cred', 'new-secret');
      const result2 = await result2Promise;

      expect(launchFn2).toHaveBeenCalledOnce();
      expect('password' in result2).toBe(true);
    });

    it('Bug 1: cleans up stale state after cancel so retry launches a fresh terminal', async () => {
      // First call: terminal is launched but user cancels (onExit called with non-zero)
      let capturedOnExit: ((code: number | null) => void) | undefined;
      const launchFn1 = vi.fn().mockImplementation((_name: string, _args: string[], onExit: (code: number | null) => void) => {
        capturedOnExit = onExit;
        return 'launched';
      });
      const result1Promise = collectOobApiKey('cancel-cred', 'credential_store_set', { launchFn: launchFn1, waitTimeoutMs: 5000 });
      // Wait for launchFn to be called (happens after ensureAuthSocket, which may retry on Windows)
      await vi.waitFor(() => { if (!capturedOnExit) throw new Error('launch not yet called'); }, { timeout: 10000 });
      capturedOnExit!(1); // simulate user closing the terminal
      const result1 = await result1Promise;
      expect('fallback' in result1).toBe(true);

      // pendingRequests must be cleared
      expect(hasPendingAuth('cancel-cred')).toBe(false);

      // Second call: should launch a fresh terminal
      const launchFn2 = vi.fn().mockReturnValue('launched');
      const result2Promise = collectOobApiKey('cancel-cred', 'credential_store_set', { launchFn: launchFn2, waitTimeoutMs: 500 });
      await new Promise(r => setTimeout(r, 50));
      await sendPassword(getSocketPath(), 'cancel-cred', 'retry-secret');
      const result2 = await result2Promise;

      expect(launchFn2).toHaveBeenCalledOnce();
      expect('password' in result2).toBe(true);
    });
  });

  describe('hasGraphicalDisplay', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns false when DISPLAY and WAYLAND_DISPLAY are both unset', () => {
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      expect(hasGraphicalDisplay()).toBe(false);
    });

    it('returns true when DISPLAY is set', () => {
      vi.stubEnv('DISPLAY', ':0');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      expect(hasGraphicalDisplay()).toBe(true);
    });

    it('returns true when WAYLAND_DISPLAY is set', () => {
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
      expect(hasGraphicalDisplay()).toBe(true);
    });
  });

  describe('hasInteractiveDesktop', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns false when SESSIONNAME is not Console', () => {
      vi.stubEnv('SESSIONNAME', 'RDP-Tcp#0');
      expect(hasInteractiveDesktop()).toBe(false);
    });

    it('returns false when SESSIONNAME is unset', () => {
      vi.stubEnv('SESSIONNAME', '');
      expect(hasInteractiveDesktop()).toBe(false);
    });

    it('returns true when SESSIONNAME is Console', () => {
      vi.stubEnv('SESSIONNAME', 'Console');
      expect(hasInteractiveDesktop()).toBe(true);
    });
  });

  describe('launchAuthTerminal � headless fallback', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns fallback with member name on Linux when DISPLAY is unset', () => {
      if (process.platform !== 'linux') return;
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      const onExit = vi.fn();
      const result = launchAuthTerminal('my-member', [], onExit);
      expect(result).toMatch(/^fallback:/);
      expect(result).toContain('! apra-fleet auth my-member');
      expect(onExit).not.toHaveBeenCalled();
    });

    it('returns fallback with member name on Windows when SESSIONNAME is not Console', () => {
      if (process.platform !== 'win32') return;
      vi.stubEnv('SESSIONNAME', 'RDP-Tcp#0');
      const onExit = vi.fn();
      const result = launchAuthTerminal('my-member', [], onExit);
      expect(result).toMatch(/^fallback:/);
      expect(result).toContain('! apra-fleet auth my-member');
      expect(onExit).not.toHaveBeenCalled();
    });

    it('returns fallback with actual member name substituted (not a placeholder)', () => {
      if (process.platform !== 'linux') return;
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      const onExit = vi.fn();
      const result = launchAuthTerminal('worker-42', [], onExit);
      expect(result).toContain('worker-42');
      expect(result).not.toContain('<name>');
      expect(result).not.toContain('<member>');
    });
  });
});

function sendPassword(sockPath: string, memberName: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.connect(sockPath, () => {
      client.write(JSON.stringify({ type: 'auth', member_name: memberName, password }) + '\n');
    });
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.indexOf('\n') !== -1) { client.end(); resolve(); }
    });
    client.on('error', reject);
  });
}