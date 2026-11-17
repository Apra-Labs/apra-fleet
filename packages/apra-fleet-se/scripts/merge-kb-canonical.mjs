#!/usr/bin/env node
/**
 * merge-kb-canonical.mjs -- an id-keyed three-way merge for the knowledge
 * bank's exported canonical file (`.fleet/kb-canonical.json`, the "bible").
 *
 * WHY THIS EXISTS
 * ---------------
 * Every branch whose sprint harvests knowledge rewrites the whole canonical
 * export. When such a branch rebases onto a base branch that ALSO absorbed a
 * harvest since the branch was cut, git's line-based merge has nothing useful
 * to say about the result: the two exports differ in thousands of lines, so
 * the "resolution" degenerates into a blind whole-file `--ours` / `--theirs`
 * pick that silently throws away every entry the losing side harvested.
 *
 * This module does the merge at the level the file actually has semantics:
 * the `entries` array, keyed by entry identity, with a real three-way
 * (base/ours/theirs) comparison per entry.
 *
 * IDENTITY IS THE ENTRY `id` -- AND NOTHING ELSE
 * ----------------------------------------------
 * An entry is matched across base/ours/theirs by its `id`, a non-empty
 * string, and by nothing else: there is no title key and no title fallback.
 *
 * An earlier version keyed on the trimmed title, citing a measurement in
 * which re-exports re-minted ids (76.5% id survival vs 99.0% title survival).
 * That measurement predates kb_import preserving bible ids (preferredId in
 * src/services/knowledge/bible-import.ts) and the v3 bible: an entry now
 * keeps its id across export, import and re-export, so the id IS the stable
 * identity of a finding. Title matching was itself the defect: a title edit
 * on the same id merged as delete+add, leaving a stale and a corrected copy
 * side by side under duplicate ids. Under id identity a title change is an
 * ordinary content change of that entry (`title` is a content field).
 *
 * MERGE RULES (per id)
 * --------------------
 *   present in base, missing from EITHER side  -> deleted (a deletion is a
 *       deliberate act; never resurrect it from the side that still has it)
 *   present in all three, nobody changed it    -> keep base
 *   changed by exactly one side                -> take the changed version
 *   changed by both sides, to the SAME content -> take it (not a conflict)
 *   changed by both sides, differently         -> GENUINE CONFLICT: reported,
 *       never silently resolved; the CLI exits non-zero
 *   added by one side only                     -> keep it
 *   added by both sides under the same id      -> de-duplicate, keep one
 *
 * "Content" is CONTENT_FIELDS, which includes `title` and the v3
 * `source_file_hashes` basis: a re-verified basis on one side is a change
 * and is taken, never silently dropped. A merged entry is the whole entry of
 * the side whose content was taken, so it carries that side's hashes.
 *
 * MALFORMED AND DUPLICATE INPUT
 * -----------------------------
 *   an entry without a usable id (non-empty string) -> malformed input: the
 *       CLI exits 2 naming the side and entry index (never title-matched)
 *   two entries sharing an id in one input, or in the merged result ->
 *       reported as a genuine conflict (exit 1); such a document is never
 *       written
 * The merged envelope keeps the highest input `version` (a v3 input yields
 * a v3 output).
 *
 * USAGE
 * -----
 *   node merge-kb-canonical.mjs <base> <ours> <theirs> [options]
 *
 * Each of the three positionals is a file path, or a git ref whose copy of
 * the canonical file should be read (`--refs` forces the git-ref reading;
 * otherwise an argument that names an existing file is read as a file and
 * anything else is resolved as a git ref).
 *
 *   --refs                read all three positionals as git refs
 *   --repo <dir>          repository root for git-ref reading (default: cwd)
 *   --path <relpath>      path of the file inside the repo, for git-ref
 *                         reading (default: .fleet/kb-canonical.json)
 *   --out <file>          write the merged document here
 *                         (default: write it to stdout)
 *   -h, --help            this text
 *
 * The plain-text summary always goes to stderr, so stdout stays a clean,
 * pipeable document. Exit codes: 0 merged cleanly, 1 genuine conflicts
 * (including duplicate ids) need a human (the merged document is NOT
 * written), 2 usage/IO error or malformed input.
 *
 * Programmatic use: import { mergeKbCanonical } and hand it three parsed
 * documents. It is pure -- no filesystem, no git, no process exit -- so it
 * can be embedded in a conflict-resolution flow later.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Default location of the canonical export inside a repository. */
export const DEFAULT_CANONICAL_PATH = '.fleet/kb-canonical.json';

