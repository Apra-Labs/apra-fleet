import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('runUpdate - npm redirect path (T8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('npm mode: prints npm update command and skill-refresh reminder, no fetch', async () => {
    vi.resetModules();
    vi.doMock('../src/cli/install.js', () => ({
      isSea: vi.fn(() => false),
      isNpmGlobalInstall: vi.fn(() => true),
      _setSeaOverride: vi.fn(),
    }));

    const { runUpdate: runUpdateNpm } = await import('../src/cli/update.js');

    await runUpdateNpm();

    expect(console.log).toHaveBeenCalledWith('apra-fleet is installed via npm. To update, run:');
    expect(console.log).toHaveBeenCalledWith('  npm update -g @apralabs/apra-fleet');
    expect(console.log).toHaveBeenCalledWith('');
    expect(console.log).toHaveBeenCalledWith('After updating, re-install skills and hooks:');
    expect(console.log).toHaveBeenCalledWith('  apra-fleet install');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    vi.doUnmock('../src/cli/install.js');
  });

  it('dev mode: prints dev-mode message without fetch', async () => {
    vi.resetModules();
    vi.doMock('../src/cli/install.js', () => ({
      isSea: vi.fn(() => false),
      isNpmGlobalInstall: vi.fn(() => false),
      _setSeaOverride: vi.fn(),
    }));

    const { runUpdate: runUpdateDev } = await import('../src/cli/update.js');

    await runUpdateDev();

    expect(console.log).toHaveBeenCalledWith('apra-fleet is running in dev mode. Pull the latest source and rebuild.');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    vi.doUnmock('../src/cli/install.js');
  });

  it('SEA mode: falls through to existing fetch logic (confirms early return not triggered)', async () => {
    vi.resetModules();
    vi.doMock('../src/cli/install.js', () => ({
      isSea: vi.fn(() => true),
      isNpmGlobalInstall: vi.fn(() => false),
      _setSeaOverride: vi.fn(),
    }));

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
    } as any);

    const { runUpdate: runUpdateSea } = await import('../src/cli/update.js');

    await runUpdateSea();

    expect(vi.mocked(fetch)).toHaveBeenCalled();

    vi.doUnmock('../src/cli/install.js');
  });
});
