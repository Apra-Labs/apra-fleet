#!/usr/bin/env node
// Guard for apra-fleet-yj1: ci.yml's Clean-pack guard used to scrape npm's
// human-readable 'unpacked size: 4.1 MB' notice with `grep -oE '[0-9]+'`,
// which matched only the leading '4' of '4.1' -- so the '-gt 10000000'
// comparison could never fire (4 is never > 10000000). This script replaces
// that scrape with a real byte count read from `npm pack --dry-run --json`.
//
// FIRST-STEP FINDING (apra-fleet-yj1.1): on the installed npm version here
// (10.9.3), `npm pack --dry-run --json` writes a JSON array to stdout, one
// object per packed workspace, and each object has both a human-readable
// `size` (tarball bytes) and `unpackedSize` (the field this guard cares
// about) -- confirmed via a live run in this repo. `npm pack` ALSO runs this
// package's own `prepare` lifecycle script (scripts/install-hooks.mjs) as
// part of packing, which itself `console.log`s a line
// ('install-hooks: installed pre-commit') -- and that line lands on stdout
// too, BEFORE the JSON array, even though npm's own pack notices go to
// stderr. So this script does not assume stdout is pure JSON: it extracts
// the substring between the first '[' and the last ']' and parses that,
// which tolerates prepare-script (or other lifecycle-script) stdout noise
// wrapped around the real array. Given pre-captured JSON via stdin/argument
// for tests, the same extraction applies uniformly.
//
// Usage:
//   node scripts/check-pack-size.mjs                    run 'npm pack --dry-run --json' live
//   node scripts/check-pack-size.mjs path/to/pack.json   read pre-captured JSON from a file
//   cat pack.json | node scripts/check-pack-size.mjs -    read pre-captured JSON from stdin
//   node scripts/check-pack-size.mjs --threshold 5000000  override the default byte threshold
//   PACK_SIZE_THRESHOLD=5000000 node scripts/check-pack-size.mjs   same, via env

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_THRESHOLD_BYTES = 10000000;

/**
 * Extract and parse the JSON array `npm pack --dry-run --json` writes to
 * stdout, tolerating extraneous non-JSON text before/after it (e.g. a
 * `prepare` lifecycle script's own stdout output -- see the file-level
 * comment above). Returns the array's first entry.
 *
 * @param {string} rawStdout
 * @returns {{ id?: string, name?: string, version?: string, size?: number, unpackedSize?: number }}
 * @throws {Error} if no JSON array can be found/parsed, or the first entry
 *   lacks a numeric `unpackedSize`.
 */
export function parsePackJson(rawStdout) {
  if (typeof rawStdout !== 'string' || rawStdout.trim() === '') {
    throw new Error('empty input: expected JSON output from "npm pack --dry-run --json"');
  }

  const end = rawStdout.lastIndexOf(']');
  if (end === -1) {
    throw new Error(`could not locate a JSON array in input (no matching '[' / ']'): '${rawStdout.slice(0, 200)}'`);
  }

  // Collect every '[' position at or before the final ']' and try each as a
  // candidate array start, earliest first. This tolerates lifecycle-script
  // (e.g. `prepare`) stdout noise that itself contains a bare '[' before the
  // real JSON array -- e.g. an '[OK] ...' log line (CLAUDE.md's mandated
  // ASCII checkmark) -- by skipping candidates that fail to parse as JSON
  // rather than committing to the very first '['.
  const starts = [];
  for (let i = rawStdout.indexOf('['); i !== -1 && i <= end; i = rawStdout.indexOf('[', i + 1)) {
    starts.push(i);
  }
  if (starts.length === 0) {
    throw new Error(`could not locate a JSON array in input (no matching '[' / ']'): '${rawStdout.slice(0, 200)}'`);
  }

  let lastErr;
  for (const start of starts) {
    const jsonSlice = rawStdout.slice(start, end + 1);
    let parsed;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch (err) {
      lastErr = new Error(`could not parse JSON array from input: ${err.message}`);
      continue;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      lastErr = new Error(`expected a non-empty JSON array, got: '${jsonSlice.slice(0, 200)}'`);
      continue;
    }

    const entry = parsed[0];
    if (!entry || typeof entry.unpackedSize !== 'number' || !Number.isFinite(entry.unpackedSize)) {
      lastErr = new Error(`first entry in JSON array is missing a numeric 'unpackedSize': '${JSON.stringify(entry).slice(0, 200)}'`);
      continue;
    }

    return entry;
  }

  throw lastErr;
}

/**
 * Check `unpackedSize` against `thresholdBytes`.
 *
 * @param {number} unpackedSize
 * @param {number} thresholdBytes
 * @returns {{ ok: boolean, message: string }}
 */
