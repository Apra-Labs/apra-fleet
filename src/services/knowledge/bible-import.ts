// Bible (.fleet/kb-canonical.json) parsing and import-mode loading, shared by
// kb_import (src/tools/kb-import.ts) and the member bible view
// (member-bible-view.ts). One parser and one capture path: the view must rank,
// quarantine directives and preserve bible confidence exactly as an import
// into the per-repo DB does, so it reuses this code rather than a copy.

import fs from 'node:fs';
import { KbCaptureRejected } from './types.js';
import type { KBEntryInput, ContentType, Confidence, AudnDecision } from './types.js';
import type { SqliteProvider } from './sqlite-provider.js';

export type KbBibleErrorCode = 'E-BIBLE-MALFORMED';

/**
 * A bible file that exists but cannot be read as a bible: invalid JSON, or a
 * shape that is neither the legacy bare array nor the v2 { entries } envelope.
 * Never treated as an empty bible.
 */
export class KbBibleError extends Error {
  readonly code: KbBibleErrorCode;
  readonly biblePath: string;
  readonly remediation: string;
  constructor(message: string, biblePath: string) {
    super(message);
    this.name = 'KbBibleError';
    this.code = 'E-BIBLE-MALFORMED';
    this.biblePath = biblePath;
    this.remediation = `Fix or regenerate '${biblePath}' (kb_export writes it), or restore it from git.`;
  }
}

/**
 * Read and parse a bible file into its raw entry array. Throws KbBibleError
 * when the file is not valid JSON or not a bible shape. `label` prefixes the
 * error message (e.g. 'kb_import'). A missing file surfaces as the fs error;
 * callers decide whether missing is an error (kb_import) or empty (the view).
 *
 * KB-TRUST PHASE 3a: the bible has TWO on-disk shapes and must accept both.
 *   v1 (legacy): a bare JSON array of entries.
 *   v2:          { version, provenance: {commit, branch, entry_count}, entries }
 * Selection is on Array.isArray. The reader must never lag the writer.
 */
export function readBibleEntries(biblePath: string, label: string): unknown[] {
  const raw = fs.readFileSync(biblePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KbBibleError(`${label}: bible file is not valid JSON: ${biblePath}`, biblePath);
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries))
      ? (parsed as { entries: unknown[] }).entries
      : null;
  if (entries === null) {
    throw new KbBibleError(`${label}: bible file is not a JSON array of entries: ${biblePath}`, biblePath);
  }
  return entries;
}

const VALID_TYPES: readonly ContentType[] = ['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive'];
const VALID_CONFIDENCE: readonly Confidence[] = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];

interface BibleEntry {
  id: string;
  type: ContentType;
  title: string;
  summary: string;
  symbols?: string[];
  source_files?: string[];
  confidence: Confidence;
  updated_at?: string;
}

// Validate a single parsed bible entry against the exported CanonicalEntry field
// set {id, type, title, summary, symbols, source_files, confidence, updated_at}
// (KB b9df569a -- NOTE: no content field). Malformed entries are tolerated and
// skipped individually rather than aborting the whole import.
function isValidBibleEntry(e: unknown): e is BibleEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return false;
  if (typeof r.type !== 'string' || !(VALID_TYPES as readonly string[]).includes(r.type)) return false;
  if (typeof r.title !== 'string' || r.title.length === 0) return false;
  if (typeof r.summary !== 'string' || r.summary.length === 0) return false;
  if (typeof r.confidence !== 'string' || !(VALID_CONFIDENCE as readonly string[]).includes(r.confidence)) return false;
  if (r.symbols !== undefined && !Array.isArray(r.symbols)) return false;
  if (r.source_files !== undefined && !Array.isArray(r.source_files)) return false;
  return true;
}

// LOW-2: bible entries carry no content field, so synthesize content
// DETERMINISTICALLY from the summary. Determinism matters twice: (1) a re-import
// of the same bible produces byte-identical content so AUDN's content-equality
// 'none' path can dedupe an id-collision-with-identical-content case; (2) it
// keeps import a pure function of the bible file.
function synthesizeContent(entry: BibleEntry): string {
  return entry.summary;
}

export interface BibleImportCounts {
  imported: number;
  skipped: number;
  linked: number;
  flagged: number;
  rejected: number;
}

/**
 * Import raw bible entries into a SqliteProvider through capture()'s INTERNAL
 * import mode: bible confidence preserved for non-directive types, directives
 * quarantined as pending proposals, source='import'. Malformed entries and
 * entries whose id already exists are skipped; entries failing the capture
 * basis check are counted as rejected. No freshness sweep (callers decide).
 */
export async function importBibleEntries(provider: SqliteProvider, bibleEntries: unknown[]): Promise<BibleImportCounts> {
  let imported = 0;
  let skipped = 0;
  let linked = 0;
  let flagged = 0;
  let rejected = 0;

  for (const candidate of bibleEntries) {
    // Malformed entry -> tolerate and skip individually.
    if (!isValidBibleEntry(candidate)) {
      skipped++;
      continue;
    }
    const entry = candidate;

    // ORDER OF OPERATIONS (LOW-2): id-exists check FIRST, before capture()/AUDN.
    // This is what makes re-import EXACT even for symbol-less/file-less entries
    // AUDN can never dedupe.
    if (provider.hasEntry(entry.id)) {
      skipped++;
      continue;
    }

    const kbInput: KBEntryInput = {
      type: entry.type,
      title: entry.title,
      summary: entry.summary,
      content: synthesizeContent(entry),
      source_files: entry.source_files ?? [],
      symbols: entry.symbols ?? [],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      // Bible entries carry no author; the trusted channel is the provenance.
      author: 'unknown',
      source: 'import',
      confidence: entry.confidence,
      scope: 'project',
    };

    // Route through the AUDN choke point with the INTERNAL import mode and the
    // preserved bible id. A user-directive is still forced through the directive
    // gate (pending proposal) INSIDE capture() -- import mode does not bypass it.
    // KB-TRUST PHASE 1: isolate each entry so one unfalsifiable bible entry is
    // counted and the import continues, rather than aborting every entry after
    // it. Import mode exempts the confidence clamp, never the basis check.
    let audn_decision: AudnDecision;
    try {
      ({ audn_decision } = await provider.capture(kbInput, {
        importMode: true,
        preferredId: entry.id,
      }));
    } catch (err) {
      if (err instanceof KbCaptureRejected) {
        rejected++;
        continue;
      }
      throw err;
    }

    if (audn_decision === 'add') imported++;
    else if (audn_decision === 'none') skipped++;
    // AUDN 'update' means the entry was linked to a same-topic predecessor and
    // BOTH stay live -- supersede is opt-in (input.supersedes) and kb_import
    // never sets it, because a bible authored on another branch cannot name a
    // local entry's id. Counting these as "superseded" reported a retirement
    // that never happened.
    else if (audn_decision === 'update') linked++;
    else if (audn_decision === 'flagged') flagged++;
  }

  return { imported, skipped, linked, flagged, rejected };
}
