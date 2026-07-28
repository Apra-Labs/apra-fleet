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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
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

    const { setHttpHandle, shutdownServer } = await import('../src/tools/shutdown-server.js');
    setHttpHandle({ close: mockClose } as any);

    await shutdownServer();

    expect(order).toEqual(['close', 'unlink']);
  });

  it('does NOT delete server.json when the transport fails to close', async () => {
    const mockClose = vi.fn().mockRejectedValue(new Error('close failed'));

    const { setHttpHandle, shutdownServer } = await import('../src/tools/shutdown-server.js');
    setHttpHandle({ close: mockClose } as any);

    await expect(shutdownServer()).rejects.toThrow('close failed');
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('closes SSH connections and schedules a clean process exit on success', async () => {
    const mockClose = vi.fn().mockResolvedValue(undefined);

    const { setHttpHandle, shutdownServer } = await import('../src/tools/shutdown-server.js');
    setHttpHandle({ close: mockClose } as any);

    const result = await shutdownServer();

    expect(result).toContain('Server shutting down');
    expect(mockCloseAllConnections).toHaveBeenCalledTimes(1);
    // process.exit is scheduled via setTimeout, not called synchronously --
    // this only asserts it's wired up, not that it already fired.
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
