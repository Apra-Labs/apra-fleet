import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isSyncRemoteActive,
  parseActiveSyncRemoteValue,
  resolvesInsideSandbox,
  defaultSandboxPath,
  checkSyncRemoteInert,
  checkNoOutboundCommits,
  parseLeftRightCount,
  checkDoltRemoteAbsent,
  parseDoltRemoteList,
  checkGitOriginNotHazard,
  HAZARD_REMOTE,
} from '../scripts/check-sandbox-sync-remote.mjs';

// Tests for apra-fleet-eft.18.6: scripts/check-sandbox-sync-remote.mjs
// retargeted from "sync.remote is commented out / real remote absent" (the
// retired bd-bootstrap-then-neutralize flow) to "every git+Dolt remote
// resolves INSIDE the sandbox path" (apra-fleet-eft.18.5's structural-
// isolation seed flow: sandbox-local git origin mirror + sandbox-local
// throwaway Dolt file:// remote, wired before any bd command ever runs).
//
// Sandbox-only: this suite never contacts the real fleet-e2e-toy Dolt
// remote. Git repos used here are local-only (no network), created fresh
// under os.tmpdir() and removed afterward.

describe('defaultSandboxPath', () => {
  it('is the parent directory of the repo path (matches "$HOME/toy-repo" -> "$HOME")', () => {
    expect(defaultSandboxPath('/home/sandbox/toy-repo')).toBe(path.dirname('/home/sandbox/toy-repo'));
  });
});

describe('resolvesInsideSandbox', () => {
  const sandbox = '/tmp/apra-fleet-tests/sandbox-root';

  it('is true for a file:// URL resolving to a path inside the sandbox root', () => {
    expect(resolvesInsideSandbox(`file://${sandbox}/.apra-fleet-toy-dolt-remote`, sandbox)).toBe(true);
  });

  it('is true for a plain filesystem path inside the sandbox root', () => {
    expect(resolvesInsideSandbox(`${sandbox}/.apra-fleet-toy-origin.git`, sandbox)).toBe(true);
  });

  it('is true when the value resolves to the sandbox root itself', () => {
    expect(resolvesInsideSandbox(sandbox, sandbox)).toBe(true);
  });

  it('is false for a path outside the sandbox root', () => {
    expect(resolvesInsideSandbox('/tmp/apra-fleet-tests/somewhere-else', sandbox)).toBe(false);
  });

  it('is false for a sibling directory that merely shares a string prefix (no false positive on startsWith)', () => {
    expect(resolvesInsideSandbox(`${sandbox}-evil-twin/payload`, sandbox)).toBe(false);
  });

  it('is false for the real hazard remote URL (git+https scheme, never a filesystem path)', () => {
    expect(resolvesInsideSandbox('git+https://github.com/Apra-Labs/fleet-e2e-toy', sandbox)).toBe(false);
  });

  it('is false for any other non-file URL scheme (e.g. ssh://)', () => {
    expect(resolvesInsideSandbox('ssh://git@example.com/some/repo.git', sandbox)).toBe(false);
  });

  it('is false for an empty value', () => {
    expect(resolvesInsideSandbox('', sandbox)).toBe(false);
  });
});

describe('parseActiveSyncRemoteValue', () => {
  it('extracts the active sync.remote value from config.yaml text', () => {
    const text = ['sync:', '  remote: "file:///tmp/sandbox/.apra-fleet-toy-dolt-remote"', ''].join('\n');
    expect(parseActiveSyncRemoteValue(text)).toBe('file:///tmp/sandbox/.apra-fleet-toy-dolt-remote');
  });

  it('ignores a commented-out remote line', () => {
    const text = ['# sync:', '#   remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"', ''].join('\n');
    expect(parseActiveSyncRemoteValue(text)).toBeNull();
  });

  it('returns null on the pristine fresh-clone config (no remote key at all)', () => {
    expect(parseActiveSyncRemoteValue('# sync.remote disabled -- no Dolt push for this toy project\n')).toBeNull();
  });
});

