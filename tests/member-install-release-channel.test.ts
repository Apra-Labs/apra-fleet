/**
 * Member install release channel: the installer resolves the orchestrator's
 * exact build from anonymous release URLs (exact-build prerelease first, then
 * the stable release only when its BUILD_INFO names that build), verifies
 * SHA-256 against SHA256SUMS, and every failure is a typed result carrying
 * OS-correct manual steps. register_member / update_member still succeed and
 * print a WARNING (consequence, exact reason, manual steps). Fakes only: no
 * network, no member host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { backupAndResetRegistry, restoreRegistry, makeConfigAwareExec, makeTestAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import {
  __setMemberFleetMcpDeps,
  buildInfoMatches,
  buildManualInstallSteps,
  downloadVerifiedAsset,
  ensureMemberFleetInstall,
  fetchReleaseInstaller,
  fleetInstallWarning,
  parseBuildInfo,
  prereleaseTagFor,
  releaseCandidatesFor,
  ReleaseDownloadError,
  NO_INSTALL_SENTINEL,
  type MemberFleetInstallDeps,
  type MemberFleetMcpDeps,
} from '../src/services/member-fleet-install.js';
import { updateMember } from '../src/tools/update-member.js';
import { registerMember } from '../src/tools/register-member.js';
import { addAgent, getAgent, recordFleetMcpStatus } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: async (paths: string[]) => ({ success: paths, failed: [] }),
    writeSecretFile: async () => '/home/testuser/.apra-fleet-secret',
    removeSecretFile: async () => undefined,
    close: vi.fn(),
  }),
}));
vi.mock('../src/services/statusline.js', () => ({ writeStatusline: vi.fn(), readMemberStatus: vi.fn(() => 'idle') }));
vi.mock('../src/services/sftp.js', () => ({ uploadContentToHome: vi.fn(async () => ({ success: [], failed: [] })) }));
vi.mock('../src/cli/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli/install.js')>();
  return { ...actual, loadAgentAssets: () => [] };
});

const DEV = 'v0.4.4_d1e339';
const ASSET = 'apra-fleet-installer-linux-x64';
const PRE = `https://github.com/Apra-Labs/apra-fleet/releases/download/${DEV}/`;
const STABLE = 'https://github.com/Apra-Labs/apra-fleet/releases/download/v0.4.4/';
const BODY = Buffer.from('pretend-installer');
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

/** A fake release host: tag base URL -> files. Unknown URLs are HTTP 404. */
function releaseHost(releases: Record<string, Record<string, Buffer | string>>, opts: { throwFor?: string } = {}): typeof fetch {
  return (async (url: string) => {
    if (opts.throwFor && url.startsWith(opts.throwFor)) throw new TypeError('fetch failed: ECONNRESET');
    for (const [base, files] of Object.entries(releases)) {
      if (url.startsWith(base)) {
        const f = files[url.slice(base.length)];
        return f === undefined ? new Response('Not Found', { status: 404 }) : new Response(f);
      }
    }
    return new Response('Not Found', { status: 404 });
  }) as unknown as typeof fetch;
}

function release(buildVersion: string | null, opts: { listInfo?: boolean; tamperInfo?: boolean; listAsset?: boolean } = {}): Record<string, Buffer | string> {
  const info = buildVersion ? `version=${buildVersion}\ncommit=${buildVersion.split('_')[1] ?? 'f00d'}0000000000000000000000000000000000\n` : '';
  const sums = [
    ...(opts.listAsset === false ? [] : [`${sha(BODY)}  ${ASSET}`]),
    ...(buildVersion && opts.listInfo !== false ? [`${sha(info)}  BUILD_INFO`] : []),
  ].join('\n') + '\n';
  return {
    SHA256SUMS: sums,
    [ASSET]: BODY,
    ...(buildVersion ? { BUILD_INFO: opts.tamperInfo ? info + 'x' : info } : {}),
  };
}

const viaHost = (fetchImpl: typeof fetch): Pick<MemberFleetInstallDeps, 'downloadReleaseAsset'> => ({
  downloadReleaseAsset: (url, name, expectBuild) => downloadVerifiedAsset(url, name, { fetchImpl, ...(expectBuild ? { expectBuild } : {}) }),
});
const SOURCE = { kind: 'release-asset' as const, assetName: ASSET, url: PRE + ASSET, candidates: releaseCandidatesFor(DEV) };
const cleanup = (p: string) => fs.rmSync(p.replace(ASSET, ''), { recursive: true, force: true });

