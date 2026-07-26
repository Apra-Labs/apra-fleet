/**
 * Hub-brokered file transfer (apra-fleet-us9.12): wire-protocol.md section
 * 3.2's chunked-framing escape hatch, made concrete. Two new envelope
 * kinds -- `file_transfer.chunk` (spoke -> hub -> spoke, one per chunk)
 * and `file_transfer.result` (spoke -> hub -> spoke, one per transfer,
 * `correlation_id` = the transfer_id all of that transfer's chunks share,
 * NOT a single chunk's envelope_id, since a transfer is many envelopes).
 *
 * Reuses src/services/relay-request.ts's PendingRelayRequests /
 * composeEnvelopeHandler unchanged: that registry only cares that
 * `correlation_id` on an inbound envelope matches a previously-`register`ed
 * key, so registering under `transferId` instead of a single envelope_id
 * works without any change to that module.
 *
 * Does NOT reuse SFTP/ssh.ts -- see docs/ssh-relay-migration-inventory.md.
 * Storage on receipt is a plain local file write (deps.writeFile),
 * matching apra-fleet-us9.6's data-ownership constraint (no new
 * persistence layer introduced here; a transferred file is just a file).
 */
import { chunkFile, FileReassembler, DEFAULT_MAX_CHUNK_BYTES, type FileChunk } from './file-chunker.js';
import { PendingRelayRequests } from './relay-request.js';
import type { InboundRelayEnvelope } from './hub-client.js';

export const FILE_TRANSFER_CHUNK_TTL_MS = 30000;
export const FILE_TRANSFER_RESULT_TTL_MS = 60000;

export interface OutboundFileEnvelope {
  envelope_id: string;
  workspace_id: string;
  kind: string;
  from: { machine_id: string | null; member_id: string | null };
  to: { machine_id: string | null; member_id: string | null };
  ts: string;
  ttl_ms: number;
  correlation_id: string | null;
  payload: unknown;
}

export interface FileTransferDeps {
  workspaceId: string;
  originMemberId: string;
  submitEnvelope(envelope: OutboundFileEnvelope): Promise<{ ok: boolean; status: number }>;
  now(): number;
  generateEnvelopeId(): string;
}

interface ChunkPayload {
  transfer_id: string;
  index: number;
  total: number;
  data_base64: string;
  sha256: string;
  dest_path: string;
}

function baseEnvelope(deps: FileTransferDeps, kind: string, targetMemberId: string, correlationId: string | null, ttlMs: number): OutboundFileEnvelope {
  return {
    envelope_id: deps.generateEnvelopeId(),
    workspace_id: deps.workspaceId,
    kind,
    from: { machine_id: null, member_id: deps.originMemberId },
    to: { machine_id: null, member_id: targetMemberId },
    ts: new Date(deps.now()).toISOString(),
    ttl_ms: ttlMs,
    correlation_id: correlationId,
    payload: {},
  };
}

/**
 * Sends a local file to `targetMemberId` (a member on a different machine)
 * over the relay, chunked per file-chunker.ts, and awaits the receiving
 * spoke's `file_transfer.result`. `destPath` is passed through verbatim to
 * the receiver -- resolving/sandboxing it against the target's work folder
 * is the receiver's responsibility (writeFile deps), not this sender's.
 */
export async function sendFileOverRelay(
  deps: FileTransferDeps,
  registry: PendingRelayRequests,
  data: Buffer,
  targetMemberId: string,
  destPath: string,
  timeoutMs: number,
  maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): Promise<unknown> {
  const chunked = chunkFile(data, maxChunkBytes);
  const resultPromise = registry.register(chunked.transferId, timeoutMs);

  for (const chunk of chunked.chunks) {
    const payload: ChunkPayload = {
      transfer_id: chunk.transferId,
      index: chunk.index,
      total: chunk.total,
      data_base64: chunk.dataBase64,
      sha256: chunked.sha256,
      dest_path: destPath,
    };
    const envelope = baseEnvelope(deps, 'file_transfer.chunk', targetMemberId, chunked.transferId, FILE_TRANSFER_CHUNK_TTL_MS);
    envelope.payload = payload;
    const submitted = await deps.submitEnvelope(envelope);
    if (!submitted.ok) {
      const err = new Error(`Failed to submit file_transfer.chunk ${chunk.index}/${chunk.total} (status ${submitted.status})`);
      registry.rejectPending(chunked.transferId, err);
      resultPromise.catch(() => {});
      throw err;
    }
  }

  return resultPromise;
}

export interface FileTransferReceiverDeps extends FileTransferDeps {
  /** Persists the fully-reassembled, hash-verified file. Resolving/
   *  sandboxing destPath against a safe root is this callback's job. */
  writeFile(destPath: string, data: Buffer): Promise<void>;
}

/**
 * Returns a hub-client `onEnvelope`-compatible handler that fulfills
 * `file_transfer.chunk` envelopes: buffers chunks per transfer_id, and once
 * complete, verifies the sha256, writes the file, and posts back a
 * `file_transfer.result` addressed to the sender with correlation_id =
 * transfer_id. Other kinds are a documented no-op (compose with
 * relay-executor.ts's handler via composeEnvelopeHandler/manual chaining
 * for a spoke that fulfills both request types).
 */
export function createFileTransferReceiver(deps: FileTransferReceiverDeps) {
  const inFlight = new Map<string, FileReassembler>();

  return async function onEnvelope(envelope: InboundRelayEnvelope): Promise<void> {
    if (envelope.kind !== 'file_transfer.chunk') return;

    const payload = envelope.payload as Partial<ChunkPayload> | undefined;
    if (
      !payload?.transfer_id || typeof payload.index !== 'number' || typeof payload.total !== 'number'
      || typeof payload.data_base64 !== 'string' || typeof payload.sha256 !== 'string' || typeof payload.dest_path !== 'string'
    ) {
      return;
    }

    const originMemberId = envelope.origin_member_id ?? null;

    let reassembler = inFlight.get(payload.transfer_id);
    if (!reassembler) {
      reassembler = new FileReassembler();
      inFlight.set(payload.transfer_id, reassembler);
    }
    const chunk: FileChunk = { transferId: payload.transfer_id, index: payload.index, total: payload.total, dataBase64: payload.data_base64 };
    reassembler.addChunk(chunk);

    if (!reassembler.isComplete()) return;
    inFlight.delete(payload.transfer_id);

    const assembled = reassembler.assemble(payload.sha256);
    const resultTarget = originMemberId ?? '';
    const result = baseEnvelope(deps, 'file_transfer.result', resultTarget, payload.transfer_id, FILE_TRANSFER_RESULT_TTL_MS);

    if (!assembled.ok) {
      result.payload = { status: assembled.reason === 'hash_mismatch' ? 'corrupt' : 'incomplete' };
      await deps.submitEnvelope(result);
      return;
    }

    try {
      await deps.writeFile(payload.dest_path, assembled.data);
      result.payload = { status: 'ok', bytes: assembled.data.length };
    } catch (err) {
      result.payload = { status: 'error', error: (err as Error).message };
    }
    await deps.submitEnvelope(result);
  };
}
