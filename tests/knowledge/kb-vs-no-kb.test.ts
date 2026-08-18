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
    summary: `Handles ${path.basename(file)} logic.`,
    content: `Detailed content for ${file}`,
    source_files: [file],
    symbols: ['mainFunc'],
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-vs-no-kb-'));
  mockExecFile.mockReset();
  setupGitSuccess();
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('KB vs no-KB comparison', () => {
  it('WITHOUT KB: all files are always stale (no cached context)', async () => {
    const files = [
      path.join(tmpDir, 'registry.ts'),
      path.join(tmpDir, 'auth.ts'),
      path.join(tmpDir, 'config.ts'),
    ];
    for (const f of files) {
      fs.writeFileSync(f, `export const x = "${path.basename(f)}";`);
    }

    // Without any captures, prime always reports cold
    const result = await provider.prime({ session_files: files });
    expect(result.session_warm).toBe(false);
    expect(result.stale_files).toHaveLength(3);
    expect(result.stale_files).toEqual(expect.arrayContaining(files));
  });

  it('WITH KB: cold -> capture -> warm (0 file reads on warm session)', async () => {
    const files = [
      path.join(tmpDir, 'registry.ts'),
      path.join(tmpDir, 'auth.ts'),
      path.join(tmpDir, 'config.ts'),
    ];
    const contents = [
      'export function initRegistry() {}',
      'export function authenticate() {}',
      'export const config = {};',
    ];
    const hashes: string[] = [];
    for (let i = 0; i < files.length; i++) {
      fs.writeFileSync(files[i], contents[i]);
      hashes.push(gitBlobHash(Buffer.from(contents[i])));
    }

    // Step 1: Cold prime -- no entries yet
    const coldPrime = await provider.prime({ session_files: files });
    expect(coldPrime.session_warm).toBe(false);
    expect(coldPrime.stale_files.length).toBeGreaterThan(0);
    expect(coldPrime.stale_files).toEqual(expect.arrayContaining(files));

    // Step 2: Capture context-cache entries for all files (simulates agent reading + capturing)
    for (let i = 0; i < files.length; i++) {
      await provider.capture(makeContextCache(files[i], hashes[i]));
    }

    // Verify entries are in KB
    for (const file of files) {
      const ctx = await provider.context([file]);
      expect(ctx[0].status).toBe('fresh');
    }

    // Step 3: Warm prime -- all files are fresh
    const warmPrime = await provider.prime({ session_files: files });
    expect(warmPrime.session_warm).toBe(true);
    expect(warmPrime.stale_files).toEqual([]);
    expect(warmPrime.fresh_summaries).toHaveLength(3);
  });
});
