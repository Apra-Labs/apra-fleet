/**
 * Member apra-fleet install service (apra-fleet-b4g.56.1): version probe,
 * install source choice, member-mode install. Driven entirely by a fake
 * transport -- no real member.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import {
  ensureMemberFleetInstall,
  buildFleetVersionProbe,
  chooseInstallSource,
  memberInstallArgs,
  parseFleetVersion,
  EXEC_FAILED_SENTINEL,
  NO_INSTALL_SENTINEL,
  type MemberFleetInstallDeps,
  type MemberPlatform,
} from '../src/services/member-fleet-install.js';

const ORCH_VERSION = 'v0.4.4';

interface FakeMember {
  /** Version currently installed, or null when nothing is installed. */
  version: string | null;
  /** Raw arch token the member reports (uname -m / PROCESSOR_ARCHITECTURE). */
  arch: string;
  /** Version the installer leaves behind when it runs. */
  installsVersion: string;
  installerExit?: number;
  /** The member-install marker exists (default true: a fleet member install). */
  marker?: boolean;
  execLog: string[];
  transfers: { localPaths: string[]; dest: string }[];
  downloads: string[];
  removed: string[];
}

function decoded(cmd: string): string {
  return cmd.includes('-EncodedCommand') ? decodePowerShellEncodedCommand(cmd) : cmd;
}

function fakeDeps(member: FakeMember, opts: {
  orchestrator: MemberPlatform;
  executable: string | null;
  home?: string | null;
  downloadFails?: boolean;
}): MemberFleetInstallDeps {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  return {
    exec: async (_agent: Agent, command: string) => {
      const text = decoded(command);
      member.execLog.push(text);
      if (text.includes('--version')) {
        return ok(member.version === null
          ? `${NO_INSTALL_SENTINEL}\n`
          : `apra-fleet ${member.version}\n  Mode:   sea\n  Binary: /x\n`);
      }
      if (text.includes('uname -m') || text.includes('PROCESSOR_ARCHITECTURE')) return ok(`${member.arch}\n`);
      if (text.includes('member-install.json')) return member.marker === false ? { stdout: '', stderr: '', code: 1 } : ok('');
      if (text.includes(' install') || text.includes("'install'")) {
        const code = member.installerExit ?? 0;
        if (code === 0) member.version = member.installsVersion;
        return { stdout: 'installed', stderr: code ? 'boom' : '', code };
      }
      return { stdout: '', stderr: `unexpected command: ${text}`, code: 127 };
    },
    transfer: async (_agent, localPaths, dest) => {
      member.transfers.push({ localPaths, dest });
      return { success: localPaths.map(p => path.basename(p)), failed: [] };
    },
    resolveHome: async agent => (opts.home !== undefined ? opts.home : agent.os === 'windows' ? 'C:\\Users\\bella' : '/home/bella'),
    orchestratorPlatform: () => opts.orchestrator,
    orchestratorExecutable: () => opts.executable,
    orchestratorVersion: () => ORCH_VERSION,
    downloadReleaseAsset: async (url, assetName) => {
      member.downloads.push(url);
      if (opts.downloadFails) throw new Error('HTTP 404');
      return `/tmp/dl/${assetName}`;
    },
    removeLocal: p => { member.removed.push(p); },
  };
}

function newMember(over: Partial<FakeMember> = {}): FakeMember {
  return { version: null, arch: 'x86_64', installsVersion: ORCH_VERSION, execLog: [], transfers: [], downloads: [], removed: [], ...over };
}

const LINUX_X64: MemberPlatform = { os: 'linux', arch: 'x64' };

