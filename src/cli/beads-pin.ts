// Single source of truth for the Beads (bd) npm pin (apra-fleet-i9ag.13.7.2).
//
// bd ships as an npm GLOBAL package, not a standalone release binary -- the
// owner re-scope recorded on apra-fleet-i9ag.13 (which supersedes that bead's
// original description) removed the download-a-release-binary approach and the
// src/cli/beads-install.ts module that used to own this constant. That left
// the pin as a bare literal in src/cli/install.ts while
// packages/apra-fleet-se/apra-pm/install.mjs kept its own copy, i.e. no single
// owner at all -- the exact drift shape that caused apra-fleet-i9ag.12.4 (the
// pm installer pinned 1.1.2 long after the product moved to 1.3.0).
//
// This module is that owner. It is deliberately dependency-free (no imports,
// no side effects) so anything may import it -- the installer, tests, and any
// future status/health reporter -- without dragging in the installer itself.
//
// The unavoidable duplicates are sites that cannot import this TypeScript module:
// packages/apra-fleet-se/apra-pm/install.mjs (plain, build-free Node: node:
// builtins only), .github/e2e/fleet-setup.mjs, and the shell steps and env of
// .github/workflows/ci.yml and pm-e2e.yml. tests/apra-pm-beads-pin.test.ts reads
// every tracked file and fails the moment any pin disagrees with this one.

/** The exact @beads/bd version this product installs and supports. */
export const BEADS_VERSION = '1.3.0';

/** The npm package specifier to install -- always built from BEADS_VERSION. */
export const BEADS_PACKAGE = `@beads/bd@${BEADS_VERSION}`;
