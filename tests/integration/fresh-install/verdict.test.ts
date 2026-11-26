import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateStep, evaluatePass, summarize, finalVerdict, parseResults, renderMarkdown, STATUS, expand } from './lib/verdict.mjs';
import { resolveVersionVars, repoVersionCore, versionCoreOf } from './lib/versions.mjs';

const checklist = {
  passes: {
    A: {
      title: 'no node',
      steps: [
        { id: 'A1', title: 'version', expect: { exit: 0, observed: '^${expectVersion}$' } },
        { id: 'A2', title: 'refuse', expect: { exit: 'nonzero', keyline: 'requires Node' } },
        { id: 'A3', title: 'ui', severity: 'advisory', expect: { exit: 200 }, na: { exit: [404], reason: 'no ui' } },
      ],
    },
    B: {
      title: 'node',
      steps: [
        { id: 'B1', title: 'install', expect: { exit: 0 }, envLimited: [{ platforms: ['linux'], keyline: 'systemd', note: 'no systemd' }] },
        { id: 'B2', title: 'task', platforms: ['windows'], expect: { exit: 0, keyline: 'Running' } },
      ],
    },
  },
};
const vars = { expectVersion: 'v0.4.3_78cefd' };
const rec = (id: string, exit: unknown, keyline = '', observed = '', extra: Record<string, unknown> = {}) =>
  ({ pass: id[0], id, cmd: 'c', exit, keyline, observed, ...extra });

describe('fresh-install verdict logic', () => {
  it('passes when exit and observed version match, with string exit codes from shells', () => {
    const r = evaluateStep(checklist.passes.A.steps[0], rec('A1', '0', '', 'v0.4.3_78cefd'), { platform: 'linux', vars });
    expect(r.status).toBe(STATUS.PASS);
  });

  it('fails on version mismatch and when the expectation cannot be met', () => {
    expect(evaluateStep(checklist.passes.A.steps[0], rec('A1', 0, '', 'v0.4.2_2b2a2f'), { vars }).status).toBe(STATUS.FAIL);
    expect(evaluateStep(checklist.passes.A.steps[1], rec('A2', 0, 'installed'), { vars }).status).toBe(STATUS.FAIL);
    expect(evaluateStep(checklist.passes.A.steps[1], rec('A2', 'ERR timeout'), { vars }).status).toBe(STATUS.FAIL);
  });

  it('an unset placeholder is INCONCLUSIVE (never satisfied), naming the unknown var', () => {
    const r = evaluateStep(checklist.passes.A.steps[0], rec('A1', 0, '', 'anything'), { vars: {} });
    expect(r.status).toBe(STATUS.INCONCLUSIVE);
    expect(r.reason).toContain('expectVersion is unknown');
    expect(expand('^${expectVersion}$', vars)).toBe('^v0\\.4\\.3_78cefd$');
  });

  it('nonzero expectation passes on any non-zero exit with the keyline', () => {
    expect(evaluateStep(checklist.passes.A.steps[1], rec('A2', '1', 'fleet-se requires Node.js 22.16+'), { vars }).status).toBe(STATUS.PASS);
  });

  it('N/A from a checklist na rule (404) and from a box-reported capability gap', () => {
    expect(evaluateStep(checklist.passes.A.steps[2], rec('A3', '404'), { vars })).toEqual({ status: STATUS.NA, reason: 'no ui' });
    expect(evaluateStep(checklist.passes.B.steps[1], rec('B2', '', '', '', { na: 'no systemd' }), { vars }).status).toBe(STATUS.NA);
  });

  it('advisory miss is WARN, required miss is FAIL, missing record is FAIL', () => {
    expect(evaluateStep(checklist.passes.A.steps[2], rec('A3', 500), { vars }).status).toBe(STATUS.WARN);
    expect(evaluateStep(checklist.passes.A.steps[0], undefined, { vars }).status).toBe(STATUS.FAIL);
  });

  it('ENV-LIMITED only on the listed platform', () => {
    const r = rec('B1', 1, 'Service registration skipped: systemd user mode is not available');
    expect(evaluateStep(checklist.passes.B.steps[0], r, { platform: 'linux', vars }).status).toBe(STATUS.ENV);
    expect(evaluateStep(checklist.passes.B.steps[0], r, { platform: 'windows', vars }).status).toBe(STATUS.FAIL);
  });

  it('pass verdict ignores N/A, WARN and ENV-LIMITED; platform filter drops windows-only steps', () => {
    const records = [rec('B1', 1, 'systemd missing')];
    const p = evaluatePass({ checklist, pass: 'B', platform: 'linux', records, vars });
    expect(p.steps.map((s: { id: string }) => s.id)).toEqual(['B1']);
    expect(p.verdict).toBe(STATUS.PASS);
  });

  it('informational pass failure does not make the run fail; required pass failure does', () => {
    const a = evaluatePass({ checklist, pass: 'A', platform: 'windows', records: [], vars, informational: true });
    expect(a.verdict).toBe(STATUS.FAIL);
    expect(a.blocking).toBe(false);
    expect(summarize([a])).toEqual({ exitCode: 0, blocking: [] });
    const b = evaluatePass({ checklist, pass: 'B', platform: 'windows', records: [rec('B1', 0), rec('B2', 1, 'Ready')], vars });
    expect(summarize([a, b])).toEqual({ exitCode: 1, blocking: ['windows/B'] });
  });

  it('a driver error fails the pass even when every recorded step passed', () => {
    const b = evaluatePass({ checklist, pass: 'B', platform: 'windows', records: [rec('B1', 0), rec('B2', 0, 'Running')], vars, driverError: 'timed out' });
    expect(b.verdict).toBe(STATUS.FAIL);
    expect(summarize([b]).exitCode).toBe(1);
  });

  it('parses jsonl with BOM/CRLF, reports bad lines, and renders ASCII-only markdown', () => {
    const { records, errors } = parseResults('\uFEFF{"id":"A1","exit":"0"}\r\nnot json\r\n\r\n');
    expect(records).toHaveLength(1);
    expect(errors).toHaveLength(1);
    const p = evaluatePass({ checklist, pass: 'A', platform: 'windows', records: [rec('A1', 0, 'ok \u2713 | pipe', 'v0.4.3_78cefd')], vars });
    const md = renderMarkdown({ candidate: { path: 'x', sha256: 'y' }, vars, passes: [p], summary: summarize([p]), notes: ['n \u26A0'] });
    expect(/[^\x09\x0a\x20-\x7e]/.test(md)).toBe(false);
    expect(md).toContain('ok \\| pipe');
  });

  it('the shipped checklist is well-formed and every expectation regex compiles', () => {
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'checklist.json'), 'utf8'));
    for (const [pass, def] of Object.entries<any>(real.passes)) {
      const ids = new Set<string>();
      for (const s of def.steps) {
        expect(ids.has(s.id), `${pass}/${s.id} duplicated`).toBe(false);
        ids.add(s.id);
        for (const rule of [s.expect, s.na, ...(s.envLimited ?? [])].filter(Boolean)) {
          for (const k of ['keyline', 'observed']) if (rule[k]) expect(() => new RegExp(expand(rule[k], { expectVersion: 'v1.2.3_abc', baselineVersion: 'v1.2.2_abc' }))).not.toThrow();
        }
      }
    }
  });
});

