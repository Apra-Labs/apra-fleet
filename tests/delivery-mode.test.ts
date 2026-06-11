import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDeliveryMode, getDeliveryInfo } from '../src/delivery-mode.js';

// Mock the install module so we can control isSea() and isNpmGlobalInstall()
vi.mock('../src/cli/install.js', () => ({
  isSea: vi.fn(() => false),
  isNpmGlobalInstall: vi.fn(() => false),
}));

describe('getDeliveryMode()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns "sea" when isSea() is true', async () => {
    // Dynamically re-import to get fresh mock state
    const { isSea } = await import('../src/cli/install.js');
    vi.mocked(isSea).mockReturnValue(true);

    const { getDeliveryMode: getMode } = await import('../src/delivery-mode.js');
    const result = getMode();

    expect(result).toBe('sea');
  });

  it('returns "npm" when isSea() is false and isNpmGlobalInstall() is true', async () => {
    const { isSea, isNpmGlobalInstall } = await import('../src/cli/install.js');
    vi.mocked(isSea).mockReturnValue(false);
    vi.mocked(isNpmGlobalInstall).mockReturnValue(true);

    const { getDeliveryMode: getMode } = await import('../src/delivery-mode.js');
    const result = getMode();

    expect(result).toBe('npm');
  });

  it('returns "dev" when both isSea() and isNpmGlobalInstall() are false', async () => {
    const { isSea, isNpmGlobalInstall } = await import('../src/cli/install.js');
    vi.mocked(isSea).mockReturnValue(false);
    vi.mocked(isNpmGlobalInstall).mockReturnValue(false);

    const { getDeliveryMode: getMode } = await import('../src/delivery-mode.js');
    const result = getMode();

    expect(result).toBe('dev');
  });
});

describe('getDeliveryInfo()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns binary = process.execPath when mode is "sea"', async () => {
    const { isSea, isNpmGlobalInstall } = await import('../src/cli/install.js');
    vi.mocked(isSea).mockReturnValue(true);
    vi.mocked(isNpmGlobalInstall).mockReturnValue(false);

    const { getDeliveryInfo: getInfo } = await import('../src/delivery-mode.js');
    const info = getInfo();

    expect(info.mode).toBe('sea');
    expect(info.binary).toBe(process.execPath);
    expect(info.nodeVersion).toBe(process.version);
  });

  it('returns binary = process.argv[1] when mode is "npm"', async () => {
    const origArgv1 = process.argv[1];
    const npmBinary = '/home/user/.npm/_npx/abc123/lib/node_modules/@apralabs/apra-fleet/dist/index.js';
    process.argv[1] = npmBinary;

    const { isSea, isNpmGlobalInstall } = await import('../src/cli/install.js');
    vi.mocked(isSea).mockReturnValue(false);
    vi.mocked(isNpmGlobalInstall).mockReturnValue(true);

    const { getDeliveryInfo: getInfo } = await import('../src/delivery-mode.js');
    const info = getInfo();

    expect(info.mode).toBe('npm');
    expect(info.binary).toBe(npmBinary);
    expect(info.nodeVersion).toBe(process.version);

    process.argv[1] = origArgv1;
  });

  it('returns binary = process.argv[1] when mode is "dev"', async () => {
    const origArgv1 = process.argv[1];
    const devBinary = '/some/project/path/dist/index.js';
    process.argv[1] = devBinary;

    const { isSea, isNpmGlobalInstall } = await import('../src/cli/install.js');
    vi.mocked(isSea).mockReturnValue(false);
    vi.mocked(isNpmGlobalInstall).mockReturnValue(false);

    const { getDeliveryInfo: getInfo } = await import('../src/delivery-mode.js');
    const info = getInfo();

    expect(info.mode).toBe('dev');
    expect(info.binary).toBe(devBinary);
    expect(info.nodeVersion).toBe(process.version);

    process.argv[1] = origArgv1;
  });

  it('returns mode that matches getDeliveryMode() result', async () => {
    const { isSea, isNpmGlobalInstall } = await import('../src/cli/install.js');

    // Test SEA mode
    vi.mocked(isSea).mockReturnValue(true);
    vi.mocked(isNpmGlobalInstall).mockReturnValue(false);
    const { getDeliveryMode: getMode, getDeliveryInfo: getInfo } = await import('../src/delivery-mode.js');
    let mode = getMode();
    let info = getInfo();
    expect(info.mode).toBe(mode);
    expect(info.mode).toBe('sea');

    // Re-import to reset cache, then test NPM mode.
    // Note: vi.mock() is hoisted to module scope at transform time and has no
    // effect when called inside a test body.  The NPM-mode assertion below is
    // driven by vi.mocked(isSea2/isNpmGlobalInstall2).mockReturnValue() below.
    vi.resetModules();
    const { getDeliveryMode: getMode2, getDeliveryInfo: getInfo2 } = await import('../src/delivery-mode.js');
    const { isSea: isSea2, isNpmGlobalInstall: isNpmGlobalInstall2 } = await import('../src/cli/install.js');
    vi.mocked(isSea2).mockReturnValue(false);
    vi.mocked(isNpmGlobalInstall2).mockReturnValue(true);
    mode = getMode2();
    info = getInfo2();
    expect(info.mode).toBe(mode);
    expect(info.mode).toBe('npm');
  });
});
