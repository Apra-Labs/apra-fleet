/**
 * RelayStrategy (apra-fleet-jfn): proves getStrategy() dispatches to it for
 * agentType 'relay', and that execCommand/testConnection actually round
 * trip through the real relay-request.ts machinery (submitAndAwaitResult +
 * PendingRelayRequests), addressed via relay-context.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStrategy } from '../src/services/strategy.js';
import { RelayStrategy } from '../src/services/relay-strategy.js';
import { setRelayContext, getRelayContext } from '../src/services/relay-context.js';
import { PendingRelayRequests } from '../src/services/relay-request.js';
import type { Agent } from '../src/types.js';

function makeRelayAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'relay-1',
    friendlyName: 'relay-agent',
    agentType: 'relay',
    relayMemberId: 'hub-member-1',
    workFolder: '/home/relay/project',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('getStrategy dispatch', () => {
  it('returns a RelayStrategy instance for agentType relay', () => {
    const strategy = getStrategy(makeRelayAgent());
    expect(strategy).toBeInstanceOf(RelayStrategy);
  });
});

describe('RelayStrategy', () => {
  afterEach(() => setRelayContext(null));

  it('throws a clear error when no relay context is configured (not running in spoke mode)', async () => {
    setRelayContext(null);
    const strategy = new RelayStrategy(makeRelayAgent());
    await expect(strategy.execCommand('ls')).rejects.toThrow(/not running in spoke mode/);
  });

  it('throws a clear error when the agent has no relayMemberId configured', async () => {
    setRelayContext({
      deps: { workspaceId: 'ws-1', originMemberId: 'me', submitEnvelope: async () => ({ ok: true, status: 202 }), now: () => Date.now() },
      registry: new PendingRelayRequests(),
    });
    const strategy = new RelayStrategy(makeRelayAgent({ relayMemberId: undefined }));
    await expect(strategy.execCommand('ls')).rejects.toThrow(/no relayMemberId configured/);
  });

  it('execCommand submits execute_command.request and resolves with stdout/stderr/code on success', async () => {
    const submitted: any[] = [];
    const registry = new PendingRelayRequests();
    setRelayContext({
      deps: {
        workspaceId: 'ws-1', originMemberId: 'me',
        submitEnvelope: async (env) => { submitted.push(env); return { ok: true, status: 202 }; },
        now: () => Date.now(),
      },
      registry,
    });

    const strategy = new RelayStrategy(makeRelayAgent());
    const resultPromise = strategy.execCommand('echo hi', 5000);

    await vi.waitFor(() => expect(submitted.length).toBeGreaterThan(0));
    expect(submitted[0]).toMatchObject({ kind: 'execute_command.request', to: { member_id: 'hub-member-1' } });
    expect((submitted[0].payload as any).command).toBe('echo hi');

    getRelayContext()!.registry.resolveFromEnvelope({
      correlation_id: submitted[0].envelope_id,
      payload: { status: 'ok', stdout: 'hi\n', stderr: '', code: 0 },
    });

    await expect(resultPromise).resolves.toEqual({ stdout: 'hi\n', stderr: '', code: 0 });
  });

  it('execCommand rejects with the relayed error status when the fulfilling spoke reports failure', async () => {
    const submitted: any[] = [];
    const registry = new PendingRelayRequests();
    setRelayContext({
      deps: {
        workspaceId: 'ws-1', originMemberId: 'me',
        submitEnvelope: async (env) => { submitted.push(env); return { ok: true, status: 202 }; },
        now: () => Date.now(),
      },
      registry,
    });

    const strategy = new RelayStrategy(makeRelayAgent());
    const resultPromise = strategy.execCommand('boom', 5000);
    await vi.waitFor(() => expect(submitted.length).toBeGreaterThan(0));

    registry.resolveFromEnvelope({ correlation_id: submitted[0].envelope_id, payload: { status: 'member_not_found' } });
    await expect(resultPromise).rejects.toThrow(/member_not_found/);
  });

  it('receiveFiles/deleteFiles are honest about not being supported yet (no pull-direction wire-protocol kind exists)', async () => {
    const strategy = new RelayStrategy(makeRelayAgent());
    await expect(strategy.receiveFiles(['a'], '/tmp')).rejects.toThrow(/not yet supported/);
    await expect(strategy.deleteFiles(['a'])).rejects.toThrow(/not yet supported/);
  });

  it('transferFiles (apra-fleet-8yn) requires a relay context, same as execCommand', async () => {
    const strategy = new RelayStrategy(makeRelayAgent());
    await expect(strategy.transferFiles(['a'])).rejects.toThrow(/not running in spoke mode/);
  });

  it('transferFiles reports success for each file sent, and per-file failure without throwing', async () => {
    const submitted: any[] = [];
    const registry = new PendingRelayRequests();
    setRelayContext({
      deps: {
        workspaceId: 'ws-1', originMemberId: 'me',
        submitEnvelope: async (env) => { submitted.push(env); return { ok: true, status: 202 }; },
        now: () => Date.now(),
      },
      registry,
    });

    const tmpFile = path.join(os.tmpdir(), `relay-strategy-transfer-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'test content');
    try {
      const strategy = new RelayStrategy(makeRelayAgent());
      const transferPromise = strategy.transferFiles([tmpFile]);

      await vi.waitFor(() => expect(submitted.length).toBeGreaterThan(0));
      const transferId = submitted[0].correlation_id;
      getRelayContext()!.registry.resolveFromEnvelope({ correlation_id: transferId, payload: { status: 'ok', bytes: 12 } });

      const result = await transferPromise;
      expect(result.success).toEqual([path.basename(tmpFile)]);
      expect(result.failed).toEqual([]);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('transferFiles reports a per-file failure without throwing when a local file does not exist', async () => {
    const registry = new PendingRelayRequests();
    setRelayContext({
      deps: {
        workspaceId: 'ws-1', originMemberId: 'me',
        submitEnvelope: async () => ({ ok: true, status: 202 }),
        now: () => Date.now(),
      },
      registry,
    });

    const strategy = new RelayStrategy(makeRelayAgent());
    const result = await strategy.transferFiles([path.join(os.tmpdir(), 'definitely-does-not-exist-12345.txt')]);
    expect(result.success).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });
});
