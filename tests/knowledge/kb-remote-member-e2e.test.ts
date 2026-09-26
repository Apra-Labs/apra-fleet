import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { KbProviders } from '../../src/services/knowledge/kb-providers.js';

// apra-fleet-b4g.11: feature-level end-to-end pin for "make the KB correct for
// remote members" (apra-fleet-b4g). The individual fixes each carry their own
// narrow regression test (kb-remote-anchor-freshness.test.ts for b4g.4,
// kb-anchor-never-cwd.test.ts for b4g.7, kb-remote-url-forwarding.test.ts /
// kb-remote-scope.test.ts for the wiring); this file pins the whole
// user-visible remote-member story in one place, driven entirely through the
// public kb_* tool handlers (kb_capture / kb_session_prime / kb_list /
// kb_stats), so a future refactor that reverts any single piece is caught by
// a test describing the observable outcome rather than an internal call
// signature.
//
// getKbProviders is wrapped, not stubbed: the mock delegates to the REAL
// implementation and records every (cwd, remoteUrl) -> KbProviders pair the
// tool handlers pass, purely so assertion 2 (CORRECT ANCHOR) below can inspect
// provider.repoPath after the fact. The scenario itself (capture, prime, list,
// stats) still runs entirely through the public tool handlers -- same pattern
// as tests/knowledge/kb-anchor-never-cwd.test.ts.
//
// No process.chdir() here on purpose (see kb-import.test.ts T3.1 and
// kb-anchor-never-cwd.test.ts: this repo treats process-wide cwd mutation as a
// bug, not a test tool). The "cwd fallback would be observable" property is
// achieved instead by asserting the recorded anchor is never process.cwd() --
// exactly as strong, since this test run's process.cwd() is this repo's own
// root, provably distinct from every fixture path used below.
//
// The KB data dir is isolated globally by tests/setup.ts (APRA_FLEET_DATA_DIR)
// and this file uses a per-run unique fake remote URL and local clone, so the
// real project KB is never touched.

const hoisted = vi.hoisted(() => ({
  real: null as typeof import('../../src/services/knowledge/kb-providers.js') | null,
  mock: vi.fn(),
}));

vi.mock('../../src/services/knowledge/kb-providers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/knowledge/kb-providers.js')>();
  hoisted.real = actual;
  return { ...actual, getKbProviders: hoisted.mock };
});

import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbStats } from '../../src/tools/kb-stats.js';

interface Recorded {
  cwd: string | undefined;
  remoteUrl: string | undefined;
  providers: KbProviders;
}

let recorded: Recorded[];
let tmp: string;
let tok: string;

function makeClone(name: string, remote: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'src', 'fixture.ts'), 'export const fixture = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'fixture2.ts'), 'export const fixture2 = 1;\n');
  return dir;
}

// Raw sqlite row, not any read path that might filter stale entries out on
// its own -- same helper shape as kb-remote-anchor-freshness.test.ts.
async function rawStale(repoPath: string, title: string): Promise<number | undefined> {
  const providers = await hoisted.real!.getKbProviders(repoPath);
  const row = (providers.project as any).getDb()
    .prepare('SELECT stale FROM entries WHERE title = ?')
    .get(title) as { stale: number } | undefined;
  return row?.stale;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-remote-e2e-'));
  tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
  recorded = [];
  hoisted.real!.resetKbProviders();
  hoisted.mock.mockReset();
  hoisted.mock.mockImplementation(async (cwd?: string, remoteUrl?: string) => {
    const providers = await hoisted.real!.getKbProviders(cwd, remoteUrl);
    recorded.push({ cwd, remoteUrl, providers });
    return providers;
  });
});

