import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeForIndex,
  normalizeQueryTerms,
  normalizeQueryTermList,
  normalizeTokens,
  splitIdentifier,
  stem,
} from '../../src/services/knowledge/kb-normalize.js';

// Design D2a: identifiers are normalized at index time and queries go through
// the same normalizer. These tests pin the pure pipeline; the SqliteProvider
// keyword-index tests exercise it end to end.

describe('splitIdentifier', () => {
  it('splits camelCase', () => {
    expect(splitIdentifier('getMemberSplitRead')).toEqual(['get', 'member', 'split', 'read']);
  });

  it('splits PascalCase with an acronym run', () => {
    expect(splitIdentifier('HTTPKbProvider')).toEqual(['http', 'kb', 'provider']);
    expect(splitIdentifier('parseJSONValue')).toEqual(['parse', 'json', 'value']);
  });

  it('splits snake_case and kebab-case', () => {
    expect(splitIdentifier('get_member_split')).toEqual(['get', 'member', 'split']);
    expect(splitIdentifier('kb-self')).toEqual(['kb', 'self']);
    expect(splitIdentifier('SCREAMING_SNAKE_CASE')).toEqual(['screaming', 'snake', 'case']);
  });
});

describe('normalizeForIndex', () => {
  it('splits camelCase and keeps the original identifier', () => {
    const toks = normalizeForIndex('getMemberSplitRead').split(' ');
    expect(toks).toContain('getmembersplitread');
    expect(toks).toEqual(expect.arrayContaining(['get', 'member', 'split', 'read']));
  });

  it('splits PascalCase with acronyms and keeps the original', () => {
    const toks = normalizeForIndex('HTTPKbProvider').split(' ');
    expect(toks).toContain('httpkbprovider');
    expect(toks).toEqual(expect.arrayContaining(['http', 'kb', stem('provider')]));
  });

  it('splits snake_case and kebab-case and keeps the original', () => {
    expect(normalizeForIndex('get_member_split').split(' ')).toEqual(['getmembersplit', 'get', 'member', 'split']);
    expect(normalizeForIndex('kb-self').split(' ')).toEqual(['kbself', 'kb', 'self']);
  });

  it('splits posix and windows paths on / \\ and . into segments', () => {
    const toks = normalizeForIndex('src/services/knowledge/kb-self.ts').split(' ');
    expect(toks).toEqual(['src', stem('services'), stem('knowledge'), 'kbself', 'kb', 'self', 'ts']);
    const win = normalizeForIndex('src\\tools\\KbQuery.ts').split(' ');
    expect(win).toEqual(['src', stem('tools'), 'kbquery', 'kb', 'queri', 'ts']);
  });

  it('lowercases and emits only [a-z0-9] tokens', () => {
    const out = normalizeForIndex('Foo.Bar(baz) -- "quoted": a/b \\ c:d; e,f!');
    for (const t of out.split(' ')) expect(t).toMatch(/^[a-z0-9]+$/);
  });

  it('returns an empty string for punctuation-only text', () => {
    expect(normalizeForIndex('.-()/:"')).toBe('');
  });
});

describe('stem (Porter)', () => {
  it('maps run/running/runs to one stem', () => {
    expect(new Set([stem('run'), stem('running'), stem('runs')]).size).toBe(1);
  });

  it('maps failed/failing to one stem', () => {
    expect(stem('failed')).toBe(stem('failing'));
    expect(stem('failed')).toBe('fail');
  });

  it('matches classic Porter reference outputs', () => {
    expect(stem('caresses')).toBe('caress');
    expect(stem('ponies')).toBe('poni');
    expect(stem('relational')).toBe('relat');
    expect(stem('hopping')).toBe('hop');
    expect(stem('filing')).toBe('file');
    expect(stem('reading')).toBe('read');
  });

  it('leaves short and digit-bearing tokens unchanged', () => {
    expect(stem('is')).toBe('is');
    expect(stem('v2s')).toBe('v2s');
  });

  it('is applied at both index and query time', () => {
    expect(normalizeTokens('running')).toEqual(normalizeTokens('runs'));
  });
});

