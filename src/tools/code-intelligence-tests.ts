// Test-path matcher (P9, design D9). Pure, dependency-free so it can be unit
// tested directly and imported by both code-intelligence-gitnexus.ts (T4.4
// code_tests) and its tests without pulling in any IO.

const TEST_SEGMENT_NAMES = new Set(['test', 'tests', 'spec']);

// Matches a filename ending in ".test.<ext>" or ".spec.<ext>", e.g.
// "foo.test.ts" or "bar.spec.js". Requires a non-empty extension after
// ".test"/".spec" so a bare "protest.spec" (no trailing ".<ext>") does not
// match via this branch.
const TEST_FILENAME_PATTERN = /\.(test|spec)\.[^.]+$/i;

// True when any path segment is exactly "test", "tests", or "spec"
// (case-insensitive), or the filename matches /\.(test|spec)\.[^.]+$/.
// Handles both "/" and "\" separators since child output can carry Windows
// paths on this platform.
export function isTestPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;

  const segments = path.split(/[/\\]+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => TEST_SEGMENT_NAMES.has(segment.toLowerCase()))) {
    return true;
  }

  const filename = segments[segments.length - 1] ?? '';
  return TEST_FILENAME_PATTERN.test(filename);
}
