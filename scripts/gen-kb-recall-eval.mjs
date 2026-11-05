#!/usr/bin/env node
// Builds tests/fixtures/kb-recall-eval/{queries,extra-entries}.json from the
// HAND-AUTHORED situation queries in kb-recall-queries-authored.mjs (one per
// CONFIRMED bible entry, keyed by 8-char id prefix) plus the real-miss case.
// Output is CHECKED IN; the eval test never regenerates it. The script fails
// loudly on a missing/unknown label or a query over the leakage cap.
// Usage: node scripts/gen-kb-recall-eval.mjs
import fs from 'node:fs';
import path from 'node:path';
import { AUTHORED } from './kb-recall-queries-authored.mjs';
import { leakage, LEAKAGE_CAP } from './kb-recall-leakage.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bible = JSON.parse(fs.readFileSync(path.join(root, '.fleet/kb-canonical.json'), 'utf-8'));
const outDir = path.join(root, 'tests/fixtures/kb-recall-eval');

const confirmed = bible.entries.filter(e => e.confidence === 'CONFIRMED');
const used = new Set();
const queries = confirmed.map(e => {
  const key = e.id.slice(0, 8);
  const query = AUTHORED[key];
  if (!query) throw new Error(`no authored query for ${e.id} (${e.title})`);
  const l = leakage(query, e);
  if (l > LEAKAGE_CAP) throw new Error(`query for ${key} leaks (${l.toFixed(2)} > ${LEAKAGE_CAP}): ${query}`);
  used.add(key);
  return { id: `q-${key}`, query, expected: [e.id], source: 'authored' };
});
for (const k of Object.keys(AUTHORED)) if (!used.has(k)) throw new Error(`authored query ${k} matches no CONFIRMED entry`);

const MISS_ENTRY_ID = 'eval-fixture-vcs-scope-push-pr';
queries.push({
  id: 'real-miss-resource-not-accessible',
  query: 'agent session on a member fails to open a change request after login provisioning: Resource not accessible by integration',
  // An error-text query: the eval passes this as the kb_query error_text input.
  error_text: 'Resource not accessible by integration',
  expected: [MISS_ENTRY_ID],
  source: 'owner-notes',
});

const extraEntries = [{
  id: MISS_ENTRY_ID,
  type: 'learning',
  title: 'Mint VCS auth with push+pr access to create pull requests',
  summary: 'A GitHub "Resource not accessible by integration" error on gh pr create means the token was minted with push access only; re-mint it with git_access push+pr.',
  symbols: ['provisionVcsAuth'],
  source_files: ['src/tools/provision-vcs-auth.ts'],
  // The error this entry explains: what kb_query error_text matches against.
  error_signatures: ['Resource not accessible by integration'],
  confidence: 'CONFIRMED',
  updated_at: '2026-11-05T00:00:00.000Z',
}];

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'queries.json'), JSON.stringify({ version: 2, queries }, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'extra-entries.json'), JSON.stringify({ entries: extraEntries }, null, 2) + '\n');
console.log(`wrote ${queries.length} queries`);
