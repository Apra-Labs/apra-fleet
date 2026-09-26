import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { KbProviders } from '../../src/services/knowledge/kb-providers.js';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';

// apra-fleet-b4g.7: three kb tools resolved repo_path through a local
// resolveRepoPath() that nulls out a path missing on this host, then handed the
// null to getKbProviders as `?? undefined` -- whose `cwd ?? process.cwd()`
// fallback silently anchored the provider at the FLEET SERVER'S OWN working
// directory. Combined with repo_remote_url routing (apra-fleet-b4g.1) that meant
// the REAL shared project KB was opened with a valid but WRONG anchor: every
// basis hash computed against a tree that does not describe those entries.
// apra-fleet-b4g.4 fixed kb_session_prime; this file pins all three sites.
//
// The anchor policy pinned here, one rule for all three:
//   - kb_session_prime / kb_stats only READ through the anchor, so a supplied
//     repo_path is passed to getKbProviders VERBATIM -- an unreachable remote
//     path stays honestly missing and SqliteProvider.anchorIsMissing() declines
//     to produce a freshness verdict.
//   - kb_export WRITES <repo_path>/.fleet/kb-canonical.json, so it keeps its
//     hard failure. It also never reaches getKbProviders in that case.
// Neither branch may ever anchor at process.cwd().
//
// getKbProviders is wrapped, not stubbed: the mock delegates to the real
// implementation so the assertions are on a REAL SqliteProvider's dbPath and
// repoPath, and records every (cwd, remoteUrl) pair the tools passed.
//
// No process.chdir() here on purpose (see kb-import.test.ts T3.1: this repo
// treats process-wide cwd mutation as a bug, not a test tool). The assertion is
// exactly as strong without it -- on the pre-fix tree these calls produced
// repoPath === process.cwd() verbatim, whatever that cwd happens to be.
//
// The KB data dir is isolated globally by tests/setup.ts (APRA_FLEET_DATA_DIR)
// and every case uses a per-test unique fake remote URL, so the real project KB
// is never touched.

const hoisted = vi.hoisted(() => ({
  real: null as typeof import('../../src/services/knowledge/kb-providers.js') | null,
  mock: vi.fn(),
}));

vi.mock('../../src/services/knowledge/kb-providers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/knowledge/kb-providers.js')>();
  hoisted.real = actual;
  return { ...actual, getKbProviders: hoisted.mock };
});

import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbStats } from '../../src/tools/kb-stats.js';
import { kbExport } from '../../src/tools/kb-export.js';

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
  return dir;
}

function onlyCall(): Recorded {
  expect(recorded).toHaveLength(1);
  return recorded[0];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-anchor-cwd-'));
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

describe('a repo_path that does not exist on this host never anchors at the server cwd (apra-fleet-b4g.7)', () => {
  it('kb_session_prime: URL-derived slug for the DB, the caller path for the anchor', async () => {
    const remoteUrl = `git@github.com:acme/anchor-cwd-prime-${tok}.git`;
    const fakeRemotePath = `C:\\Users\\member\\work\\anchor-cwd-prime-${tok}`;

    await kbSessionPrime({
      repo_path: fakeRemotePath,
      repo_remote_url: remoteUrl,
      hint_symbols: [`anchorCwdPrimeSymbol${tok}`],
    } as any);

    const { providers } = onlyCall();
    expect(providers.projectSlug).toBe(resolveProjectSlug(undefined, remoteUrl));
    expect(providers.project.dbPath).toContain(path.join('knowledge', providers.projectSlug));
    expect(providers.project.repoPath).toBe(fakeRemotePath);
    expect(providers.project.repoPath).not.toBe(process.cwd());
  });

  it('kb_stats: URL-derived slug for the DB, the caller path for the anchor', async () => {
    const remoteUrl = `git@github.com:acme/anchor-cwd-stats-${tok}.git`;
    const fakeRemotePath = `C:\\Users\\member\\work\\anchor-cwd-stats-${tok}`;

    await kbStats({ repo_path: fakeRemotePath, repo_remote_url: remoteUrl } as any);

    const { providers } = onlyCall();
    expect(providers.projectSlug).toBe(resolveProjectSlug(undefined, remoteUrl));
    expect(providers.project.dbPath).toContain(path.join('knowledge', providers.projectSlug));
    expect(providers.project.repoPath).toBe(fakeRemotePath);
    expect(providers.project.repoPath).not.toBe(process.cwd());
  });

  it('kb_stats: the `repo` alias takes the same verbatim path as `repo_path`', async () => {
    const remoteUrl = `git@github.com:acme/anchor-cwd-stats-alias-${tok}.git`;
    const fakeRemotePath = `C:\\Users\\member\\work\\anchor-cwd-stats-alias-${tok}`;

    await kbStats({ repo: fakeRemotePath, repo_remote_url: remoteUrl } as any);

    const { providers } = onlyCall();
    expect(providers.project.repoPath).toBe(fakeRemotePath);
    expect(providers.project.repoPath).not.toBe(process.cwd());
  });

  it('kb_export: fails loudly instead of anchoring anywhere at all', async () => {
    const remoteUrl = `git@github.com:acme/anchor-cwd-export-${tok}.git`;
    const fakeRemotePath = `C:\\Users\\member\\work\\anchor-cwd-export-${tok}`;

    await expect(
      kbExport({ repo_path: fakeRemotePath, repo_remote_url: remoteUrl } as any),
    ).rejects.toThrow(/does not exist or is not a directory/);

    // The throw happens before getKbProviders, so no provider -- and in
    // particular no cwd-anchored provider -- is created for the URL's slug.
    expect(hoisted.mock).not.toHaveBeenCalled();
  });
});

describe('a repo_path that DOES exist still anchors at that path (apra-fleet-b4g.7 criterion 5)', () => {
  it('kb_session_prime anchors at the local clone', async () => {
    const remoteUrl = `git@github.com:acme/anchor-cwd-local-prime-${tok}.git`;
    const localClone = makeClone('local-clone', remoteUrl);

    await kbSessionPrime({
      repo_path: localClone,
      repo_remote_url: remoteUrl,
      hint_symbols: [`anchorCwdLocalSymbol${tok}`],
    } as any);

    const { providers } = onlyCall();
    expect(providers.project.repoPath).toBe(localClone);
  });

  it('kb_stats anchors at the local clone, and still reads its bible from there', async () => {
    const remoteUrl = `git@github.com:acme/anchor-cwd-local-stats-${tok}.git`;
    const localClone = makeClone('local-clone', remoteUrl);
    fs.mkdirSync(path.join(localClone, '.fleet'), { recursive: true });
    fs.writeFileSync(
      path.join(localClone, '.fleet', 'kb-canonical.json'),
      JSON.stringify([{ id: 'b1', updated_at: '2026-01-01T00:00:00.000Z' }]),
    );

    const out = JSON.parse(await kbStats({ repo_path: localClone, repo_remote_url: remoteUrl } as any));

    const { providers } = onlyCall();
    expect(providers.project.repoPath).toBe(localClone);
    expect(out.bible.present).toBe(true);
    expect(out.bible.entries).toBe(1);
  });

  it('kb_stats with no repo path at all keeps the pre-change cwd fallback', async () => {
    // The omitted-path case is deliberately unchanged: for a single-repo CLI
    // invocation the process cwd IS the repo. Only a path that was SUPPLIED and
    // did not validate stopped degrading to it.
    await kbStats({} as any);

    const { cwd, providers } = onlyCall();
    expect(cwd).toBe(process.cwd());
    expect(providers.project.repoPath).toBe(process.cwd());
  });
});
