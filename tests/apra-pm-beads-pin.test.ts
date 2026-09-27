import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEADS_VERSION } from '../src/cli/beads-install.js';

// apra-fleet-i9ag.12.4 -- packages/apra-fleet-se/apra-pm/install.mjs pinned
// '@beads/bd@1.1.2' while the product had moved to 1.3.0, and on failure printed
// a single '[!] beads install failed' line before going on to report
// 'pm installed.' -- a false success on a machine left with no bd at all.
//
// The pin is necessarily DUPLICATED: that installer is deliberately
// dependency-free plain Node (node: builtins only, no build step), so it cannot
// import BEADS_VERSION from the TypeScript module that owns it. This suite is
// what stops the copy rotting silently -- it fails the build the moment the two
// disagree, which is the loud-failure substitute for a shared constant.
//
// install.mjs is read as TEXT rather than imported: it is an installer whose
// module scope writes to the real HOME, so importing it here would be unsafe.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PM_INSTALLER = path.join(__dirname, '../packages/apra-fleet-se/apra-pm/install.mjs');

describe('apra-pm installer beads pin (apra-fleet-i9ag.12.4)', () => {
  const source = fs.readFileSync(PM_INSTALLER, 'utf-8');

  it('declares a BEADS_VERSION equal to src/cli/beads-install.ts BEADS_VERSION', () => {
    const declared = source.match(/^const BEADS_VERSION = '([^']+)';$/m);
    expect(declared, 'apra-pm/install.mjs must declare a single BEADS_VERSION constant').not.toBeNull();
    expect(declared![1]).toBe(BEADS_VERSION);
  });

  it('never hardcodes a beads version next to @beads/bd -- the pin comes from the constant', () => {
    // A literal '@beads/bd@1.2.3' would drift again; the install call must
    // interpolate the constant instead.
    const hardcoded = source.match(/@beads\/bd@(?!\$\{)[^'"`\s]+/g);
    expect(hardcoded ?? [], `found a hardcoded @beads/bd pin: ${JSON.stringify(hardcoded)}`).toEqual([]);
    expect(source).toMatch(/@beads\/bd@\$\{BEADS_VERSION\}/);
  });

  it('treats a failed beads install as FATAL rather than warning and reporting success', () => {
    // The regression: the old code logged and fell through to 'pm installed.'.
    expect(source).toMatch(/beads \(bd\) could not be installed/);
    // Both failure paths (npm itself failing, and npm succeeding while bd still
    // does not run) must exit non-zero.
    const exits = source.match(/process\.exit\(1\)/g) ?? [];
    expect(exits.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/beads install failed\. Run manually/);
  });

  it('still reports the already-installed case without touching npm', () => {
    // bd present must remain a no-op success path, not a reinstall.
    expect(source).toMatch(/beads OK: /);
  });
});
