import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  lockPathFor,
  serverInfoPathFor,
  readLockPid,
  readServerPid,
  checkLockState,
  acquireLock,
  markServerStarted,
  authorizeAndReleaseLock,
} from '../scripts/sandbox-lock.mjs';

// Tests for apra-fleet-egc.2: verifies apra-fleet-egc.1 (scripts/sandbox-lock.mjs),
// the mutual-exclusion lock that makes regression-test-playbook.md's smoke-test
// sandbox Setup fail loud ("sandbox busy") instead of a second overlapping run
// silently corrupting the first run's in-progress sandbox.
//
// Two layers:
//   1. In-memory fake-fs unit tests (no real processes / no real filesystem)
//      exercising the busy/stale/owns/refuse decision logic directly, via the
//      `deps` injection point scripts/sandbox-lock.mjs's own header comment
//      calls out as existing specifically for this bead.
//   2. A real-filesystem "two overlapping runs" simulation (still no real
//      processes -- `isAlive` is injected) that plays out the actual
//      Setup(A) -> Setup(B) refused -> Teardown(A) -> Setup(B) succeeds
//      story from the acceptance criteria end to end, plus the plain
//      single-run Setup -> Test -> Teardown path.

/** Minimal in-memory fake filesystem: enough for lockPathFor/serverInfoPathFor
 *  paths (plain string keys), no real disk I/O. */
function makeFakeFs(initialFiles: Record<string, string> = {}, aliveGetter: () => Set<string> = () => new Set()) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    deps: {
      existsSync: (p: string) => files.has(p),
      readFileSync: (p: string) => {
        if (!files.has(p)) {
          const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file, open '${p}'`);
          err.code = 'ENOENT';
          throw err;
        }
        return files.get(p) as string;
      },
      writeFileSync: (p: string, content: string, options?: { flag?: string }) => {
        if (options?.flag === 'wx' && files.has(p)) {
          const err: NodeJS.ErrnoException = new Error(`EEXIST: file already exists, open '${p}'`);
          err.code = 'EEXIST';
          throw err;
        }
        files.set(p, String(content));
      },
      unlinkSync: (p: string) => {
        if (!files.has(p)) {
          const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, unlink '${p}'`);
          err.code = 'ENOENT';
          throw err;
        }
        files.delete(p);
      },
      isAlive: (pid: string) => aliveGetter().has(String(pid)),
    },
  };
}

describe('lockPathFor / serverInfoPathFor: path shape', () => {
  it('lock path is a sibling of the sandbox, not nested inside it (survives a Teardown rm -rf of the sandbox dir)', () => {
    expect(lockPathFor('/tmp/apra-fleet-tests')).toBe('/tmp/apra-fleet-tests.lock');
  });

  it('server info path is under the sandbox\'s own data dir', () => {
    // Explicit empty override: tests/setup.ts sets process.env.APRA_FLEET_DATA_DIR
    // globally for the suite, so exercise the "no override" default-computation
    // branch directly instead of relying on an unset env var.
    expect(serverInfoPathFor('/tmp/apra-fleet-tests', '')).toBe(
      path.join('/tmp/apra-fleet-tests', '.apra-fleet', 'data', 'server.json'),
    );
  });

  it('server info path honors an APRA_FLEET_DATA_DIR override', () => {
    expect(serverInfoPathFor('/tmp/apra-fleet-tests', '/custom/data')).toBe(
      path.join('/custom/data', 'server.json'),
    );
  });
});

describe('readLockPid / readServerPid: raw readers behind checkLockState (fake fs)', () => {
  it('readLockPid returns null when there is no lock file', () => {
    const { deps } = makeFakeFs({});
    expect(readLockPid('/sandbox.lock', deps)).toBeNull();
  });

  it('readLockPid returns the trimmed PID string recorded in the lock file', () => {
    const { deps } = makeFakeFs({ '/sandbox.lock': '  4242  \n' });
    expect(readLockPid('/sandbox.lock', deps)).toBe('4242');
  });

  it('readServerPid returns null when server.json does not exist', () => {
    const { deps } = makeFakeFs({});
    expect(readServerPid('/sandbox', deps)).toBeNull();
  });

  it('readServerPid returns the PID (as a string) from a valid server.json', () => {
    const infoPath = serverInfoPathFor('/sandbox');
    const { deps } = makeFakeFs({ [infoPath]: JSON.stringify({ pid: 4242 }) });
    expect(readServerPid('/sandbox', deps)).toBe('4242');
  });

  it('readServerPid returns null when server.json is unparseable', () => {
    const infoPath = serverInfoPathFor('/sandbox');
    const { deps } = makeFakeFs({ [infoPath]: 'not json' });
    expect(readServerPid('/sandbox', deps)).toBeNull();
  });
});

