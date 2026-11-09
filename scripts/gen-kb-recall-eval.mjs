#!/usr/bin/env node
// Builds the KB recall eval fixtures under tests/fixtures/kb-recall-eval/:
//   bible-snapshot.json  pinned copy of .fleet/kb-canonical.json
//   entry-content.json   real captured content for bible entries (from a KB db)
//   enrichment.json      per-entry content / recall_cues / error_signatures
//   extra-entries.json   the push+pr entry (a recorded operator memory)
//   queries.json         real queries + authored queries + the push+pr case
// Output is CHECKED IN; the eval test never regenerates it. Fails loudly on a
// missing/unknown label or an authored query over the leakage cap.
//
// Usage:
//   node scripts/gen-kb-recall-eval.mjs                 # reuse entry-content.json
//   node scripts/gen-kb-recall-eval.mjs --kb-db <kb.sqlite>
//   node scripts/gen-kb-recall-eval.mjs --keep-snapshot   # do not refresh bible-snapshot.json
//     refresh entry-content.json from a maintainer's per-repo KB database
//     (<data dir>/knowledge/<repo slug>/kb.sqlite): for every bible entry
//     whose stored content is longer than its summary, the content with the
//     trailing promotion audit note cut (as bible export cuts it).
//
// Sources, so nothing in the set is tuned to the queries:
//   - queries: REAL (scripts/kb-recall-queries-real.mjs, recorded kb_query
//     traffic, verbatim), AUTHORED (scripts/kb-recall-queries-authored.mjs,
//     one situation query per CONFIRMED entry), and the push+pr scope-error case.
//   - content: real captured content where a KB db has it, else the summary
//     (what bible import stores for an entry without content).
//   - recall_cues: derived mechanically from the entry's own symbols and source
//     file names (split into words), never from any query.
//   - error_signatures: verbatim error-looking strings found in the entry's
//     own title/summary/content (error codes, SQLITE_* codes, quoted messages).
import fs from 'node:fs';
import path from 'node:path';
import { AUTHORED } from './kb-recall-queries-authored.mjs';
import { REAL } from './kb-recall-queries-real.mjs';
import { leakage, LEAKAGE_CAP } from './kb-recall-leakage.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = process.env.APRA_KB_EVAL_FIXTURE_DIR
  ? path.resolve(process.env.APRA_KB_EVAL_FIXTURE_DIR) // test hook: write to a scratch copy
  : path.join(root, 'tests/fixtures/kb-recall-eval');
fs.mkdirSync(outDir, { recursive: true });

/** JSON with every non-ASCII char escaped (the repo is ASCII-only). */
function writeJson(file, value) {
  const text = JSON.stringify(value, null, 2).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  fs.writeFileSync(path.join(outDir, file), text + '\n');
}

// The eval reads this pinned snapshot, not the live bible; regenerating refreshes it.
// --keep-snapshot regenerates from the already-pinned snapshot without refreshing it.
if (!process.argv.includes('--keep-snapshot')) fs.copyFileSync(path.join(root, '.fleet/kb-canonical.json'), path.join(outDir, 'bible-snapshot.json'));
const bible = JSON.parse(fs.readFileSync(path.join(outDir, 'bible-snapshot.json'), 'utf-8'));
const byPrefix = new Map(bible.entries.map(e => [e.id.slice(0, 8), e]));

