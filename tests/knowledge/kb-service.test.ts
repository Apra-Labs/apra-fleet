import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// Hoist mock so it is available in the vi.mock factory (vitest hoists vi.mock calls)
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { computeFileHash, computeFileHashBatch, checkStaleness } from '../../src/services/knowledge/kb-service.js';
import type { KBEntry } from '../../src/services/knowledge/types.js';

// Compute the git blob hash the same way git does: "blob <size>\0<content>"
function gitBlobHash(data: Buffer): string {
  const header = Buffer.from(`blob ${data.length}\0`);
  return createHash('sha1').update(header).update(data).digest('hex');
}

// Make execFile behave like real git hash-object for existing files
function setupGitSuccess(): void {
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    const fileArgs = (allArgs[1] as string[]).slice(1); // ['hash-object', ...files] -> files
    const hashes = fileArgs.map((f: string) => {
      try {
        const data = fs.readFileSync(f) as Buffer;
        return gitBlobHash(data);
      } catch {
        return '';
      }
    });
    cb(null, hashes.join('\n') + '\n', '');
  });
}

// Make git fail unconditionally
function setupGitFailure(): void {
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    cb(new Error('git: command not found'), '', '');
  });
}

function makeEntry(overrides: Partial<KBEntry> = {}): KBEntry {
  return {
    id: 'test-entry-id',
    type: 'context-cache',
    title: 'Test Entry',
    summary: 'A test entry summary.',
    content: 'Test content body.',
    source_files: [],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'git',
    stale: false,
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    created_at: new Date().toISOString(),
    use_count: 0,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-service-test-'));
  mockExecFile.mockReset();
  setupGitSuccess();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeFileHash', () => {
  it('returns git hash for a fresh file (hash matches)', async () => {
    const filePath = path.join(tmpDir, 'fresh.ts');
    const content = 'export const x = 1;';
    fs.writeFileSync(filePath, content);

    const result = await computeFileHash(filePath);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('git');
    expect(result!.hash).toBe(gitBlobHash(Buffer.from(content)));
  });

  it('returns null for a non-existent file', async () => {
    const result = await computeFileHash(path.join(tmpDir, 'does-not-exist.ts'));
    expect(result).toBeNull();
  });

  it('falls back to sha256 when git is unavailable (non-git file)', async () => {
    setupGitFailure();

    const filePath = path.join(tmpDir, 'nongit.ts');
    const content = 'const fallback = true;';
    fs.writeFileSync(filePath, content);

    const result = await computeFileHash(filePath);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('sha256');
    const expectedHash = createHash('sha256').update(Buffer.from(content)).digest('hex');
    expect(result!.hash).toBe(expectedHash);
  });
});

describe('computeFileHashBatch', () => {
  it('hashes 3 files with a single git subprocess call', async () => {
    const files = [
      path.join(tmpDir, 'a.ts'),
      path.join(tmpDir, 'b.ts'),
      path.join(tmpDir, 'c.ts'),
    ];
    for (const [i, f] of files.entries()) {
      fs.writeFileSync(f, `const x${i} = ${i};`);
    }

    const result = await computeFileHashBatch(files);

    // Exactly one git subprocess call for all 3 files
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const callArgs = mockExecFile.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('git');
    expect((callArgs[1] as string[])[0]).toBe('hash-object');

    expect(Object.keys(result)).toHaveLength(3);
    for (const f of files) {
      expect(result[f]).not.toBeNull();
      expect(result[f]!.type).toBe('git');
    }
  });
});

describe('checkStaleness', () => {
  it('returns stale=false when file hash matches stored hash', async () => {
    const filePath = path.join(tmpDir, 'match.ts');
    const content = 'const match = "yes";';
    fs.writeFileSync(filePath, content);
    const hash = gitBlobHash(Buffer.from(content));

    const entry = makeEntry({ source_files: [filePath], content_hash: hash, content_hash_type: 'git' });
    const result = await checkStaleness(entry);

    expect(result.stale).toBe(false);
  });

  it('returns stale=true when file hash does not match (modified file)', async () => {
    const filePath = path.join(tmpDir, 'modified.ts');
    const originalContent = 'const v = 1;';
    fs.writeFileSync(filePath, originalContent);
    const oldHash = gitBlobHash(Buffer.from(originalContent));

    // Modify the file after storing the hash
    fs.writeFileSync(filePath, 'const v = 999; // changed');

    const entry = makeEntry({ source_files: [filePath], content_hash: oldHash, content_hash_type: 'git' });
    const result = await checkStaleness(entry);

    expect(result.stale).toBe(true);
  });

  it('returns stale=true with reason file_missing when source file is deleted', async () => {
    const filePath = path.join(tmpDir, 'deleted.ts');
    // File does not exist
    const entry = makeEntry({ source_files: [filePath], content_hash: 'abc123', content_hash_type: 'git' });

    const result = await checkStaleness(entry);

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('file_missing');
  });

  it('returns stale=true with reason unreadable when file cannot be read (EACCES)', async () => {
    const filePath = path.join(tmpDir, 'locked.ts');
    fs.writeFileSync(filePath, 'locked content');

    // Spy on readFileSync to simulate EACCES for this file
    const realReadFileSync = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === filePath) {
        const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
        throw err;
      }
      return realReadFileSync(...args);
    });

    // Use sha256 type so checkStaleness goes straight to readFileSync (no git call)
    const entry = makeEntry({ source_files: [filePath], content_hash: 'old', content_hash_type: 'sha256' });

    try {
      const result = await checkStaleness(entry);
      expect(result.stale).toBe(true);
      expect(result.reason).toBe('unreadable');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns stale=true immediately when content_hash is "invalidated"', async () => {
    const entry = makeEntry({
      source_files: [path.join(tmpDir, 'any.ts')],
      content_hash: 'invalidated',
      content_hash_type: 'git',
    });

    const result = await checkStaleness(entry);

    expect(result.stale).toBe(true);
    expect(result.reason).toBe('invalidated');
  });

  it('returns stale=false for non-context-cache entry regardless of hash', async () => {
    const entry = makeEntry({ type: 'learning', content_hash: 'whatever' });
    const result = await checkStaleness(entry);
    expect(result.stale).toBe(false);
  });
});
