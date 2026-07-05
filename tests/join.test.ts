import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// FLEET_DIR (src/paths.ts) reads APRA_FLEET_DATA_DIR once at module load
// time -- same eager-evaluation shape as jwt.ts's KEY_PATH and
// http-transport.ts's DEFAULT_HOST -- so a fresh tmp dir + dynamic
// re-import per test is required, not a plain env var set after import.
let tmpDataDir: string;
let joinMod: typeof import('../src/cli/join.js');

beforeEach(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-join-test-'));
  process.env.APRA_FLEET_DATA_DIR = tmpDataDir;
  vi.resetModules();
  joinMod = await import('../src/cli/join.js');
});

afterEach(() => {
  delete process.env.APRA_FLEET_DATA_DIR;
  delete process.env.APRA_FLEET_HUB_URL;
  vi.resetModules();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

function fakeDeps(fetchImpl: typeof fetch) {
  return { fetch: fetchImpl, hostname: () => 'test-hostname' };
}

describe('apra-fleet join <token> (apra-fleet-us9.5/fnz.4)', () => {
  it('prints usage and sets a non-zero exit code when no token is given', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await joinMod.runJoin([], fakeDeps(vi.fn() as any));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it('exchanges the token with the hub and stores the resulting credentials locally', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ machineId: 'm-1', workspaceId: 'ws-1', jwt: 'the-jwt' }),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await joinMod.runJoin(['tok-123', '--hub-url', 'https://custom-hub.example.com'], fakeDeps(fetchMock));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom-hub.example.com/join/exchange',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'tok-123', hostname: 'test-hostname' }),
      }),
    );

    const stored = JSON.parse(fs.readFileSync(joinMod.HUB_CREDENTIALS_PATH, 'utf-8'));
    expect(stored).toEqual({
      hubUrl: 'https://custom-hub.example.com',
      machineId: 'm-1',
      workspaceId: 'ws-1',
      jwt: 'the-jwt',
    });
    logSpy.mockRestore();
  });

  it('defaults to APRA_FLEET_HUB_URL env var, then the public hub URL, when --hub-url is omitted', async () => {
    process.env.APRA_FLEET_HUB_URL = 'https://env-hub.example.com';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ machineId: 'm', workspaceId: 'ws', jwt: 'j' }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await joinMod.runJoin(['tok'], fakeDeps(fetchMock));

    expect(fetchMock).toHaveBeenCalledWith('https://env-hub.example.com/join/exchange', expect.anything());
  });

  it('reports a clear error and sets exitCode=1 when the hub rejects the token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"invalid, expired, or already-used token"}' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await joinMod.runJoin(['bad-token'], fakeDeps(fetchMock));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('401'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(fs.existsSync(joinMod.HUB_CREDENTIALS_PATH)).toBe(false);
    errorSpy.mockRestore();
  });

  it('reports a clear error and sets exitCode=1 when the hub is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await joinMod.runJoin(['tok'], fakeDeps(fetchMock));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Could not reach hub'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });
});
