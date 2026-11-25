/**
 * Opt-in full-install replacement (fleet_install "replace-full"), driven with a
 * FAKE member transport per OS:
 *
 *  - with the opt-in on an unmarked (full) install, the member gets the full
 *    command sequence in order: backup (data + fleet.key), uninstall with the
 *    installed binary, linux fleet-supervisor stop/disable, data moved aside,
 *    the staged current installer in member mode;
 *  - without the opt-in, a full install gets zero destructive commands;
 *  - with the opt-in but a marker probe failure, zero destructive commands and
 *    reason probe-failed;
 *  - a failure after the uninstall names the failed step and the rollback;
 *  - update_member / register_member schemas and the client typedefs accept
 *    the new value.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeTestAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import {
  ensureMemberFleetInstall, buildReplaceFullInstallPlan, REPLACE_FULL_INSTALL, FLEET_MCP_FIX, ReleaseDownloadError,
  buildSelfRegisterCommand, buildSelfRemoveCommand, buildMemberCallCommand, buildExeLockProbe, buildManualInstallSteps,
  type MemberFleetInstallDeps,
} from '../src/services/member-fleet-install.js';
import { updateMemberSchema } from '../src/tools/update-member.js';
import { registerMemberSchema } from '../src/tools/register-member.js';

const ORCH = 'v0.4.4';
const OLD = 'v0.4.2';
const NOW = new Date(Date.UTC(2026, 9, 6, 14, 30, 0));
const STAMP = '20261006T143000Z';

interface Platform { os: 'linux' | 'macos' | 'windows'; home: string; sep: string; shell?: string; arch: string }
const LINUX: Platform = { os: 'linux', home: '/home/bella', sep: '/', arch: 'x64' };
const MACOS: Platform = { os: 'macos', home: '/Users/bella', sep: '/', arch: 'arm64' };
const WINDOWS: Platform = { os: 'windows', home: 'C:\\Users\\bella', sep: '\\', shell: 'powershell5', arch: 'x64' };

function agentFor(p: Platform): Agent {
  return makeTestAgent({ os: p.os, ...(p.shell ? { shell: p.shell } : {}), llmProvider: 'claude', workFolder: `${p.home}${p.sep}repo`, friendlyName: 'bella' } as Partial<Agent>);
}

type MarkerMode = 'absent' | 'present' | 'timeout';
type Step = 'supervisor-check' | 'supervisor-stop' | 'supervisor-recheck' | 'supervisor-restart' | 'stop' | 'stop-check' | 'backup' | 'exe-check' | 'uninstall' | 'supervisor' | 'move-data' | 'install';

/** Classify a decoded member command as one of the replacement's destructive steps. */
function stepOf(c: string): Step | null {
  // A Git Bash member runs the supervisor stop through a nested powershell.exe -EncodedCommand.
  const nested = /powershell\.exe -NoProfile -NonInteractive -EncodedCommand (\S+)/.exec(c);
  const inner = nested ? Buffer.from(nested[1], 'base64').toString('utf16le') : c;
  if (inner.includes('__APRA_FLEET_SUPERVISOR_VIA__')) return 'supervisor-stop';
  if (c.includes('schtasks.exe /Run') || c.includes('systemctl --user start fleet-supervisor')) return 'supervisor-restart';
  if (/' 'fleet-se-check'/.test(c)) return 'supervisor-check';
  if (c.includes('__APRA_FLEET_EXE_LOCKED__')) return 'exe-check';
  if (/apra-fleet(\.exe)?' stop(;|$| )/.test(c)) return 'stop';
  if (/apra-fleet(\.exe)?' status(;|$| )/.test(c)) return 'stop-check';
  if (c.includes('.apra-fleet-replace-backup-') && c.includes('fleet.key') && !c.includes('uninstall')) return 'backup';
  if (c.includes('uninstall --force --yes')) return 'uninstall';
  if (c.includes('systemctl')) return 'supervisor';
  if (c.includes('data.replaced-')) return 'move-data';
  if (c.includes("'install' '--llm'")) return 'install';
  return null;
}

function harness(p: Platform, opts: { marker?: MarkerMode; failStep?: Step; serverStaysUp?: boolean; supervisorLine?: string; exeLocked?: boolean; supervisorSurvivesStop?: boolean; supervisorVia?: 'task' | 'unit' | 'manual' } = {}) {
  const log: string[] = [];
  const events: string[] = [];
  const w = { installed: OLD as string | null, marker: opts.marker ?? 'absent' as MarkerMode, checks: 0, supervisorUp: true };
  const via = opts.supervisorVia ?? (p.os === 'windows' ? 'task' : p.os === 'linux' ? 'unit' : 'manual');
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  const deps: MemberFleetInstallDeps = {
    exec: async (_a, raw) => {
      const c = decodePowerShellEncodedCommand(raw);
      log.push(c);
      let step = stepOf(c);
      // The re-check after the supervisor stop is the same fleet-se-check command.
      if (step === 'supervisor-check' && w.checks++ > 0) step = 'supervisor-recheck';
      if (step) {
        events.push(step);
        if (step === opts.failStep) return { stdout: '', stderr: `${step} broke`, code: 1 };
        // The installed (old) binary's status never carries a Supervisor line; the staged fleet-se-check does the detecting.
        if (step === 'supervisor-check' || step === 'supervisor-recheck') {
          const lines = (opts.supervisorLine ?? '').split('\n').filter(l => w.supervisorUp || !l.startsWith('FLEET_SE supervisor ')).join('\n');
          return ok('FLEET_SE_CHECK ok\n' + lines);
        }
        if (step === 'supervisor-stop') { w.supervisorUp = !!opts.supervisorSurvivesStop; return ok(`__APRA_FLEET_SUPERVISOR_VIA__ ${via}\n`); }
        if (step === 'exe-check') return ok(opts.exeLocked ? '__APRA_FLEET_EXE_LOCKED__ The process cannot access the file because it is being used by another process.\n' : '__APRA_FLEET_EXE_FREE__\n');
        if (step === 'stop-check') return ok(opts.serverStaysUp ? 'apra-fleet status\n  State:    running\n' : 'apra-fleet status\n  State:    stopped\n');
        if (step === 'uninstall') w.installed = null;
        if (step === 'install') { w.installed = ORCH; w.marker = 'present'; return ok('installed'); }
        if (step === 'supervisor') return ok('__APRA_FLEET_SUPERVISOR_MOVED__\n');
        return ok('');
      }
      if (c.includes('member-install.json')) {
        if (w.marker === 'timeout') throw new Error('Command timed out after 15000ms of inactivity');
        return { stdout: '', stderr: '', code: w.marker === 'present' ? 0 : 1 };
      }
      if (c.includes('--version')) return ok(w.installed ? `apra-fleet ${w.installed}\n` : '__APRA_FLEET_NO_INSTALL__\n');
      if (c.includes('uname -m')) return ok(p.arch === 'arm64' ? 'arm64\n' : 'x86_64\n');
      if (c.includes('PROCESSOR_ARCHITECTURE')) return ok('AMD64');
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, paths, dir) => { events.push(`transfer:${dir}`); return { success: paths, failed: [] }; },
    resolveHome: async () => p.home,
    orchestratorPlatform: () => ({ os: p.os, arch: p.arch }),
    orchestratorExecutable: () => (p.os === 'windows' ? 'C:\\fleet\\apra-fleet.exe' : '/opt/fleet/apra-fleet'),
    orchestratorVersion: () => ORCH,
    downloadReleaseAsset: async () => { throw new Error('not expected'); },
    removeLocal: () => {},
    now: () => NOW,
  };
  return { deps, log, events, w };
}

const destructive = (events: string[]) => events.filter(e => !e.startsWith('transfer:') && e !== 'stop' && e !== 'stop-check' && e !== 'supervisor-check' && e !== 'exe-check');

describe('replace-full: full command sequence per OS', () => {
  it('linux: stage, backup (data + fleet.key), uninstall, supervisor stop/disable, move data, member install', async () => {
    const h = harness(LINUX);
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'available', version: ORCH, installed: true });
    // The installer is staged BEFORE anything destructive.
    expect(h.events).toEqual([`transfer:${LINUX.home}/.apra-fleet/staging`, 'supervisor-check', 'stop', 'stop-check', 'backup', 'uninstall', 'supervisor', 'move-data', 'install']);
    const backupDir = `${LINUX.home}/.apra-fleet-replace-backup-${STAMP}`;
    const backup = h.log.find(c => stepOf(c) === 'backup')!;
    expect(backup).toContain(`cp -R '${LINUX.home}/.apra-fleet/data' '${backupDir}/data'`);
    expect(backup).toContain(`cp '${LINUX.home}/.apra-fleet/fleet.key' '${backupDir}/fleet.key'`);
    expect(backup).toContain(`cp '${LINUX.home}/.apra-fleet/bin/apra-fleet' '${backupDir}/apra-fleet'`);
    // d05q: the uninstall runs the BACKUP copy of the binary, never the installed one.
    expect(h.log.find(c => stepOf(c) === 'uninstall')).toBe(`chmod +x '${backupDir}/apra-fleet' && '${backupDir}/apra-fleet' uninstall --force --yes`);
    const sup = h.log.find(c => stepOf(c) === 'supervisor')!;
    expect(sup).toContain('systemctl --user stop fleet-supervisor');
    expect(sup).toContain('systemctl --user disable fleet-supervisor');
    expect(sup).toContain(`mv '${LINUX.home}/.config/systemd/user/fleet-supervisor.service' '${backupDir}/fleet-supervisor.service'`);
    expect(sup).toContain('systemctl --user daemon-reload');
    expect(h.log.find(c => stepOf(c) === 'move-data')).toBe(`mv '${LINUX.home}/.apra-fleet/data' '${LINUX.home}/.apra-fleet/data.replaced-${STAMP}'`);
    const install = h.log.find(c => stepOf(c) === 'install')!;
    expect(install).toContain(`'${LINUX.home}/.apra-fleet/staging/apra-fleet' 'install' '--llm' 'claude' '--member'`);
    expect(install).toContain("'--force'");
    if (r.state !== 'available') throw new Error('unreachable');
    expect(r.replaced).toEqual({
      previousVersion: OLD,
      backupPath: backupDir,
      removed: [
        `the apra-fleet ${OLD} full install (uninstalled with its own binary)`,
        'the fleet-supervisor user unit (stopped, disabled, unit file moved into the backup)',
        `its data directory (moved aside to ${LINUX.home}/.apra-fleet/data.replaced-${STAMP})`,
      ],
    });
  });

  it('macos: same sequence without the linux supervisor step', async () => {
    const h = harness(MACOS);
    const r = await ensureMemberFleetInstall(agentFor(MACOS), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'available', version: ORCH, installed: true, replaced: { backupPath: `${MACOS.home}/.apra-fleet-replace-backup-${STAMP}` } });
    expect(destructive(h.events)).toEqual(['backup', 'uninstall', 'move-data', 'install']);
    expect(h.log.find(c => stepOf(c) === 'backup')).toContain(`cp '${MACOS.home}/.apra-fleet/fleet.key' '${MACOS.home}/.apra-fleet-replace-backup-${STAMP}/fleet.key'`);
    expect(h.log.some(c => c.includes('systemctl'))).toBe(false);
  });

  it('windows (PowerShell): -EncodedCommand steps, call operator on the installed binary, fleet.key in the backup', async () => {
    const h = harness(WINDOWS);
    const r = await ensureMemberFleetInstall(agentFor(WINDOWS), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'available', version: ORCH, installed: true });
    expect(destructive(h.events)).toEqual(['backup', 'uninstall', 'move-data', 'install']);
    const backupDir = `${WINDOWS.home}\\.apra-fleet-replace-backup-${STAMP}`;
    const backup = h.log.find(c => stepOf(c) === 'backup')!;
    expect(backup).toContain(`Copy-Item -Recurse -LiteralPath '${WINDOWS.home}\\.apra-fleet\\data' -Destination '${backupDir}\\data'`);
    expect(backup).toContain(`Copy-Item -LiteralPath '${WINDOWS.home}\\.apra-fleet\\fleet.key' -Destination '${backupDir}\\fleet.key'`);
    expect(backup).toContain("$ErrorActionPreference = 'Stop'");
    // Call operator on the quoted path; wrapPowerShellEncoded turns a non-zero native exit into a failed step.
    expect(h.log.find(c => stepOf(c) === 'uninstall')).toContain(`try { & '${backupDir}\\apra-fleet.exe' uninstall --force --yes; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
    expect(h.log.find(c => stepOf(c) === 'move-data')).toContain(`Move-Item -LiteralPath '${WINDOWS.home}\\.apra-fleet\\data' -Destination '${WINDOWS.home}\\.apra-fleet\\data.replaced-${STAMP}'`);
    // No POSIX expansion tokens in any member-bound command.
    for (const c of h.log) { expect(c).not.toContain('$HOME'); expect(c).not.toContain('~/'); }
  });
});

describe('replace-full: refusals run no destructive command', () => {
  for (const p of [LINUX, MACOS, WINDOWS]) {
    it(`${p.os}: without the opt-in a full install is refused with the hint naming the opt-in`, async () => {
      const h = harness(p);
      const r = await ensureMemberFleetInstall(agentFor(p), h.deps);
      expect(r).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
      expect(destructive(h.events)).toEqual([]);
      expect((r as { detail: string }).detail).toContain(`fleet_install: "${REPLACE_FULL_INSTALL}"`);
    });

    it(`${p.os}: with the opt-in but a marker probe failure -> probe-failed, nothing staged or run`, async () => {
      const h = harness(p, { marker: 'timeout' });
      const r = await ensureMemberFleetInstall(agentFor(p), h.deps, { replaceFull: true });
      expect(r).toMatchObject({ state: 'unavailable', reason: 'probe-failed', detail: expect.stringContaining('timed out') });
      // Pins the replaceFull guard: only it appends this opt-in-specific text (the normal upgrade path also fails probe-failed).
      expect((r as { detail: string }).detail).toContain('the opt-in full-install replacement was not run');
      expect(h.events).toEqual([]);
    });
  }

  it('the full-install-running fix line names the opt-in', () => {
    expect(FLEET_MCP_FIX['full-install-running']).toContain('fleet_install: "replace-full"');
  });
});

describe('replace-full: a failure after the uninstall names the step and the rollback', () => {
  it('linux: install step fails -> replace-failed, step 5 named, rollback restores data, key and the supervisor unit', async () => {
    const h = harness(LINUX, { failStep: 'install' });
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'replace-failed', version: OLD });
    const detail = (r as { detail: string }).detail;
    const backupDir = `${LINUX.home}/.apra-fleet-replace-backup-${STAMP}`;
    expect(detail).toContain('step 5 (run the current installer in member mode)');
    expect(detail).toContain('install broke');
    expect(detail).toContain(`The backup is at ${backupDir}`);
    // step 5 failure: the consistent copy moved aside in step 4 is restored; the backup is only the fallback
    const aside = `${LINUX.home}/.apra-fleet/data.replaced-${STAMP}`;
    expect(detail).toContain(`if [ -d '${aside}' ]; then rm -rf '${LINUX.home}/.apra-fleet/data' && mv '${aside}' '${LINUX.home}/.apra-fleet/data'; else`);
    expect(detail).toContain(`cp -R '${backupDir}/data' '${LINUX.home}/.apra-fleet/data'`);
    expect(detail).toContain(`cp '${backupDir}/fleet.key' '${LINUX.home}/.apra-fleet/fleet.key'`);
    // Re-enabled before the reinstall but not started there (a running supervisor makes the old install refuse).
    expect(detail).toContain('systemctl --user enable fleet-supervisor');
    expect(detail).not.toContain('enable --now');
    expect(detail).toContain(`chmod +x '${backupDir}/apra-fleet' && '${backupDir}/apra-fleet' install --llm claude --force`);
  });

  it('windows: move-data fails -> replace-failed, step 4 named, PowerShell rollback, install never run', async () => {
    const h = harness(WINDOWS, { failStep: 'move-data' });
    const r = await ensureMemberFleetInstall(agentFor(WINDOWS), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'replace-failed' });
    const detail = (r as { detail: string }).detail;
    expect(detail).toContain('step 4 (move data aside)');
    // move-data failed: data/ is still in place, so the rollback must not delete or overwrite it
    expect(detail).not.toContain('Remove-Item');
    expect(detail).not.toContain('Copy-Item -Recurse');
    expect(detail).toContain('install --llm claude --force');
    expect(destructive(h.events)).toEqual(['backup', 'uninstall', 'move-data']);
  });

  it('linux: uninstall step fails -> rollback leaves the in-place data/ alone and never restores the backup copy over it', async () => {
    const h = harness(LINUX, { failStep: 'uninstall' });
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'replace-failed' });
    const detail = (r as { detail: string }).detail;
    const backupDir = `${LINUX.home}/.apra-fleet-replace-backup-${STAMP}`;
    expect(detail).toContain('step 2 (uninstall with the backup copy of the installed binary)');
    expect(detail).not.toContain('rm -rf');
    expect(detail).not.toContain(`cp -R '${backupDir}/data'`);
    expect(detail).not.toContain('data.replaced-');
    expect(detail).toContain(`cp '${backupDir}/fleet.key'`);
    expect(detail).toContain('install --llm claude --force');
  });

  it('windows: install step fails -> PowerShell rollback restores the aside copy first, backup only as fallback', () => {
    const plan = buildReplaceFullInstallPlan({
      home: WINDOWS.home, targetOs: 'windows', shell: 'powershell5' as never, provider: 'claude',
      installerPath: `${WINDOWS.home}\.apra-fleet\staging\apra-fleet.exe`, stamp: STAMP,
    });
    const first = plan.rollbackFor.install[0];
    expect(first).toContain(`Move-Item -LiteralPath '${plan.dataAside}'`);
    expect(first.indexOf('Move-Item')).toBeLessThan(first.indexOf('Copy-Item -Recurse'));
    for (const step of ['uninstall', 'supervisor', 'move-data'] as const) {
      expect(plan.rollbackFor[step].join(' ')).not.toContain('Remove-Item');
      expect(plan.rollbackFor[step].join(' ')).not.toContain('Copy-Item -Recurse');
    }
    expect(plan.rollbackFor.backup).toEqual([`& '${WINDOWS.home}\\.apra-fleet\\bin\\apra-fleet.exe' start`]);
  });

  it('a backup failure stops before the uninstall and says nothing was removed (no rollback needed)', async () => {
    const h = harness(MACOS, { failStep: 'backup' });
    const r = await ensureMemberFleetInstall(agentFor(MACOS), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'replace-failed' });
    expect((r as { detail: string }).detail).toContain('Nothing was removed');
    expect(destructive(h.events)).toEqual(['backup']);
  });
});

describe('replace-full: schemas and client accept the new value', () => {
  it('update_member and register_member schemas parse fleet_install "replace-full"', () => {
    expect(updateMemberSchema.parse({ member_id: 'm1', fleet_install: 'replace-full' }).fleet_install).toBe('replace-full');
    const reg = registerMemberSchema.safeParse({ friendly_name: 'bella', member_type: 'local', work_folder: '/tmp/x', fleet_install: 'replace-full' });
    expect(reg.success, JSON.stringify(reg.error?.issues)).toBe(true);
    expect(reg.data?.fleet_install).toBe('replace-full');
    expect(updateMemberSchema.safeParse({ member_id: 'm1', fleet_install: 'replace' }).success).toBe(false);
  });

  it('the apra-fleet-client typedefs list "replace-full" for both register and update', () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'packages', 'apra-fleet-client', 'src', 'client', 'api.mjs'), 'utf8');
    const lines = api.split('\n').filter(l => l.includes('[fleet_install]'));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain('{"auto" | "skip" | "replace-full"}');
  });
});

/** Parse a PowerShell snippet with the real parser; null when powershell is unavailable. */
function psParseErrors(code: string): string[] | null {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:SNIPPET,[ref]$t,[ref]$e);$e|ForEach-Object{$_.Message}'], { env: { ...process.env, SNIPPET: code }, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean);
}
const hasPs = process.platform === 'win32' && psParseErrors('1') !== null;

describe.skipIf(!hasPs)('replace-full: every emitted PowerShell step and rollback command parses', () => {
  it('windows plan steps and rollback lines', { timeout: 120_000 }, () => {
    const plan = buildReplaceFullInstallPlan({
      home: WINDOWS.home, targetOs: 'windows', shell: 'powershell5' as never, provider: 'claude',
      installerPath: `${WINDOWS.home}\.apra-fleet\staging\apra-fleet.exe`, stamp: STAMP,
    });
    for (const s of plan.steps) expect(psParseErrors(decodePowerShellEncodedCommand(s.command)), s.name).toEqual([]);
    for (const lines of Object.values(plan.rollbackFor)) for (const line of lines) expect(psParseErrors(line), line).toEqual([]);
  });
});

describe('replace-full: same-core stable fallback', () => {
  const DEVBUILD = 'v0.4.4_d1e339';
  /** Release host with no release for the exact build, only the stable v0.4.4
   *  of another build: the same-core fallback (expectBuild = bare core) works. */
  const onlySameCoreStable: MemberFleetInstallDeps['downloadReleaseAsset'] = async (url, name, expectBuild) => {
    if (expectBuild === 'v0.4.4' && url.includes('/download/v0.4.4/')) return `/tmp/dl/${name}`;
    throw new ReleaseDownloadError('release-not-found', `no release for ${expectBuild} at ${url}`, 404);
  };
  const devDeps = (h: ReturnType<typeof harness>): MemberFleetInstallDeps => ({
    ...h.deps, orchestratorVersion: () => DEVBUILD, orchestratorExecutable: () => null, downloadReleaseAsset: onlySameCoreStable,
  });

  it('replaced install on an older core: the signed same-core stable is installed and reported', async () => {
    const h = harness(LINUX); // full install OLD = v0.4.2
    const r = await ensureMemberFleetInstall(agentFor(LINUX), devDeps(h), { replaceFull: true });
    expect(r).toMatchObject({ state: 'available', installed: true, version: ORCH, sameCoreFallback: { tag: 'v0.4.4', wantedBuild: DEVBUILD } });
    expect(destructive(h.events)).toEqual(['backup', 'uninstall', 'supervisor', 'move-data', 'install']);
  });

  it('replaced install already on the same core: no fallback, nothing on the member changed', async () => {
    const h = harness(LINUX);
    h.w.installed = 'v0.4.4_bbbbbb';
    const r = await ensureMemberFleetInstall(agentFor(LINUX), devDeps(h), { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'no-matching-release' });
    expect(destructive(h.events)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// apra-fleet-7e9x / ips9 / ne0q
// ---------------------------------------------------------------------------

const GITBASH: Platform = { os: 'windows', home: '/c/Users/bella', sep: '/', shell: 'gitbash', arch: 'x64' };
const ENVELOPE = /^s=\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\) && eval "\$s"$/;

/** Minimal POSIX word splitter for the plain command lines the builders emit
 *  (single-quoted or bare words; stops at the first && or ;). */
function posixWords(script: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < script.length) {
    if (script[i] === ' ') { i++; continue; }
    if (script.startsWith('&&', i) || script[i] === ';') break;
    let w = '';
    while (i < script.length && script[i] !== ' ') {
      if (script[i] === "'") {
        const end = script.indexOf("'", i + 1);
        w += script.slice(i + 1, end);
        i = end + 1;
      } else { w += script[i++]; }
    }
    words.push(w);
  }
  return words;
}
const lastSimple = (script: string) => posixWords(script.split(' && ').pop()!);
const decodeEnvelope = (cmd: string): string => {
  const m = ENVELOPE.exec(cmd);
  if (!m) throw new Error(`not a POSIX envelope: ${cmd.slice(0, 80)}`);
  return Buffer.from(m[1], 'base64').toString('utf8');
};

function posixPlan(p: Platform) {
  return buildReplaceFullInstallPlan({
    home: p.home, targetOs: p.os, shell: (p.shell ?? 'bash') as never, provider: 'claude',
    installerPath: `${p.home}/.apra-fleet/staging/${p.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet'}`, stamp: STAMP,
  });
}

describe('7e9x: POSIX member commands reach the shell encoded, with the full argv', () => {
  for (const p of [LINUX, MACOS, GITBASH]) {
    const label = p.shell ?? p.os;
    const bin = `${p.home}/.apra-fleet/bin/${p.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet'}`;
    const agent = makeTestAgent({ os: p.os, ...(p.shell ? { shell: p.shell } : {}), llmProvider: 'claude', workFolder: `${p.home}/repo`, friendlyName: 'bella', id: 'id-1' } as Partial<Agent>);

    it(`${label}: no replace-full step starts with a quote; each decodes to the exact argv`, () => {
      const plan = posixPlan(p);
      const byName = Object.fromEntries(plan.steps.map(st => [st.name, st.command]));
      for (const st of plan.steps) {
        expect(st.command, st.name).toMatch(ENVELOPE);
        expect(st.command[0], st.name).not.toMatch(/['"]/);
      }
      expect(posixWords(decodeEnvelope(byName.stop))).toEqual([bin, 'stop']);
      expect(posixWords(decodeEnvelope(byName['stop-check']))).toEqual([bin, 'status']);
      const exe = p.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet';
      expect(lastSimple(decodeEnvelope(byName.uninstall))).toEqual([`${p.home}/.apra-fleet-replace-backup-${STAMP}/${exe}`, 'uninstall', '--force', '--yes']);
      expect(lastSimple(decodeEnvelope(byName['supervisor-check']))).toEqual([`${p.home}/.apra-fleet/staging/${p.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet'}`, 'fleet-se-check']);
      expect(lastSimple(decodeEnvelope(byName.install)).slice(0, 4)).toEqual([`${p.home}/.apra-fleet/staging/${p.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet'}`, 'install', '--llm', 'claude']);
      expect(lastSimple(decodeEnvelope(byName.install))).toContain('--member');
    });

    it(`${label}: self-register, self-remove and list-tools decode to the exact argv`, () => {
      const os = p.os as 'linux' | 'macos' | 'windows';
      const sh = (p.shell ?? 'bash') as never;
      const reg = buildSelfRegisterCommand(bin, agent, os, sh);
      const rm = buildSelfRemoveCommand(bin, 'id-1', os, sh);
      const lt = buildMemberCallCommand(bin, 'id-1', 'list-tools', '/x/args.json', os, sh);
      for (const c of [reg, rm, lt]) { expect(c).toMatch(ENVELOPE); expect(c[0]).not.toMatch(/['"]/); }
      expect(posixWords(decodeEnvelope(reg))).toEqual([bin, 'register-member', '--type', 'local', '--id', 'id-1', '--name', 'bella', '--path', `${p.home}/repo`, '--llm', 'claude']);
      expect(posixWords(decodeEnvelope(rm))).toEqual([bin, 'remove-member', '--id', 'id-1', '--force']);
      expect(posixWords(decodeEnvelope(lt))).toEqual([bin, 'call', '--member', 'id-1', '--list-tools']);
    });
  }

  it('windows PowerShell members stay on -EncodedCommand (not the POSIX envelope)', () => {
    const plan = buildReplaceFullInstallPlan({
      home: WINDOWS.home, targetOs: 'windows', shell: 'powershell5' as never, provider: 'claude',
      installerPath: `${WINDOWS.home}\\.apra-fleet\\staging\\apra-fleet.exe`, stamp: STAMP,
    });
    for (const st of plan.steps) { expect(st.command, st.name).toContain('-EncodedCommand '); expect(st.command).not.toMatch(ENVELOPE); }
  });
});

/** Git for Windows bash.exe, when present (Windows only). */
function gitBashExe(): string | null {
  if (process.platform !== 'win32') return null;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean) as string[];
  for (const r of roots) for (const rel of ['Git\\usr\\bin\\bash.exe', 'Git\\bin\\bash.exe']) {
    const f = path.join(r, rel);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const GIT_BASH = gitBashExe();

describe.skipIf(!GIT_BASH)('7e9x: a real Git Bash receives the full argv (Windows only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-7e9x-'));
  const toPosix = (w: string) => w.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
  const home = toPosix(dir);
  fs.mkdirSync(path.join(dir, '.apra-fleet', 'bin'), { recursive: true });
  // Stand-in for the apra-fleet binary: prints the argv it received.
  fs.writeFileSync(path.join(dir, '.apra-fleet', 'bin', 'apra-fleet'), '#!/bin/sh\necho "ARGC=$# ARGV=$*"\n');
  fs.mkdirSync(path.join(dir, `.apra-fleet-replace-backup-${STAMP}`), { recursive: true });
  fs.writeFileSync(path.join(dir, `.apra-fleet-replace-backup-${STAMP}`, 'apra-fleet'), '#!/bin/sh\necho "ARGC=$# ARGV=$*"\n');
  /** The command line Windows sshd builds for a DefaultShell of bash.exe (model
   *  from the 7e9x diagnosis): a command that starts with a quote is passed
   *  through as-is, anything else is wrapped as -c "<command>". */
  const sshdCommandLine = (cmd: string) => (/^["']/.test(cmd) ? `-c ${cmd}` : `-c "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  const run = (cmd: string) => spawnSync(GIT_BASH!, [sshdCommandLine(cmd)], { windowsVerbatimArguments: true, argv0: 'bash.exe', encoding: 'utf8', input: '' });

  it('the built uninstall step prints ARGC=3 (uninstall --force --yes)', () => {
    const plan = buildReplaceFullInstallPlan({
      home, targetOs: 'linux', shell: 'bash' as never, provider: 'claude', installerPath: `${home}/staging/apra-fleet`, stamp: STAMP,
    });
    const r = run(plan.steps.find(st => st.name === 'uninstall')!.command);
    expect((r.stdout + r.stderr).trim()).toBe('ARGC=3 ARGV=uninstall --force --yes');
  });

  it('stop and status steps deliver their subcommand too', () => {
    const plan = buildReplaceFullInstallPlan({
      home, targetOs: 'linux', shell: 'bash' as never, provider: 'claude', installerPath: `${home}/staging/apra-fleet`, stamp: STAMP,
    });
    expect(run(plan.steps.find(st => st.name === 'stop')!.command).stdout.trim()).toBe('ARGC=1 ARGV=stop');
    expect(run(plan.steps.find(st => st.name === 'stop-check')!.command).stdout.trim()).toBe('ARGC=1 ARGV=status');
  });
});

describe('ips9: the rollback reinstalls the PREVIOUS binary from the backup', () => {
  for (const p of [LINUX, MACOS, GITBASH, WINDOWS]) {
    it(`${p.shell ?? p.os}: no rollback references the staged installer; each reinstall runs the backup copy`, () => {
      const ps = p.shell === 'powershell5';
      const exe = p.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet';
      const installer = ps ? `${p.home}\\.apra-fleet\\staging\\${exe}` : `${p.home}/.apra-fleet/staging/${exe}`;
      const plan = buildReplaceFullInstallPlan({
        home: p.home, targetOs: p.os, shell: (p.shell ?? 'bash') as never, provider: 'claude', installerPath: installer, stamp: STAMP,
      });
      const backupBin = `${plan.backupDir}${ps ? '\\' : '/'}${exe}`;
      for (const [step, lines] of Object.entries(plan.rollbackFor)) {
        const all = lines.join('\n');
        expect(all, step).not.toContain(installer);
        expect(all, step).not.toContain('staging');
        if (['uninstall', 'supervisor', 'move-data', 'install', 'verify'].includes(step)) {
          expect(all, step).toContain(ps ? `& '${backupBin}' install --llm claude --force` : `'${backupBin}' install --llm claude --force`);
        }
      }
      // Step 1 copies the old binary into the backup (after the server is down).
      const backupStep = plan.steps.find(st => st.name === 'backup')!.command;
      const decoded = ps ? decodePowerShellEncodedCommand(backupStep) : decodeEnvelope(backupStep);
      expect(decoded).toContain(`'${p.home}${ps ? '\\' : '/'}.apra-fleet${ps ? '\\' : '/'}bin${ps ? '\\' : '/'}${exe}'`);
      expect(decoded).toContain(`'${backupBin}'`);
    });
  }

  it('the rollback hint names the previous version and the backup binary, not the new installer', async () => {
    const h = harness(LINUX, { failStep: 'install' });
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    const detail = (r as { detail: string }).detail;
    expect(detail).toContain(`reinstalls apra-fleet ${OLD} from the backup copy of its binary`);
    expect(detail).not.toContain('/.apra-fleet/staging/');
  });
});

describe('ne0q: step 0 stops the member server and verifies it is down before the backup', () => {
  for (const p of [LINUX, MACOS, WINDOWS, GITBASH]) {
    it(`${p.shell ?? p.os}: stop, then the status check, then backup, uninstall, ... in order`, async () => {
      const h = harness(p);
      const r = await ensureMemberFleetInstall(agentFor(p), h.deps, { replaceFull: true });
      expect(r).toMatchObject({ state: 'available', installed: true });
      const ev = h.events.filter(e => !e.startsWith('transfer:'));
      expect(ev.slice(0, 4)).toEqual(['supervisor-check', 'stop', 'stop-check', 'backup']);
      expect(ev.indexOf('uninstall')).toBeGreaterThan(ev.indexOf('backup'));
    });
  }

  it('stop fails -> typed stop-failed, no backup/uninstall/move/install ran, server-start hint, fix named', async () => {
    const h = harness(LINUX, { failStep: 'stop' });
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'stop-failed', version: OLD });
    expect(h.events.filter(e => !e.startsWith('transfer:') && e !== 'supervisor-check')).toEqual(['stop']);
    const detail = (r as { detail: string }).detail;
    expect(detail).toContain('step 0 (stop the member server)');
    expect(detail).toContain('Nothing was removed or backed up');
    expect(detail).toContain(`'${LINUX.home}/.apra-fleet/bin/apra-fleet' start`);
    expect(detail).toContain('replace-full');
    expect(FLEET_MCP_FIX['stop-failed']).toContain('stop');
  });

  it('server still running after stop -> typed stop-failed before any backup', async () => {
    const h = harness(MACOS, { serverStaysUp: true });
    const r = await ensureMemberFleetInstall(agentFor(MACOS), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'stop-failed' });
    expect(h.events.filter(e => !e.startsWith('transfer:') && e !== 'supervisor-check')).toEqual(['stop', 'stop-check']);
    expect((r as { detail: string }).detail).toContain('not reported stopped after stop');
  });

  it('windows PowerShell: stop failure is the same typed refusal', async () => {
    const h = harness(WINDOWS, { failStep: 'stop' });
    const r = await ensureMemberFleetInstall(agentFor(WINDOWS), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'stop-failed' });
    expect(h.events.filter(e => !e.startsWith('transfer:') && e !== 'supervisor-check')).toEqual(['stop']);
  });
});

describe('judge fixes on #848', () => {
  it('a backup failure after step 0 restarts the server: rollback and detail name start', async () => {
    const h = harness(LINUX, { failStep: 'backup' });
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'replace-failed' });
    const detail = (r as { detail: string }).detail;
    expect(detail).toContain(`'${LINUX.home}/.apra-fleet/bin/apra-fleet' start`);
    expect(detail).toContain('server was stopped in step 0');
    expect(detail).not.toContain('is unchanged');
    expect(posixPlan(LINUX).rollbackFor.backup).toEqual([`'${LINUX.home}/.apra-fleet/bin/apra-fleet' start`]);
  });

  for (const status of ['  State:    unresponsive\n', '', 'some unknown format\n']) {
    it(`status output ${JSON.stringify(status)} is not "stopped": typed stop-failed before the backup`, async () => {
      const h = harness(LINUX);
      const exec = h.deps.exec;
      h.deps.exec = async (a, raw, t) => (stepOf(decodePowerShellEncodedCommand(raw)) === 'stop-check' ? { stdout: status, stderr: '', code: 0 } : exec(a, raw, t));
      const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
      expect(r).toMatchObject({ state: 'unavailable', reason: 'stop-failed' });
      expect(h.events.filter(e => !e.startsWith('transfer:') && e !== 'supervisor-check')).toEqual(['stop']);
    });
  }

  it('the envelope fails (127) when base64 is missing, instead of evaluating an empty script', () => {
    if (process.platform === 'win32' && !GIT_BASH) return;
    const sh = process.platform === 'win32' ? GIT_BASH! : '/bin/sh';
    const cmd = posixPlan(LINUX).steps[0].command;
    // base64 is not on PATH (sh itself is invoked by absolute path / builtin only).
    const r = spawnSync(sh, ['-c', cmd], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });
});

describe('d05q: step 2 uninstalls with the BACKUP copy of the binary', () => {
  for (const p of [LINUX, MACOS, GITBASH, WINDOWS]) {
    it(`${p.shell ?? p.os}: the uninstall step never runs the installed binary`, () => {
      const ps = p.shell === 'powershell5';
      const exe = p.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet';
      const sepc = ps ? '\\' : '/';
      const plan = buildReplaceFullInstallPlan({
        home: p.home, targetOs: p.os, shell: (p.shell ?? 'bash') as never, provider: 'claude',
        installerPath: `${p.home}${sepc}.apra-fleet${sepc}staging${sepc}${exe}`, stamp: STAMP,
      });
      const un = plan.steps.find(st => st.name === 'uninstall')!.command;
      const decoded = ps ? decodePowerShellEncodedCommand(un) : decodeEnvelope(un);
      expect(decoded).toContain(`'${plan.backupDir}${sepc}${exe}' uninstall --force --yes`);
      expect(decoded).not.toContain(`${sepc}.apra-fleet${sepc}bin${sepc}`);
    });
  }
});

describe('9hyz: a live fleet-sprint sprint on the member refuses before anything is stopped', () => {
  const LIVE = 'FLEET_SE supervisor pid=16028 port=8788\nFLEET_SE sprint pid=16100 id=s7\n';
  for (const p of [LINUX, WINDOWS, GITBASH]) {
    it(`${p.shell ?? p.os}: supervisor with a live sprint -> typed fleet-se-running, no supervisor stop/stop/backup/uninstall`, async () => {
      const h = harness(p, { supervisorLine: LIVE });
      const r = await ensureMemberFleetInstall(agentFor(p), h.deps, { replaceFull: true });
      expect(r).toMatchObject({ state: 'unavailable', reason: 'fleet-se-running', version: OLD });
      expect(h.events.filter(e => !e.startsWith('transfer:'))).toEqual(['supervisor-check']);
      const detail = (r as { detail: string }).detail;
      expect(detail).toContain('FLEET_SE sprint pid=16100 id=s7');
      expect(detail).toContain('Nothing was stopped, removed or backed up');
      expect(FLEET_MCP_FIX['fleet-se-running']).toContain('/api/shutdown');
    });
  }

  it('nothing running (or the check errored) -> proceeds', async () => {
    for (const line of ['', 'FLEET_SE_CHECK error probe broke\n']) {
      const h = harness(LINUX, { supervisorLine: line });
      const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
      expect(r).toMatchObject({ state: 'available', installed: true });
    }
  });
});

describe('re-judge 2: the supervisor check uses the staged binary and sees what the installed status cannot', () => {
  it('installed status shows no Supervisor line but one is up: refuses before stop, with a sprint line too', async () => {
    const h = harness(LINUX, { supervisorLine: 'FLEET_SE supervisor pid=7 port=8788\nFLEET_SE sprint pid=9 id=s1\n' });
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'unavailable', reason: 'fleet-se-running' });
    expect(h.events.filter(e => !e.startsWith('transfer:'))).toEqual(['supervisor-check']);
    const detail = (r as { detail: string }).detail;
    expect(detail).toContain('FLEET_SE sprint pid=9 id=s1');
    expect(detail).toContain('Let its sprints finish');
    expect(h.log.find(c => stepOf(c) === 'supervisor-check')).toContain(`'${LINUX.home}/.apra-fleet/staging/apra-fleet' 'fleet-se-check'`);
  });

  it('a rollback hint from step 2 on names the supervisor stop', async () => {
    const h = harness(LINUX, { failStep: 'install' });
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    const detail = (r as { detail: string }).detail;
    expect(detail).toContain('E-FLEET-SE-RUNNING');
    expect(detail).toContain('/api/shutdown -H "Content-Type: application/json"');
  });
});

