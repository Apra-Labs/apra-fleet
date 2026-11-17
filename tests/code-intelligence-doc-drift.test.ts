// Doc drift check: docs/code-intelligence-embeddings.md must quote the gitnexus
// invocations the code actually runs -- the pinned package spec for the fleet's
// MCP child and the analyze argv -- so bumping GITNEXUS_MIN_VERSION (or the
// analyze flags) without updating the doc fails here. Read-only: writes nothing.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITNEXUS_ANALYZE_ARGS, GITNEXUS_PACKAGE_SPEC } from '../src/tools/code-intelligence-reindex.js';

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'code-intelligence-embeddings.md');

describe('docs/code-intelligence-embeddings.md matches the pinned gitnexus invocations', () => {
  const doc = readFileSync(DOC, 'utf8');

  it('states the MCP child as npx -y <GITNEXUS_PACKAGE_SPEC> mcp, never the unpinned form', () => {
    expect(doc).toContain(`npx -y ${GITNEXUS_PACKAGE_SPEC} mcp`);
    expect(doc).toContain('GITNEXUS_PACKAGE_SPEC');
    expect(doc).not.toContain('npx -y gitnexus mcp');
  });

  it('quotes the analyze argv built from GITNEXUS_ANALYZE_ARGS, including --index-only', () => {
    expect(GITNEXUS_ANALYZE_ARGS).toContain('--index-only');
    expect(doc).toContain(`npx ${GITNEXUS_ANALYZE_ARGS.join(' ')}`);
  });
});
