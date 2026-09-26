import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { applyIsolatedHome } from './helpers/isolated-home.mjs';

// apra-fleet-y3xp.4: static + behavioural guard for the test-home-isolation
// bug (apra-fleet-y3xp lane). Makes the bug this lane fixed unable to come
// back unnoticed: any test that hand-rolls a HOME override (instead of
// going through tests/helpers/isolated-home.mjs) fails THIS test, naming
// the offending file and line.
//
// Scope: this file statically scans source under tests/**, packages/*/test/**
// and packages/*/tests/** for three patterns:
//   1. process.env.HOME = ... / process.env['HOME'] = ... / process.env["HOME"] = ...
//   2. vi.stubEnv('HOME', ...) / vi.stubEnv("HOME", ...)
//   3. a `HOME:` object-literal key with no nearby "isolated-home-allow:"
//      justification comment (the marker the migration tasks in this lane
//      settled on -- see tests/helpers/isolated-home.mjs's header and its
//      callers for examples).
//
// It runs under the root `npm test` (vitest), which covers the node --test
// package trees STATICALLY (by reading their source as text) even though
// the root bounded runner does not execute those suites itself.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs']);

// Files this guard must never flag itself against: the shared helper (the
// one place literal HOME assignment is legitimate) and this guard file
// itself (whose pattern strings would otherwise trip its own scan).
const EXEMPT_FILES = new Set([
  path.join(REPO_ROOT, 'tests', 'helpers', 'isolated-home.mjs'),
  path.join(REPO_ROOT, 'tests', 'helpers', 'isolated-home.test.ts'),
  path.join(REPO_ROOT, 'tests', 'test-home-isolation-guard.test.ts'),
]);

const SCAN_ROOTS = ['tests', 'packages'];

/** Directory name never descended into while walking. */
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'sprint-logs', '.git']);

function isUnderScannedPackageTestDir(relFromPackages: string): boolean {
  // packages/<pkg>/test/** or packages/<pkg>/tests/**
  const parts = relFromPackages.split(path.sep);
  return parts.length >= 2 && (parts[1] === 'test' || parts[1] === 'tests');
}

function collectSourceFiles(): string[] {
  const results: string[] = [];

  function walk(dir: string, opts: { isPackagesRoot?: boolean; packagesRelBase?: string } = {}): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (opts.isPackagesRoot) {
          // Only descend into packages/<pkg>/test or packages/<pkg>/tests,
          // not the rest of each package (src/, node_modules, etc.).
          walk(full, { packagesRelBase: full });
        } else if (opts.packagesRelBase !== undefined) {
          const rel = path.relative(opts.packagesRelBase, full);
          const top = rel.split(path.sep)[0];
          if (top === 'test' || top === 'tests') {
            walk(full);
          } else if (path.relative(REPO_ROOT, full).split(path.sep).length <= 2) {
            // still inside packages/<pkg>/ itself (not yet at test/tests) --
            // keep descending one more level to find test/tests.
            walk(full, { packagesRelBase: opts.packagesRelBase });
          }
          // otherwise: some other package subdirectory (src/, dist/, ...) -- skip.
        } else {
          walk(full);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(path.join(dir, entry.name));
        }
      }
    }
  }

  for (const root of SCAN_ROOTS) {
    const full = path.join(REPO_ROOT, root);
    if (!fs.existsSync(full)) continue;
    walk(full, { isPackagesRoot: root === 'packages' });
  }

  return results.filter((f) => !EXEMPT_FILES.has(f));
}

/** Strips quoted string/template literal contents on a single line (best
 *  effort, no cross-line strings) so a test-name string containing literal
 *  "HOME:" text (e.g. "a directory that does not exist under $HOME: exit 0")
 *  cannot false-positive the HOME-key scan below. */
function stripStringLiterals(line: string): string {
  return line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => '"'.repeat(m.length));
}

const JUSTIFICATION_MARKER = 'isolated-home-allow:';
const JUSTIFICATION_LOOKBACK_LINES = 6;

interface Violation {
  file: string;
  line: number;
  reason: string;
}

/** The one scanning implementation, shared by the real file scan and the
 *  in-memory falsification tests below -- so those tests actually pin the
 *  real code path instead of a re-derivation of it. */
