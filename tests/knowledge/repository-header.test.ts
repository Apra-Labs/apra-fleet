import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  normaliseRepositoryRemote,
  isValidRepositoryValue,
  headCommitReader,
  resolveRepositoryIdentity,
} from '../../src/services/knowledge/repository-header.js';

// Obviously fake credential material: it must never survive normalisation.
const FAKE_SECRET = 'NOT_A_REAL_KEY';

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-header-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

describe('normaliseRepositoryRemote', () => {
  it.each([
    ['https://github.com/Apra-Labs/apra-fleet.git', 'github.com/Apra-Labs/apra-fleet'],
    ['https://github.com/Apra-Labs/apra-fleet', 'github.com/Apra-Labs/apra-fleet'],
    ['https://github.com/Apra-Labs/apra-fleet/', 'github.com/Apra-Labs/apra-fleet'],
    ['https://github.com/Apra-Labs/apra-fleet.git/', 'github.com/Apra-Labs/apra-fleet'],
    ['HTTPS://GitHub.COM/Apra-Labs/apra-fleet.git', 'github.com/Apra-Labs/apra-fleet'],
    ['  git@github.com:Apra-Labs/apra-fleet.git\n', 'github.com/Apra-Labs/apra-fleet'],
    ['ssh://git@github.com/Apra-Labs/apra-fleet.git', 'github.com/Apra-Labs/apra-fleet'],
    ['ssh://git@github.com:22/Apra-Labs/apra-fleet', 'github.com/Apra-Labs/apra-fleet'],
    ['git://github.com/Apra-Labs/apra-fleet.git', 'github.com/Apra-Labs/apra-fleet'],
    ['https://gitlab.example.com:8443/group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
  ])('%s -> %s', (input, expected) => {
    expect(normaliseRepositoryRemote(input)).toBe(expected);
  });

  it('maps every spelling of one GitHub repository to the same value', () => {
    const spellings = [
      'https://github.com/o/r.git',
      `https://user:${FAKE_SECRET}@github.com/o/r.git`,
      'git@github.com:o/r.git',
      'ssh://git@github.com/o/r',
      'github.com:o/r',
    ];
    expect(new Set(spellings.map(normaliseRepositoryRemote))).toEqual(new Set(['github.com/o/r']));
  });

  it('strips user info and credentials, query and fragment', () => {
    const cases = [
      `https://user:${FAKE_SECRET}@github.com/o/r.git`,
      `https://${FAKE_SECRET}@github.com/o/r.git`,
      `https://x-access-token:${FAKE_SECRET}@github.com/o/r.git`,
      `https://u:p@ss:${FAKE_SECRET}@github.com/o/r.git`,
      `https://github.com/o/r.git?access_token=${FAKE_SECRET}`,
      `https://github.com/o/r.git#${FAKE_SECRET}`,
      `user:${FAKE_SECRET}@github.com:o/r.git`,
    ];
    for (const input of cases) {
      const out = normaliseRepositoryRemote(input);
      expect(out, input).toBe('github.com/o/r');
      expect(out).not.toContain(FAKE_SECRET);
      expect(out).not.toContain('@');
    }
  });

  describe('Azure DevOps folds to dev.azure.com/<org>/<project>/_git/<repo>', () => {
    it.each([
      ['https://MyOrg@dev.azure.com/MyOrg/My%20Project/_git/MyRepo', 'dev.azure.com/myorg/My%20Project/_git/MyRepo'],
      [`https://MyOrg:${FAKE_SECRET}@dev.azure.com/MyOrg/Proj/_git/Repo`, 'dev.azure.com/myorg/Proj/_git/Repo'],
      ['https://dev.azure.com/MyOrg/Proj/_git/Repo', 'dev.azure.com/myorg/Proj/_git/Repo'],
      ['https://MyOrg.visualstudio.com/Proj/_git/Repo', 'dev.azure.com/myorg/Proj/_git/Repo'],
      ['https://myorg.visualstudio.com/DefaultCollection/Proj/_git/Repo', 'dev.azure.com/myorg/Proj/_git/Repo'],
      ['git@ssh.dev.azure.com:v3/MyOrg/Proj/Repo', 'dev.azure.com/myorg/Proj/_git/Repo'],
      ['ssh://git@ssh.dev.azure.com/v3/MyOrg/Proj/Repo', 'dev.azure.com/myorg/Proj/_git/Repo'],
      ['myorg@vs-ssh.visualstudio.com:v3/myorg/Proj/Repo', 'dev.azure.com/myorg/Proj/_git/Repo'],
    ])('%s -> %s', (input, expected) => {
      expect(normaliseRepositoryRemote(input)).toBe(expected);
    });
  });

  it('percent-encodes spaces and non-ASCII so the value is printable ASCII', () => {
    expect(normaliseRepositoryRemote('https://dev.azure.com/org/My Project/_git/Rëpo'))
      .toBe('dev.azure.com/org/My%20Project/_git/R%C3%ABpo');
  });

  it.each([
    [''],
    ['   '],
    ['/srv/git/repo.git'],
    ['./relative/repo'],
    ['C:/repos/thing'],
    ['C:\\repos\\thing'],
    ['file:///srv/git/repo.git'],
    ['ftp://example.com/o/r'],
    ['https://github.com'],
    ['https://github.com/'],
    [`https://github.com/${'a'.repeat(600)}`],
    // Authorities that do not parse to a hostname: what is left could carry
    // credentials or tokens, so no header at all.
    ['https://user:pa/ss@github.com/org/repo.git'],
    ['https://github.com?access_token=tok/org/repo'],
    ['https://host:abc/o/r'],
    ['https://github.com\t/o/r'],
  ])('returns undefined for %j (not a network remote, or not a valid header)', (input) => {
    expect(normaliseRepositoryRemote(input)).toBeUndefined();
  });

  it('only ever produces values the receiving server accepts', () => {
    for (const input of [
      'https://github.com/o/r.git', 'git@github.com:o/r.git', 'https://MyOrg@dev.azure.com/MyOrg/P/_git/R',
      'https://dev.azure.com/org/My Project/_git/Rëpo',
    ]) {
      const out = normaliseRepositoryRemote(input)!;
      expect(isValidRepositoryValue(out)).toBe(true);
      expect(out).not.toContain('://');
    }
  });
});

describe('isValidRepositoryValue (mirrors the receiving server)', () => {
  it('refuses a scheme, user info before the host, spaces and over-long values', () => {
    expect(isValidRepositoryValue('github.com/o/r')).toBe(true);
    expect(isValidRepositoryValue('github.com/o/r@v1')).toBe(true);
    expect(isValidRepositoryValue('https://github.com/o/r')).toBe(false);
    expect(isValidRepositoryValue(`u:${FAKE_SECRET}@github.com/o/r`)).toBe(false);
    expect(isValidRepositoryValue('github.com/o/my repo')).toBe(false);
    expect(isValidRepositoryValue(`github.com/${'a'.repeat(512)}`)).toBe(false);
    expect(isValidRepositoryValue('')).toBe(false);
  });
});

describe('headCommitReader / resolveRepositoryIdentity', () => {
  it('reads the HEAD sha of a local repo and caches it for the TTL', () => {
    const dir = makeDir();
    git(dir, ['init', '-q', '.']);
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'one']);
    const first = git(dir, ['rev-parse', 'HEAD']);

    const read = headCommitReader(dir, 60_000);
    expect(read()).toBe(first);

    git(dir, ['commit', '-q', '--allow-empty', '-m', 'two']);
    // Still inside the TTL: the cached sha, git is not re-run.
    expect(read()).toBe(first);
    // A zero TTL re-reads every call.
    expect(headCommitReader(dir, 0)()).toBe(git(dir, ['rev-parse', 'HEAD']));
  });

  it('returns undefined, never throws, for an unborn HEAD or a non-repo folder', () => {
    const unborn = makeDir();
    git(unborn, ['init', '-q', '.']);
    expect(headCommitReader(unborn, 0)()).toBeUndefined();
    expect(headCommitReader(makeDir(), 0)()).toBeUndefined();
    expect(headCommitReader(path.join(makeDir(), 'missing'), 0)()).toBeUndefined();
  });

  it('a local folder: remote from its origin, commit from its HEAD', () => {
    const dir = makeDir();
    git(dir, ['init', '-q', '.']);
    git(dir, ['remote', 'add', 'origin', `https://user:${FAKE_SECRET}@github.com/o/local-repo.git`]);
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'one']);

    const identity = resolveRepositoryIdentity(dir);
    expect(identity?.remote).toBe('github.com/o/local-repo');
    expect(identity?.commitOf?.()).toBe(git(dir, ['rev-parse', 'HEAD']));
  });

  it('a remote member (remoteUrl given): the remote only, no commit reader', () => {
    const identity = resolveRepositoryIdentity('/on/another/host', 'git@github.com:o/remote-repo.git');
    expect(identity).toEqual({ remote: 'github.com/o/remote-repo' });
  });

  it('no anchor remote: no identity', () => {
    const dir = makeDir();
    git(dir, ['init', '-q', '.']);
    expect(resolveRepositoryIdentity(dir)).toBeUndefined();
    expect(resolveRepositoryIdentity(makeDir())).toBeUndefined();
  });
});
