import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';
import { FLEET_DIR } from '../../src/paths.js';

/**
 * kb_demote bible safety (workstream D verification).
 *
 * Demotion only means something if the DEMOTED entry stops being handed to
 * agents. Two paths could undo it, and both are pinned here against a REAL
 * SqliteProvider and a REAL temp git repo -- no mocks of the code under test:
 *
 *   D-a  kb_session_prime's canonical-bible cold-seed reads
 *        <repo>/.fleet/kb-canonical.json and defaults every entry it finds to
 *        CONFIRMED without consulting the local row, so a demoted entry would
 *        keep being injected as CONFIRMED into every single session.
 *
 *   D-b  kb_export's shrink guard refused to auto-commit ANY shrinking export
 *        (apra-fleet-ong). A demotion legitimately shrinks the bible, so the
 *        guard was widened -- and the negative cases carry the weight here:
 *        a shrink with ONE missing id that was NOT demoted must still refuse
 *        and still warn, which is exactly what a bug in the widening would
 *        silently remove.
 */

const DEMOTE_REASON = 'the cited basis file was rewritten and no longer supports this claim';
const PROMOTE_REASON = 'verified against the seeded tree for this test fixture';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

function gitCommit(dir: string, message: string): void {
  git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@test.local', 'commit', '-q', '-m', message]);
}

