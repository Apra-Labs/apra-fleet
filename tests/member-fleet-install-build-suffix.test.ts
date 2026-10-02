/**
 * Build-aware member install version check. Driven by fakes only -- no SSH,
 * no network. Scenario 1 (same-core different build, orchestrator-executable
 * source -> install runs) is the regression guard: restoring isOlderThan to a
 * core-only compare makes it fail.
 */
import { describe, it, expect } from 'vitest';
import { makeTestAgent } from './test-helpers.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import {
  ensureMemberFleetInstall,
  isMemberOutdated,
  NO_INSTALL_SENTINEL,
  type MemberFleetInstallDeps,
  type MemberPlatform,
} from '../src/services/member-fleet-install.js';

const LINUX_X64: MemberPlatform = { os: 'linux', arch: 'x64' };
const MAC_ARM: MemberPlatform = { os: 'macos', arch: 'arm64' };

interface Fake { version: string; installsVersion: string; installs: number; transfers: number; downloads: string[] }

function run(opts: {
  member: string; orch: string; installsVersion?: string;
  orchestrator?: MemberPlatform; executable?: string | null;
}) {
  const f: Fake = { version: opts.member, installsVersion: opts.installsVersion ?? opts.orch, installs: 0, transfers: 0, downloads: [] };
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  const deps: MemberFleetInstallDeps = {
    exec: async (_a: Agent, command: string) => {
      if (command.includes('--version')) {
        return ok(f.version ? `apra-fleet ${f.version}\n  Mode:   sea\n` : `${NO_INSTALL_SENTINEL}\n`);
      }
      if (command.includes('uname -m')) return ok('x86_64\n');
      if (command.includes('member-install.json')) return ok(''); // a marked member install
      if (command.includes("'install'")) { f.installs++; f.version = f.installsVersion; return ok('installed'); }
      return { stdout: '', stderr: `unexpected: ${command}`, code: 127 };
    },
    transfer: async (_a, paths) => { f.transfers++; return { success: paths, failed: [] }; },
    resolveHome: async () => '/home/bella',
    orchestratorPlatform: () => opts.orchestrator ?? LINUX_X64,
    orchestratorExecutable: () => (opts.executable === undefined ? '/opt/fleet/apra-fleet' : opts.executable),
    orchestratorVersion: () => opts.orch,
    downloadReleaseAsset: async (url, name) => { f.downloads.push(url); return `/tmp/dl/${name}`; },
    removeLocal: () => {},
  };
  return { f, go: () => ensureMemberFleetInstall(makeTestAgent({ os: 'linux', llmProvider: 'claude' }), deps) };
}

describe('build-aware member install version check', () => {
  it('1. same core, different build, orchestrator-executable source -> upgrades', async () => {
    const t = run({ member: 'v0.4.4_aaaaaa', orch: 'v0.4.4_bbbbbb' });
    const r = await t.go();
    expect(t.f.transfers).toBe(1);
    expect(t.f.installs).toBe(1);
    expect(r).toMatchObject({ state: 'available', installed: true, version: 'v0.4.4_bbbbbb' });
  });

  it('2. newer member core is never downgraded', async () => {
    for (const member of ['v0.4.5_aaaaaa', 'v0.4.5']) {
      const t = run({ member, orch: 'v0.4.4_bbbbbb' });
      const r = await t.go();
      expect(t.f.transfers).toBe(0);
      expect(t.f.installs).toBe(0);
      expect(r).toMatchObject({ state: 'available', installed: false, version: member });
    }
  });

  it('3. release versions keep today semantics (equal = up to date, older = install)', async () => {
    const same = run({ member: 'v0.4.4', orch: 'v0.4.4' });
    expect(await same.go()).toMatchObject({ state: 'available', installed: false });
    expect(same.f.installs).toBe(0);
    const older = run({ member: 'v0.4.3', orch: 'v0.4.4' });
    expect(await older.go()).toMatchObject({ state: 'available', installed: true });
    expect(older.f.installs).toBe(1);
  });

  it('4. release-asset source: same core is up to date, no reinstall loop, no install-unverified', async () => {
    const t = run({ member: 'v0.4.4', orch: 'v0.4.4_bbbbbb', orchestrator: MAC_ARM });
    const r = await t.go();
    expect(t.f.installs).toBe(0);
    expect(t.f.downloads).toEqual([]);
    expect(r).toMatchObject({ state: 'available', installed: false, version: 'v0.4.4' });
  });

  it('4b. release-asset install of an older core is not reported install-unverified', async () => {
    const t = run({ member: 'v0.4.3', orch: 'v0.4.4_bbbbbb', installsVersion: 'v0.4.4', orchestrator: MAC_ARM });
    const r = await t.go();
    expect(t.f.installs).toBe(1);
    expect(r).toMatchObject({ state: 'available', installed: true, source: 'release-asset', version: 'v0.4.4' });
  });

  it('isMemberOutdated unit rules', () => {
    expect(isMemberOutdated('v0.4.4_a', 'v0.4.4_b', true)).toBe(true);
    expect(isMemberOutdated('v0.4.4_a', 'v0.4.4_b', false)).toBe(false);
    expect(isMemberOutdated('v0.4.4_a', 'v0.4.4_a', true)).toBe(false);
    expect(isMemberOutdated('v0.4.5', 'v0.4.4_b', true)).toBe(false);
    expect(isMemberOutdated('v0.4.3_z', 'v0.4.4', false)).toBe(true);
  });
});
