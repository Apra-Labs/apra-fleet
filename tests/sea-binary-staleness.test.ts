// apra-fleet-v6t7.17.2: pins the staleness predicate the sibling [impl] task
// (apra-fleet-v6t7.17.1) added to tests/sea-http-verify.test.ts's "SEA binary
// smoke" suite. Drives the PURE predicate (evaluateSeaBinaryStaleness) with
// injected inputs, so this needs no real binary build and runs under plain
// `npm test`.
//
// apra-fleet-v6t7.20 also covers findUiDistFilesNotEmbedded -- the content
// comparison that replaced the old UI-dist mtime proxy -- against scratch
// files, so it needs no real binary either.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateSeaBinaryStaleness,
  findUiDistFilesNotEmbedded,
  parseBuildHash,
  SEA_RELEVANT_GIT_PATHS,
} from './helpers/sea-binary-staleness.js';

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

describe('findUiDistFilesNotEmbedded (apra-fleet-v6t7.20 content comparison)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A scratch shell dist plus a fake "binary" embedding the named files verbatim. */
  function makeFixture(distFiles: Record<string, string>, embed: string[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-ui-content-'));
    tmpDirs.push(root);
    const shellDistDir = path.join(root, 'dist');
    for (const [rel, content] of Object.entries(distFiles)) {
      const full = path.join(shellDistDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const binaryPath = path.join(root, 'fake-binary');
    // Padding around the embedded assets mirrors a real SEA blob, where the
    // asset bytes sit verbatim inside a much larger executable.
    fs.writeFileSync(binaryPath, `\u0000NODE_SEA_BLOB${embed.map((rel) => distFiles[rel]).join('\u0000')}\u0000tail`);
    return { shellDistDir, binaryPath };
  }

  it('fresh: reports nothing when every built asset is embedded verbatim, even after a byte-identical rebuild bumps mtimes (the old proxy\'s false positive)', () => {
    const files = { 'index.html': '<div id="root"></div>', 'assets/index-abc123.js': 'console.log("shell")' };
    const { shellDistDir, binaryPath } = makeFixture(files, ['index.html', 'assets/index-abc123.js']);

    // Rebuild in place with identical bytes: mtimes now postdate the binary.
    const future = new Date(Date.now() + 60_000);
    for (const rel of Object.keys(files)) {
      fs.writeFileSync(path.join(shellDistDir, rel), files[rel as keyof typeof files]);
      fs.utimesSync(path.join(shellDistDir, rel), future, future);
    }

    expect(findUiDistFilesNotEmbedded({ binaryPath, shellDistDir })).toEqual([]);
  });

  it('stale: names the drifted asset when a built file\'s content is not in the binary (e.g. a ui-kit change git diff cannot see)', () => {
    const { shellDistDir, binaryPath } = makeFixture(
      { 'index.html': '<div id="root"></div>', 'assets/index-abc123.js': 'console.log("shell")' },
      ['index.html'],
    );

    const drifted = findUiDistFilesNotEmbedded({ binaryPath, shellDistDir, distLabel: 'shell-ui/dist' });

    expect(drifted).toEqual([path.join('shell-ui/dist', 'assets/index-abc123.js')]);
  });

  it('returns [] when the shell dist or the binary is absent (nothing to compare)', () => {
    const { shellDistDir, binaryPath } = makeFixture({ 'index.html': 'x' }, ['index.html']);

    expect(findUiDistFilesNotEmbedded({ binaryPath, shellDistDir: path.join(shellDistDir, 'nope') })).toEqual([]);
    expect(findUiDistFilesNotEmbedded({ binaryPath: `${binaryPath}.missing`, shellDistDir })).toEqual([]);
  });
});

describe('SEA_RELEVANT_GIT_PATHS covers bundled workspace packages (apra-fleet-v6t7.21)', () => {
  // Mirrors git pathspec prefix semantics: equal to an entry or under entry + '/'.
  const matched = (file: string) =>
    SEA_RELEVANT_GIT_PATHS.some((entry) => file === entry || file.startsWith(`${entry}/`));

  it.each([
    'packages/apra-fleet-client/src/auth/local-token.ts',
    'packages/apra-fleet-client/package.json',
    'packages/fleet-api-contract/src/index.ts',
    'packages/fleet-api-contract/package.json',
    'packages/apra-fleet-ui-kit/src/Wizard.tsx',
    'packages/apra-fleet-ui-kit/package.json',
  ])('matches %s', (file) => {
    expect(matched(file)).toBe(true);
  });

  it.each(['docs/npm-packaging.md', 'packages/apra-fleet-client/test/x.test.ts', 'packages/apra-fleet-ui-kit/dist/Form.js'])(
    'does not match unrelated path %s',
    (file) => {
      expect(matched(file)).toBe(false);
    },
  );

  it('stale: a change under packages/apra-fleet-client reports stale and names the file', () => {
    const file = 'packages/apra-fleet-client/src/auth/local-token.ts';
    const verdict = evaluateSeaBinaryStaleness({ buildHash: 'abc123', hashResolvable: true, changedRelevantFiles: [file] });

    expect(verdict.stale).toBe(true);
    expect(verdict.message).toContain(file);
  });
});