export function checkPackSize(unpackedSize, thresholdBytes) {
  if (unpackedSize > thresholdBytes) {
    return {
      ok: false,
      message: `::error::unpacked package size ${unpackedSize} bytes exceeds threshold ${thresholdBytes} bytes`,
    };
  }
  return {
    ok: true,
    message: `OK: unpacked package size ${unpackedSize} bytes (threshold ${thresholdBytes} bytes)`,
  };
}

/**
 * Parse an explicitly-supplied threshold value, accepting both the
 * space-separated ('--threshold 5000000') and '='-joined
 * ('--threshold=5000000') spellings. Unlike the previous implementation,
 * this never silently falls through to DEFAULT_THRESHOLD_BYTES when the
 * flag IS present but its value is unparseable/non-positive -- it throws
 * instead, so callers can fail loudly rather than running the guard at an
 * unintended threshold.
 *
 * @param {string[]} argv
 * @returns {number|undefined} the parsed threshold, or undefined if the
 *   flag was not supplied at all (caller should fall back to the env var
 *   or DEFAULT_THRESHOLD_BYTES).
 * @throws {Error} if the flag was supplied with an unparseable or
 *   non-positive value.
 */
export function parseThresholdFlag(argv) {
  let rawValue;
  let found = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold') {
      found = true;
      rawValue = argv[i + 1];
      break;
    }
    if (a.startsWith('--threshold=')) {
      found = true;
      rawValue = a.slice('--threshold='.length);
      break;
    }
  }

  if (!found) return undefined;

  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid --threshold value: '${rawValue}' (must be a positive, finite number)`);
  }
  return n;
}

/**
 * Resolve the threshold to use: an explicitly-supplied `--threshold`/
 * `--threshold=` flag wins, then the `PACK_SIZE_THRESHOLD` env var, then
 * {@link DEFAULT_THRESHOLD_BYTES}. Mirrors parseThresholdFlag's loud-failure
 * behavior: an explicitly supplied but unparseable/non-positive value (via
 * flag or env) throws rather than silently falling back to the default.
 *
 * @param {string[]} argv
 * @returns {number}
 * @throws {Error} if an explicitly supplied flag or env value is invalid.
 */
export function parseThresholdArg(argv) {
  const fromFlag = parseThresholdFlag(argv);
  if (fromFlag !== undefined) return fromFlag;

  if (process.env.PACK_SIZE_THRESHOLD) {
    const n = Number(process.env.PACK_SIZE_THRESHOLD);
    if (Number.isFinite(n) && n > 0) return n;
    throw new Error(`invalid PACK_SIZE_THRESHOLD env value: '${process.env.PACK_SIZE_THRESHOLD}' (must be a positive, finite number)`);
  }
  return DEFAULT_THRESHOLD_BYTES;
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch (err) {
    throw new Error(`could not read JSON from stdin: ${err.message}`);
  }
}

function getRawInput(argv) {
  // A positional argument that isn't a flag/its value is treated as a path
  // to pre-captured JSON ('-' means stdin); otherwise run npm pack live.
  const positional = argv.find((a, i) => {
    if (a === '-') return true;
    if (a.startsWith('-')) return false;
    if (argv[i - 1] === '--threshold') return false;
    return true;
  });

  if (positional === '-') {
    return readStdinSync();
  }
  if (positional) {
    return fs.readFileSync(positional, 'utf-8');
  }
  // No pre-captured input given: run npm pack --dry-run --json live. Only
  // stdout is captured/parsed -- npm's human-readable notices go to stderr,
  // which is inherited straight through for visibility but never parsed.
  // `shell: true` is required to resolve the `npm.cmd` shim on Windows
  // (plain `execFileSync('npm', ...)` throws ENOENT there); every argument
  // here is a static literal, never caller-controlled, so this carries no
  // shell-injection risk.
  return execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: true,
  });
}

function main() {
  const argv = process.argv.slice(2);

  let thresholdBytes;
  try {
    thresholdBytes = parseThresholdArg(argv);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
    return;
  }

  let rawStdout;
  try {
    rawStdout = getRawInput(argv);
  } catch (err) {
    console.error(`::error::failed to obtain pack JSON: ${err.message}`);
    process.exit(1);
    return;
  }

  let entry;
  try {
    entry = parsePackJson(rawStdout);
  } catch (err) {
    console.error(`::error::malformed or unusable pack JSON: ${err.message}`);
    process.exit(1);
    return;
  }

  const result = checkPackSize(entry.unpackedSize, thresholdBytes);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  console.log(result.message);
}

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
