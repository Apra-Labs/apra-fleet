import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Hoist mock references so they are available inside vi.mock factories, which
// are hoisted to the top of the file before any import statements.
// ---------------------------------------------------------------------------
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

import { detectProviderAvailability, estimateIndexSize } from '../../src/services/knowledge/pre-init.js';

describe('detectProviderAvailability()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns available=true when binary exists', () => {
    mockExecFileSync.mockReturnValue('1.2.3\n');

    const result = detectProviderAvailability();

    expect(result).toEqual({ available: true, provider: 'codebase-memory-mcp', version: '1.2.3' });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'codebase-memory-mcp',
      ['--version'],
      expect.objectContaining({ encoding: 'utf-8' })
    );
  });

  it('returns available=false with error when binary missing', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('spawn codebase-memory-mcp ENOENT');
    });

    const result = detectProviderAvailability();

    expect(result.available).toBe(false);
    expect(result.provider).toBe('codebase-memory-mcp');
    expect(result.error).toBe('spawn codebase-memory-mcp ENOENT');
  });
});

describe('estimateIndexSize()', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'pre-init-test-'));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('counts files correctly in a temp repo', () => {
    writeFileSync(join(repoDir, 'a.ts'), 'a'.repeat(100));
    writeFileSync(join(repoDir, 'b.ts'), 'b'.repeat(50));
    mkdirSync(join(repoDir, 'sub'));
    writeFileSync(join(repoDir, 'sub', 'c.ts'), 'c'.repeat(25));

    const result = estimateIndexSize(repoDir);

    expect(result.fileCount).toBe(3);
    expect(result.estimatedSizeBytes).toBe(175);
  });

  it('respects .gitignore excludes', () => {
    writeFileSync(join(repoDir, '.gitignore'), 'ignored.txt\nignored-dir/\n');
    writeFileSync(join(repoDir, 'kept.ts'), 'kept');
    writeFileSync(join(repoDir, 'ignored.txt'), 'ignored');
    mkdirSync(join(repoDir, 'ignored-dir'));
    writeFileSync(join(repoDir, 'ignored-dir', 'nested.ts'), 'nested');

    const result = estimateIndexSize(repoDir);

    // .gitignore itself + kept.ts should count; ignored.txt and everything
    // under ignored-dir/ should be excluded.
    expect(result.fileCount).toBe(2);
  });
});
