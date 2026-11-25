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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReport } from './integration/member-host/lib/report.mjs';
import {
  ROLLBACK_OK, guardedReinstallCommand, listBackupsCommand, pickNewestBackup, restoreChecks, rollbackCommand, rollbackSteps, rollbackSucceeded,
} from './integration/member-host/lib/rollback.mjs';

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

describe('rollback (RB / RBS)', () => {
  const B = '/c/Users/fleetmember/.apra-fleet-replace-backup-20261125T010203Z';
  const snap = (over: Record<string, unknown> = {}) => ({ binaryVersion: 'apra-fleet 0.4.5', fleetKeySha256: 'k1', dataListing: ['agents.json', 'kb'], ...over });

  it('finds the newest replace-full backup and ignores anything else', () => {
    expect(listBackupsCommand()).toMatch(/^ls -1dt \$HOME\/\.apra-fleet-replace-backup-\* /);
    expect(pickNewestBackup(`${B}\n/c/Users/fleetmember/.apra-fleet-replace-backup-20261124T000000Z\n`)).toBe(B);
    expect(pickNewestBackup(`ls: cannot access\n${B}/\r\n`)).toBe(B);
    expect(pickNewestBackup('')).toBeNull();
    expect(pickNewestBackup("/c/Users/x/.apra-fleet-replace-backup-a'b")).toBeNull();
    expect(() => rollbackCommand("/tmp/x'; rm -rf /")).toThrow(/unexpected backup path/);
  });

  it('follows the documented order and gates every step on the previous one', () => {
    const steps = rollbackSteps(B);
    expect(steps[0]).toMatch(/apra-fleet\.exe" uninstall --force --yes$/);
    expect(steps[1]).toBe('rm -rf "$HOME/.apra-fleet/data"');
    expect(steps[2]).toBe(`cp -R '${B}/data' "$HOME/.apra-fleet/data"`);
    expect(steps[3]).toBe(`cp '${B}/fleet.key' "$HOME/.apra-fleet/fleet.key"`);
    expect(steps[4]).toBe(guardedReinstallCommand(B));
    const cmd = rollbackCommand(B);
    expect(cmd).toBe(`${steps.join(' && ')} && echo ${ROLLBACK_OK}`);
    expect(cmd).not.toMatch(/;/);
  });

  it('the RBS refusal attempt is the guarded reinstall ALONE: no uninstall, no data removal or restore', () => {
    const probe = guardedReinstallCommand(B);
    expect(probe).toBe(`chmod +x '${B}/apra-fleet.exe' && '${B}/apra-fleet.exe' install --llm none --force`);
    expect(probe).not.toMatch(/uninstall|rm -rf|cp /);
  });

  it('success needs both a clean exit and the final marker (a mid-chain failure is never masked)', () => {
    expect(rollbackSucceeded({ isError: false, text: `installed\n${ROLLBACK_OK}\n` })).toBe(true);
    expect(rollbackSucceeded({ isError: true, text: `${ROLLBACK_OK}\n` })).toBe(false);
    expect(rollbackSucceeded({ isError: false, text: 'uninstall failed' })).toBe(false);
    expect(rollbackSucceeded(null)).toBe(false);
  });

  it('data and key are MATCH only when EQUAL to the snapshot taken before replace-full', () => {
    const pre = snap();
    const ok = restoreChecks({ preReplace: pre, post: snap(), releaseVersion: 'v0.4.5' });
    expect([ok.version.keyline, ok.data.keyline, ok.key.keyline]).toEqual(['MATCH', 'MATCH', 'MATCH']);
    // A rollback that kept the candidate's data or key: non-empty but different.
    const kept = restoreChecks({ preReplace: pre, post: snap({ dataListing: ['agents.json', 'kb', 'member-install.json'], fleetKeySha256: 'k2' }), releaseVersion: 'v0.4.5' });
    expect(kept.data.keyline).toBe('MISMATCH');
    expect(kept.data.detail).toMatch(/member-install\.json/);
    expect(kept.key.keyline).toBe('MISMATCH');
    expect(restoreChecks({ preReplace: pre, post: snap({ binaryVersion: 'apra-fleet 0.5.0' }), releaseVersion: 'v0.4.5' }).version.keyline).toBe('MISMATCH');
  });

  it('no pre-replace snapshot, or an empty one, can never MATCH', () => {
    const none = restoreChecks({ preReplace: null, post: snap(), releaseVersion: 'v0.4.5' });
    expect([none.data.keyline, none.key.keyline]).toEqual(['MISMATCH', 'MISMATCH']);
    const empty = restoreChecks({ preReplace: snap({ dataListing: [], fleetKeySha256: '' }), post: snap({ dataListing: [], fleetKeySha256: '' }), releaseVersion: 'v0.4.5' });
    expect([empty.data.keyline, empty.key.keyline]).toEqual(['MISMATCH', 'MISMATCH']);
  });

  it('RB and RBS both check version, data and key; RBS proves the refusal changed nothing first', () => {
    const ids = (id: string) => PASSES.find((p: { id: string }) => p.id === id)!.steps.map((s: { id: string }) => s.id);
    expect(ids('RB')).toEqual(['rb-backup', 'rb-rollback', 'rb-version', 'rb-data', 'rb-key']);
    expect(ids('RBS')).toEqual(['rbs-backup', 'rbs-supervisor-started', 'rbs-refused', 'rbs-unchanged', 'rbs-supervisor-stopped', 'rbs-rollback', 'rbs-version', 'rbs-data', 'rbs-key']);
  });

  it('the driver wires them: guarded probe under the supervisor, gated rollback after, checks against the pre-replace snapshot', () => {
    const src = fs.readFileSync(path.join(__dirname, 'integration', 'member-host', 'run.mjs'), 'utf8');
    expect(src).not.toMatch(/full-install\.bak/);
    expect(src).toMatch(/preReplaceBy\[pass\] = pre;/);
    expect(src).toMatch(/restoreChecks\(\{ preReplace: preReplaceBy\[pass === 'RB' \? 'RF' : 'RFS'\]/);
    const start = src.indexOf("await startSupervisor('RBS')");
    const probe = src.indexOf('guardedReinstallCommand(backup)', start);
    const stop = src.indexOf("await stopSupervisor('RBS')", start);
    const full = src.indexOf('rollbackCommand(backup)', start);
    expect(start).toBeGreaterThan(0);
    expect(probe).toBeGreaterThan(start);
    expect(stop).toBeGreaterThan(probe);
    expect(full).toBeGreaterThan(stop);
    expect(src).toMatch(/rollbackSucceeded\(r\) \? 0 : 1/);
  });
});

describe('rollback command on a real bash, in a temp HOME with stub binaries', () => {
  const posixHost = process.platform === 'linux' || process.platform === 'darwin';

  const setup = (uninstallExit: number) => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'member-host-rb-')));
    const mh = path.join(home, '.apra-fleet');
    const backup = path.join(home, '.apra-fleet-replace-backup-20261125T000000Z');
    fs.mkdirSync(path.join(mh, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(mh, 'data'), { recursive: true });
    fs.writeFileSync(path.join(mh, 'data', 'member-install.json'), '{}');
    fs.writeFileSync(path.join(mh, 'fleet.key'), 'candidate-key');
    fs.writeFileSync(path.join(mh, 'bin', 'apra-fleet.exe'), `#!/bin/sh\necho "uninstall $*" >> "$HOME/calls.log"\nexit ${uninstallExit}\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(backup, 'data'), { recursive: true });
    fs.writeFileSync(path.join(backup, 'data', 'agents.json'), '[]');
    fs.writeFileSync(path.join(backup, 'fleet.key'), 'release-key');
    fs.writeFileSync(path.join(backup, 'apra-fleet.exe'), '#!/bin/sh\necho "reinstall $*" >> "$HOME/calls.log"\n', { mode: 0o644 });
    return { home, mh, backup };
  };
  const runIn = (home: string, cmd: string) => {
    const env = { ...process.env, HOME: home };
    expect(env.HOME.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    return spawnSync('bash', ['-c', cmd], { env, encoding: 'utf8' });
  };

  it.skipIf(!posixHost)('runs every step in order and restores data/ and fleet.key from the backup', () => {
    const { home, mh, backup } = setup(0);
    try {
      const r = runIn(home, rollbackCommand(backup));
      expect(r.status, r.stderr).toBe(0);
      expect(rollbackSucceeded({ isError: false, text: r.stdout })).toBe(true);
      expect(fs.readdirSync(path.join(mh, 'data'))).toEqual(['agents.json']);
      expect(fs.readFileSync(path.join(mh, 'fleet.key'), 'utf8')).toBe('release-key');
      expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).toBe('uninstall uninstall --force --yes\nreinstall install --llm none --force\n');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!posixHost)('a failing first step stops the chain: data/ and fleet.key untouched, no reinstall, no success marker', () => {
    const { home, mh, backup } = setup(3);
    try {
      const r = runIn(home, rollbackCommand(backup));
      expect(r.status).toBe(3);
      expect(rollbackSucceeded({ isError: true, text: r.stdout })).toBe(false);
      expect(r.stdout).not.toContain(ROLLBACK_OK);
      expect(fs.readdirSync(path.join(mh, 'data'))).toEqual(['member-install.json']);
      expect(fs.readFileSync(path.join(mh, 'fleet.key'), 'utf8')).toBe('candidate-key');
      expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).toBe('uninstall uninstall --force --yes\n');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
