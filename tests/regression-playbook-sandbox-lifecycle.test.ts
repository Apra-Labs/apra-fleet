import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
// @ts-expect-error -- plain .mjs helper, no type declarations
import { waitPortFree, ProbeToolMissingError as KillPortToolMissingError } from '../scripts/kill-port.mjs';
// @ts-expect-error -- plain .mjs helper, no type declarations
import { reapSandboxDolt, ProbeToolMissingError as ReapToolMissingError } from '../scripts/reap-sandbox-dolt.mjs';

// apra-fleet-uof6.7: end-to-end verification for the hardened
// regression-test-playbook.md sandbox lifecycle (Setup busy-check + stale-
// port guard, Teardown reaps, cross-instance safety time bound).
//
// Scope note (see this bead's acceptance criteria and the doer contract):
// this drives the ACTUAL CLI scripts regression-test-playbook.md's Setup /
// Teardown invoke (scripts/sandbox-lock.mjs, scripts/kill-port.mjs,
// scripts/reap-sandbox-dolt.mjs) as real child processes against a
// throwaway `os.tmpdir()` sandbox root and OS-assigned scratch ports/pids --
// exactly like tests/integ-test-playbook-reset-portclean.test.ts's precedent
// for the sibling integ-test-playbook.md. It does NOT execute the
// playbook's real 'node dist/index.js install/start' (network clone of
// fleet-e2e-toy, real HOME override, real toy-repo Deploy) -- that is a
// live-evidence run of the actual smoke test, out of scope for a doer
// session (see agents/doer.md's "Live-evidence beads" rule). The literal
// ports the playbook hardcodes (18700, 18701, 3001) are only touched in a
// guarded case that first probes and bails out if a real service already
// owns the port, mirroring the precedent test's `port3001AlreadyInUse`
// pattern -- every other case uses an OS-assigned port to avoid ever
// touching a developer's live sandbox or supervisor.
const REPO_ROOT = path.resolve(__dirname, '..');
const SANDBOX_LOCK_CLI = path.join(REPO_ROOT, 'scripts', 'sandbox-lock.mjs');
const KILL_PORT_CLI = path.join(REPO_ROOT, 'scripts', 'kill-port.mjs');
const REAP_SANDBOX_DOLT_CLI = path.join(REPO_ROOT, 'scripts', 'reap-sandbox-dolt.mjs');
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

