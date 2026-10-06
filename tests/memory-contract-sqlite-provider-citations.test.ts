// Guards against the class of rot fixed by commit 17e7c904
// (docs(memory-contract): replace stale sqlite-provider.ts line pins with
// symbol anchors): memory-contract/v1/taxonomy.json, spec.md and
// INVENTORY.md cited src/services/knowledge/sqlite-provider.ts by absolute
// file:line three times running up to that cleanup -- SqliteProvider.
// demote's insertion alone shifted every later line pin in taxonomy.json
// without anyone noticing until a manual audit. A hand-maintained line
// number is not a durable citation into a file that changes shape
// routinely.
//
// This file enforces the two-part fix a token-checking guard gives (see bd
// memory `memory-contract-citations-shift-with-sqlite-provider`): no more
// `sqlite-provider.ts:<line>` citations ANYWHERE in these three docs (the
// file is banned from ever being line-pinned again, full stop -- unlike
// http-provider.ts and path-validation.ts, which are NOT covered here
// because their existing line pins were verified accurate and are left
// alone per the cleanup's own scope decision), and every `SqliteProvider.
// <member>` symbol anchor that replaces those line pins must resolve to a
// real class member in the current tree, so a future rename is caught
// here instead of silently going stale again.
//
// Lives under the repo's top-level tests/ (not memory-contract/v1/tests/)
// because vitest.config.ts only discovers tests/**/*.test.ts and
// packages/*/tests/**/*.test.ts -- the same reason as every other
// memory-contract test at this path.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const V1_DIR = fileURLToPath(new URL('../memory-contract/v1/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

const DOCS = [
  { name: 'taxonomy.json', path: V1_DIR + 'taxonomy.json' },
  { name: 'spec.md', path: V1_DIR + 'spec.md' },
  { name: 'INVENTORY.md', path: V1_DIR + 'INVENTORY.md' },
];

const SQLITE_PROVIDER_SRC = readFileSync(SRC_DIR + 'services/knowledge/sqlite-provider.ts', 'utf8');

/** Any absolute file:line citation into sqlite-provider.ts, with or without
 * the leading src/services/knowledge/ path segment (spec.md sometimes
 * shortens it to a bare `sqlite-provider.ts:N` once the file was already
 * named earlier in the same paragraph). */
const LINE_PIN_RE = /sqlite-provider\.ts:\d+/g;

/** A `SqliteProvider.<member>` symbol anchor. */
const SYMBOL_RE = /SqliteProvider\.([A-Za-z0-9_]+)/g;

function memberExists(member: string): boolean {
  // A method declaration (capture(, private getDb(, async promote( ...).
  const methodRe = new RegExp(
    String.raw`(^|\n)\s*(private\s+|protected\s+|public\s+|static\s+|async\s+)*${member}\s*\(`,
  );
  // A class field/property declaration (repoPath: string, private foo: Bar).
  const fieldRe = new RegExp(
    String.raw`(^|\n)\s*(private\s+|protected\s+|public\s+|readonly\s+|static\s+)*${member}\s*[?!]?\s*:`,
  );
  return methodRe.test(SQLITE_PROVIDER_SRC) || fieldRe.test(SQLITE_PROVIDER_SRC);
}

describe('sqlite-provider.ts citations in memory-contract docs stay symbol-anchored', () => {
  for (const doc of DOCS) {
    it(`${doc.name} cites no sqlite-provider.ts absolute line pin`, () => {
      const text = readFileSync(doc.path, 'utf8');
      const hits = [...text.matchAll(LINE_PIN_RE)].map((m) => m[0]);
      expect(
        hits,
        `${doc.name} pins sqlite-provider.ts by line number (${hits.join(', ')}); ` +
          'convert to a SqliteProvider.<member> symbol anchor instead -- this file has ' +
          'already drifted three times under hand-maintained line numbers',
      ).toEqual([]);
    });
  }

  for (const doc of DOCS) {
    it(`${doc.name} only cites SqliteProvider members that still exist`, () => {
      const text = readFileSync(doc.path, 'utf8');
      const members = new Set([...text.matchAll(SYMBOL_RE)].map((m) => m[1]));
      for (const member of members) {
        expect(
          memberExists(member),
          `${doc.name} cites SqliteProvider.${member}, which no longer resolves to a ` +
            'method declaration in src/services/knowledge/sqlite-provider.ts',
        ).toBe(true);
      }
    });
  }

  it('spec.md actually carries at least one SqliteProvider symbol anchor (sanity: the guard is reachable)', () => {
    const text = readFileSync(V1_DIR + 'spec.md', 'utf8');
    const members = [...text.matchAll(SYMBOL_RE)];
    expect(members.length).toBeGreaterThan(0);
  });

  it('taxonomy.json actually carries at least one SqliteProvider symbol anchor (sanity: the guard is reachable)', () => {
    const text = readFileSync(V1_DIR + 'taxonomy.json', 'utf8');
    const members = [...text.matchAll(SYMBOL_RE)];
    expect(members.length).toBeGreaterThan(0);
  });
});
