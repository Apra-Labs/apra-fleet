import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// apra-fleet-0v0.2 -- regression test locking apra-fleet-0v0 shut.
//
// undici 8.x is incompatible with Node 20 (webidl.util.markAsUncloneable is
// not a function, thrown from CacheStorage construction at import time).
// apra-fleet-0v0.1 pinned undici to ^7.29.0 directly and via a root
// `overrides` block so no transitive dependency can reintroduce 8.x. This
// test guards that fix: it fails loudly if undici 8.x ever resolves again.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('undici / Node 20 compatibility (apra-fleet-0v0 regression)', () => {
  it('resolves undici to a 7.x version', () => {
    const undiciPkg = require('undici/package.json');
    expect(undiciPkg.version).toMatch(/^7\./);
  });

  it('imports undici without throwing (guards the markAsUncloneable crash)', async () => {
    // This is the exact crash surface from apra-fleet-0v0: undici 8.x throws
    // 'webidl.util.markAsUncloneable is not a function' while constructing
    // its CacheStorage global at module-load time under Node 20.
    await expect(import('undici')).resolves.toBeDefined();
    expect(() => require('undici')).not.toThrow();
  });

  it('has no undici 8.x anywhere in the resolved dependency tree', () => {
    // Walk the full `npm ls undici` output (root + all workspaces) rather
    // than trusting a single resolved copy -- this is what would catch a
    // transitive re-introduction that require.resolve() alone would miss.
    // shell: true required on Windows -- npm resolves to the npm.cmd shim,
    // and Node's execFileSync cannot exec a .cmd/.bat file without a shell
    // (see src/cli/install.ts and scripts/lib/exec-bd.mjs for the same
    // convention elsewhere in this codebase). Safe here: no user-controlled
    // input reaches the args array.
    const output = execFileSync(
      'npm',
      ['ls', 'undici', '--all', '--json'],
      { cwd: repoRoot, encoding: 'utf8', shell: true }
    );
    const tree = JSON.parse(output);

    const versions: string[] = [];
    const collect = (node: any) => {
      if (!node) return;
      if (node.dependencies?.undici?.version) {
        versions.push(node.dependencies.undici.version);
      }
      for (const dep of Object.values(node.dependencies ?? {})) {
        collect(dep);
      }
    };
    collect(tree);

    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version.startsWith('8.')).toBe(false);
      expect(version).toMatch(/^7\./);
    }
  });

  it('pins undici via an npm override so transitive deps cannot escape 7.x', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(path.join(repoRoot, 'package.json'));
    expect(pkg.overrides?.undici).toBeDefined();
    expect(pkg.overrides.undici).toMatch(/^\^?7\./);
  });
});
