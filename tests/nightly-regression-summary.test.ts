import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  renderNightlyReport, collectNightlyInputs, computeVerdict, laneCounts, formatDuration,
  DETAIL_FILES_PER_GROUP,
} from '../scripts/nightly-regression-summary.mjs';
import { listSlowTestFiles } from '../scripts/check-integ-suite-budget.mjs';

// Nightly regression report (scripts/nightly-regression-summary.mjs): the
// verdict headline, failure grouping, BROKEN paths and the delta vs the
// previous run. The script must never fail its step on an outcome.

const now = new Date('2026-10-15T03:30:00Z');
const entry = (fingerprint: string, over: Record<string, unknown> = {}) => ({
  fingerprint, bead: 'x-1', reason: 'load timeout', addedAt: '2026-10-01', expires: '2026-10-31', ...over,
});
const pass = (ms = 1000, tests = { total: 3, passed: 3, failed: 0, skipped: 0 }) => ({ passed: true, durationMs: ms, tests });
const fail = (name: string, error: string, ms = 1000) => ({
  passed: false, durationMs: ms, tests: { total: 2, passed: 1, failed: 1, skipped: 0 }, failures: [{ name, error }],
});
const slowDoc = (over: Record<string, unknown> = {}) => ({
  run: { startedAt: '2026-10-15T03:00:00Z', lastResultAt: '2026-10-15T03:07:30Z' },
  results: { 'w.test.mjs': pass(31000), ...over },
});

describe('computeVerdict / headline', () => {
  const g = (fresh: number, q: number, expired = 0) => ({
    fresh: Array.from({ length: fresh }, (_, i) => ({ file: `new${i}` })),
    quarantined: Array.from({ length: q }, (_, i) => ({ file: `q${i}`, entry: entry(`q${i}`) })),
    expired: Array.from({ length: expired }, (_, i) => ({ file: `e${i}`, expired: entry(`e${i}`) })),
  });
  it('PASS names the quarantined count', () => {
    expect(computeVerdict({ reasons: [], groups: g(0, 2) })).toEqual({ verdict: 'PASS', headline: 'PASS -- 0 new failures (2 quarantined)' });
  });
  it('FAIL counts expired-quarantine failures as new', () => {
    expect(computeVerdict({ reasons: [], groups: g(2, 0, 1) }).headline).toBe('FAIL -- 3 new failures');
    expect(computeVerdict({ reasons: [], groups: g(1, 1) }).headline).toBe('FAIL -- 1 new failure (1 quarantined)');
  });
  it('BROKEN wins over failures and names the first reason', () => {
    const v = computeVerdict({ reasons: ['slow lane did not finish', 'other'], groups: g(3, 0) });
    expect(v.verdict).toBe('BROKEN');
    expect(v.headline).toBe('BROKEN -- slow lane did not finish (+1 more)');
  });
});

