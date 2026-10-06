import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { resolveKbAnchor, type KbAnchor } from '../services/knowledge/kb-self.js';
import { logWarn } from '../utils/log-helpers.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import { KB_CONFIG_PATH } from '../services/knowledge/kb-config.js';
import type { KbConfigFile } from '../services/knowledge/kb-config.js';
import { filterProjectBibleCandidates } from '../services/knowledge/bible-basis-filter.js';
import { extractBibleDemotions, type BibleDemotion } from '../services/knowledge/bible-import.js';
import type { SqliteProvider } from '../services/knowledge/sqlite-provider.js';
import type { KBEntry } from '../services/knowledge/types.js';

// T3.4 (F8b, D8): export half of the shareable, diffable team bible. Writes
// all CONFIRMED, non-superseded, non-stale project entries to
// <repo>/.fleet/kb-canonical.json. Registered as a real MCP tool (not just an
// exported helper) so any MCP-only caller -- one with no shell/git access --
// can invoke it directly after kb_promote.
// T2.3 (F6a, D5 AMENDED -- USER DIRECTIVE 2026-07-07): the tool itself now
// commits the bible after writing it (see maybeAutoCommitBible below) -- no
// role needs a manual "commit the bible" step. This is code, not agent
// discretion: the export TOOL commits with its own dedicated identity
// (pm-kb), so no role's "no git operations" rule is violated by this
// automatic side effect.
// kb (self): the repo written to is the calling session's own folder -- the
// member's registered work folder for a member session, the server's working
// folder otherwise (src/services/knowledge/kb-self.ts). It is validated (must
// exist, be a git repo with an origin remote) or kb_export refuses with a
// typed E-SELF error; it is never a scope argument.
// T3.3 (F9a, D8): scope param -- 'project' (default, unchanged behavior) reads
// the PROJECT KB and writes .fleet/kb-canonical.json (as before); 'global'
// reads the GLOBAL KB (providers.global -- the shared kb.sqlite at
// ~/.apra-fleet/data/knowledge/global/) and writes
// .fleet/kb-canonical-global.json in the given repo path (in practice the
// apra-fleet platform repo, committed there per D8). Same stable field set,
// same asciiSafeStringify + deterministic id-sorted output, and the same
// auto-commit behavior (T2.3) applies to the global file too.
// Provenance names the TARGET BASE branch: the branch the bible's entries will
// merge into, not the (typically feature) branch the export ran on. baseBranch
// and baseCommit let the caller say so explicitly; when omitted, provenance
// falls back to the export folder's own HEAD branch and commit (unchanged).
export const kbExportSchema = z.object({
  scope: z.enum(['project', 'global']).optional()
    .describe('project (default, unchanged): export the project KB to .fleet/kb-canonical.json. global: export the GLOBAL KB to .fleet/kb-canonical-global.json in the calling session\'s own repo (in practice the apra-fleet platform repo, committed there so the installer can distribute it -- D8).'),
  baseBranch: z.string().min(1).optional()
    .describe('The target base branch (the branch the entries merge into). Written to provenance.branch. Omitted: the export folder HEAD branch.'),
  baseCommit: z.string().min(1).optional()
    .describe('The base commit the entries were verified against. Written to provenance.commit. Omitted: the export folder HEAD commit.'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbExportInput = z.infer<typeof kbExportSchema>;

export interface CanonicalEntry {
  id: string;
  type: string;
  title: string;
  summary: string;
  symbols: string[];
  source_files: string[];
  confidence: string;
  updated_at: string;
}

/**
 * KB-TRUST PHASE 3a: the v2 bible envelope. kb_import accepts BOTH this and the
 * legacy bare array, selecting on Array.isArray -- an older bible must keep
 * importing unchanged.
 */
export interface CanonicalBible {
  version: 2;
  provenance: {
    /** 40-char HEAD sha, or null when the repo has no commits or git is absent. */
    commit: string | null;
    branch: string | null;
    /**
     * ENTRIES ONLY. A tombstone is not an entry, so recording a demotion never
     * moves this number -- it still names how many entries the file carries.
     */
    entry_count: number;
  };
  entries: CanonicalEntry[];
  /**
   * OPTIONAL demotion tombstones, sorted by id. Absent when the bible carries
   * none, so a reader that does not know the field (and every bible written
   * before it existed) keeps working unchanged.
   */
  demotions?: BibleDemotion[];
}

/** Entries AND tombstones of a bible already on disk. */
export interface CanonicalBibleDocument {
  entries: CanonicalEntry[];
  demotions: BibleDemotion[];
}

/** Map a KB entry to the bible's stable field set. Shared with kb_bible_commit. */
export function toCanonicalEntry(e: KBEntry): CanonicalEntry {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    summary: e.summary,
    symbols: e.symbols,
    source_files: e.source_files,
    confidence: e.confidence,
    updated_at: e.promoted_at || e.created_at,
  };
}

/** Deterministic id ordering so re-exports produce meaningful diffs. */
export function compareById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The entries of the bible already on disk, in either shape (legacy bare array
 * or v2 envelope). null when the file is absent or unparseable.
 *
 * Entries only, exactly as before: callers that do not care about tombstones are
 * unchanged. readBibleDocument below is the sibling reader for callers that do.
 */
export function readBibleEntries(outPath: string): CanonicalEntry[] | null {
  return readBibleDocument(outPath)?.entries ?? null;
}

/**
 * The entries AND the demotion tombstones of the bible already on disk. Same
 * acceptance as readBibleEntries (both shapes; null when absent or unparseable);
 * a bible with no demotions field yields an empty tombstone list, never a
 * failure.
 */
export function readBibleDocument(outPath: string): CanonicalBibleDocument | null {
  if (!fs.existsSync(outPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    const existing = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
    if (existing === null) return null;
    return { entries: existing as CanonicalEntry[], demotions: extractBibleDemotions(parsed) };
  } catch {
    return null;
  }
}

/**
 * PATHSPEC-ONLY commit of the bible file with the dedicated pm-kb identity:
 * git add <path> then a commit scoped to -- <path>, so unrelated staged or
 * dirty working-tree state is never swept in. Throws on any git failure; the
 * caller decides whether that is fatal. Never pushes.
 */
export function commitBiblePath(repoPath: string, outPath: string, message: string): void {
  execFileSync('git', ['add', outPath], {
    cwd: repoPath, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync(
    'git',
    ['-c', 'user.name=pm-kb', '-c', 'user.email=kb@pm.local', 'commit', '-m', message, '--', outPath],
    { cwd: repoPath, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/**
 * Resolve HEAD, degrading gracefully to null rather than throwing: a repo with
 * no commits yet, a non-repo directory, or a machine without git must still be
 * able to export a bible.
 */
function resolveHeadCommit(repoPath: string): string | null {
  return gitOrNull(repoPath, ['rev-parse', 'HEAD']);
}

function resolveBranch(repoPath: string): string | null {
  return gitOrNull(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * True when an existing bible already carries exactly these entries. Compares
 * the ENTRIES only, never the provenance envelope, so a moved HEAD alone never
 * counts as a change. Accepts both bible shapes: a legacy bare array compares
 * equal to the same entries, so upgrading a v1 file in place only happens when
 * its entries actually differ.
 */
function entriesUnchanged(outPath: string, nextEntriesJson: string): boolean {
  if (!fs.existsSync(outPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    const existing = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
    if (existing === null) return false;
    return asciiSafeStringify(existing) === nextEntriesJson;
  } catch {
    return false;
  }
}

function gitOrNull(repoPath: string, args: string[]): string | null {
  if (!isGitRepo(repoPath)) return null;
  try {
    const out = execFileSync('git', args, {
      cwd: repoPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ASCII-safe stringify: JSON.stringify already escapes the JSON-mandatory
// characters (quotes, control chars) but leaves ordinary non-ASCII text
// (e.g. an em-dash or accented letter that made it into a captured title or
// summary) as literal UTF-8 bytes. This file is committed under the repo's
// ASCII-only convention, so every UTF-16 code unit above the printable ASCII
// range gets re-escaped as a four-hex-digit unicode escape, one code unit at
// a time via charCodeAt/toString(16). Deliberately avoids putting a literal
// unicode-escape sequence in THIS source file's own text (it must stay
// ASCII too) and avoids template literals -- the pre-commit hook's
// backtick-n/t/r scan false-positives on template-literal escape sequences,
// the same gotcha T2.3's promote() fix worked around.
export function asciiSafeStringify(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  const maxAsciiCode = 127;
  const escapePrefix = String.fromCharCode(92) + 'u'; // backslash + 'u', built at runtime
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (code > maxAsciiCode) {
      let hex = code.toString(16);
      while (hex.length < 4) hex = '0' + hex;
      out += escapePrefix + hex;
    } else {
      out += json.charAt(i);
    }
  }
  return out;
}

// The resolved anchor folder must exist on THIS host: kb_export writes the
// bible file there, so an anchor naming a folder on another host (a remote
// member's work folder) has nothing meaningful to do and must refuse.
export function requireLocalFolder(folder: string, toolName = 'kb_export'): string {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error(toolName + ': repo folder does not exist or is not a directory on this host: ' + folder);
  }
  return folder;
}

// T2.3 (F6a, D5 AMENDED): switch for the auto-commit below, read from the
// same KB config file kb-setup.ts writes (FLEET_DIR/knowledge/config.json),
// under a { bible: { autoCommit?: boolean } } section.
//
// USER DIRECTIVE 2026-08-11: the default is TRUE.
//
// KB-TRUST PHASE 1 (2026-08-03) had set it FALSE, reasoning that kb_import
// preserves a bible's CONFIRMED confidence as its sole exemption from the D1
// clamp -- justified in-code because "the bible is a git-reviewed, human-merged
// artifact" -- and that auto-committing as pm-kb <kb@pm.local>, mid-sprint, on
// a feature branch made that review a bot commit nobody was asked to look at.
//
// The KB audit of 2026-08-11 showed the opposite failure was the real one: with
// the default off, and nothing in the pipeline calling kb_export at all, 1 of 17
// repositories had a bible. Knowledge that never gets written down cannot be
// reviewed either, and an export left uncommitted on one machine is knowledge
// nobody else will ever see. The auto-commit lands as a diff on the sprint's own
// feature branch, which a human reads in that sprint's PR -- review later in the
// loop than Phase 1 wanted, but review nonetheless. The commit remains
// pathspec-scoped to the bible file, keeps its dedicated pm-kb identity, and is
// still NEVER pushed automatically.
//
// Missing file and missing section degrade to the default (TRUE). A MALFORMED
// config still degrades to FALSE: "I could not read your settings" must not be
// the moment the tool starts committing on the team's behalf.

// 'off'      -- explicitly disabled, or the config is unreadable.
// 'default'  -- nobody expressed a preference; commit, but refuse to commit a
//               SHRINKING export (see maybeAutoCommitBible).
// 'explicit' -- the operator set autoCommit:true. A deliberate override: it
//               commits whatever the export produced, shrink included. That is
//               the documented contract the apra-fleet-ong chain test pins.
type AutoCommitMode = 'off' | 'default' | 'explicit';

function autoCommitMode(): AutoCommitMode {
  try {
    if (!fs.existsSync(KB_CONFIG_PATH)) return 'default';
    const raw = JSON.parse(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')) as KbConfigFile;
    const configured = raw.bible?.autoCommit;
    if (configured === true) return 'explicit';
    if (configured === false) return 'off';
    return 'default';
  } catch {
    // Unreadable config only: see the note above on why this one case is
    // conservative regardless of which way the default points.
    return 'off';
  }
}

function autoCommitEnabled(): boolean {
  return autoCommitMode() !== 'off';
}

// The entry count of the bible ALREADY on disk, read before we overwrite it.
// Accepts both shapes (legacy bare array, v2 envelope) like entriesUnchanged.
// null means "no comparable prior bible" -- absent file, or unparseable -- in
// which case there is no shrink to detect and the export is a first write.
function bibleEntryCount(outPath: string): number | null {
  if (!fs.existsSync(outPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    const existing = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
    return existing === null ? null : existing.length;
  } catch {
    return null;
  }
}

/** Test seam: the default is a trust decision, so it is asserted directly. */
export function _autoCommitEnabledForTest(): boolean {
  return autoCommitEnabled();
}

export function isGitRepo(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, '.git'));
}

// "Content actually changed" (D5): git status --porcelain against the exact
// pathspec, run AFTER the write above. Empty output means the working tree
// already matches HEAD for this one path -- re-exporting an identical bible
// is a no-op, so there is nothing to commit. Any output (modified, or a
// brand-new untracked file on the very first export) means it changed.
export function bibleContentChanged(repoPath: string, outPath: string): boolean {
  const status = execFileSync('git', ['status', '--porcelain', '--', outPath], {
    cwd: repoPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return status.trim().length > 0;
}

// T2.3 (F6a, D5 AMENDED -- USER DIRECTIVE 2026-07-07): auto-commit the bible
// at export time so the reviewer-verdict -> KB Agent -> promote -> export ->
// COMMIT chain is fully automatic (zero manual steps). PATHSPEC-ONLY: `git
// add <bible-path>` then a commit scoped to `-- <bible-path>` so unrelated
// staged or dirty working-tree state is NEVER swept in, exactly per D5.
// Dedicated identity (pm-kb) -- not the KB Agent's own git-less MCP session.
// Any git failure (not a repo, no git binary, hooks reject, index lock) is
// logged via log-helpers and NON-FATAL: the export itself already succeeded
// by the time this runs, and stays successful regardless of what happens
// here. Push is NOT automatic (D5: rides the existing per-turn sprint pushes).
//
// SHRINK GUARD (added with the 2026-08-11 default flip to ON). apra-fleet-ong
// was exactly this composition: import into a worktree missing cited files ->
// sweep correctly stales them -> export correctly emits only live CONFIRMED ->
// 82 of 97 entries vanish from the COMMITTED artifact other machines import
// from, with no human in the loop. The only thing standing between that
// incident and the team was the default being off, so turning it on without a
// guard would re-open it. Under the DEFAULT, an export that produces fewer
// entries than the bible it is replacing is written to disk but NOT committed:
// the loss lands as a reviewable working-tree diff, which is the outcome the
// off-default was protecting. An explicit autoCommit:true is still an operator
// override and commits the shrink -- documented behavior, not an accident.
function maybeAutoCommitBible(
  repoPath: string,
  outPath: string,
  entryCount: number,
  scope: 'project' | 'global' = 'project',
  previousEntryCount: number | null = null,
): boolean {
  const mode = autoCommitMode();
  if (mode === 'off') return false;
  if (!isGitRepo(repoPath)) return false;

  if (mode === 'default' && previousEntryCount !== null && entryCount < previousEntryCount) {
    logWarn(
      'kb-export',
      'bible SHRANK from ' + previousEntryCount + ' to ' + entryCount + ' entries -- written to disk but NOT '
      + 'auto-committed. Review the diff and commit it yourself if the loss is intended '
      + '(set { bible: { autoCommit: true } } to commit shrinking exports unattended).',
    );
    return false;
  }

  try {
    if (!bibleContentChanged(repoPath, outPath)) return false;

    const scopeLabel = scope === 'global' ? 'global knowledge bible' : 'knowledge bible';
    const message = 'chore(kb): update ' + scopeLabel + ' -- ' + entryCount + ' confirmed entries';
    commitBiblePath(repoPath, outPath, message);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarn('kb-export', 'bible auto-commit failed (non-fatal, export still succeeded): ' + reason);
    return false;
  }
}

// Id ordering for the additive project merge, whose existing bible entries are
// raw objects (never re-shaped) and so carry an id of unknown type.
function byId(a: { id?: unknown }, b: { id?: unknown }): number {
  const x = String(a.id);
  const y = String(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Entries of the bible already on disk, as raw objects (never re-shaped, so
 * they are written back byte-for-byte equivalent). Accepts the v2 envelope and
 * the legacy bare array. An absent file is an empty bible. A file that exists
 * but cannot be parsed as either shape THROWS: the project export is additive
 * and must never overwrite (and so silently drop) a bible it cannot read.
 */
function readExistingBibleDocument(
  outPath: string,
): { entries: Array<Record<string, unknown>>; demotions: BibleDemotion[] } {
  if (!fs.existsSync(outPath)) return { entries: [], demotions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  } catch (err) {
    throw new Error('kb_export: existing bible is not valid JSON, refusing to overwrite it: ' + outPath
      + ' (' + (err instanceof Error ? err.message : String(err)) + ')');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : null);
  if (list === null) {
    throw new Error('kb_export: existing bible has no entries array, refusing to overwrite it: ' + outPath);
  }
  return { entries: list as Array<Record<string, unknown>>, demotions: extractBibleDemotions(parsed) };
}

/**
 * Is `later` strictly after `earlier`? Both are ISO-8601 instants written by
 * this codebase (toISOString), but a bible is edited by humans and merged across
 * clones, so an unparseable value degrades to a plain string comparison rather
 * than silently answering "no".
 */
function isStrictlyAfter(later: string | undefined, earlier: string): boolean {
  if (!later) return false;
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  if (Number.isNaN(a) || Number.isNaN(b)) return later > earlier;
  return a > b;
}

// PROJECT-SCOPE EXPORT: basis filter + additive merge.
//
// Only CONFIRMED (non-superseded, non-stale -- list() already excludes those)
// entries whose per-file hash basis matches the files in repoPath qualify (see
// qualifiesForProjectBible in services/knowledge/bible-basis-filter.ts). A
// member-local KB routinely holds entries about files the exported tree does
// not contain; publishing them would leak them into the committed artifact.
//
// The merge is ADDITIVE: every entry already in the bible is kept exactly as it
// is (curated, possibly human-edited), qualifying entries whose id is not yet
// present are added, and on an id collision the existing bible entry wins.
// Nothing is ever removed by an export -- removal is a human (or reconcile)
// edit of the file. Consequently the project bible never shrinks through this
// path and the shrink guard in maybeAutoCommitBible only matters for global.
//
// No new id to add -> the file is not touched at all (byte-identical,
// provenance untouched) and nothing is committed.
//
// `exported` in the response is the number of entries in the bible as written
// (or as left on disk when nothing was added), not the number newly added.
async function exportProjectBible(
  source: SqliteProvider,
  repoPath: string,
  outPath: string,
  input: KbExportInput,
): Promise<string> {
  const { entries: existing, demotions } = readExistingBibleDocument(outPath);
  const existingIds = new Set(existing.map(e => String(e.id)));
  const tombstones = new Map(demotions.map(d => [d.id, d]));

  const confirmed = await source.list({ confidence: ['CONFIRMED'] });
  // TOMBSTONE GATE, before the basis filter. An id another clone demoted is not
  // re-added just because this clone still holds it CONFIRMED -- that is how a
  // demotion would be silently undone on the next export. The ONE exception is a
  // local row promoted AFTER the tombstone was recorded: that is a deliberate
  // re-promotion on newer evidence, so the entry comes back and its tombstone is
  // cleared in the same write.
  const newCandidates = confirmed.filter(e => {
    if (existingIds.has(e.id)) return false;
    const tombstone = tombstones.get(e.id);
    if (!tombstone) return true;
    return isStrictlyAfter(e.promoted_at, tombstone.demoted_at);
  });
  const bases = source.getSourceFileBases(newCandidates.map(e => e.id));
  const qualifying = await filterProjectBibleCandidates(newCandidates, bases, repoPath);

  if (qualifying.length === 0) {
    return JSON.stringify({ exported: existing.length, path: outPath, scope: 'project', committed: false });
  }

  for (const e of qualifying) tombstones.delete(e.id);

  const merged = [...existing, ...qualifying.map(toCanonicalEntry)].sort(byId);
  const nextDemotions = Array.from(tombstones.values()).sort(compareById);
  const bible = {
    version: 2 as const,
    provenance: {
      commit: input.baseCommit ?? resolveHeadCommit(repoPath),
      branch: input.baseBranch ?? resolveBranch(repoPath),
      // Entries only: the tombstones below are deliberately not counted.
      entry_count: merged.length,
    },
    entries: merged,
    // Omitted entirely when there are none, so a bible that never saw a
    // demotion is byte-identical to one written before the field existed.
    ...(nextDemotions.length > 0 ? { demotions: nextDemotions } : {}),
  };
  const fleetDir = path.dirname(outPath);
  if (!fs.existsSync(fleetDir)) fs.mkdirSync(fleetDir, { recursive: true });
  const previousEntryCount = bibleEntryCount(outPath);
  fs.writeFileSync(outPath, asciiSafeStringify(bible) + '\n', 'utf-8');

  const committed = maybeAutoCommitBible(repoPath, outPath, merged.length, 'project', previousEntryCount);
  return JSON.stringify({ exported: merged.length, path: outPath, scope: 'project', committed });
}

export async function kbExport(input: KbExportInput, anchor?: KbAnchor): Promise<string> {
  // kb_export WRITES <folder>/.fleet/kb-canonical.json and git-commits it, so
  // an unreachable folder has no meaningful behaviour left -- it must not
  // proceed. An invalid anchor throws here, before getKbProviders is reached,
  // so no provider is ever anchored somewhere the caller did not mean.
  const resolved = resolveKbAnchor(anchor);
  const repoPath = requireLocalFolder(resolved.folder);
  const scope = input.scope ?? 'project';

  // Read from the SAME repo we are about to write the bible into. Resolving the
  // source from process cwd while writing to repoPath is how repo A's entries
  // used to end up serialised into repo B's committed bible.
  const providers = await getKbProviders(repoPath, resolved.remoteUrl);
  const fleetDir = path.join(repoPath, '.fleet');
  const fileName = scope === 'global' ? 'kb-canonical-global.json' : 'kb-canonical.json';
  const outPath = path.join(fleetDir, fileName);

  if (scope === 'project') {
    return exportProjectBible(requireSqliteProject(providers.project, 'kb_export'), repoPath, outPath, input);
  }

  const entries = await providers.global.list({ confidence: ['CONFIRMED'] });

  // Deterministic ordering by id so re-exports produce meaningful diffs.
  const canonical: CanonicalEntry[] = entries
    .map(toCanonicalEntry)
    .sort(compareById);

  if (!fs.existsSync(fleetDir)) {
    fs.mkdirSync(fleetDir, { recursive: true });
  }

  // KB-TRUST PHASE 3a: the bible records the commit it was exported from, so a
  // later audit can date its entries against the tree they were verified on.
  // Before this, a bible harvested from other repositories was indistinguishable
  // from a real one.
  //
  // THE COMMIT, NOT A TIMESTAMP. Entries are sorted by id above "so re-exports
  // produce meaningful diffs"; an exported_at timestamp would defeat exactly
  // that, producing a diff on every export even when no entry changed and
  // turning the git history into noise. A commit sha changes only when the tree
  // the entries were verified against changes, which is the signal worth
  // recording. entry_count is derivable but cheap, and makes truncation visible
  // in a diff -- precisely the failure mode of apra-fleet-ong.
  //
  // ENTRIES-UNCHANGED IS A NO-OP. Auto-committing the bible moves HEAD, so
  // re-reading HEAD on the next export would record a DIFFERENT commit, rewrite
  // the file, and commit again -- an export that never converges and produces
  // exactly the git-history noise recording a commit (rather than a timestamp)
  // exists to avoid. When the entry set is unchanged the file is left exactly as
  // it is, which also keeps the recorded commit honest: it names the tree those
  // entries were last verified against, not the commit that stored them.
  const nextEntriesJson = asciiSafeStringify(canonical);
  if (entriesUnchanged(outPath, nextEntriesJson)) {
    return JSON.stringify({ exported: canonical.length, path: outPath, scope, committed: false });
  }

  const bible: CanonicalBible = {
    version: 2,
    provenance: {
      commit: input.baseCommit ?? resolveHeadCommit(repoPath),
      branch: input.baseBranch ?? resolveBranch(repoPath),
      entry_count: canonical.length,
    },
    entries: canonical,
  };
  // Read the OUTGOING count before the write below destroys it -- the shrink
  // guard in maybeAutoCommitBible compares against the bible being replaced.
  const previousEntryCount = bibleEntryCount(outPath);
  fs.writeFileSync(outPath, asciiSafeStringify(bible) + '\n', 'utf-8');

  const committed = maybeAutoCommitBible(repoPath, outPath, canonical.length, scope, previousEntryCount);

  return JSON.stringify({ exported: canonical.length, path: outPath, scope, committed });
}