describe('install source choice', () => {
  it('same OS/arch copies the orchestrator executable', async () => {
    const m = newMember();
    const agent = makeTestAgent({ os: 'linux', llmProvider: 'claude' });
    const r = await ensureMemberFleetInstall(agent, fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' }));
    expect(r).toMatchObject({ state: 'available', installed: true, source: 'orchestrator-executable', version: ORCH_VERSION });
    expect(m.downloads).toEqual([]);
    expect(m.transfers).toEqual([{ localPaths: ['/opt/fleet/apra-fleet'], dest: '/home/bella/.apra-fleet/staging' }]);
    const install = m.execLog.find(c => c.includes("'install'"))!;
    expect(install).toContain("'/home/bella/.apra-fleet/staging/apra-fleet'");
  });

  it('cross-OS member downloads the tagged release asset for the orchestrator version', async () => {
    const m = newMember({ arch: 'AMD64' });
    const agent = makeTestAgent({ os: 'windows', llmProvider: 'claude' });
    const r = await ensureMemberFleetInstall(agent, fakeDeps(m, { orchestrator: { os: 'macos', arch: 'arm64' }, executable: '/opt/fleet/apra-fleet' }));
    expect(r).toMatchObject({ state: 'available', installed: true, source: 'release-asset' });
    expect(m.downloads).toEqual([
      'https://github.com/Apra-Labs/apra-fleet/releases/download/v0.4.4/apra-fleet-installer-win-x64.exe',
    ]);
    expect(m.transfers[0]).toEqual({ localPaths: ['/tmp/dl/apra-fleet-installer-win-x64.exe'], dest: 'C:\\Users\\bella\\.apra-fleet\\staging' });
    // the downloaded temp file is cleaned up after the install
    expect(m.removed).toEqual(['/tmp/dl/apra-fleet-installer-win-x64.exe']);
  });

  it('same platform but no copyable executable (dev/npm orchestrator) falls back to the release asset', () => {
    const src = chooseInstallSource(LINUX_X64, LINUX_X64, null, 'v0.4.4_abc123');
    expect(src).toEqual({
      kind: 'release-asset',
      assetName: 'apra-fleet-installer-linux-x64',
      url: 'https://github.com/Apra-Labs/apra-fleet/releases/download/v0.4.4/apra-fleet-installer-linux-x64',
    });
  });

  it('unsupported platform yields unavailable(unsupported-platform) without throwing', async () => {
    const m = newMember({ arch: 'aarch64' }); // linux/arm64: no release asset, differs from orchestrator
    const agent = makeTestAgent({ os: 'linux' });
    const r = await ensureMemberFleetInstall(agent, fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' }));
    expect(r.state).toBe('unavailable');
    expect(r).toMatchObject({ reason: 'unsupported-platform' });
    expect(m.transfers).toEqual([]);
    expect(m.execLog.some(c => c.includes("'install'"))).toBe(false);
  });

  it('a failed release download is unavailable(download-failed), never a throw', async () => {
    const m = newMember();
    const agent = makeTestAgent({ os: 'linux' });
    const r = await ensureMemberFleetInstall(agent, fakeDeps(m, { orchestrator: { os: 'macos', arch: 'arm64' }, executable: null, downloadFails: true }));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'download-failed' });
  });

  it('an unresolvable member home is unavailable(home-unresolved), never a throw', async () => {
    const m = newMember();
    const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), fakeDeps(m, { orchestrator: LINUX_X64, executable: null, home: null }));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'home-unresolved' });
  });

  it('a non-zero installer exit is unavailable(install-failed)', async () => {
    const m = newMember({ installerExit: 1 });
    const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' }));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'install-failed' });
  });
});

