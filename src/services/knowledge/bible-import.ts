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
 * An EXPLICIT demotion tombstone in the committed bible: this id was CONFIRMED
 * here once and trust was withdrawn at demoted_at. A demotion is NEVER inferred
 * from an entry merely being absent from the bible -- a clone legitimately holds
 * CONFIRMED rows that were never exported (local-only promotions, basis_mismatch
 * refusals), and those must never be demoted by an import.
 */
export interface BibleDemotion {
  id: string;
  demoted_at: string;
}

/**
 * A parsed bible: its entries AND its demotion tombstones. The two readers that
 * return entries only (readBibleEntries/parseBibleText here, readBibleEntries in
 * src/tools/kb-export.ts) keep their existing signature and are implemented on
 * top of the document readers, so no existing caller changes shape and a caller
 * that needs tombstones has one to ask for. Both modules follow the same
 * sibling-reader approach.
 */
export interface BibleDocument {
  entries: unknown[];
  demotions: BibleDemotion[];
}

/**
 * The tombstones of an already-parsed bible value, in id order and deduped
 * (last wins). Tolerant by design: the field is OPTIONAL, a reader that does not
 * know it must keep working, and a malformed tombstone is dropped individually
 * rather than failing the whole bible -- exactly how a malformed ENTRY is
 * treated by importBibleEntries below. The one shared implementation of the
 * tombstone-extraction rule; kb-export.ts's reader calls it too.
 */
export function extractBibleDemotions(parsed: unknown): BibleDemotion[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const raw = (parsed as { demotions?: unknown }).demotions;
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, BibleDemotion>();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue;
    const r = candidate as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.length === 0) continue;
    if (typeof r.demoted_at !== 'string' || r.demoted_at.length === 0) continue;
    byId.set(r.id, { id: r.id, demoted_at: r.demoted_at });
  }
  return Array.from(byId.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  return readBibleDocument(biblePath, label).entries;
}

/** Parse bible text already in memory (e.g. fetched from a remote member). */
export function parseBibleText(raw: string, biblePath: string, label: string): unknown[] {
  return parseBibleDocument(raw, biblePath, label).entries;
}

/** Entries AND tombstones of a bible file. Same parse, same refusals. */
export function readBibleDocument(biblePath: string, label: string): BibleDocument {
  return parseBibleDocument(fs.readFileSync(biblePath, 'utf-8'), biblePath, label);
}

/** Entries AND tombstones of bible text already in memory. */
export function parseBibleDocument(raw: string, biblePath: string, label: string): BibleDocument {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
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
  // A legacy bare array carries no demotions field; extract returns [] for it.
  return { entries, demotions: extractBibleDemotions(parsed) };
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
  /**
   * Local rows actually taken CONFIRMED -> INFERRED by an explicit demotion
   * tombstone in this bible. A tombstone that named no local row, or one whose
   * row was re-promoted after the demotion, is NOT counted: this is how many
   * rows changed, not how many tombstones were read.
   */
  demoted: number;
}

/**
 * Import raw bible entries into a SqliteProvider through capture()'s INTERNAL
 * import mode: bible confidence preserved for non-directive types, directives
 * quarantined as pending proposals, source='import'. Malformed entries and
 * entries whose id already exists are skipped; entries failing the capture
 * basis check are counted as rejected. No freshness sweep (callers decide).
 */
export interface BibleImportOptions {
  /**
   * Load every valid entry verbatim (no AUDN dedupe/update/contradiction):
   * bible id and bible confidence kept exactly. For the member bible view,
   * which must reproduce the reviewed bible rather than re-curate it.
   */
  verbatim?: boolean;
  /**
   * The EXPLICIT demotion tombstones of the same bible (parseBibleDocument /
   * readBibleDocument return them alongside the entries). Applied AFTER the
   * entry loop, against rows that already existed locally.
   *
   * Omitted (or empty) means "this bible carries no tombstones" -- NOT "demote
   * whatever is missing". Absence is never evidence of demotion: a clone
   * legitimately holds CONFIRMED rows that were never exported, and an import
   * must leave those byte-unchanged.
   */
  demotions?: BibleDemotion[];
}

export async function importBibleEntries(
  provider: SqliteProvider,
  bibleEntries: unknown[],
  options: BibleImportOptions = {},
): Promise<BibleImportCounts> {
  let imported = 0;
  let skipped = 0;
  let linked = 0;
  let flagged = 0;
  let rejected = 0;
  let demoted = 0;

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
        verbatim: options.verbatim === true,
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

  // TOMBSTONES, applied AFTER the entry loop so an id the bible lists as a live
  // entry is loaded first and judged on its own merits (its fresh created_at is
  // newer than any tombstone, so it correctly stays CONFIRMED). The provider
  // holds every rule -- never create, promotion-time comparison, no ownerTag
  // check -- in applyBibleDemotion; this loop only counts what it changed.
  //
  // Note what is NOT here: nothing walks the local rows looking for ids missing
  // from the bible. Only an id with an EXPLICIT tombstone is ever touched.
  for (const tombstone of options.demotions ?? []) {
    if (provider.applyBibleDemotion(tombstone.id, tombstone.demoted_at)) demoted++;
  }

  return { imported, skipped, linked, flagged, rejected, demoted };
}
