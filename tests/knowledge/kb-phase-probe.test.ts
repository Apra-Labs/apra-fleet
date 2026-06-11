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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-phase-probe-'));
  mockExecFile.mockReset();
  setupGitSuccess();
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('KB phase learning curve -- stale savings grow monotonically', () => {
  it('proves KB value accumulates across sprint phases', async () => {
    const fileNames = ['alpha.ts', 'beta.ts', 'gamma.ts', 'delta.ts', 'epsilon.ts', 'zeta.ts'];
    const fileContents = fileNames.map(name => `export const ${name.replace('.ts', '')} = "module";`);
    const files = fileNames.map((name, i) => {
      const f = path.join(tmpDir, name);
      fs.writeFileSync(f, fileContents[i]);
      return f;
    });
    const hashes = fileContents.map(c => gitBlobHash(Buffer.from(c)));

    // Phase 0 gate: KB is empty -> all 6 files are stale
    const phase0Result = await provider.prime({ session_files: files });
    const phase0Stale = phase0Result.stale_files.length;

    // Phase 1 gate: capture files A and B; also store a knowledge learning
    for (let i = 0; i < 2; i++) {
      await provider.capture(makeContextCache(files[i], hashes[i]));
    }
    await provider.capture({
      type: 'knowledge',
      title: 'caching strategy learning for sprint workflow',
      summary: 'Use lazy loading for caching strategy in sprint workflow.',
      content: 'Detailed caching strategy notes for the sprint workflow pipeline.',
      source_files: [],
      symbols: ['caching'],
      tags: ['caching', 'strategy'],
      content_hash: 'learning-hash-v1',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'test-agent',
      source: 'doer',
      confidence: 'CONFIRMED',
    });
    const phase1Result = await provider.prime({ session_files: files });
    const phase1Stale = phase1Result.stale_files.length;

    // Phase 2 gate: capture files C and D
    for (let i = 2; i < 4; i++) {
      await provider.capture(makeContextCache(files[i], hashes[i]));
    }
    const phase2Result = await provider.prime({ session_files: files });
    const phase2Stale = phase2Result.stale_files.length;

    // Query KB to verify learning is visible at phase 2
    const phase2Query = await provider.query({ type: 'knowledge', limit: 10 });

    // Phase 3 gate: capture files E and F
    for (let i = 4; i < 6; i++) {
      await provider.capture(makeContextCache(files[i], hashes[i]));
    }
    const phase3Result = await provider.prime({
      session_files: files,
      hint_symbols: ['caching'],
    });
    const phase3Stale = phase3Result.stale_files.length;

    // Learning curve: stale count decreases strictly as phase progresses
    expect(phase0Stale).toBe(6);
    expect(phase1Stale).toBeLessThan(phase0Stale);
    expect(phase2Stale).toBeLessThan(phase1Stale);
    expect(phase3Stale).toBe(0);

    // Session warm flag
    expect(phase0Result.session_warm).toBe(false);
    expect(phase3Result.session_warm).toBe(true);

    // Learning recall: stored at phase 1, visible at phase 2 and phase 3
    expect(phase2Query.results.length).toBeGreaterThan(0);
    expect(phase3Result.top_entries.some(e => e.type === 'knowledge')).toBe(true);
  });
});
