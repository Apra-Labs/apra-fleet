// Shared helpers for the Phase 4 task 13 regression guard (apra-fleet-7pm.14):
// existing command-surface outputs (install --help, uninstall --dry-run,
// run --transport stdio handshake, --version) must stay byte-for-byte
// unchanged across this epic's install.ts/uninstall.ts/update.ts/index.ts edits.
//
// Fixtures live under tests/fixtures/regression-command-surface/ and are kept
// ASCII-only (per repo convention). Some CLI output uses non-ASCII glyphs
// (em dash, right arrow, warning sign); normalizeCommandSurfaceOutput() maps
// those to their ASCII equivalents before comparison so the fixtures on disk
// never need a non-ASCII byte. This file itself stays ASCII-only too: the
// glyphs are matched via \uXXXX escapes (em dash U+2014, right arrow U+2192,
// warning sign U+26A0) rather than raw non-ASCII bytes in source.
//
// Fixture reads use createRequire(import.meta.url) rather than a top-level
// `import fs from 'node:fs'` so that consumers which call `vi.mock('node:fs')`
// at module scope (e.g. tests/install-multi-provider.test.ts) do not perturb
// fixture loading -- the lazy require() bypasses vitest's module mock, same
// strategy documented in src/version.ts and tests/version.test.ts.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'regression-command-surface');
const require = createRequire(import.meta.url);

/**
 * Normalize dynamic/non-ASCII CLI output for stable fixture comparison:
 *  - CRLF -> LF
 *  - known non-ASCII glyphs -> their ASCII equivalents (em dash -> --, right
 *    arrow -> ->, warning sign -> [WARN])
 *  - trailing whitespace/newlines trimmed, single trailing newline appended
 */
export function normalizeCommandSurfaceOutput(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\u2014/g, '--')
    .replace(/\u2192/g, '->')
    .replace(/\u26a0/g, '[WARN]')
    .replace(/\n+$/, '') + '\n';
}

export function readCommandSurfaceFixture(name: string): string {
  const fs = require('node:fs') as typeof import('node:fs');
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

/**
 * Build a RegExp from a fixture that contains `{PLACEHOLDER}` tokens (e.g.
 * `{VERSION}`, `{MODE}`, `{BINARY}`, `{PM_SKILLS_DIR}`) standing in for
 * environment-/build-dependent values that cannot be pinned byte-for-byte.
 * Every other character in the fixture is treated as a literal (regex
 * special characters are escaped), so a match against this RegExp proves
 * the surrounding text is unchanged while allowing the placeholder spans to
 * hold any value.
 */
export function fixtureToRegex(fixtureText: string): RegExp {
  const escaped = fixtureText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withPlaceholders = escaped.replace(/\\\{([A-Z_]+)\\\}/g, '[\\s\\S]*?');
  return new RegExp('^' + withPlaceholders + '$');
}

/**
 * Fill a fixture's `{PLACEHOLDER}` tokens with concrete values, for cases
 * where building an exact expected string (rather than matching a regex) is
 * more convenient (e.g. JSON fixtures compared after JSON.parse).
 */
export function fillFixturePlaceholders(fixtureText: string, values: Record<string, string>): string {
  return fixtureText.replace(/\{([A-Z_]+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}
