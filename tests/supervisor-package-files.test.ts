// Guards the general property the sibling impl task (shipping
// packages/apra-fleet-se/src/ in the root package.json `files` array) exists
// to satisfy: every file reachable from packages/apra-fleet-se/bin/serve.mjs
// via a STATIC RELATIVE import (walked transitively, not just serve.mjs's
// own direct imports) must be covered by some entry in that `files` array.
//
// Deliberately NOT a literal assertion that the string
// 'packages/apra-fleet-se/src/' appears in the files array -- that would
// only re-state the sibling impl task and catch nothing new. If a future
// change adds an import that escapes into some other untracked directory,
// THIS test must be the one that catches it.
//
// Pure static read of the repo: no npm pack invocation, no network call, no
// child process spawned. Fast and works offline.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const entryFile = path.join(repoRoot, 'packages', 'apra-fleet-se', 'bin', 'serve.mjs');

/**
 * Extract every static import/export module specifier from ESM source text,
 * covering:
 *   import x from '...'; import { a, b } from '...'; import '...';
 *   export { a } from '...'; export * from '...';
 * including multi-line named-import/export lists. Dynamic import() is
 * intentionally NOT handled -- the reachable tree here uses none (grepped
 * both packages/apra-fleet-se/bin and packages/apra-fleet-se/src for real
 * `import(` calls outside comments/JSDoc `typeof import(...)` annotations;
 * there are none), and the bead scope is the STATIC import graph only.
 *
 * Approach: find each `import`/`export` statement as the text from that
 * keyword up to its OWN terminating ';' (non-greedy over "any non-semicolon
 * char", which includes newlines, so a multi-line named-import list is
 * captured as one statement). The module specifier -- for every form above
 * -- is always the last quoted string immediately before that terminating
 * ';', so a single trailing-quote match per statement is suffient and never
 * confuses a named-import identifier for a specifier (identifiers are never
 * quoted here).
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const statementRe = /^[ \t]*(?:import|export)\b[^;]*?;/gm;
  let match: RegExpExecArray | null;
  while ((match = statementRe.exec(source)) !== null) {
    const stmt = match[0];
    const specMatch = stmt.match(/['"]([^'"]+)['"]\s*;\s*$/);
    if (specMatch) specifiers.push(specMatch[1]);
  }
  return specifiers;
}

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

/**
 * Walk the static import graph reachable from `startFile`, following only
 * relative specifiers (bare specifiers like '@apralabs/apra-fleet-client' or
 * 'node:util' resolve through node_modules, not through the published
 * `files` array, so they are out of scope here). Returns the set of reached
 * absolute file paths, INCLUDING startFile itself.
 */
