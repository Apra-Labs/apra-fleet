import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import {
  listDirectivesCmd,
  approveDirectiveCmd,
  rejectDirectiveCmd,
  addDirectiveCmd,
  parseSymbols,
} from '../../src/cli/kb-directives.js';

// T1.2 (F1/D1): the human-terminal directive activation CLI. Handlers are
// invoked directly (not via child_process) against a real temp sqlite KB.

let provider: SqliteProvider;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
});

// Seed a pending proposal directly through capture() (as an MCP capture would).
async function seedPending(text = 'The user said: never force-push to main.', symbols = ['gitPolicy']): Promise<string> {
  const { id } = await provider.capture({
    type: 'user-directive',
    title: text.slice(0, 60),
    summary: 'pending proposal',
    content: text,
    source_files: [],
    symbols,
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'doer',
    source: 'user-directive',
    confidence: 'UNVERIFIED',
    scope: 'project',
  });
  return id;
}

describe('kb directives CLI: list', () => {
  it('prints an empty-state message when there are no directives', async () => {
    const code = await listDirectivesCmd(provider);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('No directives');
  });

  it('lists pending and active directives with a status column', async () => {
    const pendingId = await seedPending();
    const active = await provider.addDirective('Always sign commits.', ['signing']);

    const code = await listDirectivesCmd(provider);
    expect(code).toBe(0);
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('STATUS');
    expect(output).toContain(pendingId);
    expect(output).toContain(active.id);
    expect(output).toContain('pending');
    expect(output).toContain('active');
  });
});

describe('kb directives CLI: approve', () => {
  it('approves a pending proposal into an active directive', async () => {
    const id = await seedPending();
    const code = await approveDirectiveCmd(provider, id);
    expect(code).toBe(0);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('CONFIRMED');
    expect(entry.author).toBe('user');
    expect(entry.flagged_for_review).toBe(false);
  });

  it('errors (exit 1) on a missing id argument', async () => {
    const code = await approveDirectiveCmd(provider, undefined);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Usage');
  });

  it('errors (exit 1) on an unknown id', async () => {
    const code = await approveDirectiveCmd(provider, 'does-not-exist');
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/not found/i);
  });

  it('errors (exit 1) on double-approve (already active)', async () => {
    const id = await seedPending();
    await approveDirectiveCmd(provider, id);
    const code = await approveDirectiveCmd(provider, id);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/already active/i);
  });
});

describe('kb directives CLI: reject', () => {
  it('rejects a pending proposal (superseded + stale, kept for audit)', async () => {
    const id = await seedPending();
    const code = await rejectDirectiveCmd(provider, id);
    expect(code).toBe(0);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.superseded_at).toBeTruthy();
    expect(entry.stale).toBe(true);
  });

  it('errors (exit 1) on missing id and on re-reject', async () => {
    expect(await rejectDirectiveCmd(provider, undefined)).toBe(1);
    const id = await seedPending();
    await rejectDirectiveCmd(provider, id);
    const code = await rejectDirectiveCmd(provider, id);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/already rejected/i);
  });
});

describe('kb directives CLI: add', () => {
  it('creates an already-active directive', async () => {
    const code = await addDirectiveCmd(provider, ['Deploy only on Fridays.']);
    expect(code).toBe(0);
    const listed = await provider.listDirectives();
    expect(listed.length).toBe(1);
    expect(listed[0].confidence).toBe('CONFIRMED');
    expect(listed[0].author).toBe('user');
  });

  it('parses --symbols into an array', async () => {
    const code = await addDirectiveCmd(provider, ['Prefer small PRs.', '--symbols', 'prPolicy, reviewFlow']);
    expect(code).toBe(0);
    const listed = await provider.listDirectives();
    expect(listed[0].symbols).toEqual(['prPolicy', 'reviewFlow']);
  });

  it('errors (exit 1) when no text is provided', async () => {
    const code = await addDirectiveCmd(provider, ['--symbols', 'a,b']);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Usage');
  });
});

describe('kb directives CLI: parseSymbols', () => {
  it('returns text and trimmed non-empty symbols', () => {
    expect(parseSymbols(['hello world', '--symbols', 'a, b ,,c'])).toEqual({
      text: 'hello world',
      symbols: ['a', 'b', 'c'],
    });
  });

  it('returns empty symbols when --symbols is absent', () => {
    expect(parseSymbols(['just text'])).toEqual({ text: 'just text', symbols: [] });
  });
});
