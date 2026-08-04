import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePackJson,
  parseThresholdFlag,
  parseThresholdArg,
  checkPackSize,
  DEFAULT_THRESHOLD_BYTES,
} from '../scripts/check-pack-size.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-pack-size.mjs');

/** Run check-pack-size.mjs as a child process with fixture JSON on stdin. */
function runScript(args, stdinJson) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args, '-'], {
      input: stdinJson ?? '',
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

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

// apra-fleet-yj1.3: verification for the size guard (yj1.1) and its ci.yml
// wiring (yj1.2) -- exercises checkPackSize's byte-threshold logic directly,
// the parseThresholdArg flag/env/default precedence, and the actual script
// process exit code / stderr for both the size-guard failure path and the
// threshold-parsing failure path.

describe('checkPackSize', () => {
  it('rejects an unpackedSize just above the threshold, message has the byte count and ::error::', () => {
    const result = checkPackSize(10000001, 10000000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('::error::');
    expect(result.message).toContain('10000001');
  });

  it('accepts an unpackedSize just below the threshold, no error emitted', () => {
    const result = checkPackSize(9999999, 10000000);
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain('::error::');
  });

  it('apra-fleet-yj1: regression guard -- a fixture whose human notice scrapes to "4" but whose real unpackedSize exceeds the threshold is rejected', () => {
    // Old buggy behavior: `npm pack`'s human-readable notice reads
    // 'unpacked size: 41.2 MB', and `grep -oE '[0-9]+'` on that text matched
    // only the leading '4' of '41.2' -- so `4 -gt 10000000` never fired. The
    // real byte count here is well over the default 10MB threshold and MUST
    // be rejected by the real-JSON-based guard.
    const fixture = '[{"name":"apra-fleet","size":"12.3 MB","unpackedSize":41200000}]';
    const entry = parsePackJson(fixture);
    expect(entry.unpackedSize).toBe(41200000);
    const result = checkPackSize(entry.unpackedSize, DEFAULT_THRESHOLD_BYTES);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('::error::');
    expect(result.message).toContain('41200000');
  });
});

describe('parseThresholdArg', () => {
  it('apra-fleet-yj1.3: equals form is honored, not silently ignored in favor of the default', () => {
    expect(parseThresholdArg(['--threshold=5000000'])).toBe(5000000);
  });

  it('space-separated form still works', () => {
    expect(parseThresholdArg(['--threshold', '5000000'])).toBe(5000000);
  });

  it('returns undefined when the flag is absent so env/default fallback can apply', () => {
    const saved = process.env.PACK_SIZE_THRESHOLD;
    delete process.env.PACK_SIZE_THRESHOLD;
    try {
      expect(parseThresholdFlag([])).toBeUndefined();
      expect(parseThresholdArg([])).toBe(DEFAULT_THRESHOLD_BYTES);
    } finally {
      if (saved === undefined) delete process.env.PACK_SIZE_THRESHOLD;
      else process.env.PACK_SIZE_THRESHOLD = saved;
    }
  });

  it('throws (does not silently fall back to the default) on an explicitly supplied bad value', () => {
    expect(() => parseThresholdArg(['--threshold', 'abc'])).toThrow(/invalid --threshold value/);
    expect(() => parseThresholdArg(['--threshold=abc'])).toThrow(/invalid --threshold value/);
    expect(() => parseThresholdArg(['--threshold=0'])).toThrow(/invalid --threshold value/);
    expect(() => parseThresholdArg(['--threshold=-1'])).toThrow(/invalid --threshold value/);
  });
});

describe('malformed/empty/missing-unpackedSize JSON fails loudly (not a silent pass)', () => {
  it('empty input throws', () => {
    expect(() => parsePackJson('')).toThrow();
  });

  it('non-JSON input throws', () => {
    expect(() => parsePackJson('this is not json at all')).toThrow();
  });

  it('JSON array missing unpackedSize on its first entry throws', () => {
    expect(() => parsePackJson('[{"name":"apra-fleet","size":"1 kB"}]')).toThrow(/unpackedSize/);
  });

  it('empty JSON array throws rather than defaulting to a passing size', () => {
    expect(() => parsePackJson('[]')).toThrow();
  });
});

describe('check-pack-size.mjs script process behavior (fixture stdin, no npm pack invocation)', () => {
  it('exits non-zero and prints ::error:: with the byte count for an oversized fixture', () => {
    const fixture = JSON.stringify([{ name: 'apra-fleet', unpackedSize: 10000001 }]);
    const { status, stderr } = runScript([], fixture);
    expect(status).not.toBe(0);
    expect(stderr).toContain('::error::');
    expect(stderr).toContain('10000001');
  });

  it('exits 0 with no ::error:: for a fixture below the threshold', () => {
    const fixture = JSON.stringify([{ name: 'apra-fleet', unpackedSize: 9999999 }]);
    const { status, stdout, stderr } = runScript([], fixture);
    expect(status).toBe(0);
    expect(stderr).not.toContain('::error::');
    expect(stdout).toContain('9999999');
  });

  it('regression fixture (scrapes to "4", real size over threshold) is rejected by the script', () => {
    const fixture = JSON.stringify([{ name: 'apra-fleet', size: '41.2 MB', unpackedSize: 41200000 }]);
    const { status, stderr } = runScript([], fixture);
    expect(status).not.toBe(0);
    expect(stderr).toContain('::error::');
  });

  it('malformed JSON fixture fails loudly with ::error::, not a silent pass', () => {
    const { status, stderr } = runScript([], 'not json');
    expect(status).not.toBe(0);
    expect(stderr).toContain('::error::');
  });

  it('empty fixture fails loudly with ::error::', () => {
    const { status, stderr } = runScript([], '');
    expect(status).not.toBe(0);
    expect(stderr).toContain('::error::');
  });

  it('missing-unpackedSize fixture fails loudly with ::error::', () => {
    const fixture = JSON.stringify([{ name: 'apra-fleet' }]);
    const { status, stderr } = runScript([], fixture);
    expect(status).not.toBe(0);
    expect(stderr).toContain('::error::');
  });

  it('apra-fleet-yj1.3: an explicitly-supplied unparseable/non-positive --threshold fails loudly naming the bad value, not a silent default fallback', () => {
    const fixture = JSON.stringify([{ name: 'apra-fleet', unpackedSize: 5000 }]);

    for (const badArgs of [
      ['--threshold', 'abc'],
      ['--threshold=abc'],
      ['--threshold=0'],
      ['--threshold=-1'],
    ]) {
      const { status, stderr } = runScript(badArgs, fixture);
      expect(status).not.toBe(0);
      expect(stderr).toContain('::error::');
      // Assert the bad literal itself appears in the error line.
      const literal = badArgs.length === 2 ? badArgs[1] : badArgs[0].split('=')[1];
      expect(stderr).toContain(literal);
    }
  });
});

describe('ci.yml wiring (apra-fleet-yj1.2)', () => {
  const ciYmlPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
  const ciYml = fs.readFileSync(ciYmlPath, 'utf-8');

  it('no longer contains the old grep -oE "[0-9]+" PACK_BYTES byte-arithmetic scrape', () => {
    expect(ciYml).not.toMatch(/grep\s+-oE\s+['"]\[0-9\]\+['"]/);
  });

  it('invokes check-pack-size.mjs', () => {
    expect(ciYml).toContain('check-pack-size.mjs');
  });
});