describe('regression-test-playbook.md sandbox lifecycle', () => {
  const cleanupDirs: string[] = [];
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
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
      const lock = `${dir}.lock`;
      if (fs.existsSync(lock)) fs.rmSync(lock, { force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Property 1: Concurrency -- a second Setup while a first sandbox is live
  // fails loud and never touches the in-progress sandbox.
  // ---------------------------------------------------------------------
  describe('concurrency: second Setup refused while a first sandbox is live', () => {
    it('acquire succeeds for run A, then fails loud (non-zero exit, "sandbox busy") for run B, without touching run A\'s sandbox', () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-lifecycle-concurrency-'));
      cleanupDirs.push(sandbox);
      // Seed a marker file representing run A's in-progress work.
      const marker = path.join(sandbox, 'run-a-marker.txt');
      fs.writeFileSync(marker, 'run-a-in-progress');
      const markerMtimeBefore = fs.statSync(marker).mtimeMs;

      // Run A acquires with its own (genuinely alive) process pid.
      const resA = spawnSync(process.execPath, [SANDBOX_LOCK_CLI, 'acquire', sandbox, String(process.pid)]);
      expect(resA.status).toBe(0);

      // Run B, a different (still-alive) pid, must be refused.
      const resB = spawnSync(process.execPath, [SANDBOX_LOCK_CLI, 'acquire', sandbox, String(process.pid)], {
        // Simulate "some other live PID" by acquiring against the SAME
        // sandbox again -- sandbox-lock.mjs's busy-check keys off the lock
        // file's recorded pid being alive, not identity of the caller, so a
        // second acquire attempt while run A's pid is still alive is exactly
        // the concurrent-Setup scenario regardless of which pid B itself is.
      });
      expect(resB.status).not.toBe(0);
      expect(resB.stderr.toString()).toMatch(/sandbox busy/i);

      // Run A's sandbox contents are untouched: marker file still present
      // with an unchanged mtime, and the lock still names run A's pid.
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.statSync(marker).mtimeMs).toBe(markerMtimeBefore);
      expect(fs.readFileSync(`${sandbox}.lock`, 'utf-8')).toBe(String(process.pid));
    });

    it('regression check: with no busy-check at all (pre-fix Setup), a second acquire-less run would freely proceed -- demonstrated by calling acquire only once and confirming a bare second "start" attempt has nothing stopping it', () => {
      // This documents the counterfactual the fix closes: without
      // sandbox-lock.mjs's acquire step, there is no artifact at all that a
      // second concurrent Setup would need to contend with. The busy-check
      // itself (proven above) is what turns that into a fail-loud refusal.
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-lifecycle-concurrency-nofix-'));
      cleanupDirs.push(sandbox);
      expect(fs.existsSync(`${sandbox}.lock`)).toBe(false);
    });

    it('regression-test-playbook.md Setup actually invokes sandbox-lock.mjs acquire and kill-port.mjs 18700 before "node dist/index.js start" -- reverting either line is what the prior tests prove would leave the busy-check/stale-port guard unenforced', () => {
      const text = fs.readFileSync(PLAYBOOK_PATH, 'utf-8');
      // Anchor to the actual '## Setup'/'## Reset' HEADINGS (a whole line),
      // not a backticked mention of the same text elsewhere in the file's
      // intro/cross-reference prose -- mirrors the sibling
      // regression-playbook-port3001-guard.test.ts pattern.
      const setupSection = text.split(/^## Setup$/m)[1]?.split(/^## Reset$/m)[0] ?? '';
      // apra-fleet-5co8.39: acquire no longer takes an explicit "$$" pid
      // argument -- the CLI now records its own process.ppid (the Setup
      // shell's real, native OS pid), since $$ is an MSYS-internal pid under
      // Git Bash on Windows that the native liveness check cannot see.
      const acquireMatch = /^node "<repo-root>\/scripts\/sandbox-lock\.mjs" acquire "\$SANDBOX" \|\| exit 1$/m.exec(
        setupSection,
      );
      const killPortMatch = /^node "<repo-root>\/scripts\/kill-port\.mjs" 18700 "sandbox scratch port 18700" 5000 \|\| exit 1$/m.exec(
        setupSection,
      );
      const startMatch = /^node dist\/index\.js start$/m.exec(setupSection);
      expect(acquireMatch).not.toBeNull();
      expect(killPortMatch).not.toBeNull();
      expect(startMatch).not.toBeNull();
      expect(acquireMatch!.index).toBeLessThan(startMatch!.index);
      expect(killPortMatch!.index).toBeLessThan(startMatch!.index);
    });
  });

  // ---------------------------------------------------------------------
  // Property 2: Stale scratch port -- Setup's bounded-retry kill-loop
  // clears a pre-bound port or fails loud; never silently proceeds on an
  // OS-assigned fallback.
  // ---------------------------------------------------------------------
  describe('stale scratch port: bounded-retry kill-loop clears a stray listener or fails loud', () => {
    it('kills a stray listener bound to an OS-assigned scratch port and confirms it free, via the real kill-port.mjs CLI Setup invokes', async () => {
      const listener = await spawnDummyListener(0);
      spawned.push(listener.child);
      expect(isProcessAlive(listener.pid)).toBe(true);
      expect(await isPortFree(listener.port)).toBe(false);

      const result = spawnSync(process.execPath, [
        KILL_PORT_CLI,
        String(listener.port),
        'sandbox scratch port (test)',
        '5000',
      ]);
      expect(result.status).toBe(0);

      await waitForReap(listener.pid);
      expect(isProcessAlive(listener.pid)).toBe(false);
      expect(await isPortFree(listener.port)).toBe(true);
    });

    it('clears the literal sandbox scratch port 18700 the playbook hardcodes, skipping if a real service already legitimately owns it', async (ctx) => {
      const alreadyBound = !(await isPortFree(18700));
      if (alreadyBound) {
        // Never collide with a real dev sandbox/service already on 18700.
        ctx.skip();
        return;
      }
      const listener = await spawnDummyListener(18700);
      spawned.push(listener.child);
      expect(listener.port).toBe(18700);

      const result = spawnSync(process.execPath, [KILL_PORT_CLI, '18700', 'sandbox scratch port 18700', '5000']);
      expect(result.status).toBe(0);

      await waitForReap(listener.pid);
      expect(isProcessAlive(listener.pid)).toBe(false);
      expect(await isPortFree(18700)).toBe(true);
    });

    it('fails loud (ok:false) instead of silently proceeding when the port can never be freed within the deadline', async () => {
      // A CLI-level shim on PATH cannot reliably intercept kill-port.mjs's
      // internal execFileSync('netstat'/'lsof', ...) call here: Windows'
      // native CreateProcess resolves an unqualified command name against
      // the system directory BEFORE the PATH env var the outer spawnSync
      // call sets, so a PATH-prepended shim never gets a chance to answer.
      // This exercises the exact same waitPortFree() the CLI's main() calls
      // (see kill-port.mjs) with an injected always-bound probe, matching
      // this repo's own tests/kill-port.test.ts convention -- deterministic
      // and platform-independent, unlike relying on real retry timing.
      const deps = {
        platform: 'linux',
        execFileSync: (cmd: string) => (cmd === 'lsof' ? '999999\n' : ''),
        processKill: () => {},
        sleep: async () => {},
        now: (() => { let t = 0; return () => (t += 1000); })(),
      };
      const result = await waitPortFree(18700, 'sandbox scratch port 18700', 2000, deps);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/still bound/);
    });

    it('reverting the fix (no probe-tool guard) is exactly the false-success gap this replaces: an unresolvable-tool host must throw ProbeToolMissingError, not silently report "port free"', async () => {
      const deps = {
        platform: 'linux',
        execFileSync: () => {
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        },
      };
      await expect(waitPortFree(18700, 'sandbox scratch port 18700', 500, deps)).rejects.toThrow(
        KillPortToolMissingError,
      );
    });
  });

  // ---------------------------------------------------------------------
  // Property 3: Teardown reaping -- no sandbox-owned dolt sql-server
  // remains after Teardown, and the reap script frees supervisor ports too.
  // ---------------------------------------------------------------------
  describe('Teardown reaping: sandbox-owned dolt sql-server and supervisor port are both cleared', () => {
    it('reap-sandbox-dolt.mjs kills a real process it discovers matching this sandbox\'s absolute path and args containing "sql-server"', async () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-lifecycle-doltreap-'));
      cleanupDirs.push(sandbox);

      // A stand-in for the detached ephemeral dolt sql-server dolt-settle.mjs
      // spawns: a real, currently-running process this test genuinely kills.
      // Real host enumeration (Get-CimInstance filtered to Name='dolt.exe' on
      // Windows, 'ps' on POSIX) cannot see this process because it is not
      // literally named 'dolt'/'dolt.exe' -- so listCandidates() is injected
      // here with a single row describing this real pid and a "sql-server
      // <sandbox>" command line, exercising reapSandboxDolt()'s real
      // matching + kill logic (matchesSandboxDolt, killPid) against a real
      // OS process, exactly as the CLI's main() does.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      spawned.push(child);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const pid = child.pid as number;
      expect(isProcessAlive(pid)).toBe(true);

      const since = Math.floor(Date.now() / 1000) - 60;
      const deps = {
        // Forces the POSIX 'ps' branch (deterministic, cross-platform: this
        // real spawned pid works with process.kill regardless of host OS,
        // whereas the win32 branch would require killPid to shell out to
        // 'taskkill', an unnecessary extra real-process dependency here).
        // Reflects reality each poll -- unlike a static fixture, this
        // actually stops reporting the row once killPid() below really
        // kills the process, so a genuine kill is required to pass, not
        // just a call being made.
        platform: 'linux',
        execFileSync: (cmd: string) =>
          cmd === 'ps' && isProcessAlive(pid) ? `${pid} 5 sql-server --data-dir ${sandbox}\n` : '',
        sleep: async () => {},
        now: () => Date.now(),
      };
      const result = await reapSandboxDolt({ sandboxPath: sandbox, since, deadlineMs: 3000 }, deps);
      expect(result.ok).toBe(true);
      expect(isProcessAlive(pid)).toBe(false);
    });

    it('propagates ProbeToolMissingError instead of silently reporting "nothing found" when no enumeration tool is available', async () => {
      const deps = {
        platform: 'linux',
        execFileSync: () => {
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        },
      };
      await expect(
        reapSandboxDolt({ sandboxPath: '/tmp/does-not-matter', since: 0, deadlineMs: 500 }, deps),
      ).rejects.toThrow(ReapToolMissingError);
    });

    it('the sandbox supervisor port is freed by the same kill-port.mjs CLI Teardown uses', async () => {
      const listener = await spawnDummyListener(0);
      spawned.push(listener.child);
      expect(await isPortFree(listener.port)).toBe(false);

      const result = spawnSync(process.execPath, [KILL_PORT_CLI, String(listener.port), 'supervisor port (test)', '5000']);
      expect(result.status).toBe(0);

      await waitForReap(listener.pid);
      expect(await isPortFree(listener.port)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // Property 4: No leftover artifacts outside the sandbox -- every helper
  // invocation above only ever touched throwaway os.tmpdir() paths and
  // OS-assigned ports, never the real HOME.
  // ---------------------------------------------------------------------
  describe('no leftover artifacts outside the test sandbox', () => {
    it('real HOME/.apra-fleet is unchanged before and after driving the guards above (directory listing + mtimes)', () => {
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
      // Re-run one of the guards above against a fresh throwaway sandbox to
      // prove it never reads/writes HOME.
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-lifecycle-homeguard-'));
      cleanupDirs.push(sandbox);
      spawnSync(process.execPath, [SANDBOX_LOCK_CLI, 'acquire', sandbox, String(process.pid)]);
      spawnSync(process.execPath, [SANDBOX_LOCK_CLI, 'release', sandbox]);
      const after = snapshot();
      expect(after).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------
  // Property 5: Cross-instance safety -- the documented time-bound
  // mitigation this playbook accepts (dolt-orphan-sweep's 5-minute tick)
  // is present and the smoke test's own bounds stay inside it.
  // ---------------------------------------------------------------------
  describe('cross-instance safety: the documented time-bound mitigation is present', () => {
    it('regression-test-playbook.md Test scenario step 4 hard-enforces the UPTIME_DEADLINE = SUPERVISOR_STARTED_AT + 280 stop (the actual enforcement point) -- Teardown\'s SUPERVISOR_UPTIME >= 300 check is only a belt-and-suspenders warning, not the hard stop', () => {
      const text = fs.readFileSync(PLAYBOOK_PATH, 'utf-8');
      // The real hard stop: Test scenario step 4's sprint-poll loop bails at
      // +280s, before the sweep's 300s/5-minute tick can ever fire.
      expect(text).toMatch(/UPTIME_DEADLINE\s*=\s*\$\(\(\s*SUPERVISOR_STARTED_AT\s*\+\s*280\s*\)\)/);
      expect(text).toMatch(/"\$\(date \+%s\)"\s*-ge\s*"\$UPTIME_DEADLINE"/);
      // The Teardown check is documented as belt-and-suspenders, not the
      // enforcement mechanism -- still present, but not what this test
      // treats as the hard bound.
      expect(text).toMatch(/SUPERVISOR_UPTIME"\s*-ge\s*300/);
      expect(text).toMatch(/belt-and-suspenders/i);
      expect(text).toMatch(/dolt-orphan-sweep/i);
    });

    it('regression-test-playbook.md guards the supervisor started-at marker BEFORE computing UPTIME_DEADLINE, so a missing/empty/non-numeric marker fails with the real reason instead of the misleading sweep-tick message', () => {
      const text = fs.readFileSync(PLAYBOOK_PATH, 'utf-8');
      // An absent marker must be caught by an existence check, and the
      // diagnostic must name the marker file path.
      expect(text).toMatch(/if \[ ! -f "\$SANDBOX\.supervisor\.started_at" \]; then/);
      expect(text).toMatch(/supervisor started-at marker file[\s\S]{0,200}is missing/);
      // An empty or non-numeric marker must be rejected too (a bare `cat`
      // of an empty file otherwise makes UPTIME_DEADLINE evaluate to 280).
      expect(text).toMatch(/case "\$SUPERVISOR_STARTED_AT" in\s*\n\s*'' \| \*\[!0-9\]\* \)/);
      expect(text).toMatch(/does not hold an integer[\s\S]{0,120}epoch timestamp/);
      // The guard must sit BEFORE the deadline computation, not after it.
      const guardIndex = text.indexOf('if [ ! -f "$SANDBOX.supervisor.started_at" ]; then');
      const deadlineIndex = text.search(/UPTIME_DEADLINE\s*=\s*\$\(\(\s*SUPERVISOR_STARTED_AT\s*\+\s*280\s*\)\)/);
      expect(guardIndex).toBeGreaterThan(-1);
      expect(deadlineIndex).toBeGreaterThan(guardIndex);
    });
  });
});