describe('d05q: a Windows member whose installed exe is held by another process is refused before the uninstall', () => {
  const planFor = (p: Platform) => {
    const ps = p.shell === 'powershell5';
    const exe = p.os === 'windows' ? 'apra-fleet.exe' : 'apra-fleet';
    const sepc = ps ? '\\' : '/';
    return buildReplaceFullInstallPlan({
      home: p.home, targetOs: p.os, shell: (p.shell ?? 'bash') as never, provider: 'claude',
      installerPath: `${p.home}${sepc}.apra-fleet${sepc}staging${sepc}${exe}`, stamp: STAMP,
    });
  };

  for (const p of [WINDOWS, GITBASH]) {
    const label = p.shell ?? p.os;
    const ps = p.shell === 'powershell5';
    const sepc = ps ? '\\' : '/';
    const installed = `${p.home}${sepc}.apra-fleet${sepc}bin${sepc}apra-fleet.exe`;

    it(`${label}: the removability probe runs after the backup and before the uninstall, which still runs the BACKUP binary`, () => {
      const plan = planFor(p);
      const names = plan.steps.map(st => st.name);
      expect(names.indexOf('exe-check')).toBe(names.indexOf('backup') + 1);
      expect(names.indexOf('uninstall')).toBe(names.indexOf('exe-check') + 1);
      const probe = plan.steps.find(st => st.name === 'exe-check')!.command;
      const decoded = ps ? decodePowerShellEncodedCommand(probe) : decodeEnvelope(probe);
      // Probes the INSTALLED exe (the one the uninstall must delete), read-write and exclusive, never modifying it.
      expect(decoded).toContain(`'${installed}'`);
      if (ps) expect(decoded).toContain(`[System.IO.File]::Open('${installed}', 'Open', 'ReadWrite', 'None')`);
      else {
        expect(decoded).toContain(`( exec 3<>'${installed}' )`);
        expect(decoded).toContain(`if [ -f '${installed}' ]`);
      }
      for (const bad of ['Remove-Item', 'rm ', 'Move-Item', 'mv ', 'Set-Content', 'Out-File']) expect(decoded, bad).not.toContain(bad);
      const un = plan.steps.find(st => st.name === 'uninstall')!.command;
      expect(ps ? decodePowerShellEncodedCommand(un) : decodeEnvelope(un)).toContain(`'${plan.backupDir}${sepc}apra-fleet.exe' uninstall --force --yes`);
      expect(plan.rollbackFor['exe-check']).toEqual(plan.rollbackFor.backup);
    });

    it(`${label}: probe reports the exe locked -> typed exe-locked, the uninstall/move/install never run, detail names the backup and the restart`, async () => {
      const h = harness(p, { exeLocked: true });
      const r = await ensureMemberFleetInstall(agentFor(p), h.deps, { replaceFull: true });
      expect(r).toMatchObject({ state: 'unavailable', reason: 'exe-locked', version: OLD });
      expect(h.events.filter(e => !e.startsWith('transfer:'))).toEqual(['supervisor-check', 'stop', 'stop-check', 'backup', 'exe-check']);
      // exec spy: no uninstall, data move or install command reached the member.
      expect(h.log.some(c => c.includes('uninstall --force --yes'))).toBe(false);
      expect(h.log.some(c => c.includes('data.replaced-'))).toBe(false);
      expect(h.log.some(c => c.includes("'install' '--llm'"))).toBe(false);
      const detail = (r as { detail: string }).detail;
      expect(detail).toContain('step 1b');
      expect(detail).toContain('is in use by another process');
      expect(detail).toContain('Nothing was uninstalled');
      expect(detail).toContain(`.apra-fleet-replace-backup-${STAMP}`);
      expect(detail).toContain(`'${installed}' start`);
    });
  }

  it('non-Windows members get no exe-check step', () => {
    for (const p of [LINUX, MACOS]) expect(planFor(p).steps.map(st => st.name)).not.toContain('exe-check');
  });

  it('fail-closed: a check that prints no FREE tag, exits non-zero, or cannot run refuses with exe-locked before the uninstall', async () => {
    const outcomes: Array<() => Promise<SSHExecResult>> = [
      async () => ({ stdout: 'something else\n', stderr: '', code: 0 }),
      async () => ({ stdout: '', stderr: 'powershell broke', code: 1 }),
      async () => { throw new Error('Command timed out'); },
    ];
    for (const outcome of outcomes) {
      const h = harness(WINDOWS);
      const exec = h.deps.exec;
      h.deps.exec = async (a, raw, t) => {
        if (stepOf(decodePowerShellEncodedCommand(raw)) === 'exe-check') { h.events.push('exe-check'); return outcome(); }
        return exec(a, raw, t);
      };
      const r = await ensureMemberFleetInstall(agentFor(WINDOWS), h.deps, { replaceFull: true });
      expect(r).toMatchObject({ state: 'unavailable', reason: 'exe-locked' });
      expect(h.events).not.toContain('uninstall');
      expect(h.events.at(-1)).toBe('exe-check');
    }
  });

  it('exe-locked points at the owner steps and has a fix line', () => {
    expect(FLEET_MCP_FIX['exe-locked']).toContain('replace-full');
    expect(buildManualInstallSteps({ home: WINDOWS.home, targetOs: 'windows', shell: 'powershell5' as never, provider: 'claude', arch: 'x64', orchestratorVersion: ORCH, reason: 'exe-locked' }))
      .toContain('follow the owner steps in the reason above');
  });
});

/** A small system exe: a running copy is mapped by Windows exactly as the member's running apra-fleet.exe is. */
const PING = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE') : null;

describe.skipIf(!hasPs || !PING || !fs.existsSync(PING))('d05q: the emitted PowerShell probe detects a really running exe (Windows only)', () => {
  it('LOCKED while a copy runs, FREE once it exits, FREE when absent; the exe is unchanged', { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-d05q-'));
    try {
      const exe = path.join(dir, 'apra-fleet.exe');
      fs.copyFileSync(PING!, exe);
      const before = fs.readFileSync(exe);
      const runProbe = (p: string) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', decodePowerShellEncodedCommand(buildExeLockProbe(p, 'windows', 'powershell5' as never))], { encoding: 'utf8' }).stdout;
      const child = spawn(exe, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
        expect(runProbe(exe)).toContain('__APRA_FLEET_EXE_LOCKED__');
      } finally {
        child.kill();
        await exited;
      }
      expect(runProbe(exe)).toContain('__APRA_FLEET_EXE_FREE__');
      expect(runProbe(path.join(dir, 'missing.exe'))).toContain('__APRA_FLEET_EXE_FREE__');
      expect(fs.readFileSync(exe).equals(before)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