describe('isSyncRemoteActive: hazard-identity detection (defense in depth)', () => {
  it('is true on an active line referencing the hazard remote', () => {
    const text = ['sync:', '  remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"', ''].join('\n');
    expect(isSyncRemoteActive(text)).toBe(true);
  });

  it('is false once every fleet-e2e-toy reference is commented out', () => {
    const text = ['# sync:', '#   remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"', ''].join('\n');
    expect(isSyncRemoteActive(text)).toBe(false);
  });

  it('references the real hazard remote identity', () => {
    expect(HAZARD_REMOTE).toBe('fleet-e2e-toy');
  });
});

describe('checkSyncRemoteInert: sync.remote resolves-inside-sandbox (apra-fleet-eft.18.6 retarget)', () => {
  let tmpDir: string;
  let sandboxRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sync-remote-test-'));
    sandboxRoot = tmpDir;
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PASSES (vacuously) when config.yaml does not exist -- nothing wired yet', () => {
    const result = checkSyncRemoteInert(path.join(tmpDir, 'does-not-exist.yaml'), sandboxRoot);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('PASSES (vacuously) on the pristine fresh-clone config (no active sync.remote)', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, '# sync.remote disabled -- no Dolt push for this toy project\n', 'utf-8');
    const result = checkSyncRemoteInert(configPath, sandboxRoot);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('PASSES (positive case): active sync.remote is a sandbox-local file:// throwaway remote', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    const doltRemote = path.join(sandboxRoot, '.apra-fleet-toy-dolt-remote');
    fs.writeFileSync(configPath, `sync:\n  remote: "file://${doltRemote}"\n`, 'utf-8');
    const result = checkSyncRemoteInert(configPath, sandboxRoot);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
    expect(result.message).toContain('resolves inside the sandbox path');
  });

  it('FAILS (negative case): active sync.remote points at the real fleet-e2e-toy remote', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, 'sync:\n  remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"\n', 'utf-8');
    const result = checkSyncRemoteInert(configPath, sandboxRoot);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
    expect(result.message).toMatch(/fleet-e2e-toy/);
  });

  it('FAILS when active sync.remote resolves to a path outside the sandbox root (not the real remote either)', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    const outside = path.join(os.tmpdir(), 'some-other-unrelated-dolt-remote');
    fs.writeFileSync(configPath, `sync:\n  remote: "file://${outside}"\n`, 'utf-8');
    const result = checkSyncRemoteInert(configPath, sandboxRoot);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
    expect(result.message).toMatch(/resolves outside the sandbox path/);
  });

  it('defaults sandboxPath to the grandparent of configPath when not given', () => {
    const repoDir = path.join(tmpDir, 'toy-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    const configPath = path.join(repoDir, 'config.yaml');
    const doltRemote = path.join(tmpDir, '.apra-fleet-toy-dolt-remote');
    fs.writeFileSync(configPath, `sync:\n  remote: "file://${doltRemote}"\n`, 'utf-8');
    const result = checkSyncRemoteInert(configPath);
    expect(result.ok).toBe(true);
  });
});

describe('parseLeftRightCount', () => {
  it('parses tab-separated left/right counts', () => {
    expect(parseLeftRightCount('0\t0\n')).toEqual({ left: 0, right: 0 });
    expect(parseLeftRightCount('3\t1')).toEqual({ left: 3, right: 1 });
  });

  it('throws on unexpected output', () => {
    expect(() => parseLeftRightCount('garbage')).toThrow();
  });
});

