/**
 * Deterministic fake embedder for KB vector tests: a hashed bag of words into
 * a fixed number of dims, L2-normalized. Satisfies EmbedderLike, so it plugs
 * into SqliteProvider.attachEmbedder with no model download. hold() makes the
 * next embedDocuments calls wait until the returned release() runs, to prove a
 * capture never waits for its embedding.
 */
import { createHash } from 'node:crypto';
import type { EmbedderLike } from '../../src/services/knowledge/embedding/embed-queue.js';

export function hashedBagOfWords(text: string, dims: number, salt = ''): Float32Array {
  const v = new Float32Array(dims);
  for (const w of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    const h = createHash('sha256').update(salt + w).digest();
    v[h.readUInt32LE(0) % dims] += (h[4] & 1) === 0 ? 1 : -1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

export class FakeEmbedder implements EmbedderLike {
  calls: string[][] = [];
  private gate: Promise<void> | null = null;
  private failure: string | null = null;

  constructor(
    readonly modelId: string,
    readonly revision = 'r1',
    readonly dims = 64,
    readonly tokenLimit = 512,
  ) {}

  get state(): { state: string; reason?: string } {
    return this.failure !== null
      ? { state: 'failed', reason: this.failure }
      : { state: 'ready' };
  }

  /** Hold every embedDocuments call until release() is called. */
  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>(r => { release = r; });
    return () => { this.gate = null; release(); };
  }

  /** Move to the failed state (embedDocuments then resolves null). */
  fail(reason: string): void {
    this.failure = reason;
  }

  embed(text: string): Float32Array {
    return hashedBagOfWords(text, this.dims, this.modelId);
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[] | null> {
    this.calls.push(texts);
    if (this.gate) await this.gate;
    if (this.failure !== null) return null;
    return texts.map(t => this.embed(t));
  }
}

/** Resolve once cond() holds (polls every 2 ms), or throw after timeoutMs. */
export async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(r => setTimeout(r, 2));
  }
}
