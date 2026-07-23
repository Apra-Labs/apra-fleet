import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeAudnDecision,
  hasContradictionKeywords,
  hasOppositePolarity,
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

// -- hasOppositePolarity (F3/D3): word-boundary matching, not substring --
//
// The old String.includes() implementation matches antonym-pair phrases as
// bare substrings, so words that merely CONTAIN a polarity phrase (e.g.
// "prefixed"/"suffixed" contain "fixed"; "unresolved" contains "resolved")
// falsely carry that phrase's polarity even though they have nothing to do
// with fix/break semantics. Paired against genuinely opposite-signal text,
// this produces a spurious opposite-polarity signal. These three tests MUST
// FAIL on the pre-fix includes() implementation and PASS once matching is
// tightened to word boundaries.
describe('hasOppositePolarity (F3/D3): word-boundary, not substring', () => {
  it('"prefixed" is not a polarity signal -- no false opposite-polarity vs genuine "is broken"', () => {
    // Pre-fix: 'prefixed'.includes('fixed') -> false-positive POSITIVE on
    // side A; 'is broken' -> genuine NEGATIVE on side B -> old code wrongly
    // returns true. Post-fix: \bfixed\b does not match inside "prefixed".
    expect(hasOppositePolarity(
      'The config key is prefixed with FOO_',
      'The service is broken',
    )).toBe(false);
  });

  it('"unresolved" is not a polarity signal -- no false opposite-polarity vs genuine "is broken"', () => {
    // Pre-fix: 'unresolved'.includes('resolved') -> false-positive POSITIVE
    // on side A; 'is broken' -> genuine NEGATIVE on side B -> old code
    // wrongly returns true. Post-fix: \bresolved\b does not match inside
    // "unresolved".
    expect(hasOppositePolarity(
      'The ticket remains unresolved',
      'The endpoint is broken',
    )).toBe(false);
  });

  it('"suffixed" is not a polarity signal -- no false opposite-polarity vs genuine "is broken"', () => {
    // Pre-fix: 'suffixed'.includes('fixed') -> false-positive POSITIVE on
    // side A; 'is broken' -> genuine NEGATIVE on side B -> old code wrongly
    // returns true. Post-fix: \bfixed\b does not match inside "suffixed".
    expect(hasOppositePolarity(
      'The parameter name is suffixed with _v2',
      'The migration is broken',
    )).toBe(false);
  });

  // -- Regression guard: genuine antonym pairs must still signal, both
  // before and after the fix. --

  it('genuine "fixed" vs "broken" pair still signals opposite polarity', () => {
    expect(hasOppositePolarity('The bug is fixed', 'The bug is broken')).toBe(true);
  });

  it('genuine "doesn\'t work" vs "now works" pair still signals opposite polarity', () => {
    expect(hasOppositePolarity(
      "The API doesn't work anymore",
      'The API now works',
    )).toBe(true);
  });

  it('case-insensitive: "IS BROKEN" vs "Now Works" still signals opposite polarity', () => {
    expect(hasOppositePolarity('The service IS BROKEN', 'The service Now Works')).toBe(true);
  });

  it('no polarity words on either side -> false', () => {
    expect(hasOppositePolarity('The registry initializes lazily.', 'The cache is populated on demand.')).toBe(false);
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

// -- T1.4 / D2: contradiction on shared symbols WITHOUT shared file, incl. cross-type --

describe('makeAudnDecision contradiction path (D2, loosened)', () => {
  it('code_graph broken-vs-fixed shape: same symbols, NO shared file -> flagged (opposite polarity)', () => {
    // The live code_graph pair. Old logic required file overlap -> would have
    // returned null ('add'); new logic flags on symbol overlap + polarity signal.
    const candidate = makeCandidate({
      type: 'knowledge',
      title: 'code_graph tool status',
      symbols: ['GitNexusProvider.graph', 'callGitNexus'],
      source_files: ['docs/code-intelligence-child-surface.md'],
      content: 'call_graph tool does not exist / code_graph is broken',
    });
    const newContent = 'code_graph now works / fixed via cypher CALLS traversal';
    const input = makeInput({
      type: 'knowledge',
      title: 'code_graph tool status',
      symbols: ['GitNexusProvider.graph', 'callGitNexus'],
      source_files: ['src/tools/code-intelligence-gitnexus.ts'],
      content: newContent,
    });

    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result?.decision).toBe('flagged');
    expect(result?.matchedId).toBe(candidate.id);
    expect(result?.shouldFlagExisting).toBe(true);
    expect(result?.newEntryOverrides?.contradiction_of).toBe(candidate.id);
    expect(result?.newEntryOverrides?.confidence).toBe('UNVERIFIED');
  });

  it('CROSS-TYPE contradiction (knowledge candidate, learning input), no shared file -> flagged', () => {
    const candidate = makeCandidate({
      type: 'knowledge',
      title: 'code_graph availability',
      symbols: ['code_graph'],
      source_files: ['docs/a.md'],
      content: 'code_graph is broken and does not exist yet',
    });
    const newContent = 'code_graph now works, fixed via cypher CALLS traversal';
    const input = makeInput({
      type: 'learning',
      title: 'code_graph availability',
      symbols: ['code_graph'],
      source_files: ['src/b.ts'],
      content: newContent,
    });

    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result?.decision).toBe('flagged');
    expect(result?.newEntryOverrides?.contradiction_of).toBe(candidate.id);
  });

  it('no false positive: same symbols, no file overlap, no contradiction signal -> null (add)', () => {
    const candidate = makeCandidate({
      type: 'knowledge',
      title: 'code_graph capabilities',
      symbols: ['code_graph'],
      source_files: ['src/a.ts'],
      content: 'code_graph supports caller traversal',
    });
    const newContent = 'code_graph also supports callee traversal and flow queries';
    const input = makeInput({
      type: 'knowledge',
      title: 'code_graph capabilities',
      symbols: ['code_graph'],
      source_files: ['src/b.ts'],
      content: newContent,
    });

    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result).toBeNull();
  });

  it('re-imposed type gate: cross-type same symbols+files, no contradiction -> null (no update)', () => {
    // Since findAudnCandidates is now cross-type, makeAudnDecision must NOT
    // dedup/update across types. Different type + no contradiction -> null.
    const candidate = makeCandidate({
      type: 'knowledge',
      title: 'X behavior',
      symbols: ['symX'],
      source_files: ['src/x.ts'],
      content: 'old content describing X',
    });
    const newContent = 'refined content describing X in more detail';
    const input = makeInput({
      type: 'learning',
      title: 'X behavior',
      symbols: ['symX'],
      source_files: ['src/x.ts'],
      content: newContent,
    });

    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result).toBeNull();
  });

  it('same-type dedup still works after the type gate (regression)', () => {
    const candidate = makeCandidate({
      type: 'learning',
      title: 'X behavior',
      symbols: ['symX'],
      source_files: ['src/x.ts'],
      content: 'old content describing X',
    });
    const newContent = 'refined content describing X in more detail';
    const input = makeInput({
      type: 'learning',
      title: 'X behavior',
      symbols: ['symX'],
      source_files: ['src/x.ts'],
      content: newContent,
    });

    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result?.decision).toBe('update');
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