afterEach(() => {
  hoisted.real!.resetKbProviders();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('remote-member KB scoping end-to-end (apra-fleet-b4g.11)', () => {
  it('same database, correct anchor, no false staling, freshness still works', async () => {
    const remoteUrl = `git@github.com:acme/remote-e2e-${tok}.git`;
    // Real local clone standing in for the LOCAL counterpart of the repo.
    const localClone = makeClone('local-clone', remoteUrl);
    // A Windows-style member work folder path: unreachable from this host,
    // routed to the SAME project KB purely by repo_remote_url.
    const fakeRemotePath = `C:\\Users\\member\\work\\remote-e2e-${tok}`;

    const healthyTitle = `Remote e2e healthy entry ${tok}`;
    const changedTitle = `Remote e2e changed-basis entry ${tok}`;

    // --- Capture two entries from the REAL local clone -------------------
    // repo_remote_url is deliberately omitted here: the local clone's git
    // origin is set to remoteUrl, so resolveProjectSlug derives the same slug
    // by shelling out to git, exactly as an ordinary local developer session
    // would (matching kb-remote-anchor-freshness.test.ts's capture style).
    await kbCapture({
      type: 'knowledge',
      title: healthyTitle,
      summary: 'Captured from the real local clone; must survive a remote-style prime untouched.',
      content: `Entry about remoteE2eHealthy${tok}, whose basis (fixture.ts) never changes in this test.`,
      symbols: [`remoteE2eHealthy${tok}`],
      source_files: ['src/fixture.ts'],
      repo_path: localClone,
    } as any);

    await kbCapture({
      type: 'knowledge',
      title: changedTitle,
      summary: 'Captured from the real local clone; its basis (fixture2.ts) changes later in this test.',
      content: `Entry about remoteE2eChanged${tok}, staled once fixture2.ts genuinely changes.`,
      symbols: [`remoteE2eChanged${tok}`],
      source_files: ['src/fixture2.ts'],
      repo_path: localClone,
    } as any);

    expect(await rawStale(localClone, healthyTitle)).toBe(0);
    expect(await rawStale(localClone, changedTitle)).toBe(0);

    const localDbPath = recorded[0].providers.project.dbPath;
    const beforeRemoteCalls = recorded.length;

    // --- Act as the remote member: prime, stats, list from the fake path -
    await kbSessionPrime({
      repo_path: fakeRemotePath,
      repo_remote_url: remoteUrl,
      hint_symbols: [`remoteE2eHealthy${tok}`, `remoteE2eChanged${tok}`],
    } as any);

    const statsOut = JSON.parse(await kbStats({ repo_path: fakeRemotePath, repo_remote_url: remoteUrl } as any));
    const listOut = JSON.parse(await kbList({ repo_path: fakeRemotePath, repo_remote_url: remoteUrl, limit: 50 } as any));

    const remoteCalls = recorded.slice(beforeRemoteCalls);

    // ASSERTION 1 -- SAME DATABASE: the remote-style calls resolve to the
    // URL-derived slug and read back exactly the entries captured from the
    // real local clone (the original apra-fleet-b4g defect: a member's
    // Windows path returned 0 entries / bible.present=false where the truth
    // was a populated KB with the bible present).
    for (const call of remoteCalls) {
      expect(call.providers.project.dbPath).toBe(localDbPath);
    }
    expect(statsOut.totals.total).toBe(2);
    expect(listOut.results.some((e: any) => e.title === healthyTitle)).toBe(true);
    expect(listOut.results.some((e: any) => e.title === changedTitle)).toBe(true);

    // ASSERTION 2 -- CORRECT ANCHOR (apra-fleet-b4g.7): the provider backing
    // each remote-style call (prime, stats, list) is anchored at the caller's
    // own path, never at the fleet server's process.cwd().
    expect(remoteCalls.length).toBeGreaterThanOrEqual(2); // at least prime + stats
    for (const call of remoteCalls) {
      expect(call.providers.project.repoPath).toBe(fakeRemotePath);
      expect(call.providers.project.repoPath).not.toBe(process.cwd());
    }

    // ASSERTION 3 -- NO FALSE STALING (apra-fleet-b4g.4): the healthy entry
    // captured from the real local clone is untouched by the remote-style
    // prime above -- raw sqlite row AND a subsequent kb_list from the local
    // clone.
    expect(await rawStale(localClone, healthyTitle)).toBe(0);
    const relistedFromLocal = JSON.parse(await kbList({ repo_path: localClone, limit: 50 } as any));
    expect(relistedFromLocal.results.some((e: any) => e.title === healthyTitle)).toBe(true);

    // ASSERTION 4 -- FRESHNESS NOT DISABLED: a prime from the REAL local
    // clone still stales an entry whose basis genuinely changed, proving
    // apra-fleet-b4g.4 narrowed freshness checking rather than disabling it.
    fs.writeFileSync(path.join(localClone, 'src', 'fixture2.ts'), 'export const fixture2 = 2; // changed\n');
    await kbSessionPrime({
      repo_path: localClone,
      repo_remote_url: remoteUrl,
      hint_symbols: [`remoteE2eChanged${tok}`],
    } as any);
    expect(await rawStale(localClone, changedTitle)).toBe(1);
  // This test does a real git clone plus sqlite work (two captures, a session
  // prime, stats, list, and a second prime after a file change), and shells out
  // to real git clone/init work (makeClone). Two independent measurements: 3869ms
  // observed in isolation (77% of vitest 5000ms default), and overruns of the
  // default under a full parallel run of 300+ files. Both remedies raised the
  // timeout; the larger of the two is kept here. 30000ms leaves comfortable
  // margin, matching register-member.test.ts /
  // register-member-bootstrap-gate.test.ts / 2cc-win-bd-invocation-integ.test.ts
  // / eft-41-symlinked-entry.test.ts.
  }, 30000);
});