describe('release candidates and BUILD_INFO matching', () => {
  it('a dev build tries its exact-build prerelease, then the stable tag; a bare version only the stable tag', () => {
    expect(releaseCandidatesFor(DEV)).toEqual([{ tag: DEV, channel: 'prerelease' }, { tag: 'v0.4.4', channel: 'stable' }]);
    expect(releaseCandidatesFor('v0.4.4')).toEqual([{ tag: 'v0.4.4', channel: 'stable' }]);
    expect(prereleaseTagFor('0.4.4_abc123')).toBe('v0.4.4_abc123');
    expect(prereleaseTagFor('v0.4.4')).toBeNull();
  });

  it('BUILD_INFO must name the exact build for a dev build; any build of the core for a bare version', () => {
    expect(parseBuildInfo('version=v0.4.4_d1e339\r\ncommit=d1e3390abc\n')).toEqual({ version: 'v0.4.4_d1e339', commit: 'd1e3390abc' });
    expect(buildInfoMatches({ version: DEV }, DEV)).toBe(true);
    expect(buildInfoMatches({ version: 'v0.4.4_aaaaaa', commit: 'aaaaaa11' }, DEV)).toBe(false);
    expect(buildInfoMatches({ version: 'v0.4.4_d1e3390', commit: 'd1e3390ff' }, DEV)).toBe(true); // longer abbreviation, same commit
    expect(buildInfoMatches({ version: 'v0.4.5_d1e339', commit: 'd1e339ff' }, DEV)).toBe(false); // different core
    expect(buildInfoMatches({ version: 'v0.4.4_abcdef' }, 'v0.4.4')).toBe(true);
    expect(buildInfoMatches({}, 'v0.4.4')).toBe(false);
  });
});

describe('fetchReleaseInstaller (real downloadVerifiedAsset over a fake anonymous host)', () => {
  it('success: the exact-build prerelease is verified and used; the stable release is not touched', async () => {
    const r = await fetchReleaseInstaller(viaHost(releaseHost({ [PRE]: release(DEV), [STABLE]: release('v0.4.4_ffffff') })), SOURCE, DEV);
    try {
      expect(r.tag).toBe(DEV);
      expect(fs.readFileSync(r.localPath).equals(BODY)).toBe(true);
    } finally { cleanup(r.localPath); }
  });

  it('no prerelease (HTTP 404): falls back to a stable release whose BUILD_INFO names this build', async () => {
    const r = await fetchReleaseInstaller(viaHost(releaseHost({ [STABLE]: release(DEV) })), SOURCE, DEV);
    try { expect(r.tag).toBe('v0.4.4'); } finally { cleanup(r.localPath); }
  });

  it('no prerelease and a stable release of a DIFFERENT build -> no-matching-release (never installs another build)', async () => {
    await expect(fetchReleaseInstaller(viaHost(releaseHost({ [STABLE]: release('v0.4.4_aaaaaa') })), SOURCE, DEV))
      .rejects.toMatchObject({ reason: 'no-matching-release', message: expect.stringContaining('not v0.4.4_d1e339') });
  });

  it('a stable release without BUILD_INFO (cannot be matched) -> no-matching-release', async () => {
    await expect(fetchReleaseInstaller(viaHost(releaseHost({ [STABLE]: release(null) })), SOURCE, DEV))
      .rejects.toMatchObject({ reason: 'no-matching-release' });
  });

  it('nothing published at all -> no-matching-release naming both tags tried', async () => {
    const err = await fetchReleaseInstaller(viaHost(releaseHost({})), SOURCE, DEV).catch(e => e);
    expect(err).toBeInstanceOf(ReleaseDownloadError);
    expect(err.reason).toBe('no-matching-release');
    expect(err.message).toContain(`prerelease ${DEV}`);
    expect(err.message).toContain('stable v0.4.4');
  });

  it('a network failure is reported as itself and never hidden behind the stable fallback', async () => {
    let stableHit = false;
    const host = releaseHost({ [STABLE]: release(DEV) }, { throwFor: PRE });
    const spy = (async (url: string, init?: RequestInit) => { if (url.startsWith(STABLE)) stableHit = true; return host(url, init); }) as unknown as typeof fetch;
    await expect(fetchReleaseInstaller(viaHost(spy), SOURCE, DEV)).rejects.toMatchObject({ reason: 'download-failed', message: expect.stringContaining('ECONNRESET') });
    expect(stableHit).toBe(false);
  });

  it('a tampered BUILD_INFO is checksum-mismatch', async () => {
    await expect(fetchReleaseInstaller(viaHost(releaseHost({ [PRE]: release(DEV, { tamperInfo: true }) })), SOURCE, DEV))
      .rejects.toMatchObject({ reason: 'checksum-mismatch' });
  });

  it('a release whose SHA256SUMS does not list the asset is checksum-unavailable', async () => {
    await expect(fetchReleaseInstaller(viaHost(releaseHost({ [PRE]: release(DEV, { listAsset: false }) })), SOURCE, DEV))
      .rejects.toMatchObject({ reason: 'checksum-unavailable' });
  });
});