describe('member-mode install command', () => {
  it('carries --llm <member provider> --member --workflows none --transport http (POSIX)', async () => {
    const m = newMember();
    const agent = makeTestAgent({ os: 'linux', llmProvider: 'opencode' });
    await ensureMemberFleetInstall(agent, fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' }));
    const install = m.execLog.find(c => c.includes("'install'"))!;
    expect(install).toContain("'install' '--llm' 'opencode' '--member' '--workflows' 'none' '--transport' 'http'");
  });

  it('is delivered via -EncodedCommand for a PowerShell member and carries the same flags', async () => {
    const m = newMember({ arch: 'AMD64' });
    const agent = makeTestAgent({ os: 'windows', llmProvider: 'agy' });
    const deps = fakeDeps(m, { orchestrator: { os: 'windows', arch: 'x64' }, executable: 'C:\\fleet\\apra-fleet.exe' });
    const raw: string[] = [];
    const exec = deps.exec;
    deps.exec = async (a, c, t) => { raw.push(c); return exec(a, c, t); };
    await ensureMemberFleetInstall(agent, deps);
    const rawInstall = raw.find(c => decoded(c).includes("'install'"))!;
    expect(rawInstall.startsWith('powershell -EncodedCommand ')).toBe(true);
    const text = decoded(rawInstall);
    expect(text).toContain("& 'C:\\Users\\bella\\.apra-fleet\\staging\\apra-fleet.exe' 'install' '--llm' 'agy' '--member' '--workflows' 'none' '--transport' 'http'");
  });

  it('memberInstallArgs defaults are exactly the member-mode flag set', () => {
    expect(memberInstallArgs('claude').slice(0, 8)).toEqual(['install', '--llm', 'claude', '--member', '--workflows', 'none', '--transport', 'http']);
  });

  it('no member-bound command contains a shell expansion token', async () => {
    const m = newMember();
    await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' }));
    for (const c of m.execLog) {
      expect(c).not.toMatch(/\$[A-Za-z{]|~\/|`/);
    }
  });
});

describe('up-to-date vs older installs', () => {
  it('an up-to-date install is not reinstalled', async () => {
    const m = newMember({ version: 'v0.4.4' });
    const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' }));
    expect(r).toEqual({ state: 'available', version: 'v0.4.4', installed: false, binPath: '/home/bella/.apra-fleet/bin/apra-fleet' });
    expect(m.transfers).toEqual([]);
    expect(m.execLog.some(c => c.includes("'install'"))).toBe(false);
  });

  it('a newer member install (or a same-core build when only the release asset is reachable) is not reinstalled', async () => {
    // Same-core build differences with an orchestrator-executable source are covered
    // in member-fleet-install-build-suffix.test.ts.
    for (const v of ['v0.5.0', 'v0.4.4_abc123']) {
      const m = newMember({ version: v });
      const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), fakeDeps(m, { orchestrator: LINUX_X64, executable: null }));
      expect(r).toMatchObject({ state: 'available', installed: false, version: v });
    }
  });

  it('an older install is reinstalled and the new version is reported', async () => {
    const m = newMember({ version: 'v0.4.2' });
    const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' }));
    expect(r).toMatchObject({ state: 'available', installed: true, version: ORCH_VERSION });
    expect(m.transfers).toHaveLength(1);
  });

  it('an installer that leaves an old version behind is unavailable(install-unverified)', async () => {
    const m = newMember({ version: 'v0.4.2', installsVersion: 'v0.4.2' });
    const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' }));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'install-unverified', version: 'v0.4.2' });
  });
});

describe('version probe', () => {
  it('parses the first apra-fleet <version> line, ignoring banners', () => {
    expect(parseFleetVersion('Welcome!\napra-fleet v0.4.4_abc123\n  Mode: sea\n')).toBe('v0.4.4_abc123');
    expect(parseFleetVersion('garbage')).toBeNull();
  });

  it('PowerShell probe tests $LASTEXITCODE so a failing native exe is EXEC_FAILED, not a version', () => {
    const ps = decodePowerShellEncodedCommand(buildFleetVersionProbe('C:\\Users\\b\\.apra-fleet\\bin\\apra-fleet.exe', 'windows', undefined));
    expect(ps).toContain(`if ($LASTEXITCODE -ne 0) { [Console]::Out.Write('${EXEC_FAILED_SENTINEL}') }`);
    // the probe's own trailing exit 0 keeps a non-zero exit reserved for transport failure
    expect(ps).toContain(`[Console]::Out.Write('${NO_INSTALL_SENTINEL}') }; exit 0`);
  });

  it('a broken install (EXEC_FAILED) is treated as needing reinstall, not as a version', async () => {
    const m = newMember();
    const deps = fakeDeps(m, { orchestrator: LINUX_X64, executable: '/opt/fleet/apra-fleet' });
    let first = true;
    const exec = deps.exec;
    deps.exec = async (a, c, t) => {
      if (first && decoded(c).includes('--version')) {
        first = false;
        return { stdout: `apra-fleet v9.9.9\n${EXEC_FAILED_SENTINEL}`, stderr: '', code: 0 };
      }
      return exec(a, c, t);
    };
    const r = await ensureMemberFleetInstall(makeTestAgent({ os: 'linux' }), deps);
    expect(r).toMatchObject({ state: 'available', installed: true, version: ORCH_VERSION });
  });

  const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
  // Three pwsh spawns on cold start take ~2s each, so 6s minimum + margin for setup/teardown
  it.skipIf(!hasPwsh || process.platform === 'win32')('live pwsh: a native exe that prints a version but exits non-zero is reported EXEC_FAILED', { timeout: 20000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfi-probe-'));
    try {
      const failing = path.join(dir, 'apra-fleet');
      fs.writeFileSync(failing, '#!/bin/sh\necho "apra-fleet v9.9.9"\nexit 3\n', { mode: 0o755 });
      const healthy = path.join(dir, 'apra-fleet-ok');
      fs.writeFileSync(healthy, '#!/bin/sh\necho "apra-fleet v0.4.4"\nexit 0\n', { mode: 0o755 });
      const run = (bin: string) => {
        const cmd = buildFleetVersionProbe(bin, 'windows', 'pwsh7');
        const blob = cmd.replace(/^powershell -EncodedCommand /, '');
        return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', blob], { encoding: 'utf-8' });
      };
      const bad = run(failing);
      expect(bad).toContain(EXEC_FAILED_SENTINEL);
      expect(parseFleetVersion(bad.replace(EXEC_FAILED_SENTINEL, ''))).toBeNull();
      expect(parseFleetVersion(run(healthy))).toBe('v0.4.4');
      expect(run(path.join(dir, 'absent'))).toContain(NO_INSTALL_SENTINEL);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
