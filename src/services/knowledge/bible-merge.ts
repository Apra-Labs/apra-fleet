/**
 * Id-keyed three-way merge of the knowledge bible (.fleet/kb-canonical.json),
 * entries AND tombstones (the `demotions` list).
 *
 * This is the engine behind `apra-fleet kb merge-driver`, the git merge driver
 * kb_setup registers for the bible in a clone. The same rules are implemented
 * by the standalone script packages/apra-fleet-se/scripts/merge-kb-canonical.mjs
 * (used from a checkout when a hosted merge reports a bible conflict); a parity
 * test (tests/knowledge/bible-merge-parity.test.ts) keeps the two identical.
 *
 * ENTRIES (per id; identity is the id, never the title)
 *   in base, missing from either side        -> deleted (never resurrected)
 *   unchanged / changed by one side          -> base / that side
 *   changed by both to the same content      -> taken
 *   changed by both differently              -> conflict
 *   added by one side, or by both            -> kept (one copy)
 *
 * TOMBSTONES (per id; content is the whole tombstone: at, reason, note,
 * evidence_files)
 *   in base, missing from both sides         -> removed
 *   in base, missing from one side, the
 *     other side unchanged                    -> removed (a re-promotion or a
 *                                                restore cleared it)
 *   in base, missing from one side, the
 *     other side changed it                   -> conflict
 *   unchanged / changed by one side          -> base / that side
 *   changed by both to the same content      -> taken
 *   changed by both differently              -> conflict
 *   added by one side                        -> kept
 *   added by both, same content              -> kept (one copy)
 *   added by both, different content         -> conflict
 *
 * A TOMBSTONE WINS over a same-id entry: an id present in the merged
 * tombstones is removed from the merged entries, so no id ends in both lists.
 * Duplicate ids inside one list of one input are conflicts. An entry or
 * tombstone without a usable id is malformed input (MalformedBibleError).
 *
 * The merged document is in writer form: entries and tombstones sorted by id,
 * `demotions` omitted when empty, the legacy provenance.commit/entry_count
 * dropped, the highest input version kept. serializeBible() writes the
 * exporter's byte form (2-space JSON, non-ASCII escaped, trailing newline).
 */

export type BibleDoc = Record<string, unknown> & {
  entries: Array<Record<string, unknown>>;
  demotions?: Array<Record<string, unknown>>;
};

/** Entry fields compared to decide whether a side changed an entry (updated_at excluded). */
export const BIBLE_ENTRY_CONTENT_FIELDS = ['type', 'title', 'summary', 'symbols', 'source_files', 'source_file_hashes', 'confidence'] as const;

export class MalformedBibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedBibleError';
  }
}

export type BibleMergeConflict =
  | { kind: 'duplicate-id'; list: 'entries' | 'demotions'; identity: string; side: string; indexes: number[] }
  | { kind: 'content'; list: 'entries' | 'demotions'; identity: string; base?: unknown; ours?: unknown; theirs?: unknown };

export interface BibleMergeSummary {
  mergedEntries: number;
  mergedTombstones: number;
  entriesDroppedForTombstone: string[];
  genuineConflicts: number;
}

export interface BibleMergeResult {
  merged: BibleDoc | null;
  summary: BibleMergeSummary;
  conflicts: BibleMergeConflict[];
}

function usableId(item: unknown): string | null {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function entrySignature(entry: Record<string, unknown>): string {
  return JSON.stringify(BIBLE_ENTRY_CONTENT_FIELDS.map((f) => canonicalValue(entry[f] ?? null)));
}

function tombstoneSignature(t: Record<string, unknown>): string {
  return JSON.stringify(canonicalValue(t));
}

function listOf(doc: Record<string, unknown>, list: 'entries' | 'demotions', side: string): Array<Record<string, unknown>> {
  const value = doc[list];
  if (value === undefined && list === 'demotions') return [];
  if (!Array.isArray(value)) {
    throw new MalformedBibleError(`bible merge: ${side} ${list} is not an array`);
  }
  value.forEach((item, index) => {
    if (usableId(item) === null) {
      throw new MalformedBibleError(`bible merge: ${side} ${list === 'entries' ? 'entry' : 'tombstone'} #${index} has no usable id (a non-empty string is required)`);
    }
  });
  return value as Array<Record<string, unknown>>;
}

function indexById(items: Array<Record<string, unknown>>, list: 'entries' | 'demotions', side: string, conflicts: BibleMergeConflict[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const positions = new Map<string, number[]>();
  items.forEach((item, index) => {
    const id = usableId(item)!;
    if (!positions.has(id)) positions.set(id, []);
    positions.get(id)!.push(index);
    if (!map.has(id)) map.set(id, item);
  });
  for (const [identity, indexes] of positions) {
    if (indexes.length > 1) conflicts.push({ kind: 'duplicate-id', list, identity, side, indexes });
  }
  return map;
}

function mergeEntries(
  b: Map<string, Record<string, unknown>>, o: Map<string, Record<string, unknown>>, t: Map<string, Record<string, unknown>>,
  conflicts: BibleMergeConflict[],
): Map<string, Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const [id, baseEntry] of b) {
    const ours = o.get(id);
    const theirs = t.get(id);
    if (!ours || !theirs) continue; // deleted by one or both sides
    const bs = entrySignature(baseEntry);
    const os = entrySignature(ours);
    const ts = entrySignature(theirs);
    if (os !== bs && ts !== bs) {
      if (os === ts) merged.set(id, ours);
      else conflicts.push({ kind: 'content', list: 'entries', identity: id, base: baseEntry, ours, theirs });
      continue;
    }
    merged.set(id, os !== bs ? ours : ts !== bs ? theirs : baseEntry);
  }
  for (const side of [o, t]) {
    for (const [id, entry] of side) {
      if (!b.has(id) && !merged.has(id)) merged.set(id, entry);
    }
  }
  return merged;
}

