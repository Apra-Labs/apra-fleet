import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

// GitHub #584 review: the service-path stop must learn that the graceful stop
// refused to force-kill an unverifiable pid, so `apra-fleet stop` does not
// print "Server stopped." and exit 0 while the server is still up.

const { mockAlive, mockIsFleet, mockPostShutdown } = vi.hoisted(() => ({
  mockAlive: vi.fn<(pid: number) => boolean>(),
  mockIsFleet: vi.fn<(pid: number) => boolean | null>(),
  mockPostShutdown: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('../src/utils/process-utils.js', () => ({
  isPidAlive: mockAlive,
  isApraFleetProcess: mockIsFleet,
  postShutdown: mockPostShutdown,
}));

import { gracefulStopByServerJson } from '../src/services/service-manager/index.js';

describe('gracefulStopByServerJson result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ pid: 4242, url: 'http://127.0.0.1:7523/mcp' }) as any);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function run(fallback?: (pid: number) => void): Promise<boolean> {
    const p = gracefulStopByServerJson(fallback);
    await vi.advanceTimersByTimeAsync(6000);
    return p;
  }

  it('returns true when the server exits after /shutdown', async () => {
    mockAlive.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await run()).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('returns false and keeps server.json when the surviving pid cannot be verified', async () => {
    mockAlive.mockReturnValue(true);
    mockIsFleet.mockReturnValue(null);
    const fallback = vi.fn();
    expect(await run(fallback)).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('returns false for a surviving pid that is verifiably not apra-fleet', async () => {
    mockAlive.mockReturnValue(true);
    mockIsFleet.mockReturnValue(false);
    expect(await run(vi.fn())).toBe(false);
  });

  it('force-kills a verified apra-fleet pid and returns true', async () => {
    mockAlive.mockReturnValue(true);
    mockIsFleet.mockReturnValue(true);
    const fallback = vi.fn();
    expect(await run(fallback)).toBe(true);
    expect(fallback).toHaveBeenCalledWith(4242);
  });
});