describe('normalizeQueryTerms', () => {
  it('produces quoted OR-joined tokens', () => {
    expect(normalizeQueryTerms('failing getMemberSplitRead')).toBe(
      '"fail" OR "getmembersplitread" OR "get" OR "member" OR "split" OR "read"'
    );
  });

  it('returns empty string when nothing usable remains', () => {
    expect(normalizeQueryTerms('(( -- ))')).toBe('');
  });

  it('yields a MATCH string SQLite FTS5 accepts for punctuation-heavy input', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(body)');
      db.prepare('INSERT INTO t(body) VALUES (?)').run(
        normalizeForIndex('getMemberSplitRead lives in src/services/knowledge/kb-self.ts')
      );
      const nasty = [
        'src/services/knowledge/kb-self.ts',
        'foo.bar(baz) - "quoted" : a/b',
        'NOT AND OR NEAR(x, y)',
        'error: E-SELF-NO-REMOTE (exit 1) "C:\\path\\x.ts"',
        "it's a 'single' quote: ^ * + {col}",
      ];
      for (const q of nasty) {
        const match = normalizeQueryTerms(q);
        expect(match.length).toBeGreaterThan(0);
        expect(() => db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(match)).not.toThrow();
      }
      const hit = db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(normalizeQueryTerms('kb-self'));
      expect(hit.length).toBe(1);
      const termHit = db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(
        normalizeQueryTermList(['getMemberSplitRead', 'nothingLikeThis'])
      );
      expect(termHit.length).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('non-ASCII text (written as \\u escapes: the repo is ASCII-only)', () => {
  const GRUESSE = 'Gr\u00fc\u00dfe';
  const NIHONGO = '\u65e5\u672c\u8a9e';

  it('normalizeForIndex keeps a non-ASCII word as one lowercased token', () => {
    expect(normalizeForIndex(`${GRUESSE} aus Berlin`).split(' ')).toEqual(['gr\u00fc\u00dfe', 'au', 'berlin']);
    expect(normalizeForIndex(`notes on ${NIHONGO} input`).split(' ')).toContain(NIHONGO);
    expect(normalizeForIndex('caf\u00e9-cr\u00e8me').split(' ')).toEqual(['caf\u00e9cr\u00e8me', 'caf\u00e9', 'cr\u00e8me']);
  });

  it('normalizeQueryTerms and normalizeQueryTermList keep it too', () => {
    expect(normalizeQueryTerms(GRUESSE)).toBe('"gr\u00fc\u00dfe"');
    expect(normalizeQueryTerms(NIHONGO)).toBe(`"${NIHONGO}"`);
    expect(normalizeQueryTermList([GRUESSE, 'getMemberSplitRead'])).toBe(
      '"gr\u00fc\u00dfe" OR "getmembersplitread" "get" "member" "split" "read"'
    );
  });

  it('composed and decomposed forms normalize to the same token (NFKC)', () => {
    expect(normalizeTokens('Gru\u0308\u00dfe')).toEqual(normalizeTokens(GRUESSE));
  });

  it('ASCII identifier splitting is unchanged next to non-ASCII text', () => {
    expect(normalizeForIndex(`getMemberSplitRead ${GRUESSE}`).split(' ')).toEqual(
      ['getmembersplitread', 'get', 'member', 'split', 'read', 'gr\u00fc\u00dfe']
    );
  });

  it('an FTS5 unicode61 MATCH finds the indexed non-ASCII word', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'unicode61')");
      db.prepare('INSERT INTO t(body) VALUES (?)').run(normalizeForIndex(`${GRUESSE} and ${NIHONGO} notes`));
      db.prepare('INSERT INTO t(body) VALUES (?)').run(normalizeForIndex('plain ascii row'));
      for (const q of [GRUESSE, NIHONGO, 'GR\u00dcSSE'.slice(0, 2) + '\u00fc\u00dfe']) {
        expect(db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(normalizeQueryTerms(q))).toEqual([{ rowid: 1 }]);
      }
    } finally {
      db.close();
    }
  });
});
