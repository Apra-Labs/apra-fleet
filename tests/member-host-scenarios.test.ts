/**
 * Pure scenario planning of the member-host upgrade passes: pass list and
 * expected outcomes, the no-destructive-change snapshot comparison, baseline
 * resolution (INCONCLUSIVE, never PASS, on a stale or missing baseline) and the
 * verdict mapping. No VM, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  PASS_IDS, PASSES, REFUSAL_CODE, REPLACE_REFUSAL_REASON, buildChecklist, compareSnapshots, planPasses, resolveBaseline,
  KNOWN_GAP_MEMBER_SERVER, SERVER_NOT_STARTED, SERVER_CRASHED, toolListKeyline, namedServerLog, serverLogCrashed, predatesGapFix, taskRunState,
} from './integration/member-host/lib/scenarios.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReport } from './integration/member-host/lib/report.mjs';
import {
  ROLLBACK_OK, dataAsidePath, guardedReinstallCommand, listBackupsCommand, pickNewestBackup, restoreChecks, rollbackCommand, rollbackSteps, rollbackSucceeded,
} from './integration/member-host/lib/rollback.mjs';
import {
  baselineInstallArgs, supervisorStartCommand, supervisorStartOutcome, SUPERVISOR_ENTRY, SUPERVISOR_COPY_DIR, parseFleetSe, idleSupervisorStoppedNote,
  sprintStopCommand, serviceDiagCommand, cimProbeCommand, diagLine, supervisorCopyCommand, supervisorDiagCommand, SUPERVISOR_RUNTIME_PACKAGE,
} from './integration/member-host/lib/commands.mjs';

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

  it('RFS expects replace-full refused (reason fleet-se-running) and RBS the install guard (E-FLEET-SE-RUNNING), both with no destructive change; the others refuse nothing', () => {
    const plan = planPasses() as Array<{ id: string; refusalWithoutDestructiveChange: boolean; refusalCode: string | null }>;
    const codes: Record<string, string | null> = { Q: null, RF: null, RB: null, RFS: 'fleet-se-running', RBS: 'E-FLEET-SE-RUNNING' };
    for (const p of plan) {
      expect(p.refusalWithoutDestructiveChange, p.id).toBe(codes[p.id] !== null);
      expect(p.refusalCode, p.id).toBe(codes[p.id]);
    }
    expect(REFUSAL_CODE).toBe('E-FLEET-SE-RUNNING');
    expect(REPLACE_REFUSAL_REASON).toBe('fleet-se-running');
  });

  it('RFS refuses under a running sprint, then has replace-full stop the idle supervisor itself and checks the candidate version', () => {
    const ids = PASSES.find((p: { id: string }) => p.id === 'RFS')!.steps.map((s: { id: string }) => s.id);
    expect(ids).toEqual([
      'rfs-baseline-installed', 'rfs-workflows-copied', 'rfs-supervisor-started', 'rfs-sprint-started', 'rfs-refused',
      'rfs-unchanged', 'rfs-sprint-stopped', 'rfs-replace', 'rfs-supervisor-gone', 'rfs-version',
    ]);
    const replace = PASSES.find((p: { id: string }) => p.id === 'RFS')!.steps.find((s: { id: string }) => s.id === 'rfs-replace')!;
    expect(replace.expect.keyline).toBe('^IDLE-SUPERVISOR-STOPPED$');
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

  it('a one-shot service-notice.json (the release guard writes one when it refuses) is not a change; anything else still is', () => {
    expect(compareSnapshots(base, { ...base, dataListing: ['a.db', 'b.json', 'service-notice.json'] }).unchanged).toBe(true);
    const r = compareSnapshots(base, { ...base, dataListing: ['a.db', 'service-notice.json', 'member-install.json'] });
    expect(r.unchanged).toBe(false);
    expect(r.diffs[0]).toMatch(/added: member-install\.json; removed: b\.json/);
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

  const rfArgs = (toolsKey: string, observed = '') => {
    const records = okRecords('RF').map((x: { id: string }) => (x.id === 'rf-tools' ? { ...x, exit: 1, keyline: toolsKey, observed } : x));
    return { passIds: ['RF'], recordsByPass: { RF: records }, startedAt: 's', finishedAt: 'f' };
  };

  it('rf-tools failing only with the known-gap signature is ENV-LIMITED, not blocking, and named at the top of the report', () => {
    const r = buildReport(rfArgs(SERVER_NOT_STARTED));
    expect(r.final).toMatchObject({ verdict: 'PASS', exitCode: 0 });
    const step = r.passResults[0].steps.find((x: { id: string }) => x.id === 'rf-tools');
    expect(step).toMatchObject({ status: 'ENV-LIMITED', reason: KNOWN_GAP_MEMBER_SERVER });
    expect(r.knownGaps).toEqual([`${KNOWN_GAP_MEMBER_SERVER}: windows/RF rf-tools recorded, not counted as a failure`]);
    const lines = r.markdown.split('\n');
    expect(lines[lines.findIndex((l: string) => l.startsWith('- Overall: PASS')) + 1]).toBe(`- ${r.knownGaps[0]}`);
    expect(/[^\x00-\x7f]/.test(r.markdown)).toBe(false);
    expect(KNOWN_GAP_MEMBER_SERVER).not.toMatch(/apra-fleet-[a-z0-9]+/); // no tracker ids in printed text
  });

  it('any other rf-tools failure stays FAIL, and a clean run lists no known gap', () => {
    expect(buildReport(rfArgs('TOOLS-WRONG', 'Server starting via service manager... AUTOSTART')).final.verdict).toBe('FAIL');
    expect(buildReport(rfArgs(SERVER_CRASHED, 'Server starting via service manager... AUTOSTART')).final.verdict).toBe('FAIL');
    const ok = buildReport({ passIds: ['RF'], recordsByPass: { RF: okRecords('RF') }, startedAt: 's', finishedAt: 'f' });
    expect(ok.knownGaps).toEqual([]);
    expect(ok.markdown).not.toMatch(/KNOWN-GAP/);
  });
});

describe('rf-tools classification from the full call --list-tools output', () => {
  // The real error text of a CI run (JSON-escaped backslashes and all).
  const gap = String.raw`{"error":{"code":"AUTOSTART_TIMEOUT","message":"Started the apra-fleet HTTP server but it did not answer /health within 45000ms. Check the last server log: C:\\Users\\fleetmember\\.apra-fleet\\data\\logs\\fleet-4540.log.\n'C:\\Users\\fleetmember\\.apra-fleet\\bin\\apra-fleet.exe start' said: Server starting via service manager...\nServer did not start in time. Check logs at: C:\\Users\\fleetmember\\.apra-fleet\\data\\fleet.log"}}`;
  const cand = 'v0.4.6_3e4540';

  it('TOOLS-OK only for the member tool set; the service-manager auto-start timeout is the known gap; anything else is TOOLS-WRONG', () => {
    expect(toolListKeyline(0, 'kb_query\ncode_query\n', cand)).toBe('TOOLS-OK');
    expect(toolListKeyline(0, 'kb_query\ncode_query\nexecute_command\n', cand)).toBe('TOOLS-WRONG');
    expect(toolListKeyline(1, gap, cand)).toBe(SERVER_NOT_STARTED);
    // A timeout without the service-manager start, or another auto-start error, is not the gap.
    expect(toolListKeyline(1, '{"error":{"code":"AUTOSTART_TIMEOUT","message":"waiting for another client"}}', cand)).toBe('TOOLS-WRONG');
    expect(toolListKeyline(1, '{"error":{"code":"AUTOSTART_VERSION_SKEW"}} via service manager', cand)).toBe('TOOLS-WRONG');
    expect(toolListKeyline(0, gap, cand)).toBe('TOOLS-WRONG');
  });

  it('the gap expires: a candidate at or past the fix, or of unknown version, gets no excuse', () => {
    expect(toolListKeyline(1, gap, 'v0.4.7_abc123')).toBe('TOOLS-WRONG');
    expect(toolListKeyline(1, gap, 'v0.5.0')).toBe('TOOLS-WRONG');
    expect(toolListKeyline(1, gap, null)).toBe('TOOLS-WRONG');
    expect(predatesGapFix('v0.4.6_x')).toBe(true);
    expect(predatesGapFix('v0.4.10')).toBe(false);
    expect(predatesGapFix('0.3.99')).toBe(true);
  });

  it('names the server log the error points at (plain drive path only), and spots a crash in it', () => {
    expect(namedServerLog(gap)).toBe('C:\\Users\\fleetmember\\.apra-fleet\\data\\logs\\fleet-4540.log');
    expect(namedServerLog('Check the last server log: C:\\x"; rm -rf ~; ".log')).toBeNull();
    expect(namedServerLog('no log named')).toBeNull();
    expect(serverLogCrashed('{"level":"error","tag":"shutdown","reason":"uncaughtException","pid":1}')).toBe(true);
    expect(serverLogCrashed('{"level":"error","tag":"shutdown","reason":"unhandledRejection"}')).toBe(true);
    expect(serverLogCrashed('FATAL: cannot bind')).toBe(true);
    expect(serverLogCrashed('server exited with code 3')).toBe(true);
    expect(serverLogCrashed('== /c/x/fleet.log\ntail: cannot open /c/x/fleet.log for reading: No such file or directory')).toBe(false);
    expect(serverLogCrashed('{"level":"info","tag":"start","msg":"listening"}')).toBe(false);
  });

  // Captured verbatim from node v22.19.0: `node -e "Promise.reject(new Error('boom'))"`, exit 1.
  // A throw before the server installs its handlers leaves only this in data/fleet.log.
  const NODE_UNHANDLED_REJECTION = [
    '[eval]:1',
    "Promise.reject(new Error('boom'))",
    '               ^',
    '',
    'Error: boom',
    '    at [eval]:1:16',
    '    at runScriptInThisContext (node:internal/vm:209:10)',
    '    at node:internal/process/execution:446:12',
    '    at [eval]-wrapper:6:24',
    '    at runScriptInContext (node:internal/process/execution:444:60)',
    '    at evalFunction (node:internal/process/execution:279:30)',
    '    at evalTypeScript (node:internal/process/execution:291:3)',
    '    at node:internal/main/eval_string:74:3',
    '',
    'Node.js v22.19.0',
    '',
  ].join('\r\n');
  // Captured from node v22.19.0: an ESM import of a missing module (path shortened), exit 1.
  const NODE_MODULE_NOT_FOUND = [
    'node:internal/modules/esm/resolve:274',
    '    throw new ERR_MODULE_NOT_FOUND(',
    '          ^',
    '',
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\\x\\does-not-exist-pkg-xyz' imported from C:\\x\\[eval]",
    '    at finalizeResolution (node:internal/modules/esm/resolve:274:11)',
    '    at moduleResolve (node:internal/modules/esm/resolve:859:10)',
    '    at defaultResolve (node:internal/modules/esm/resolve:983:11) {',
    "  code: 'ERR_MODULE_NOT_FOUND',",
    "  url: 'file:///C:/x/does-not-exist-pkg-xyz'",
    '}',
    '',
    'Node.js v22.19.0',
  ].join('\n');
  // The shape writeLog (src/utils/log-helpers.ts) emits: ts, level, tag, msg; plus its stderr mirror.
  const startupRecord = JSON.stringify({ ts: '2026-11-27T12:00:00.000+05:30', level: 'error', tag: 'startup', msg: 'port 7523 is held by another user' });
  const startFailedRecord = JSON.stringify({ ts: '2026-11-27T12:00:00.000+05:30', level: 'error', tag: 'cli', msg: 'Start failed: Server did not start in time' });

  it('a real Node start-up crash (no server record, only the default crash text) is a crash', () => {
    expect(serverLogCrashed(`== /c/u/.apra-fleet/data/fleet.log\n${NODE_UNHANDLED_REJECTION}`)).toBe(true);
    expect(serverLogCrashed(NODE_MODULE_NOT_FOUND)).toBe(true);
    // And what this node prints right now, not just the captured copies.
    for (const code of ["Promise.reject(new Error('boom'))", "throw new Error('sync boom')"]) {
      const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(serverLogCrashed(`${r.stdout}${r.stderr}`)).toBe(true);
    }
  });

  it('an error-level start-up record is a crash; the start CLI failing at error level (the gap itself) is not', () => {
    expect(serverLogCrashed(startupRecord)).toBe(true);
    expect(serverLogCrashed('[fleet:error] startup port 7523 is held by another user')).toBe(true);
    expect(serverLogCrashed(`${startFailedRecord}\n[fleet:error] cli Start failed: Server did not start in time`)).toBe(false);
    expect(serverLogCrashed('Server starting via service manager...\nServer did not start in time. Check logs at: C:\\x\\fleet.log')).toBe(false);
  });

  it('task Last Result: only never-ran codes are the gap; a run that ended (any code) or still runs is not', () => {
    const diag = (v: string) => `TASK Status: Ready ; Last Run Time: 11/30/1999 12:00:00 AM ; Last Result: ${v} ; Logon Mode: Interactive only`;
    expect(taskRunState(diag('267011'))).toEqual({ state: 'never-ran', code: 0x41303 });
    expect(taskRunState(diag('-2147020576')).state).toBe('never-ran'); // 0x800710E0 refused
    expect(taskRunState(diag('0x80070520')).state).toBe('never-ran');
    expect(taskRunState(diag('267009')).state).toBe('running');
    expect(taskRunState(diag('1'))).toEqual({ state: 'exited', code: 1 });
    expect(taskRunState(diag('0')).state).toBe('exited');
    expect(taskRunState('TASK ERROR: The system cannot find the file specified.')).toEqual({ state: 'unknown', code: null });
  });

  it('the driver classifies from the full output, reads the named log before excusing, and warns loudly', () => {
    const src = fs.readFileSync(path.join(__dirname, 'integration', 'member-host', 'run.mjs'), 'utf8');
    expect(src).toMatch(/toolListKeyline\(t\.exitCode, t\.exitCode === 0 \? t\.stdout : out\(t\), candVersion\)/);
    expect(src).toMatch(/const crashed = l\.exitCode !== 0 \|\| serverLogCrashed\(l\.stdout\);/);
    expect(src).toMatch(/if \(crashed \|\| task\.state === 'exited' \|\| task\.state === 'running'\) toolsKey = SERVER_CRASHED;/);
    expect(src.indexOf('taskRunState(sd.stdout)')).toBeLessThan(src.indexOf("rec('RF', 'rf-tools'"));
    expect(src).toMatch(/::warning title=member-host known gap::/);
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
    const aside = dataAsidePath(B);
    expect(aside).toBe(`$HOME/.apra-fleet/data.replaced-${/replace-backup-(.+)$/.exec(B)![1]}`);
    expect(steps[0]).toMatch(/apra-fleet\.exe" uninstall --force --yes$/);
    // docs/install.md Rollback: the aside copy; data/ kept if never moved; the backup only when neither exists.
    expect(steps[1]).toBe(`if [ -d "${aside}" ]; then rm -rf "$HOME/.apra-fleet/data" && mv "${aside}" "$HOME/.apra-fleet/data"; elif [ ! -d "$HOME/.apra-fleet/data" ]; then cp -R '${B}/data' "$HOME/.apra-fleet/data"; fi`);
    // fleet.key only if missing.
    expect(steps[2]).toBe(`if [ ! -f "$HOME/.apra-fleet/fleet.key" ] && [ -f '${B}/fleet.key' ]; then cp '${B}/fleet.key' "$HOME/.apra-fleet/fleet.key"; fi`);
    expect(steps[3]).toBe(guardedReinstallCommand(B));
    const cmd = rollbackCommand(B);
    expect(cmd).toBe(`${steps.join(' && ')} && echo ${ROLLBACK_OK}`);
    // The only ';' are inside the two conditional steps.
    expect(cmd.replace(steps[1], '').replace(steps[2], '')).not.toMatch(/;/);
  });

  it('the RBS refusal attempt is the guarded reinstall ALONE: no uninstall, no data removal or restore', () => {
    const probe = guardedReinstallCommand(B);
    expect(probe).toBe(`chmod +x '${B}/apra-fleet.exe' && '${B}/apra-fleet.exe' install --llm claude --force`);
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
    // The release's first install leaves a one-shot service-notice.json that the rollback's reinstall clears: not state.
    const withNotice = restoreChecks({ preReplace: snap({ dataListing: [...pre.dataListing, 'service-notice.json'] }), post: snap(), releaseVersion: 'v0.4.5' });
    expect(withNotice.data.keyline).toBe('MATCH');
    expect(withNotice.data.detail).toMatch(/ignored: service-notice\.json/);
    const lost = restoreChecks({ preReplace: snap({ dataListing: [...pre.dataListing, 'service-notice.json'] }), post: snap({ dataListing: ['agents.json'] }), releaseVersion: 'v0.4.5' });
    expect(lost.data.keyline).toBe('MISMATCH');
    expect(kept.data.detail).toMatch(/member-install\.json/);
    expect(kept.key.keyline).toBe('MISMATCH');
    expect(restoreChecks({ preReplace: pre, post: snap({ binaryVersion: 'apra-fleet 0.5.0' }), releaseVersion: 'v0.4.5' }).version.keyline).toBe('MISMATCH');
  });

  it('no pre-replace snapshot, or an empty one, can never MATCH', () => {
    const none = restoreChecks({ preReplace: null, post: snap(), releaseVersion: 'v0.4.5' });
    expect([none.data.keyline, none.key.keyline]).toEqual(['MISMATCH', 'MISMATCH']);
    const empty = restoreChecks({ preReplace: snap({ dataListing: [], fleetKeySha256: '' }), post: snap({ dataListing: [], fleetKeySha256: '' }), releaseVersion: 'v0.4.5' });
    expect(empty.data.keyline).toBe('MISMATCH');
    expect(restoreChecks({ preReplace: null, post: snap({ fleetKeySha256: '' }), releaseVersion: 'v0.4.5' }).key.keyline).toBe('MISMATCH');
  });

  it('fleet.key absent before replace and absent after rollback is a MATCH; any other absence mix is a MISMATCH', () => {
    const key = (pre: string, post: string) => restoreChecks({ preReplace: snap({ fleetKeySha256: pre }), post: snap({ fleetKeySha256: post }), releaseVersion: 'v0.4.5' }).key.keyline;
    expect(key('', '')).toBe('MATCH');
    expect(key('', 'k2')).toBe('MISMATCH');
    expect(key('k1', '')).toBe('MISMATCH');
    expect(key('k1', 'k2')).toBe('MISMATCH');
    expect(key('k1', 'k1')).toBe('MATCH');
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
    const start = src.indexOf("await startSupervisor('RBS'");
    // The probe command is built before the start (the skip record names it); it RUNS after.
    expect(src).toMatch(/const probe = guardedReinstallCommand\(backup\);/);
    const probe = src.indexOf('await exec(probe, 300)', start);
    const stop = src.indexOf("await stopSupervisor('RBS')", start);
    const full = src.indexOf('rollbackCommand(backup)', start);
    expect(start).toBeGreaterThan(0);
    expect(probe).toBeGreaterThan(start);
    expect(stop).toBeGreaterThan(probe);
    expect(full).toBeGreaterThan(stop);
    // The rollback's success is its real exit code (structuredContent), not the MCP isError.
    expect(src).toMatch(/rollbackSucceeded\(\{ isError: r\.exitCode !== 0, text: r\.stdout \}\) \? 0 : 1/);
  });

  it('exit codes come from execute_command structuredContent, never from isError (a nonzero exit is not an MCP error)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'integration', 'member-host', 'run.mjs'), 'utf8');
    expect(src).toMatch(/execOutcome\(r\)/);
    expect(src).toMatch(/rec\(pass, `\$\{pass\.toLowerCase\(\)\}-baseline-installed`, `baseline \$\{installArgs\}`, r\.exitCode/);
    expect(src).toMatch(/verifyEcho\(c, r\.stdout\)/);
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
    // replace-full moved the old data aside under the backup's stamp.
    const aside = path.join(mh, 'data.replaced-20261125T000000Z');
    fs.mkdirSync(aside, { recursive: true });
    fs.writeFileSync(path.join(aside, 'registry.json'), '{}');
    return { home, mh, backup, aside };
  };
  const runIn = (home: string, cmd: string) => {
    const env = { ...process.env, HOME: home };
    expect(env.HOME.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    return spawnSync('bash', ['-c', cmd], { env, encoding: 'utf8' });
  };

  it.skipIf(!posixHost)('runs every step in order: data/ from the aside copy, an existing fleet.key kept', () => {
    const { home, mh, backup, aside } = setup(0);
    try {
      const r = runIn(home, rollbackCommand(backup));
      expect(r.status, r.stderr).toBe(0);
      expect(rollbackSucceeded({ isError: false, text: r.stdout })).toBe(true);
      expect(fs.readdirSync(path.join(mh, 'data'))).toEqual(['registry.json']);
      expect(fs.existsSync(aside)).toBe(false);
      // Restored only if missing: the key the member has stays.
      expect(fs.readFileSync(path.join(mh, 'fleet.key'), 'utf8')).toBe('candidate-key');
      expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).toBe('uninstall uninstall --force --yes\nreinstall install --llm claude --force\n');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!posixHost)('no aside copy: data/ in place is kept; with no data/ either, the backup is used; a missing fleet.key is restored', () => {
    const { home, mh, backup, aside } = setup(0);
    fs.rmSync(aside, { recursive: true });
    fs.rmSync(path.join(mh, 'fleet.key'));
    try {
      expect(runIn(home, rollbackCommand(backup)).status).toBe(0);
      expect(fs.readdirSync(path.join(mh, 'data'))).toEqual(['member-install.json']);
      expect(fs.readFileSync(path.join(mh, 'fleet.key'), 'utf8')).toBe('release-key');
      fs.rmSync(path.join(mh, 'data'), { recursive: true });
      expect(runIn(home, rollbackCommand(backup)).status).toBe(0);
      expect(fs.readdirSync(path.join(mh, 'data'))).toEqual(['agents.json']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!posixHost)('a backup without fleet.key: the chain is intact and succeeds', () => {
    const { home, mh, backup } = setup(0);
    fs.rmSync(path.join(backup, 'fleet.key'));
    try {
      const r = runIn(home, rollbackCommand(backup));
      expect(r.status, r.stderr).toBe(0);
      expect(rollbackSucceeded({ isError: false, text: r.stdout })).toBe(true);
      expect(fs.readFileSync(path.join(mh, 'fleet.key'), 'utf8')).toBe('candidate-key');
      expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).toBe('uninstall uninstall --force --yes\nreinstall install --llm claude --force\n');
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

describe('member-host baseline install and supervisor start (RFS / RBS)', () => {
  const runSrc = () => fs.readFileSync(path.join(__dirname, 'integration', 'member-host', 'run.mjs'), 'utf8');

  it('RFS and RBS install the baseline WITH the workflow runtime; RF and RB keep the core-only install', () => {
    expect(baselineInstallArgs('RFS')).toEqual([]);
    expect(baselineInstallArgs('RBS')).toEqual([]);
    expect(baselineInstallArgs('RF')).toEqual(['--workflows', 'none']);
    expect(baselineInstallArgs('RB')).toEqual(['--workflows', 'none']);
    expect(() => baselineInstallArgs('Q')).toThrow(/installs no baseline/);
  });

  it('the driver builds the baseline install from baselineInstallArgs, never a hard-coded --workflows none', () => {
    const src = runSrc();
    expect(src).toMatch(/baselineInstallArgs\(pass\)/);
    expect(src).not.toMatch(/install --workflows none`/);
  });

  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const home = 'C:\\Users\\fleetmember';

  it('the supervisor starts detached (job breakaway first), from the installed tree or the RBS copy, with the member profile env', () => {
    const installed = supervisorStartCommand({ node, home });
    expect(installed).toContain('[ ! -f "/c/Users/fleetmember/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs" ]');
    const ps = Buffer.from(/EncodedCommand (\S+)/.exec(installed)![1], 'base64').toString('utf16le');
    expect(ps).toMatch(/Add-Type -TypeDefinition/);
    expect(ps).toContain('0x01000000u, 0u'); // CREATE_BREAKAWAY_FROM_JOB, then without it
    expect(ps).not.toMatch(/Invoke-CimMethod/); // refused with Access denied for a key-auth SSH user
    expect(ps).toContain('set "USERPROFILE=C:\\Users\\fleetmember"');
    expect(ps).toContain('"C:\\Users\\fleetmember\\.apra-fleet\\workflows\\fleet-sprint\\bin\\serve.mjs"');
    expect(supervisorStartCommand({ node, home, fromCopy: true })).toContain(`/c/Users/fleetmember/${SUPERVISOR_COPY_DIR}/workflows/fleet-sprint/bin/serve.mjs`);
  });

  it('the RBS copy keeps the installed layout: node_modules/ next to workflows/, checked for the package serve.mjs imports', () => {
    const c = supervisorCopyCommand('$HOME/.apra-fleet');
    expect(c).toContain(`cp -R "$HOME/.apra-fleet/workflows" "$HOME/${SUPERVISOR_COPY_DIR}/workflows"`);
    expect(c).toContain(`cp -R "$HOME/.apra-fleet/node_modules" "$HOME/${SUPERVISOR_COPY_DIR}/node_modules"`);
    expect(c).toContain(`test -d "$HOME/${SUPERVISOR_COPY_DIR}/${SUPERVISOR_RUNTIME_PACKAGE}"`);
    expect(c).toMatch(/&& echo copied$/);
  });

  it('a supervisor that was not seen gets its pid liveness (no CIM) and both logs as diagnostics', () => {
    const d = supervisorDiagCommand(1234);
    const ps = Buffer.from(/EncodedCommand (\S+)/.exec(d)![1], 'base64').toString('utf16le');
    expect(ps).toMatch(/Get-Process -Id 1234/);
    expect(ps).not.toMatch(/Cim/);
    expect(d).toContain('$HOME/supervisor.log');
    expect(d).toContain('$HOME/.apra-fleet-se/logs/supervisor.log');
    expect(supervisorDiagCommand(null)).toMatch(/^echo "PID-NONE/);
  });

  it('supervisor-started needs the launch pid AND a later fleet-se-check seeing it; a missing serve.mjs is named', () => {
    const out = supervisorStartOutcome(`SUPERVISOR-ENTRY-MISSING: ${SUPERVISOR_ENTRY} does not exist on the member (x)\n`);
    expect(out.exit).toBe(1);
    expect(out.observed).toContain('workflows/fleet-sprint/bin/serve.mjs');
    const seen = 'FLEET_SE_CHECK ok\nFLEET_SE supervisor pid=6 port=8787\n';
    expect(supervisorStartOutcome('LAUNCHED rc=0 pid=5\r\n', seen)).toMatchObject({ exit: 0 });
    expect(supervisorStartOutcome('LAUNCHED rc=0 pid=5', 'FLEET_SE_CHECK ok\n').exit).toBe(1); // died with the session
    expect(supervisorStartOutcome('LAUNCHED rc=0 pid=5 breakaway=no\n', seen)).toMatchObject({ exit: 0 });
    expect(supervisorStartOutcome('LAUNCHED rc=5 pid=0', seen).exit).toBe(1);
    expect(supervisorStartOutcome('LAUNCHED rc= pid=', seen).exit).toBe(1);
    // A refused PowerShell call reports the PowerShell message line, not its CategoryInfo tail.
    const denied = 'Invoke-CimMethod : Access denied\n+ CategoryInfo : PermissionDenied\n+ FullyQualifiedErrorId : HRESULT 0x80041003\n';
    expect(supervisorStartOutcome(denied).observed).toBe('Invoke-CimMethod : Access denied');
  });

  const decodePs = (cmd: string) => Buffer.from(/EncodedCommand (\S+)/.exec(cmd)![1], 'base64').toString('utf16le');

  it('stopping the stand-in sprint silences PowerShell progress (no CLIXML on stderr)', () => {
    expect(decodePs(sprintStopCommand(42))).toMatch(/^\$ProgressPreference = 'SilentlyContinue'; Stop-Process -Id 42 /);
  });

  it('diagnostics: service state via PowerShell (no MSYS path mangling) and the guard\'s own CIM probe', () => {
    const diag = decodePs(serviceDiagCommand());
    expect(diag).toContain('schtasks.exe /query /tn ApraFleet /v /fo LIST');
    expect(diag).toContain("reg.exe query 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' /v ApraFleet");
    expect(diag).toContain("-split '\\r?\\n'");
    const cim = decodePs(cimProbeCommand(7680));
    expect(cim).toContain('Get-CimInstance Win32_Process -Filter "ProcessId=7680" -ErrorAction Stop');
    expect(cim).toContain("'CIM-ERR ' + $_.Exception.Message");
    expect(() => cimProbeCommand('7; calc')).toThrow(/bad pid/);
    expect(diagLine('#< CLIXML\r\nTASK a\r\n<Objs x>\r\n\r\nRUNKEY b')).toBe('TASK a | RUNKEY b');
  });

  it('a refusal attempt whose precondition failed is recorded FAIL and never run', () => {
    const src = runSrc();
    expect(src).toMatch(/if \(sprintSeen\) \{[\s\S]*?await replaceFull\(\)[\s\S]*?\} else \{\s*skipped\('RFS', 'rfs-refused'/);
    expect(src).toMatch(/if \(await startSupervisor\('RBS', true\)\) \{[\s\S]*?await exec\(probe, 300\)[\s\S]*?\} else \{\s*skipped\('RBS', 'rbs-refused'/);
    // The release's workflows/ is copied right after its install, before any replace-full can remove it.
    expect(src.indexOf("'rfs-workflows-copied'")).toBeLessThan(src.indexOf("await startSupervisor('RFS')"));
  });

  it('parses fleet-se-check and recognizes the replace-full idle-supervisor note', () => {
    expect(parseFleetSe('FLEET_SE_CHECK ok\r\nFLEET_SE supervisor pid=10 port=8787\nFLEET_SE sprint pid=42 id=x\n'))
      .toEqual({ ok: true, supervisor: { pid: 10, port: 8787 }, sprints: [42] });
    expect(parseFleetSe('Error: unknown option').ok).toBe(false);
    expect(idleSupervisorStoppedNote('...; the idle fleet-sprint supervisor (port 8787) was stopped in step 0; it was started by hand')).toBe(true);
    expect(idleSupervisorStoppedNote('replaced the apra-fleet v0.4.5 full install')).toBe(false);
  });

  it.skipIf(!(process.platform === 'linux' || process.platform === 'darwin'))('on a real bash with no serve.mjs the command exits non-zero naming the path', () => {
    const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'member-host-sup-')));
    try {
      const r = spawnSync('bash', ['-c', supervisorStartCommand({ node: 'node', home: tmpHome })], { env: { ...process.env, HOME: tmpHome }, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('.apra-fleet/workflows/fleet-sprint/bin/serve.mjs');
      expect(supervisorStartOutcome(r.stdout).observed).toContain('SUPERVISOR-ENTRY-MISSING');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
