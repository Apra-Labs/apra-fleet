import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateStep, evaluatePass, summarize, parseResults, renderMarkdown, STATUS, expand } from './lib/verdict.mjs';

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

  it('treats an unset placeholder as unchecked rather than failing', () => {
    expect(evaluateStep(checklist.passes.A.steps[0], rec('A1', 0, '', 'anything'), { vars: {} }).status).toBe(STATUS.PASS);
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
    const { records, errors } = parseResults('﻿{"id":"A1","exit":"0"}\r\nnot json\r\n\r\n');
    expect(records).toHaveLength(1);
    expect(errors).toHaveLength(1);
    const p = evaluatePass({ checklist, pass: 'A', platform: 'windows', records: [rec('A1', 0, 'ok ✓ | pipe', 'v0.4.3_78cefd')], vars });
    const md = renderMarkdown({ candidate: { path: 'x', sha256: 'y' }, vars, passes: [p], summary: summarize([p]), notes: ['n ⚠'] });
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
