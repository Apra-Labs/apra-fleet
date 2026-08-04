import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { FLEET_DIR } from '../paths.js';
import { logWarn } from '../utils/log-helpers.js';

// T3.4 (F8b, D8): export half of the shareable, diffable team bible. Writes
// all CONFIRMED, non-superseded, non-stale project entries to
// <repo>/.fleet/kb-canonical.json. Registered as a real MCP tool (not just an
// exported helper) so the KB Agent -- which is MCP-only, it has no shell/git
// access -- can invoke it directly after kb_promote.
// T2.3 (F6a, D5 AMENDED -- USER DIRECTIVE 2026-07-07): the tool itself now
// commits the bible after writing it (see maybeAutoCommitBible below) -- the
// PM no longer needs a manual "commit the bible" step. This is code, not
// agent discretion: tpl-kb-agent.md documents that the export TOOL commits
// with its own dedicated identity (pm-kb), so the KB Agent's "no git
// operations" rule is not violated by this automatic side effect.
// F4 (T1.6): repo path resolution precedence -- (1) explicit repo_path input,
// validated (must exist and be a directory) or kb_export refuses with a clear
// error; (2) validated session context -- this process's own working
// directory, used ONLY when repo_path is omitted, and put through the exact
// same existence + isDirectory check as an explicit path, never trusted
// blindly; (3) neither validates -- kb_export refuses with a clear error
// rather than silently writing relative to an arbitrary path. There is no
// bare process.cwd() fallback: the fallback tier is validated the same way
// explicit input is.
// T3.3 (F9a, D8): scope param -- 'project' (default, unchanged behavior) reads
// the PROJECT KB and writes .fleet/kb-canonical.json (as before); 'global'
// reads the GLOBAL KB (providers.global -- the shared kb.sqlite at
// ~/.apra-fleet/data/knowledge/global/) and writes
// .fleet/kb-canonical-global.json in the given repo path (in practice the
// apra-fleet platform repo, committed there per D8). Same stable field set,
// same asciiSafeStringify + deterministic id-sorted output, and the same
// auto-commit behavior (T2.3) applies to the global file too.
export const kbExportSchema = z.object({
  repo_path: z.string().optional()
    .describe('Path to the repo root to write the canonical bible into. Precedence: this explicit input, when given, is validated (must exist and be a directory) or the call fails; when omitted, falls back to the validated session working directory (same validation, not a blind default); if neither validates, kb_export refuses with a clear error.'),
  scope: z.enum(['project', 'global']).optional()
    .describe('project (default, unchanged): export the project KB to .fleet/kb-canonical.json. global: export the GLOBAL KB to .fleet/kb-canonical-global.json in the given repo path (in practice the apra-fleet platform repo, committed there so the installer can distribute it -- D8).'),
});

export type KbExportInput = z.infer<typeof kbExportSchema>;

