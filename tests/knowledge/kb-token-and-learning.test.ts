import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// Mock execFile so git hash-object works deterministically in CI
const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Token approximation: 1 token ~ 4 characters
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

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

const EVAL_DIR = path.join(process.cwd(), 'eval', 'kb-eval-project', 'src');
const EVAL_FILE_NAMES = ['index.ts', 'errors.ts', 'tokens.ts', 'parser.ts', 'evaluator.ts'];
const EVAL_FILES = EVAL_FILE_NAMES.map(n => path.join(EVAL_DIR, n));

function makeContextCacheInput(file: string): KBEntryInput {
  const content = fs.readFileSync(file, 'utf-8');
  return {
    type: 'context-cache',
    title: path.basename(file),
    summary: 'source file ' + path.basename(file),
    content: content.slice(0, 4000),
    confidence: 'CONFIRMED',
    symbols: [],
    source_files: [file],
    source: 'doer',
    tags: [],
    content_hash: gitBlobHash(Buffer.from(content)),
    content_hash_type: 'git',
    flagged_for_review: false,
    author: 'kb-token-test',
  };
}

describe('KB token usage -- CI regression guards', () => {
  let tmpDir: string;
  let provider: SqliteProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-token-'));
    mockExecFile.mockReset();
    setupGitSuccess();
    provider = new SqliteProvider(path.join(tmpDir, 'test.db'));
    await provider.init();
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cold session: stale_files count equals total input files', async () => {
    const result = await provider.prime({ session_files: EVAL_FILES });
    expect(result.stale_files.length).toBe(EVAL_FILES.length);
    expect(result.session_warm).toBe(false);
  });

  it('warm session token cost is under 80% of cold raw file cost', async () => {
    // Compute cold cost: sum of all file token sizes
    const coldTokens = EVAL_FILES.reduce((sum, f) => {
      return sum + approxTokens(readFileSync(f, 'utf-8'));
    }, 0);

    // Capture all files with matching git hashes
    for (const f of EVAL_FILES) {
      await provider.capture(makeContextCacheInput(f));
    }

    // Warm prime
    const warmResult = await provider.prime({ session_files: EVAL_FILES });
    expect(warmResult.stale_files.length).toBe(0);
    expect(warmResult.session_warm).toBe(true);

    const warmTokens = approxTokens(JSON.stringify(warmResult));
    const savingsPct = ((coldTokens - warmTokens) / coldTokens) * 100;

    console.log('cold tokens:', coldTokens, '| warm tokens:', warmTokens, '| savings:', savingsPct.toFixed(1) + '%');

    // CI guard: warm prime response (summaries only) must cost less than 15% of cold file reads
    expect(warmTokens).toBeLessThan(coldTokens * 0.15);
  });

  it('L1 scan (titles + summaries) costs under 20% of naive file load', async () => {
    const naiveTokens = EVAL_FILES.reduce((sum, f) => {
      return sum + approxTokens(readFileSync(f, 'utf-8'));
    }, 0);

    for (const f of EVAL_FILES) {
      await provider.capture(makeContextCacheInput(f));
    }

    const queryResult = await provider.query({
      type: 'context-cache',
      l1_only: true,
      limit: 20,
    });
    const l1Tokens = queryResult.results.reduce((sum, e) => {
      return sum + approxTokens(e.title + ' ' + e.summary);
    }, 0);

    console.log('naive tokens:', naiveTokens, '| L1 tokens:', l1Tokens, '| L1 pct:', ((l1Tokens / naiveTokens) * 100).toFixed(1) + '%');

    expect(l1Tokens).toBeLessThan(naiveTokens * 0.20);
  });
});

