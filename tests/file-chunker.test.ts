/**
 * File chunking/reassembly (apra-fleet-us9.12), the binary-framing escape
 * hatch docs/hub-spoke-wire-protocol.md section 3.2 names but leaves
 * unspecified. Pure logic, no transport involved.
 */
import { describe, expect, it } from 'vitest';
import { chunkFile, FileReassembler } from '../src/services/file-chunker.js';

describe('chunkFile / FileReassembler', () => {
  it('round-trips a small file (single chunk)', () => {
    const original = Buffer.from('hello relay world');
    const chunked = chunkFile(original, 1024);
    expect(chunked.chunks).toHaveLength(1);

    const reassembler = new FileReassembler();
    for (const chunk of chunked.chunks) reassembler.addChunk(chunk);
    expect(reassembler.isComplete()).toBe(true);

    const result = reassembler.assemble(chunked.sha256);
    expect(result).toEqual({ ok: true, data: original });
  });

  it('round-trips a file spanning multiple chunks', () => {
    const original = Buffer.from('x'.repeat(10_000));
    const chunked = chunkFile(original, 1000);
    expect(chunked.chunks.length).toBeGreaterThan(1);

    const reassembler = new FileReassembler();
    for (const chunk of chunked.chunks) reassembler.addChunk(chunk);
    const result = reassembler.assemble(chunked.sha256);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.equals(original)).toBe(true);
  });

  it('reassembles correctly even when chunks arrive out of order', () => {
    const original = Buffer.from('a'.repeat(5000));
    const chunked = chunkFile(original, 1000);
    const shuffled = [...chunked.chunks].reverse();

    const reassembler = new FileReassembler();
    for (const chunk of shuffled) reassembler.addChunk(chunk);
    const result = reassembler.assemble(chunked.sha256);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.equals(original)).toBe(true);
  });

  it('is not complete until every chunk has arrived', () => {
    const original = Buffer.from('b'.repeat(3000));
    const chunked = chunkFile(original, 1000);
    const reassembler = new FileReassembler();
    for (const chunk of chunked.chunks.slice(0, -1)) reassembler.addChunk(chunk);
    expect(reassembler.isComplete()).toBe(false);
    expect(reassembler.assemble(chunked.sha256)).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('detects corruption via sha256 mismatch, not just returning garbage', () => {
    const original = Buffer.from('integrity check');
    const chunked = chunkFile(original, 1024);
    const reassembler = new FileReassembler();
    for (const chunk of chunked.chunks) reassembler.addChunk(chunk);
    const result = reassembler.assemble('0'.repeat(64));
    expect(result).toEqual({ ok: false, reason: 'hash_mismatch' });
  });

  it('handles an empty file as a single empty chunk', () => {
    const original = Buffer.alloc(0);
    const chunked = chunkFile(original, 1024);
    expect(chunked.chunks).toHaveLength(1);
    const reassembler = new FileReassembler();
    for (const chunk of chunked.chunks) reassembler.addChunk(chunk);
    const result = reassembler.assemble(chunked.sha256);
    expect(result).toEqual({ ok: true, data: original });
  });
});
