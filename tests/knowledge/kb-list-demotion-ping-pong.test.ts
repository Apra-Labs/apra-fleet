import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// fleet-sprint's D6 promote/demote ping-pong guard (packages/apra-fleet-se
// fleet-sprint/kb.mjs promotionCandidates): a reviewer that just demoted an
// entry should not be re-offered the SAME entry for promotion on the very
// next round with nothing having changed about it. list()'s opt-in
// excludeUnchangedDemotions does the actual exclusion here, server-side,
// because only the provider holds the repoPath anchor the re-hash needs and
// the demoted_basis_hashes snapshot a caller has no business re-deriving.
//
// Real SqliteProvider, a real file on disk, real capture/promote/demote
// calls -- no mocking of the provider or of computeFileHashBatch.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Ping-pong guard test entry',
    summary: 'Something about file.ts',
    content: 'Describes behavior in file.ts.',
    source_files: ['file.ts'],
    symbols: ['pingPongSymbol'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

// demoted_at/promoted_at/created_at are millisecond-precision ISO timestamps
// (new Date().toISOString()), and the guard's own ordering rule -- demoted_at
// STRICTLY after COALESCE(promoted_at, created_at) -- can otherwise collide on
// fast hardware where two writes land in the same millisecond. A real delay,
// not a mocked clock, so the provider's own Date.now() calls stay genuine.
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 2));
}

let provider: SqliteProvider;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ping-pong-test-'));
  fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'original content\n');
  provider = new SqliteProvider(':memory:', tmpDir);
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('SqliteProvider.list excludeUnchangedDemotions (D6 ping-pong guard)', () => {
  it('excludes a demoted entry whose cited basis is unchanged on disk', async () => {
    const { id } = await provider.capture(makeInput());
    await provider.promote(id, 'test fixture: verified against file.ts');
    await tick();
    await provider.demote(id, 'test fixture: no longer sure this still holds');

    const withoutGuard = await provider.list({ confidence: 'INFERRED' });
    expect(withoutGuard.some(e => e.id === id)).toBe(true);

    const withGuard = await provider.list({ confidence: 'INFERRED', excludeUnchangedDemotions: true });
    expect(withGuard.some(e => e.id === id)).toBe(false);
  });

  it('includes that same entry again once a cited basis file is modified on disk', async () => {
    const { id } = await provider.capture(makeInput());
    await provider.promote(id, 'test fixture: verified against file.ts');
    await tick();
    await provider.demote(id, 'test fixture: no longer sure this still holds');

    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'genuinely different content now\n');

    const withGuard = await provider.list({ confidence: 'INFERRED', excludeUnchangedDemotions: true });
    expect(withGuard.some(e => e.id === id)).toBe(true);
  });

  it('still includes a never-demoted INFERRED entry', async () => {
    const { id } = await provider.capture(makeInput({ title: 'Never demoted', symbols: ['neverDemoted'] }));

    const withGuard = await provider.list({ confidence: 'INFERRED', excludeUnchangedDemotions: true });
    expect(withGuard.some(e => e.id === id)).toBe(true);
  });

  it('a manual kb_promote after the demote clears the ping-pong state (promoted_at now wins)', async () => {
    const { id } = await provider.capture(makeInput());
    await provider.promote(id, 'test fixture: verified against file.ts');
    await tick();
    await provider.demote(id, 'test fixture: no longer sure this still holds');
    await tick();
    // Re-promote by hand, with the basis UNCHANGED -- a human/automation
    // decided this entry is good again regardless of the guard.
    await provider.promote(id, 'test fixture: re-verified, basis unchanged');

    const withGuard = await provider.list({ confidence: 'CONFIRMED', excludeUnchangedDemotions: true });
    expect(withGuard.some(e => e.id === id)).toBe(true);
  });

  it('is a strict no-op when the flag is omitted (existing callers unaffected)', async () => {
    const { id } = await provider.capture(makeInput());
    await provider.promote(id, 'test fixture: verified against file.ts');
    await tick();
    await provider.demote(id, 'test fixture: no longer sure this still holds');

    const defaultList = await provider.list({ confidence: 'INFERRED' });
    expect(defaultList.some(e => e.id === id)).toBe(true);
  });
});
