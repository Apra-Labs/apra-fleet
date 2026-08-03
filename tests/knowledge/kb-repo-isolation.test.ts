import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbList } from '../../src/tools/kb-list.js';

// apra-fleet-3zl: every kb_* tool used to call getKbProviders() with no
// argument, and getKbProviders memoised a SINGLE provider. In the long-lived
// fleet server that collapsed every member's knowledge -- across every repo --
// into whichever KB the first call happened to resolve. These tests pin the two
// halves of the fix: per-call repo scoping, and per-slug caching.

function makeRepo(root: string, name: string, remote: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  // KB-TRUST PHASE 1: capture requires a basis that resolves in the repo the
  // provider is anchored at, so every fixture repo carries one real file.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'fixture.ts'), 'export const fixture = 1;\n');
  return dir;
}

let tmp: string;
let repoA: string;
let repoB: string;
// The project KB is a real file under FLEET_DIR keyed by slug, so it outlives a
// resetKbProviders(). Give every test its own remote -- and therefore its own
// slug and its own DB -- so tests cannot bleed entries into one another.
let tok: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-iso-'));
  tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
  repoA = makeRepo(tmp, 'alpha', `git@github.com:acme/alpha-${tok}.git`);
  repoB = makeRepo(tmp, 'beta', `git@github.com:acme/beta-${tok}.git`);
  resetKbProviders();
});

afterEach(() => {
  resetKbProviders();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('project slug resolution', () => {
  it('derives distinct slugs from distinct remotes', () => {
    expect(resolveProjectSlug(repoA)).toBe(`githubcom-acme-alpha-${tok}`);
    expect(resolveProjectSlug(repoB)).toBe(`githubcom-acme-beta-${tok}`);
  });

  // apra-fleet-k5j: `[^@]*@?` was greedy and unbounded, so a URL with no '@'
  // had its whole remainder eaten -> '' -> silent fallback to the directory
  // basename. Plain HTTPS is the default GitHub clone URL, so this was the
  // common case, and two same-named directories shared one KB.
  it('an HTTPS remote resolves to the same slug as its SSH equivalent', () => {
    const https = makeRepo(tmp, 'alpha-https', `https://github.com/acme/alpha-${tok}.git`);
    expect(resolveProjectSlug(https)).toBe(`githubcom-acme-alpha-${tok}`);
    expect(resolveProjectSlug(https)).toBe(resolveProjectSlug(repoA));
  });

  it('does not fall back to the directory basename for an HTTPS remote', () => {
    const oddDir = makeRepo(tmp, 'checkout-7', `https://gitlab.com/acme/gamma-${tok}.git`);
    expect(resolveProjectSlug(oddDir)).toBe(`gitlabcom-acme-gamma-${tok}`);
    expect(resolveProjectSlug(oddDir)).not.toBe('checkout-7');
  });
});

describe('KB provider scoping (apra-fleet-3zl)', () => {
  it('hands back a different project DB per repo, within one process', async () => {
    const a = await getKbProviders(repoA);
    const b = await getKbProviders(repoB);
    expect(a.projectSlug).toBe(`githubcom-acme-alpha-${tok}`);
    expect(b.projectSlug).toBe(`githubcom-acme-beta-${tok}`);
    expect(a.project).not.toBe(b.project);
  });

  it('caches per slug -- same repo twice yields the identical instance', async () => {
    const first = await getKbProviders(repoA);
    const second = await getKbProviders(repoA);
    expect(second).toBe(first);
  });

  it('shares one global KB across repos', async () => {
    const a = await getKbProviders(repoA);
    const b = await getKbProviders(repoB);
    expect(a.global).toBe(b.global);
  });

  // The regression itself: written for A, invisible to B.
  it('an entry captured for repo A is not visible from repo B', async () => {
    await kbCapture({
      type: 'knowledge',
      title: 'Alpha-only fact',
      summary: 'Belongs exclusively to repo alpha.',
      content: 'If this shows up under beta, repo scoping is broken.',
      source_files: ['src/fixture.ts'],
      repo_path: repoA,
    } as any);

    const fromA = JSON.parse(await kbList({ repo_path: repoA, limit: 50 } as any));
    const fromB = JSON.parse(await kbList({ repo_path: repoB, limit: 50 } as any));

    expect(fromA.results.some((e: any) => e.title === 'Alpha-only fact')).toBe(true);
    expect(fromB.results.some((e: any) => e.title === 'Alpha-only fact')).toBe(false);
    expect(fromB.total).toBe(0);
  });

  // Ordering must not matter: before the fix, whichever repo was touched first
  // captured every subsequent call regardless of the repo_path passed.
  it('the first repo touched does not capture later calls for other repos', async () => {
    await kbCapture({
      type: 'knowledge', title: 'Beta-only fact',
      summary: 'Belongs exclusively to repo beta.', content: 'x',
      source_files: ['src/fixture.ts'],
      repo_path: repoB,
    } as any);
    await kbCapture({
      type: 'knowledge', title: 'Alpha-only fact',
      summary: 'Belongs exclusively to repo alpha.', content: 'y',
      source_files: ['src/fixture.ts'],
      repo_path: repoA,
    } as any);

    const fromA = JSON.parse(await kbList({ repo_path: repoA, limit: 50 } as any));
    const fromB = JSON.parse(await kbList({ repo_path: repoB, limit: 50 } as any));

    expect(fromA.results.map((e: any) => e.title)).toEqual(['Alpha-only fact']);
    expect(fromB.results.map((e: any) => e.title)).toEqual(['Beta-only fact']);
  });
});
