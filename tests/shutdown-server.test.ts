import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCloseAllConnections = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock('../src/services/ssh.js', () => ({
  closeAllConnections: () => mockCloseAllConnections(),
}));

vi.mock('node:fs', () => ({
  default: { unlinkSync: (...args: any[]) => mockUnlinkSync(...args) },
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
}));

vi.mock('../src/paths.js', () => ({
  SERVER_INFO_PATH: '/fake/server.json',
}));

describe('shutdownServer', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let cancelScheduledExit: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    cancelScheduledExit = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    // shutdownServer() defers its exit via setTimeout(..., 100). If that
    // timer is still pending when this test file finishes, it fires later
    // (once the spy below has been restored) and calls the REAL
    // process.exit, which vitest reports as an uncaught exception even
    // though every assertion already passed. Cancel it before restoring the
    // spy so nothing outlives this test.
    cancelScheduledExit?.();
    exitSpy.mockRestore();
  });

  // The client (apra-fleet-client's ApraFleet.shutdownServer()) polls
  // checkRunningInstance() -- which is just "does server.json exist and is
  // its pid alive" -- to verify the shutdown actually happened, since the
  // response to this very request can be lost when the server closes its
  // own transport. Deleting server.json before the close actually succeeds
  // would make that check falsely report "stopped" while the process (and
  // its stale HTTP listener) is still up.
  it('deletes server.json only AFTER the transport closes successfully', async () => {
    const order: string[] = [];
    const mockClose = vi.fn().mockImplementation(async () => { order.push('close'); });
    mockUnlinkSync.mockImplementation(() => { order.push('unlink'); });

    const { setHttpHandle, shutdownServer, cancelScheduledExit: cancel } = await import('../src/tools/shutdown-server.js');
    cancelScheduledExit = cancel;
    setHttpHandle({ close: mockClose } as any);

    await shutdownServer();

    expect(order).toEqual(['close', 'unlink']);
  });

  it('does NOT delete server.json when the transport fails to close', async () => {
    const mockClose = vi.fn().mockRejectedValue(new Error('close failed'));

    const { setHttpHandle, shutdownServer, cancelScheduledExit: cancel } = await import('../src/tools/shutdown-server.js');
    cancelScheduledExit = cancel;
    setHttpHandle({ close: mockClose } as any);

    await expect(shutdownServer()).rejects.toThrow('close failed');
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('closes SSH connections and schedules a clean process exit on success', async () => {
    const mockClose = vi.fn().mockResolvedValue(undefined);

    const { setHttpHandle, shutdownServer, cancelScheduledExit: cancel } = await import('../src/tools/shutdown-server.js');
    cancelScheduledExit = cancel;
    setHttpHandle({ close: mockClose } as any);

    const result = await shutdownServer();

    expect(result).toContain('Server shutting down');
    expect(mockCloseAllConnections).toHaveBeenCalledTimes(1);
    // process.exit is scheduled via setTimeout, not called synchronously --
    // this only asserts it's wired up, not that it already fired. afterEach
    // cancels the pending timer so it never fires once this test's spy is
    // restored (see cancelScheduledExit above).
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // Regression test for apra-fleet-j918.14: under full-suite load, the
  // deferred setTimeout(() => process.exit(0), 100) used to fire after this
  // test file had already finished and its process.exit spy was restored,
  // so it called the REAL process.exit and vitest reported an uncaught
  // exception on an otherwise fully-passing run. Fake timers let us assert
  // the cancel/fire behavior deterministically without depending on real
  // wall-clock timing (and without leaving a real timer pending past the
  // end of this test).
  it('cancelScheduledExit prevents the deferred process.exit from firing', async () => {
    vi.useFakeTimers();
    try {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const { setHttpHandle, shutdownServer, cancelScheduledExit: cancel } =
        await import('../src/tools/shutdown-server.js');
      cancelScheduledExit = cancel;
      setHttpHandle({ close: mockClose } as any);

      await shutdownServer();
      cancel();
      vi.advanceTimersByTime(200);

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires process.exit(0) after the delay when the exit is not cancelled', async () => {
    vi.useFakeTimers();
    try {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const { setHttpHandle, shutdownServer, cancelScheduledExit: cancel } =
        await import('../src/tools/shutdown-server.js');
      cancelScheduledExit = cancel;
      setHttpHandle({ close: mockClose } as any);

      await shutdownServer();
      vi.advanceTimersByTime(200);

      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
