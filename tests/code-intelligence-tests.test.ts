import { describe, it, expect } from 'vitest';
import { isTestPath } from '../src/tools/code-intelligence-tests.js';

// ---------------------------------------------------------------------------
// isTestPath() -- pure function, design D9. True when any path segment is
// "test", "tests", or "spec" (case-insensitive), or the filename matches
// /\.(test|spec)\.[^.]+$/. Must handle both "/" and "\" separators.
// ---------------------------------------------------------------------------
describe('isTestPath()', () => {
  const positives: Array<[string, string]> = [
    ['segment "tests" (posix)', 'tests/foo.ts'],
    ['segment "TESTS" mixed case', 'src/TESTS/x.ts'],
    ['segment "spec" (backslash separators)', 'a\\spec\\b.ts'],
    ['segment "test" exact', 'test/helper.js'],
    ['segment "Test" mixed case', 'src/Test/helper.js'],
    ['segment "spec" among many posix segments', 'a/b/spec/c/d.ts'],
    ['filename .test.ts', 'foo.test.ts'],
    ['filename .spec.js', 'bar.spec.js'],
    ['filename .test.tsx nested path', 'src/components/Button.test.tsx'],
    ['filename .spec.ts backslash path', 'src\\components\\Button.spec.ts'],
    ['both a segment and a filename match', 'tests/foo.test.ts'],
  ];

  for (const [label, path] of positives) {
    it(`matches: ${label} (${path})`, () => {
      expect(isTestPath(path)).toBe(true);
    });
  }

  const negatives: Array<[string, string]> = [
    ['"contest" is not "test"', 'contest/file.ts'],
    ['"attest.ts" filename does not match', 'attest.ts'],
    ['"testfile.ts" filename does not match', 'testfile.ts'],
    ['"protest.spec" has no extension after .spec', 'src/lib/protest.spec'],
    ['plain product path, no test/spec anywhere', 'src/lib/handlers/index.ts'],
    ['"attestation" directory is not "test"', 'attestation/report.ts'],
    ['"specimen" directory is not "spec"', 'specimen/data.ts'],
    ['empty string', ''],
  ];

  for (const [label, path] of negatives) {
    it(`does not match: ${label} (${JSON.stringify(path)})`, () => {
      expect(isTestPath(path)).toBe(false);
    });
  }

  it('matches a mixed-separator path with a test segment', () => {
    expect(isTestPath('src\\lib/tests\\foo.ts')).toBe(true);
  });

  it('matches a mixed-separator path via the filename pattern', () => {
    expect(isTestPath('src\\lib/components/Foo.spec.ts')).toBe(true);
  });

  it('is not fooled by "test" appearing only as a filename substring, not a segment or suffix', () => {
    expect(isTestPath('src/testHelpers.ts')).toBe(false);
  });
});
