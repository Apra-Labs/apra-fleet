import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BUDGET_MS, checkBudget, loadResults, classifyFailures, validateQuarantine, loadQuarantine, DEFAULT_QUARANTINE_FILE,
} from '../scripts/check-integ-suite-budget.mjs';

// Tests for apra-fleet-eft.17.2: verify scripts/check-integ-suite-budget.mjs
// correctly flags real-bd suite files whose recorded durationMs (from
// integ-suite-status.json, produced by scripts/run-integ-suites.mjs)
// exceeds the ~5 minute (300000ms) single-file budget documented in
// packages/apra-fleet-se/test/INTEG-SUITE.md step 7, so a future regression
// in the eft.17.1 shared-fixture dolt caching is caught rather than
// rediscovered by hand.
//
// Fixture numbers below are drawn from the real pre-fix/post-fix evidence
// recorded in packages/apra-fleet-se/test/TEST-VALUE-ANALYSIS.md ("D-pull/
// D-push bracket caching (apra-fleet-eft.17.1)") -- this suite never runs
// the real-bd suite itself, it only exercises the guard's own logic against
// realistic result shapes.

describe('BUDGET_MS', () => {
  it('is the ~5 minute (300000ms) single-file budget from INTEG-SUITE.md step 7', () => {
    expect(BUDGET_MS).toBe(300000);
  });
});

describe('checkBudget', () => {
  it('PASSES when every file is within budget', () => {
    const results = {
      'mock-sprint-happy-path.test.mjs': { durationMs: 120000, passed: true },
      'budget-live.test.mjs': { durationMs: BUDGET_MS, passed: true }, // exactly at budget: not over
    };
    const result = checkBudget(results);
    expect(result.ok).toBe(true);
    expect(result.offenders).toEqual([]);
    expect(result.message).toMatch(/^OK:/);
  });

  it('FAILS and names every offending file, worst-first, on the recorded pre-eft.17.1 baseline (28/74 files over budget)', () => {
    // Real "before" durationMs values from TEST-VALUE-ANALYSIS.md's
    // before/after table -- these are exactly the numbers that motivated
    // apra-fleet-eft.17 (worst offender 1543s) and would have failed this
    // guard had it existed pre-fix.
    const results = {
      'mock-sprint-doer-max-turns.test.mjs': { durationMs: 1543492, passed: true },
      'golden-transcript.test.mjs': { durationMs: 1408835, passed: true },
      'budget-live.test.mjs': { durationMs: 1232943, passed: true },
      'mock-sprint-plan-contracts.test.mjs': { durationMs: 48000, passed: true }, // well within budget
    };
    const result = checkBudget(results);
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.file)).toEqual([
      'mock-sprint-doer-max-turns.test.mjs',
      'golden-transcript.test.mjs',
      'budget-live.test.mjs',
    ]);
    expect(result.message).toContain('mock-sprint-doer-max-turns.test.mjs');
    expect(result.message).toContain('golden-transcript.test.mjs');
    expect(result.message).toContain('budget-live.test.mjs');
    expect(result.message).not.toContain('mock-sprint-plan-contracts.test.mjs');
    expect(result.message).toMatch(/^FAIL:/);
  });

  it('ignores results with no recorded durationMs (in-flight/crashed entries)', () => {
    const results = {
      'still-running.test.mjs': { passed: false },
      'ok.test.mjs': { durationMs: 1000, passed: true },
    };
    const result = checkBudget(results);
    expect(result.ok).toBe(true);
  });

  it('respects a custom budget override', () => {
    const results = { 'fast.test.mjs': { durationMs: 5000, passed: true } };
    expect(checkBudget(results, 1000).ok).toBe(false);
    expect(checkBudget(results, 10000).ok).toBe(true);
  });
});

describe('loadResults', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-suite-budget-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the status file does not exist (no run recorded yet)', () => {
    const missing = path.join(tmpDir, 'integ-suite-status.json');
    expect(loadResults(missing)).toBeNull();
  });

  it('returns the results map when the status file is well-formed', () => {
    const statusFile = path.join(tmpDir, 'integ-suite-status.json');
    fs.writeFileSync(
      statusFile,
      JSON.stringify({ run: { runComplete: true }, results: { 'a.test.mjs': { durationMs: 1000 } } })
    );
    expect(loadResults(statusFile)).toEqual({ 'a.test.mjs': { durationMs: 1000 } });
  });

  it('throws on a status file with no "results" object (corrupt/foreign file)', () => {
    const statusFile = path.join(tmpDir, 'integ-suite-status.json');
    fs.writeFileSync(statusFile, JSON.stringify({ run: {} }));
    expect(() => loadResults(statusFile)).toThrow(/no "results" object/);
  });

  it('throws on unparseable JSON', () => {
    const statusFile = path.join(tmpDir, 'integ-suite-status.json');
    fs.writeFileSync(statusFile, 'not json');
    expect(() => loadResults(statusFile)).toThrow();
  });
});

