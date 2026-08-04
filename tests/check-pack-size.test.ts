import { describe, it, expect } from 'vitest';
import { parsePackJson, parseThresholdFlag } from '../scripts/check-pack-size.mjs';

// Tests for apra-fleet-0v0.2: harden scripts/check-pack-size.mjs's JSON
// extraction against a leading '[' in lifecycle-script stdout.
//
// Also apra-fleet-0v0.3: check-pack-size.mjs accepts the '--threshold=N'
// equals form (not just space-separated) and fails loudly rather than
// silently falling back to DEFAULT_THRESHOLD_BYTES when an explicitly
// supplied threshold is unparseable/non-positive.

describe('parsePackJson', () => {
  it('parses a clean JSON array with no lifecycle-script noise', () => {
    const entry = parsePackJson('[{"unpackedSize":5000}]');
    expect(entry.unpackedSize).toBe(5000);
  });

  it('apra-fleet-0v0.2: tolerates a leading "[" inside lifecycle-script stdout noise before the real array', () => {
    // Regression case from the bead: a prepare-script console.log using the
    // CLAUDE.md-mandated '[OK]' ASCII checkmark contains a bare '[' before
    // the real JSON array -- the old first-'['-to-last-']' scan would slice
    // from that noise and fail to parse.
    const raw = '[OK] hi\n[{"unpackedSize":5}]';
    const entry = parsePackJson(raw);
    expect(entry.unpackedSize).toBe(5);
  });

  it('tolerates multiple bracket-noise lines before the real array', () => {
    const raw = '[OK] install-hooks: installed pre-commit\n[WARN] something [nested]\n[{"unpackedSize":12345,"name":"apra-fleet"}]';
    const entry = parsePackJson(raw);
    expect(entry.unpackedSize).toBe(12345);
  });

  it('throws when no JSON array can be located at all', () => {
    expect(() => parsePackJson('no brackets here')).toThrow(/could not locate a JSON array/);
  });

  it('throws when nothing in the input parses as a usable JSON array', () => {
    expect(() => parsePackJson('[OK] hi\n[not json]')).toThrow();
  });

  it('throws on an empty array', () => {
    expect(() => parsePackJson('[]')).toThrow(/non-empty JSON array/);
  });

  it('throws when the first entry lacks a numeric unpackedSize', () => {
    expect(() => parsePackJson('[{"name":"apra-fleet"}]')).toThrow(/unpackedSize/);
  });

  it('throws on empty/whitespace-only input', () => {
    expect(() => parsePackJson('')).toThrow(/empty input/);
    expect(() => parsePackJson('   ')).toThrow(/empty input/);
  });
});

describe('parseThresholdFlag', () => {
  it('returns undefined when --threshold is not present', () => {
    expect(parseThresholdFlag([])).toBeUndefined();
    expect(parseThresholdFlag(['-'])).toBeUndefined();
  });

  it('accepts the space-separated form', () => {
    expect(parseThresholdFlag(['--threshold', '5000000'])).toBe(5000000);
  });

  it('apra-fleet-0v0.3: accepts the "=" form', () => {
    expect(parseThresholdFlag(['--threshold=5000000'])).toBe(5000000);
  });

  it('throws (does not silently fall back) on a non-numeric value in either form', () => {
    expect(() => parseThresholdFlag(['--threshold', 'abc'])).toThrow(/invalid --threshold value/);
    expect(() => parseThresholdFlag(['--threshold=abc'])).toThrow(/invalid --threshold value/);
  });

  it('throws on a non-positive value in either form', () => {
    expect(() => parseThresholdFlag(['--threshold', '0'])).toThrow(/invalid --threshold value/);
    expect(() => parseThresholdFlag(['--threshold=-5'])).toThrow(/invalid --threshold value/);
  });
});
