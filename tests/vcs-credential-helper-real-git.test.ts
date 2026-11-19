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
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import { vcsGitEnvPrefix } from '../src/services/vcs-git-env.js';
import { getOsCommands } from '../src/os/index.js';
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

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: (agent: Agent) => ({
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
    execCommand: async (cmd: string) => runBash(cmd, agent.workFolder),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

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

  beforeEach(() => backupAndResetRegistry());
  afterEach(() => restoreRegistry());

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
});
