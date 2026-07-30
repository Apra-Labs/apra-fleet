import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';

// apra-fleet-04g.1.2: regression guard for the integ-test-playbook.md Reset
// port-cleanup fix (apra-fleet-04g.1 / apra-fleet-04g.1.1).
//
// Before the fix, ## Reset restored the toy repo's git state but never
// freed the toy app's dev-server port (3001, from `npm run start:test` /
// `cross-env PORT=3001`). A prior abandoned attempt's background dev server
// could survive a Reset into the next attempt, causing
// `listen EADDRINUSE :::3001` in the next Deploy phase.
//
// The original fix (apra-fleet-04g.1.1) added, before the git fetch/reset in
// the Reset block:
//   PIDS="$(lsof -ti tcp:3001 2>/dev/null || true)"
//   if [ -n "$PIDS" ]; then
//     kill -9 $PIDS 2>/dev/null || true
//   fi
//
// apra-fleet-04g.7 (follow-through): that fragment was a single
// fire-and-forget kill with no verification that the port actually became
// free -- it only ever got proven, here, against a single freshly-spawned
// listener killed exactly once (the "single-run case"). It still reproduced
// live as 'Reset did not kill it' for a resumed-session/interrupted-attempt
// process. The current Reset snippet (mirroring `node dist/index.js stop`'s
// own deadline-poll-then-escalate shutdown pattern in src/cli/stop.ts)
// instead loops, re-killing anything still bound to the port each pass,
// until either the port is free or a bounded deadline elapses -- and fails
// loud (non-zero exit, before the git reset ever runs) if the port is still
// occupied once that deadline is reached, rather than silently proceeding.
//
// This test reproduces that port-cleanup fragment entirely against
// isolated, in-process/child dummy TCP listeners (never the real toy
// sandbox or a real dev server) and asserts:
//   - the fixed snippet frees a port a stray listener is bound to, verified
//     synchronously (no external polling needed on the caller's side)
//   - it also frees the port when the stray listener is a fully detached,
//     session-independent orphan (the resumed-session/interrupted-attempt
//     case, not just a directly-tracked child of the current shell)
//   - it fails loud instead of silently proceeding when the port can never
//     be verified free within the deadline
//   - the pre-fix Reset (no cleanup step at all) leaves the listener bound

// The behavior under test is a POSIX shell conditional (lsof/kill), so the
// shell must be bash on every platform: /bin/bash on POSIX, PATH-resolved
// bash.exe (Git Bash) on Windows -- a hard-coded /bin/bash is ENOENT there.
const BASH_SHELL = (() => {
  if (process.platform === 'win32') {
    const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(gitBashPath)) {
      return gitBashPath;
    }
    return 'bash.exe';
  }
  return '/bin/bash';
})();

// The Reset port-cleanup fragment relies on `lsof`, which is not guaranteed
// to be present in every CI shell (notably a bare Git Bash on Windows
// without extra tooling). Skip the whole suite rather than fail spuriously
// when the prerequisite binary genuinely is not available.
const hasLsof = (() => {
  try {
    execSync('command -v lsof', { shell: BASH_SHELL, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Inline script for a dummy dev-server stand-in: binds a real net.Server to
// the requested port (0 == OS-assigned scratch port) and prints
// "LISTENING:<port>" once bound, then just idles (keeping the process, and
// the port, occupied) until killed.
const DUMMY_LISTENER_SCRIPT = `
const net = require('node:net');
const server = net.createServer(() => {});
server.on('error', (err) => {
  process.stderr.write('ERROR:' + String(err && err.message) + '\\n');
  process.exit(1);
});
server.listen(Number(process.argv[1]), '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write('LISTENING:' + addr.port + '\\n');
});
`;

interface DummyListener {
  child: ChildProcess;
  pid: number;
  port: number;
}

function spawnDummyListener(requestedPort: number): Promise<DummyListener> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', DUMMY_LISTENER_SCRIPT, String(requestedPort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('dummy listener did not report LISTENING in time'));
      }
    }, 5000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const match = stdoutBuf.match(/LISTENING:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, pid: child.pid as number, port: Number(match[1]) });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`dummy listener exited early with code ${code}`));
      }
    });
  });
}