describe('checkLockState: busy / stale / absent classification (fake fs, injected isAlive)', () => {
  it('reports absent when no lock file exists', () => {
    const { deps } = makeFakeFs({});
    expect(checkLockState('/sandbox.lock', deps)).toEqual({ busy: false, stale: false, pid: null });
  });

  it('reports busy when the recorded PID is alive', () => {
    const { deps } = makeFakeFs({ '/sandbox.lock': '4242' }, () => new Set(['4242']));
    expect(checkLockState('/sandbox.lock', deps)).toEqual({ busy: true, stale: false, pid: '4242' });
  });

  it('reports stale when the recorded PID is not alive', () => {
    const { deps } = makeFakeFs({ '/sandbox.lock': '4242' }, () => new Set());
    expect(checkLockState('/sandbox.lock', deps)).toEqual({ busy: false, stale: true, pid: '4242' });
  });
});

describe('acquireLock: Run A acquires, Run B (concurrent) is refused loudly (fake fs)', () => {
  it('Run A acquires cleanly when no lock exists', () => {
    const { deps, files } = makeFakeFs({});
    const result = acquireLock('/sandbox', '111', deps);
    expect(result.ok).toBe(true);
    expect(files.get('/sandbox.lock')).toBe('111');
  });

  it('Run B, invoked while Run A holds a live lock, is refused with a "sandbox busy" message and does not mutate the lock', () => {
    const alive = new Set(['111']);
    const { deps, files } = makeFakeFs({}, () => alive);

    const runA = acquireLock('/sandbox', '111', deps);
    expect(runA.ok).toBe(true);

    const runB = acquireLock('/sandbox', '222', deps);
    expect(runB.ok).toBe(false);
    expect(runB.message).toMatch(/sandbox busy/);
    expect(runB.message).toContain('111');

    // Run B must NOT have clobbered Run A's lock -- A's PID is still recorded.
    expect(files.get('/sandbox.lock')).toBe('111');
  });

  it('self-heals a stale lock (recorded PID no longer alive) instead of refusing', () => {
    const { deps, files } = makeFakeFs({ '/sandbox.lock': '999' }, () => new Set());
    const result = acquireLock('/sandbox', '333', deps);
    expect(result.ok).toBe(true);
    expect(files.get('/sandbox.lock')).toBe('333');
  });

  it('refuses on a lost exclusive-create race even if checkLockState briefly looked free (EEXIST path)', () => {
    const { deps } = makeFakeFs({});
    // Simulate the race by having writeFileSync always throw EEXIST for 'wx'.
    const raceDeps = {
      ...deps,
      writeFileSync: () => {
        const err: NodeJS.ErrnoException = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      },
    };
    const result = acquireLock('/sandbox', '111', raceDeps);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/sandbox busy/);
    expect(result.message).toMatch(/lost the race/);
  });
});

describe('markServerStarted: hand-off from Setup-shell PID to sandbox server PID (fake fs)', () => {
  it('refuses when there is no existing lock to hand off (acquireLock must run first)', () => {
    const { deps } = makeFakeFs({});
    const result = markServerStarted('/sandbox', deps);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no lock/);
  });

  it('refuses when the sandbox has no server.json PID yet', () => {
    const { deps } = makeFakeFs({ '/sandbox.lock': '111' });
    const result = markServerStarted('/sandbox', deps);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no server\.json PID/);
  });

  it('re-points the lock at the sandbox\'s own server PID once server.json exists', () => {
    const infoPath = serverInfoPathFor('/sandbox');
    const { deps, files } = makeFakeFs({
      '/sandbox.lock': '111',
      [infoPath]: JSON.stringify({ pid: 555 }),
    });
    const result = markServerStarted('/sandbox', deps);
    expect(result.ok).toBe(true);
    expect(files.get('/sandbox.lock')).toBe('555');
  });
});

