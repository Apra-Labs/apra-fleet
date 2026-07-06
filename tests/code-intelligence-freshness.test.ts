import { describe, it, expect } from 'vitest';
import { freshnessNote } from '../src/tools/code-intelligence-freshness.js';

// ---------------------------------------------------------------------------
// freshnessNote() (F2.2) -- pure comparison function, no IO.
// ---------------------------------------------------------------------------
describe('freshnessNote()', () => {
  it('returns null when lastCommit and head match', () => {
    expect(freshnessNote('abc12345', 'abc12345')).toBeNull();
  });

  it('returns the verbatim note with 8-char truncated SHAs when they differ', () => {
    const note = freshnessNote(
      'aaaaaaaa1111222233334444555566667777',
      'bbbbbbbb111122223333444455556666777788',
    );
    expect(note).toBe(
      "[code-intelligence] index is behind repo HEAD (indexed aaaaaaaa vs HEAD bbbbbbbb). Results may miss recent changes; run 'npx gitnexus analyze' to refresh.",
    );
  });

  it('returns null when lastCommit is undefined', () => {
    expect(freshnessNote(undefined, 'bbbbbbbb111122223333444455556666777788')).toBeNull();
  });

  it('returns null when head is undefined', () => {
    expect(freshnessNote('aaaaaaaa1111222233334444555566667777', undefined)).toBeNull();
  });

  it('returns null when both are undefined', () => {
    expect(freshnessNote(undefined, undefined)).toBeNull();
  });

  it('does not crash on short SHAs (< 8 chars) and includes them verbatim', () => {
    expect(() => freshnessNote('abc', 'xyz')).not.toThrow();
    expect(freshnessNote('abc', 'xyz')).toBe(
      "[code-intelligence] index is behind repo HEAD (indexed abc vs HEAD xyz). Results may miss recent changes; run 'npx gitnexus analyze' to refresh.",
    );
  });

  it('returns null when short SHAs happen to match', () => {
    expect(freshnessNote('abc', 'abc')).toBeNull();
  });
});
