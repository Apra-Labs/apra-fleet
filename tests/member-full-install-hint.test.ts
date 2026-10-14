/**
 * The full-install-running refusal: stages the orchestrator's CURRENT installer
 * on the member and gives per-OS manual replacement steps that work with it
 * (paths resolved in JS, no ~ or $HOME, no --force-stop-full-install, no bead ids).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { makeTestAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import {
  ensureMemberFleetInstall, buildFullInstallReplaceHint, FLEET_MCP_FIX,
  type MemberFleetInstallDeps,
} from '../src/services/member-fleet-install.js';

const ORCH = 'v0.4.4';
const OLD = 'v0.4.2';

interface Platform { os: 'linux' | 'macos' | 'windows'; home: string; exe: string; sep: string; shell?: string; arch: string }
const LINUX: Platform = { os: 'linux', home: '/home/bella', exe: 'apra-fleet', sep: '/', arch: 'x64' };
const MACOS: Platform = { os: 'macos', home: '/Users/bella', exe: 'apra-fleet', sep: '/', arch: 'arm64' };
const WINDOWS: Platform = { os: 'windows', home: 'C:\\Users\\bella', exe: 'apra-fleet.exe', sep: '\\', shell: 'powershell5', arch: 'x64' };

function agentFor(p: Platform): Agent {
  return makeTestAgent({ os: p.os, ...(p.shell ? { shell: p.shell } : {}), llmProvider: 'claude', workFolder: `${p.home}${p.sep}repo`, friendlyName: 'bella' } as Partial<Agent>);
}

function harness(p: Platform, opts: { transferFails?: boolean; orchestratorOs?: Platform['os']; downloadFails?: boolean } = {}) {
  const events: string[] = [];
  const log: string[] = [];
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  const orch = opts.orchestratorOs ?? p.os;
  const deps: MemberFleetInstallDeps = {
    exec: async (_a, raw) => {
      const c = decodePowerShellEncodedCommand(raw);
      log.push(c);
      if (c.includes('member-install.json')) return { stdout: '', stderr: '', code: 1 }; // unmarked
      if (c.includes('--version')) return ok(`apra-fleet ${OLD}\n`);
      if (c.includes('uname -m')) return ok(p.arch === 'arm64' ? 'arm64\n' : 'x86_64\n');
      if (c.includes('PROCESSOR_ARCHITECTURE')) return ok('AMD64');
      if (c.includes("'install' '--llm'")) events.push('install-run');
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, paths, dir) => {
      events.push(`transfer:${dir}`);
      return opts.transferFails ? { success: [], failed: [{ path: paths[0], error: 'disk full' }] } : { success: paths, failed: [] };
    },
    resolveHome: async () => p.home,
    orchestratorPlatform: () => ({ os: orch, arch: orch === p.os ? p.arch : 'x64' }),
    orchestratorExecutable: () => (orch === 'windows' ? 'C:\\fleet\\apra-fleet.exe' : '/opt/fleet/apra-fleet'),
    orchestratorVersion: () => ORCH,
    downloadReleaseAsset: async () => { if (opts.downloadFails) throw new Error('network down'); return '/tmp/asset'; },
    removeLocal: () => {},
  };
  return { deps, events, log };
}

async function refusal(p: Platform, opts: Parameters<typeof harness>[1] = {}) {
  const h = harness(p, opts);
  const r = await ensureMemberFleetInstall(agentFor(p), h.deps);
  expect(r).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
  return { detail: (r as { detail: string }).detail, ...h };
}

function expectNoExpansion(text: string): void {
  expect(text).not.toContain('$HOME');
  expect(text).not.toContain('~/');
  expect(text).not.toContain('--force-stop-full-install');
  expect(text).not.toMatch(/apra-fleet-(?=[a-z0-9]*\d)[a-z0-9]{3,6}\b/); // no bead ids (they carry a digit; apra-fleet-data does not)
}

describe('full-install-running hint, per OS', () => {
  for (const p of [LINUX, MACOS]) {
    it(`${p.os}: staged installer, installed-binary uninstall, data + fleet.key backup`, async () => {
      const { detail } = await refusal(p);
      const staged = `${p.home}/.apra-fleet/staging/apra-fleet`;
      expect(detail).toContain(`'${staged}' install --member --llm claude --force`);
      expect(detail).toContain(`'${p.home}/.apra-fleet/bin/apra-fleet' uninstall --force --yes`);
      expect(detail).toContain(`cp -R '${p.home}/.apra-fleet/data' '${p.home}/.apra-fleet-data.full-install.bak'`);
      expect(detail).toContain(`cp '${p.home}/.apra-fleet/fleet.key' '${p.home}/.apra-fleet-data.full-install.bak/'`);
      expect(detail).toContain('update_member');
      expectNoExpansion(detail);
    });
  }

  it('linux: includes the fleet-supervisor stop/disable step; macos does not', async () => {
    const linux = (await refusal(LINUX)).detail;
    expect(linux).toContain('systemctl --user stop fleet-supervisor');
    expect(linux).toContain('systemctl --user disable fleet-supervisor');
    expect(linux).toContain(`${LINUX.home}/.config/systemd/user/fleet-supervisor.service`);
    expect(linux).toContain('systemctl --user daemon-reload');
    expect((await refusal(MACOS)).detail).not.toContain('fleet-supervisor');
  });

  it('windows: PowerShell steps with resolved paths, Copy-Item backup incl fleet.key, no supervisor step', async () => {
    const { detail } = await refusal(WINDOWS);
    const h = WINDOWS.home;
    expect(detail).toContain(`& '${h}\\.apra-fleet\\staging\\apra-fleet.exe' install --member --llm claude --force`);
    expect(detail).toContain(`& '${h}\\.apra-fleet\\bin\\apra-fleet.exe' uninstall --force --yes`);
    expect(detail).toContain(`Copy-Item -Recurse -LiteralPath '${h}\\.apra-fleet\\data' -Destination '${h}\\.apra-fleet-data.full-install.bak'`);
    expect(detail).toContain(`Copy-Item -LiteralPath '${h}\\.apra-fleet\\fleet.key'`);
    expect(detail).not.toContain('fleet-supervisor');
    expectNoExpansion(detail);
  });

  it('the fixed one-line fix text no longer recommends the takeover flag', () => {
    expect(FLEET_MCP_FIX['full-install-running']).not.toContain('--force-stop-full-install');
  });

  it('buildFullInstallReplaceHint is ASCII and cites no bead id', () => {
    const hint = buildFullInstallReplaceHint({ home: '/home/bella', targetOs: 'linux', shell: 'bash' as never, provider: 'claude', installer: { staged: true, path: '/home/bella/.apra-fleet/staging/apra-fleet' } });
    expect(hint).toMatch(/^[\x20-\x7e]+$/);
    expectNoExpansion(hint);
  });
});

/** Parse a PowerShell snippet with the real parser; null when powershell is unavailable. */
function psParseErrors(code: string): string[] | null {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:HINT_SNIPPET,[ref]$t,[ref]$e);$e|ForEach-Object{$_.Message}'], { env: { ...process.env, HINT_SNIPPET: code }, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
}
const hasPs = psParseErrors('1') !== null;

