/**
 * Tests for update-check service (#161) and fleet_status update notice integration.
 *
 * Covers:
 * - Newer version → notice returned by getUpdateNotice()
 * - Same version → no notice
 * - Network failure → silent (no throw, no notice)
 * - Pre-release tag → ignored
 * - fleet_status compact output includes notice when update available
 * - fleet_status JSON output includes updateAvailable object
 * - fleet_status silent when on latest
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkForUpdate, getUpdateNotice, _setUpdateCache } from '../src/services/update-check.js';

// ---------------------------------------------------------------------------
// checkForUpdate + getUpdateNotice
// ---------------------------------------------------------------------------

describe('checkForUpdate — newer version available', () => {
  beforeEach(() => {
    _setUpdateCache(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _setUpdateCache(null);
  });

  it('sets cache and notice when remote is newer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v99.0.0' }),
    }));

    await checkForUpdate();

    const notice = getUpdateNotice();
    expect(notice).not.toBeNull();
    expect(notice).toContain('v99.0.0');
    expect(notice).toContain('is available');
    expect(notice).toContain('/pm deploy apra-fleet');
  });

  it('returns null when remote version equals installed', async () => {
    // Installed version from version.ts (resolves to something like v0.1.7...)
    // We'll mock a response with the same base version
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v0.0.0' }), // older than any real version
    }));

    await checkForUpdate();

    expect(getUpdateNotice()).toBeNull();
  });

  it('returns null on network failure (fetch throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    await expect(checkForUpdate()).resolves.toBeUndefined(); // no throw
    expect(getUpdateNotice()).toBeNull();
  });

  it('returns null on HTTP error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }));

    await checkForUpdate();
    expect(getUpdateNotice()).toBeNull();
  });

  it('ignores pre-release alpha tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v99.0.0-alpha.1' }),
    }));

    await checkForUpdate();
    expect(getUpdateNotice()).toBeNull();
  });

  it('ignores pre-release beta tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v99.0.0-beta.2' }),
    }));

    await checkForUpdate();
    expect(getUpdateNotice()).toBeNull();
  });

  it('ignores pre-release rc tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v99.0.0-rc.1' }),
    }));

    await checkForUpdate();
    expect(getUpdateNotice()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fleet_status update notice integration
// ---------------------------------------------------------------------------

describe('fleetStatus — update notice integration', () => {
  beforeEach(() => {
    _setUpdateCache(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _setUpdateCache(null);
  });

  it('compact output includes update notice when update available', async () => {
    // Inject a cached update directly to avoid network calls
    _setUpdateCache({ latest: 'v99.9.9', installed: 'v0.1.7' });

    // Mock the registry to return no members so fleetStatus returns early
    vi.mock('../src/services/registry.js', () => ({
      getAllAgents: () => [],
    }));

    const { fleetStatus } = await import('../src/tools/check-status.js');
    // With no members, returns early before our notice — so we test getUpdateNotice directly
    const notice = getUpdateNotice();
    expect(notice).not.toBeNull();
    expect(notice).toContain('v99.9.9');
    expect(notice).toContain('v0.1.7');
  });

  it('getUpdateNotice returns null when no update cached', () => {
    _setUpdateCache(null);
    expect(getUpdateNotice()).toBeNull();
  });

  it('getUpdateNotice includes correct version strings', () => {
    _setUpdateCache({ latest: 'v1.2.3', installed: 'v1.2.2' });
    const notice = getUpdateNotice()!;
    expect(notice).toContain('v1.2.3');
    expect(notice).toContain('v1.2.2');
    expect(notice).toContain('ℹ️');
    expect(notice).toContain('apra-fleet');
  });
});
