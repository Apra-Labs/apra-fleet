/**
 * isPidAlive: EPERM (the process exists, we may not signal it -- e.g. a
 * server running elevated, seen from a normal shell) is ALIVE. Treating it
 * as dead made a non-elevated install classify the elevated server as
 * unrelated and then fail EBUSY overwriting its running binary.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPidAlive } from '../src/utils/process-utils.js';

const errno = (code: string) => Object.assign(new Error(code), { code });

describe('isPidAlive', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('EPERM is alive; ESRCH is dead; a signal-0 success is alive', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementation(() => { throw errno('EPERM'); });
    expect(isPidAlive(4242)).toBe(true);
    kill.mockImplementation(() => { throw errno('ESRCH'); });
    expect(isPidAlive(4242)).toBe(false);
    kill.mockImplementation(() => true);
    expect(isPidAlive(4242)).toBe(true);
  });

  it('install guard: a server recorded in the data dir that we may not signal is RELEVANT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-pidalive-'));
    const prev = process.env.APRA_FLEET_DATA_DIR;
    try {
      process.env.APRA_FLEET_DATA_DIR = dir;
      fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ pid: 4242, url: 'http://127.0.0.1:7523/mcp' }));
      vi.spyOn(process, 'kill').mockImplementation(() => { throw errno('EPERM'); });
      const { classifyRunningServer } = await import('../src/cli/install-guard.js');
      const scope = classifyRunningServer(path.join(dir, 'bin'));
      expect(scope.relevant).toBe(true);
      expect(scope.reason).toBe('data-dir');
    } finally {
      if (prev === undefined) delete process.env.APRA_FLEET_DATA_DIR; else process.env.APRA_FLEET_DATA_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