describe('authorizeAndReleaseLock: Teardown authorization (fake fs)', () => {
  it('is safe (ok) when there is no lock at all', () => {
    const { deps } = makeFakeFs({});
    const result = authorizeAndReleaseLock('/sandbox', deps);
    expect(result.ok).toBe(true);
  });

  it('is safe and releases when the lock PID is stale (abandoned prior run, self-heal)', () => {
    const { deps, files } = makeFakeFs({ '/sandbox.lock': '999' }, () => new Set());
    const result = authorizeAndReleaseLock('/sandbox', deps);
    expect(result.ok).toBe(true);
    expect(files.has('/sandbox.lock')).toBe(false);
  });

  it('is safe and releases when the live lock PID matches this sandbox\'s own current server PID (genuinely our own run)', () => {
    const infoPath = serverInfoPathFor('/sandbox');
    const { deps, files } = makeFakeFs(
      { '/sandbox.lock': '555', [infoPath]: JSON.stringify({ pid: 555 }) },
      () => new Set(['555']),
    );
    const result = authorizeAndReleaseLock('/sandbox', deps);
    expect(result.ok).toBe(true);
    expect(files.has('/sandbox.lock')).toBe(false);
  });

  it('REFUSES to release when a live lock PID does not match this sandbox\'s own server PID (another run currently owns it)', () => {
    const infoPath = serverInfoPathFor('/sandbox');
    const { deps, files } = makeFakeFs(
      { '/sandbox.lock': '111', [infoPath]: JSON.stringify({ pid: 555 }) },
      () => new Set(['111']),
    );
    const result = authorizeAndReleaseLock('/sandbox', deps);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refusing to remove sandbox/);
    // Lock must survive -- Teardown must not have unlinked it.
    expect(files.has('/sandbox.lock')).toBe(true);
    expect(files.get('/sandbox.lock')).toBe('111');
  });
});

