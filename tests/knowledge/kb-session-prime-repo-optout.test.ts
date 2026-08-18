import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { CodebaseMemoryProvider } from '../../src/tools/code-intelligence-codebase-memory.js';
import { GitNexusProvider } from '../../src/tools/code-intelligence-gitnexus.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';

// apra-fleet-tm7.20: kb_session_prime's graph-neighbor enrichment block called
// getProvider() with no repoPath, so a repo that opted out of code
// intelligence via .apra-fleet/code-intel.json (enabled:false) still got a
// live provider resolved for it. Fixed by forwarding input.repo_path through
// to getProvider(undefined, input.repo_path) (kb-session-prime.ts:246), which
// makes getProvider's existing repo-level opt-out check (code-intelligence.ts:154)
// apply here too and return RepoDisabledProvider instead.
//
// This file exercises the REAL getProvider / isCodeIntelEnabled / provider
// chain (code-intelligence.js is NOT mocked) so the assertion is that no real
// provider is ever constructed for an opted-out repo -- not just that a mock
// received particular args.
//
// kb-providers is not mocked either; getKbProviders/resetKbProviders are the
// real implementations, isolated by tests/setup.ts's APRA_FLEET_DATA_DIR
// override, and reset between tests to avoid the module-level provider cache
// leaking a provider anchored at a previous test's tmp dir.

let tmp: string;
let tok: string;

function makeRepo(enabled: boolean): string {
  const dir = path.join(tmp, `repo-${enabled}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:acme/optout-${tok}-${enabled}.git`], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.apra-fleet'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.apra-fleet', 'code-intel.json'),
    JSON.stringify({ enabled }),
  );
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prime-optout-'));
  tok = path.basename(tmp).replace(/[^a-z0-9]/gi, '').toLowerCase();
  resetKbProviders();
});

afterEach(() => {
  resetKbProviders();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('kb_session_prime graph-neighbor block honors the repo-level code-intel opt-out (apra-fleet-tm7.20)', () => {
  it('never constructs a real provider for a repo with enabled:false, and prime output is unchanged', async () => {
    // Which concrete provider is "real" depends on this host's global
    // ~/.apra-fleet/data/code-intelligence/config.json (codebase-memory is
    // only the fallback default) -- spy on both so the assertion holds
    // regardless of the machine's configured provider.
    const cmSpy = vi.spyOn(CodebaseMemoryProvider.prototype, 'context');
    const gnSpy = vi.spyOn(GitNexusProvider.prototype, 'context');
    const disabledRepo = makeRepo(false);

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');

    const withHints = JSON.parse(
      await kbSessionPrime({
        repo_path: disabledRepo,
        hint_symbols: [`optoutSymbol${tok}`],
      } as any),
    );
    const withoutHints = JSON.parse(
      await kbSessionPrime({
        repo_path: disabledRepo,
      } as any),
    );

    // Neither real provider is ever reached -- RepoDisabledProvider
    // short-circuits getProvider before either PROVIDERS entry is used.
    expect(cmSpy).not.toHaveBeenCalled();
    expect(gnSpy).not.toHaveBeenCalled();

    // Graph-neighbor expansion contributed nothing: a call with hint_symbols
    // against an opted-out repo yields the same top_entries as a call with no
    // hint_symbols at all (which never enters the enrichment block).
    expect(withHints.top_entries).toEqual(withoutHints.top_entries);

    cmSpy.mockRestore();
    gnSpy.mockRestore();
  });

  it('sanity check: an enabled repo DOES reach a real provider (control case)', async () => {
    const cmSpy = vi.spyOn(CodebaseMemoryProvider.prototype, 'context');
    const gnSpy = vi.spyOn(GitNexusProvider.prototype, 'context');
    const enabledRepo = makeRepo(true);

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    await kbSessionPrime({
      repo_path: enabledRepo,
      hint_symbols: [`optoutSymbol${tok}`],
    } as any);

    expect(cmSpy.mock.calls.length + gnSpy.mock.calls.length).toBeGreaterThan(0);

    cmSpy.mockRestore();
    gnSpy.mockRestore();
  });
});
