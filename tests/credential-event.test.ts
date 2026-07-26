import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import {
  getSocketPath,
  ensureAuthSocket,
  createPendingAuth,
  cleanupAuthSocket,
  waitForPassword,
} from '../src/services/auth-socket.js';
import { fleetEvents } from '../src/services/event-bus.js';

describe('credential-event', () => {
  afterEach(async () => {
    await cleanupAuthSocket();
    fleetEvents.removeAllListeners();
    vi.restoreAllMocks();
  });

  describe('credential:stored event emission', () => {
    it('emits credential:stored event when OOB password is delivered', async () => {
      await ensureAuthSocket();
      createPendingAuth('web1');

      const emitSpy = vi.spyOn(fleetEvents, 'emit');
      const sockPath = getSocketPath();

      // Start waiting for the password (creates a waiter)
      const passwordPromise = waitForPassword('web1', 5000);

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
          client.destroy();
          resolve();
        });
        client.on('error', (err) => {
          client.destroy();
          reject(err);
        });
      });

      // Wait for the password to be resolved
      const pw = await passwordPromise;
      expect(pw).toBeTruthy();

      expect(emitSpy).toHaveBeenCalledWith('credential:stored', { name: 'web1' });
    });

    it('emits credential:stored with correct member name', async () => {
      await ensureAuthSocket();
      const memberName = 'prod-database';
      createPendingAuth(memberName);

      const emitSpy = vi.spyOn(fleetEvents, 'emit');
      const sockPath = getSocketPath();

      // Start waiting for the password (creates a waiter)
      const passwordPromise = waitForPassword(memberName, 5000);

      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sockPath, () => {
          client.write(JSON.stringify({ type: 'auth', member_name: memberName, password: 'pw123' }) + '\n');
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

      // Wait for the password to be resolved
      const pw = await passwordPromise;
      expect(pw).toBeTruthy();

      const calls = emitSpy.mock.calls.filter((call) => call[0] === 'credential:stored');
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual({ name: memberName });
    });

    it('emits credential:stored only on successful password delivery', async () => {
      await ensureAuthSocket();
      createPendingAuth('web1');

      const emitSpy = vi.spyOn(fleetEvents, 'emit');
      const sockPath = getSocketPath();

      // Send invalid message (no pending auth for 'unknown')
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(sockPath, () => {
          client.write(JSON.stringify({ type: 'auth', member_name: 'unknown', password: 'pw' }) + '\n');
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

      // Should not emit for invalid/failed delivery
      const credentialCalls = emitSpy.mock.calls.filter((call) => call[0] === 'credential:stored');
      expect(credentialCalls).toHaveLength(0);
    });
  });
});