interface CanonicalEntry {
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
interface CanonicalBible {
  version: 2;
  provenance: {
    /** 40-char HEAD sha, or null when the repo has no commits or git is absent. */
    commit: string | null;
    branch: string | null;
    entry_count: number;
  };
  entries: CanonicalEntry[];
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
function asciiSafeStringify(value: unknown): string {
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

// F4 (T1.6): shared validation for both precedence tiers -- an explicit
// repo_path (tier 1) and the session working directory fallback (tier 2, used
// only when repo_path is omitted) go through the identical existence +
// isDirectory check. Neither tier is ever trusted without it.
function resolveRepoPath(explicit?: string): string {
  const candidate = explicit || process.cwd();
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error('kb_export: repo_path does not exist or is not a directory: ' + candidate);
  }
  return candidate;
}

// T2.3 (F6a, D5 AMENDED): switch for the auto-commit below, read from the
// same KB config file kb-setup.ts writes (FLEET_DIR/knowledge/config.json),
// under a { bible: { autoCommit?: boolean } } section.
//
// KB-TRUST PHASE 1 (decided 2026-08-03): the default is now FALSE. kb_import
// preserves a bible's CONFIRMED confidence as its sole exemption from the D1
// clamp, justified in-code because "the bible is a git-reviewed, human-merged
// artifact". Auto-committing the export as pm-kb <kb@pm.local>, mid-sprint, on
// a feature branch, made that review a bot commit nobody was asked to look at.
// The default should make human review possible rather than pre-empt it.
// Missing file, missing section, or malformed JSON all degrade to the default
// (FALSE) -- kb_export never fails because the config is absent or bad, and a
// config problem must not silently start committing on the team's behalf.
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

function autoCommitEnabled(): boolean {
  try {
    if (!fs.existsSync(KB_CONFIG_PATH)) return false;
    const raw = JSON.parse(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')) as { bible?: { autoCommit?: boolean } };
    return raw.bible?.autoCommit ?? false;
  } catch {
    return false;
  }
}

/** Test seam: the default is a trust decision, so it is asserted directly. */
export function _autoCommitEnabledForTest(): boolean {
  return autoCommitEnabled();
}

function isGitRepo(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, '.git'));
}

// "Content actually changed" (D5): git status --porcelain against the exact
// pathspec, run AFTER the write above. Empty output means the working tree
// already matches HEAD for this one path -- re-exporting an identical bible
// is a no-op, so there is nothing to commit. Any output (modified, or a
// brand-new untracked file on the very first export) means it changed.
function bibleContentChanged(repoPath: string, outPath: string): boolean {
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
function maybeAutoCommitBible(repoPath: string, outPath: string, entryCount: number, scope: 'project' | 'global' = 'project'): boolean {
  if (!autoCommitEnabled()) return false;
  if (!isGitRepo(repoPath)) return false;

  try {
    if (!bibleContentChanged(repoPath, outPath)) return false;

    execFileSync('git', ['add', outPath], {
      cwd: repoPath, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const scopeLabel = scope === 'global' ? 'global knowledge bible' : 'knowledge bible';
    const message = 'chore(kb): update ' + scopeLabel + ' -- ' + entryCount + ' confirmed entries';
    execFileSync(
      'git',
      ['-c', 'user.name=pm-kb', '-c', 'user.email=kb@pm.local', 'commit', '-m', message, '--', outPath],
      { cwd: repoPath, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarn('kb-export', 'bible auto-commit failed (non-fatal, export still succeeded): ' + reason);
    return false;
  }
}

export async function kbExport(input: KbExportInput): Promise<string> {
  const repoPath = resolveRepoPath(input.repo_path);
  const scope = input.scope ?? 'project';

  // Read from the SAME repo we are about to write the bible into. Resolving the
  // source from process cwd while writing to repoPath is how repo A's entries
  // used to end up serialised into repo B's committed bible.
  const providers = await getKbProviders(repoPath);
  const source = scope === 'global' ? providers.global : providers.project;
  const entries = await source.list({ confidence: 'CONFIRMED' });

  // Deterministic ordering by id so re-exports produce meaningful diffs.
  const canonical: CanonicalEntry[] = entries
    .map(e => ({
      id: e.id,
      type: e.type,
      title: e.title,
      summary: e.summary,
      symbols: e.symbols,
      source_files: e.source_files,
      confidence: e.confidence,
      updated_at: e.promoted_at || e.created_at,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const fleetDir = path.join(repoPath, '.fleet');
  if (!fs.existsSync(fleetDir)) {
    fs.mkdirSync(fleetDir, { recursive: true });
  }
  const fileName = scope === 'global' ? 'kb-canonical-global.json' : 'kb-canonical.json';
  const outPath = path.join(fleetDir, fileName);

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
      commit: resolveHeadCommit(repoPath),
      branch: resolveBranch(repoPath),
      entry_count: canonical.length,
    },
    entries: canonical,
  };
  fs.writeFileSync(outPath, asciiSafeStringify(bible) + '\n', 'utf-8');

  const committed = maybeAutoCommitBible(repoPath, outPath, canonical.length, scope);

  return JSON.stringify({ exported: canonical.length, path: outPath, scope, committed });
}
