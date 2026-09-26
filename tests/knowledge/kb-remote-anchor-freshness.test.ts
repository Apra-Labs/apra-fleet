import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';

// apra-fleet-b4g.4: a remote member's repo_path does not exist on this host,
// but repo_remote_url routes the call to the REAL shared project KB. The anchor
// that freshness checking depends on is therefore missing, and re-hashing a
// stored basis against a tree that does not exist retired healthy entries --
// prime() UPDATEd them to stale=1 in the shared DB, so a kb_list from the real
// local clone returned nothing.
//
// Test A pins that a prime from such a member leaves a healthy entry alone
// (raw sqlite row AND kb_list). Test B pins that freshness was NARROWED, not
// disabled: the same prime from the real local clone still stales an entry
// whose basis file genuinely changed.
//
// The KB data dir is isolated globally by tests/setup.ts (APRA_FLEET_DATA_DIR),
// and every case uses a per-test unique fake remote URL, so the real project KB
// is never touched.

function makeClone(root: string, name: string, remote: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'src', 'fixture.ts'), 'export const fixture = 1;\n');
  return dir;
}

// Read the stale flag straight off the row, not through any read path that
// might filter stale entries out on its own.
async function rawStale(repoPath: string, title: string): Promise<number | undefined> {
  const providers = await getKbProviders(repoPath);
  const row = (providers.project as any).getDb()
    .prepare('SELECT stale FROM entries WHERE title = ?')
    .get(title) as { stale: number } | undefined;
  return row?.stale;
}

let tmp: string;
let tok: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-remote-anchor-'));
  tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
  resetKbProviders();
});

afterEach(() => {
  resetKbProviders();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('kb_session_prime from a repo path that does not exist on this host (apra-fleet-b4g.4)', () => {
  it('A: leaves a healthy entry captured from the real local clone at stale=0, and kb_list still returns it', async () => {
    const remoteUrl = `git@github.com:acme/anchor-a-${tok}.git`;
    const localClone = makeClone(tmp, 'local-clone', remoteUrl);
    // A Windows-style member work folder: routed to the same project KB by the
    // remote URL, unreachable from this host.
    const fakeRemotePath = `C:\\Users\\member\\work\\anchor-a-${tok}`;
    const title = `Anchor healthy entry ${tok}`;

    // The basis path is RELATIVE on purpose: that is what makes the anchor
    // load-bearing. An absolute basis path re-hashes identically under any
    // anchor and would make this test vacuous.
    await kbCapture({
      type: 'knowledge',
      title,
      summary: 'Captured from a real local clone with a relative basis path.',
      content: `Entry about anchorHealthySymbol${tok} that must survive a remote member's prime.`,
      symbols: [`anchorHealthySymbol${tok}`],
      source_files: ['src/fixture.ts'],
      repo_path: localClone,
    } as any);

    expect(await rawStale(localClone, title)).toBe(0);

    // The remote member's session begins with a prime against the shared KB.
    await kbSessionPrime({
      repo_path: fakeRemotePath,
      repo_remote_url: remoteUrl,
      hint_symbols: [`anchorHealthySymbol${tok}`],
    } as any);

    expect(await rawStale(localClone, title)).toBe(0);

    const listed = JSON.parse(await kbList({ repo_path: localClone, limit: 50 } as any));
    expect(listed.results.some((e: any) => e.title === title)).toBe(true);
  });

  it('B: the same prime from the REAL local clone still stales an entry whose basis file changed', async () => {
    const remoteUrl = `git@github.com:acme/anchor-b-${tok}.git`;
    const localClone = makeClone(tmp, 'local-clone', remoteUrl);
    const title = `Anchor changed-basis entry ${tok}`;

    await kbCapture({
      type: 'knowledge',
      title,
      summary: 'Captured from a real local clone; its basis file is about to change.',
      content: `Entry about anchorChangedSymbol${tok} whose basis must go stale on a real edit.`,
      symbols: [`anchorChangedSymbol${tok}`],
      source_files: ['src/fixture.ts'],
      repo_path: localClone,
    } as any);

    expect(await rawStale(localClone, title)).toBe(0);

    fs.writeFileSync(path.join(localClone, 'src', 'fixture.ts'), 'export const fixture = 2; // changed\n');

    await kbSessionPrime({
      repo_path: localClone,
      repo_remote_url: remoteUrl,
      hint_symbols: [`anchorChangedSymbol${tok}`],
    } as any);

    expect(await rawStale(localClone, title)).toBe(1);
  });
});

describe('freshnessSweep anchoring (apra-fleet-b4g.4 criterion 5)', () => {
  it('with no explicit root, sweeps against the provider anchor -- not the process cwd', async () => {
    const remoteUrl = `git@github.com:acme/anchor-sweep-${tok}.git`;
    const localClone = makeClone(tmp, 'local-clone', remoteUrl);
    const title = `Anchor sweep entry ${tok}`;

    await kbCapture({
      type: 'knowledge',
      title,
      summary: 'Captured from a real local clone to pin the sweep anchor default.',
      content: `Entry about anchorSweepSymbol${tok} used to pin freshnessSweep's default root.`,
      symbols: [`anchorSweepSymbol${tok}`],
      source_files: ['src/fixture.ts'],
      repo_path: localClone,
    } as any);

    // Unchanged tree: a sweep anchored at the provider's repo must NOT stale it.
    // Anchored at process.cwd() (this repo) the relative basis path does not
    // resolve, and the entry would be retired.
    const providers = await getKbProviders(localClone);
    const clean = await providers.project.freshnessSweep();
    expect(clean.staled).toBe(0);
    expect(await rawStale(localClone, title)).toBe(0);

    // And a real edit still stales it, so the anchor did not disable the sweep.
    fs.writeFileSync(path.join(localClone, 'src', 'fixture.ts'), 'export const fixture = 3; // changed\n');
    const dirty = await providers.project.freshnessSweep();
    expect(dirty.staled).toBeGreaterThanOrEqual(1);
    expect(await rawStale(localClone, title)).toBe(1);
  });

  it('a sweep whose anchor does not exist on this host makes no verdict at all', async () => {
    const remoteUrl = `git@github.com:acme/anchor-sweep-missing-${tok}.git`;
    const localClone = makeClone(tmp, 'local-clone', remoteUrl);
    const fakeRemotePath = `C:\\Users\\member\\work\\anchor-sweep-${tok}`;
    const title = `Anchor sweep missing-anchor entry ${tok}`;

    await kbCapture({
      type: 'knowledge',
      title,
      summary: 'Captured locally, then swept by a member whose work folder is unreachable.',
      content: `Entry about anchorSweepMissingSymbol${tok} that a missing-anchor sweep must not touch.`,
      symbols: [`anchorSweepMissingSymbol${tok}`],
      source_files: ['src/fixture.ts'],
      repo_path: localClone,
    } as any);

    const remote = await getKbProviders(fakeRemotePath, remoteUrl);
    expect(await remote.project.freshnessSweep()).toEqual({ checked: 0, staled: 0, unstaled: 0 });
    expect(await rawStale(localClone, title)).toBe(0);
  });
});
