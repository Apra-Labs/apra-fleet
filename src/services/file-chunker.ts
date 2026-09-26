/**
 * File chunking/reassembly (apra-fleet-us9.12): the binary/chunked framing
 * escape hatch docs/hub-spoke-wire-protocol.md section 3.2 names but leaves
 * unspecified ("in scope for apra-fleet-us9.12"). Each envelope has a
 * 64 KiB soft cap (section 3.2); base64 expands data by ~33%, so chunks are
 * sized well under that cap to leave room for the envelope's own JSON
 * wrapper (workspace_id, from/to, correlation_id, etc.).
 *
 * Pure, transport-agnostic: this module only knows how to split a Buffer
 * into ordered, integrity-checked chunks and reassemble them -- it has no
 * knowledge of envelopes, the hub, or the wire protocol's kind/TTL
 * conventions (that's file-transfer-relay.ts).
 */
import crypto from 'node:crypto';

/** 48 KiB of raw bytes -> ~64 KiB of base64, safely under the 64 KiB
 *  envelope cap once wrapped in envelope JSON. */
export const DEFAULT_MAX_CHUNK_BYTES = 48 * 1024;

export interface FileChunk {
  transferId: string;
  index: number;
  total: number;
  dataBase64: string;
}

export interface ChunkedFile {
  transferId: string;
  sha256: string;
  totalBytes: number;
  chunks: FileChunk[];
}

export function chunkFile(data: Buffer, maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES, transferId: string = crypto.randomUUID()): ChunkedFile {
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const total = Math.max(1, Math.ceil(data.length / maxChunkBytes));
  const chunks: FileChunk[] = [];
  for (let i = 0; i < total; i++) {
    const slice = data.subarray(i * maxChunkBytes, (i + 1) * maxChunkBytes);
    chunks.push({ transferId, index: i, total, dataBase64: slice.toString('base64') });
  }
  return { transferId, sha256, totalBytes: data.length, chunks };
}

export type ReassembleResult =
  | { ok: true; data: Buffer }
  | { ok: false; reason: 'incomplete' | 'hash_mismatch' };

/**
 * Accumulates chunks (possibly arriving out of order, per
 * wire-protocol.md's per-(workspace,member) FIFO guarantee not being a
 * global ordering guarantee) for ONE transfer, and reassembles once every
 * index 0..total-1 has been seen.
 */
export class FileReassembler {
  private received = new Map<number, Buffer>();
  private total: number | null = null;

  addChunk(chunk: FileChunk): void {
    if (this.total === null) this.total = chunk.total;
    this.received.set(chunk.index, Buffer.from(chunk.dataBase64, 'base64'));
  }

  isComplete(): boolean {
    return this.total !== null && this.received.size === this.total;
  }

  /** Reassembles in index order and verifies against `expectedSha256`. */
  assemble(expectedSha256: string): ReassembleResult {
    if (!this.isComplete() || this.total === null) return { ok: false, reason: 'incomplete' };
    const ordered: Buffer[] = [];
    for (let i = 0; i < this.total; i++) {
      const part = this.received.get(i);
      if (!part) return { ok: false, reason: 'incomplete' };
      ordered.push(part);
    }
    const data = Buffer.concat(ordered);
    const actualSha256 = crypto.createHash('sha256').update(data).digest('hex');
    if (actualSha256 !== expectedSha256) return { ok: false, reason: 'hash_mismatch' };
    return { ok: true, data };
  }
}
