import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadConfig, resolveMemberConfigs } from '../.github/e2e/fleet-setup.mjs';

const REPO_ROOT = path.join(process.cwd());

describe('fleet-setup.mjs config resolution', () => {
  it('loads suites.json and members.json', () => {
    const { suites, members } = loadConfig(REPO_ROOT);
    expect(suites.suites).toBeTruthy();
    expect(members.toy_projects).toBeTruthy();
  });

  it('resolves a remote suite (s1) to doer/reviewer with host/username/folder', () => {
    const config = loadConfig(REPO_ROOT);
    const resolved = resolveMemberConfigs('s1', config);

    expect(resolved.doer).toMatchObject({
      name: 'alice',
      tags: ['doer'],
      type: 'remote',
      provider: 'claude',
      host: '192.168.1.102',
      username: 'akhil',
      folder: '/home/akhil/git/apra-fleet-e2e',
    });
    expect(resolved.reviewer).toMatchObject({
      name: 'bella',
      tags: ['reviewer'],
      type: 'remote',
      provider: 'claude',
      host: '192.168.1.13',
      username: 'akhil',
      folder: '/Users/akhil/git/apra-fleet-e2e',
    });
  });

  it('resolves a local suite (s1.2) to local-role-specific members.json keys', () => {
    const config = loadConfig(REPO_ROOT);
    const resolved = resolveMemberConfigs('s1.2', config);

    expect(resolved.doer.type).toBe('local');
    expect(resolved.doer.host).toBe('local');
    expect(resolved.doer.username).toBeUndefined();
    expect(resolved.doer.folder).toBe('/home/akhil/git/apra-fleet-e2e-doer');

    expect(resolved.reviewer.type).toBe('local');
    expect(resolved.reviewer.folder).toBe('/home/akhil/git/apra-fleet-e2e-rev');
    // doer and reviewer must never collide on the same local folder
    expect(resolved.doer.folder).not.toBe(resolved.reviewer.folder);
  });

  it('carries each role\'s own llm_provider through, even when it differs from the PM\'s', () => {
    const config = loadConfig(REPO_ROOT);
    const resolved = resolveMemberConfigs('s2', config); // pm=claude, doer/reviewer=agy
    expect(resolved.doer.provider).toBe('agy');
    expect(resolved.reviewer.provider).toBe('agy');
  });

  it('throws a clear error for an unknown suite id', () => {
    const config = loadConfig(REPO_ROOT);
    expect(() => resolveMemberConfigs('does-not-exist', config)).toThrow(/Unknown suite/);
  });
});
