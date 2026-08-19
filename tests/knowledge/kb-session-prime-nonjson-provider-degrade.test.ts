import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';

// apra-fleet-tm7.26: kb-session-prime.ts:254 forwards input.repo_path into
// getProvider(). Any provider that answers with a human-readable prose
// message rather than JSON -- RepoDisabledProvider (repo explicitly opted
// out via .apra-fleet/code-intel.json enabled:false) and OptInPromptProvider
// (repo has never recorded a code-intel choice at all, apra-fleet-le1.2.1)
// -- makes parseContextNeighbors' JSON.parse (kb-session-prime.ts:163) throw.
// That throw is caught internally at :176 and, as a second line of defense,
// by the enclosing hard-skip try/catch that wraps the whole graph-neighbor
// block (kb-session-prime.ts:245-306). This pins the end-to-end contract:
// priming with hint_symbols against either provider must resolve (not
// throw) and contribute zero graph-neighbor entries, exactly as if
// hint_symbols had been omitted.
//
// FIXTURE GOTCHA: getProvider()'s repo-level opt-out/opt-in gate reads
// .apra-fleet/code-intel.json via fs/promises directly (not through a
// mockable seam), so this must use real tmpdir repo fixtures rather than a
// node:fs mock -- see repo-config.test.ts and
// kb-session-prime-repo-optout.test.ts for the same constraint.

let tmp: string;
let tok: string;

function makeRepo(config: { enabled: boolean } | null): string {
  const label = config === null ? 'unconfigured' : String(config.enabled);
  const dir = path.join(tmp, `repo-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:acme/nonjson-${tok}-${label}.git`], { cwd: dir });
  if (config !== null) {
    fs.mkdirSync(path.join(dir, '.apra-fleet'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.apra-fleet', 'code-intel.json'),
      JSON.stringify(config),
    );
  }
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prime-nonjson-'));
  tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
  resetKbProviders();
});

afterEach(() => {
  resetKbProviders();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('kb_session_prime degrades cleanly when the code-intel provider returns non-JSON prose (apra-fleet-tm7.26)', () => {
  it('resolves with zero graph-neighbor entries for an opted-out repo (RepoDisabledProvider)', async () => {
    const disabledRepo = makeRepo({ enabled: false });
    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');

    const withHints = JSON.parse(
      await kbSessionPrime({
        repo_path: disabledRepo,
        hint_symbols: [`nonjsonSymbol${tok}`],
      } as any),
    );
    const withoutHints = JSON.parse(
      await kbSessionPrime({ repo_path: disabledRepo } as any),
    );

    // Same output with and without hint_symbols: the enrichment block
    // contributed nothing, rather than throwing past kbSessionPrime.
    expect(withHints.top_entries).toEqual(withoutHints.top_entries);
    expect(
      (withHints.top_entries ?? []).some((e: { via?: string }) => e.via === 'graph-neighbor'),
    ).toBe(false);
  });

  it('resolves with zero graph-neighbor entries for a never-configured repo (OptInPromptProvider)', async () => {
    const unconfiguredRepo = makeRepo(null);
    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');

    const withHints = JSON.parse(
      await kbSessionPrime({
        repo_path: unconfiguredRepo,
        hint_symbols: [`nonjsonSymbol${tok}`],
      } as any),
    );
    const withoutHints = JSON.parse(
      await kbSessionPrime({ repo_path: unconfiguredRepo } as any),
    );

    expect(withHints.top_entries).toEqual(withoutHints.top_entries);
    expect(
      (withHints.top_entries ?? []).some((e: { via?: string }) => e.via === 'graph-neighbor'),
    ).toBe(false);
  });
});
