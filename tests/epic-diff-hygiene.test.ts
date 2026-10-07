// Verification task closing the client-and-docs lane (memory-contract/v1
// kb_demote epic): the branch-wide hygiene guards every task in this epic is
// bound by -- no bead id cited in any added line, no docs/sprint-analysis-*
// file touched by a doer task -- plus command-falsifiable assertions that the
// client docs and README actually list kb_demote (not just manual inspection).
//
// Lives under the repo's top-level tests/ (not memory-contract/v1/tests/ or
// packages/apra-fleet-client/test/) because this guard is about the WHOLE
// branch diff, not one package, and vitest.config.ts only discovers
// tests/**/*.test.ts and packages/*/tests/**/*.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { resolveEpicBaseRef } from '../scripts/epic-base-ref.mjs';
import {
  findBeadIdCitations,
  addedLinesFromDiff,
  getAddedLines,
  findSprintAnalysisDocChanges,
  parseSprintAnalysisNameStatus,
  findSprintAnalysisViolations,
} from '../scripts/check-epic-diff-hygiene.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EPIC_BASE_BRANCH = 'u1_kb_redesign_base';

// This test module is itself scanned by the very guard it tests (it is an
// ADDED file in the branch diff), so every example id below is assembled at
// RUNTIME from separate string pieces rather than written as one literal,
// contiguous, digit-bearing token -- otherwise this file would trip its own
// sibling check further down ("no added line ... cites a tracker id").
const EXAMPLE_MY_BEADS_DB_PREFIX = 'my-beads-db-';
const EXAMPLE_APRA_FLEET_PREFIX = 'apra-fleet-';

