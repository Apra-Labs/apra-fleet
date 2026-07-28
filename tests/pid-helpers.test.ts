import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPidAlive } from '../src/utils/pid-helpers.js';

// apra-fleet-eft.28.1: isPidAlive() is the pure liveness primitive used by
// both the pre-dispatch dead-session check and the mid-wait liveness poll in
// src/tools/execute-prompt.ts. Covered directly here via process.kill
// mocking so the ESRCH/EPERM branches are pinned regardless of what real
// PIDs happen to be alive/dead on the machine running the tests.
describe('isPidAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when process.kill(pid, 0) does not throw (process exists, signalable)', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    expect(isPidAlive(4242)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4242, 0);
  });

  it('returns false on ESRCH -- no such process, the definitive "dead" signal', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    });
    expect(isPidAlive(4242)).toBe(false);
  });

  it('returns true on EPERM -- process exists but we lack permission to signal it', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('kill EPERM');
      err.code = 'EPERM';
      throw err;
    });
    expect(isPidAlive(4242)).toBe(true);
  });

  it('treats any other unexpected error code as "alive" (conservative on ambiguity)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('kill EINVAL');
      err.code = 'EINVAL';
      throw err;
    });
    expect(isPidAlive(4242)).toBe(true);
  });

  it('is true for the current process (a real, definitely-alive PID)', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});
