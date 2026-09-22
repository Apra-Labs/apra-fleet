import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error -- plain .mjs helper, no type declarations
import { execBdSync } from '../scripts/lib/exec-bd.mjs';
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
//
// my-beads-db-27m.25: on a dev host running this suite from inside a real
// beads workspace (e.g. via the bd-managed sprint tooling), BEADS_DIR is set
// in the ambient environment and points at THAT workspace's own database --
// not this file's scratch '.beads/embeddeddolt' fixture below. Every 'bd'
// child process this file spawns must NOT inherit it: bd resolves BEADS_DIR
// before it looks at cwd, so an inherited BEADS_DIR makes the real bd child
// query the unrelated ambient database instead of the fixture, producing a
// false result.ok===false. Mirrors the BD_CHILD_ENV pattern already proven in
// tests/2cc-win-bd-invocation-integ.test.ts (apra-fleet-2cc.3 / my-beads-db-27m.14).
const BD_CHILD_ENV: NodeJS.ProcessEnv = { ...process.env };
delete BD_CHILD_ENV.BEADS_DIR;

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

  it('is true for a git+file:// compound scheme URL resolving to a path inside the sandbox root (apra-fleet-eft.62.1)', () => {
    expect(resolvesInsideSandbox(`git+file://${sandbox}/.apra-fleet-toy-dolt-remote`, sandbox)).toBe(true);
  });

  it('is false for a git+file:// compound scheme URL resolving to a path outside the sandbox root', () => {
    expect(resolvesInsideSandbox('git+file:///tmp/apra-fleet-tests/somewhere-else', sandbox)).toBe(false);
  });

  it('is true for other +file:// compound schemes (e.g. hg+file://) resolving inside the sandbox root', () => {
    expect(resolvesInsideSandbox(`hg+file://${sandbox}/.some-remote`, sandbox)).toBe(true);
  });

  // Windows-only: file:// URLs with a drive letter, in the three forms
  // actually observed in practice (apra-fleet-xuo.9 / xuo.9.1 / xuo.9.2).
  // Guarded to win32 because fileURLToPath() requires an actual drive
  // letter to parse these and would throw (or mis-resolve, pre-fix) on
  // POSIX hosts.
  //
  // The fixture path is derived from os.tmpdir() (never a hardcoded
  // developer home dir like 'C:/Users/<name>/...') so this suite is
  // deterministic and portable across machines/CI runners -- apra-fleet-
  // xuo.9.2. resolvesInsideSandbox() is a pure string/path function, so
  // none of these directories need to actually exist on disk.
  const winDescribe = os.platform() === 'win32' ? describe : describe.skip;
  winDescribe('Windows drive-letter and MSYS file:// forms (apra-fleet-xuo.9.1 / xuo.9.2)', () => {
    const winSandbox = `${os.tmpdir().replace(/\\/g, '/').replace(/\/$/, '')}/.apra-fleet-tests`;
    const driveLetter = /^([A-Za-z]):/.exec(winSandbox)?.[1] ?? 'C';
    // 'C:/Users/...' -> '/c/Users/...' (MSYS/git-bash single-letter-segment form)
    const msysSandbox = `/${driveLetter.toLowerCase()}${winSandbox.slice(2)}`;
    // Parent of the sandbox root -- genuinely outside it, without hardcoding
    // any particular machine's directory layout.
    const outsideDrivePath = path.dirname(winSandbox);

    it('is true for a 3-slash drive file:// URL (file:///C:/...) inside the sandbox root', () => {
      expect(
        resolvesInsideSandbox(`file:///${winSandbox}/.apra-fleet-toy-dolt-remote`, winSandbox),
      ).toBe(true);
    });

    it('is true for an MSYS/git-bash single-letter-segment form (file:///c/...) inside the sandbox root', () => {
      expect(
        resolvesInsideSandbox(`file://${msysSandbox}/.apra-fleet-toy-origin.git`, winSandbox),
      ).toBe(true);
    });

    it('is true for the 2-slash drive form emitted by "bd dolt remote list --json" (file://C:/...) inside the sandbox root', () => {
      expect(
        resolvesInsideSandbox(`file://${winSandbox}/.apra-fleet-toy-dolt-remote`, winSandbox),
      ).toBe(true);
    });

    it('is false for a genuinely outside drive-letter file:// path (safety guard not loosened)', () => {
      expect(resolvesInsideSandbox(`file:///${outsideDrivePath}`, winSandbox)).toBe(false);
    });

    it('is false for a sibling directory that merely shares a string prefix, in drive-letter file:// form (no substring false-PASS)', () => {
      expect(resolvesInsideSandbox(`file:///${winSandbox}-other/repo`, winSandbox)).toBe(false);
    });

    it('is false for a sibling directory that merely shares a string prefix, in plain path form (no substring false-PASS)', () => {
      expect(resolvesInsideSandbox(`${winSandbox}-other/repo`, winSandbox)).toBe(false);
    });
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

  // apra-fleet-b4g.3: `bd dolt remote list --json` prints the literal `null`
  // (not `[]`) when no Dolt remotes are configured -- this must be treated
  // as "no remotes" rather than an "not an array" parse error.
  it('treats a literal null (including whitespace-padded) as an empty list', () => {
    expect(parseDoltRemoteList('null')).toEqual([]);
    expect(parseDoltRemoteList('null\n')).toEqual([]);
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

  // apra-fleet-xuo.8.1: exercises the no-injection branch (no deps.execFileSync)
  // against a real .beads/embeddeddolt directory to ensure the predicate recognizes
  // all known database layouts and does not silent-return "nothing wired yet" for
  // directories that actually contain a database.
  it('recognizes .beads/embeddeddolt as a database layout and invokes bd without short-circuiting', async () => {
    let tmpDir: string | null = null;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-embeddeddolt-check-'));
      const repoPath = path.join(tmpDir, 'toy-repo');
      const beadsDir = path.join(repoPath, '.beads');
      fs.mkdirSync(beadsDir, { recursive: true });
      // Create the embeddeddolt directory layout that bd init produces.
      fs.mkdirSync(path.join(beadsDir, 'embeddeddolt'));
      // Also create a minimal config.yaml so the repo looks initialized.
      fs.writeFileSync(path.join(beadsDir, 'config.yaml'), 'sync:\n  remote: file://sandbox-local\n');

      // my-beads-db-27m.25: strip the ambient BEADS_DIR from process.env for the
      // duration of this call, rather than injecting deps.execFileSync.
      // checkDoltRemoteAbsent's own filesystem quick-check (scripts/check-
      // sandbox-sync-remote.mjs:427) is gated on `if (!deps.execFileSync)` --
      // any deps injection here, even one that still shells out for real, would
      // skip that quick-check branch entirely and make this test's key
      // assertion below unfalsifiable. Passing no deps keeps that branch (the
      // thing under test) running, while the real 'bd' child it spawns still
      // does not inherit BEADS_DIR because it is deleted from process.env below.
      const savedBeadsDir = process.env.BEADS_DIR;
      delete process.env.BEADS_DIR;
      let result;
      try {
        result = checkDoltRemoteAbsent(repoPath, tmpDir);
      } finally {
        if (savedBeadsDir !== undefined) {
          process.env.BEADS_DIR = savedBeadsDir;
        }
      }
      expect(result.ok).toBe(true);
      // The key assertion: the message must NOT be the "no Dolt database initialized"
      // message that the old code would have returned when it failed to recognize
      // embeddeddolt. Instead, it should report either an actual Dolt remote status
      // or an error from trying to run bd.
      expect(result.message).not.toMatch(/no Dolt database initialized/);
      // apra-fleet-b4g.3: the loose `/Dolt-level remotes|unavailable/` assertion
      // this used to have let the test pass vacuously on a machine without `bd`
      // on PATH (the "unavailable" fallback message satisfies it without ever
      // reaching parseDoltRemoteList). Detect whether `bd` is actually reachable
      // and assert the specific outcome for that environment, so a real `bd`
      // installation always exercises the parser this test is meant to cover.
      // The probe MUST use the same execBdSync helper as the code under test.
      // A bare execFileSync('bd', ...) throws on Windows -- npm installs `bd` as
      // a .cmd shim, which execFileSync cannot spawn without a shell -- so this
      // computed bdAvailable=false on windows-latest while checkDoltRemoteAbsent
      // (which routes through execBdSync's resolved bin/bd.js) DID reach bd,
      // failing as: expected 'OK: Dolt-level remotes in ...' to match /unavailable/.
      // execBdSync is also the injection-safe path -- see scripts/lib/exec-bd.mjs.
      let bdAvailable = true;
      try {
        execBdSync(['--version'], { stdio: 'ignore', env: BD_CHILD_ENV });
      } catch {
        bdAvailable = false;
      }
      if (bdAvailable) {
        expect(result.message).toMatch(/Dolt-level remotes/);
      } else {
        expect(result.message).toMatch(/unavailable/);
      }

    } finally {
      // Clean up: on Windows, file locks may persist after the function call --
      // this test spawns a REAL `bd` (no execFileSync injected), and bd's own
      // dolt process can take longer than a few hundred ms to release its
      // handle on tmpDir under CI load (observed live: a loaded windows-latest
      // runner still held the lock past a 10x50ms=500ms budget -- see
      // EBUSY_RETRY_DELAY_MS=200 in src/cli/workflow-assets.ts for the same
      // class of Windows EBUSY retry elsewhere in this codebase). 30x200ms=6s
      // gives real headroom without slowing the common (already-released) case,
      // since the loop exits on the first successful attempt.
      if (tmpDir) {
        const cleanupAttempts = 30;
        for (let i = 0; i < cleanupAttempts; i++) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            break; // Success
          } catch (err) {
            if (i === cleanupAttempts - 1) throw err;
            // Small delay before retry to allow file handles to be released
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      }
    }
  }, 60000); // Increase timeout for this test due to retry logic
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