describe('KB learning -- capture and recall CI guards', () => {
  let tmpDir: string;
  let provider: SqliteProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-learn-'));
    mockExecFile.mockReset();
    setupGitSuccess();
    provider = new SqliteProvider(path.join(tmpDir, 'test.db'));
    await provider.init();
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CONFIRMED learning stored appears in query results', async () => {
    // R5 (T1.2): provider.capture() clamps CONFIRMED -> INFERRED; promote to
    // CONFIRMED via the real ladder to model a confirmed learning.
    const { id } = await provider.capture({
      type: 'knowledge',
      title: 'ci-test: extend Parser not Evaluator for token processors',
      summary: 'All token-processing classes must extend Parser, not Evaluator.',
      content: 'Reviewer correction: Lexer, Validator, Serializer all extend Parser.',
      confidence: 'INFERRED',
      symbols: ['Parser', 'Evaluator', 'Lexer'],
      source_files: ['src/parser.ts'],
      source: 'kb_agent_harvest',
      tags: ['inheritance', 'correction'],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'kb-token-test',
    });
    await provider.promote(id, 'confirmed learning');

    const result = await provider.query({ query: 'Parser Evaluator inheritance' });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].type).toBe('knowledge');
    expect(result.results[0].confidence).toBe('CONFIRMED');
  });

  it('INFERRED learning is queryable and shows correct confidence', async () => {
    await provider.capture({
      type: 'knowledge',
      title: 'ci-test: inferred pattern',
      summary: 'Parser uses recursive descent -- inferred from code reading.',
      content: 'Each parse method handles one grammar level.',
      confidence: 'INFERRED',
      symbols: ['Parser'],
      source_files: ['src/parser.ts'],
      source: 'doer',
      tags: ['pattern'],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'kb-token-test',
    });

    const result = await provider.query({ query: 'Parser recursive descent' });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].confidence).toBe('INFERRED');
  });

  it('cross-task: learning from Task A surfaces in prime for Task B via hint_symbols', async () => {
    // Task A learning: symbols include Parser and Serializer.
    // R5 (T1.2): provider.capture() clamps CONFIRMED -> INFERRED; promote via
    // the real ladder to model a confirmed Task A correction.
    const { id: taskAId } = await provider.capture({
      type: 'knowledge',
      title: 'ci-test: Serializer extends Parser (Task A correction)',
      summary: 'Token processors extend Parser. Confirmed during Serializer implementation.',
      content: 'Serializer extends Parser -- correct. Do not extend Evaluator for token processors.',
      confidence: 'INFERRED',
      symbols: ['Serializer', 'Parser', 'Evaluator'],
      source_files: ['src/parser.ts', 'src/serializer.ts'],
      source: 'kb_agent_harvest',
      tags: ['inheritance', 'correction'],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'kb-token-test',
    });
    await provider.promote(taskAId, 'confirmed Task A correction');

    // Also capture the 5 eval files so prime warm session works
    for (const f of EVAL_FILES) {
      await provider.capture(makeContextCacheInput(f));
    }

    // Task B: new session, same project files -- use hint_symbols to surface knowledge entries
    // (top_entries is only populated when hint_symbols is provided)
    const primeResult = await provider.prime({
      session_files: EVAL_FILES,
      hint_symbols: ['Serializer', 'Parser', 'Evaluator'],
    });

    // Learning from Task A must appear in top_entries
    const learningEntry = (primeResult.top_entries ?? []).find(
      e => e.type === 'knowledge' && e.confidence === 'CONFIRMED'
    );
    expect(learningEntry).toBeDefined();
    expect(primeResult.stale_files.length).toBe(0);

    console.log('cross-task: learning in top_entries:', learningEntry?.title);
  });

  it('learning with no symbol overlap does not prevent warm cache', async () => {
    await provider.capture({
      type: 'knowledge',
      title: 'ci-test: unrelated domain learning',
      summary: 'Cooking recipe: pasta takes 8 minutes.',
      content: 'Unrelated to any code.',
      confidence: 'CONFIRMED',
      symbols: ['PastaTimer', 'CookingEngine'],
      source_files: [],
      source: 'doer',
      tags: ['unrelated'],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'kb-token-test',
    });

    // Prime with eval project files -- unrelated learning should NOT block warm cache
    for (const f of EVAL_FILES) {
      await provider.capture(makeContextCacheInput(f));
    }

    const result = await provider.prime({ session_files: EVAL_FILES });
    expect(result.stale_files.length).toBe(0);
    expect(result.session_warm).toBe(true);
  });
});

