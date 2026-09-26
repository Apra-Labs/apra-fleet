import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// T2.4 (F7, D6): server version handshake. Mocks src/cli/install.js's isSea()
// (same pattern as tests/delivery-mode.test.ts) so these tests control the
// SEA/non-SEA branch deterministically without needing a real SEA binary.
vi.mock('../src/cli/install.js', () => ({
  isSea: vi.fn(() => false),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-check-test-'));
  // Explicit default every test (not just the vi.mock() factory default):
  // mockReturnValue() sticks across tests since clearAllMocks() only wipes
  // call history, not the configured implementation -- without this, the
  // "SEA mode" describe block's mockReturnValue(true) would leak into every
  // test that runs after it in this file.
  const { isSea } = await import('../src/cli/install.js');
  vi.mocked(isSea).mockReturnValue(false);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('readDiskVersion (non-SEA)', () => {
  it('reads version.json in the given directory', async () => {
    fs.writeFileSync(path.join(tmpDir, 'version.json'), JSON.stringify({ version: '1.2.3' }));
    const { readDiskVersion } = await import('../src/services/version-check.js');
    expect(readDiskVersion(tmpDir)).toBe('v1.2.3');
  });

  it('walks up to find version.json from a nested subdirectory (findProjectRoot pattern)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'version.json'), JSON.stringify({ version: '4.5.6' }));
    const nested = path.join(tmpDir, 'dist', 'services');
    fs.mkdirSync(nested, { recursive: true });
    const { readDiskVersion } = await import('../src/services/version-check.js');
    expect(readDiskVersion(nested)).toBe('v4.5.6');
  });

  it('returns null when version.json is not found within 5 levels', async () => {
    const { readDiskVersion } = await import('../src/services/version-check.js');
    expect(readDiskVersion(tmpDir)).toBeNull();
  });

  it('returns null on malformed JSON (never throws)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'version.json'), 'not valid json{{{');
    const { readDiskVersion } = await import('../src/services/version-check.js');
    expect(() => readDiskVersion(tmpDir)).not.toThrow();
    expect(readDiskVersion(tmpDir)).toBeNull();
  });

  it('returns null when the version field is missing or not a string', async () => {
    fs.writeFileSync(path.join(tmpDir, 'version.json'), JSON.stringify({ version: 123 }));
    const { readDiskVersion } = await import('../src/services/version-check.js');
    expect(readDiskVersion(tmpDir)).toBeNull();
  });
});

describe('readDiskVersion (SEA mode)', () => {
  it('never throws when the SEA asset is unavailable -- degrades to null', async () => {
    const { isSea } = await import('../src/cli/install.js');
    vi.mocked(isSea).mockReturnValue(true);
    const { readDiskVersion } = await import('../src/services/version-check.js');
    expect(() => readDiskVersion(tmpDir)).not.toThrow();
    expect(readDiskVersion(tmpDir)).toBeNull();
  });
});

describe('checkVersionMismatch', () => {
  it('returns null when running matches disk exactly', async () => {
    fs.writeFileSync(path.join(tmpDir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
    const { checkVersionMismatch } = await import('../src/services/version-check.js');
    expect(checkVersionMismatch('v1.0.0', tmpDir)).toBeNull();
  });

  it('ignores a dev git-hash suffix on the running version when comparing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'version.json'), JSON.stringify({ version: '1.0.0' }));
    const { checkVersionMismatch } = await import('../src/services/version-check.js');
    expect(checkVersionMismatch('v1.0.0_abc123', tmpDir)).toBeNull();
  });

  it('returns {running, disk} when versions differ', async () => {
    fs.writeFileSync(path.join(tmpDir, 'version.json'), JSON.stringify({ version: '2.0.0' }));
    const { checkVersionMismatch } = await import('../src/services/version-check.js');
    expect(checkVersionMismatch('v1.0.0', tmpDir)).toEqual({ running: 'v1.0.0', disk: 'v2.0.0' });
  });

  it('returns null (omitted) when the disk version cannot be read', async () => {
    const { checkVersionMismatch } = await import('../src/services/version-check.js');
    expect(checkVersionMismatch('v1.0.0', tmpDir)).toBeNull();
  });
});