/**
 * Content fields compared to decide whether a side CHANGED an entry.
 * `id` is the identity, not content. `updated_at` is excluded: a re-export
 * timestamp that changes on every harvest and would make every entry look
 * "changed by both sides", i.e. an all-conflicts merge. `title` is content
 * (a title edit is a change), and so is the v3 `source_file_hashes` basis.
 */
export const CONTENT_FIELDS = ['type', 'title', 'summary', 'symbols', 'source_files', 'source_file_hashes', 'confidence'];

/** Thrown for an input the merge cannot interpret (e.g. an entry without an id). */
export class MalformedInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MalformedInputError';
    }
}

/**
 * Identity of an entry: its id, when it is a non-empty string; otherwise
 * null (a malformed entry -- see assertUsableIds). Never the title.
 */
export function entryIdentity(entry) {
    const id = entry?.id;
    return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/** JSON value with object keys sorted, so key order never reads as a change. */
function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
        return out;
    }
    return value;
}

/**
 * Stable content signature over CONTENT_FIELDS in a fixed order. Array order
 * is meaningful and kept; object keys (source_file_hashes) are sorted.
 */
export function contentSignature(entry) {
    return JSON.stringify(CONTENT_FIELDS.map((f) => canonicalValue(entry?.[f] ?? null)));
}

/** Throw MalformedInputError naming the side and index of an entry without a usable id. */
function assertUsableIds(doc, sideName) {
    doc.entries.forEach((entry, index) => {
        if (entryIdentity(entry) === null) {
            const title = typeof entry?.title === 'string' ? ` (title ${JSON.stringify(entry.title)})` : '';
            throw new MalformedInputError(
                `merge-kb-canonical: ${sideName} entry #${index}${title} has no usable id (a non-empty string is required; entries are never matched by title)`,
            );
        }
    });
}

/** Index a document's entries by id; ids seen more than once are reported, not merged. */
function indexById(doc, sideName) {
    const map = new Map();
    const positions = new Map();
    doc.entries.forEach((entry, index) => {
        const key = entryIdentity(entry);
        if (!positions.has(key)) positions.set(key, []);
        positions.get(key).push(index);
        if (!map.has(key)) map.set(key, entry);
    });
    const duplicates = [];
    for (const [key, indexes] of positions) {
        if (indexes.length > 1) duplicates.push({ kind: 'duplicate-id', identity: key, side: sideName, indexes });
    }
    return { map, duplicates };
}

/** Highest numeric `version` among the inputs (a v3 input yields a v3 output). */
function highestVersion(docs) {
    const versions = docs.map((d) => d.version).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (versions.length > 0) return Math.max(...versions);
    return docs.map((d) => d.version).find((v) => v !== undefined);
}

/**
 * Id-keyed three-way merge of three parsed canonical documents.
 *
 * @param {object} base   common-ancestor document
 * @param {object} ours   the local side
 * @param {object} theirs the incoming side
 * @returns {{merged: object|null, summary: object, conflicts: Array, duplicates: Array}}
 *   `merged` is null when `conflicts` is non-empty (content conflicts and
 *   duplicate ids alike): a conflicted merge has no single correct answer,
 *   and returning a half-resolved document invites a caller to write it out
 *   anyway. Throws MalformedInputError for an entry without a usable id.
 */