// apra-fleet-95sp: the expected version never comes from the candidate; an
// unknown expected/baseline version is INCONCLUSIVE (exit 3), never PASS.
describe('fresh-install version vars', () => {
  const cl = {
    passes: {
      A: { title: 'a', steps: [{ id: 'A01', title: 'version', expect: { exit: 0, observed: '^${expectVersion}$' } }] },
      U: { title: 'u', steps: [{ id: 'U02', title: 'baseline', expect: { exit: 0, observed: '^${baselineVersion}$' } }] },
    },
  };
  const passFor = (pass: string, records: unknown[], vars: Record<string, unknown>) =>
    evaluatePass({ checklist: cl, pass, platform: 'linux', driver: 'docker', records: records as never, vars: vars as never });

  it('unknown expectVersion -> INCONCLUSIVE, exit 3, reason names expectVersion', () => {
    const p = passFor('A', [rec('A01', 0, '', 'v0.4.6_abc')], { expectVersion: null, baselineVersion: null });
    expect(p.verdict).toBe('INCONCLUSIVE');
    const f = finalVerdict([p]);
    expect([f.verdict, f.exitCode]).toEqual(['INCONCLUSIVE', 3]);
    expect(f.inconclusive.join(' ')).toContain('expectVersion is unknown');
  });

  it('unknown baselineVersion for an upgrade pass -> INCONCLUSIVE naming baselineVersion', () => {
    const p = passFor('U', [rec('U02', 0, '', 'v0.4.3_x')], { expectVersion: '0.4.6', baselineVersion: null });
    const f = finalVerdict([p]);
    expect([f.verdict, f.exitCode]).toEqual(['INCONCLUSIVE', 3]);
    expect(f.inconclusive.join(' ')).toContain('baselineVersion is unknown');
  });

  it('a real FAIL still outranks INCONCLUSIVE', () => {
    const p = passFor('A', [rec('A01', 1, '', 'v0.4.6_abc')], { expectVersion: '0.4.6' });
    expect(finalVerdict([p]).exitCode).toBe(1);
  });

  it('omitted --expect-version: core from version.json; another core fails A01, the same core passes', () => {
    const { vars, note } = resolveVersionVars({ repoVersion: repoVersionCore(() => '{"version":"0.4.6"}'), needBase: false });
    expect(vars.expectVersion).toBe('0.4.6');
    expect(note).toContain('version.json');
    expect(passFor('A', [rec('A01', 0, '', 'v0.4.6_abc123')], vars).verdict).toBe('PASS');
    const bad = passFor('A', [rec('A01', 0, '', 'v0.4.7_abc123')], vars);
    expect(bad.verdict).toBe('FAIL');
    expect(bad.steps[0].status).toBe(STATUS.FAIL);
  });

  it('the candidate is never a source: no version.json and no flag -> unknown', () => {
    const { vars } = resolveVersionVars({ repoVersion: repoVersionCore(() => { throw new Error('missing'); }), needBase: false });
    expect(vars.expectVersion).toBeNull();
  });

  it('--expect-version wins over version.json', () => {
    expect(resolveVersionVars({ expectVersionArg: 'v0.4.9_aaa', repoVersion: '0.4.6', needBase: false }).vars.expectVersion).toBe('v0.4.9_aaa');
  });

  it('report-only reuses expectVersion and baselineVersion recorded in report.json', () => {
    const prior = { expectVersion: 'v0.4.5_deadbe', baselineVersion: 'v0.4.3_95435e' };
    const { vars, note } = resolveVersionVars({ repoVersion: '0.4.6', pinnedBaseline: null, needBase: true, reportOnly: true, priorVars: prior });
    expect(vars).toEqual(prior);
    expect(note).toContain('recorded report.json');
    // not report-only: priorVars ignored
    expect(resolveVersionVars({ repoVersion: '0.4.6', needBase: true, reportOnly: false, priorVars: prior }).vars)
      .toEqual({ expectVersion: '0.4.6', baselineVersion: null });
  });

  it('versionCoreOf extracts the core', () => {
    expect(versionCoreOf('v0.4.6_abc')).toBe('0.4.6');
    expect(versionCoreOf(null)).toBeNull();
  });
});