function walkImportGraph(startFile: string): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startFile];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = fs.readFileSync(current, 'utf-8');
    const dir = path.dirname(current);
    for (const spec of extractImportSpecifiers(source)) {
      if (!isRelativeSpecifier(spec)) continue;
      const resolved = path.resolve(dir, spec);
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

/**
 * Model npm's own `files` array matching semantics (per package.json docs):
 * an entry ending in '/' is a directory-prefix match; an entry naming a file
 * matches only that exact file. Both sides are compared as repo-root-relative
 * POSIX paths.
 */
function isCoveredByFilesArray(relPath: string, filesArray: string[]): string | undefined {
  return filesArray.find((entry) => {
    if (entry.endsWith('/')) return relPath.startsWith(entry);
    return relPath === entry;
  });
}

function toRepoRelativePosix(absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

function readFilesArray(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  return pkg.files as string[];
}

describe('extractImportSpecifiers', () => {
  it('extracts a simple named import', () => {
    expect(extractImportSpecifiers(`import { a } from './a.mjs';`)).toEqual(['./a.mjs']);
  });

  it('extracts a bare side-effect import', () => {
    expect(extractImportSpecifiers(`import './a.mjs';`)).toEqual(['./a.mjs']);
  });

  it('extracts a multi-line named-import list', () => {
    const src = `import {\n  a,\n  b,\n} from '../errors.mjs';`;
    expect(extractImportSpecifiers(src)).toEqual(['../errors.mjs']);
  });

  it('extracts export-from re-exports, including export *', () => {
    const src = `export { a } from './a.mjs';\nexport * from './b.mjs';`;
    expect(extractImportSpecifiers(src)).toEqual(['./a.mjs', './b.mjs']);
  });

  it('ignores bare specifiers and node: builtins (still extracted as specifiers, filtering is a separate step)', () => {
    const src = `import fs from 'node:fs';\nimport { ApraFleet } from '@apralabs/apra-fleet-client';`;
    const specs = extractImportSpecifiers(src);
    expect(specs).toEqual(['node:fs', '@apralabs/apra-fleet-client']);
    expect(specs.filter(isRelativeSpecifier)).toEqual([]);
  });

  it('does not confuse a local export declaration (no from-clause) for an import edge', () => {
    expect(extractImportSpecifiers(`export default { version: 1 };`)).toEqual([]);
  });
});

describe('isCoveredByFilesArray', () => {
  it('a directory-prefix entry (ending in /) covers any file under it', () => {
    expect(isCoveredByFilesArray('packages/apra-fleet-se/src/foo.mjs', ['packages/apra-fleet-se/src/'])).toBe(
      'packages/apra-fleet-se/src/',
    );
  });

  it('a file entry covers only that exact file', () => {
    expect(isCoveredByFilesArray('packages/apra-fleet-se/package.json', ['packages/apra-fleet-se/package.json'])).toBe(
      'packages/apra-fleet-se/package.json',
    );
    expect(isCoveredByFilesArray('packages/apra-fleet-se/other.json', ['packages/apra-fleet-se/package.json'])).toBeUndefined();
  });

  it('a directory-prefix entry does not accidentally cover a sibling directory with a similar name', () => {
    expect(isCoveredByFilesArray('packages/apra-fleet-se/src-extra/foo.mjs', ['packages/apra-fleet-se/src/'])).toBeUndefined();
  });
});

describe('every relative-import-reachable file from serve.mjs is covered by the published files array', () => {
  const reached = walkImportGraph(entryFile);
  const filesArray = readFilesArray();

  it('walked more than one file (sanity: the graph walk actually traverses, not a trivial single-node result)', () => {
    expect(reached.size).toBeGreaterThan(10);
  });

  it('reaches at least one file only INDIRECTLY (not among serve.mjs\'s own direct import specifiers) -- proves this is a transitive walk, not a direct-imports-only check', () => {
    const serveSource = fs.readFileSync(entryFile, 'utf-8');
    const serveDir = path.dirname(entryFile);
    const directTargets = new Set(
      extractImportSpecifiers(serveSource)
        .filter(isRelativeSpecifier)
        .map((spec) => path.resolve(serveDir, spec)),
    );
    const indirectOnly = [...reached].filter((f) => f !== entryFile && !directTargets.has(f));
    expect(indirectOnly.length).toBeGreaterThan(0);
    // Concretely: src/projects/store/projects.mjs is imported by
    // src/registration/owner-refs.mjs and src/projects/routes/projects.mjs,
    // both of which serve.mjs imports directly -- but serve.mjs never
    // imports store/projects.mjs itself.
    const storeProjects = path.join(repoRoot, 'packages/apra-fleet-se/src/projects/store/projects.mjs');
    expect(reached.has(storeProjects)).toBe(true);
    expect(directTargets.has(storeProjects)).toBe(false);
  });

  it('every reached file resolves to a path that actually exists on disk (the walk never fabricates a phantom path)', () => {
    for (const f of reached) {
      expect(fs.existsSync(f), `resolved import target does not exist: ${toRepoRelativePosix(f)}`).toBe(true);
    }
  });

  it('every reached file is covered by an entry in the root package.json files array', () => {
    const uncovered: string[] = [];
    for (const f of reached) {
      const rel = toRepoRelativePosix(f);
      if (!isCoveredByFilesArray(rel, filesArray)) uncovered.push(rel);
    }
    if (uncovered.length > 0) {
      const suggestions = uncovered
        .map((f) => `  - ${f}  (no files entry covers it; e.g. add "${path.dirname(f)}/" or "${f}")`)
        .join('\n');
      throw new Error(
        `${uncovered.length} file(s) reachable from packages/apra-fleet-se/bin/serve.mjs are NOT covered by ` +
        `the root package.json "files" array, so an npm-installed apra-fleet cannot load them:\n${suggestions}`,
      );
    }
    expect(uncovered).toEqual([]);
  });
});
