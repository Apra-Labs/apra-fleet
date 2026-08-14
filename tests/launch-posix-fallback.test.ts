/**
 * Unit coverage for the POSIX detached-launch fallbacks (apra-fleet-i8qj.16):
 * launchMcpServerPosix (src/cli/launch-mcp-server-windows.ts) and
 * launchFleetSupervisorPosix (src/cli/launch-fleet-supervisor-windows.ts).
 * These are new, entirely untested code -- neither is gated behind a
 * process.platform check internally (only their CLI entry points are), so
 * they run and are exercised on any OS, including this suite's CI host.
 *
 * Covers:
 *  1. successful detached spawn returns ok: true with a pid
 *  2. a nonexistent executable yields the structured { ok: false, error }
 *     rather than crashing the process via an unhandled 'error' event
 *  3. the log directory is created when missing
 *  4. stdio uses ['ignore', out, err] and the child is unref()'d so it
 *     outlives the parent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Named ESM exports from a builtin (node:child_process) are non-configurable
// live bindings -- vi.spyOn(cp, 'spawn') on a namespace import throws
// "Cannot redefine property" under vitest's ESM handling. vi.mock with an
// importOriginal-forwarding factory replaces the module at resolution time
// instead, which src/cli's own `import { spawn } from 'node:child_process'`
// picks up too, while still calling through to the REAL spawn so 1-3's
// real-process assertions keep working.
const { spawnSpy, unrefSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(),
  unrefSpy: vi.fn(),
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      spawnSpy(...args);
      const child = actual.spawn(...(args as Parameters<typeof actual.spawn>));
      const originalUnref = child.unref.bind(child);
      child.unref = () => {
        unrefSpy();
        return originalUnref();
      };
      return child;
    }) as typeof actual.spawn,
  };
});

import { launchMcpServerPosix } from '../src/cli/launch-mcp-server-windows.js';
import { launchFleetSupervisorPosix } from '../src/cli/launch-fleet-supervisor-windows.js';

describe('launchMcpServerPosix / launchFleetSupervisorPosix: POSIX detached-launch fallbacks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-posix-launch-test-'));
    spawnSpy.mockClear();
    unrefSpy.mockClear();
  });

  afterEach(() => {
    // On Windows, a just-SIGKILL'd child can hold its log file's handle open
    // for a brief moment after the kill call returns -- retry the cleanup
    // rather than treating that transient EBUSY as a test failure.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('1. successful detached spawn', () => {
    it('1a. launchMcpServerPosix returns ok: true with a numeric pid for a real executable', () => {
      const logFile = path.join(tmpDir, 'mcp.log');
      const result = launchMcpServerPosix({ execPath: process.execPath, cwd: tmpDir, logFile });
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      if (result.ok) {
        expect(Number.isInteger(result.pid)).toBe(true);
        expect(result.pid).toBeGreaterThan(0);
        process.kill(result.pid, 'SIGKILL');
      }
    });

    it('1b. launchFleetSupervisorPosix returns ok: true with a numeric pid for a real executable', () => {
      const logFile = path.join(tmpDir, 'supervisor.log');
      const result = launchFleetSupervisorPosix({
        repoRoot: tmpDir,
        nodeExecPath: process.execPath,
        cwd: tmpDir,
        logFile,
      });
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      if (result.ok) {
        expect(Number.isInteger(result.pid)).toBe(true);
        expect(result.pid).toBeGreaterThan(0);
        process.kill(result.pid, 'SIGKILL');
      }
    });
  });

  describe('2. nonexistent executable: structured failure, no crash', () => {
    it('2a. launchMcpServerPosix on a nonexistent execPath yields { ok: false, error } synchronously', async () => {
      const logFile = path.join(tmpDir, 'mcp.log');
      const result = launchMcpServerPosix({
        execPath: path.join(tmpDir, 'definitely-does-not-exist.exe'),
        cwd: tmpDir,
        logFile,
      });
      expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.any(String) }));
      // Give the async ENOENT 'error' event a tick to fire. If it were
      // unhandled (no listener attached), Node would throw and crash this
      // test process -- reaching the assertion below at all is the proof.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(true).toBe(true);
    });

    it('2b. launchFleetSupervisorPosix on a nonexistent nodeExecPath yields { ok: false, error } synchronously', async () => {
      const logFile = path.join(tmpDir, 'supervisor.log');
      const result = launchFleetSupervisorPosix({
        repoRoot: tmpDir,
        nodeExecPath: path.join(tmpDir, 'definitely-does-not-exist.exe'),
        cwd: tmpDir,
        logFile,
      });
      expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.any(String) }));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(true).toBe(true);
    });
  });

  describe('3. log directory creation', () => {
    it('3a. launchMcpServerPosix creates a missing, nested log directory', () => {
      const logFile = path.join(tmpDir, 'nested', 'deeper', 'mcp.log');
      expect(fs.existsSync(path.dirname(logFile))).toBe(false);
      const result = launchMcpServerPosix({ execPath: process.execPath, cwd: tmpDir, logFile });
      expect(fs.existsSync(path.dirname(logFile))).toBe(true);
      if (result.ok) process.kill(result.pid, 'SIGKILL');
    });

    it('3b. launchFleetSupervisorPosix creates a missing, nested log directory', () => {
      const logFile = path.join(tmpDir, 'nested', 'deeper', 'supervisor.log');
      expect(fs.existsSync(path.dirname(logFile))).toBe(false);
      const result = launchFleetSupervisorPosix({
        repoRoot: tmpDir,
        nodeExecPath: process.execPath,
        cwd: tmpDir,
        logFile,
      });
      expect(fs.existsSync(path.dirname(logFile))).toBe(true);
      if (result.ok) process.kill(result.pid, 'SIGKILL');
    });
  });

  describe('4. stdio shape and detachment', () => {
    it('4a. launchMcpServerPosix spawns with stdio [ignore, fd, fd], detached, and unref()s the child', () => {
      const logFile = path.join(tmpDir, 'mcp.log');
      const result = launchMcpServerPosix({ execPath: process.execPath, cwd: tmpDir, logFile });

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const options = spawnSpy.mock.calls[0][2] as { detached?: boolean; stdio?: unknown[] };
      expect(options.detached).toBe(true);
      expect(Array.isArray(options.stdio)).toBe(true);
      expect(options.stdio?.[0]).toBe('ignore');
      expect(typeof options.stdio?.[1]).toBe('number');
      expect(typeof options.stdio?.[2]).toBe('number');

      expect(unrefSpy).toHaveBeenCalledTimes(1);
      if (result.ok) process.kill(result.pid, 'SIGKILL');
    });

    it('4b. launchFleetSupervisorPosix spawns with stdio [ignore, fd, fd], detached, and unref()s the child', () => {
      const logFile = path.join(tmpDir, 'supervisor.log');
      const result = launchFleetSupervisorPosix({
        repoRoot: tmpDir,
        nodeExecPath: process.execPath,
        cwd: tmpDir,
        logFile,
      });

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const options = spawnSpy.mock.calls[0][2] as { detached?: boolean; stdio?: unknown[] };
      expect(options.detached).toBe(true);
      expect(Array.isArray(options.stdio)).toBe(true);
      expect(options.stdio?.[0]).toBe('ignore');
      expect(typeof options.stdio?.[1]).toBe('number');
      expect(typeof options.stdio?.[2]).toBe('number');

      expect(unrefSpy).toHaveBeenCalledTimes(1);
      if (result.ok) process.kill(result.pid, 'SIGKILL');
    });
  });
});
