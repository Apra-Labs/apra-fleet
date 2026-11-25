// createStreamRedactor (src/utils/redact-secret.ts): a secret split across
// chunks at any position is still redacted, and text that cannot start the
// secret is written at once (streaming, not buffered to the end).
import { describe, it, expect } from 'vitest';
import { createStreamRedactor, redactSecret } from '../src/utils/redact-secret.js';

const SECRET = 'ghs_FAKEtokenVALUE123';
const MARK = '[X]';

function run(chunks: Array<string | Buffer>): { out: string; writes: string[] } {
  const writes: string[] = [];
  const r = createStreamRedactor(SECRET, MARK, s => { writes.push(s); });
  for (const c of chunks) r.push(c);
  r.end();
  return { out: writes.join(''), writes };
}

describe('createStreamRedactor', () => {
  it('redacts the secret split at every position across two chunks', () => {
    const text = `a ${SECRET} b ${SECRET}`;
    for (let i = 0; i <= text.length; i++) {
      expect(run([text.slice(0, i), text.slice(i)]).out).toBe(`a ${MARK} b ${MARK}`);
    }
  });

  it('writes text that cannot start the secret immediately; holds only a possible prefix', () => {
    const writes: string[] = [];
    const r = createStreamRedactor(SECRET, MARK, s => { writes.push(s); });
    r.push('prompt> ');
    expect(writes.join('')).toBe('prompt> ');
    r.push('x ghs_FA');
    expect(writes.join('')).toBe('prompt> x ');
    r.push('Z');
    expect(writes.join('')).toBe('prompt> x ghs_FAZ');
    r.end();
  });

  it('does not split a multi-byte character across Buffer chunks', () => {
    const buf = Buffer.from(`caf\u00e9 ${SECRET}`);
    expect(run([buf.subarray(0, 4), buf.subarray(4)]).out).toBe(`caf\u00e9 ${MARK}`);
  });

  it('redactSecret counts and replaces exact values; an empty secret is a no-op', () => {
    expect(redactSecret(`${SECRET}/${SECRET}`, SECRET, MARK)).toEqual({ text: `${MARK}/${MARK}`, count: 2 });
    expect(redactSecret('abc', '', MARK)).toEqual({ text: 'abc', count: 0 });
  });
});
