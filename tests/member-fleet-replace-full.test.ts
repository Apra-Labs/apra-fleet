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
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeTestAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import {
  ensureMemberFleetInstall, buildReplaceFullInstallPlan, REPLACE_FULL_INSTALL, FLEET_MCP_FIX,
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
type Step = 'backup' | 'uninstall' | 'supervisor' | 'move-data' | 'install';

/** Classify a decoded member command as one of the replacement's destructive steps. */
function stepOf(c: string): Step | null {
  if (c.includes('.apra-fleet-replace-backup-') && c.includes('fleet.key') && !c.includes('uninstall')) return 'backup';
  if (c.includes('uninstall --force --yes')) return 'uninstall';
  if (c.includes('systemctl')) return 'supervisor';
  if (c.includes('data.replaced-')) return 'move-data';
  if (c.includes("'install' '--llm'")) return 'install';
  return null;
}

function harness(p: Platform, opts: { marker?: MarkerMode; failStep?: Step } = {}) {
  const log: string[] = [];
  const events: string[] = [];
  const w = { installed: OLD as string | null, marker: opts.marker ?? 'absent' as MarkerMode };
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  const deps: MemberFleetInstallDeps = {
    exec: async (_a, raw) => {
      const c = decodePowerShellEncodedCommand(raw);
      log.push(c);
      const step = stepOf(c);
      if (step) {
        events.push(step);
        if (step === opts.failStep) return { stdout: '', stderr: `${step} broke`, code: 1 };
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

const destructive = (events: string[]) => events.filter(e => !e.startsWith('transfer:'));

describe('replace-full: full command sequence per OS', () => {
  it('linux: stage, backup (data + fleet.key), uninstall, supervisor stop/disable, move data, member install', async () => {
    const h = harness(LINUX);
    const r = await ensureMemberFleetInstall(agentFor(LINUX), h.deps, { replaceFull: true });
    expect(r).toMatchObject({ state: 'available', version: ORCH, installed: true });
    // The installer is staged BEFORE anything destructive.
    expect(h.events).toEqual([`transfer:${LINUX.home}/.apra-fleet/staging`, 'backup', 'uninstall', 'supervisor', 'move-data', 'install']);
    const backupDir = `${LINUX.home}/.apra-fleet-replace-backup-${STAMP}`;
    const backup = h.log.find(c => stepOf(c) === 'backup')!;
    expect(backup).toContain(`cp -R '${LINUX.home}/.apra-fleet/data' '${backupDir}/data'`);
    expect(backup).toContain(`cp '${LINUX.home}/.apra-fleet/fleet.key' '${backupDir}/fleet.key'`);
    expect(h.log.find(c => stepOf(c) === 'uninstall')).toBe(`'${LINUX.home}/.apra-fleet/bin/apra-fleet' uninstall --force --yes`);
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
    expect(h.log.find(c => stepOf(c) === 'uninstall')).toContain(`try { & '${WINDOWS.home}\\.apra-fleet\\bin\\apra-fleet.exe' uninstall --force --yes; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
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
    expect(detail).toContain('systemctl --user enable --now fleet-supervisor');
    expect(detail).toContain(`'${LINUX.home}/.apra-fleet/staging/apra-fleet' install --llm claude --force`);
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
    expect(detail).toContain('step 2 (uninstall with the installed binary)');
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
    expect(plan.rollbackFor.backup).toEqual([]);
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
  it('windows plan steps and rollback lines', () => {
    const plan = buildReplaceFullInstallPlan({
      home: WINDOWS.home, targetOs: 'windows', shell: 'powershell5' as never, provider: 'claude',
      installerPath: `${WINDOWS.home}\.apra-fleet\staging\apra-fleet.exe`, stamp: STAMP,
    });
    for (const s of plan.steps) expect(psParseErrors(decodePowerShellEncodedCommand(s.command)), s.name).toEqual([]);
    for (const lines of Object.values(plan.rollbackFor)) for (const line of lines) expect(psParseErrors(line), line).toEqual([]);
  });
});
