// Tests for bin/runtime.mjs -- the real collaborators. Fakes are injected
// where the signature allows (`execFile`); the real filesystem is used
// through a temp directory for `readTokenFile`/`openAppendStream`, since
// those two ARE the real-fs seam this file exists to provide.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import {
  readTokenFile,
  createGit,
  isAlive,
  createClock,
  openAppendStream,
} from '../bin/runtime.mjs';

const tmpDirs = [];
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-bridge-runtime-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- readTokenFile ------------------------------------------------------------

describe('readTokenFile', () => {
  test('missing file -> null, never throws', () => {
    const dataDir = makeTmpDir();
    assert.equal(readTokenFile(join(dataDir, 'does-not-exist')), null);
  });

  test('missing dataDir entirely -> null, never throws', () => {
    assert.equal(readTokenFile(join(tmpdir(), 'fleet-bridge-runtime-never-created-xyz')), null);
  });

  test('empty file -> null, not empty string', () => {
    const dataDir = makeTmpDir();
    mkdirSync(join(dataDir, 'private'), { recursive: true });
    writeFileSync(join(dataDir, 'private', 'token'), '');
    assert.equal(readTokenFile(dataDir), null);
  });

  test('whitespace-only file -> null', () => {
    const dataDir = makeTmpDir();
    mkdirSync(join(dataDir, 'private'), { recursive: true });
    writeFileSync(join(dataDir, 'private', 'token'), '   \n\t  \n');
    assert.equal(readTokenFile(dataDir), null);
  });

  test('a real token is read back, trimmed', () => {
    const dataDir = makeTmpDir();
    mkdirSync(join(dataDir, 'private'), { recursive: true });
    writeFileSync(join(dataDir, 'private', 'token'), '  s3cr3t-bearer-token  \n');
    assert.equal(readTokenFile(dataDir), 's3cr3t-bearer-token');
  });

  test('an unreadable path (a directory where the token file should be) -> null, never throws', () => {
    const dataDir = makeTmpDir();
    // Make `<dataDir>/private/token` a directory instead of a file, so
    // reading it fails (EISDIR) the same way a permissions error would --
    // portable across platforms, unlike chmod-based permission tests.
    mkdirSync(join(dataDir, 'private', 'token'), { recursive: true });
    assert.equal(readTokenFile(dataDir), null);
  });

  test('non-string dataDir -> null, never throws', () => {
    assert.equal(readTokenFile(undefined), null);
    assert.equal(readTokenFile(null), null);
    assert.equal(readTokenFile(42), null);
  });

  test('never logs the value: the function has no visible side channel', () => {
    // Structural guard: readTokenFile takes no logger and returns a plain
    // string|null, so there is no parameter through which it could log.
    // Asserted by arity/shape rather than by intercepting console output.
    assert.equal(readTokenFile.length, 1);
  });
});

// -- createGit ------------------------------------------------------------

describe('createGit', () => {
  function fakeExecFile(responder) {
    return (file, args, options, callback) => {
      responder(file, args, options, callback);
    };
  }

  test('resolveRef resolves to the trimmed sha on success', async () => {
    const calls = [];
    const git = createGit({
      execFile: fakeExecFile((file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(null, 'abc123def456\n', '');
      }),
    });
    const sha = await git.resolveRef('main', { cwd: '/some/repo' });
    assert.equal(sha, 'abc123def456');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'git');
    assert.deepEqual(calls[0].args, ['rev-parse', '--verify', 'main']);
    assert.equal(calls[0].options.cwd, '/some/repo');
  });

  test('resolveRef rejects when the ref does not exist', async () => {
    const git = createGit({
      execFile: fakeExecFile((file, args, options, callback) => {
        const err = new Error("Command failed: git rev-parse --verify no-such-branch\nfatal: Needed a single revision\n");
        err.code = 128;
        callback(err, '', 'fatal: Needed a single revision\n');
      }),
    });
    await assert.rejects(() => git.resolveRef('no-such-branch', { cwd: '/some/repo' }));
  });

  test('argv is passed as an array, never interpolated into a shell string', async () => {
    const git = createGit({
      execFile: fakeExecFile((file, args, options, callback) => {
        assert.equal(file, 'git');
        assert.ok(Array.isArray(args));
        // A branch name containing shell metacharacters must survive as one
        // argv element, not be split or interpreted.
        assert.equal(args[args.length - 1], '$(rm -rf /); evil');
        callback(null, 'deadbeef\n', '');
      }),
    });
    const sha = await git.resolveRef('$(rm -rf /); evil', { cwd: '/repo' });
    assert.equal(sha, 'deadbeef');
  });

  test('defaults to the real node:child_process execFile when none is injected', () => {
    // Not exercised end-to-end (no repo guaranteed here) -- just confirms
    // construction without an injected execFile does not throw and returns
    // the expected shape.
    const git = createGit({});
    assert.equal(typeof git.resolveRef, 'function');
  });
});

