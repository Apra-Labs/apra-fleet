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
  return { fetch: fetchImpl };
}

// A fleet-dashboard member JWT is a real signed JWT; join.ts only decodes
// the payload locally (it has no way to verify the signature -- only
// fleet-dashboard's backend can), so a fake unsigned header.payload.sig
// with the right claims shape is a faithful test double.
function fakeMemberJwt(claims: { sub: string; ws: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fake-signature`;
}

describe('apra-fleet join <member-jwt> (apra-fleet-6bf)', () => {
  it('prints usage and sets a non-zero exit code when no token is given', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await joinMod.runJoin([], fakeDeps(vi.fn() as any));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it('rejects a malformed token before making any network call', async () => {
    const fetchMock = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await joinMod.runJoin(['not-a-jwt'], fakeDeps(fetchMock));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid member JWT'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it('rejects a token whose payload is missing ws/sub claims', async () => {
    const badToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`;
    const fetchMock = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await joinMod.runJoin([badToken], fakeDeps(fetchMock));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('missing workspace (ws) or member (sub) claim'));
    expect(fetchMock).not.toHaveBeenCalled();
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it('calls fleet-dashboard connect with the decoded workspace/member ids and stores credentials locally', async () => {
    const token = fakeMemberJwt({ sub: 'member-1', ws: 'ws-1' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ member: { id: 'member-1', name: 'alice' } }),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await joinMod.runJoin([token, '--hub-url', 'https://custom-dashboard.example.com'], fakeDeps(fetchMock));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom-dashboard.example.com/v1/ws/ws-1/members/member-1/connect',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );

    const stored = JSON.parse(fs.readFileSync(joinMod.HUB_CREDENTIALS_PATH, 'utf-8'));
    expect(stored).toEqual({
      hubUrl: 'https://custom-dashboard.example.com',
      machineId: 'member-1',
      workspaceId: 'ws-1',
      jwt: token,
    });
    logSpy.mockRestore();
  });

  it('defaults to APRA_FLEET_HUB_URL env var, then the public dashboard URL, when --hub-url is omitted', async () => {
    process.env.APRA_FLEET_HUB_URL = 'https://env-dashboard.example.com';
    const token = fakeMemberJwt({ sub: 'm', ws: 'ws' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ member: { id: 'm' } }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await joinMod.runJoin([token], fakeDeps(fetchMock));

    expect(fetchMock).toHaveBeenCalledWith('https://env-dashboard.example.com/v1/ws/ws/members/m/connect', expect.anything());
  });

  it('reports a clear error and sets exitCode=1 when fleet-dashboard rejects the token', async () => {
    const token = fakeMemberJwt({ sub: 'member-1', ws: 'ws-1' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"invalid_token"}' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await joinMod.runJoin([token], fakeDeps(fetchMock));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('401'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(fs.existsSync(joinMod.HUB_CREDENTIALS_PATH)).toBe(false);
    errorSpy.mockRestore();
  });

  it('reports a clear error and sets exitCode=1 when fleet-dashboard is unreachable', async () => {
    const token = fakeMemberJwt({ sub: 'member-1', ws: 'ws-1' });
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await joinMod.runJoin([token], fakeDeps(fetchMock));

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Could not reach fleet-dashboard'));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });
});