describe('checkNoOutboundCommits: sandbox-integrity sanity check, unchanged by the eft.18.6 retarget (local-only git, no network)', () => {
  let tmpDir: string;
  let originDir: string;
  let cloneDir: string;

  function git(cwd: string, args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-outbound-test-'));
    originDir = path.join(tmpDir, 'origin.git');
    cloneDir = path.join(tmpDir, 'clone');

    // Bare "remote" repo, entirely local -- never touches the real
    // fleet-e2e-toy remote or the network.
    fs.mkdirSync(originDir);
    git(originDir, ['init', '--bare', '-b', 'main']);

    const seedDir = path.join(tmpDir, 'seed');
    fs.mkdirSync(seedDir);
    git(seedDir, ['init', '-b', 'main']);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'seed\n', 'utf-8');
    git(seedDir, ['add', 'README.md']);
    git(seedDir, ['commit', '-m', 'seed commit']);
    git(seedDir, ['push', originDir, 'main']);

    git(tmpDir, ['clone', originDir, cloneDir]);
    git(cloneDir, ['config', 'user.email', 'test@example.com']);
    git(cloneDir, ['config', 'user.name', 'Test']);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PASSES when the sandbox clone has 0 commits ahead of origin/main', () => {
    const result = checkNoOutboundCommits(cloneDir);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('FAILS when the sandbox clone has an un-pushed local commit ahead of origin/main', () => {
    fs.writeFileSync(path.join(cloneDir, 'new-file.txt'), 'local only\n', 'utf-8');
    git(cloneDir, ['add', 'new-file.txt']);
    git(cloneDir, ['commit', '-m', 'local-only commit (never pushed anywhere)']);

    const result = checkNoOutboundCommits(cloneDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });

  it('surfaces a FAIL result (not a throw) when git rev-list itself errors', () => {
    const result = checkNoOutboundCommits(cloneDir, {
      execFileSync: () => {
        throw new Error('boom');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });
});

describe('parseDoltRemoteList', () => {
  it('parses a JSON array of {name, url} entries', () => {
    expect(parseDoltRemoteList('[{"name":"origin","url":"git+https://github.com/Apra-Labs/fleet-e2e-toy"}]')).toEqual([
      { name: 'origin', url: 'git+https://github.com/Apra-Labs/fleet-e2e-toy' },
    ]);
    expect(parseDoltRemoteList('[]')).toEqual([]);
  });

  it('throws on non-JSON output', () => {
    expect(() => parseDoltRemoteList('not json')).toThrow();
  });

  it('throws when the parsed JSON is not an array', () => {
    expect(() => parseDoltRemoteList('{"name":"origin"}')).toThrow();
  });
});

describe('checkDoltRemoteAbsent: Dolt-level remote resolves-inside-sandbox (apra-fleet-eft.18.6 retarget of apra-fleet-eft.30)', () => {
  // Hermetic: execFileSync is always injected here -- this suite never
  // shells out to a real 'bd' binary or contacts the network.
  const sandbox = '/tmp/apra-fleet-tests/sandbox-root';

  it('PASSES (positive case): the Dolt remote is a sandbox-local throwaway file:// remote', () => {
    const result = checkDoltRemoteAbsent(
      '/fake/repo',
      sandbox,
      { execFileSync: () => JSON.stringify([{ name: 'origin', url: `file://${sandbox}/.apra-fleet-toy-dolt-remote` }]) },
    );
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('FAILS (negative case): the Dolt remote points at the real fleet-e2e-toy remote', () => {
    const result = checkDoltRemoteAbsent(
      '/fake/repo',
      sandbox,
      { execFileSync: () => JSON.stringify([{ name: 'origin', url: 'git+https://github.com/Apra-Labs/fleet-e2e-toy' }]) },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
    expect(result.message).toMatch(/fleet-e2e-toy/);
  });

  it('FAILS when a Dolt remote resolves outside the sandbox path (not the hazard remote either)', () => {
    const result = checkDoltRemoteAbsent(
      '/fake/repo',
      sandbox,
      { execFileSync: () => JSON.stringify([{ name: 'origin', url: '/somewhere/else/entirely' }]) },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
    expect(result.message).toMatch(/resolve outside the sandbox path/);
  });

  it('PASSES when no Dolt remotes are configured yet', () => {
    const result = checkDoltRemoteAbsent('/fake/repo', sandbox, { execFileSync: () => JSON.stringify([]) });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('FAILS when a hazard remote is identified by name rather than url', () => {
    const result = checkDoltRemoteAbsent(
      '/fake/repo',
      sandbox,
      { execFileSync: () => JSON.stringify([{ name: 'fleet-e2e-toy', url: '' }]) },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });

  it('is vacuously OK when "bd dolt remote list" is unavailable (no bd binary / no beads DB in this clone)', () => {
    const result = checkDoltRemoteAbsent('/fake/repo', sandbox, {
      execFileSync: () => {
        throw new Error('command not found: bd');
      },
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('surfaces a FAIL result (not a throw) when the command output cannot be parsed as JSON', () => {
    const result = checkDoltRemoteAbsent('/fake/repo', sandbox, { execFileSync: () => 'not json' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });

  it('defaults sandboxPath to the parent of repoPath when not given', () => {
    const repoPath = path.join(sandbox, 'toy-repo');
    const result = checkDoltRemoteAbsent(repoPath, undefined, {
      execFileSync: () => JSON.stringify([{ name: 'origin', url: `file://${sandbox}/.apra-fleet-toy-dolt-remote` }]),
    });
    expect(result.ok).toBe(true);
  });
});

describe('checkGitOriginNotHazard: git-origin resolves-inside-sandbox (apra-fleet-eft.18.6 retarget of apra-fleet-eft.31)', () => {
  // Hermetic: execFileSync is always injected -- this suite never shells out
  // to a real git binary or touches the network, except in the "REAL local
  // git repo" cases below which use only local, network-free git repos.
  const sandbox = '/tmp/apra-fleet-tests/sandbox-root';

  it('PASSES (positive case): git origin is a sandbox-local bare mirror', () => {
    const result = checkGitOriginNotHazard('/fake/repo', sandbox, {
      execFileSync: () => `file://${sandbox}/.apra-fleet-toy-origin.git\n`,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('FAILS (negative case): git origin points at the real fleet-e2e-toy remote', () => {
    const result = checkGitOriginNotHazard('/fake/repo', sandbox, {
      execFileSync: () => 'git+https://github.com/Apra-Labs/fleet-e2e-toy\n',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
    expect(result.message).toMatch(/fleet-e2e-toy/);
  });

  it('FAILS when git origin resolves to a path outside the sandbox root (not the hazard remote either)', () => {
    const result = checkGitOriginNotHazard('/fake/repo', sandbox, {
      execFileSync: () => 'https://github.com/Apra-Labs/some-other-toy-repo\n',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
    expect(result.message).toMatch(/resolves outside the sandbox path/);
  });

  it('is vacuously OK when there is no git \'origin\' remote to inspect (no git repo / no origin configured)', () => {
    const result = checkGitOriginNotHazard('/fake/repo', sandbox, {
      execFileSync: () => {
        throw new Error("fatal: No such remote 'origin'");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-git-origin-sandbox-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('against a REAL local git repo: PASSES when origin is a sandbox-local bare mirror', () => {
    const mirror = path.join(tmpDir, '.apra-fleet-toy-origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', mirror]);

    const workDir = path.join(tmpDir, 'toy-repo');
    fs.mkdirSync(workDir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: workDir });
    execFileSync('git', ['remote', 'add', 'origin', mirror], { cwd: workDir });

    const result = checkGitOriginNotHazard(workDir, tmpDir);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('against a REAL local git repo: FAILS when origin is a local remote outside the sandbox root', () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-outside-sandbox-'));
    const hazardRemote = path.join(outsideRoot, 'fleet-e2e-toy.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', hazardRemote]);

    const workDir = path.join(tmpDir, 'toy-repo');
    fs.mkdirSync(workDir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: workDir });
    execFileSync('git', ['remote', 'add', 'origin', hazardRemote], { cwd: workDir });

    try {
      const result = checkGitOriginNotHazard(workDir, tmpDir);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^FAIL/);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('defaults sandboxPath to the parent of repoPath when not given', () => {
    const mirror = path.join(tmpDir, '.apra-fleet-toy-origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', mirror]);

    const workDir = path.join(tmpDir, 'toy-repo');
    fs.mkdirSync(workDir);
    execFileSync('git', ['init', '-b', 'main'], { cwd: workDir });
    execFileSync('git', ['remote', 'add', 'origin', mirror], { cwd: workDir });

    const result = checkGitOriginNotHazard(workDir);
    expect(result.ok).toBe(true);
  });
});