function makeInput(title: string, basisFile: string): KBEntryInput {
  return {
    type: 'learning',
    title: title,
    summary: 'An entry used to exercise bible safety for ' + title,
    content: 'Behaviour recorded for ' + title + '.',
    source_files: [basisFile],
    symbols: ['bibleSafetySymbol'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

/** capture() clamps CONFIRMED -> INFERRED, so CONFIRMED is only reachable up the ladder. */
async function captureConfirmed(p: SqliteProvider, title: string, basisFile: string): Promise<string> {
  const { id } = await p.capture(makeInput(title, basisFile));
  await p.promote(id, PROMOTE_REASON);
  return id;
}

/** The shape kb_export writes, which the cold-seed reads back. */
function bibleEntry(id: string) {
  return {
    id: id,
    type: 'knowledge',
    title: 'Canonical ' + id,
    summary: 'Canonical summary for ' + id,
    symbols: [],
    source_files: ['src/fixture.ts'],
    confidence: 'CONFIRMED',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function writeBible(repoDir: string, entries: unknown): void {
  const fleetDir = path.join(repoDir, '.fleet');
  fs.mkdirSync(fleetDir, { recursive: true });
  fs.writeFileSync(
    path.join(fleetDir, 'kb-canonical.json'),
    typeof entries === 'string' ? entries : JSON.stringify(entries, null, 2) + '\n',
    'utf-8',
  );
}

function primedIds(parsed: { top_entries?: KBEntry[] }): string[] {
  return (parsed.top_entries ?? []).map(e => e.id);
}

describe('kb_demote bible safety: the cold-seed does not re-inject a demoted entry', () => {
  let repoDir: string;
  let provider: SqliteProvider;
  let basisFile: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-demote-prime-'));
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    basisFile = path.join(repoDir, 'src', 'basis.ts');
    fs.writeFileSync(basisFile, 'export const basis = 1;\n');

    provider = new SqliteProvider(':memory:', repoDir);
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider,
      global: provider,
      projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    provider.close();
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('suppresses a bible entry whose local row was demoted below CONFIRMED', async () => {
    const demotedId = await captureConfirmed(provider, 'demoted claim', basisFile);
    const result = await provider.demote(demotedId, DEMOTE_REASON);
    expect(result.confidence_after).toBe('INFERRED');

    // The bible still carries it as CONFIRMED -- that is the committed
    // artifact, exported before the demotion -- alongside a control entry
    // nobody demoted.
    writeBible(repoDir, [bibleEntry(demotedId), bibleEntry('control-no-local-row')]);

    const parsed = JSON.parse(await kbSessionPrime({ repo_path: repoDir }));

    expect(primedIds(parsed)).not.toContain(demotedId);
    expect(primedIds(parsed)).toEqual(['control-no-local-row']);
  });

  it('still seeds a bible entry with no local row at all', async () => {
    // The normal cross-machine case: a bible is read where its entries were
    // never captured. "No row" is not "demoted".
    writeBible(repoDir, [bibleEntry('from-another-machine')]);

    const parsed = JSON.parse(await kbSessionPrime({ repo_path: repoDir }));

    expect(primedIds(parsed)).toEqual(['from-another-machine']);
    expect((parsed.top_entries[0] as KBEntry & { via: string }).via).toBe('canonical-bible');
  });

  it('still seeds a bible entry whose local row is CONFIRMED', async () => {
    const confirmedId = await captureConfirmed(provider, 'confirmed claim', basisFile);
    writeBible(repoDir, [bibleEntry(confirmedId)]);

    const parsed = JSON.parse(await kbSessionPrime({ repo_path: repoDir }));

    expect(primedIds(parsed)).toEqual([confirmedId]);
  });

  it('seeds again once a demoted entry has been promoted back to CONFIRMED', async () => {
    // The suppression is keyed on "demoted AND still below CONFIRMED", not on
    // demoted_at alone: trust that came back must be delivered again, or a
    // single demotion would mute an entry forever.
    const id = await captureConfirmed(provider, 'recovered claim', basisFile);
    await provider.demote(id, DEMOTE_REASON);
    await provider.promote(id, PROMOTE_REASON);
    writeBible(repoDir, [bibleEntry(id)]);

    const parsed = JSON.parse(await kbSessionPrime({ repo_path: repoDir }));

    expect(primedIds(parsed)).toEqual([id]);
  });

  it('keeps the cold-seed non-fatal: a malformed bible yields the live-KB result unchanged', async () => {
    // Baseline with NO bible file at all, then the identical call with a
    // malformed one. The whole result object must match: the demoted-id lookup
    // must not have turned a hard skip into a throw.
    const baseline = JSON.parse(await kbSessionPrime({ repo_path: repoDir }));

    writeBible(repoDir, '{ this is not valid json');
    const malformed = JSON.parse(await kbSessionPrime({ repo_path: repoDir }));

    expect(malformed).toEqual(baseline);
    expect(primedIds(malformed)).toEqual([]);
  });
});

describe('kb_demote bible safety: only a demotion-only shrink auto-commits', () => {
  const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
  // Global scope: since #631 the project export is additive (it never removes
  // an entry), so only the global export can shrink and reach the guard.
  const BIBLE_REL = '.fleet/kb-canonical-global.json';

  let repoDir: string;
  let provider: SqliteProvider;
  let basisFile: string;
  let priorConfig: string | null = null;
  let warnings: string[];

  function headSha(): string {
    return git(repoDir, ['rev-parse', 'HEAD']).trim();
  }

  function commitCount(): number {
    return git(repoDir, ['rev-list', '--count', 'HEAD']).trim().length > 0
      ? Number(git(repoDir, ['rev-list', '--count', 'HEAD']).trim())
      : 0;
  }

  function bibleAtHead(): { entries: { id: string }[] } {
    return JSON.parse(git(repoDir, ['show', 'HEAD:' + BIBLE_REL]));
  }

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-demote-export-'));
    git(repoDir, ['init', '--quiet']);
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    basisFile = path.join(repoDir, 'src', 'basis.ts');
    fs.writeFileSync(basisFile, 'export const basis = 1;\n');
    git(repoDir, ['add', '-A']);
    gitCommit(repoDir, 'seed: a repo with one cited file');

    provider = new SqliteProvider(':memory:', repoDir);
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider,
      global: provider,
      projectSlug: 'test',
    } as any);

    // The shrink warning is asserted through the real emitter's output rather
    // than by replacing it, so the WORDING an operator actually sees is what
    // is pinned.
    warnings = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(a => String(a)).join(' '));
    });

    priorConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
    // No config at all: autoCommit is in its DEFAULT mode, which is the mode
    // the shrink guard belongs to.
    if (fs.existsSync(KB_CONFIG_PATH)) fs.unlinkSync(KB_CONFIG_PATH);
  });

  afterEach(() => {
    provider.close();
    vi.restoreAllMocks();
    fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (priorConfig !== null) {
      fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(KB_CONFIG_PATH, priorConfig);
    } else if (fs.existsSync(KB_CONFIG_PATH)) {
      fs.unlinkSync(KB_CONFIG_PATH);
    }
  });

  /** Three CONFIRMED entries exported and committed: the baseline bible. */
  async function seedCommittedBible(): Promise<string[]> {
    const ids = [
      await captureConfirmed(provider, 'claim one', basisFile),
      await captureConfirmed(provider, 'claim two', basisFile),
      await captureConfirmed(provider, 'claim three', basisFile),
    ];
    const first = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));
    expect(first.exported).toBe(3);
    expect(first.committed).toBe(true);
    expect(bibleAtHead().entries).toHaveLength(3);
    return ids;
  }

  it('commits a shrink whose every missing id was demoted locally', async () => {
    const ids = await seedCommittedBible();
    const shaBefore = headSha();
    const commitsBefore = commitCount();

    await provider.demote(ids[0], DEMOTE_REASON);

    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    // It really is a shrink: 3 committed entries in, 2 out.
    expect(result.exported).toBe(2);
    expect(result.committed).toBe(true);

    // Asserted from git itself, not from the return value: a NEW commit exists
    // and the artifact at HEAD is the shrunken one.
    expect(headSha()).not.toBe(shaBefore);
    expect(commitCount()).toBe(commitsBefore + 1);
    expect(git(repoDir, ['log', '-1', '--format=%an'])).toContain('pm-kb');
    const atHead = bibleAtHead();
    expect(atHead.entries).toHaveLength(2);
    expect(atHead.entries.map(e => e.id)).not.toContain(ids[0]);
    // Nothing was left dirty: the removal landed in the commit.
    expect(git(repoDir, ['status', '--porcelain', '--', BIBLE_REL]).trim()).toBe('');
  });

  it('refuses the shrink when ONE missing id was not demoted, and still warns verbatim', async () => {
    const ids = await seedCommittedBible();
    const shaBefore = headSha();

    // One deliberate demotion plus one entry that merely went stale -- the
    // apra-fleet-ong shape. A single unexplained loss poisons the whole shrink.
    await provider.demote(ids[0], DEMOTE_REASON);
    await provider.feedback(ids[1], 'this entry did not hold up in practice', 'test-agent');

    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    expect(result.exported).toBe(1);
    expect(result.committed).toBe(false);
    expect(headSha()).toBe(shaBefore);
    expect(bibleAtHead().entries).toHaveLength(3);

    // The existing warning, with its current wording.
    const shrinkWarning = warnings.find(w => w.includes('bible SHRANK'));
    expect(shrinkWarning).toBeDefined();
    expect(shrinkWarning).toContain('[fleet:warn] kb-export');
    expect(shrinkWarning).toContain(
      'bible SHRANK from 3 to 1 entries -- written to disk but NOT auto-committed. '
      + 'Review the diff and commit it yourself if the loss is intended '
      + '(set { bible: { autoCommit: true } } to commit shrinking exports unattended).',
    );

    // The loss is still a reviewable working-tree diff.
    expect(git(repoDir, ['status', '--porcelain', '--', BIBLE_REL]).trim()).not.toBe('');
  });

  it('refuses the shrink when a missing id has no local row at all', async () => {
    // A bible entry that was never captured here cannot be shown to have been
    // demoted, so its disappearance stays unexplained -- the ong case where a
    // worktree simply does not hold the knowledge the bible does.
    const ids = await seedCommittedBible();
    const committed = JSON.parse(git(repoDir, ['show', 'HEAD:' + BIBLE_REL]));
    committed.entries.push(bibleEntry('never-captured-here'));
    committed.provenance.entry_count = committed.entries.length;
    fs.writeFileSync(path.join(repoDir, BIBLE_REL), JSON.stringify(committed, null, 2) + '\n', 'utf-8');
    git(repoDir, ['add', '-A']);
    gitCommit(repoDir, 'seed: a bible entry this KB never captured');
    const shaBefore = headSha();

    await provider.demote(ids[0], DEMOTE_REASON);

    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    expect(result.exported).toBe(2);
    expect(result.committed).toBe(false);
    expect(headSha()).toBe(shaBefore);
    expect(warnings.some(w => w.includes('bible SHRANK from 4 to 2 entries'))).toBe(true);
  });

  it('refuses the shrink when a missing id was demoted but has since been re-promoted to CONFIRMED', async () => {
    // REGRESSION (round-2 review). demoted_at is WRITE-ONCE: promote() rewrites
    // confidence/promoted_at/content/source and never clears it, so "has a
    // demoted_at" outlives the demotion forever. list() also drops stale rows,
    // so a re-promoted entry that later goes stale is missing from a
    // CONFIRMED-only export while still CONFIRMED locally. Asking the WIDE
    // question ("was this id ever demoted?") made every such entry permanently
    // exempt from the guard -- demote -> re-verify -> promote -> freshness
    // sweep -> silent auto-commit of the loss, the exact apra-fleet-ong shape
    // this guard exists to refuse.
    //
    // One basis file PER entry so a single entry can be staled on its own.
    const ownBasis = (name: string): string => {
      const p = path.join(repoDir, 'src', name + '.ts');
      fs.writeFileSync(p, 'export const ' + name + ' = 1;\n');
      return p;
    };
    const fileAlpha = ownBasis('alpha');
    const fileBeta = ownBasis('beta');
    const fileGamma = ownBasis('gamma');
    git(repoDir, ['add', '-A']);
    gitCommit(repoDir, 'seed: one cited file per entry');

    const idAlpha = await captureConfirmed(provider, 'claim alpha', fileAlpha);
    const idBeta = await captureConfirmed(provider, 'claim beta', fileBeta);
    await captureConfirmed(provider, 'claim gamma', fileGamma);

    const first = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));
    expect(first.exported).toBe(3);
    expect(first.committed).toBe(true);
    expect(bibleAtHead().entries).toHaveLength(3);
    const shaBefore = headSha();
    const commitsBefore = commitCount();

    // beta: trust fell, then the claim was re-verified and promoted back up.
    // It is CONFIRMED again -- and still carries demoted_at.
    await provider.demote(idBeta, DEMOTE_REASON);
    const rePromoted = await provider.promote(idBeta, PROMOTE_REASON);
    expect(rePromoted.confidence_after).toBe('CONFIRMED');
    expect(provider.demotedIds([idBeta]).has(idBeta)).toBe(true);
    expect(provider.demotedIds([idBeta], { belowConfirmedOnly: true }).has(idBeta)).toBe(false);

    // beta's cited file changes, so the freshness sweep stales it. Nobody
    // chose to drop this knowledge -- it is exactly the unexplained loss.
    fs.writeFileSync(fileBeta, 'export const beta = 2;\n');
    const sweep = await provider.freshnessSweep(repoDir);
    expect(sweep.staled).toBe(1);

    // alpha is a genuine demotion, so the shrink LOOKS demotion-shaped.
    await provider.demote(idAlpha, DEMOTE_REASON);

    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    expect(result.exported).toBe(1);
    expect(result.committed).toBe(false);
    expect(headSha()).toBe(shaBefore);
    expect(commitCount()).toBe(commitsBefore);
    expect(bibleAtHead().entries).toHaveLength(3);

    const shrinkWarning = warnings.find(w => w.includes('bible SHRANK'));
    expect(shrinkWarning).toBeDefined();
    expect(shrinkWarning).toContain('[fleet:warn] kb-export');
    expect(shrinkWarning).toContain(
      'bible SHRANK from 3 to 1 entries -- written to disk but NOT auto-committed. '
      + 'Review the diff and commit it yourself if the loss is intended '
      + '(set { bible: { autoCommit: true } } to commit shrinking exports unattended).',
    );

    // The loss stays a reviewable working-tree diff.
    expect(git(repoDir, ['status', '--porcelain', '--', BIBLE_REL]).trim()).not.toBe('');
  });

  it('leaves a non-shrinking export committing exactly as before', async () => {
    await seedCommittedBible();
    const commitsBefore = commitCount();

    // Growth, not shrink: the guard must not be in the way at all.
    await captureConfirmed(provider, 'claim four', basisFile);
    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    expect(result.exported).toBe(4);
    expect(result.committed).toBe(true);
    expect(commitCount()).toBe(commitsBefore + 1);
    expect(warnings.some(w => w.includes('bible SHRANK'))).toBe(false);
  });

  it('autoCommit off never commits, even for a demotion-only shrink', async () => {
    const ids = await seedCommittedBible();
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ bible: { autoCommit: false } }));
    const shaBefore = headSha();

    await provider.demote(ids[0], DEMOTE_REASON);
    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    expect(result.exported).toBe(2);
    expect(result.committed).toBe(false);
    expect(headSha()).toBe(shaBefore);
  });

  it('explicit autoCommit true still commits any shrink, demoted or not', async () => {
    const ids = await seedCommittedBible();
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ bible: { autoCommit: true } }));

    // Not a demotion: the operator override is unchanged by the widening.
    await provider.feedback(ids[1], 'this entry did not hold up in practice', 'test-agent');
    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    expect(result.exported).toBe(2);
    expect(result.committed).toBe(true);
    expect(bibleAtHead().entries).toHaveLength(2);
  });
});