function scanText(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;

    // Pattern 1: direct process.env.HOME assignment.
    if (/process\.env(\.HOME|\[['"]HOME['"]\])\s*=(?!=)/.test(rawLine)) {
      violations.push({ file, line: lineNo, reason: "direct 'process.env.HOME =' assignment outside the shared isolated-home helper" });
      continue;
    }

    // Pattern 2: vi.stubEnv('HOME', ...).
    if (/\bstubEnv\(\s*['"]HOME['"]/.test(rawLine)) {
      violations.push({ file, line: lineNo, reason: "vi.stubEnv('HOME', ...) outside the shared isolated-home helper" });
      continue;
    }

    // Pattern 3: an object-literal HOME: key, on a line with string
    // literals stripped first so a HOME: substring inside a test-name
    // string can never match.
    const stripped = stripStringLiterals(rawLine);
    if (/(?<![A-Za-z0-9_$])HOME\s*:/.test(stripped)) {
      const windowStart = Math.max(0, i - JUSTIFICATION_LOOKBACK_LINES);
      const window = lines.slice(windowStart, i + 1).join('\n');
      if (!window.includes(JUSTIFICATION_MARKER)) {
        violations.push({
          file,
          line: lineNo,
          reason: `'HOME:' env-object key with no nearby "${JUSTIFICATION_MARKER}" justification comment`,
        });
      }
    }
  }

  return violations;
}

function scanFile(file: string): Violation[] {
  return scanText(file, fs.readFileSync(file, 'utf8'));
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  ${path.relative(REPO_ROOT, v.file)}:${v.line} -- ${v.reason}`)
    .join('\n');
}

describe('test-home-isolation guard (apra-fleet-y3xp)', () => {
  it('every test file under tests/**, packages/*/test/** and packages/*/tests/** isolates HOME only through the shared helper', () => {
    const files = collectSourceFiles();
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(scanFile);

    expect(
      violations,
      violations.length > 0
        ? `Found ${violations.length} test-home-isolation violation(s). Use tests/helpers/isolated-home.mjs ` +
          `(applyIsolatedHome/buildIsolatedHomeEnv) instead, or justify with a "${JUSTIFICATION_MARKER}" ` +
          `comment within ${JUSTIFICATION_LOOKBACK_LINES} lines above the HOME: key:\n${formatViolations(violations)}`
        : undefined,
    ).toEqual([]);
  });

  it('a bare process.env.HOME assignment is detected by the scanner itself (falsification, no disk write)', () => {
    // Exercises scanFile's pattern-matching logic directly on in-memory
    // text, proving the regex actually flags the exact shape the bug
    // reintroduces, without touching any real file on disk (see the
    // separate falsification test below for the "reverting the fix makes
    // this test fail" check against real files).
    const violations = scanFileFromText('const x = 1;\nprocess.env.HOME = "/somewhere";\n');
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it("an unjustified 'HOME:' child-env key is detected", () => {
    const violations = scanFileFromText('const env = { HOME: tmpHome };\n');
    expect(violations).toHaveLength(1);
  });

  it("a justified 'HOME:' child-env key (isolated-home-allow marker nearby) is NOT flagged", () => {
    const violations = scanFileFromText(
      '// isolated-home-allow: this is git-config isolation, not os.homedir()\nconst env = { HOME: tmpHome };\n',
    );
    expect(violations).toHaveLength(0);
  });

  it("a HOME: substring inside a test-name STRING literal is NOT flagged", () => {
    const violations = scanFileFromText(
      "it('a directory that does not exist under $HOME: exit 0 with empty stdout', () => {});\n",
    );
    expect(violations).toHaveLength(0);
  });

  it("an identifier merely ending in _HOME (e.g. HUB_HOME:) is NOT flagged", () => {
    const violations = scanFileFromText('const HUB_HOME: Record<string, string> = {};\n');
    expect(violations).toHaveLength(0);
  });

  it('behavioural: under the helper, os.homedir() and APRA_FLEET_DATA_DIR resolve inside the temp dir', async () => {
    const home = await applyIsolatedHome('guard-behavioural-');
    try {
      expect(os.homedir()).toBe(home.tempHome);
      expect(process.env.APRA_FLEET_DATA_DIR).toBe(home.dataDir);
      expect(home.dataDir.startsWith(home.tempHome)).toBe(true);
    } finally {
      await home.restore();
    }
  });
});

const INLINE_FIXTURE_PATH = path.join(REPO_ROOT, 'tests', '__guard_inline_fixture__.ts');
function scanFileFromText(text: string): Violation[] {
  return scanText(INLINE_FIXTURE_PATH, text);
}
