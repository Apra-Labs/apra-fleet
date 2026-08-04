import { describe, it, expect } from 'vitest';
import { parsePackJson } from '../scripts/check-pack-size.mjs';

// Tests for apra-fleet-0v0.2: harden scripts/check-pack-size.mjs's JSON
// extraction against a leading '[' in lifecycle-script stdout.

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