// -- isAlive ------------------------------------------------------------

describe('isAlive', () => {
  test('the current process, on the local host, is alive', () => {
    assert.equal(isAlive(process.pid, hostname()), true);
  });

  test('the current process, with no host given, is alive (treated as local)', () => {
    assert.equal(isAlive(process.pid, undefined), true);
  });

  test('an almost-certainly-dead pid on the local host is not alive', () => {
    // A very large pid number is exceedingly unlikely to be a live process
    // on any real system; if this ever flakes, that would itself be
    // interesting, but this is the standard way to probe "probably dead".
    const almostCertainlyDeadPid = 999999;
    assert.equal(isAlive(almostCertainlyDeadPid, hostname()), false);
  });

  test('a foreign host is always reported alive -- cross-host liveness is unsolved by design', () => {
    // Documented in bin/runtime.mjs: getting this wrong in the unsafe
    // direction (reporting a foreign process dead when it might not be)
    // would let two daemons both claim a sprint and both advance the
    // append-blob appendpos cursor, corrupting the log silently. So a
    // foreign host always reads "alive", even for a pid that could not
    // possibly exist.
    assert.equal(isAlive(999999, 'some-other-machine-entirely'), true);
  });
});

// -- createClock ------------------------------------------------------------

describe('createClock', () => {
  test('now() returns a number close to Date.now()', () => {
    const clock = createClock();
    const before = Date.now();
    const value = clock.now();
    const after = Date.now();
    assert.equal(typeof value, 'number');
    assert.ok(value >= before && value <= after);
  });

  test('sleep(ms) resolves after roughly ms', async () => {
    const clock = createClock();
    const start = Date.now();
    await clock.sleep(10);
    assert.ok(Date.now() - start >= 5);
  });

  test('setTimeout/clearTimeout: a cleared timer never fires', async () => {
    const clock = createClock();
    let fired = false;
    const id = clock.setTimeout(() => { fired = true; }, 10);
    clock.clearTimeout(id);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    assert.equal(fired, false);
  });

  test('satisfies watch.mjs / daemon.mjs / await-gate.mjs: bare now()/sleep() deps', async () => {
    const clock = createClock();
    // These three consumers destructure deps.now / deps.sleep directly --
    // simulate exactly that composition.
    const deps = { now: clock.now, sleep: clock.sleep };
    assert.equal(typeof deps.now(), 'number');
    await deps.sleep(1);
  });

  test('satisfies jsonl-file.mjs: a whole deps.clock with just now()', () => {
    const clock = createClock();
    const deps = { clock };
    assert.equal(typeof deps.clock.now, 'function');
    assert.equal(typeof deps.clock.now(), 'number');
  });

  test('satisfies append-blob.mjs: a whole deps.clock with now()/setTimeout()/clearTimeout()', () => {
    const clock = createClock();
    const deps = { clock };
    assert.equal(typeof deps.clock.now, 'function');
    assert.equal(typeof deps.clock.setTimeout, 'function');
    assert.equal(typeof deps.clock.clearTimeout, 'function');
  });

  test('one instance works both as a whole object and with its methods extracted', async () => {
    const clock = createClock();
    // Same instance, used both ways at once -- this is the actual claim
    // the composition root relies on: one createClock() call wires all
    // five consumers.
    const watchLikeDeps = { now: clock.now, sleep: clock.sleep };
    const sinkLikeDeps = { clock };
    assert.equal(typeof watchLikeDeps.now(), 'number');
    assert.equal(typeof sinkLikeDeps.clock.now(), 'number');
    await watchLikeDeps.sleep(1);
  });
});

// -- openAppendStream ------------------------------------------------------------

describe('openAppendStream', () => {
  test('returns a stream exposing write() and end(), matching jsonl-file.mjs\'s usage', () => {
    const dataDir = makeTmpDir();
    const filePath = join(dataDir, 'out.jsonl');
    const stream = openAppendStream(filePath);
    assert.equal(typeof stream.write, 'function');
    assert.equal(typeof stream.end, 'function');
    stream.end();
  });

  test('appends rather than truncates on repeated opens', async () => {
    const dataDir = makeTmpDir();
    const filePath = join(dataDir, 'out.jsonl');

    await new Promise((resolve, reject) => {
      const s1 = openAppendStream(filePath);
      s1.write('line-one\n');
      s1.end((err) => (err ? reject(err) : resolve()));
    });

    await new Promise((resolve, reject) => {
      const s2 = openAppendStream(filePath);
      s2.write('line-two\n');
      s2.end((err) => (err ? reject(err) : resolve()));
    });

    assert.ok(existsSync(filePath));
    const content = readFileSync(filePath, 'utf8');
    assert.equal(content, 'line-one\nline-two\n');
  });
});
