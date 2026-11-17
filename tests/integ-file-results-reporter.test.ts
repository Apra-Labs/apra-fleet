import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// scripts/integ-file-results-reporter.mjs: per-file results with per-test
// counts and bounded, noise-free failure detail. Runs node --test over two
// small fixtures (tests/fixtures/integ-reporter) with the status/heartbeat
// files redirected to a temp dir.

const repoRoot = path.join(__dirname, '..');
const reporter = pathToFileURL(path.join(repoRoot, 'scripts', 'integ-file-results-reporter.mjs')).href;
const fixtures = path.join(repoRoot, 'tests', 'fixtures', 'integ-reporter');

describe('integ-file-results-reporter', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-reporter-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('records per-test counts, real failures only, hook causes, and lane timestamps', () => {
    const statusFile = path.join(tmp, 'status.json');
    const r = spawnSync(process.execPath, [
      '--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout',
      path.join(fixtures, 'mixed.test.mjs'), path.join(fixtures, 'clean.test.mjs'),
    ], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, INTEG_SUITES_STATUS_FILE: statusFile, INTEG_SUITES_HEARTBEAT_FILE: path.join(tmp, 'hb.json') },
    });
    expect(r.status).toBe(1); // mixed.test.mjs fails on purpose
    const doc = JSON.parse(fs.readFileSync(statusFile, 'utf8'));

    expect(doc.results['clean.test.mjs']).toMatchObject({ passed: true, tests: { total: 2, passed: 2, failed: 0, skipped: 0 } });
    const mixed = doc.results['mixed.test.mjs'];
    // ok1, top-ok pass; bad1, throws, never (cancelled by its failed hook) fail; skip + todo skipped.
    expect(mixed.passed).toBe(false);
    expect(mixed.tests).toEqual({ total: 7, passed: 2, failed: 3, skipped: 2 });
    // No "N subtests failed" suite entry, no cancelled-by-parent entry, no todo.
    expect(mixed.failures.map((f: { name: string }) => f.name)).toEqual(['bad1', 'throws', 'hookfail']);
    expect(mixed.failures[0].error).toContain('one is not two');
    expect(mixed.failures[2].error).toBe('failed running before hook: before hook died');

    expect(typeof doc.run.startedAt).toBe('string');
    expect(Date.parse(doc.run.lastResultAt)).toBeGreaterThanOrEqual(Date.parse(doc.run.startedAt));
  });
});