describe('CLI (scripts/check-integ-suite-budget.mjs)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-suite-budget-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const scriptPath = path.join(__dirname, '..', 'scripts', 'check-integ-suite-budget.mjs');

  it('exits 0 and prints OK when no file is over budget', () => {
    const statusFile = path.join(tmpDir, 'integ-suite-status.json');
    fs.writeFileSync(
      statusFile,
      JSON.stringify({ results: { 'a.test.mjs': { durationMs: 1000, passed: true } } })
    );
    const out = execFileSync('node', [scriptPath, statusFile], { encoding: 'utf8' });
    expect(out).toMatch(/OK:/);
  });

  it('exits 1 and names the offending file when a file is over budget', () => {
    const statusFile = path.join(tmpDir, 'integ-suite-status.json');
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        results: { 'slow.test.mjs': { durationMs: 1543492, passed: true } },
      })
    );
    let stdout = '';
    let exitCode = 0;
    try {
      execFileSync('node', [scriptPath, statusFile], { encoding: 'utf8' });
    } catch (e: any) {
      stdout = e.stdout;
      exitCode = e.status;
    }
    expect(exitCode).toBe(1);
    expect(stdout).toContain('slow.test.mjs');
    expect(stdout).toMatch(/FAIL:/);
  });

  it('exits 2 (fail-loud) when no status file is present', () => {
    const missing = path.join(tmpDir, 'integ-suite-status.json');
    let exitCode = 0;
    try {
      execFileSync('node', [scriptPath, missing], { encoding: 'utf8' });
    } catch (e: any) {
      exitCode = e.status;
    }
    expect(exitCode).toBe(2);
  });
});

describe('quarantine (new vs quarantined failures)', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    fingerprint: 'flaky.test.mjs',
    bead: 'x-1',
    reason: 'load timeout',
    addedAt: '2026-10-01',
    expires: '2026-10-31',
    ...over,
  });
  const results = {
    'flaky.test.mjs': { passed: false, durationMs: 1 },
    'fresh-break.test.mjs': { passed: false, durationMs: 1 },
    'ok.test.mjs': { passed: true, durationMs: 1 },
  };
  const now = new Date('2026-10-15T00:00:00Z');

  it('quarantines a matching live entry and reports anything else as new', () => {
    const r = classifyFailures(results, [entry()], now, 'linux');
    expect(r.quarantined.map((q) => q.file)).toEqual(['flaky.test.mjs']);
    expect(r.newFailures).toEqual([{ file: 'fresh-break.test.mjs' }]);
  });

  it('counts a failure under an EXPIRED entry as new, carrying the expired entry', () => {
    const r = classifyFailures(results, [entry()], new Date('2026-11-01T00:00:01Z'), 'linux');
    expect(r.quarantined).toEqual([]);
    expect(r.newFailures.find((f) => f.file === 'flaky.test.mjs')?.expired?.expires).toBe('2026-10-31');
  });

  it('is still quarantined during the whole expires day', () => {
    const r = classifyFailures(results, [entry()], new Date('2026-10-31T23:00:00Z'), 'linux');
    expect(r.quarantined.map((q) => q.file)).toEqual(['flaky.test.mjs']);
  });

  it('honours os: an entry for another platform does not quarantine', () => {
    expect(classifyFailures(results, [entry({ os: 'win32' })], now, 'linux').quarantined).toEqual([]);
    expect(classifyFailures(results, [entry({ os: 'win32' })], now, 'win32').quarantined).toHaveLength(1);
  });

  it('rejects an expiry more than 30 days after addedAt, missing fields, bad dates and duplicates', () => {
    expect(() => validateQuarantine({ entries: [entry({ expires: '2026-11-05' })] })).toThrow(/days after addedAt/);
    expect(() => validateQuarantine({ entries: [entry({ bead: '' })] })).toThrow(/bead/);
    expect(() => validateQuarantine({ entries: [entry({ addedAt: '10/01/2026' })] })).toThrow(/YYYY-MM-DD/);
    expect(() => validateQuarantine({ entries: [entry(), entry()] })).toThrow(/duplicate/);
    expect(() => validateQuarantine({})).toThrow(/entries/);
  });

  // Structure only -- never asserts the entries are unexpired, so this test
  // does not go red on its own when a quarantine lapses (the checker does).
  it('the committed tests/regression/quarantine.json is valid', () => {
    const entries = loadQuarantine(DEFAULT_QUARANTINE_FILE);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('CLI --quarantine exits 1 on a new failure and 0 when every failure is quarantined', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-quarantine-cli-'));
    try {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'check-integ-suite-budget.mjs');
      const statusFile = path.join(tmp, 'status.json');
      const qFile = path.join(tmp, 'q.json');
      const today = new Date().toISOString().slice(0, 10);
      const later = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
      fs.writeFileSync(qFile, JSON.stringify({ entries: [entry({ addedAt: today, expires: later })] }));
      fs.writeFileSync(statusFile, JSON.stringify({ results: { 'flaky.test.mjs': { passed: false, durationMs: 1 } } }));
      const out = execFileSync('node', [scriptPath, statusFile, `--quarantine=${qFile}`], { encoding: 'utf8' });
      expect(out).toContain('new=0 quarantined=1');

      fs.writeFileSync(statusFile, JSON.stringify({ results }));
      let code = 0;
      let stdout = '';
      try {
        execFileSync('node', [scriptPath, statusFile, `--quarantine=${qFile}`], { encoding: 'utf8' });
      } catch (e: any) {
        code = e.status;
        stdout = e.stdout;
      }
      expect(code).toBe(1);
      expect(stdout).toContain('NEW fresh-break.test.mjs');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
