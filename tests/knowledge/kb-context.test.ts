import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function gitBlobHash(data: Buffer): string {
  const header = Buffer.from(`blob ${data.length}\0`);
  return createHash('sha1').update(header).update(data).digest('hex');
}

function setupGitSuccess(): void {
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    const fileArgs = (allArgs[1] as string[]).slice(1);
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

function makeContextCache(file: string, hash: string): KBEntryInput {
  return {
    type: 'context-cache',
    title: `Summary of ${path.basename(file)}`,
    summary: `This file handles ${path.basename(file)} logic.`,
    content: `Detailed content for ${file}`,
    source_files: [file],
    symbols: ['someFunc'],
    tags: [],
    content_hash: hash,
    content_hash_type: 'git',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

let provider: SqliteProvider;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-context-test-'));
  mockExecFile.mockReset();
  setupGitSuccess();
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kb_context', () => {
  it('returns fresh for a file with matching hash', async () => {
    const filePath = path.join(tmpDir, 'fresh.ts');
    const content = 'export const x = 1;';
    fs.writeFileSync(filePath, content);
    const hash = gitBlobHash(Buffer.from(content));

    await provider.capture(makeContextCache(filePath, hash));

    const results = await provider.context([filePath]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fresh');
    expect(results[0].summary).toBe(`This file handles fresh.ts logic.`);
    expect(results[0].entry_id).toBeTruthy();
  });

  it('returns stale for a file with mismatched hash', async () => {
    const filePath = path.join(tmpDir, 'stale.ts');
    fs.writeFileSync(filePath, 'const v = 1;');
    const oldHash = 'stale-hash-that-wont-match';

    await provider.capture(makeContextCache(filePath, oldHash));

    const results = await provider.context([filePath]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('stale');
    expect(results[0].reason).toBe('hash_mismatch');
    expect(results[0].entry_id).toBeTruthy();
  });

  it('returns missing for a file with no KB entry', async () => {
    const filePath = path.join(tmpDir, 'unknown.ts');
    fs.writeFileSync(filePath, 'const y = 2;');

    const results = await provider.context([filePath]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('missing');
    expect(results[0].file).toBe(filePath);
  });

  it('batch: 3 files checked with a single git subprocess call', async () => {
    const files = [
      path.join(tmpDir, 'a.ts'),
      path.join(tmpDir, 'b.ts'),
      path.join(tmpDir, 'c.ts'),
    ];
    for (const [i, f] of files.entries()) {
      const content = `const x${i} = ${i};`;
      fs.writeFileSync(f, content);
      const hash = gitBlobHash(Buffer.from(content));
      await provider.capture(makeContextCache(f, hash));
    }

    mockExecFile.mockReset();
    setupGitSuccess();

    const results = await provider.context(files);
    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'fresh')).toBe(true);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const callArgs = mockExecFile.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('git');
    expect((callArgs[1] as string[])[0]).toBe('hash-object');
  });
});