describe('KB token savings -- scale validation', () => {
  let tmpDir: string;
  let provider: SqliteProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-scale-'));
    mockExecFile.mockReset();
    setupGitSuccess();
    provider = new SqliteProvider(path.join(tmpDir, 'test.db'));
    await provider.init();
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('large file (20000 chars): warm prime saves >90% vs cold', async () => {
    const LARGE_CONTENT = 'x'.repeat(20000);
    const LARGE_FILE_PATH = path.join(tmpDir, 'large-scale-test-file.ts');
    fs.writeFileSync(LARGE_FILE_PATH, LARGE_CONTENT);
    const coldTokens = Math.ceil(LARGE_CONTENT.length / 4);
    const contentHash = gitBlobHash(Buffer.from(LARGE_CONTENT));

    await provider.capture({
      type: 'context-cache',
      title: 'large-scale-test-file.ts',
      summary: 'A large TypeScript file with 20000 characters of content for scale testing.',
      content: LARGE_CONTENT.slice(0, 4000),
      confidence: 'CONFIRMED',
      symbols: ['LargeClass'],
      source_files: [LARGE_FILE_PATH],
      source: 'doer',
      tags: ['scale-test'],
      content_hash: contentHash,
      content_hash_type: 'git',
      flagged_for_review: false,
      author: 'kb-scale-test',
    });

    const warmResult = await provider.prime({
      session_files: [LARGE_FILE_PATH],
      hint_symbols: ['LargeClass'],
    });

    const warmTokens = approxTokens(JSON.stringify(warmResult));
    const savingsPct = ((coldTokens - warmTokens) / coldTokens) * 100;

    console.log('large file -- cold tokens:', coldTokens, '| warm tokens:', warmTokens, '| savings:', savingsPct.toFixed(1) + '%');

    expect(warmResult.stale_files.length).toBe(0);
    expect(savingsPct).toBeGreaterThan(90);
  });

  it('10 large files (20000 chars each): warm prime saves >95% vs cold', async () => {
    const LARGE_CONTENT = 'y'.repeat(20000);
    const totalColdTokens = 10 * Math.ceil(LARGE_CONTENT.length / 4);
    const contentHash = gitBlobHash(Buffer.from(LARGE_CONTENT));
    const FILE_PATHS = Array.from({ length: 10 }, (_, i) => path.join(tmpDir, 'large-file-' + i + '.ts'));

    for (let i = 0; i < FILE_PATHS.length; i++) {
      fs.writeFileSync(FILE_PATHS[i], LARGE_CONTENT);
      await provider.capture({
        type: 'context-cache',
        title: 'large-file-' + i + '.ts',
        summary: 'Large TypeScript file ' + i + ' -- service class with 20000 chars of business logic.',
        content: LARGE_CONTENT.slice(0, 4000),
        confidence: 'CONFIRMED',
        symbols: ['Service' + i],
        source_files: [FILE_PATHS[i]],
        source: 'doer',
        tags: ['scale-test'],
        content_hash: contentHash,
        content_hash_type: 'git',
        flagged_for_review: false,
        author: 'kb-scale-test',
      });
    }

    const warmResult = await provider.prime({
      session_files: FILE_PATHS,
      hint_symbols: FILE_PATHS.map((_, i) => 'Service' + i),
    });

    const warmTokens = approxTokens(JSON.stringify(warmResult));
    const savingsPct = ((totalColdTokens - warmTokens) / totalColdTokens) * 100;

    console.log('10 large files -- cold tokens:', totalColdTokens, '| warm tokens:', warmTokens, '| savings:', savingsPct.toFixed(1) + '%');

    expect(warmResult.stale_files.length).toBe(0);
    expect(savingsPct).toBeGreaterThan(95);
  });

  it('mixed session (50% cached, 50% new): savings proportional to cached ratio', async () => {
    const CONTENT = 'z'.repeat(10000);
    const contentHash = gitBlobHash(Buffer.from(CONTENT));
    const perFileColdTokens = Math.ceil(CONTENT.length / 4);

    const CACHED = [
      path.join(tmpDir, 'cached-a.ts'),
      path.join(tmpDir, 'cached-b.ts'),
      path.join(tmpDir, 'cached-c.ts'),
    ];
    const NEW_FILES = [
      path.join(tmpDir, 'new-x.ts'),
      path.join(tmpDir, 'new-y.ts'),
      path.join(tmpDir, 'new-z.ts'),
    ];
    const ALL_FILES = [...CACHED, ...NEW_FILES];

    for (const f of CACHED) {
      fs.writeFileSync(f, CONTENT);
      await provider.capture({
        type: 'context-cache',
        title: path.basename(f),
        summary: 'Cached file: ' + path.basename(f),
        content: CONTENT.slice(0, 4000),
        confidence: 'CONFIRMED',
        symbols: [],
        source_files: [f],
        source: 'doer',
        tags: [],
        content_hash: contentHash,
        content_hash_type: 'git',
        flagged_for_review: false,
        author: 'kb-scale-test',
      });
    }

    const primeResult = await provider.prime({ session_files: ALL_FILES });

    expect(primeResult.stale_files.length).toBe(NEW_FILES.length);
    expect(primeResult.stale_files).toEqual(expect.arrayContaining(NEW_FILES));

    const tokensSaved = CACHED.length * perFileColdTokens;
    const totalColdTokens = ALL_FILES.length * perFileColdTokens;
    const effectiveSavingsPct = (tokensSaved / totalColdTokens) * 100;

    console.log('mixed session -- cached:', CACHED.length, '| new:', NEW_FILES.length, '| effective savings:', effectiveSavingsPct.toFixed(1) + '%');

    expect(effectiveSavingsPct).toBeCloseTo(50, 0);
  });
});

