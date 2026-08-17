import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { KbCaptureRejected } from '../../src/services/knowledge/types.js';

// apra-fleet-b4g.2.2: pins apra-fleet-b4g.2.1's provider-cache-key fix --
// getKbProviders is now keyed by (slug, repoPath), NOT slug alone. Before the
// fix, two repos sharing one slug (the SAME remote, cloned/checked out at
// different paths -- exactly what a fleet server sees across members)
// collapsed onto whichever repoPath the FIRST caller supplied for that slug:
// every later caller's basis check, freshness sweep, and capture anchor
// silently ran against the first repo's tree instead of its own.
//
// Case 1 pins the regression directly (same slug, different repoPath).
// Case 2 pins the still-required same-key sharing, including the unawaited/
// concurrent path. Case 3 proves the anchor is REAL -- not just a readback of
// the stored field -- via the capture basis-check consequence. Case 4 pins
// that resetKbProviders() clears the composite key too.

function makeRepo(root: string, name: string, remote: string, fixtureFile: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  // KB-TRUST PHASE 1: capture requires a basis that resolves in the repo the
  // provider is anchored at -- each repo gets a file the OTHER repo lacks, so
  // the capture-basis cases below can tell which repoPath a provider is
  // really anchored at.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', fixtureFile), `export const fixture = '${fixtureFile}';\n`);
  return dir;
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cache-key-'));
  resetKbProviders();
});

afterEach(() => {
  resetKbProviders();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('provider cache key: (slug, repoPath), not slug alone (apra-fleet-b4g.2.1)', () => {
  it('case 1: same slug, different repoPath -- each call is anchored at ITS OWN path, not the first caller\'s', async () => {
    const tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const remote = `git@github.com:acme/shared-${tok}.git`;
    const pathA = makeRepo(tmp, 'clone-a', remote, 'only-in-a.ts');
    const pathB = makeRepo(tmp, 'clone-b', remote, 'only-in-b.ts');

    const a = await getKbProviders(pathA);
    const b = await getKbProviders(pathB);

    // Regression pin: on the pre-fix (slug-only key) tree, b.project.repoPath
    // is still pathA -- the FIRST caller's repoPath for this shared slug.
    expect(a.project.repoPath).toBe(pathA);
    expect(b.project.repoPath).toBe(pathB);
    expect(a.projectSlug).toBe(b.projectSlug);
  });

  it('case 2: identical (slug, repoPath) -- sequential AND concurrent unawaited calls share one instance', async () => {
    const tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const remote = `git@github.com:acme/solo-${tok}.git`;
    const repoPath = makeRepo(tmp, 'clone', remote, 'fixture.ts');

    const first = await getKbProviders(repoPath);
    const second = await getKbProviders(repoPath);
    expect(second).toBe(first);

    resetKbProviders();

    // Fired without awaiting the first call: pins the shared-promise property
    // (the cache stores the in-flight Promise, not just the resolved value),
    // so two concurrent callers for the same (slug, repoPath) never race to
    // build two separate providers.
    const [concurrentA, concurrentB] = await Promise.all([
      getKbProviders(repoPath),
      getKbProviders(repoPath),
    ]);
    expect(concurrentB).toBe(concurrentA);
  });

  it('case 3: basis-check consequence -- a capture scoped to pathB is anchored at pathB, not whichever repo created the provider first', async () => {
    const tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const remote = `git@github.com:acme/anchor-${tok}.git`;
    const pathA = makeRepo(tmp, 'clone-a', remote, 'only-in-a.ts');
    const pathB = makeRepo(tmp, 'clone-b', remote, 'only-in-b.ts');

    // Touch A first so a slug-only cache would still be anchored at pathA
    // when pathB is captured against below.
    await getKbProviders(pathA);

    await expect(kbCapture({
      type: 'knowledge',
      title: 'B-anchored fact',
      summary: 'Cites a file that exists only under pathB.',
      content: 'Proves the provider serving pathB is anchored at pathB, not pathA.',
      source_files: ['src/only-in-b.ts'],
      repo_path: pathB,
    } as any)).resolves.toBeTruthy();

    await expect(kbCapture({
      type: 'knowledge',
      title: 'Wrongly A-anchored fact',
      summary: 'Cites a file that exists only under pathA, scoped to pathB.',
      content: 'If this succeeds, the provider serving pathB is still anchored at pathA.',
      source_files: ['src/only-in-a.ts'],
      repo_path: pathB,
    } as any)).rejects.toThrow(KbCaptureRejected);
  });

  it('case 4: resetKbProviders() clears the composite-keyed cache -- a call after reset rebuilds rather than serving a stale anchor', async () => {
    const tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const remote = `git@github.com:acme/reset-${tok}.git`;
    const repoPath = makeRepo(tmp, 'clone', remote, 'fixture.ts');

    const before = await getKbProviders(repoPath);
    resetKbProviders();
    const after = await getKbProviders(repoPath);

    expect(after).not.toBe(before);
    expect(after.project.repoPath).toBe(repoPath);
  });
});
