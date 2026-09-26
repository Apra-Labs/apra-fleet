/**
 * Hub-brokered file transfer (apra-fleet-us9.12): unit tests for
 * sendFileOverRelay/createFileTransferReceiver against injected fake
 * transport (no real hub). See tests/hub-service/file-transfer-e2e.test.ts
 * for the real-HTTP/real-pg-mem round trip proving correlation_id and
 * origin_member_id actually flow through the real hub pipeline.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  sendFileOverRelay,
  createFileTransferReceiver,
  type FileTransferDeps,
  type FileTransferReceiverDeps,
  type OutboundFileEnvelope,
} from '../src/services/file-transfer-relay.js';
import { PendingRelayRequests } from '../src/services/relay-request.js';
import type { InboundRelayEnvelope } from '../src/services/hub-client.js';

function baseDeps(overrides: Partial<FileTransferDeps> = {}): FileTransferDeps {
  return {
    workspaceId: 'ws-1',
    originMemberId: 'sender-member',
    submitEnvelope: async () => ({ ok: true, status: 202 }),
    now: () => Date.now(),
    generateEnvelopeId: (() => { let n = 0; return () => `env-${++n}`; })(),
    ...overrides,
  };
}

describe('sendFileOverRelay', () => {
  it('chunks a small file into one envelope and resolves once the correlated result arrives', async () => {
    const registry = new PendingRelayRequests();
    const submitted: OutboundFileEnvelope[] = [];
    const deps = baseDeps({ submitEnvelope: async (env) => { submitted.push(env); return { ok: true, status: 202 }; } });

    const sendPromise = sendFileOverRelay(deps, registry, Buffer.from('hello'), 'target-member', '/tmp/dest.txt', 5000, 1024);
    await vi.waitFor(() => expect(submitted.length).toBeGreaterThan(0));

    const transferId = submitted[0].correlation_id!;
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      workspace_id: 'ws-1', kind: 'file_transfer.chunk',
      from: { machine_id: null, member_id: 'sender-member' },
      to: { machine_id: null, member_id: 'target-member' },
    });
    expect((submitted[0].payload as any).dest_path).toBe('/tmp/dest.txt');

    registry.resolveFromEnvelope({ correlation_id: transferId, payload: { status: 'ok', bytes: 5 } });
    await expect(sendPromise).resolves.toEqual({ status: 'ok', bytes: 5 });
  });

  it('splits a large file into multiple ordered chunk envelopes, all sharing the same transfer correlation_id', async () => {
    const registry = new PendingRelayRequests();
    const submitted: OutboundFileEnvelope[] = [];
    const deps = baseDeps({ submitEnvelope: async (env) => { submitted.push(env); return { ok: true, status: 202 }; } });

    const data = Buffer.from('y'.repeat(5000));
    const sendPromise = sendFileOverRelay(deps, registry, data, 'target-member', '/tmp/big.bin', 5000, 1000);
    await vi.waitFor(() => expect(submitted.length).toBeGreaterThanOrEqual(5));

    const transferId = submitted[0].correlation_id;
    expect(submitted.every((e) => e.correlation_id === transferId)).toBe(true);
    expect(submitted.map((e) => (e.payload as any).index)).toEqual([0, 1, 2, 3, 4]);

    registry.resolveFromEnvelope({ correlation_id: transferId, payload: { status: 'ok' } });
    await expect(sendPromise).resolves.toEqual({ status: 'ok' });
  });

  it('rejects immediately if a chunk submission fails partway through', async () => {
    const registry = new PendingRelayRequests();
    let calls = 0;
    const deps = baseDeps({ submitEnvelope: async () => { calls++; return calls === 2 ? { ok: false, status: 500 } : { ok: true, status: 202 }; } });

    const data = Buffer.from('z'.repeat(3000));
    await expect(sendFileOverRelay(deps, registry, data, 'target-member', '/tmp/x', 5000, 1000))
      .rejects.toThrow(/Failed to submit file_transfer\.chunk/);
    expect(registry.size).toBe(0);
  });
});

describe('createFileTransferReceiver', () => {
  function baseReceiverDeps(overrides: Partial<FileTransferReceiverDeps> = {}): FileTransferReceiverDeps {
    return {
      ...baseDeps(),
      originMemberId: 'receiver-member',
      writeFile: vi.fn(async () => {}),
      ...overrides,
    };
  }

  function chunkEnvelope(transferId: string, index: number, total: number, dataBase64: string, sha256: string, originMemberId = 'sender-member'): InboundRelayEnvelope {
    return {
      envelope_id: `chunk-${index}`,
      kind: 'file_transfer.chunk',
      payload: { transfer_id: transferId, index, total, data_base64: dataBase64, sha256, dest_path: '/tmp/received.txt' },
      target_member_id: 'receiver-member',
      origin_member_id: originMemberId,
    };
  }

  it('buffers chunks, writes the file once complete, and posts a file_transfer.result back to the sender', async () => {
    const data = Buffer.from('hello file transfer');
    const b64 = data.toString('base64');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(data).digest('hex');

    const writeFile = vi.fn(async () => {});
    const submitted: OutboundFileEnvelope[] = [];
    const deps = baseReceiverDeps({ writeFile, submitEnvelope: async (env) => { submitted.push(env); return { ok: true, status: 202 }; } });

    const onEnvelope = createFileTransferReceiver(deps);
    await onEnvelope(chunkEnvelope('t-1', 0, 1, b64, sha256));

    expect(writeFile).toHaveBeenCalledWith('/tmp/received.txt', data);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ kind: 'file_transfer.result', correlation_id: 't-1', to: { member_id: 'sender-member' } });
    expect((submitted[0].payload as any).status).toBe('ok');
  });

  it('does not write anything until every chunk has arrived', async () => {
    const data = Buffer.from('a'.repeat(2000));
    const chunk0 = data.subarray(0, 1000).toString('base64');
    const chunk1 = data.subarray(1000).toString('base64');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(data).digest('hex');

    const writeFile = vi.fn(async () => {});
    const deps = baseReceiverDeps({ writeFile, submitEnvelope: async () => ({ ok: true, status: 202 }) });
    const onEnvelope = createFileTransferReceiver(deps);

    await onEnvelope(chunkEnvelope('t-2', 0, 2, chunk0, sha256));
    expect(writeFile).not.toHaveBeenCalled();

    await onEnvelope(chunkEnvelope('t-2', 1, 2, chunk1, sha256));
    expect(writeFile).toHaveBeenCalledWith('/tmp/received.txt', data);
  });

  it('reports a corrupt result (never writes) when the reassembled data does not match sha256', async () => {
    const data = Buffer.from('trustworthy data');
    const b64 = data.toString('base64');

    const writeFile = vi.fn(async () => {});
    const submitted: OutboundFileEnvelope[] = [];
    const deps = baseReceiverDeps({ writeFile, submitEnvelope: async (env) => { submitted.push(env); return { ok: true, status: 202 }; } });
    const onEnvelope = createFileTransferReceiver(deps);

    await onEnvelope(chunkEnvelope('t-3', 0, 1, b64, '0'.repeat(64)));

    expect(writeFile).not.toHaveBeenCalled();
    expect((submitted[0].payload as any).status).toBe('corrupt');
  });

  it('ignores envelope kinds other than file_transfer.chunk', async () => {
    const deps = baseReceiverDeps();
    const onEnvelope = createFileTransferReceiver(deps);
    await onEnvelope({ envelope_id: 'e1', kind: 'execute_command.request', payload: {}, target_member_id: 'receiver-member' });
    // No throw, no-op -- nothing to assert beyond "did not crash".
  });
});