describe('End-to-end simulation (real filesystem, injected isAlive): concurrent Setup/Teardown story from the acceptance criteria', () => {
  // Real tmp directory + real fs calls (default deps minus isAlive), so this
  // layer also exercises the real fs.writeFileSync 'wx' exclusive-create path
  // and real fs.unlinkSync -- only process liveness is faked, since we are
  // not going to fork real child processes to prove PID liveness semantics.
  function realFsDepsWithFakeAlive(aliveSet: Set<string>) {
    return {
      existsSync: (p: string) => fs.existsSync(p),
      readFileSync: (p: string) => fs.readFileSync(p, 'utf-8'),
      writeFileSync: (p: string, content: string, options?: { flag?: string }) =>
        fs.writeFileSync(p, content, options as fs.WriteFileOptions),
      unlinkSync: (p: string) => fs.unlinkSync(p),
      isAlive: (pid: string) => aliveSet.has(String(pid)),
    };
  }

  it('Run A acquires and starts Setup; Run B invoked while A holds the lock is refused and does NOT touch A\'s sandbox; after A\'s Teardown releases the lock, a subsequent run acquires cleanly; a single normal Setup->Test->Teardown pass also succeeds end to end', () => {
    // tests/setup.ts sets process.env.APRA_FLEET_DATA_DIR globally for the
    // whole suite (so unrelated tests don't share/corrupt one registry.json).
    // The real playbook never sets this var, so serverInfoPathFor() falls
    // back to '<sandbox>/.apra-fleet/data/server.json' -- unset it for the
    // duration of this test so the simulation matches production behavior
    // (server.json lives INSIDE the sandbox being locked), then restore it.
    const savedDataDir = process.env.APRA_FLEET_DATA_DIR;
    delete process.env.APRA_FLEET_DATA_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sandbox-lock-test-'));
    try {
      const sandboxPath = path.join(tmpDir, '.apra-fleet-tests');
      fs.mkdirSync(sandboxPath, { recursive: true });
      // A sentinel file standing in for "A's in-progress sandbox contents" --
      // if Run B ever actually mutated/removed the sandbox, this would be gone.
      const sentinelPath = path.join(sandboxPath, 'sentinel.txt');
      fs.writeFileSync(sentinelPath, 'run-A-owns-this\n', 'utf-8');

      const aliveSet = new Set<string>(['1001']); // Run A's Setup-shell PID is alive
      const deps = realFsDepsWithFakeAlive(aliveSet);

      // --- Run A: ## Setup step 1 (acquire) ---
      const acquireA = acquireLock(sandboxPath, '1001', deps);
      expect(acquireA.ok).toBe(true);

      // --- Run B invoked concurrently, while A still holds the lock ---
      const acquireB = acquireLock(sandboxPath, '2002', deps);
      expect(acquireB.ok).toBe(false);
      expect(acquireB.message).toMatch(/sandbox busy/);
      // Run B must exit refused without ever touching A's sandbox contents.
      expect(fs.existsSync(sentinelPath)).toBe(true);
      expect(fs.readFileSync(sentinelPath, 'utf-8')).toBe('run-A-owns-this\n');

      // --- Run A: ## Setup step 2 -- server starts, hand off lock to server PID ---
      const dataDir = path.join(sandboxPath, '.apra-fleet', 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'server.json'), JSON.stringify({ pid: 3003 }), 'utf-8');
      aliveSet.add('3003');
      const markA = markServerStarted(sandboxPath, deps);
      expect(markA.ok).toBe(true);

      // Run A's Setup-shell PID (1001) can now "exit" -- no longer alive --
      // while the server PID (3003) is what actually protects the sandbox
      // through '## Test scenario'.
      aliveSet.delete('1001');

      // A second concurrent attempt during '## Test scenario' is still refused,
      // proving the hand-off covered the window with no gap.
      const acquireDuringTest = acquireLock(sandboxPath, '4004', deps);
      expect(acquireDuringTest.ok).toBe(false);
      expect(acquireDuringTest.message).toMatch(/sandbox busy/);

      // --- Run A: ## Teardown -- authorize + release, then the real rm -rf ---
      const teardownA = authorizeAndReleaseLock(sandboxPath, deps);
      expect(teardownA.ok).toBe(true);
      fs.rmSync(sandboxPath, { recursive: true, force: true });
      aliveSet.delete('3003');

      expect(fs.existsSync(lockPathFor(sandboxPath))).toBe(false);

      // --- A subsequent run, after A's Teardown released the lock, acquires cleanly ---
      fs.mkdirSync(sandboxPath, { recursive: true });
      const acquireC = acquireLock(sandboxPath, '5005', deps);
      expect(acquireC.ok).toBe(true);
      authorizeAndReleaseLock(sandboxPath, deps); // clean up for the next case
      fs.rmSync(sandboxPath, { recursive: true, force: true });

      // --- A single normal Setup -> Test -> Teardown pass, end to end, no contention ---
      fs.mkdirSync(sandboxPath, { recursive: true });
      const setup = acquireLock(sandboxPath, '6006', deps);
      expect(setup.ok).toBe(true);
      aliveSet.add('6006');

      const soloDataDir = path.join(sandboxPath, '.apra-fleet', 'data');
      fs.mkdirSync(soloDataDir, { recursive: true });
      fs.writeFileSync(path.join(soloDataDir, 'server.json'), JSON.stringify({ pid: 7007 }), 'utf-8');
      aliveSet.add('7007');
      expect(markServerStarted(sandboxPath, deps).ok).toBe(true);
      aliveSet.delete('6006');

      // '## Test scenario' runs here (no-op in this simulation).

      aliveSet.delete('7007');
      const teardown = authorizeAndReleaseLock(sandboxPath, deps);
      expect(teardown.ok).toBe(true);
      fs.rmSync(sandboxPath, { recursive: true, force: true });
      expect(fs.existsSync(lockPathFor(sandboxPath))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (savedDataDir === undefined) {
        delete process.env.APRA_FLEET_DATA_DIR;
      } else {
        process.env.APRA_FLEET_DATA_DIR = savedDataDir;
      }
    }
  });
});

describe('CLI exit-code contract (used directly by regression-test-playbook.md)', () => {
  function runCli(args: string[], cwd?: string): { status: number | null; stderr: string } {
    const result = require('node:child_process').spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'sandbox-lock.mjs'), ...args],
      { cwd, encoding: 'utf-8' },
    );
    return { status: result.status, stderr: result.stderr };
  }

  it('acquire exits 0 and prints an "acquired" message when the sandbox is free', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sandbox-lock-cli-'));
    try {
      const sandboxPath = path.join(tmpDir, 'sandbox');
      const result = runCli(['acquire', sandboxPath, String(process.pid)]);
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/acquired/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('acquire exits non-zero with a "sandbox busy" message when a live PID already holds the lock', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sandbox-lock-cli-'));
    try {
      const sandboxPath = path.join(tmpDir, 'sandbox');
      // Use this test process's own PID as the "live" holder -- it is
      // guaranteed to be alive for the duration of this test.
      const first = runCli(['acquire', sandboxPath, String(process.pid)]);
      expect(first.status).toBe(0);

      const second = runCli(['acquire', sandboxPath, '999999']);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toMatch(/sandbox busy/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('release exits 0 when there is no lock (nothing to protect)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sandbox-lock-cli-'));
    try {
      const sandboxPath = path.join(tmpDir, 'sandbox');
      const result = runCli(['release', sandboxPath]);
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