// Spawns the dummy listener fully detached from this test process's own
// session/process group and unref'd, modeling the resumed-session /
// interrupted-attempt case (apra-fleet-04g.7): a dev server left behind by
// an earlier, now-gone attempt, no longer connected to any live parent --
// only discoverable/killable by PID via `lsof`, exactly like a real orphaned
// `npm run start:test` process would be.
function spawnDetachedDummyListener(requestedPort: number): Promise<DummyListener> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', DUMMY_LISTENER_SCRIPT, String(requestedPort)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    child.unref();

    let stdoutBuf = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { process.kill(child.pid as number, 'SIGKILL'); } catch { /* already gone */ }
        reject(new Error('detached dummy listener did not report LISTENING in time'));
      }
    }, 5000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const match = stdoutBuf.match(/LISTENING:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, pid: child.pid as number, port: Number(match[1]) });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

// The current ## Reset port-cleanup fragment from integ-test-playbook.md
// (apra-fleet-04g.7), parameterized over $PORT and $DEADLINE_SECONDS instead
// of the literal `3001`/`5` so it can target an isolated scratch port and a
// short deadline in tests. Mirrors `node dist/index.js stop`'s own
// deadline-poll-then-escalate shutdown pattern (src/cli/stop.ts): loop,
// re-killing anything still bound each pass, until the port is free or the
// deadline elapses, then fail loud if it is still occupied.
const RESET_PORT_CLEANUP_SNIPPET = [
  'DEADLINE=$(( $(date +%s) + ${DEADLINE_SECONDS:-5} ))',
  'while :; do',
  '  PIDS="$(lsof -ti tcp:$PORT 2>/dev/null || true)"',
  '  if [ -z "$PIDS" ]; then',
  '    break',
  '  fi',
  '  kill -9 $PIDS 2>/dev/null || true',
  '  if [ "$(date +%s)" -ge "$DEADLINE" ]; then',
  '    break',
  '  fi',
  '  sleep 1',
  'done',
  'if [ -n "$(lsof -ti tcp:$PORT 2>/dev/null || true)" ]; then',
  '  echo "still bound" >&2',
  '  exit 1',
  'fi',
].join('\n');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Node-test-harness technicality, not a gap in the production Reset
// snippet: `execSync` blocks this process's own event loop, so a child this
// process spawned can be SIGKILLed by the shell script yet still show up as
// alive (a zombie/defunct entry the kernel keeps until ITS PARENT -- this
// Node process -- reaps it) to `process.kill(pid, 0)` until the event loop
// gets a tick to process the child's exit. The OS-level port itself is
// already free the instant the snippet's own verify loop confirms it
// (asserted via isPortFree, independent of this reaping race) -- this just
// gives Node's own bookkeeping a bounded chance to catch up before also
// asserting on isProcessAlive.
async function waitForReap(pid: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Verifies a port is free at the OS level (not just that our tracked
// process is gone) by attempting a real bind-and-listen.
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

describe.skipIf(!hasLsof)('integ-test-playbook.md Reset port-cleanup regression', () => {
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      if (child.pid && isProcessAlive(child.pid)) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  });

  it('fixed Reset port-cleanup snippet frees a scratch port a stray listener holds -- the port itself is verified free by the snippet, with no caller-side wait needed', async () => {
    const listener = await spawnDummyListener(0);
    spawned.push(listener.child);

    expect(isProcessAlive(listener.pid)).toBe(true);
    expect(await isPortFree(listener.port)).toBe(false);

    execSync(RESET_PORT_CLEANUP_SNIPPET, {
      shell: BASH_SHELL,
      env: { ...process.env, PORT: String(listener.port) },
    });

    // Unlike the pre-04g.7 fragment (which required the caller to separately
    // poll for the OS-level port to become free), the snippet's own bounded
    // verify loop already guarantees the port itself is free by the time
    // execSync returns -- isPortFree needs no extra wait. waitForReap below
    // is purely so this Node test process's own event loop gets a chance to
    // reap its already-dead child before isProcessAlive is asserted (see
    // waitForReap's comment).
    await waitForReap(listener.pid);
    expect(isProcessAlive(listener.pid)).toBe(false);
    expect(await isPortFree(listener.port)).toBe(true);
  });

  it('fixed Reset port-cleanup snippet frees the literal port 3001 when a stray listener holds it (verbatim as it appears in integ-test-playbook.md)', async () => {
    const port3001AlreadyInUse = (() => {
      try {
        const out = execSync('lsof -ti tcp:3001 2>/dev/null || true', {
          shell: BASH_SHELL,
        })
          .toString()
          .trim();
        return out.length > 0;
      } catch {
        return false;
      }
    })();

    if (port3001AlreadyInUse) {
      // Never collide with a real service already bound to 3001.
      return;
    }

    const listener = await spawnDummyListener(3001);
    spawned.push(listener.child);
    expect(listener.port).toBe(3001);
    expect(isProcessAlive(listener.pid)).toBe(true);

    execSync(RESET_PORT_CLEANUP_SNIPPET, {
      shell: BASH_SHELL,
      env: { ...process.env, PORT: '3001' },
    });

    await waitForReap(listener.pid);
    expect(isProcessAlive(listener.pid)).toBe(false);
    expect(await isPortFree(3001)).toBe(true);
  });

  it('resumed-session/interrupted-attempt case: frees the port even when the stray listener is a fully detached, session-independent orphan', async () => {
    const listener = await spawnDetachedDummyListener(0);
    spawned.push(listener.child);

    expect(isProcessAlive(listener.pid)).toBe(true);
    expect(await isPortFree(listener.port)).toBe(false);

    execSync(RESET_PORT_CLEANUP_SNIPPET, {
      shell: BASH_SHELL,
      env: { ...process.env, PORT: String(listener.port) },
    });

    await waitForReap(listener.pid);
    expect(isProcessAlive(listener.pid)).toBe(false);
    expect(await isPortFree(listener.port)).toBe(true);
  });

  it('fails loud (non-zero exit, before any further Reset step) when the port can never be verified free within the deadline', () => {
    // Deterministically simulates "a stray process the kill loop can never
    // fully clear within the deadline" (e.g. a respawning dev-server
    // supervisor) via a fake `lsof` shim on PATH that always reports a
    // (nonexistent) PID still bound to the port, regardless of how many
    // times the snippet kills it -- rather than relying on real process
    // timing, which would make this test flaky.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-reset-portclean-lsof-shim-'));
    const shimPath = path.join(shimDir, 'lsof');
    fs.writeFileSync(shimPath, '#!/bin/sh\necho 999999\n', { mode: 0o755 });

    try {
      const result = spawnSync(BASH_SHELL, ['-c', RESET_PORT_CLEANUP_SNIPPET], {
        env: {
          ...process.env,
          PORT: '3001',
          DEADLINE_SECONDS: '1',
          PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
        encoding: 'utf-8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/still bound/);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('pre-fix Reset (no port-cleanup step) leaves the stray listener bound', async () => {
    const listener = await spawnDummyListener(0);
    spawned.push(listener.child);

    expect(isProcessAlive(listener.pid)).toBe(true);
    expect(await isPortFree(listener.port)).toBe(false);

    // The pre-fix Reset block performed no port cleanup at all before the
    // git fetch/reset -- represented here by simply doing nothing to the
    // listener.
    execSync('true', { shell: BASH_SHELL, env: { ...process.env } });

    // Demonstrates the bug: the stray listener and its port survive.
    expect(isProcessAlive(listener.pid)).toBe(true);
    expect(await isPortFree(listener.port)).toBe(false);
  });
});
