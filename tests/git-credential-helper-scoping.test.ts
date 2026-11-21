/**
 * The OS credential-helper command builders for every member OS/shell:
 *
 *  - gitCredentialHelperWrite/Remove touch the member's OWN helper file
 *    (`.fleet-git-credential-<label>.<member id>`) and NO git config file --
 *    in particular never --global, which every member running as the same OS
 *    user shared and overwrote.
 *  - Write and Remove agree on the file for a (label, member) pair; two labels
 *    or two members never collide.
 *  - gitCredentialEnvPrefix registers the helpers for git through
 *    GIT_CONFIG_PARAMETERS (reset entry first, then helpers in order).
 *  - gitCredentialHelperRemoveLegacyGlobal is the one builder that still names
 *    the global config: it removes a helper an older release registered there.
 */
import { describe, it, expect } from 'vitest';
import { getOsCommands } from '../src/os/index.js';
import { gitCredentialHelperStem, isSafeGitCredentialScope } from '../src/os/os-commands.js';

const shells = [
  ['linux', getOsCommands('linux')],
  ['macos', getOsCommands('macos')],
  ['windows-powershell', getOsCommands('windows', 'powershell5')],
  ['windows-gitbash', getOsCommands('windows', 'gitbash')],
] as const;

describe.each(shells)('%s git credential helper builders', (_name, cmds) => {
  it('write and remove issue no --global (and no git config at all)', () => {
    const write = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghu_tok', 'work-github', 'https://github.com/my-org', 'member-a');
    const remove = cmds.gitCredentialHelperRemove('github.com', 'work-github', 'https://github.com/my-org', 'member-a');
    for (const cmd of [write, remove]) {
      expect(cmd).not.toContain('--global');
      expect(cmd).not.toContain('git config');
    }
  });

  it('write, remove and read agree on the per-member, per-label file', () => {
    const write = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'ghu_tok', 'work-github', undefined, 'member-a');
    const remove = cmds.gitCredentialHelperRemove('github.com', 'work-github', undefined, 'member-a');
    const read = cmds.gitCredentialHelperRead('work-github', 'member-a');
    for (const cmd of [write, remove, read.command, read.path]) {
      expect(cmd).toContain('.fleet-git-credential-work-github.member-a');
    }
  });

  it('two members of one OS user and two labels of one member never share a file', () => {
    const a = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'tok-a', 'github', undefined, 'member-a');
    const b = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'tok-b', 'github', undefined, 'member-b');
    const issues = cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'tok-i', 'github-issues', undefined, 'member-a');
    expect(a).toContain('.fleet-git-credential-github.member-a');
    expect(a).not.toContain('member-b');
    expect(b).toContain('.fleet-git-credential-github.member-b');
    expect(issues).toContain('.fleet-git-credential-github-issues.member-a');
    const removeA = cmds.gitCredentialHelperRemove('github.com', 'github', undefined, 'member-a');
    expect(removeA).not.toContain('member-b');
    expect(removeA).not.toContain('github-issues');
  });

  it('the env prefix resets the helper list per scope, then lists the helpers in the given order', () => {
    const prefix = cmds.gitCredentialEnvPrefix([
      { scopeUrl: 'https://github.com', label: 'github' },
      { scopeUrl: 'https://github.com', label: 'github-issues' },
      { scopeUrl: 'https://dev.azure.com/org', label: 'azure-devops' },
    ], 'member-a');
    expect(prefix).toContain('GIT_CONFIG_PARAMETERS');
    expect(prefix).not.toContain('--global');
    const reset = prefix.indexOf("'credential.https://github.com.helper='");
    const first = prefix.indexOf('.fleet-git-credential-github.member-a');
    const second = prefix.indexOf('.fleet-git-credential-github-issues.member-a');
    const azureReset = prefix.indexOf("'credential.https://dev.azure.com/org.helper='");
    expect(reset).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(reset);
    expect(second).toBeGreaterThan(first);
    expect(azureReset).toBeGreaterThan(second);
  });

  it('no helpers -> no prefix', () => {
    expect(cmds.gitCredentialEnvPrefix([], 'member-a')).toBe('');
  });

  it('refuses an unsafe scope URL, label or member id rather than escaping it', () => {
    expect(() => cmds.gitCredentialEnvPrefix([{ scopeUrl: 'https://github.com/"$(id)"', label: 'github' }], 'member-a')).toThrow(/unsafe scope URL/);
    expect(() => cmds.gitCredentialEnvPrefix([{ scopeUrl: 'https://github.com', label: 'a b' }], 'member-a')).toThrow(/unsafe VCS credential label/);
    expect(() => cmds.gitCredentialEnvPrefix([{ scopeUrl: 'https://github.com', label: 'github' }], 'id;rm')).toThrow(/unsafe member id/);
  });

  it('the legacy cleanup names the shared per-OS-user file and the global key of its scope', () => {
    const cmd = cmds.gitCredentialHelperRemoveLegacyGlobal('github.com', 'work-github', 'https://github.com/my-org');
    expect(cmd).toContain('.fleet-git-credential-work-github');
    expect(cmd).not.toMatch(/\.fleet-git-credential-work-github\.(?!bat)/);
    expect(cmd).toContain('credential.https://github.com/my-org.helper');
    expect(cmd).toContain('--global');
  });
});

describe('helper naming and scope validation', () => {
  it('stem: per member and label, legacy without a member id', () => {
    expect(gitCredentialHelperStem('github', 'm1')).toBe('.fleet-git-credential-github.m1');
    expect(gitCredentialHelperStem('github')).toBe('.fleet-git-credential-github');
    expect(gitCredentialHelperStem()).toBe('.fleet-git-credential');
    expect(gitCredentialHelperStem(undefined, 'm1')).toBe('.fleet-git-credential.m1');
  });

  it('scope URLs: plain URLs pass, anything needing escaping is refused', () => {
    for (const ok of ['https://github.com', 'https://github.com/my-org', 'https://dev.azure.com/org', 'https://ORG.visualstudio.com', 'https://git.example.com:8443/team']) {
      expect(isSafeGitCredentialScope(ok)).toBe(true);
    }
    for (const bad of ['github.com', "https://x.com/a'b", 'https://x.com/a"b', 'https://x.com/$HOME', 'https://x.com/a=b', 'https://x.com/a b', 'https://x.com/?q', 'https://x.com/#f', 'https://x.com\\a', 'https://x.com/`id`']) {
      expect(isSafeGitCredentialScope(bad)).toBe(false);
    }
  });
});
