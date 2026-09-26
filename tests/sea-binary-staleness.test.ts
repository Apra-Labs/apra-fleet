// apra-fleet-v6t7.17.2: pins the staleness predicate the sibling [impl] task
// (apra-fleet-v6t7.17.1) added to tests/sea-http-verify.test.ts's "SEA binary
// smoke" suite. Drives the PURE predicate (evaluateSeaBinaryStaleness) with
// injected inputs, so this needs no real binary build and runs under plain
// `npm test`.
import { describe, it, expect } from 'vitest';
import { evaluateSeaBinaryStaleness, parseBuildHash } from './helpers/sea-binary-staleness.js';

describe('evaluateSeaBinaryStaleness (apra-fleet-v6t7.17.1 staleness predicate)', () => {
  it('stale: a resolvable build hash with a relevant changed file reports stale, with a message naming both "stale" and "npm run build:binary"', () => {
    const verdict = evaluateSeaBinaryStaleness({
      buildHash: '0c91f0',
      hashResolvable: true,
      changedRelevantFiles: ['scripts/gen-sea-config.mjs'],
    });

    expect(verdict.stale).toBe(true);
    expect(verdict.unknown).toBe(false);
    expect(verdict.message).toContain('stale');
    expect(verdict.message).toContain('npm run build:binary');
    expect(verdict.message).toContain('scripts/gen-sea-config.mjs');
  });

  it('stale: a relevant change under packages/apra-fleet-shell-ui also reports stale', () => {
    const verdict = evaluateSeaBinaryStaleness({
      buildHash: 'abc123',
      hashResolvable: true,
      changedRelevantFiles: ['packages/apra-fleet-shell-ui/src/pages/Members.tsx'],
    });

    expect(verdict.stale).toBe(true);
    expect(verdict.message).toContain('stale');
    expect(verdict.message).toContain('npm run build:binary');
  });

  it('fresh: build hash equals HEAD (no relevant changes at all) reports fresh with an empty message', () => {
    const verdict = evaluateSeaBinaryStaleness({
      buildHash: 'deadbe',
      hashResolvable: true,
      changedRelevantFiles: [],
    });

    expect(verdict.stale).toBe(false);
    expect(verdict.unknown).toBe(false);
    expect(verdict.message).toBe('');
  });

  it('fresh: only an UNRELATED file changed since the build hash reports fresh -- an unrelated commit must never mark the binary stale', () => {
    // The gatherer (resolveSeaBinaryStaleness) is responsible for restricting
    // `changedRelevantFiles` to SEA-relevant paths in the first place (via
    // `git diff -- <SEA_RELEVANT_GIT_PATHS>`), so a docs-only or unrelated
    // commit never appears in this list at all -- this case pins that the
    // PREDICATE itself also treats an empty list as fresh regardless of how
    // much unrelated history moved.
    const verdict = evaluateSeaBinaryStaleness({
      buildHash: 'f00d12',
      hashResolvable: true,
      changedRelevantFiles: [],
    });

    expect(verdict.stale).toBe(false);
  });

  it('stale-unknown: a null build hash (nothing parsed from --version output) reports stale-unknown with a readable message, never throws', () => {
    const verdict = evaluateSeaBinaryStaleness({
      buildHash: null,
      hashResolvable: false,
      changedRelevantFiles: [],
    });

    expect(verdict.stale).toBe(true);
    expect(verdict.unknown).toBe(true);
    expect(verdict.message).toContain('stale-unknown');
    expect(verdict.message).toContain('npm run build:binary');
    expect(verdict.message.length).toBeGreaterThan(0);
  });

  it('stale-unknown: a parsed hash that does not resolve locally (shallow clone / rewritten history) also reports stale-unknown, never throws', () => {
    const verdict = evaluateSeaBinaryStaleness({
      buildHash: 'ffffff',
      hashResolvable: false,
      changedRelevantFiles: [],
    });

    expect(verdict.stale).toBe(true);
    expect(verdict.unknown).toBe(true);
    expect(verdict.message).toContain('ffffff');
    expect(verdict.message).toContain('stale-unknown');
  });
});

describe('parseBuildHash', () => {
  it('extracts the 6-char hash suffix from a real --version-style output line', () => {
    expect(parseBuildHash('apra-fleet v0.4.3_6ef5d6\n  Mode:   sea\n')).toBe('6ef5d6');
  });

  it('returns null when the version string carries no hash suffix (dev/npm build with no git info)', () => {
    expect(parseBuildHash('apra-fleet v0.4.3\n  Mode:   node\n')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseBuildHash('not a version string at all')).toBeNull();
  });
});
