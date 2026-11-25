/**
 * Pure scenario planning of the member-host upgrade passes: pass list and
 * expected outcomes, the no-destructive-change snapshot comparison, baseline
 * resolution (INCONCLUSIVE, never PASS, on a stale or missing baseline) and the
 * verdict mapping. No VM, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  PASS_IDS, PASSES, REFUSAL_CODE, buildChecklist, compareSnapshots, planPasses, resolveBaseline,
} from './integration/member-host/lib/scenarios.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { buildReport } from './integration/member-host/lib/report.mjs';

const pins = JSON.parse(JSON.stringify({
  baselines: {
    'v0.4.4': { repo: 'r/r', windows: { asset: 'a.exe', sha256: 'aa' } },
    'v0.4.5': { repo: 'r/r', windows: { asset: 'a.exe', sha256: 'bb' } },
  },
}));

describe('member-host scenario plan', () => {
  it('lists exactly Q, RF, RB, RFS, RBS in order', () => {
    expect(PASS_IDS).toEqual(['Q', 'RF', 'RB', 'RFS', 'RBS']);
    expect(planPasses().map((p: { id: string }) => p.id)).toEqual(['Q', 'RF', 'RB', 'RFS', 'RBS']);
  });

  it('RFS and RBS expect an E-FLEET-SE-RUNNING refusal with no destructive change; the others do not', () => {
    const plan = planPasses() as Array<{ id: string; refusalWithoutDestructiveChange: boolean; refusalCode: string | null }>;
    for (const p of plan) {
      const refusing = p.id === 'RFS' || p.id === 'RBS';
      expect(p.refusalWithoutDestructiveChange, p.id).toBe(refusing);
      expect(p.refusalCode, p.id).toBe(refusing ? 'E-FLEET-SE-RUNNING' : null);
    }
    expect(REFUSAL_CODE).toBe('E-FLEET-SE-RUNNING');
  });

  it('the refusal passes assert the unchanged snapshot, not just the error code', () => {
    for (const id of ['RFS', 'RBS']) {
      const steps = PASSES.find((p: { id: string }) => p.id === id)!.steps.map((s: { id: string }) => s.id);
      expect(steps.some((s: string) => s.endsWith('-refused'))).toBe(true);
      expect(steps.some((s: string) => s.endsWith('-unchanged'))).toBe(true);
    }
  });

  it('RB builds on RF and RBS on RFS; an unknown pass is rejected', () => {
    const plan = planPasses() as Array<{ id: string; requires: string | null }>;
    expect(plan.find(p => p.id === 'RB')!.requires).toBe('RF');
    expect(plan.find(p => p.id === 'RBS')!.requires).toBe('RFS');
    expect(() => planPasses(['ZZ'])).toThrow(/unknown pass/);
  });

  it('RF verifies the documented Verify list: version, member-install.json, tool list', () => {
    const ids = PASSES.find((p: { id: string }) => p.id === 'RF')!.steps.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['rf-version', 'rf-marker', 'rf-tools']));
  });
});

describe('compareSnapshots (no destructive change on refusal)', () => {
  const base = { binaryVersion: 'v0.4.5_703e81', fleetKeySha256: 'abc', dataListing: ['a.db', 'b.json'] };

  it('identical state is unchanged, regardless of listing order', () => {
    expect(compareSnapshots(base, { ...base, dataListing: ['b.json', 'a.db'] })).toEqual({ unchanged: true, diffs: [] });
  });

  it('flags a changed binary version, fleet.key hash or data listing', () => {
    expect(compareSnapshots(base, { ...base, binaryVersion: 'v0.4.6_x' }).diffs[0]).toMatch(/binary version/);
    expect(compareSnapshots(base, { ...base, fleetKeySha256: 'zzz' }).diffs).toEqual(['fleet.key hash changed']);
    const r = compareSnapshots(base, { ...base, dataListing: ['a.db'] });
    expect(r.unchanged).toBe(false);
    expect(r.diffs[0]).toMatch(/removed: b\.json/);
  });
});

describe('baseline resolution: stale or missing is INCONCLUSIVE', () => {
  it('current baseline (the pin equals the latest release) has no reasons', () => {
    const b = resolveBaseline({ pins, latestTag: 'v0.4.5' });
    expect(b.tag).toBe('v0.4.5');
    expect(b.sha256).toBe('bb');
    expect(b.reasons).toEqual([]);
  });

  it('a stale pin, an unresolvable latest release, no pins, or no digest each give a reason', () => {
    expect(resolveBaseline({ pins, latestTag: 'v0.4.6' }).reasons[0]).toMatch(/stale/);
    expect(resolveBaseline({ pins, latestTag: null, lookupError: 'offline' }).reasons[0]).toMatch(/unverified|offline/);
    expect(resolveBaseline({ pins: { baselines: {} }, latestTag: 'v0.4.5' }).reasons[0]).toMatch(/no release baseline/);
    const noDigest = { baselines: { 'v0.4.5': { windows: { asset: 'a.exe' } } } };
    expect(resolveBaseline({ pins: noDigest, latestTag: 'v0.4.5' }).reasons.join(' ')).toMatch(/sha256/);
  });
});

describe('verdict mapping (PASS / FAIL / INCONCLUSIVE)', () => {
  const okRecords = (pass: string) => {
    const p = PASSES.find((x: { id: string }) => x.id === pass)!;
    return p.steps.map((s: { id: string; expect: { keyline?: string } }) => ({
      pass, id: s.id, cmd: 'c', exit: 0, keyline: (s.expect.keyline ?? '').replace(/^\^|\$$/g, ''), observed: '',
    }));
  };
  const args = (over: Record<string, unknown> = {}) => ({
    passIds: ['RFS'], recordsByPass: { RFS: okRecords('RFS') }, startedAt: 's', finishedAt: 'f', ...over,
  });

  it('every step satisfied and a current baseline -> PASS (exit 0)', () => {
    const r = buildReport(args());
    expect(r.final).toMatchObject({ verdict: 'PASS', exitCode: 0 });
  });

  it('a stale or missing baseline -> INCONCLUSIVE (exit 3), never PASS', () => {
    const r = buildReport(args({ inconclusive: ['baseline pin stale'] }));
    expect(r.final).toMatchObject({ verdict: 'INCONCLUSIVE', exitCode: 3 });
    expect(r.markdown).toMatch(/Inconclusive: baseline pin stale/);
  });

  it('a refusal that changed state (snapshot CHANGED) -> FAIL (exit 1), beating INCONCLUSIVE', () => {
    const records = okRecords('RFS').map((x: { id: string }) => (x.id === 'rfs-unchanged' ? { ...x, keyline: 'CHANGED' } : x));
    const r = buildReport(args({ recordsByPass: { RFS: records }, inconclusive: ['stale'] }));
    expect(r.final).toMatchObject({ verdict: 'FAIL', exitCode: 1 });
  });

  it('a pass that never reported, or a driver error -> FAIL', () => {
    expect(buildReport(args({ recordsByPass: {} })).final.verdict).toBe('FAIL');
    expect(buildReport(args({ driverErrors: { RFS: 'no baseline' } })).final.verdict).toBe('FAIL');
  });

  it('report.md is ASCII and names the member-host report', () => {
    const md = buildReport(args()).markdown;
    expect(md).toMatch(/^# Member-host upgrade test report/);
    expect(/[^\x00-\x7f]/.test(md)).toBe(false);
  });

  it('the checklist covers every pass', () => {
    expect(Object.keys(buildChecklist().passes)).toEqual(PASS_IDS);
  });
});

describe('driver spawns every process with the sandbox env', () => {
  const src = fs.readFileSync(path.join(__dirname, 'integration', 'member-host', 'run.mjs'), 'utf8');

  it('each spawnSync call passes the sandbox env (HOME/USERPROFILE/GIT_CONFIG_GLOBAL redirected)', () => {
    const calls = src.match(/spawnSync\([^;]*;/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, c).toMatch(/\benv\b/);
    expect(src).toMatch(/const env = sandboxEnv\(process\.env, sb\)/);
  });
});
