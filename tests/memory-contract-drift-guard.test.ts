// T1.5.1 (my-beads-db-27m.10): regenerate-and-diff drift guard.
//
// Wraps `node memory-contract/v1/generate-contract.mjs --check` (T1.2.2/
// T1.2.3/T1.3.3's own --check mode; see that file's header comment) so a
// zod schema, response-schemas.mjs, or taxonomy.json edit that is not
// followed by `npm run contract:generate` fails here instead of merging
// with a silently stale schemas/, bindings/mcp/, or bindings/openapi/ tree.
// --check also runs the metaschema validation (buildDoc's validateOrThrow)
// and the AC5(a) directive-activation absence scan on every generated
// document, so this single command carries all three.
//
// Needs dist/tools/ built (contract:generate imports the REAL request zod
// schemas from there, not from src/) -- same dist-must-exist precondition
// as tests/regression-command-surface.test.ts, and the same reason: CI's
// build-and-test job always runs `npm run build` before `npm test`
// (.github/workflows/ci.yml).
//
// This test spawns the script (a real child process) rather than importing
// its --check codepath directly (main() is not exported, and spawning
// exercises the exact command a developer or CI runs).
//
// The full fixture round-trip vs sqlite is already covered by
// tests/memory-contract-roundtrip.test.ts; this file does not repeat it.
//
// Separate from tests/memory-contract-parity.test.ts (T1.5.1's other file):
// this test is about generated-artifact DRIFT (does regenerating produce a
// byte-identical tree) and about silent ENTRY DELETION from the two
// hand-authored source-of-truth documents (taxonomy.json / methods.json,
// "removals are contract REVISIONS by policy" -- a silent shrink is a
// FAILING test, not a passing one); parity.test.ts is about cross-document
// REFERENTIAL integrity (tool <-> binding <-> schema, taxonomy code <->
// projection), independently recomputed from the committed files rather
// than by re-running this same --check command.
//
// The .github/workflows/ci.yml regenerate-and-diff step (this same bead)
// covers the one thing this in-process test deliberately does not: actually
// WRITING regenerated files to disk and diffing them with git. Doing that
// inside a vitest run would leave a developer's working tree dirty on every
// `npm test`, and could race across the CI OS matrix's parallel jobs -- so
// the disk-mutating half of this guard lives in CI only, and this test
// covers the same content via --check's in-memory compare instead.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_MARKER = path.join(REPO_ROOT, 'dist', 'tools', 'kb-capture.js');
const GENERATE_SCRIPT = path.join(REPO_ROOT, 'memory-contract', 'v1', 'generate-contract.mjs');
const V1_DIR = path.join(REPO_ROOT, 'memory-contract', 'v1');

// Baselines recorded when this guard was authored (my-beads-db-27m.10):
// taxonomy.json currently disposes 33 names (22 codes across its 7 groups plus
// 11 non_error_outcomes), methods.json currently has 25 entries (18 methods + 7
// code_intelligence_methods). Both numbers only grow or hold steady from here --
// a drop below the baseline means an entry was silently deleted, which policy
// requires to be a deliberate contract revision (tracked, version-bumped), not a
// change this guard waves through unnoticed.
//
// The taxonomy baseline counts codes AND non_error_outcomes together, on
// purpose. A name can legitimately MOVE between the two dispositions when its
// classification is corrected -- E-DIRECTIVE-QUARANTINE did exactly that, out of
// governance and into non_error_outcomes, once it was established that no
// response field reports it and the capture succeeds. A move is not a deletion
// and must not trip this guard; counting only the codes side would have made the
// correction indistinguishable from silently dropping a code.
const TAXONOMY_DISPOSED_NAME_COUNT_BASELINE = 33;
const METHODS_ENTRY_COUNT_BASELINE = 25;

describe('memory-contract drift guard (my-beads-db-27m.10)', () => {
  beforeAll(() => {
    if (!existsSync(DIST_MARKER)) {
      throw new Error(
        `dist/tools not built (missing ${DIST_MARKER}). Run "npm run build" before "npm test" ` +
          '(this matches the CI job ordering in .github/workflows/ci.yml).',
      );
    }
  });

  it('contract:check reports zero drift across schemas/, bindings/mcp/, and bindings/openapi/', () => {
    const output = execFileSync(process.execPath, [GENERATE_SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(output).toMatch(/contract:generate --check: OK --/);
  });

  it('does not drop taxonomy.json below its last-known disposed-name count (structural regression guard)', () => {
    const taxonomy = readJsonV1('taxonomy.json') as {
      groups: Record<string, { codes: unknown[] }>;
      non_error_outcomes: unknown[];
    };
    const codeCount = Object.values(taxonomy.groups).reduce((n, g) => n + g.codes.length, 0);
    const disposedCount = codeCount + taxonomy.non_error_outcomes.length;
    expect(disposedCount).toBeGreaterThanOrEqual(TAXONOMY_DISPOSED_NAME_COUNT_BASELINE);
  });

  it('does not drop methods.json below its last-known entry count (structural regression guard)', () => {
    const methodsDoc = readJsonV1('methods.json') as {
      methods: unknown[];
      code_intelligence_methods: unknown[];
    };
    const total = methodsDoc.methods.length + methodsDoc.code_intelligence_methods.length;
    expect(total).toBeGreaterThanOrEqual(METHODS_ENTRY_COUNT_BASELINE);
  });
});

function readJsonV1(name: string): unknown {
  return JSON.parse(readFileSync(path.join(V1_DIR, name), 'utf8'));
}
