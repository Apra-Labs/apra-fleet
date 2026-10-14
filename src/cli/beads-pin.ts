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
// The ONE unavoidable duplicate is packages/apra-fleet-se/apra-pm/install.mjs:
// that installer is deliberately plain, build-free Node (node: builtins only)
// and so cannot import from this TypeScript module. Its copy is held equal to
// this one by tests/apra-pm-beads-pin.test.ts, which fails the moment the two
// disagree. .github/workflows/ci.yml states the pin a third time for the same
// reason (a shell step cannot import TypeScript either); that file is owned by
// another track, so it is deliberately not edited from here.

/** The exact @beads/bd version this product installs and supports. */
export const BEADS_VERSION = '1.3.0';

/** The npm package specifier to install -- always built from BEADS_VERSION. */
export const BEADS_PACKAGE = `@beads/bd@${BEADS_VERSION}`;