describe('renderNightlyReport', () => {
  const integDoc = {
    headSha: 'abcdef1234567890',
    run: { wallClockSeconds: 754 },
    results: {
      'ok.test.mjs': pass(400000),
      'fresh.test.mjs': fail('breaks <now>', 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8'),
      'flaky.test.mjs': fail('flakes', 'timed out'),
      'lapsed.test.mjs': fail('lapsed test', 'still broken'),
    },
  };
  const entries = [entry('flaky.test.mjs'), entry('lapsed.test.mjs', { addedAt: '2026-09-10', expires: '2026-10-01' })];
  const base = {
    integDoc, slowDoc: slowDoc(), entries, now, platform: 'linux', expectedSha: 'abcdef1234567890',
    repoUrl: 'https://github.com/o/r', runUrl: 'https://github.com/o/r/actions/runs/9', artifactUrl: 'https://art/1',
  };

  it('puts the verdict headline first, then commit + date, then the count table', () => {
    const r = renderNightlyReport(base);
    expect(r.verdict).toBe('FAIL');
    const lines = r.markdown.split('\n');
    expect(lines[0]).toBe('## FAIL -- 2 new failures (1 quarantined)');
    expect(lines[2]).toContain('[`abcdef1`](https://github.com/o/r/commit/abcdef1234567890)');
    expect(lines[2]).toContain('2026-10-15 03:30 UTC');
    expect(r.markdown).toContain('| real-bd suite | 4 | 1 | 3 | 9 | 6 | 3 | 0 | 12m 34s |');
    expect(r.markdown).toContain('| slow lane | 1 | 1 | 0 | 3 | 3 | 0 | 0 | 7m 30s |');
  });

  it('groups failures as new, quarantined (with expiry) and expired, with collapsible per-file detail', () => {
    const md = renderNightlyReport(base).markdown;
    const newIdx = md.indexOf('### New failures (1)');
    const qIdx = md.indexOf('### Quarantined failures (1)');
    const eIdx = md.indexOf('### Expired-quarantine failures (count as new) (1)');
    expect(newIdx).toBeGreaterThan(-1);
    expect(qIdx).toBeGreaterThan(newIdx);
    expect(eIdx).toBeGreaterThan(qIdx);
    expect(md.slice(newIdx, qIdx)).toContain('<summary><code>fresh.test.mjs</code> -- 1 failing test</summary>');
    expect(md).toContain('<b>breaks &lt;now&gt;</b>'); // test names are HTML-escaped
    expect(md).toContain('<pre>line1\nline2\nline3\nline4\nline5\nline6\n...</pre>'); // first lines only
    expect(md.slice(qIdx, eIdx)).toContain('quarantined until 2026-10-31: load timeout');
    expect(md.slice(eIdx)).toContain('quarantine expired 2026-10-01');
    expect(md).not.toContain('x-1'); // never print tracking ids
  });

  it('lists the slowest files against the advisory budget', () => {
    const md = renderNightlyReport(base).markdown;
    expect(md).toContain('### Slowest files vs the 300s budget (advisory)');
    expect(md).toContain('| 1 | `ok.test.mjs` | 6m 40s | OVER |');
    expect(md).toContain('| 2 | `slow/w.test.mjs` | 31s | ok |');
  });

  it('says there is no previous run to compare when none was fetched', () => {
    expect(renderNightlyReport(base).markdown).toContain('No previous run to compare.');
  });

  it('reports newly failing and newly passing files against the previous run', () => {
    const previous = {
      headSha: '1111111aaaa', runUrl: 'https://prev/run',
      results: { 'ok.test.mjs': { passed: false }, 'flaky.test.mjs': { passed: false }, 'fresh.test.mjs': { passed: true } },
    };
    const md = renderNightlyReport({ ...base, previous }).markdown;
    expect(md).toContain('[previous run](https://prev/run) at `1111111`');
    const delta = md.slice(md.indexOf('### Delta'));
    expect(delta).toContain('Newly failing (2):\n\n- `fresh.test.mjs`\n- `lapsed.test.mjs` (not run previously)');
    expect(delta).toContain('Newly passing (1):\n\n- `ok.test.mjs`');
  });

  it('BROKEN: headline, loud caution block, and partial data still rendered', () => {
    const r = renderNightlyReport({ ...base, slowDoc: null, reasons: ['no slow-lane status file (slow-suite-status.json)'] });
    expect(r.verdict).toBe('BROKEN');
    expect(r.markdown.split('\n')[0]).toBe('## BROKEN -- no slow-lane status file (slow-suite-status.json)');
    expect(r.markdown).toContain('> [!CAUTION]');
    expect(r.markdown).toContain('| slow lane | n/a |');
    expect(r.markdown).toContain('fresh.test.mjs');
  });

  it('shows n/a test counts for records without per-test detail (older status files)', () => {
    const c = laneCounts({ 'a.test.mjs': { passed: true, durationMs: 1 } });
    expect(c.tests).toBeNull();
    const md = renderNightlyReport({ ...base, integDoc: { headSha: 'abcdef1234567890', results: { 'a.test.mjs': { passed: true, durationMs: 1 } } } }).markdown;
    expect(md).toContain('| real-bd suite | 1 | 1 | 0 | n/a | n/a | n/a | n/a | n/a |');
  });

  it('caps detailed files per group and lists the rest by name', () => {
    const results: Record<string, unknown> = {};
    for (let i = 0; i < DETAIL_FILES_PER_GROUP + 3; i++) results[`f${String(i).padStart(2, '0')}.test.mjs`] = fail('t', 'e');
    const md = renderNightlyReport({ ...base, integDoc: { headSha: 'abcdef1234567890', results } }).markdown;
    expect(md.match(/<details>/g)).toHaveLength(DETAIL_FILES_PER_GROUP);
    expect(md).toContain('Plus 3 more (detail in the artifact):');
  });

  it('formatDuration', () => {
    expect(formatDuration(59400)).toBe('59s');
    expect(formatDuration(754000)).toBe('12m 34s');
    expect(formatDuration(3 * 3600000 + 60000)).toBe('3h 1m');
    expect(formatDuration(null as unknown as number)).toBe('n/a');
  });
});

describe('collectNightlyInputs (harness checks) and the CLI', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'nightly-regression-summary.mjs');
  const slowFiles = listSlowTestFiles();
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-summary-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const write = (name: string, doc: unknown) => {
    const p = path.join(tmp, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(doc));
    return p;
  };
  const fullSlow = () => {
    const r: Record<string, unknown> = {};
    for (const f of slowFiles) r[f] = pass();
    return { results: r };
  };
  const qFile = () => write('q.json', {
    entries: [entry('flaky.test.mjs', { addedAt: new Date().toISOString().slice(0, 10), expires: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10) })],
  });

  it('collects every harness problem as a BROKEN reason instead of throwing', () => {
    const status = write('s.json', { headSha: 'aaa', results: { 'a.test.mjs': pass() } });
    const r = collectNightlyInputs({
      statusFile: status, slowFile: write('slow.json', { results: {} }), quarantineFile: qFile(),
      integRc: '2', slowRc: '', expectedSha: 'bbb', previousDir: path.join(tmp, 'nope'),
    });
    expect(r.reasons).toEqual([
      'real-bd suite did not complete (--status exit=2)',
      'slow lane did not finish (no exit code recorded: timed out or never ran)',
      'real-bd status is for aaa, not the tested commit bbb',
      expect.stringContaining('slow lane has no recorded result for'),
    ]);
    expect(r.previous).toBeNull();
  });

  it('a clean run has no reasons and loads the previous run with its meta', () => {
    const status = write('s.json', { headSha: 'aaa', results: { 'a.test.mjs': pass() } });
    write('prev/integ-suite-status.json', { headSha: 'old', results: { 'a.test.mjs': { passed: false } } });
    write('prev/meta.json', { headSha: 'old', runUrl: 'https://prev' });
    const r = collectNightlyInputs({
      statusFile: status, slowFile: write('slow.json', fullSlow()), quarantineFile: qFile(),
      integRc: '0', slowRc: '1', expectedSha: 'aaa', previousDir: path.join(tmp, 'prev'),
    });
    expect(r.reasons).toEqual([]);
    expect(r.previous).toMatchObject({ headSha: 'old', runUrl: 'https://prev' });
  });

  it('CLI exits 0 and writes verdict=BROKEN when the status file is missing', () => {
    const summary = path.join(tmp, 'summary.md');
    const out = path.join(tmp, 'out.txt');
    const stdout = execFileSync('node', [
      scriptPath, `--status=${path.join(tmp, 'missing.json')}`, `--slow=${write('slow.json', fullSlow())}`,
      `--quarantine=${qFile()}`, '--integ-rc=', '--slow-rc=0', `--summary=${summary}`, `--github-output=${out}`,
    ], { encoding: 'utf8' });
    expect(stdout).toContain('::error title=Nightly regression BROKEN::');
    expect(fs.readFileSync(out, 'utf8')).toContain('verdict=BROKEN\n');
    expect(fs.readFileSync(summary, 'utf8').split('\n')[0]).toBe(
      '## BROKEN -- real-bd suite did not finish (no exit code recorded: timed out or never ran) (+1 more)');
  });

  it('CLI exits 0 on new failures too (FAIL is a verdict, not a red X)', () => {
    const out = path.join(tmp, 'out.txt');
    const status = write('s.json', { headSha: 'aaa', results: { 'new.test.mjs': fail('t', 'e'), 'flaky.test.mjs': fail('t', 'e') } });
    execFileSync('node', [
      scriptPath, `--status=${status}`, `--slow=${write('slow.json', fullSlow())}`, `--quarantine=${qFile()}`,
      '--integ-rc=1', '--slow-rc=0', '--expected-sha=aaa', `--github-output=${out}`,
    ], { encoding: 'utf8' });
    expect(fs.readFileSync(out, 'utf8')).toBe('verdict=FAIL\nheadline=FAIL -- 1 new failure (1 quarantined)\n');
  });
});