// ---- real content ---------------------------------------------------------
const CONTENT_MAX = 2000; // bible import's content cap
const AUDIT_NOTE = /\n*\[Promoted:[\s\S]*\]\s*$/;
const contentFile = path.join(outDir, 'entry-content.json');
const kbDbArg = process.argv.indexOf('--kb-db');
if (kbDbArg !== -1) {
  const dbPath = process.argv[kbDbArg + 1];
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`--kb-db: no such file ${dbPath}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const get = db.prepare('SELECT content, summary FROM entries WHERE id = ?');
  const content = {};
  for (const e of bible.entries) {
    const row = get.get(e.id);
    if (!row || typeof row.content !== 'string') continue;
    const c = row.content.replace(AUDIT_NOTE, '').trim();
    if (c.length > row.summary.length && c !== row.summary && c.length <= CONTENT_MAX) content[e.id] = c;
  }
  db.close();
  writeJson('entry-content.json', { source: 'maintainer per-repo KB database (captured content, promotion audit note cut)', content });
}
const realContent = fs.existsSync(contentFile) ? JSON.parse(fs.readFileSync(contentFile, 'utf-8')).content : {};

// ---- push+pr entry (the real KB runbook entry, exported from the KB) -------
// Carried in extra-entries.json until harvest commits it to the bible; once its
// id is in .fleet/kb-canonical.json it is NOT added again (no duplicate id).
const MISS_ENTRY_ID = '4f54d973-5627-49c3-903a-466695892a45';
const PUSH_PR_ENTRY = {
  id: MISS_ENTRY_ID,
  type: 'runbook',
  title: "gh 'Resource not accessible by integration' means re-mint provision_vcs_auth with git_access push+pr",
  summary: "When gh or git reports 'Resource not accessible by integration', the GitHub App token lacks the needed access. Re-mint with provision_vcs_auth using git_access push+pr (push alone cannot create PRs or dispatch workflows) and repos as full owner/repo names.",
  content: 'error_signature: "Resource not accessible by integration" (gh / GitHub API 403). Cause: the GitHub App installation token minted by provision_vcs_auth was granted too little access (e.g. git_access push or read). push cannot create PRs or dispatch workflows. Fix: re-run provision_vcs_auth (github-app) with git_access: "push+pr" and repos passed as full owner/repo names (e.g. Apra-Labs/apra-fleet). Members provisioned only by sprint preflight have no stored access level and may fail with deploy_failed until re-minted. Evidence: GIT_ACCESS_DESCRIPTION and git_access enum (read, push, push+pr, admin, issues, full) in src/tools/provision-vcs-auth.ts.',
  symbols: ['provisionVcsAuth'],
  source_files: ['src/tools/provision-vcs-auth.ts'],
  confidence: 'CONFIRMED',
  updated_at: '2026-11-09T16:39:19.026Z',
};
const extraEntries = bible.entries.some(e => e.id === MISS_ENTRY_ID) ? [] : [PUSH_PR_ENTRY];

// ---- derived recall_cues / error_signatures -------------------------------
/** "SqliteProvider.hybridRows" -> "sqlite provider hybrid rows"; "kb-index.ts" -> "kb index". */
function words(s) {
  return s.replace(/\.[a-z]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).filter(Boolean).join(' ').toLowerCase();
}
function recallCuesFor(e) {
  const cues = [];
  for (const s of e.symbols ?? []) cues.push(words(s));
  for (const f of e.source_files ?? []) cues.push(words(path.basename(f)));
  return [...new Set(cues.filter(c => c.includes(' ')))].slice(0, 8);
}
const SIG_PATTERNS = [
  /\bE-[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g, // fleet error codes
  /\bSQLITE_[A-Z]+\b/g,
  /\b(?:ENOENT|EACCES|EPERM|EADDRINUSE|ECONNREFUSED|ETIMEDOUT|EBUSY)\b/g,
  /"([A-Za-z][^"\n]{12,90})"/g, // quoted messages of a few words
];
function errorSignaturesFor(e, content) {
  const text = `${e.title}\n${e.summary}\n${content ?? ''}`;
  const out = [];
  for (const re of SIG_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const s = (m[1] ?? m[0]).trim();
      if (m[1] && s.split(/\s+/).length < 3) continue; // a quoted word is not a message
      out.push(s);
    }
  }
  return [...new Set(out)].slice(0, 6);
}
const enrichment = {};
for (const e of [...bible.entries, ...extraEntries]) {
  const content = realContent[e.id] ?? e.content;
  enrichment[e.id] = {
    ...(content ? { content } : {}),
    recall_cues: recallCuesFor(e),
    error_signatures: errorSignaturesFor(e, content),
  };
}

// ---- queries ---------------------------------------------------------------
const confirmed = bible.entries.filter(e => e.confidence === 'CONFIRMED');
const used = new Set();
const queries = [];
REAL.forEach((r, i) => {
  const expected = r.expected.map(k => {
    const e = byPrefix.get(k);
    if (!e) throw new Error(`real query "${r.query}" labels ${k}, which is not in the bible`);
    return e.id;
  });
  queries.push({
    id: `real-${String(i + 1).padStart(2, '0')}`,
    query: r.query,
    expected,
    source: 'real',
    provenance: `recorded kb_query, agent session ${r.session} at ${r.at}`,
  });
});
for (const e of confirmed) {
  // The push+pr entry has its own owner-notes query below; once harvest lands it in
  // the bible it must not also need an authored one.
  if (e.id === MISS_ENTRY_ID) continue;
  const key = e.id.slice(0, 8);
  const query = AUTHORED[key];
  if (!query) throw new Error(`no authored query for ${e.id} (${e.title})`);
  const l = leakage(query, e);
  if (l > LEAKAGE_CAP) throw new Error(`query for ${key} leaks (${l.toFixed(2)} > ${LEAKAGE_CAP}): ${query}`);
  used.add(key);
  queries.push({ id: `q-${key}`, query, expected: [e.id], source: 'authored', provenance: 'hand-authored situation query' });
}
for (const k of Object.keys(AUTHORED)) if (!used.has(k)) throw new Error(`authored query ${k} matches no CONFIRMED entry`);

queries.push({
  id: 'real-miss-resource-not-accessible',
  query: 'agent session on a member fails to open a change request after login provisioning: Resource not accessible by integration',
  // An error-text query: the eval passes this as the kb_query error_text input.
  error_text: 'Resource not accessible by integration',
  expected: [MISS_ENTRY_ID],
  source: 'owner-notes',
  provenance: 'owner-reported recall miss; the target is the real KB runbook entry on the push+pr access level',
});

writeJson('queries.json', { version: 3, queries });
writeJson('extra-entries.json', { entries: extraEntries });
writeJson('enrichment.json', { entries: enrichment });
const n = s => queries.filter(q => q.source === s).length;
console.log(`wrote ${queries.length} queries (real ${n('real')}, authored ${n('authored')}, owner-notes ${n('owner-notes')}); `
  + `${Object.keys(realContent).length} entries with real content`);