// ---------------------------------------------------------------------------
// ensureMemberFleetInstall: every failure class is typed and carries manual steps
// ---------------------------------------------------------------------------

function installDeps(opts: { arch?: string; download?: MemberFleetInstallDeps['downloadReleaseAsset']; installed?: string | null } = {}): MemberFleetInstallDeps & { installs: number } {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  let installed = opts.installed ?? null;
  const d = {
    installs: 0,
    exec: async (_a: unknown, command: string) => {
      if (command.includes('--version')) return ok(installed ? `apra-fleet ${installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      if (command.includes('uname -m')) return ok(`${opts.arch ?? 'x86_64'}\n`);
      if (command.includes('member-install.json')) return ok('');
      if (command.includes("'install'")) { d.installs++; installed = DEV; return ok('installed'); }
      return { stdout: '', stderr: `unexpected: ${command}`, code: 127 };
    },
    transfer: async (_a: unknown, p: string[]) => ({ success: p, failed: [] }),
    resolveHome: async () => '/home/bella',
    orchestratorPlatform: () => ({ os: 'windows' as const, arch: 'x64' }),
    orchestratorExecutable: () => null,
    orchestratorVersion: () => DEV,
    downloadReleaseAsset: opts.download ?? (async (_u: string, name: string) => `/tmp/dl/${name}`),
    removeLocal: () => {},
  };
  return d as MemberFleetInstallDeps & { installs: number };
}

describe('ensureMemberFleetInstall failure classes', () => {
  const linux = makeTestAgent({ os: 'linux', llmProvider: 'claude' });
  const throwing = (reason: ConstructorParameters<typeof ReleaseDownloadError>[0]) =>
    async () => { throw new ReleaseDownloadError(reason, `fake ${reason}`); };

  for (const reason of ['no-matching-release', 'checksum-unavailable', 'checksum-mismatch', 'download-failed', 'download-timeout'] as const) {
    it(`${reason}: typed, nothing installed, manual steps with the anonymous download URL`, async () => {
      const d = installDeps({ download: throwing(reason) });
      const r = await ensureMemberFleetInstall(linux, d);
      expect(r).toMatchObject({ state: 'unavailable', reason });
      expect(d.installs).toBe(0);
      const steps = (r as { manualSteps: string }).manualSteps;
      expect(steps).toContain(`'${PRE}${ASSET}'`);
      expect(steps).toContain('sha256sum -c -');
      expect(steps).toContain("'install' '--llm' 'claude' '--member' '--workflows' 'none' '--transport' 'http' '--force'");
    });
  }

  it('a plain Error from the downloader is download-failed', async () => {
    const r = await ensureMemberFleetInstall(linux, installDeps({ download: async () => { throw new Error('boom'); } }));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'download-failed', detail: 'boom' });
  });

  it('unsupported platform: manual steps say to build from source', async () => {
    const r = await ensureMemberFleetInstall(linux, installDeps({ arch: 'riscv64' }));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'unsupported-platform' });
    expect((r as { manualSteps: string }).manualSteps).toContain('no apra-fleet installer is published for linux/riscv64');
  });

  it('success path: installs the exact build; no manual steps', async () => {
    const d = installDeps();
    const r = await ensureMemberFleetInstall(linux, d);
    expect(r).toMatchObject({ state: 'available', installed: true, source: 'release-asset', version: DEV });
    expect((r as { manualSteps?: string }).manualSteps).toBeUndefined();
  });
});

describe('buildManualInstallSteps is OS-correct and expansion-free', () => {
  const base = { provider: 'claude' as const, arch: 'x64', orchestratorVersion: DEV, reason: 'checksum-unavailable' as const };

  it('linux: curl + sha256sum, resolved quoted paths, no shell expansion', () => {
    const s = buildManualInstallSteps({ ...base, home: '/home/bella', targetOs: 'linux', shell: undefined as never });
    expect(s).toContain(`curl -fL -o '/home/bella/.apra-fleet/staging/${ASSET}' '${PRE}${ASSET}'`);
    expect(s).toContain(`'${PRE}SHA256SUMS'`);
    expect(s).toContain(`grep ' ${ASSET}' 'SHA256SUMS' | sha256sum -c -`);
    expect(s).not.toMatch(/\$|~\/|`/);
    expect(/^[\x20-\x7e\n]*$/.test(s)).toBe(true);
  });

  it('macos: shasum -a 256', () => {
    const s = buildManualInstallSteps({ ...base, arch: 'arm64', home: '/Users/bella', targetOs: 'macos', shell: undefined as never });
    expect(s).toContain('apra-fleet-installer-darwin-arm64');
    expect(s).toContain('shasum -a 256 -c -');
  });

  it('windows PowerShell: Invoke-WebRequest + Get-FileHash, backslash paths', () => {
    const s = buildManualInstallSteps({ ...base, home: 'C:\\Users\\bella', targetOs: 'windows', shell: undefined as never });
    expect(s).toContain(`Invoke-WebRequest -UseBasicParsing -Uri '${PRE}apra-fleet-installer-win-x64.exe' -OutFile 'C:\\Users\\bella\\.apra-fleet\\staging\\apra-fleet-installer-win-x64.exe'`);
    expect(s).toContain('Get-FileHash -Algorithm SHA256');
    expect(s).toContain("& 'C:\\Users\\bella\\.apra-fleet\\staging\\apra-fleet-installer-win-x64.exe' 'install'");
    expect(s).not.toContain('sha256sum');
  });

  it('windows Git Bash: POSIX form with the .exe asset', () => {
    const s = buildManualInstallSteps({ ...base, home: '/c/Users/bella', targetOs: 'windows', shell: 'gitbash' as never });
    expect(s).toContain("curl -fL -o '/c/Users/bella/.apra-fleet/staging/apra-fleet-installer-win-x64.exe'");
    expect(s).toContain('sha256sum -c -');
  });

  it('no-matching-release explains there is no release for the build and how to get one', () => {
    const s = buildManualInstallSteps({ ...base, reason: 'no-matching-release', home: '/home/bella', targetOs: 'linux', shell: undefined as never });
    expect(s).toContain(`no release for build ${DEV} is published yet`);
    expect(s).toContain('npm run build:binary');
  });
});

