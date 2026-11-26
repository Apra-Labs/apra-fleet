#!/usr/bin/env node
/**
 * check-kb-bible-drift.mjs -- reports the knowledge-bible entries a branch
 * OWNS whose recorded file basis no longer matches the branch head.
 *
 * Every entry in .fleet/kb-canonical.json carries source_file_hashes: for each
 * cited file, the git blob id of that file when the entry was last verified.
 * kb_bible_commit admits an entry only while every hash equals the file at
 * HEAD, and a sprint re-checks its own entries after its last commit. A later
 * merge of the base branch INTO the branch can still change a cited file and
 * leave the entry with a drifted basis. This check finds those, locally:
 *
 *   - the branch bible is read as committed at HEAD, the base bible as
 *     committed at --base (default origin/main; a base with no bible is an
 *     empty bible);
 *   - the branch OWNS an entry when its id is absent from the base bible, or
 *     present there with different content. Entries identical to the base
 *     bible are never reported, re-stamped or dropped -- they are the base
 *     branch's to keep current;
 *   - each owned entry's cited files are hashed at HEAD exactly as
 *     kb_bible_commit hashes them (the git blob id of HEAD:<path>), and the
 *     entry is reported when any hash differs, the file is absent at HEAD, or
 *     the entry records no hash for it.
 *
 * Run from anywhere inside the repository:
 *   node scripts/check-kb-bible-drift.mjs [--base <ref>] [--bible <repo-relative path>]
 *   node scripts/check-kb-bible-drift.mjs [--base <ref>] --restamp <id>[,<id>...]
 *
 * Exit codes: 0 no owned entry drifted (or no bible at HEAD); 1 one or more
 * owned entries drifted (one line per entry, naming the id and each file);
 * 2 a usage or git error.
 *
 * Re-stamping after a base merge (docs/kb-bible-correctness.md): first
 * RE-VERIFY each reported entry's claim against the files at HEAD -- a hash is
 * only a record of what was checked. Then either
 *   (a) on the machine whose KB holds the entry, kb_promote it (re-stamps its
 *       basis at HEAD) and kb_bible_commit {ids: [<id>]} -- the preferred path,
 *       which also keeps that KB's basis in step; or
 *   (b) run this script with --restamp <id> for exactly the re-verified ids:
 *       it rewrites only their source_file_hashes in the work-tree bible to
 *       the blob ids at HEAD (exporter serialization, nothing else touched);
 *       review the diff and commit it.
 * An entry whose claim no longer holds is withdrawn instead (kb_bible_commit
 * withdrawals), never re-stamped. Re-run the check: it exits 0 once every
 * owned entry matches HEAD.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exporterSerialization } from './check-kb-canonical.mjs';

export const DEFAULT_BIBLE_PATH = '.fleet/kb-canonical.json';
export const DEFAULT_BASE = 'origin/main';

export class DriftCheckError extends Error {}

function git(cwd, args, input) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
        const stderr = err && err.stderr ? String(err.stderr).trim() : '';
        throw new DriftCheckError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
    }
}

function gitOk(cwd, args) {
    try {
        execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
        return true;
    } catch {
        return false;
    }
}

/** The repository's top level for `cwd`; throws outside a work tree. */
export function repoRoot(cwd) {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

/** The bible committed at `ref`, parsed; null when `ref` holds none. Throws on an unknown ref or bad JSON. */
export function readBibleAt(root, ref, biblePath = DEFAULT_BIBLE_PATH) {
    if (!gitOk(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) {
        throw new DriftCheckError(`ref ${JSON.stringify(ref)} does not name a commit (fetch it, or pass --base <ref>)`);
    }
    if (!gitOk(root, ['cat-file', '-e', `${ref}:${biblePath}`])) return null;
    const raw = git(root, ['show', `${ref}:${biblePath}`]);
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new DriftCheckError(`the bible at ${ref}:${biblePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function entriesOf(doc) {
    return doc && Array.isArray(doc.entries) ? doc.entries.filter((e) => e && typeof e === 'object' && typeof e.id === 'string') : [];
}

/** Stable comparison of two entries (key order ignored). */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** Entries of `head` the branch owns: absent from `base`, or present there with different content. */
export function ownedEntries(head, base) {
    const baseById = new Map(entriesOf(base).map((e) => [e.id, canonical(e)]));
    return entriesOf(head).filter((e) => baseById.get(e.id) !== canonical(e));
}

/**
 * Blob ids of `files` at HEAD, keyed by the given repo-relative path (null:
 * absent at HEAD, or not a repo-relative path) -- the hash kb_bible_commit
 * records and compares.
 */
export function headBlobIds(root, files) {
    const out = {};
    const queried = [];
    for (const f of files) {
        out[f] = null;
        if (typeof f !== 'string' || f.length === 0 || /[\r\n]/.test(f) || path.isAbsolute(f) || path.win32.isAbsolute(f)) continue;
        const rel = path.posix.normalize(f.replace(/\\/g, '/'));
        if (rel === '.' || rel === '..' || rel.startsWith('../')) continue;
        queried.push([f, rel]);
    }
    if (queried.length === 0) return out;
    const stdout = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], queried.map(([, rel]) => `HEAD:${rel}`).join('\n') + '\n');
    const lines = stdout.split('\n');
    queried.forEach(([f], i) => {
        const [oid, type] = (lines[i] || '').trim().split(' ');
        if (type === 'blob' && /^[0-9a-f]{40,64}$/.test(oid)) out[f] = oid;
    });
    return out;
}

/**
 * The owned entries whose basis differs from HEAD:
 * [{ id, title, files: [{ path, reason: 'changed'|'absent'|'no_basis', recorded, head }] }].
 */
export function findOwnedDrift(root, { base = DEFAULT_BASE, biblePath = DEFAULT_BIBLE_PATH } = {}) {
    const head = readBibleAt(root, 'HEAD', biblePath);
    if (!head) return { bible: false, owned: 0, drifted: [] };
    const baseDoc = readBibleAt(root, base, biblePath);
    const owned = ownedEntries(head, baseDoc);
    const cited = [...new Set(owned.flatMap((e) => (Array.isArray(e.source_files) ? e.source_files : [])))];
    const current = headBlobIds(root, cited);
    const drifted = [];
    for (const e of owned) {
        const basis = e.source_file_hashes && typeof e.source_file_hashes === 'object' ? e.source_file_hashes : {};
        const files = [];
        for (const f of Array.isArray(e.source_files) ? e.source_files : []) {
            const recorded = typeof basis[f] === 'string' ? basis[f] : null;
            const now = current[f] ?? null;
            if (now === null) files.push({ path: f, reason: 'absent', recorded, head: null });
            else if (recorded === null) files.push({ path: f, reason: 'no_basis', recorded, head: now });
            else if (recorded !== now) files.push({ path: f, reason: 'changed', recorded, head: now });
        }
        if (files.length > 0) drifted.push({ id: e.id, title: typeof e.title === 'string' ? e.title : '', files });
    }
    return { bible: true, owned: owned.length, drifted };
}

/**
 * Re-stamp the named owned, drifted entries in the work-tree bible: their
 * source_file_hashes become the blob ids at HEAD (keys sorted, as the writers
 * emit them). Starts from the bible committed at HEAD and refuses when the
 * work-tree file differs from it, so nothing uncommitted is overwritten.
 * Refuses an id that is not owned or not drifted, and one citing a file absent
 * at HEAD (that entry must be withdrawn, not re-stamped).
 * @returns {string[]} the re-stamped ids
 */
export function restampEntries(root, ids, { base = DEFAULT_BASE, biblePath = DEFAULT_BIBLE_PATH } = {}) {
    const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
    if (wanted.length === 0) throw new DriftCheckError('--restamp needs at least one entry id');
    const headRaw = git(root, ['show', `HEAD:${biblePath}`]);
    const file = path.join(root, biblePath);
    const workRaw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (workRaw !== headRaw) throw new DriftCheckError(`${biblePath} has uncommitted changes -- commit or discard them before re-stamping`);
    const { drifted } = findOwnedDrift(root, { base, biblePath });
    const byId = new Map(drifted.map((d) => [d.id, d]));
    for (const id of wanted) {
        const d = byId.get(id);
        if (!d) throw new DriftCheckError(`entry ${id} is not an owned entry with a drifted basis -- nothing to re-stamp`);
        const absent = d.files.filter((f) => f.reason === 'absent').map((f) => f.path);
        if (absent.length > 0) throw new DriftCheckError(`entry ${id} cites file(s) absent at HEAD (${absent.join(', ')}) -- withdraw it instead of re-stamping`);
    }
    const doc = JSON.parse(headRaw);
    for (const e of doc.entries) {
        if (!wanted.includes(e.id)) continue;
        const current = headBlobIds(root, e.source_files);
        const basis = {};
        for (const f of [...e.source_files].sort()) basis[f] = current[f];
        e.source_file_hashes = basis;
    }
    fs.writeFileSync(file, exporterSerialization(doc));
    return wanted;
}

export function formatDrift(base, drifted) {
    return [
        `KB BIBLE DRIFT: ${drifted.length} bible entr${drifted.length === 1 ? 'y' : 'ies'} this branch owns (vs ${base}) no longer match their cited files at HEAD:`,
        ...drifted.map((d) => `  ${d.id}${d.title ? ` "${d.title}"` : ''}: ${d.files.map((f) => `${f.path} (${f.reason})`).join(', ')}`),
        'Re-verify each claim at HEAD, then re-stamp it (kb_promote + kb_bible_commit on the KB that holds it, or',
        '  node scripts/check-kb-bible-drift.mjs --base ' + base + ' --restamp <id>[,<id>...] and commit the bible),',
        'or withdraw it if the claim no longer holds. See docs/kb-bible-correctness.md.',
    ].join('\n');
}

function parseArgs(argv) {
    const opts = { base: DEFAULT_BASE, biblePath: DEFAULT_BIBLE_PATH, restamp: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new DriftCheckError(`${a} needs a value`);
            return v;
        };
        if (a === '--base') opts.base = value();
        else if (a === '--bible') opts.biblePath = value();
        else if (a === '--restamp') opts.restamp = value().split(',').map((s) => s.trim()).filter(Boolean);
        else throw new DriftCheckError(`unknown argument ${JSON.stringify(a)} (usage: [--base <ref>] [--bible <path>] [--restamp <id>[,<id>...]])`);
    }
    return opts;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
    try {
        const opts = parseArgs(argv);
        const root = repoRoot(cwd);
        if (opts.restamp) {
            const done = restampEntries(root, opts.restamp, opts);
            console.log(`Re-stamped ${done.length} entr${done.length === 1 ? 'y' : 'ies'} in ${opts.biblePath} at HEAD: ${done.join(', ')}. Review the diff and commit it.`);
            return 0;
        }
        const { bible, owned, drifted } = findOwnedDrift(root, opts);
        if (!bible) {
            console.log(`OK: no bible at HEAD:${opts.biblePath}, nothing to check.`);
            return 0;
        }
        if (drifted.length > 0) {
            console.error(formatDrift(opts.base, drifted));
            return 1;
        }
        console.log(`OK: all ${owned} bible entr${owned === 1 ? 'y' : 'ies'} this branch owns (vs ${opts.base}) match their cited files at HEAD.`);
        return 0;
    } catch (err) {
        console.error(`KB BIBLE DRIFT CHECK ERROR: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
}
