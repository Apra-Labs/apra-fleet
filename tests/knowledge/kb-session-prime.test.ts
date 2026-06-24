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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prime-test-'));
  mockExecFile.mockReset();
  setupGitSuccess();
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kb_session_prime', () => {
  it('cold session: stale_files has entries, session_warm=false', async () => {
    const filePath = path.join(tmpDir, 'cold.ts');
    fs.writeFileSync(filePath, 'const cold = true;');

    const result = await provider.prime({ session_files: [filePath] });
    expect(result.session_warm).toBe(false);
    expect(result.stale_files).toContain(filePath);
  });

  it('warm session: stale_files empty, session_warm=true', async () => {
    const filePath = path.join(tmpDir, 'warm.ts');
    const content = 'const warm = true;';
    fs.writeFileSync(filePath, content);
    const hash = gitBlobHash(Buffer.from(content));

    await provider.capture(makeContextCache(filePath, hash));

    const result = await provider.prime({ session_files: [filePath] });
    expect(result.session_warm).toBe(true);
    expect(result.stale_files).toHaveLength(0);
    expect(result.fresh_summaries).toHaveLength(1);
  });

  it('recommended_code_calls is array of objects with tool+args keys', async () => {
    const result = await provider.prime({
      session_files: ['src/registry.ts'],
      hint_symbols: ['initRegistry'],
    });

    expect(Array.isArray(result.recommended_code_calls)).toBe(true);
    for (const call of result.recommended_code_calls) {
      expect(call).toHaveProperty('tool');
      expect(call).toHaveProperty('args');
      expect(typeof call.tool).toBe('string');
      expect(typeof call.args).toBe('object');
    }

    const symbolCall = result.recommended_code_calls.find(c => c.tool === 'code_context');
    expect(symbolCall).toBeDefined();
    expect(symbolCall!.args).toEqual({ name: 'initRegistry' });

    const impactCall = result.recommended_code_calls.find(c => c.tool === 'code_impact');
    expect(impactCall).toBeDefined();
    expect(impactCall!.args).toEqual({ target: 'src/registry.ts', direction: 'upstream' });
  });

  it('no hints: recommended_code_calls is empty array', async () => {
    const result = await provider.prime({});
    expect(result.recommended_code_calls).toEqual([]);
    expect(result.session_warm).toBe(true);
  });
});