describe('fleetInstallWarning', () => {
  it('unavailable: names the KB/code-tools consequence, the reason and the steps', () => {
    const w = fleetInstallWarning('bella', { state: 'unavailable', reason: 'no-matching-release', detail: 'no published release', checkedAt: 'x', manualInstall: '(1) do it' })!;
    expect(w).toContain('WARNING: apra-fleet on member "bella"');
    expect(w).toContain('will not get the KB/code tools');
    expect(w).toContain('Reason: no-matching-release -- no published release');
    expect(w).toContain('    (1) do it');
  });

  it('available on an older install: says the older version is kept, not that tools are gone', () => {
    const w = fleetInstallWarning('bella', { state: 'available', version: 'v0.4.3', checkedAt: 'x', installFailure: { reason: 'download-failed', detail: 'net' }, manualInstall: 's' })!;
    expect(w).toContain('keeps its older apra-fleet v0.4.3');
    expect(w).toContain('Reason: download-failed -- net');
  });

  it('no manual steps -> no warning', () => {
    expect(fleetInstallWarning('bella', { state: 'available', checkedAt: 'x' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tool level: update_member / register_member succeed and print the WARNING
// ---------------------------------------------------------------------------

const plain = (cmd: string): string => (cmd.includes('-EncodedCommand') ? decodePowerShellEncodedCommand(cmd) : cmd);

function toolDeps(installed: string | null): MemberFleetMcpDeps {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  return {
    exec: async (agent, command) => {
      const c = plain(command);
      if (c.includes('member-access.key')) return ok('');
      if (c.includes('member-install.json')) return ok('');
      if (c.includes("'register-member'")) return ok('registered');
      if (c.includes('command -v bd')) return ok('bd version 1.3.0\n');
      if (c.includes("'call'") && c.includes("'--list-tools'")) return ok(JSON.stringify({ tools: [{ name: 'kb_query' }, { name: 'code_query' }] }));
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${installed}` }] }));
      if (c.includes('--version')) return ok(installed ? `apra-fleet ${installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      if (c.includes('uname -m')) return ok('x86_64');
      if (c.includes('CLAUDE_CONFIG_DIR')) return ok('');
      if (c.includes('cat "') && c.includes('.claude.json')) {
        return ok(JSON.stringify({ projects: { '/home/bella/repo': { mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:7523/mcp?member=${agent.id}` } } } } }));
      }
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, p) => ({ success: p, failed: [] }),
    resolveHome: async () => '/home/bella',
    orchestratorPlatform: () => ({ os: 'macos', arch: 'arm64' }),
    orchestratorExecutable: () => null,
    orchestratorVersion: () => DEV,
    downloadReleaseAsset: async () => { throw new ReleaseDownloadError('no-matching-release', `no published release carries the ${ASSET} installer for build ${DEV}`); },
    removeLocal: () => {},
    connectLocalMember: async () => { throw new Error('no local session expected'); },
    now: () => new Date(Date.UTC(2026, 9, 9)),
    record: (id, status) => { recordFleetMcpStatus(id, status); },
  };
}

describe('update_member / register_member never fail on an install that cannot happen', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockImplementation(makeConfigAwareExec());
  });
  afterEach(() => {
    __setMemberFleetMcpDeps(null);
    restoreRegistry();
  });

  it('update_member fleet_install auto, no member install, no release: "updated" + WARNING with reason and steps', async () => {
    const a = makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: '/home/bella/repo', friendlyName: 'bella' });
    addAgent(a);
    __setMemberFleetMcpDeps(toolDeps(null));
    const out = await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(out).toContain('Member "bella" updated.');
    expect(out).toContain('fleetMcp: unavailable (no-matching-release)');
    expect(out).toContain('(see WARNING below)');
    expect(out).toContain('WARNING: apra-fleet on member "bella"');
    expect(out).toContain('will not get the KB/code tools');
    expect(out).toContain(`curl -fL -o '/home/bella/.apra-fleet/staging/${ASSET}' '${PRE}${ASSET}'`);
    expect(getAgent(a.id)?.fleetMcp?.manualInstall).toContain('sha256sum');
  });

  it('update_member with an older install still serving: available, WARNING says the older version is kept', async () => {
    const a = makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: '/home/bella/repo', friendlyName: 'bella' });
    addAgent(a);
    __setMemberFleetMcpDeps(toolDeps('v0.4.3'));
    const out = await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(out).toContain('Member "bella" updated.');
    expect(out).toContain('fleetMcp: available (apra-fleet v0.4.3)');
    expect(out).toContain('keeps its older apra-fleet v0.4.3');
    expect(out).toContain('Reason: no-matching-release');
  });

  it('register_member with no release: registered + WARNING', async () => {
    __setMemberFleetMcpDeps(toolDeps(null));
    const out = await registerMember({
      member_type: 'remote', host: '192.168.1.120', username: 'bella', work_folder: '/home/bella/repo', auth_type: 'password', password: 'pw',
      friendly_name: 'bella', llm_provider: 'claude', fleet_install: 'auto', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30,
    } as any);
    expect(out).toContain('Member registered successfully');
    expect(out).toContain('WARNING: apra-fleet on member "bella"');
    expect(out).toContain('Reason: no-matching-release');
  });
});
