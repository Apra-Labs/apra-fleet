// Real git, sandboxed: the per-member git credential helper (written by
// provision_vcs_auth, registered for git only through the dispatch environment)
// gives each member ITS OWN token, even when several members run as one OS
// user, and gives one member the right token per label.
//
// Every command provision_vcs_auth generates for a POSIX member is executed
// for real by bash with HOME / USERPROFILE / XDG_CONFIG_HOME pointed at a fresh
// temp dir, GIT_CONFIG_GLOBAL at an empty temp file and the system config
// disabled; the members' work folders are temp git repos. No real member, no
// real token (the provider is azure-devops with a made-up PAT and no repo, so
// nothing is minted and nothing touches the network), throwaway fleet data dir
// (tests/setup.ts). On Windows the POSIX commands run under Git for Windows'
// bash; with no usable bash the file is skipped.
//
// GitHub members use a mocked App mint (no real token); the two network
// commands a GitHub provision issues (gh auth login, the git ls-remote
// connectivity check) are answered by the mock, never run. Windows members
// (windows-powershell, windows-gitbash) are not executed: their generated
// commands are recorded and asserted instead.
//
// Not covered here (needs-external-evidence): two real same-user members on
// one host with re-provisionable credentials pushing concurrently.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, FLEET_DIR } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import { vcsGitEnvPrefix } from '../src/services/vcs-git-env.js';
import { getOsCommands } from '../src/os/index.js';
import { getVcsCredentials } from '../src/services/vcs-credential-record.js';
import { _getCleanupTimers, cleanupTimerKey, scheduleCredentialCleanup } from '../src/services/credential-cleanup.js';
import { mintGitToken } from '../src/services/github-app.js';
import type { Agent, SSHExecResult } from '../src/types.js';

function findBash(): string | null {
  try {
    if (process.platform === 'win32') {
      const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf-8' }).trim();
      const bash = path.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
      return fs.existsSync(bash) ? bash : null;
    }
    execFileSync('git', ['--version']);
    return fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  } catch {
    return null;
  }
}
const BASH = findBash();

let sandbox = '';
let sandboxEnv: NodeJS.ProcessEnv = {};

function runBash(cmd: string, cwd: string): SSHExecResult {
  const r = spawnSync(BASH!, ['-c', cmd], { cwd, env: sandboxEnv, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

/** Commands generated for Windows members: recorded, never executed. */
const windowsCommands: Array<{ memberId: string; cmd: string }> = [];
/** gh auth login commands a provision issued: recorded, never executed. */
const ghLoginCommands: Array<{ memberId: string; cmd: string }> = [];

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: (agent: Agent) => ({
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
    execCommand: async (cmd: string) => {
      if (agent.os === 'windows') {
        windowsCommands.push({ memberId: agent.id, cmd });
        return { stdout: '', stderr: '', code: 0 };
      }
      // Network commands of a GitHub provision: answered, never run.
      if (/gh auth login/.test(cmd)) {
        ghLoginCommands.push({ memberId: agent.id, cmd });
        return { stdout: '', stderr: '', code: 0 };
      }
      if (/git ls-remote/.test(cmd)) return { stdout: '', stderr: '', code: 0 };
      return runBash(cmd, agent.workFolder);
    },
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/github-app.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/github-app.js')>('../src/services/github-app.js');
  return {
    ...actual,
    mintGitToken: vi.fn(),
    loadPrivateKey: vi.fn().mockReturnValue('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'),
  };
});
const mockMint = vi.mocked(mintGitToken);
const GIT_APP_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');

vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: vi.fn().mockResolvedValue({ fallback: '[FAIL] OOB cancelled in test.' }),
}));

/** What `git credential fill` in the member's own clone, with its dispatch environment, returns for a host. */
function gitFill(agent: Agent, host: string): string {
  const prefix = vcsGitEnvPrefix(getAgent(agent.id)!);
  const r = runBash(`${prefix}printf 'protocol=https\\nhost=${host}\\n\\n' | git credential fill`, agent.workFolder);
  const m = /^password=(.*)$/m.exec(r.stdout);
  return m ? m[1].trim() : `<no password: exit ${r.code} ${r.stderr.trim()}>`;
}

