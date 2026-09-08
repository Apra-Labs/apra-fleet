/**
 * Unit coverage for detectVcsProviderFromRemoteUrl (apra-fleet-5oo), the pure
 * URL -> provider mapping register_member uses to auto-detect a member's
 * vcsProvider from its git 'origin' remote.
 *
 * Mirrors the URL-form coverage of the orchestrator-side equivalents this
 * function deliberately parallels: vcs-module.mjs's parseRemote() and each
 * vcs-providers/*.mjs descriptor's matchesHost().
 */
import { describe, it, expect } from 'vitest';
import { detectVcsProviderFromRemoteUrl, parseRemoteHost } from '../src/utils/vcs-provider-detect.js';

describe('detectVcsProviderFromRemoteUrl', () => {
  describe('github', () => {
    const urls = [
      'https://github.com/Apra-Labs/apra-fleet.git',
      'https://github.com/Apra-Labs/apra-fleet',
      'http://github.com/Apra-Labs/apra-fleet.git',
      'https://user:token@github.com/Apra-Labs/apra-fleet.git',
      'ssh://git@github.com/Apra-Labs/apra-fleet.git',
      'ssh://git@ssh.github.com:443/Apra-Labs/apra-fleet.git',
      'git://github.com/Apra-Labs/apra-fleet.git',
      'git@github.com:Apra-Labs/apra-fleet.git',
      'git@github.com:Apra-Labs/apra-fleet',
      'GIT@GITHUB.COM:Apra-Labs/apra-fleet.git',
      'https://GitHub.com/Apra-Labs/apra-fleet.git',
    ];
    for (const url of urls) {
      it(`detects github from ${url}`, () => {
        expect(detectVcsProviderFromRemoteUrl(url)).toBe('github');
      });
    }
  });

  describe('bitbucket', () => {
    const urls = [
      'https://bitbucket.org/team/repo.git',
      'https://www.bitbucket.org/team/repo.git',
      'https://user@bitbucket.org/team/repo.git',
      'ssh://git@bitbucket.org/team/repo.git',
      'ssh://git@altssh.bitbucket.org:443/team/repo.git',
      'git@bitbucket.org:team/repo.git',
    ];
    for (const url of urls) {
      it(`detects bitbucket from ${url}`, () => {
        expect(detectVcsProviderFromRemoteUrl(url)).toBe('bitbucket');
      });
    }
  });

  describe('azure-devops', () => {
    const urls = [
      'https://dev.azure.com/org/project/_git/repo',
      'https://org@dev.azure.com/org/project/_git/repo',
      'git@ssh.dev.azure.com:v3/org/project/repo',
      'ssh://git@ssh.dev.azure.com:22/v3/org/project/repo',
      'https://org.visualstudio.com/project/_git/repo',
      'https://visualstudio.com/project/_git/repo',
      'git@vs-ssh.visualstudio.com:v3/org/project/repo',
    ];
    for (const url of urls) {
      it(`detects azure-devops from ${url}`, () => {
        expect(detectVcsProviderFromRemoteUrl(url)).toBe('azure-devops');
      });
    }
  });

  describe('unrecognized -> null (never a guess)', () => {
    const urls: Array<[string, unknown]> = [
      ['empty string', ''],
      ['whitespace only', '   '],
      ['undefined', undefined],
      ['null', null],
      ['a gitlab remote', 'https://gitlab.com/group/repo.git'],
      ['a self-hosted gitlab remote', 'git@gitlab.example.com:group/repo.git'],
      ['a GitHub Enterprise host (no fixed domain -- needs explicit vcs_provider)', 'https://github.acme-corp.net/team/repo.git'],
      ['a file:// remote', 'file:///srv/bare/repo.git'],
      ['a bare local path', '/srv/bare/repo.git'],
      ['a Windows local path', 'C:\\src\\repo'],
      ['a lookalike github host', 'https://github.com.evil.example/Apra-Labs/apra-fleet.git'],
      ['a github lookalike mirror (substring, not a suffix)', 'https://mygithubmirror.attacker.io/Apra-Labs/apra-fleet.git'],
      ['a lookalike azure host', 'https://dev.azure.com.attacker.test/org/project/_git/repo'],
      ['a lookalike bitbucket host', 'git@bitbucket.org.evil.example:team/repo.git'],
      ['a lookalike visualstudio host', 'https://visualstudio.com.evil.example/project/_git/repo'],
      ['garbage', 'not a url at all'],
    ];
    for (const [label, url] of urls) {
      it(`returns null for ${label}`, () => {
        expect(detectVcsProviderFromRemoteUrl(url)).toBeNull();
      });
    }
  });
});

describe('parseRemoteHost', () => {
  it('lowercases the host for every shape', () => {
    expect(parseRemoteHost('https://GitHub.COM/a/b.git')).toBe('github.com');
    expect(parseRemoteHost('GIT@GitHub.COM:a/b.git')).toBe('github.com');
    expect(parseRemoteHost('SSH://git@GitHub.COM/a/b.git')).toBe('github.com');
  });

  it('strips the port from a scheme-d URL', () => {
    expect(parseRemoteHost('ssh://git@ssh.github.com:443/a/b.git')).toBe('ssh.github.com');
  });

  it('returns null for a file:// remote and for unparseable input', () => {
    expect(parseRemoteHost('file:///srv/bare.git')).toBeNull();
    expect(parseRemoteHost('/srv/bare.git')).toBeNull();
    expect(parseRemoteHost('')).toBeNull();
  });
});