function mergeTombstones(
  b: Map<string, Record<string, unknown>>, o: Map<string, Record<string, unknown>>, t: Map<string, Record<string, unknown>>,
  conflicts: BibleMergeConflict[],
): Map<string, Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  const ids = new Set<string>([...b.keys(), ...o.keys(), ...t.keys()]);
  for (const id of ids) {
    const base = b.get(id);
    const ours = o.get(id);
    const theirs = t.get(id);
    const sig = (x: Record<string, unknown> | undefined) => (x === undefined ? null : tombstoneSignature(x));
    const bs = sig(base);
    const os = sig(ours);
    const ts = sig(theirs);
    const conflict = () => conflicts.push({ kind: 'content', list: 'demotions', identity: id, base, ours, theirs });
    if (base !== undefined) {
      if (ours === undefined && theirs === undefined) continue;
      if (ours === undefined) { if (ts === bs) continue; conflict(); continue; }
      if (theirs === undefined) { if (os === bs) continue; conflict(); continue; }
      if (os !== bs && ts !== bs && os !== ts) { conflict(); continue; }
      merged.set(id, os !== bs ? ours : ts !== bs ? theirs : base);
      continue;
    }
    if (ours !== undefined && theirs !== undefined) {
      if (os === ts) merged.set(id, ours);
      else conflict();
      continue;
    }
    merged.set(id, (ours ?? theirs)!);
  }
  return merged;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function highestVersion(docs: Array<Record<string, unknown>>): unknown {
  const versions = docs.map((d) => d.version).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (versions.length > 0) return Math.max(...versions);
  return docs.map((d) => d.version).find((v) => v !== undefined);
}

/** Pure three-way merge of three parsed bibles. Throws MalformedBibleError on unusable input. */
export function mergeBibleDocuments(base: unknown, ours: unknown, theirs: unknown): BibleMergeResult {
  const sides: Array<[string, unknown]> = [['base', base], ['ours', ours], ['theirs', theirs]];
  for (const [name, doc] of sides) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new MalformedBibleError(`bible merge: ${name} is not a bible document (expected an object with an 'entries' array)`);
    }
  }
  const [bd, od, td] = [base, ours, theirs] as Array<Record<string, unknown>>;
  const conflicts: BibleMergeConflict[] = [];
  const be = indexById(listOf(bd, 'entries', 'base'), 'entries', 'base', conflicts);
  const oe = indexById(listOf(od, 'entries', 'ours'), 'entries', 'ours', conflicts);
  const te = indexById(listOf(td, 'entries', 'theirs'), 'entries', 'theirs', conflicts);
  const bt = indexById(listOf(bd, 'demotions', 'base'), 'demotions', 'base', conflicts);
  const ot = indexById(listOf(od, 'demotions', 'ours'), 'demotions', 'ours', conflicts);
  const tt = indexById(listOf(td, 'demotions', 'theirs'), 'demotions', 'theirs', conflicts);

  const entries = mergeEntries(be, oe, te, conflicts);
  const tombstones = mergeTombstones(bt, ot, tt, conflicts);

  // A tombstone wins over a same-id entry: no id ends in both lists.
  const dropped: string[] = [];
  for (const id of tombstones.keys()) {
    if (entries.delete(id)) dropped.push(id);
  }
  dropped.sort(compareIds);

  const summary: BibleMergeSummary = {
    mergedEntries: entries.size,
    mergedTombstones: tombstones.size,
    entriesDroppedForTombstone: dropped,
    genuineConflicts: conflicts.length,
  };
  if (conflicts.length > 0) return { merged: null, summary, conflicts };

  const provenance = od.provenance && typeof od.provenance === 'object' && !Array.isArray(od.provenance)
    ? { ...(od.provenance as Record<string, unknown>) }
    : {};
  delete provenance.commit;
  delete provenance.entry_count;

  const merged: BibleDoc = {
    ...od,
    version: highestVersion([od, td, bd]),
    provenance,
    entries: [...entries.keys()].sort(compareIds).map((id) => entries.get(id)!),
  };
  const sortedTombstones = [...tombstones.keys()].sort(compareIds).map((id) => tombstones.get(id)!);
  if (sortedTombstones.length > 0) merged.demotions = sortedTombstones;
  else delete merged.demotions;
  return { merged, summary, conflicts };
}

/** The exporter's byte form: 2-space JSON, every non-ASCII code unit escaped, one trailing newline. */
export function serializeBible(doc: unknown): string {
  const json = JSON.stringify(doc, null, 2);
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code > 127 ? '\\u' + code.toString(16).padStart(4, '0') : json.charAt(i);
  }
  return out + '\n';
}

/** One line per conflict, naming the list and id. */
export function formatBibleConflicts(conflicts: BibleMergeConflict[]): string {
  return conflicts.map((c) => (c.kind === 'duplicate-id'
    ? `  duplicate ${c.list === 'entries' ? 'entry' : 'tombstone'} id ${c.identity} in ${c.side} (indexes ${c.indexes.join(', ')})`
    : `  ${c.list === 'entries' ? 'entry' : 'tombstone'} ${c.identity} changed differently by both sides`)).join('\n');
}
