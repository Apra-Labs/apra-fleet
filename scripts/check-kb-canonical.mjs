#!/usr/bin/env node
/**
 * check-kb-canonical.mjs -- rejects a malformed knowledge bible
 * (.fleet/kb-canonical.json).
 *
 * The bible is merged by plain git text merge, and a hand-resolved merge can
 * leave a file that still parses but is not what any writer produces (a broken
 * envelope, an id listed twice, an entry and its tombstone both present). The
 * readers tolerate much of that silently, so nothing else fails loudly. This
 * check does, naming the problem and the id. It validates exactly what the
 * writers (kb_export, kb_bible_commit) emit -- see memory-contract/v1/spec.md
 * section 2.8 and memory-contract/v1/bible/kb-canonical.schema.json:
 *
 *   - envelope: exactly the keys version, provenance, entries and (optional,
 *     never empty) demotions; version is the current format version (3)
 *   - provenance: branch (a string or null); the legacy keys commit and
 *     entry_count are accepted, and entry_count, when present, must equal the
 *     number of entries
 *   - entries: each an object with a non-empty string id, a known type and
 *     confidence, a non-empty title and summary; ids unique and sorted
 *   - demotions (tombstones): each {id, at, reason} with a known reason --
 *     "demoted" carries nothing else, "withdrawn" also carries a non-empty
 *     note and a non-empty evidence_files list of repo-relative paths;
 *     ids unique and sorted
 *   - no id is both an entry and a tombstone
 *   - the file is in the exporter's exact serialization: 2-space JSON, every
 *     non-ASCII character escaped, one trailing newline
 *
 * Run directly:
 *   node scripts/check-kb-canonical.mjs [path]   (default .fleet/kb-canonical.json)
 * Exit code 1 on any problem, printing one line per problem; 0 when valid or
 * when the file does not exist (a repo without a bible has nothing to check).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_BIBLE = path.join(REPO_ROOT, '.fleet', 'kb-canonical.json');

export const BIBLE_FORMAT_VERSION = 3;
const ENVELOPE_KEYS = ['version', 'provenance', 'entries', 'demotions'];
const REQUIRED_ENVELOPE_KEYS = ['version', 'provenance', 'entries'];
const PROVENANCE_KEYS = ['branch', 'commit', 'entry_count'];
const ENTRY_TYPES = ['context-cache', 'learning', 'knowledge', 'runbook', 'user-directive'];
const CONFIDENCE = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];
/** Known tombstone reasons and the keys each may carry (required, optional). */
export const TOMBSTONE_SHAPES = {
    demoted: { required: ['id', 'at', 'reason'], optional: [] },
    withdrawn: { required: ['id', 'at', 'reason', 'note', 'evidence_files'], optional: [] },
};

/** The exporter's serialization: 2-space JSON with every non-ASCII code unit escaped. */
export function exporterSerialization(value) {
    const json = JSON.stringify(value, null, 2);
    let out = '';
    for (let i = 0; i < json.length; i++) {
        const code = json.charCodeAt(i);
        out += code > 127 ? '\\u' + code.toString(16).padStart(4, '0') : json.charAt(i);
    }
    return out + '\n';
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
}

/** Relative, no '..' segment, no POSIX, drive-letter or UNC root. */
function isRepoRelativePath(p) {
    if (!isNonEmptyString(p)) return false;
    if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
    return !p.split(/[\\/]/).includes('..');
}

function describeId(id) {
    return typeof id === 'string' ? JSON.stringify(id) : '(no id)';
}

/**
 * Validate bible text. Returns a list of problems, each
 * {code, message, id?}; an empty list means the file is valid.
 */