describe('bead-id guard: the violation-detection logic itself', () => {
  it('flags a real my-beads-db- tracker id (digit-bearing suffix)', () => {
    const exampleId = EXAMPLE_MY_BEADS_DB_PREFIX + 'xqp.5.1';
    const hits = findBeadIdCitations([`some text citing ${exampleId} inline`]);
    expect(hits.length).toBe(1);
    expect(hits[0].match).toBe(exampleId);
  });

  it('flags a real apra-fleet- tracker id (digit-bearing suffix)', () => {
    const idOne = EXAMPLE_APRA_FLEET_PREFIX + '23c';
    const idTwo = EXAMPLE_APRA_FLEET_PREFIX + 'oomh.16';
    const hits = findBeadIdCitations([`fixed per ${idOne} and ${idTwo}`]);
    expect(hits.map((h) => h.match)).toEqual([idOne, idTwo]);
  });

  it('demonstrates the fail case: a temporarily-added bead-id line is caught (repeatable-test form of "add then confirm it fails")', () => {
    const exampleId = EXAMPLE_MY_BEADS_DB_PREFIX + 'xqp.5.1';
    const addedLines = addedLinesFromDiff(`+this line was temporarily added and cites ${exampleId}\n`);
    const hits = findBeadIdCitations(addedLines);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('does NOT flag this repo\'s own package/directory names, which are plain words with no digit', () => {
    const hits = findBeadIdCitations([
      'packages/apra-fleet-client/docs/api-reference.md',
      'apra-fleet-se and apra-fleet-workflow are npm workspaces',
      '@apralabs/apra-fleet-client',
    ]);
    expect(hits).toEqual([]);
  });

  it('flags a my-beads-db- tracker id whose short code is purely alphabetic -- no digit, no dot segment', () => {
    // The digit requirement is kept for apra-fleet- (see the test above) but
    // dropped for my-beads-db-, since no package/directory in this repo
    // carries that prefix. A bare epic-level id (prefix plus a plain-word
    // short code) is exactly the form the pre-fix guard missed.
    const exampleId = EXAMPLE_MY_BEADS_DB_PREFIX + 'epic';
    const hits = findBeadIdCitations([`see ${exampleId} for the full epic description`]);
    expect(hits.length).toBe(1);
    expect(hits[0].match).toBe(exampleId);
  });

  it('addedLinesFromDiff strips the + marker and excludes the +++ file header', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new line one\n+new line two\n';
    expect(addedLinesFromDiff(diff)).toEqual(['new line one', 'new line two']);
  });
});

describe('sprint-analysis-doc guard: the violation-detection logic itself', () => {
  it('flags an added docs/sprint-analysis-* entry not in the allowed set (repeatable-test form of "add then confirm it fails")', () => {
    const entries = parseSprintAnalysisNameStatus('A\tdocs/sprint-analysis-2026-01-01.md\n');
    const violations = findSprintAnalysisViolations(entries, new Set());
    expect(violations).toEqual([{ status: 'A', path: 'docs/sprint-analysis-2026-01-01.md' }]);
  });

  it('suppresses an entry explicitly named in the allowed set (the harvester\'s own current-cycle report)', () => {
    const entries = parseSprintAnalysisNameStatus('A\tdocs/sprint-analysis-2026-01-01.md\n');
    const violations = findSprintAnalysisViolations(entries, new Set(['docs/sprint-analysis-2026-01-01.md']));
    expect(violations).toEqual([]);
  });

  it('the allowed-set filter is exact-path, so a different sprint-analysis file is still flagged', () => {
    const entries = parseSprintAnalysisNameStatus('A\tdocs/sprint-analysis-2026-01-01.md\n');
    const violations = findSprintAnalysisViolations(entries, new Set(['docs/sprint-analysis-2099-12-31.md']));
    expect(violations).toEqual([{ status: 'A', path: 'docs/sprint-analysis-2026-01-01.md' }]);
  });

  it('parseSprintAnalysisNameStatus splits multiple name-status lines into {status, path} entries', () => {
    const entries = parseSprintAnalysisNameStatus(
      'A\tdocs/sprint-analysis-2026-01-01.md\nM\tdocs/sprint-analysis-2025-12-25.md\n',
    );
    expect(entries).toEqual([
      { status: 'A', path: 'docs/sprint-analysis-2026-01-01.md' },
      { status: 'M', path: 'docs/sprint-analysis-2025-12-25.md' },
    ]);
  });

  it('findSprintAnalysisDocChanges wraps a real git diff and still defaults to an empty allowed set', () => {
    // A HEAD..HEAD diff is legitimately empty for this repo (no uncommitted
    // docs/sprint-analysis-* change), so this only exercises the spawnSync
    // wiring; the detection logic itself is proven above against fabricated
    // entries, and against the real epic branch diff below.
    const violations = findSprintAnalysisDocChanges({ cwd: REPO_ROOT, baseRef: 'HEAD' });
    expect(violations).toEqual([]);
  });
});

describe('epic base-ref resolution (shared with the fixture-additivity guard)', () => {
  it('resolves the real epic base branch, never the bare local name', () => {
    const ref = resolveEpicBaseRef(EPIC_BASE_BRANCH, { cwd: REPO_ROOT });
    expect(ref).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('fails loudly, with a remediation, when the ref cannot be resolved -- never passes vacuously', () => {
    expect(() => resolveEpicBaseRef('this-branch-definitely-does-not-exist-zzz', { cwd: REPO_ROOT })).toThrow(
      /Cannot resolve epic base ref/,
    );
  });

  it('resolveEpicBaseRef never passes the bare branch name to git directly -- it always builds origin/<branch> first', () => {
    const src = readFileSync(fileURLToPath(new URL('../scripts/epic-base-ref.mjs', import.meta.url)), 'utf8');
    // Every real git invocation in this module (spawnSync('git', [...])) must
    // target `remoteRef` (the origin/${branchName} template) and never the
    // raw `branchName` parameter directly.
    const gitInvocationLines = src.split('\n').filter((l) => l.includes("spawnSync('git'"));
    expect(gitInvocationLines.length).toBeGreaterThan(0); // sanity: the filter itself finds something
    for (const line of gitInvocationLines) {
      expect(line).toContain('remoteRef');
      expect(line).not.toContain('branchName');
    }
  });
});

describe('the real branch diff against the epic base passes both hygiene guards', () => {
  const baseRef = resolveEpicBaseRef(EPIC_BASE_BRANCH, { cwd: REPO_ROOT });

  it('no added line in the branch diff cites a my-beads-db- or apra-fleet- tracker id', () => {
    const addedLines = getAddedLines({ cwd: REPO_ROOT, baseRef });
    const hits = findBeadIdCitations(addedLines);
    expect(hits, `bead id citations found: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no docs/sprint-analysis-* file appears in the branch diff', () => {
    const violations = findSprintAnalysisDocChanges({ cwd: REPO_ROOT, baseRef });
    expect(violations, `sprint-analysis doc changes found: ${JSON.stringify(violations)}`).toEqual([]);
  });
});

describe('client docs and README list kb_demote -- assertions, not manual inspection', () => {
  it('packages/apra-fleet-client/docs/api-reference.md documents kbDemote', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../packages/apra-fleet-client/docs/api-reference.md', import.meta.url)),
      'utf8',
    );
    expect(text).toMatch(/#### `kbDemote\(options: KbDemoteOptions\)`/);
    expect(text).toContain('kb_demote');
  });

  it('packages/apra-fleet-client/docs/api-reference.md documents kbBibleCommit\'s demoted_ids input', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../packages/apra-fleet-client/docs/api-reference.md', import.meta.url)),
      'utf8',
    );
    expect(text).toContain('demoted_ids');
  });

  it('README.md lists kb_demote among the KB tools', () => {
    const text = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    expect(text).toMatch(/\|\s*`kb_demote`\s*\|/);
  });
});
