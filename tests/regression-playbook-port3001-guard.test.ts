import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
// @ts-expect-error -- plain .mjs helper, no type declarations
import { waitPortFree } from '../scripts/kill-port.mjs';

// apra-fleet-cgc5.2: end-to-end verification that regression-test-
// playbook.md's Setup guard for the toy app's dev-server port (3001) clears
// a stray listener from a prior interrupted run, or fails loud naming port
// 3001 and the toy dev server -- so this can never again leak into a
// following Deploy phase as `listen EADDRINUSE :::3001` (apra-fleet-cgc5).
//
// Scope note (mirrors tests/regression-playbook-sandbox-lifecycle.test.ts's
// precedent for the sibling uof6.7 bead and the doer contract's
// "Live-evidence beads" rule): this drives the ACTUAL
// `scripts/kill-port.mjs` CLI regression-test-playbook.md's Setup invokes
// for port 3001, as a real child process against throwaway dummy listeners.
// It does NOT execute the playbook's real `node dist/index.js install/start`
// or the toy repo's Deploy phase -- that is a live-evidence run of the real
// smoke test, out of scope for a doer session.
const REPO_ROOT = path.resolve(__dirname, '..');
const KILL_PORT_CLI = path.join(REPO_ROOT, 'scripts', 'kill-port.mjs');
const PLAYBOOK_PATH = path.join(REPO_ROOT, 'regression-test-playbook.md');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

const DUMMY_LISTENER_SCRIPT = `
const net = require('node:net');
const server = net.createServer(() => {});
server.on('error', (err) => {
  process.stderr.write('ERROR:' + String(err && err.message) + '\\n');
  process.exit(1);
});
server.listen(Number(process.argv[1]), '127.0.0.1', () => {
  process.stdout.write('LISTENING:' + server.address().port + '\\n');
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
    let buf = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('dummy listener did not report LISTENING in time'));
      }
    }, 5000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/LISTENING:(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, pid: child.pid as number, port: Number(m[1]) });
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

async function waitForReap(pid: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('regression-test-playbook.md Setup toy dev-server port 3001 guard', () => {
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

  it('kills a decoy listener on the literal port 3001 the playbook hardcodes, via the real kill-port.mjs CLI Setup invokes -- skipping if a real service already legitimately owns it', async () => {
    const alreadyBound = !(await isPortFree(3001));
    if (alreadyBound) {
      // Never collide with a real dev sandbox/service already on 3001.
      return;
    }
    const listener = await spawnDummyListener(3001);
    spawned.push(listener.child);
    expect(listener.port).toBe(3001);
    expect(isProcessAlive(listener.pid)).toBe(true);

    // Verbatim invocation regression-test-playbook.md's Setup uses.
    const result = spawnSync(process.execPath, [
      KILL_PORT_CLI,
      '3001',
      'toy app dev-server port 3001',
      '5000',
    ]);
    expect(result.status).toBe(0);

    await waitForReap(listener.pid);
    expect(isProcessAlive(listener.pid)).toBe(false);
    expect(await isPortFree(3001)).toBe(true);
  });

  it('exits non-zero naming port 3001 and the toy dev-server label instead of silently proceeding when the port can never be freed within the deadline (revert-check: without this guard nothing stops Setup from proceeding with 3001 still bound)', async () => {
    const deps = {
      platform: 'linux',
      execFileSync: (cmd: string) => (cmd === 'lsof' ? '999999\n' : ''),
      processKill: () => {},
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
    };
    const result = await waitPortFree(3001, 'toy app dev-server port 3001', 2000, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/toy app dev-server port 3001/);
    expect(result.message).toMatch(/still bound/);
  });

  it('regression-test-playbook.md Setup actually invokes kill-port.mjs for port 3001 before "node dist/index.js start" -- reverting this line is what the prior test proves would leave 3001 unguarded', () => {
    const text = fs.readFileSync(PLAYBOOK_PATH, 'utf-8');
    // Split on the actual '## Setup'/'## Reset' HEADINGS (a whole line, not
    // a backticked mention in prose elsewhere in the file).
    const setupSection = text.split(/^## Setup$/m)[1]?.split(/^## Reset$/m)[0] ?? '';
    expect(setupSection).toMatch(/kill-port\.mjs["'\s]+3001\s+"toy app dev-server port 3001"/);
    // The 3001 guard must run before the server (and thus the toy app) is
    // started, matching the 18700 guard's ordering.
    const guardMatch = /^node "<repo-root>\/scripts\/kill-port\.mjs" 3001 "toy app dev-server port 3001"/m.exec(
      setupSection,
    );
    // Match the actual command line (start of line, no leading '#' comment
    // prefix), not an earlier prose mention of the same string in a comment
    // explaining the guard's ordering.
    const startMatch = /^node dist\/index\.js start$/m.exec(setupSection);
    expect(guardMatch).not.toBeNull();
    expect(startMatch).not.toBeNull();
    expect(guardMatch!.index).toBeLessThan(startMatch!.index);
  });

  it('Teardown honours its documented 3001 branch: no separate reap runs, and the file explains why that is safe (rm -rf makes the dev server unreachable, and the next Setup guard closes the port)', () => {
    const text = fs.readFileSync(PLAYBOOK_PATH, 'utf-8');
    const teardownSection = text.split(/^## Teardown$/m)[1] ?? '';
    expect(teardownSection).toMatch(
      /No separate guard reaps the toy app's dev-server port \(3001\)/,
    );
    expect(teardownSection).toMatch(/next '## Setup'\/'## Reset' to clear/);
  });

  it('no leftover artifacts outside the test sandbox: driving the 3001 guard never touches real HOME/.apra-fleet (directory listing + mtimes unchanged)', async () => {
    const realApraFleetDir = path.join(os.homedir(), '.apra-fleet');
    const snapshot = () => {
      if (!fs.existsSync(realApraFleetDir)) return null;
      return fs
        .readdirSync(realApraFleetDir)
        .sort()
        .map((name) => {
          const full = path.join(realApraFleetDir, name);
          return `${name}:${fs.statSync(full).mtimeMs}`;
        });
    };
    const before = snapshot();

    const listener = await spawnDummyListener(0);
    spawned.push(listener.child);
    const result = spawnSync(process.execPath, [
      KILL_PORT_CLI,
      String(listener.port),
      'toy app dev-server port (test)',
      '5000',
    ]);
    expect(result.status).toBe(0);
    await waitForReap(listener.pid);

    const after = snapshot();
    expect(after).toEqual(before);
  });

  it('cross-instance safety: killing the decoy on its own port never touches an unrelated long-lived decoy on a different port', async () => {
    const targetDecoy = await spawnDummyListener(0);
    spawned.push(targetDecoy.child);
    const unrelatedDecoy = await spawnDummyListener(0);
    spawned.push(unrelatedDecoy.child);
    expect(targetDecoy.port).not.toBe(unrelatedDecoy.port);

    const result = spawnSync(process.execPath, [
      KILL_PORT_CLI,
      String(targetDecoy.port),
      'toy app dev-server port (test)',
      '5000',
    ]);
    expect(result.status).toBe(0);
    await waitForReap(targetDecoy.pid);

    expect(isProcessAlive(targetDecoy.pid)).toBe(false);
    expect(isProcessAlive(unrelatedDecoy.pid)).toBe(true);
    expect(await isPortFree(unrelatedDecoy.port)).toBe(false);
  });
});
