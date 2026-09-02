import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error -- plain .mjs helper, no type declarations
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

// Tests for apra-fleet-egc.2 (verifies apra-fleet-egc.1's
// scripts/sandbox-lock.mjs): the regression-test-playbook.md smoke-test
// sandbox lives at a fixed path with no mutual exclusion of its own; the
// lock in scripts/sandbox-lock.mjs is what makes a second concurrent run
// fail loud ("sandbox busy") instead of destroying the first run's
// in-progress sandbox.
//
// Exercised two ways:
//  - an in-memory fake fs (deps injection, matching
//    scripts/check-sandbox-sync-remote.mjs's convention) for the
//    concurrent-refusal and stale-reclaim decision logic, so no real
//    processes/filesystem are needed to simulate "another live run".
//  - a real os.tmpdir() sandbox for the single normal Setup -> Test ->
//    Teardown pass, so the lock file's real on-disk lifecycle is proven,
//    not just the decision function's return value.

function makeMemDeps() {
  const files = new Map<string, string>();
  const alive = new Set<string>();
  return {
    files,
    alive,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      if (!files.has(p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return files.get(p) as string;
    },
    writeFileSync: (p: string, content: string, options?: { flag?: string }) => {
      if (options && options.flag === 'wx' && files.has(p)) {
        throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' });
      }
      files.set(p, String(content));
    },
    unlinkSync: (p: string) => {
      if (!files.has(p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      files.delete(p);
    },
    isAlive: (pid: string | number) => alive.has(String(pid)),
  };
}

const sandbox = '/tmp/apra-fleet-tests-fake-sandbox';

describe('concurrent Setup: run B refused while run A holds the lock', () => {
  it('run A acquires the lock cleanly', () => {
    const deps = makeMemDeps();
    deps.alive.add('1111');
    const resA = acquireLock(sandbox, '1111', deps);
    expect(resA.ok).toBe(true);
    expect(readLockPid(lockPathFor(sandbox), deps)).toBe('1111');
  });

  it("run B, invoked while A's PID is still live, exits non-zero (ok:false) with a clear 'sandbox busy' message", () => {
    const deps = makeMemDeps();
    deps.alive.add('1111');
    const resA = acquireLock(sandbox, '1111', deps);
    expect(resA.ok).toBe(true);

    const resB = acquireLock(sandbox, '2222', deps);
    expect(resB.ok).toBe(false);
    expect(resB.message).toMatch(/sandbox busy/i);
  });

  it("does NOT mutate A's lock -- it still names A's PID after B's refused attempt", () => {
    const deps = makeMemDeps();
    deps.alive.add('1111');
    acquireLock(sandbox, '1111', deps);
    acquireLock(sandbox, '2222', deps);

    expect(readLockPid(lockPathFor(sandbox), deps)).toBe('1111');
    expect(checkLockState(lockPathFor(sandbox), deps)).toEqual({ busy: true, stale: false, pid: '1111' });
  });

  it("a live-owned lock, checked directly, reports busy so Teardown-time authorization also refuses another live owner's sandbox", () => {
    const deps = makeMemDeps();
    // A acquires and its own server comes up under a different long-lived PID.
    deps.alive.add('1111'); // A's setup shell pid
    acquireLock(sandbox, '1111', deps);
    deps.alive.add('9999'); // A's server pid
    deps.files.set(serverInfoPathFor(sandbox), JSON.stringify({ pid: '9999' }));
    const marked = markServerStarted(sandbox, deps);
    expect(marked.ok).toBe(true);
    expect(readLockPid(lockPathFor(sandbox), deps)).toBe('9999');

    // Some other live process's PID (not A's server, and not recorded as
    // this sandbox's server) attempting Teardown must be refused, not
    // silently allowed to rm -rf A's still-live sandbox.
    deps.alive.add('7777');
    deps.files.set(serverInfoPathFor(sandbox), JSON.stringify({ pid: '7777' }));
    const teardown = authorizeAndReleaseLock(sandbox, deps);
    expect(teardown.ok).toBe(false);
    expect(teardown.message).toMatch(/refusing to remove sandbox/i);
    // Lock file survives the refusal -- A's sandbox is not torn down.
    expect(readLockPid(lockPathFor(sandbox), deps)).toBe('9999');
  });
});

describe('after A completes Teardown, the lock is released and a subsequent run acquires cleanly', () => {
  it('authorizeAndReleaseLock releases the lock when the recorded PID matches the sandbox\'s own current server PID', () => {
    const deps = makeMemDeps();
    deps.alive.add('1111');
    acquireLock(sandbox, '1111', deps);
    deps.files.set(serverInfoPathFor(sandbox), JSON.stringify({ pid: '1111' }));
    const marked = markServerStarted(sandbox, deps);
    expect(marked.ok).toBe(true);

    const teardown = authorizeAndReleaseLock(sandbox, deps);
    expect(teardown.ok).toBe(true);
    expect(readLockPid(lockPathFor(sandbox), deps)).toBeNull();
  });

  it('a new run acquires the now-free lock cleanly', () => {
    const deps = makeMemDeps();
    deps.alive.add('1111');
    acquireLock(sandbox, '1111', deps);
    deps.files.set(serverInfoPathFor(sandbox), JSON.stringify({ pid: '1111' }));
    markServerStarted(sandbox, deps);
    const teardown = authorizeAndReleaseLock(sandbox, deps);
    expect(teardown.ok).toBe(true);

    deps.alive.add('3333');
    const resC = acquireLock(sandbox, '3333', deps);
    expect(resC.ok).toBe(true);
    expect(readLockPid(lockPathFor(sandbox), deps)).toBe('3333');
  });

  it('self-heals a stale lock (owning PID no longer alive) instead of staying wedged forever', () => {
    const deps = makeMemDeps();
    // Crashed prior run: lock recorded but PID is dead (never added to alive set).
    deps.files.set(lockPathFor(sandbox), '404404');
    expect(checkLockState(lockPathFor(sandbox), deps)).toEqual({ busy: false, stale: true, pid: '404404' });

    deps.alive.add('5555');
    const res = acquireLock(sandbox, '5555', deps);
    expect(res.ok).toBe(true);
    expect(readLockPid(lockPathFor(sandbox), deps)).toBe('5555');
  });
});

describe('single normal Setup -> Test -> Teardown pass', () => {
  let realSandbox: string;

  beforeEach(() => {
    realSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sandbox-lock-test-'));
  });

  afterEach(() => {
    fs.rmSync(realSandbox, { recursive: true, force: true });
    const lock = lockPathFor(realSandbox);
    if (fs.existsSync(lock)) fs.rmSync(lock, { force: true });
  });

  it('still succeeds end to end (acquire -> mark-server-started -> release) unchanged, using the real filesystem', () => {
    const deps = {
      existsSync: (p: string) => fs.existsSync(p),
      readFileSync: (p: string) => fs.readFileSync(p, 'utf-8'),
      writeFileSync: (p: string, content: string, options?: fs.WriteFileOptions) => fs.writeFileSync(p, content, options),
      unlinkSync: (p: string) => fs.unlinkSync(p),
      // process.pid is guaranteed alive for the duration of this test process.
      isAlive: (pid: string | number) => Number(pid) === process.pid,
    };

    const acq = acquireLock(realSandbox, process.pid, deps);
    expect(acq.ok).toBe(true);
    expect(fs.existsSync(lockPathFor(realSandbox))).toBe(true);

    // Simulate 'node dist/index.js start' writing server.json.
    const infoPath = serverInfoPathFor(realSandbox);
    fs.mkdirSync(path.dirname(infoPath), { recursive: true });
    fs.writeFileSync(infoPath, JSON.stringify({ pid: process.pid }));

    const marked = markServerStarted(realSandbox, deps);
    expect(marked.ok).toBe(true);
    expect(fs.readFileSync(lockPathFor(realSandbox), 'utf-8')).toBe(String(process.pid));
    expect(readServerPid(realSandbox, deps)).toBe(String(process.pid));

    const teardown = authorizeAndReleaseLock(realSandbox, deps);
    expect(teardown.ok).toBe(true);
    expect(fs.existsSync(lockPathFor(realSandbox))).toBe(false);
  });
});
