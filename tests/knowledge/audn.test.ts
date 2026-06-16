import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeAudnDecision,
  hasContradictionKeywords,
  symbolsOverlap,
  filesOverlap,
  CONTRADICTION_KEYWORDS,
} from '../../src/services/knowledge/audn.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';

// -- Pure unit tests for helper functions --

describe('hasContradictionKeywords', () => {
  it('returns true for content containing contradiction keywords', () => {
    for (const kw of CONTRADICTION_KEYWORDS) {
      expect(hasContradictionKeywords(`prefix ${kw} suffix`)).toBe(true);
    }
  });

  it('returns false for normal content', () => {
    expect(hasContradictionKeywords('The registry initializes lazily.')).toBe(false);
  });
});

describe('symbolsOverlap', () => {
  it('returns true when arrays share at least one element', () => {
    expect(symbolsOverlap(['a', 'b'], ['b', 'c'])).toBe(true);
  });

  it('returns false when arrays have no common elements', () => {
    expect(symbolsOverlap(['a'], ['b', 'c'])).toBe(false);
  });

  it('returns false when either array is empty (strict AND-logic)', () => {
    expect(symbolsOverlap([], ['a'])).toBe(false);
    expect(symbolsOverlap(['a'], [])).toBe(false);
  });
});

describe('filesOverlap', () => {
  it('returns true when arrays share a file path', () => {
    expect(filesOverlap(['src/foo.ts', 'src/bar.ts'], ['src/bar.ts'])).toBe(true);
  });

  it('returns false when no common files', () => {
    expect(filesOverlap(['src/foo.ts'], ['src/bar.ts'])).toBe(false);
  });

  it('returns false when either array is empty', () => {
    expect(filesOverlap([], ['src/foo.ts'])).toBe(false);
    expect(filesOverlap(['src/foo.ts'], [])).toBe(false);
  });
});

// -- makeAudnDecision pure logic tests --

function makeCandidate(overrides: Partial<KBEntry> = {}): KBEntry {
  return {
    id: 'existing-id',
    type: 'learning',
    title: 'Registry initialization behavior',
    summary: 'How registry init works',
    content: 'The registry initializes lazily on first access.',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry', 'getOrCreate'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    stale: false,
    flagged_for_review: false,
    author: 'agent',
    source: 'doer',
    confidence: 'INFERRED',
    created_at: new Date().toISOString(),
    use_count: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'learning',
    title: 'Registry initialization behavior',
    summary: 'How registry init works',
    content: 'The registry initializes lazily on first access.',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry', 'getOrCreate'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

describe('makeAudnDecision', () => {
  it('identical entry -> none (skip write, return existing id)', () => {
    const candidate = makeCandidate();
    const input = makeInput();
    const result = makeAudnDecision(input, [candidate], candidate.content);
    expect(result?.decision).toBe('none');
    expect(result?.matchedId).toBe(candidate.id);
  });

  it('similar title but different symbols -> add (AND-logic: symbol overlap required)', () => {
    const candidate = makeCandidate({ symbols: ['authService', 'loginFlow'] });
    const input = makeInput({ symbols: ['initRegistry', 'getOrCreate'] });
    // symbols do not overlap -> null (caller returns add)
    const result = makeAudnDecision(input, [candidate], 'some content');
    expect(result).toBeNull();
  });

  it('same symbols + files + similar title + different content -> update', () => {
    const candidate = makeCandidate();
    const newContent = 'The registry now initializes eagerly at startup. Changed in v2.';
    const input = makeInput({ content: newContent });
    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result?.decision).toBe('update');
    expect(result?.matchedId).toBe(candidate.id);
    expect(result?.shouldSupersede).toBe(true);
  });

  it('contradicting content with same symbols/files -> flagged', () => {
    const candidate = makeCandidate();
    const contradictingContent = 'Actually this was wrong: the registry does not use getOrCreate.';
    const input = makeInput({ content: contradictingContent });
    const result = makeAudnDecision(input, [candidate], contradictingContent);
    expect(result?.decision).toBe('flagged');
    expect(result?.matchedId).toBe(candidate.id);
    expect(result?.shouldFlagExisting).toBe(true);
    expect(result?.newEntryOverrides?.contradiction_of).toBe(candidate.id);
    expect(result?.newEntryOverrides?.confidence).toBe('UNVERIFIED');
  });

  it('completely different entry (no candidates) -> add (returns null)', () => {
    const input = makeInput({
      symbols: ['differentSymbol'],
      source_files: ['src/completely/different.ts'],
    });
    const result = makeAudnDecision(input, [], 'Different content about something else.');
    expect(result).toBeNull();
  });
});

// -- Integration: self-wiring via SqliteProvider --

let provider: SqliteProvider;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
});

describe('self-wiring links', () => {
  it('two entries sharing registry.ts are linked in the links table', async () => {
    const inputA: KBEntryInput = {
      type: 'learning',
      title: 'Registry initialization pattern',
      summary: 'How the registry starts up',
      content: 'The registry calls init on startup.',
      source_files: ['src/services/registry.ts'],
      symbols: ['initRegistry'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'agent',
      source: 'doer',
      confidence: 'INFERRED',
    };

    const inputB: KBEntryInput = {
      type: 'knowledge',
      title: 'Registry cleanup procedure',
      summary: 'How to clean up the registry',
      content: 'Call destroy() on the registry to clean up connections.',
      source_files: ['src/services/registry.ts'],
      symbols: ['destroyRegistry'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'agent',
      source: 'doer',
      confidence: 'INFERRED',
    };

    const resultA = await provider.capture(inputA);
    const resultB = await provider.capture(inputB);

    expect(resultA.audn_decision).toBe('add');
    expect(resultB.audn_decision).toBe('add');

    const linked = await provider.getLinked(resultA.id);
    expect(linked.some(e => e.id === resultB.id)).toBe(true);
  });
});
