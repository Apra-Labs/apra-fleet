import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Same eager-FLEET_DIR-evaluation caveat as tests/join.test.ts -- fresh tmp
// dir + dynamic re-import per test, not a plain env var set after import.
let tmpDataDir: string;
let cloudSyncMod: typeof import('../src/services/cloud-sync.js');

beforeEach(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cloud-sync-test-'));
  process.env.APRA_FLEET_DATA_DIR = tmpDataDir;
  vi.resetModules();
  cloudSyncMod = await import('../src/services/cloud-sync.js');
});

afterEach(() => {
  delete process.env.APRA_FLEET_DATA_DIR;
  vi.resetModules();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

const CREDS = { hubUrl: 'https://dashboard.example.com', machineId: 'member-1', workspaceId: 'ws-1', jwt: 'the-jwt' };

function depsWithCreds(fetchImpl: typeof fetch, creds: typeof CREDS | null = CREDS, now = () => 1000) {
  return { fetch: fetchImpl, now, readCredentials: () => creds };
}

describe('syncCloudCache (apra-fleet-aho)', () => {
  it('returns not-connected when there are no hub credentials (standalone mode)', async () => {
    const fetchMock = vi.fn();
    const result = await cloudSyncMod.syncCloudCache(depsWithCreds(fetchMock, null));
    expect(result).toEqual({ status: 'not-connected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches GET /v1/ws/:id/bootstrap with the member JWT and caches the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [{ id: 'm1' }], projects: [{ id: 'p1' }] }),
    });

    const result = await cloudSyncMod.syncCloudCache(depsWithCreds(fetchMock));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dashboard.example.com/v1/ws/ws-1/bootstrap',
      expect.objectContaining({ headers: { Authorization: 'Bearer the-jwt' } }),
    );
    expect(result).toEqual({
      status: 'synced',
      cache: { workspaceId: 'ws-1', members: [{ id: 'm1' }], projects: [{ id: 'p1' }], lastSyncedAt: 1000 },
    });

    const onDisk = cloudSyncMod.readCloudCache();
    expect(onDisk).toEqual(result.status === 'synced' ? result.cache : undefined);
  });

  it('preserves unrecognized fields on members/projects (additive-only contract evolution)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [{ id: 'm1', futureField: 'x' }], projects: [] }),
    });

    const result = await cloudSyncMod.syncCloudCache(depsWithCreds(fetchMock));

    expect(result.status).toBe('synced');
    expect((result as any).cache.members[0]).toEqual({ id: 'm1', futureField: 'x' });
  });

  it('fails open to the last-synced cache on a network error, without throwing', async () => {
    const okFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ members: [{ id: 'm1' }], projects: [] }) });
    await cloudSyncMod.syncCloudCache(depsWithCreds(okFetch));

    const failingFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await cloudSyncMod.syncCloudCache(depsWithCreds(failingFetch));

    expect(result.status).toBe('offline');
    expect((result as any).cache.members).toEqual([{ id: 'm1' }]);
  });

  it('fails open to the last-synced cache on a 5xx response', async () => {
    const okFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ members: [{ id: 'm1' }], projects: [] }) });
    await cloudSyncMod.syncCloudCache(depsWithCreds(okFetch));

    const failingFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const result = await cloudSyncMod.syncCloudCache(depsWithCreds(failingFetch));

    expect(result.status).toBe('offline');
    expect((result as any).cache.members).toEqual([{ id: 'm1' }]);
  });

  it('fails open to null cache when offline and nothing was ever synced', async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await cloudSyncMod.syncCloudCache(depsWithCreds(failingFetch));
    expect(result).toEqual({ status: 'offline', cache: null });
  });

  it('does NOT fail open on 401 -- surfaces credential-expired instead of serving stale cache', async () => {
    const okFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ members: [{ id: 'm1' }], projects: [] }) });
    await cloudSyncMod.syncCloudCache(depsWithCreds(okFetch));

    const unauthorizedFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await cloudSyncMod.syncCloudCache(depsWithCreds(unauthorizedFetch));

    expect(result).toEqual({ status: 'credential-expired' });
  });
});