export function validateBibleText(raw) {
    const problems = [];
    const add = (code, message, id) => problems.push(id === undefined ? { code, message } : { code, message, id });

    let doc;
    try {
        doc = JSON.parse(raw);
    } catch (err) {
        add('invalid-json', 'the file is not valid JSON: ' + (err instanceof Error ? err.message : String(err)));
        return problems;
    }
    if (!isPlainObject(doc)) {
        add('envelope', 'the file is not the bible envelope object {version, provenance, entries}');
        return problems;
    }

    // Envelope keys.
    for (const key of Object.keys(doc)) {
        if (!ENVELOPE_KEYS.includes(key)) add('envelope-key', 'unexpected top-level key ' + JSON.stringify(key) + ' (allowed: ' + ENVELOPE_KEYS.join(', ') + ')');
    }
    for (const key of REQUIRED_ENVELOPE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(doc, key)) add('envelope-key', 'missing top-level key ' + JSON.stringify(key));
    }
    if (Object.prototype.hasOwnProperty.call(doc, 'version') && doc.version !== BIBLE_FORMAT_VERSION) {
        add('version', 'version is ' + JSON.stringify(doc.version) + ', expected ' + BIBLE_FORMAT_VERSION);
    }

    const entries = Array.isArray(doc.entries) ? doc.entries : null;
    if (Object.prototype.hasOwnProperty.call(doc, 'entries') && entries === null) add('entries', 'entries is not an array');

    // Provenance.
    if (Object.prototype.hasOwnProperty.call(doc, 'provenance')) {
        const prov = doc.provenance;
        if (!isPlainObject(prov)) {
            add('provenance', 'provenance is not an object');
        } else {
            for (const key of Object.keys(prov)) {
                if (!PROVENANCE_KEYS.includes(key)) add('provenance-key', 'unexpected provenance key ' + JSON.stringify(key) + ' (allowed: ' + PROVENANCE_KEYS.join(', ') + ')');
            }
            if (!Object.prototype.hasOwnProperty.call(prov, 'branch')) add('provenance-key', 'provenance has no branch');
            else if (prov.branch !== null && !isNonEmptyString(prov.branch)) add('provenance', 'provenance.branch is not a non-empty string or null');
            if (Object.prototype.hasOwnProperty.call(prov, 'commit') && prov.commit !== null && !isNonEmptyString(prov.commit)) {
                add('provenance', 'provenance.commit is not a non-empty string or null');
            }
            if (Object.prototype.hasOwnProperty.call(prov, 'entry_count') && entries !== null && prov.entry_count !== entries.length) {
                add('entry-count', 'provenance.entry_count is ' + JSON.stringify(prov.entry_count) + ' but the file has ' + entries.length + ' entries');
            }
        }
    }

    // Entries.
    const entryIds = new Set();
    if (entries !== null) {
        let previous = null;
        entries.forEach((e, index) => {
            if (!isPlainObject(e)) { add('entry', 'entry #' + index + ' is not an object'); return; }
            const id = e.id;
            if (!isNonEmptyString(id)) { add('entry', 'entry #' + index + ' has no non-empty string id'); return; }
            if (entryIds.has(id)) add('duplicate-entry-id', 'entry id ' + describeId(id) + ' appears more than once', id);
            entryIds.add(id);
            if (previous !== null && !(previous < id)) add('entry-order', 'entry id ' + describeId(id) + ' is out of id order (follows ' + describeId(previous) + ')', id);
            previous = id;
            if (!ENTRY_TYPES.includes(e.type)) add('entry', 'entry ' + describeId(id) + ' has unknown type ' + JSON.stringify(e.type), id);
            if (!CONFIDENCE.includes(e.confidence)) add('entry', 'entry ' + describeId(id) + ' has unknown confidence ' + JSON.stringify(e.confidence), id);
            if (!isNonEmptyString(e.title)) add('entry', 'entry ' + describeId(id) + ' has no non-empty title', id);
            if (!isNonEmptyString(e.summary)) add('entry', 'entry ' + describeId(id) + ' has no non-empty summary', id);
        });
    }

    // Tombstones.
    if (Object.prototype.hasOwnProperty.call(doc, 'demotions')) {
        const demotions = doc.demotions;
        if (!Array.isArray(demotions)) {
            add('demotions', 'demotions is not an array');
        } else if (demotions.length === 0) {
            add('demotions', 'demotions is empty (writers omit the key when there are no tombstones)');
        } else {
            const tombIds = new Set();
            let previous = null;
            demotions.forEach((t, index) => {
                if (!isPlainObject(t)) { add('tombstone', 'tombstone #' + index + ' is not an object'); return; }
                const id = t.id;
                if (!isNonEmptyString(id)) { add('tombstone', 'tombstone #' + index + ' has no non-empty string id'); return; }
                if (tombIds.has(id)) add('duplicate-tombstone-id', 'tombstone id ' + describeId(id) + ' appears more than once', id);
                tombIds.add(id);
                if (previous !== null && !(previous < id)) add('tombstone-order', 'tombstone id ' + describeId(id) + ' is out of id order (follows ' + describeId(previous) + ')', id);
                previous = id;
                if (entryIds.has(id)) add('entry-and-tombstone', 'id ' + describeId(id) + ' is both an entry and a tombstone', id);
                if (!isNonEmptyString(t.at) || Number.isNaN(Date.parse(t.at))) add('tombstone', 'tombstone ' + describeId(id) + ' has no valid "at" timestamp', id);
                const shape = Object.prototype.hasOwnProperty.call(TOMBSTONE_SHAPES, t.reason) ? TOMBSTONE_SHAPES[t.reason] : null;
                if (shape === null) {
                    add('tombstone-reason', 'tombstone ' + describeId(id) + ' has unknown reason ' + JSON.stringify(t.reason) + ' (known: ' + Object.keys(TOMBSTONE_SHAPES).join(', ') + ')', id);
                    return;
                }
                const allowed = [...shape.required, ...shape.optional];
                for (const key of Object.keys(t)) {
                    if (!allowed.includes(key)) add('tombstone-shape', 'tombstone ' + describeId(id) + ' (reason ' + t.reason + ') has unexpected key ' + JSON.stringify(key), id);
                }
                for (const key of shape.required) {
                    if (!Object.prototype.hasOwnProperty.call(t, key)) add('tombstone-shape', 'tombstone ' + describeId(id) + ' (reason ' + t.reason + ') is missing ' + JSON.stringify(key), id);
                }
                if (Object.prototype.hasOwnProperty.call(t, 'note') && !isNonEmptyString(t.note)) {
                    add('tombstone-shape', 'tombstone ' + describeId(id) + ' has an empty or non-string note', id);
                }
                if (Object.prototype.hasOwnProperty.call(t, 'evidence_files')
                    && (!Array.isArray(t.evidence_files) || t.evidence_files.length === 0 || !t.evidence_files.every(isRepoRelativePath))) {
                    add('tombstone-shape', 'tombstone ' + describeId(id) + ' evidence_files is not a non-empty list of repo-relative paths', id);
                }
            });
        }
    }

    // Exporter serialization. Only meaningful once the content itself is sound,
    // and reported once: it names the first differing line.
    const expected = exporterSerialization(doc);
    if (raw !== expected) {
        const got = raw.split('\n');
        const want = expected.split('\n');
        let line = 0;
        while (line < got.length && line < want.length && got[line] === want[line]) line++;
        add('format', 'the file is not in exporter format (2-space JSON, non-ASCII escaped, one trailing newline); first difference at line ' + (line + 1));
    }
    return problems;
}

/** Validate a bible file. A missing file is valid (nothing to check). */
export function checkBibleFile(file = DEFAULT_BIBLE) {
    if (!fs.existsSync(file)) return { file, exists: false, problems: [] };
    let raw = fs.readFileSync(file, 'utf8');
    const problems = [];
    if (raw.charCodeAt(0) === 0xfeff) {
        problems.push({ code: 'format', message: 'the file starts with a byte order mark' });
        raw = raw.slice(1);
    }
    problems.push(...validateBibleText(raw));
    return { file, exists: true, problems };
}

export function formatProblems(file, problems) {
    return [
        'KB BIBLE CHECK: ' + problems.length + ' problem(s) in ' + file + ':',
        ...problems.map(p => '  [' + p.code + '] ' + p.message),
        'Fix the file (re-run the writer, or merge with the id-keyed bible merge tool) rather than hand-editing it.',
    ].join('\n');
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const file = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_BIBLE;
    const { exists, problems } = checkBibleFile(file);
    if (!exists) {
        console.log('OK: no bible at ' + file + ', nothing to check.');
    } else if (problems.length > 0) {
        console.error(formatProblems(file, problems));
        process.exit(1);
    } else {
        console.log('OK: ' + file + ' is a well-formed bible.');
    }
}
