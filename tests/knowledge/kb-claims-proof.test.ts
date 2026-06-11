import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const EVAL_DIR = path.join(process.cwd(), 'eval', 'kb-eval-project', 'src');
const EVAL_FILE_NAMES = ['index.ts', 'errors.ts', 'tokens.ts', 'parser.ts', 'evaluator.ts'];
const EVAL_FILES = EVAL_FILE_NAMES.map(n => path.join(EVAL_DIR, n));

const FILE_SUMMARIES: Record<string, string> = {
  'index.ts': 'Public API: evaluate(), evaluateSafe(), evaluateAll(), runRepl() helper functions.',
  'errors.ts': 'Error classes: EvalError, LexError, ParseError, RuntimeError, DivisionByZeroError, OverflowError, ArityError.',
  'tokens.ts': 'Lexer and token types: TokenType enum, Token interface, Lexer class with tokenize() method.',
  'parser.ts': 'Recursive descent parser: ASTNode hierarchy, Parser class with parse() and tokenize() methods.',
  'evaluator.ts': 'Expression evaluator: Evaluator extends Parser, evalNode() dispatches on AST node kind.',
};

function captureInput(file: string, content: string): KBEntryInput {
  const name = path.basename(file);
  return {
    type: 'context-cache',
    title: `context-cache: ${name}`,
    summary: FILE_SUMMARIES[name] ?? `Source file: ${name}`,
    content,
    source_files: [file],
    symbols: [],
    tags: [],
    content_hash: gitBlobHash(Buffer.from(content)),
    content_hash_type: 'git',
    flagged_for_review: false,
    author: 'kb-claims-proof',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

async function captureAllEvalFiles(
  prov: SqliteProvider
): Promise<{ totalChars: number; totalFileTokens: number }> {
  let totalChars = 0;
  for (const file of EVAL_FILES) {
    const content = fs.readFileSync(file, 'utf8');
    totalChars += content.length;
    await prov.capture(captureInput(file, content));
  }
  return { totalChars, totalFileTokens: Math.ceil(totalChars / 4) };
}

let provider: SqliteProvider;

beforeEach(async () => {
  mockExecFile.mockReset();
  setupGitSuccess();
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
});

describe('KB Claims Proof -- real measured numbers', () => {
  it('Claim 1+5: warm prime saves >= 80% of raw file tokens', async () => {
    const { totalFileTokens } = await captureAllEvalFiles(provider);

    const primeResult = await provider.prime({ session_files: EVAL_FILES });

    expect(primeResult.stale_files.length).toBe(0);
    expect(primeResult.session_warm).toBe(true);
    expect(primeResult.fresh_summaries.length).toBe(EVAL_FILES.length);

    const responseChars = JSON.stringify(primeResult).length;
    const primeResponseTokens = Math.ceil(responseChars / 4);
    const savedTokens = totalFileTokens - primeResponseTokens;
    const savingsPct = Math.round((savedTokens / totalFileTokens) * 100);

    console.log(
      `\n[Claim 1+5] totalFileTokens=${totalFileTokens}` +
      ` primeResponseTokens=${primeResponseTokens}` +
      ` savingsPct=${savingsPct}%`
    );

    expect(savingsPct).toBeGreaterThanOrEqual(80);
  });

  it('Claim 4: L1 payload < 20% of naive token cost', async () => {
    const { totalFileTokens: naiveTokens } = await captureAllEvalFiles(provider);

    const l1Result = await provider.query({
      type: 'context-cache',
      l1_only: true,
      limit: 20,
    });

    const l1Chars = l1Result.results.reduce(
      (sum, e) => sum + e.title.length + e.summary.length,
      0
    );
    const l1Tokens = Math.ceil(l1Chars / 4);

    const top5Ids = l1Result.results.slice(0, 5).map(e => e.id);
    const l2Result = await provider.query({ ids: top5Ids });
    const l2Chars = l2Result.results.reduce(
      (sum, e) => sum + Math.min(e.content.length, 4000),
      0
    );
    const l2Tokens = Math.ceil(l2Chars / 4);

    console.log(
      `\n[Claim 4] naiveTokens=${naiveTokens}` +
      ` l1Tokens=${l1Tokens}` +
      ` l2TopTokens=${l2Tokens}` +
      ` l1Pct=${Math.round((l1Tokens / naiveTokens) * 100)}%`
    );

    expect(l1Result.results.length).toBeGreaterThanOrEqual(5);
    expect(l1Tokens).toBeLessThan(naiveTokens * 0.20);
  });

  it('Claim 5: cost projection shows positive savings over 50 sessions', async () => {
    const { totalFileTokens } = await captureAllEvalFiles(provider);

    const primeResult = await provider.prime({ session_files: EVAL_FILES });
    const primeResponseTokens = Math.ceil(JSON.stringify(primeResult).length / 4);

    const SONNET_PRICE_PER_MILLION = 3.00;
    const savedTokensPerSession = totalFileTokens - primeResponseTokens;
    const totalSavedTokens50 = savedTokensPerSession * 50;
    const dollarSaved = (totalSavedTokens50 / 1_000_000) * SONNET_PRICE_PER_MILLION;
    const dollarAnnual = dollarSaved * 20;

    console.log(
      `\n[Claim 5] savedTokensPerSession=${savedTokensPerSession}` +
      ` totalSavedTokens50=${totalSavedTokens50}` +
      ` dollarSaved=$${dollarSaved.toFixed(4)}` +
      ` dollarAnnual=$${dollarAnnual.toFixed(2)}`
    );

    expect(savedTokensPerSession).toBeGreaterThan(0);
    expect(dollarSaved).toBeGreaterThan(0);
  });

  it('Claim 3a: INFERRED -> CONFIRMED promote in one operation', async () => {
    const { id } = await provider.capture({
      type: 'knowledge',
      title: 'kb-proof: parser pattern',
      summary: 'Parser uses recursive descent; each parse* method handles one grammar level.',
      content: 'Parser uses recursive descent; each parse* method handles one grammar level.',
      source_files: ['eval/kb-eval-project/src/parser.ts'],
      symbols: ['Parser'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'kb-claims-proof',
      source: 'doer',
      confidence: 'INFERRED',
    });

    const before = (await provider.query({ ids: [id] })).results[0];
    expect(before.confidence).toBe('INFERRED');

    const t0 = performance.now();
    const promoteResult = await provider.promote(id, 'verified by kb-claims-proof test');
    const promoteMs = Math.round(performance.now() - t0);

    const after = (await provider.query({ ids: [id] })).results[0];
    expect(after.confidence).toBe('CONFIRMED');
    expect(after.promoted_at).toBeTruthy();

    expect(promoteResult.confidence_before).toBe('INFERRED');
    expect(promoteResult.confidence_after).toBe('CONFIRMED');

    console.log(
      `\n[Claim 3a] before=${before.confidence} after=${after.confidence}` +
      ` promoteMs=${promoteMs}ms`
    );
  });

  it('Claim 3b: contradiction capture triggers AUDN flagged_for_review on existing entry', async () => {
    const entry1Input = {
      type: 'knowledge' as const,
      title: 'kb-proof: parser pattern',
      summary: 'Parser uses recursive descent; each parse* method handles one grammar level.',
      content: 'Parser uses recursive descent; each parse* method handles one grammar level.',
      source_files: ['eval/kb-eval-project/src/parser.ts'],
      symbols: ['Parser'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256' as const,
      flagged_for_review: false,
      author: 'kb-claims-proof',
      source: 'doer' as const,
      confidence: 'INFERRED' as const,
    };

    const { id: id1, audn_decision: d1 } = await provider.capture(entry1Input);
    expect(d1).toBe('add');

    const entry2Input = {
      ...entry1Input,
      title: 'kb-proof: parser pattern',
      content: 'actually this is incorrect: Parser does NOT use recursion -- it is iterative, not recursive descent',
      confidence: 'INFERRED' as const,
    };

    const { id: id2, audn_decision: d2 } = await provider.capture(entry2Input);
    expect(d2).toBe('flagged');

    const e1After = (await provider.query({ ids: [id1] })).results[0];
    const e2 = (await provider.query({ ids: [id2] })).results[0];

    expect(e1After.flagged_for_review).toBe(true);
    expect(e2.confidence).toBe('UNVERIFIED');
    expect(e2.contradiction_of).toBe(id1);

    console.log(
      `\n[Claim 3b] entry1 flagged=${e1After.flagged_for_review}` +
      ` entry2 confidence=${e2.confidence}` +
      ` contradiction_of=${e2.contradiction_of ? 'entry1' : 'none'}`
    );
  });
});