export function mergeKbCanonical(base, ours, theirs) {
    for (const [name, doc] of [['base', base], ['ours', ours], ['theirs', theirs]]) {
        if (!doc || typeof doc !== 'object' || !Array.isArray(doc.entries)) {
            throw new MalformedInputError(`merge-kb-canonical: ${name} is not a canonical document (expected an object with an 'entries' array)`);
        }
        assertUsableIds(doc, name);
    }

    const b = indexById(base, 'base');
    const o = indexById(ours, 'ours');
    const t = indexById(theirs, 'theirs');
    const duplicates = [...b.duplicates, ...o.duplicates, ...t.duplicates];

    const summary = {
        baseEntries: base.entries.length,
        oursEntries: ours.entries.length,
        theirsEntries: theirs.entries.length,
        keptUnchanged: 0,
        changedByOurs: 0,
        changedByTheirs: 0,
        changedByBothIdentically: 0,
        addedByOurs: 0,
        addedByTheirs: 0,
        addedByBothDeduplicated: 0,
        removedByOurs: 0,
        removedByTheirs: 0,
        removedByBoth: 0,
        duplicateIds: duplicates.length,
        genuineConflicts: 0,
        mergedEntries: 0,
    };
    const conflicts = [...duplicates];
    const merged = new Map();

    // Pass 1: everything the base knew about. Base order is preserved so the
    // merged document stays diff-friendly against both sides.
    for (const [key, baseEntry] of b.map) {
        const inOurs = o.map.has(key);
        const inTheirs = t.map.has(key);
        if (!inOurs && !inTheirs) {
            summary.removedByOurs += 1;
            summary.removedByTheirs += 1;
            summary.removedByBoth += 1;
            continue;
        }
        // A deletion by EITHER side is honoured. Resurrecting the entry from
        // the side that still has it would quietly undo a deliberate removal.
        if (!inOurs) { summary.removedByOurs += 1; continue; }
        if (!inTheirs) { summary.removedByTheirs += 1; continue; }

        const oursEntry = o.map.get(key);
        const theirsEntry = t.map.get(key);
        const baseSig = contentSignature(baseEntry);
        const oursSig = contentSignature(oursEntry);
        const theirsSig = contentSignature(theirsEntry);
        const oursChanged = oursSig !== baseSig;
        const theirsChanged = theirsSig !== baseSig;

        if (oursChanged && theirsChanged) {
            if (oursSig === theirsSig) {
                summary.changedByBothIdentically += 1;
                merged.set(key, oursEntry);
                continue;
            }
            conflicts.push({ kind: 'content', identity: key, base: baseEntry, ours: oursEntry, theirs: theirsEntry });
            continue;
        }
        if (oursChanged) { summary.changedByOurs += 1; merged.set(key, oursEntry); continue; }
        if (theirsChanged) { summary.changedByTheirs += 1; merged.set(key, theirsEntry); continue; }
        summary.keptUnchanged += 1;
        merged.set(key, baseEntry);
    }

    // Pass 2: additions. Ours first, then theirs; an id added by both sides
    // is de-duplicated (ours wins the slot). A both-sides addition whose
    // content differs is NOT a conflict -- there is no common ancestor to
    // arbitrate against.
    for (const [key, entry] of o.map) {
        if (b.map.has(key) || merged.has(key)) continue;
        summary.addedByOurs += 1;
        if (t.map.has(key)) summary.addedByBothDeduplicated += 1;
        merged.set(key, entry);
    }
    for (const [key, entry] of t.map) {
        if (b.map.has(key) || merged.has(key)) continue;
        summary.addedByTheirs += 1;
        merged.set(key, entry);
    }

    const entries = [...merged.values()];
    // Duplicate-id guard on the output itself: never hand back a document in
    // which two entries share an id, whatever produced it.
    const out = indexById({ entries }, 'merged');
    conflicts.push(...out.duplicates);

    summary.mergedEntries = merged.size;
    summary.genuineConflicts = conflicts.length;

    if (conflicts.length > 0) {
        return { merged: null, summary, conflicts, duplicates };
    }

    const mergedDoc = {
        ...ours,
        version: highestVersion([ours, theirs, base]),
        provenance: { ...(ours.provenance ?? {}), entry_count: entries.length },
        entries,
    };
    return { merged: mergedDoc, summary, conflicts, duplicates };
}

/** Plain-text summary block, one count per line. */
export function formatSummary(summary) {
    const rows = [
        ['base entries', summary.baseEntries],
        ['ours entries', summary.oursEntries],
        ['theirs entries', summary.theirsEntries],
        ['kept unchanged', summary.keptUnchanged],
        ['changed by ours', summary.changedByOurs],
        ['changed by theirs', summary.changedByTheirs],
        ['changed by both, identically', summary.changedByBothIdentically],
        ['added by ours', summary.addedByOurs],
        ['added by theirs', summary.addedByTheirs],
        ['added by both (de-duplicated)', summary.addedByBothDeduplicated],
        ['removed by ours', summary.removedByOurs],
        ['removed by theirs', summary.removedByTheirs],
        ['removed by both', summary.removedByBoth],
        ['duplicate ids', summary.duplicateIds],
        ['genuine conflicts', summary.genuineConflicts],
        ['merged entries', summary.mergedEntries],
    ];
    const width = Math.max(...rows.map(([label]) => label.length));
    const lines = ['Three-way merge summary (identity key: entry id):'];
    for (const [label, value] of rows) lines.push(`  ${label.padEnd(width)} : ${value}`);
    return lines.join('\n');
}

/**
 * Human-readable report of the entries a human has to arbitrate. Printed
 * instead of a merged document, so nobody can mistake a conflicted run for
 * a successful one.
 */
