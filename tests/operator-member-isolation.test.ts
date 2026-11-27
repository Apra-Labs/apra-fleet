/**
 * Members never get the operator's GitHub credential. `apra-fleet operator-auth
 * github` registers an installation-wide helper on the GLOBAL
 * credential.https://github.com.helper key of the operator host; a local
 * member's git reads that same global config, so its dispatch prefix must
 * reset that scope whenever the operator helper is set up and the member has
 * no helper of its own for exactly that scope.
 *
 * Hermetic: the operator record check is mocked (no file in the shared test
 * FLEET_DIR, which other files read in parallel); the real-git check runs only
 * `git config --get-all` against a temp global config with HOME, USERPROFILE
 * and GIT_CONFIG_GLOBAL in a temp dir -- never `git credential fill`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTestAgent, makeTestLocalAgent } from './test-helpers.js';
import { getOsCommands } from '../src/os/index.js';
import type { Agent, VcsCredentialRecord } from '../src/types.js';

const state = vi.hoisted(() => ({ operatorSetUp: false }));
vi.mock('../src/services/operator-auth-record.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/operator-auth-record.js')>()),
  hasOperatorGithubCredential: () => state.operatorSetUp,
}));

import { vcsGitEnvPrefix } from '../src/services/vcs-git-env.js';
const { hasOperatorGithubCredential: realHasOperatorGithubCredential } =
  await vi.importActual<typeof import('../src/services/operator-auth-record.js')>('../src/services/operator-auth-record.js');

const RESET = "'credential.https://github.com.helper='";
const posix = getOsCommands('linux');
const pwsh = getOsCommands('windows');

function cred(scopeUrl: string, provider: VcsCredentialRecord['provider'] = 'github'): VcsCredentialRecord {
  return { provider, scopeUrl, memberScoped: true };
}

function local(overrides: Partial<Agent> = {}): Agent {
  return makeTestLocalAgent({ id: 'member-a', ...overrides });
}

beforeEach(() => { state.operatorSetUp = false; });

describe('a local member without its own github.com credential gets no operator token', () => {
  it('operator helper set up: the github.com list is reset (POSIX and PowerShell), nothing is registered', () => {
    state.operatorSetUp = true;
    const p = vcsGitEnvPrefix(local(), posix);
    expect(p).toBe(`export GIT_CONFIG_PARAMETERS="${RESET}"; `);
    const w = vcsGitEnvPrefix(local(), pwsh);
    expect(w).toBe(`$env:GIT_CONFIG_PARAMETERS = "${RESET}"; `);
    expect(p + w).not.toContain('git-credential');
  });

  it('no operator helper on this host: unchanged, no prefix (upgrading hosts keep their behaviour)', () => {
    expect(vcsGitEnvPrefix(local(), posix)).toBe('');
    expect(vcsGitEnvPrefix(local(), pwsh)).toBe('');
  });

  it('a remote member does not share the operator global config: no prefix', () => {
    state.operatorSetUp = true;
    expect(vcsGitEnvPrefix(makeTestAgent({ id: 'member-r' }), posix)).toBe('');
  });

  it('a member credential on another scope: the github.com reset comes BEFORE the member group', () => {
    state.operatorSetUp = true;
    for (const scope of ['https://github.com/org-a', 'https://dev.azure.com/org']) {
      const provider = scope.includes('azure') ? 'azure-devops' : 'github';
      const agent = local({ vcsCredentials: { [provider]: cred(scope, provider) } });
      for (const cmds of [posix, pwsh]) {
        const p = vcsGitEnvPrefix(agent, cmds);
        const reset = p.indexOf(RESET);
        const own = p.indexOf(`'credential.${scope}.helper='`);
        expect(reset).toBeGreaterThan(-1);
        expect(own).toBeGreaterThan(reset);
        expect(p).toContain(`.fleet-git-credential-${provider}.member-a`);
      }
    }
  });

  it('a member credential on exactly https://github.com already resets it: no second reset', () => {
    state.operatorSetUp = true;
    const p = vcsGitEnvPrefix(local({ vcsCredentials: { github: cred('https://github.com') } }), posix);
    expect(p.split(RESET).length - 1).toBe(1);
    expect(p).toContain('.fleet-git-credential-github.member-a');
  });

  describe('real git (temp global config only)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-member-iso-'));
    afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it('the reset is the last value git sees on the key, after the operator helper', () => {
      state.operatorSetUp = true;
      const globalConfig = path.join(tmp, 'gitconfig');
      fs.writeFileSync(globalConfig, '');
      const env: NodeJS.ProcessEnv = {
        ...process.env, HOME: tmp, USERPROFILE: tmp, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1',
      };
      delete env.GIT_CONFIG_PARAMETERS;
      const key = 'credential.https://github.com.helper';
      const operatorHelper = '!/opt/apra-fleet git-credential --label github';
      for (const v of ['', operatorHelper]) execFileSync('git', ['config', '--global', '--add', key, v], { env });
      const prefix = vcsGitEnvPrefix(local(), posix);
      const params = /GIT_CONFIG_PARAMETERS="(.*)"; $/.exec(prefix)![1];
      const values = execFileSync('git', ['config', '-z', '--get-all', key], { env: { ...env, GIT_CONFIG_PARAMETERS: params }, encoding: 'utf8' })
        .split('\0').slice(0, -1);
      // git applies values in this order and an empty one clears the list:
      // nothing is left, so the operator helper is never asked.
      expect(values).toEqual(['', operatorHelper, '']);
    });
  });
});

describe('hasOperatorGithubCredential reads the operator record', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-record-'));
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('true only for a record holding at least one github label', () => {
    const file = path.join(tmp, 'operator-auth.json');
    expect(realHasOperatorGithubCredential(file)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, github: {} }));
    expect(realHasOperatorGithubCredential(file)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ version: 1, github: { github: { label: 'github' } } }));
    expect(realHasOperatorGithubCredential(file)).toBe(true);
    fs.writeFileSync(file, 'not json');
    expect(realHasOperatorGithubCredential(file)).toBe(false);
  });
});
