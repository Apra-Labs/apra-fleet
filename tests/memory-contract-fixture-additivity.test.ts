// Verification task closing the contract lane (memory-contract/v1 kb_demote
// epic): proves the fixture corpus under memory-contract/v1/fixtures grew
// ADDITIVELY ONLY against the epic's base branch, that the base-ref
// resolution never silently passes against an unresolvable ref, and that the
// pre-existing sqlite-provider.ts citation guard (tests/memory-contract-
// sqlite-provider-citations.test.ts) is picked up by the default suite
// rather than needing a second one.
//
// Lives under the repo's top-level tests/ (not memory-contract/v1/tests/)
// because vitest.config.ts only discovers tests/**/*.test.ts and
// packages/*/tests/**/*.test.ts -- the same reason as every other
// memory-contract test at this path.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { resolveEpicBaseRef } from '../scripts/epic-base-ref.mjs';
import {
  checkFixtureAdditivity,
  parseNameStatus,
  findNonAdditiveFixtureChanges,
  KNOWN_PRE_EXISTING_FIXTURE_MODIFICATIONS,
} from '../scripts/check-fixture-additivity.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EPIC_BASE_BRANCH = 'u1_kb_redesign_base';

describe('epic base-ref resolution never passes vacuously', () => {
  it('resolves the real epic base branch to a non-empty commit SHA', () => {
    const ref = resolveEpicBaseRef(EPIC_BASE_BRANCH, { cwd: REPO_ROOT });
    expect(ref).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('fails LOUDLY, with a remediation, when neither the remote-tracking ref nor a merge-base resolves', () => {
    expect(() =>
      resolveEpicBaseRef('this-branch-definitely-does-not-exist-anywhere-zzz', { cwd: REPO_ROOT }),
    ).toThrow(/Cannot resolve epic base ref/);
  });
});

describe('fixture-additivity: the violation-detection logic itself', () => {
  it('passes a diff that only adds files', () => {
    const entries = parseNameStatus(
      'A\tmemory-contract/v1/fixtures/kb_demote/happy.json\n' +
        'A\tmemory-contract/v1/fixtures/kb_capture/setup-for-demote.json\n',
    );
    expect(findNonAdditiveFixtureChanges(entries, new Set())).toEqual([]);
  });

  it('FAILS the check when an existing fixture is modified (temporarily-edited-fixture demonstration)', () => {
    // This is the repeatable-test form of "temporarily edit one recorded
    // fixture and confirm the check fails" -- a fabricated diff line stands
    // in for a real `git diff`, so the failure mode is exercised on every
    // run without ever touching a committed fixture file.
    const entries = parseNameStatus('M\tmemory-contract/v1/fixtures/kb_demote/happy.json\n');
    const violations = findNonAdditiveFixtureChanges(entries, new Set());
    expect(violations).toEqual([{ status: 'M', path: 'memory-contract/v1/fixtures/kb_demote/happy.json' }]);
  });

  it('FAILS the check when an existing fixture is deleted', () => {
    const entries = parseNameStatus('D\tmemory-contract/v1/fixtures/kb_demote/happy.json\n');
    const violations = findNonAdditiveFixtureChanges(entries, new Set());
    expect(violations).toEqual([{ status: 'D', path: 'memory-contract/v1/fixtures/kb_demote/happy.json' }]);
  });

  it('never allows a deletion through the modification allowlist, even if the path is listed there', () => {
    const entries = parseNameStatus('D\tmemory-contract/v1/fixtures/kb_import/happy.json\n');
    const violations = findNonAdditiveFixtureChanges(entries, KNOWN_PRE_EXISTING_FIXTURE_MODIFICATIONS);
    expect(violations).toEqual([{ status: 'D', path: 'memory-contract/v1/fixtures/kb_import/happy.json' }]);
  });

  it('an unrelated modification outside the known baseline still fails', () => {
    const entries = parseNameStatus('M\tmemory-contract/v1/fixtures/kb_promote/happy.json\n');
    const violations = findNonAdditiveFixtureChanges(entries, KNOWN_PRE_EXISTING_FIXTURE_MODIFICATIONS);
    expect(violations).toEqual([{ status: 'M', path: 'memory-contract/v1/fixtures/kb_promote/happy.json' }]);
  });
});

describe('fixture-additivity: the real branch diff against the epic base', () => {
  const baseRef = resolveEpicBaseRef(EPIC_BASE_BRANCH, { cwd: REPO_ROOT });
  const { entries, violations } = checkFixtureAdditivity({ cwd: REPO_ROOT, baseRef });

  it('contains no fixture change beyond the documented, reviewed baseline', () => {
    expect(violations, `non-additive fixture changes: ${JSON.stringify(violations)}`).toEqual([]);
  });

  it('is NOT restricted to kb_demote/ -- the demote setup fixtures legitimately span kb_capture/ and kb_promote/ too', () => {
    const dirs = new Set(
      entries.map((e) => e.path.split('/')[3]).filter((d): d is string => typeof d === 'string'),
    );
    for (const expectedDir of ['kb_capture', 'kb_promote', 'kb_demote', 'kb_bible_commit']) {
      expect(dirs.has(expectedDir), `expected an entry under fixtures/${expectedDir}/ in the epic diff`).toBe(true);
    }
  });

  it('every entry in the known pre-existing baseline is still present as exactly that modification, not silently reverted or deleted', () => {
    for (const [path] of KNOWN_PRE_EXISTING_FIXTURE_MODIFICATIONS) {
      const entry = entries.find((e) => e.path === path);
      expect(entry, `expected a diff entry for the known baseline path ${path}`).toBeDefined();
      expect(entry?.status.startsWith('M')).toBe(true);
    }
  });
});

describe('the sqlite-provider citation guard needs no second instance', () => {
  const GUARD_RELATIVE_PATH = 'tests/memory-contract-sqlite-provider-citations.test.ts';

  it('exists at the expected path and matches vitest.config.ts\'s tests/**/*.test.ts include glob', () => {
    const abs = fileURLToPath(new URL(`../${GUARD_RELATIVE_PATH}`, import.meta.url));
    expect(existsSync(abs)).toBe(true);
    expect(GUARD_RELATIVE_PATH.startsWith('tests/')).toBe(true);
    expect(GUARD_RELATIVE_PATH.endsWith('.test.ts')).toBe(true);
  });

  it('is a real, non-trivial vitest suite (not an empty placeholder)', () => {
    const abs = fileURLToPath(new URL(`../${GUARD_RELATIVE_PATH}`, import.meta.url));
    const text = readFileSync(abs, 'utf8');
    expect(text).toContain('describe(');
    expect((text.match(/\bit\(/g) ?? []).length).toBeGreaterThan(0);
  });
});

describe('taxonomy error_codes vs non_error_outcomes split for P-13 demote specifically', () => {
  const methods = JSON.parse(readFileSync(fileURLToPath(new URL('../memory-contract/v1/methods.json', import.meta.url)), 'utf8'));
  const taxonomy = JSON.parse(readFileSync(fileURLToPath(new URL('../memory-contract/v1/taxonomy.json', import.meta.url)), 'utf8'));

  function allTaxonomyCodes(): Set<string> {
    const out = new Set<string>();
    for (const group of Object.values(taxonomy.groups as Record<string, { codes: { code: string }[] }>)) {
      for (const entry of group.codes) out.add(entry.code);
    }
    return out;
  }
  function allNonErrorOutcomeNames(): Set<string> {
    return new Set((taxonomy.non_error_outcomes as { name: string }[]).map((o) => o.name));
  }

  it('methods.json declares P-13 demote with a non-empty error_codes list', () => {
    const demote = (methods.methods as { id: string; member: string; error_codes?: string[] }[]).find(
      (m) => m.id === 'P-13',
    );
    expect(demote?.member).toBe('demote');
    expect(demote?.error_codes?.length ?? 0).toBeGreaterThan(0);
  });

  it('every one of P-13\'s error_codes is a real taxonomy error code, never a bare non-error-outcome name', () => {
    const demote = (methods.methods as { id: string; error_codes?: string[] }[]).find((m) => m.id === 'P-13');
    const codes = allTaxonomyCodes();
    const nonErrorNames = allNonErrorOutcomeNames();
    for (const code of demote?.error_codes ?? []) {
      expect(nonErrorNames.has(code), `P-13 error_codes cites ${code}, which taxonomy.json disposes as non-error`).toBe(false);
      expect(codes.has(code), `P-13 error_codes cites ${code}, which is not a real taxonomy.json error code`).toBe(true);
    }
  });

  it('all five E-DEMOTE codes are present among P-13\'s error_codes', () => {
    const demote = (methods.methods as { id: string; error_codes?: string[] }[]).find((m) => m.id === 'P-13');
    const demoteCodes = new Set(demote?.error_codes ?? []);
    for (const code of [
      'E-DEMOTE-NOT-CONFIRMED',
      'E-DEMOTE-SUPERSEDED',
      'E-DEMOTE-REFUSED-DIRECTIVE',
      'E-DEMOTE-REASON-REQUIRED',
      'E-DEMOTE-EVIDENCE-UNRESOLVED',
    ]) {
      expect(demoteCodes.has(code), `P-13 error_codes is missing ${code}`).toBe(true);
    }
  });
});
