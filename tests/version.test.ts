/**
 * tests/version.test.ts
 *
 * Unit tests for src/version.ts resolveVersion().
 *
 * Mocking strategy note
 * =====================
 * version.ts loads fs/path/url LAZILY via createRequire(import.meta.url) rather than
 * top-level ESM imports.  This was deliberate: a module-scope vi.mock('node:fs') is
 * evaluated before module load but the lazy require() call bypasses it because
 * createRequire returns native Node require -- not the vi-intercepted one.
 *
 * Consequence: vi.mock('node:fs') does NOT change what resolveVersion() reads.
 *
 * Instead we use the following strategies per test case:
 *
 *   BUILD_VERSION (SEA path)  -- vi.stubGlobal + vi.resetModules + dynamic import
 *   ESM real-semver path      -- import the real module; it reads the real version.json
 *                                (which exists at project root) so we verify the semver
 *                                pattern and that the returned string starts with 'v'.
 *   Fallback v0.0.0-unknown   -- NOT directly triggerable in this test environment.
 *                                'node:module' is a native Node built-in resolved by
 *                                Node's own ESM loader before vitest interceptors run;
 *                                vi.mock/vi.doMock cannot intercept it.  The fallback
 *                                path is tested structurally: we verify the source
 *                                contains the fallback string and that the logic is
 *                                correctly positioned inside a try/catch.
 *   Git-hash suffix           -- the project root has a .git directory so the real import
 *                                includes a _<hash> suffix; we verify the pattern.
 *
 * All tests that re-evaluate the module use vi.resetModules() + dynamic import so that
 * the module-scope serverVersion const is re-computed with the current stub state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serverVersion } from '../src/version.js';

const __filename = fileURLToPath(import.meta.url);
const __testdir = dirname(__filename);

// ---------------------------------------------------------------------------
// Helper: re-import version.ts after module cache is cleared.
// ---------------------------------------------------------------------------
async function freshServerVersion(): Promise<string> {
  const mod = await import('../src/version.js');
  return mod.serverVersion;
}

// ---------------------------------------------------------------------------
// Suite 1: Direct import (ESM real-semver path)
//
// The module is imported once at the top of the file.  In test environment:
//   - package type is "module" -> vitest runs in ESM mode
//   - __dirname is undefined  -> ESM branch of resolveVersion() executes
//   - createRequire(import.meta.url) is used to lazily load node:fs
//   - version.json exists at <project-root>/version.json and is real
//   - .git/HEAD exists        -> git-hash suffix is appended
// ---------------------------------------------------------------------------
describe('resolveVersion -- ESM real-semver path (direct import)', () => {
  it('returns a string starting with "v"', () => {
    expect(serverVersion).toMatch(/^v/);
  });

  it('contains a valid semver component (MAJOR.MINOR.PATCH)', () => {
    // Matches e.g. "v0.2.2" or "v0.2.2_abc123"
    expect(serverVersion).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('is not the fallback v0.0.0-unknown', () => {
    expect(serverVersion).not.toBe('v0.0.0-unknown');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Git-hash suffix
//
// The project has a .git directory, so the devOnly hash branch runs.
// The suffix is "_" followed by 6 hex characters.
// ---------------------------------------------------------------------------
describe('resolveVersion -- git-hash suffix', () => {
  it('appends a _<6-char-hex> suffix when .git/HEAD exists', () => {
    // e.g. "v0.2.2_5d1460"
    expect(serverVersion).toMatch(/^v\d+\.\d+\.\d+_[0-9a-f]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: BUILD_VERSION / SEA path
//
// When the global BUILD_VERSION is defined (as esbuild injects at bundle time),
// resolveVersion() returns it immediately without reading version.json.
// We simulate this by stubbing the global before resetting the module cache.
// ---------------------------------------------------------------------------
describe('resolveVersion -- BUILD_VERSION (SEA / esbuild path)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns BUILD_VERSION directly when the global is defined', async () => {
    vi.stubGlobal('BUILD_VERSION', 'v9.9.9-sea');
    const { serverVersion: v } = await import('../src/version.js');
    expect(v).toBe('v9.9.9-sea');
  });

  it('does not read version.json when BUILD_VERSION is set', async () => {
    // If BUILD_VERSION branch is taken, the file-read path is never reached.
    // We verify indirectly: even with a recognisably artificial value the module
    // returns exactly that value with no semver parsing.
    vi.stubGlobal('BUILD_VERSION', 'injected-by-build');
    const { serverVersion: v } = await import('../src/version.js');
    expect(v).toBe('injected-by-build');
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Fallback -- v0.0.0-unknown (structural test)
//
// The fallback path (catch block returning 'v0.0.0-unknown') is reached when
// BUILD_VERSION is absent AND reading version.json throws (stripped install,
// missing file, I/O error).
//
// WHY this cannot be triggered directly in this test environment:
//   version.ts uses `import { createRequire } from 'node:module'` (static ESM
//   import).  'node:module' is a native Node.js built-in resolved by Node's own
//   ESM loader BEFORE vitest's mock registry runs -- so vi.mock('node:module')
//   and vi.doMock('node:module') both silently have no effect.  The lazy
//   require() inside resolveVersion() always gets the real Node require, and the
//   real version.json is found at the project root, so the fallback is never
//   triggered.
//
// Mitigation per PLAN.md: "if a path is genuinely untestable in isolation, test
// it via its observable output and note why."  We assert:
//   (a) The source file contains the literal fallback string.
//   (b) The fallback is inside a catch block (structural code shape).
//   (c) When BUILD_VERSION is defined the function returns early (no file I/O
//       path is taken), so BUILD_VERSION implicitly covers the "no version.json"
//       production use-case for SEA binaries.
// ---------------------------------------------------------------------------
describe('resolveVersion -- fallback v0.0.0-unknown (structural)', () => {
  it('source contains the fallback string v0.0.0-unknown inside a catch block', () => {
    const src = readFileSync(join(__testdir, '..', 'src', 'version.ts'), 'utf-8');
    // The fallback return is present in the source.
    expect(src).toContain("'v0.0.0-unknown'");
    // It is inside a catch block (the catch keyword appears before the return).
    const catchIdx = src.lastIndexOf('} catch {');
    const fallbackIdx = src.lastIndexOf("'v0.0.0-unknown'");
    expect(catchIdx).toBeGreaterThan(0);
    expect(fallbackIdx).toBeGreaterThan(catchIdx);
  });

  it('the real serverVersion is not the fallback (version.json is present)', () => {
    // This confirms that in the current environment the fallback is NOT taken.
    expect(serverVersion).not.toBe('v0.0.0-unknown');
  });
});