describe.skipIf(!hasPs)('windows hint: every emitted PowerShell step parses', () => {
  it.each([{ label: 'staged', opts: {} }, { label: 'staging failed', opts: { transferFails: true } }])('$label', async ({ opts }) => {
    const { detail } = await refusal(WINDOWS, opts);
    const steps = [...detail.matchAll(/\((\d)\)[^:]*: (.*?)(?=; \(\d|\.$)/g)].filter((m) => ['0', '1', '2', '3', '4'].includes(m[1]));
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const m of steps) {
      const stepText = m[1] === '0' ? m[2].slice(m[2].indexOf('fetch it with: ') + 'fetch it with: '.length) : m[2];
      expect(psParseErrors(stepText), `step (${m[1]}): ${stepText}`).toEqual([]);
    }
  });
});

describe('full-install-running stages the current installer first', () => {
  it('transfers the installer to the staging dir before returning, and never runs it', async () => {
    const { events } = await refusal(LINUX);
    expect(events).toEqual([`transfer:${LINUX.home}/.apra-fleet/staging`]);
  });

  it('staging failure is named in the hint and gives the curl download command for the linux asset (orchestrator-executable source)', async () => {
    const { detail } = await refusal(LINUX, { transferFails: true });
    const asset = 'apra-fleet-installer-linux-x64';
    const target = `${LINUX.home}/.apra-fleet/staging/${asset}`;
    expect(detail).toContain('could not be staged');
    expect(detail).toContain('disk full');
    expect(detail).toContain(`curl -fL -o '${target}' 'https://github.com/`);
    expect(detail).toContain(`/releases/download/v0.4.4/${asset}'`);
    expect(detail).not.toContain('release page');
    // the install step runs the downloaded installer
    expect(detail).toContain(`'${target}' install --member --llm claude --force`);
  });

  it('staging failure on a windows member gives the release-asset download command', async () => {
    const { detail } = await refusal(WINDOWS, { orchestratorOs: 'linux', downloadFails: true });
    expect(detail).toContain('could not be staged');
    expect(detail).toContain('network down');
    expect(detail).toContain('Invoke-WebRequest -Uri');
    expect(detail).toContain(`-OutFile '${WINDOWS.home}\\.apra-fleet\\staging\\`);
  });
});