/** What the read path (vcs_credential_exec's server-side helper read) returns for a label. */
function readLabel(agent: Agent, label: string): string {
  const read = getOsCommands('linux').gitCredentialHelperRead(label, agent.id);
  const r = runBash(read.command, agent.workFolder);
  const m = /^password=(.*)$/m.exec(r.stdout);
  return m ? m[1].trim() : `<no password: exit ${r.code} ${r.stderr.trim()}>`;
}

function makeMember(name: string): Agent {
  const workFolder = path.join(sandbox, name);
  fs.mkdirSync(workFolder, { recursive: true });
  runBash('git init -q .', workFolder);
  // Same host, same OS user: the case a global helper broke.
  return makeTestAgent({ friendlyName: name, os: 'linux', host: 'build.example', username: 'ci', workFolder });
}

/** Provision a GitHub App credential; the (mocked) mint returns `token`. */
async function provisionGithub(
  agent: Agent, token: string, repos: string[], label?: string,
  access: 'push' | 'push+pr' | 'issues' = 'push', expiresInMs = 3600_000,
) {
  mockMint.mockResolvedValueOnce({ token, expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
  const res = await provisionVcsAuth({
    member_id: agent.id, provider: 'github', github_mode: 'github-app', git_access: access, repos,
    ...(label ? { label } : {}),
  });
  expect(res.text).toContain('[OK]');
  return res;
}

function makeWindowsMember(name: string, shell: 'powershell5' | 'gitbash'): Agent {
  return makeTestAgent({ friendlyName: name, os: 'windows', shell, host: 'win.example', username: 'ci', workFolder: `C:\\work\\${name}` });
}

async function provision(agent: Agent, pat: string, label?: string, scope?: string) {
  const res = await provisionVcsAuth({
    member_id: agent.id, provider: 'azure-devops', org_url: 'https://dev.azure.com/org', pat,
    ...(label ? { label } : {}), ...(scope ? { scope_url: scope } : {}),
  });
  expect(res.text).toContain('[OK]');
}

describe.skipIf(!BASH)('per-member git credential helpers (real git, sandboxed HOME)', () => {
  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-vcs-helper-'));
    const home = path.join(sandbox, 'home');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(sandbox, 'xdg'));
    const globalConfig = path.join(sandbox, 'global.gitconfig');
    fs.writeFileSync(globalConfig, '');
    sandboxEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg'),
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GH_CONFIG_DIR: path.join(sandbox, 'gh'),
    };
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  let gitAppConfigBackup: string | null = null;
  beforeEach(() => {
    backupAndResetRegistry();
    windowsCommands.length = 0;
    ghLoginCommands.length = 0;
    mockMint.mockReset();
    gitAppConfigBackup = fs.existsSync(GIT_APP_CONFIG_PATH) ? fs.readFileSync(GIT_APP_CONFIG_PATH, 'utf-8') : null;
    fs.writeFileSync(GIT_APP_CONFIG_PATH, JSON.stringify({
      version: '1.0',
      github: { appId: '123', privateKeyPath: path.join(sandbox, 'app.pem'), installationId: 999, createdAt: '2026-01-01T00:00:00Z' },
    }));
  });
  afterEach(() => {
    const timers = _getCleanupTimers();
    for (const [key, timer] of [...timers]) {
      clearTimeout(timer);
      timers.delete(key);
    }
    if (gitAppConfigBackup !== null) fs.writeFileSync(GIT_APP_CONFIG_PATH, gitAppConfigBackup);
    else fs.rmSync(GIT_APP_CONFIG_PATH, { force: true });
    restoreRegistry();
  });

  it('two members on one OS user each read back their own token (git fill in their clone, and the read path)', async () => {
    const a = makeMember('member-a');
    const b = makeMember('member-b');
    addAgent(a);
    addAgent(b);

    await provision(a, 'token-of-a');
    await provision(b, 'token-of-b');

    expect(gitFill(a, 'dev.azure.com')).toBe('token-of-a');
    expect(gitFill(b, 'dev.azure.com')).toBe('token-of-b');
    expect(readLabel(a, 'azure-devops')).toBe('token-of-a');
    expect(readLabel(b, 'azure-devops')).toBe('token-of-b');
  });

  it('one member with two labels for the same host reads back the right token per label', async () => {
    const m = makeMember('member-two-labels');
    addAgent(m);

    // The non-default label is provisioned FIRST and refreshed LAST: git
    // still uses the provider-named label, whatever the provisioning order.
    await provision(m, 'issues-token-1', 'az-issues');
    await provision(m, 'push-token', 'azure-devops');
    await provision(m, 'issues-token-2', 'az-issues');

    expect(readLabel(m, 'azure-devops')).toBe('push-token');
    expect(readLabel(m, 'az-issues')).toBe('issues-token-2');
    expect(gitFill(m, 'dev.azure.com')).toBe('push-token');
  });

  // bd/dolt pushes through its own bare cache repository
  // (<clone>/.beads/.../.dolt/git-remote-cache/<hash>/repo.git), whose config
  // never includes the clone's: a clone-local registration would be invisible
  // there. The dispatch-environment registration is not.
  it('a git process in a separate bare repository (the bd/dolt remote cache shape) finds the helper too', async () => {
    const m = makeMember('member-dolt-cache');
    addAgent(m);
    await provision(m, 'cache-token');
    const cacheRepo = path.join(m.workFolder, '.beads', 'embeddeddolt', 'beads', '.dolt', 'git-remote-cache', 'h', 'repo.git');
    fs.mkdirSync(cacheRepo, { recursive: true });
    runBash('git init -q --bare .', cacheRepo);
    const prefix = vcsGitEnvPrefix(getAgent(m.id)!);
    const r = runBash(`${prefix}printf 'protocol=https\\nhost=dev.azure.com\\n\\n' | git --git-dir=. credential fill`, cacheRepo);
    expect(/^password=(.*)$/m.exec(r.stdout)?.[1]).toBe('cache-token');
  });

  it('nothing is written to the (sandboxed) global git config', async () => {
    const m = makeMember('member-global-check');
    addAgent(m);
    await provision(m, 'some-token');
    const globalConfig = fs.readFileSync(sandboxEnv.GIT_CONFIG_GLOBAL!, 'utf-8');
    expect(globalConfig).not.toMatch(/credential/i);
  });

  it('two members on one OS user provisioned at the same time each still read back their own token', async () => {
    const a = makeMember('member-conc-a');
    const b = makeMember('member-conc-b');
    addAgent(a);
    addAgent(b);

    await Promise.all([provision(a, 'concurrent-token-a'), provision(b, 'concurrent-token-b')]);

    expect(gitFill(a, 'dev.azure.com')).toBe('concurrent-token-a');
    expect(gitFill(b, 'dev.azure.com')).toBe('concurrent-token-b');
    expect(readLabel(a, 'azure-devops')).toBe('concurrent-token-a');
    expect(readLabel(b, 'azure-devops')).toBe('concurrent-token-b');
  });

  // The 2026-11-16 repro: one member, labels github and github-issues for
  // github.com. The second label must not take over or drop the first --
  // the record, helper file and cleanup timer of each label survive.
  it('one member with labels github and github-issues for github.com reads back each label own token', async () => {
    const m = makeMember('member-gh-labels');
    addAgent(m);

    await provisionGithub(m, 'ghs_push_token', ['acme/widgets'], 'github');
    await provisionGithub(m, 'ghs_issues_token', ['acme/widgets'], 'github-issues');

    expect(readLabel(m, 'github')).toBe('ghs_push_token');
    expect(readLabel(m, 'github-issues')).toBe('ghs_issues_token');
    // git pushes with the provider-named label.
    expect(gitFill(m, 'github.com')).toBe('ghs_push_token');
    expect(Object.keys(getVcsCredentials(getAgent(m.id)!)).sort()).toEqual(['github', 'github-issues']);
    const prefix = vcsGitEnvPrefix(getAgent(m.id)!);
    expect(prefix).toContain(`.fleet-git-credential-github.${m.id}`);
    expect(prefix).toContain(`.fleet-git-credential-github-issues.${m.id}`);
    expect(_getCleanupTimers().has(cleanupTimerKey(m.id, 'github'))).toBe(true);
    expect(_getCleanupTimers().has(cleanupTimerKey(m.id, 'github-issues'))).toBe(true);
  });

  it('after GitHub provisioning of two members, the sandboxed global git config holds no credential helper key', async () => {
    const a = makeMember('member-gh-global-a');
    const b = makeMember('member-gh-global-b');
    addAgent(a);
    addAgent(b);
    await provisionGithub(a, 'ghs_a', ['acme/widgets']);
    await provisionGithub(b, 'ghs_b', ['acme/widgets'], 'github-issues');
    expect(fs.readFileSync(sandboxEnv.GIT_CONFIG_GLOBAL!, 'utf-8')).not.toMatch(/credential/i);
    const r = runBash('git config --global --get-regexp credential || true', a.workFolder);
    expect(r.stdout.trim()).toBe('');
  });

  it('re-provisioning member A with a different repo scope does not change what member B reads', async () => {
    const a = makeMember('member-scope-a');
    const b = makeMember('member-scope-b');
    addAgent(a);
    addAgent(b);
    await provisionGithub(a, 'ghs_a_widgets', ['acme/widgets']);
    await provisionGithub(b, 'ghs_b_widgets', ['acme/widgets']);

    await provisionGithub(a, 'ghs_a_gadgets', ['acme/gadgets']);

    expect(mockMint.mock.calls.at(-1)?.[3]).toEqual(['acme/gadgets']);
    expect(gitFill(a, 'github.com')).toBe('ghs_a_gadgets');
    expect(gitFill(b, 'github.com')).toBe('ghs_b_widgets');
    expect(readLabel(b, 'github')).toBe('ghs_b_widgets');
  });

  it.each([['windows-powershell', 'powershell5'], ['windows-gitbash', 'gitbash']] as const)(
    '%s: two members on one OS user get generated commands that write and register only their own helper',
    async (_name, shell) => {
      const a = makeWindowsMember(`win-${shell}-a`, shell);
      const b = makeWindowsMember(`win-${shell}-b`, shell);
      addAgent(a);
      addAgent(b);

      await provision(a, 'win-token-a');
      await provision(b, 'win-token-b');

      const writesOf = (id: string) => windowsCommands
        .filter(c => c.memberId === id && c.cmd.includes('win-token-'))
        .map(c => c.cmd)
        .join('\n');
      const writeA = writesOf(a.id);
      const writeB = writesOf(b.id);
      expect(writeA).toContain(`.fleet-git-credential-azure-devops.${a.id}`);
      expect(writeA).toContain('win-token-a');
      expect(writeA).not.toContain(b.id);
      expect(writeA).not.toContain('win-token-b');
      expect(writeA).not.toContain('--global');
      expect(writeB).toContain(`.fleet-git-credential-azure-devops.${b.id}`);
      expect(writeB).toContain('win-token-b');
      expect(writeB).not.toContain(a.id);
      expect(writeB).not.toContain('--global');

      const prefixA = vcsGitEnvPrefix(getAgent(a.id)!);
      const prefixB = vcsGitEnvPrefix(getAgent(b.id)!);
      expect(prefixA).toContain(`.fleet-git-credential-azure-devops.${a.id}`);
      expect(prefixA).not.toContain(b.id);
      expect(prefixB).toContain(`.fleet-git-credential-azure-devops.${b.id}`);
      expect(prefixB).not.toContain(a.id);
    },
  );

  // Re-mint of the same label/access, with the cleanup timer of the FIRST
  // provisioning still pending in another fleet server process on the host
  // (each agent session can run its own; the registry on disk is shared).
  // That stale timer fires at the first token's expiry and must leave the
  // re-minted credential every reader uses in place.
  it('re-minting the same label/access keeps the credential readers use when the first provision timer fires', async () => {
    const m = makeMember('member-remint');
    addAgent(m);
    await provisionGithub(m, 'ghs_first', ['acme/widgets'], 'github', 'push+pr', 3600_000);
    const firstExpiry = getVcsCredentials(getAgent(m.id)!).github.expiresAt!;
    expect(gitFill(m, 'github.com')).toBe('ghs_first');

    await provisionGithub(m, 'ghs_second', ['acme/widgets'], 'github', 'push+pr', 2 * 3600_000);
    expect(gitFill(m, 'github.com')).toBe('ghs_second');

    // The other process's timer, scheduled for the first token.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      scheduleCredentialCleanup(m.id, 'github', firstExpiry);
      await vi.advanceTimersByTimeAsync(3600_000 + 1000);
    } finally {
      vi.useRealTimers();
    }

    expect(gitFill(m, 'github.com')).toBe('ghs_second');
    expect(readLabel(m, 'github')).toBe('ghs_second');
    expect(Object.keys(getVcsCredentials(getAgent(m.id)!))).toEqual(['github']);
  });

  it('a different access level or repo set changes neither the host gh login nor the global git config', async () => {
    const m = makeMember('member-gh-identity');
    const other = makeMember('member-gh-identity-other');
    addAgent(m);
    addAgent(other);
    const ghDir = sandboxEnv.GH_CONFIG_DIR!;
    fs.mkdirSync(ghDir, { recursive: true });
    const hostsYml = path.join(ghDir, 'hosts.yml');
    const hostsBefore = 'github.com:\n    oauth_token: ghs_identity_other_processes_use\n';
    fs.writeFileSync(hostsYml, hostsBefore);
    const globalBefore = fs.readFileSync(sandboxEnv.GIT_CONFIG_GLOBAL!, 'utf-8');

    const issues = await provisionGithub(m, 'ghs_issues_level', ['acme/widgets'], 'github-issues', 'issues');
    const otherRepos = await provisionGithub(m, 'ghs_other_repos', ['acme/gadgets'], 'github', 'push');

    expect(ghLoginCommands).toEqual([]);
    expect(issues.text).toMatch(/ghCliAuth: skipped/);
    expect(otherRepos.text).toMatch(/ghCliAuth: skipped/);
    expect(fs.readFileSync(hostsYml, 'utf-8')).toBe(hostsBefore);
    expect(fs.readFileSync(sandboxEnv.GIT_CONFIG_GLOBAL!, 'utf-8')).toBe(globalBefore);
    // Each token stays readable on its own label.
    expect(readLabel(m, 'github-issues')).toBe('ghs_issues_level');
    expect(readLabel(m, 'github')).toBe('ghs_other_repos');
  });

  // The 2026-10-23 scenario: a NEW member on the same host user, scoped to
  // repo X, must not narrow what an existing member uses for repo Y.
  it('provisioning a new same-user member scoped to repo X does not narrow the credential another member uses for repo Y', async () => {
    const existing = makeMember('member-repo-y');
    addAgent(existing);
    await provisionGithub(existing, 'ghs_repo_y', ['acme/repo-y'], 'github', 'push+pr');
    ghLoginCommands.length = 0;

    const newcomer = makeMember('member-repo-x');
    addAgent(newcomer);
    await provisionGithub(newcomer, 'ghs_repo_x', ['acme/repo-x'], 'github', 'push+pr');

    expect(mockMint.mock.calls.at(-1)?.[3]).toEqual(['acme/repo-x']);
    expect(ghLoginCommands).toEqual([]);
    expect(gitFill(existing, 'github.com')).toBe('ghs_repo_y');
    expect(readLabel(existing, 'github')).toBe('ghs_repo_y');
    expect(gitFill(newcomer, 'github.com')).toBe('ghs_repo_x');
  });
});
