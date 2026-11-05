#!/usr/bin/env node
// Generates tests/fixtures/kb-recall-eval/queries.json: one situation-phrased
// query per CONFIRMED bible entry (labelled with its id), plus the hand-written
// real-miss case. Output is CHECKED IN; the eval test never regenerates it.
// Usage: node scripts/gen-kb-recall-eval.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bible = JSON.parse(fs.readFileSync(path.join(root, '.fleet/kb-canonical.json'), 'utf-8'));
const outDir = path.join(root, 'tests/fixtures/kb-recall-eval');
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'is', 'are', 'for', 'with', 'by', 'it', 'its', 'that', 'this', 'as', 'at', 'be', 'from', 'not', 'no', 'but', 'so', 'if', 'then']);
const words = s => (s.match(/[A-Za-z0-9_.\/-]+/g) ?? []);

// Prefer recall_cues when an entry has them; otherwise phrase a situation from
// the summary's words that the title does NOT already contain, so the query is
// not a trivial copy of the title.
function situation(e) {
  if (Array.isArray(e.recall_cues) && e.recall_cues.length > 0) return `Working on a task where ${e.recall_cues[0]}`;
  const titleWords = new Set(words(e.title).map(w => w.toLowerCase()));
  const picked = words(e.summary.split(/(?<=[.;])\s/)[0])
    .filter(w => !STOP.has(w.toLowerCase()) && !titleWords.has(w.toLowerCase()))
    .slice(0, 12);
  return `I am about to change code and need to know about: ${picked.join(' ')}`;
}

const queries = bible.entries
  .filter(e => e.confidence === 'CONFIRMED')
  .map(e => ({ id: `gen-${e.id.slice(0, 8)}`, query: situation(e), expected: [e.id], source: 'generated' }));

const MISS_ENTRY_ID = 'eval-fixture-vcs-scope-push-pr';
queries.push({
  id: 'real-miss-resource-not-accessible',
  query: 'gh says Resource not accessible by integration when opening a pull request',
  expected: [MISS_ENTRY_ID],
  source: 'owner-notes',
});

const extraEntries = [{
  id: MISS_ENTRY_ID,
  type: 'learning',
  title: 'Mint VCS auth with push+pr access to create pull requests',
  summary: 'A GitHub "Resource not accessible by integration" error on gh pr create means the token was minted with push access only; re-mint it with git_access push+pr.',
  symbols: [],
  source_files: [],
  confidence: 'CONFIRMED',
  updated_at: '2026-11-05T00:00:00.000Z',
}];

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'queries.json'), JSON.stringify({ version: 1, queries }, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'extra-entries.json'), JSON.stringify({ entries: extraEntries }, null, 2) + '\n');
console.log(`wrote ${queries.length} queries`);