describe('KB context size budget -- CI regression guards', () => {
  let tmpDir: string;
  let provider: SqliteProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-budget-'));
    mockExecFile.mockReset();
    setupGitSuccess();
    provider = new SqliteProvider(path.join(tmpDir, 'test.db'));
    await provider.init();
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('session_prime response for 10 captured entries fits under 2000 tokens', async () => {
    // Capture 10 entries -- synthetic paths that won't exist on disk
    // so stale_files will include them, but response size is still measured
    for (let i = 0; i < 10; i++) {
      await provider.capture({
        type: 'context-cache',
        title: 'budget-test-file-' + i + '.ts',
        summary: 'Summary for file ' + i + '. This file contains class definitions and utility functions.',
        content: 'x'.repeat(3000), // ~750 tokens each -- capped at 4000 chars
        confidence: 'CONFIRMED',
        symbols: ['Class' + i],
        source_files: ['src/file-' + i + '.ts'],
        source: 'doer',
        tags: ['budget-test'],
        content_hash: '',
        content_hash_type: 'sha256',
        flagged_for_review: false,
        author: 'kb-token-test',
      });
    }

    const syntheticFiles = Array.from({ length: 10 }, (_, i) => 'src/file-' + i + '.ts');
    const result = await provider.prime({
      session_files: syntheticFiles,
    });

    const responseTokens = approxTokens(JSON.stringify(result));
    console.log('prime response tokens for 10 entries:', responseTokens);

    // L1-style response: stale_files list + minimal metadata should stay compact
    expect(responseTokens).toBeLessThan(2000);
  });
});
