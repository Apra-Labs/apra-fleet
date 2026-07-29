import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
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
// The fix (apra-fleet-04g.1.1) added, before the git fetch/reset in the
// Reset block:
//   PIDS="$(lsof -ti tcp:3001 2>/dev/null || true)"
//   if [ -n "$PIDS" ]; then
//     kill -9 $PIDS 2>/dev/null || true
//   fi
//
// This test reproduces that port-cleanup fragment entirely against an
// isolated, in-process dummy TCP listener (never the real toy sandbox or a
// real dev server) and asserts:
//   - the fixed snippet frees a port a stray listener is bound to
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('condition not met before timeout'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
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

  it('fixed Reset port-cleanup snippet frees a scratch port a stray listener holds', async () => {
    const listener = await spawnDummyListener(0);
    spawned.push(listener.child);

    expect(isProcessAlive(listener.pid)).toBe(true);
    expect(await isPortFree(listener.port)).toBe(false);

    // The fixed ## Reset port-cleanup fragment from integ-test-playbook.md,
    // parameterized over PORT instead of the literal 3001 so it can target
    // an isolated scratch port.
    execSync(
      [
        'PIDS="$(lsof -ti tcp:$PORT 2>/dev/null || true)"',
        'if [ -n "$PIDS" ]; then',
        '  kill -9 $PIDS 2>/dev/null || true',
        'fi',
      ].join('\n'),
      {
        shell: BASH_SHELL,
        env: { ...process.env, PORT: String(listener.port) },
      },
    );

    await waitFor(() => !isProcessAlive(listener.pid), 5000);
    expect(isProcessAlive(listener.pid)).toBe(false);
    expect(await isPortFree(listener.port)).toBe(true);
  });

  it('fixed Reset port-cleanup snippet frees the literal port 3001 when a stray listener holds it', async () => {
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

    // Verbatim port-cleanup fragment as it appears in integ-test-playbook.md's
    // ## Reset block.
    execSync(
      [
        'PIDS="$(lsof -ti tcp:3001 2>/dev/null || true)"',
        'if [ -n "$PIDS" ]; then',
        '  kill -9 $PIDS 2>/dev/null || true',
        'fi',
      ].join('\n'),
      { shell: BASH_SHELL, env: { ...process.env } },
    );

    await waitFor(() => !isProcessAlive(listener.pid), 5000);
    expect(isProcessAlive(listener.pid)).toBe(false);
    expect(await isPortFree(3001)).toBe(true);
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