export function formatConflicts(conflicts) {
    const lines = [
        `${conflicts.length} genuine conflict(s): an id changed differently by both sides, or an id shared by two entries.`,
        'Nothing was merged. Resolve these by hand (edit one side to agree, pick the correct',
        'content, or give one of the duplicate entries its own id) and re-run.',
        '',
    ];
    for (const c of conflicts) {
        if (c.kind === 'duplicate-id') {
            lines.push(`--- duplicate id ${c.identity}: ${c.side} has ${c.indexes.length} entries with this id (indexes ${c.indexes.join(', ')})`);
            lines.push('');
            continue;
        }
        lines.push(`--- ${c.identity}`);
        for (const side of ['base', 'ours', 'theirs']) {
            lines.push(`    ${side}:`);
            for (const field of CONTENT_FIELDS) {
                const value = c[side]?.[field];
                if (value === undefined) continue;
                lines.push(`      ${field}: ${JSON.stringify(value)}`);
            }
        }
        lines.push('');
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Source loading (file path or git ref) and CLI
// ---------------------------------------------------------------------------

/** Read one side from a file path. */
export function readDocumentFromFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Read one side from `<ref>:<relPath>` inside a repository. */
export function readDocumentFromRef(ref, { repo = process.cwd(), relPath = DEFAULT_CANONICAL_PATH } = {}) {
    const text = execFileSync('git', ['show', `${ref}:${relPath}`], {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(text);
}

/**
 * Resolve one positional argument. With `forceRefs`, always a git ref;
 * otherwise a name that exists on disk is a file and anything else is a ref.
 */
export function readSide(arg, { forceRefs = false, repo = process.cwd(), relPath = DEFAULT_CANONICAL_PATH } = {}) {
    if (!forceRefs && fs.existsSync(arg) && fs.statSync(arg).isFile()) {
        return readDocumentFromFile(arg);
    }
    return readDocumentFromRef(arg, { repo, relPath });
}

/** Serialize a merged document the way the exporter writes it. */
export function serializeDocument(doc) {
    return `${JSON.stringify(doc, null, 2)}\n`;
}

export function parseArgs(argv) {
    const opts = { positional: [], refs: false, repo: process.cwd(), relPath: DEFAULT_CANONICAL_PATH, out: null, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { opts.help = true; continue; }
        if (a === '--refs') { opts.refs = true; continue; }
        if (a === '--repo') { opts.repo = argv[++i]; continue; }
        if (a === '--path') { opts.relPath = argv[++i]; continue; }
        if (a === '--out' || a === '-o') { opts.out = argv[++i]; continue; }
        if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
        opts.positional.push(a);
    }
    return opts;
}

const USAGE = [
    'Usage: node merge-kb-canonical.mjs <base> <ours> <theirs> [options]',
    '',
    '  Three-way merges the knowledge-bank canonical export. Each positional is a',
    '  file path, or a git ref to read the file from.',
    '',
    '  --refs            read all three positionals as git refs',
    '  --repo <dir>      repository root for git-ref reading (default: cwd)',
    `  --path <relpath>  file path inside the repo (default: ${DEFAULT_CANONICAL_PATH})`,
    '  --out <file>      write the merged document here (default: stdout)',
    '  -h, --help        show this help',
    '',
    '  Entries are matched by id only. Exit 0 merged cleanly, 1 genuine conflicts or',
    '  duplicate ids (nothing written), 2 usage/IO error or an entry without an id.',
].join('\n');

export function main(argv = process.argv.slice(2)) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(err.message);
        console.error(USAGE);
        return 2;
    }
    if (opts.help) { console.log(USAGE); return 0; }
    if (opts.positional.length !== 3) {
        console.error(`expected 3 positional arguments (base, ours, theirs), got ${opts.positional.length}`);
        console.error(USAGE);
        return 2;
    }

    let docs;
    try {
        docs = opts.positional.map((arg) => readSide(arg, { forceRefs: opts.refs, repo: opts.repo, relPath: opts.relPath }));
    } catch (err) {
        console.error(`could not read a side: ${err.message}`);
        return 2;
    }

    let result;
    try {
        result = mergeKbCanonical(docs[0], docs[1], docs[2]);
    } catch (err) {
        console.error(err.message);
        return 2;
    }

    console.error(formatSummary(result.summary));
    if (result.conflicts.length > 0) {
        console.error('');
        console.error(formatConflicts(result.conflicts));
        return 1;
    }

    const text = serializeDocument(result.merged);
    if (opts.out) {
        fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
        fs.writeFileSync(opts.out, text);
        console.error(`\nWrote ${result.summary.mergedEntries} merged entries to ${opts.out}`);
    } else {
        process.stdout.write(text);
    }
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main());
}
