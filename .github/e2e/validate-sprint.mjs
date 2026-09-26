#!/usr/bin/env node
// Post-sprint validation gates for fleet e2e.
//
// Mirrors the gates from packages/apra-fleet-se/apra-pm/e2e/validate-sprint.mjs:
//   1. pr-exists           a PR was raised for the branch
//   2. commits>=N          the work landed as N+ commits (not one dump)
//   3. final-changeset-clean  the PR's net diff carries NO process scaffolding
//   4. process-discipline  scaffolding files DID appear in intermediate commits
//   5. beads-closed        P1 issues picked for the sprint were closed
//
// evaluateGates() is pure so it is unit-testable without git.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCAFFOLD = ['requirements.md', 'plan.md', 'feedback.md', 'progress.json'];
const baseName = (p) => p.split('/').pop().toLowerCase();

// ---- pure verdict logic -------------------------------------------------------

export function evaluateGates(d) {
  const gates = [];
  const add = (name, pass, detail = '') => gates.push({ name, pass, detail });

  add('pr-exists', !!(d.pr && d.pr.url), d.pr ? `#${d.pr.number}` : 'no PR found');

  const minCommits = d.minCommits ?? 10;
  add(`commits>=${minCommits}`, (d.commitCount || 0) >= minCommits, `${d.commitCount || 0} commits`);

  const finalBases = (d.finalFiles || []).map(baseName);
  const leaked = SCAFFOLD.filter((f) => finalBases.includes(f));
  add('final-changeset-clean', leaked.length === 0,
    leaked.length ? `process files still in net diff: ${leaked.join(', ')}` : 'no process files in net diff');

  const touched = new Set((d.touchedBasenames || []).map((s) => s.toLowerCase()));
  const missing = SCAFFOLD.filter((f) => !touched.has(f));
  add('process-discipline', missing.length === 0,
    missing.length ? `never committed (no discipline proof): ${missing.join(', ')}` : 'all process files appeared in intermediate commits');

  const expected = d.expectedIssues ?? 3;
  const closed = d.closedP1 || [];
  add('beads-closed', closed.length >= expected,
    `${closed.length} of the picked P1 issue(s) closed${closed.length ? ': ' + closed.join(', ') : ''}`);

  return { gates, pass: gates.every((g) => g.pass) };
}

// ---- fact gathering -----------------------------------------------------------

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

const isP1 = (o) => o && (o.priority === 1 || o.priority === '1' || String(o.priority).toUpperCase() === 'P1');
const isClosed = (o) => o && String(o.status).toLowerCase() === 'closed';

function parseBeadsJsonl(text, map) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o.id) map.set(o.id, o); } catch { /* skip */ }
  }
  return map;
}

function readBeadsRef(repo, ref) {
  const map = new Map();
  let names = (git(repo, ['ls-tree', '--name-only', `${ref}:.beads`]).stdout || '')
    .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.jsonl'));
  if (!names.length) names = ['issues.jsonl'];
  for (const n of names) parseBeadsJsonl(git(repo, ['show', `${ref}:.beads/${n}`]).stdout || '', map);
  return map;
}

function readBeadsDisk(repo) {
  const map = new Map();
  const dir = join(repo, '.beads');
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return map; }
  if (!names.length) names = ['issues.jsonl'];
  for (const n of names) {
    try { parseBeadsJsonl(readFileSync(join(dir, n), 'utf-8'), map); } catch { /* skip */ }
  }
  return map;
}

function bdSaysClosed(repo, id) {
  const r = spawnSync('bd', ['show', id, '--json'], { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout) return false;
  try {
    const parsed = JSON.parse(r.stdout);
    const o = Array.isArray(parsed) ? parsed[0] : parsed;
    const st = o?.status ?? o?.issue?.status;
    return String(st).toLowerCase() === 'closed';
  } catch { return false; }
}

export function validateSprint({ repo, branch, pr, minCommits = 10, expectedIssues = 3 }) {
  git(repo, ['fetch', '-q', 'origin', 'main']);
  git(repo, ['fetch', '-q', 'origin', branch]);
  const head = (git(repo, ['rev-parse', 'FETCH_HEAD']).stdout || '').trim();
  const base = (git(repo, ['rev-parse', 'origin/main']).stdout || '').trim();

  if (!head || !base) {
    return evaluateGates({ pr, commitCount: 0, finalFiles: [], touchedBasenames: [], closedP1: [], minCommits, expectedIssues });
  }
  const range = `${base}..${head}`;

  const commitCount = parseInt((git(repo, ['rev-list', '--count', range]).stdout || '0').trim(), 10) || 0;

  const finalFiles = (git(repo, ['diff', '--name-only', range]).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const touchedBasenames = (git(repo, ['log', range, '--name-only', '--pretty=format:']).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean).map(baseName);

  const baseB = readBeadsRef(repo, base);
  const candidates = [...baseB].filter(([, o]) => isP1(o) && !isClosed(o)).map(([id]) => id);

  const headB = readBeadsRef(repo, head);
  const diskB = readBeadsDisk(repo);
  const closedP1 = candidates.filter((id) =>
    isClosed(headB.get(id)) || isClosed(diskB.get(id)) || bdSaysClosed(repo, id));

  return evaluateGates({ pr, commitCount, finalFiles, touchedBasenames, closedP1, minCommits, expectedIssues });
}

// ---- CLI entry ----------------------------------------------------------------

if (process.argv[1] && (process.argv[1].endsWith('validate-sprint.mjs') || process.argv[1].endsWith('validate-sprint'))) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    process.stderr.write('Usage: validate-sprint.mjs <repo> <branch> [--pr-url <url>] [--min-commits N] [--expected-issues N]\n');
    process.exit(1);
  }
  const repo = args[0];
  const branch = args[1];
  let prUrl = '';
  let prNumber = 0;
  let minCommits = 10;
  let expectedIssues = 3;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--pr-url' && args[i + 1]) { prUrl = args[++i]; prNumber = parseInt(prUrl.split('/').pop(), 10) || 0; }
    if (args[i] === '--min-commits' && args[i + 1]) { minCommits = parseInt(args[++i], 10); }
    if (args[i] === '--expected-issues' && args[i + 1]) { expectedIssues = parseInt(args[++i], 10); }
  }
  const pr = prUrl ? { url: prUrl, number: prNumber } : null;
  const result = validateSprint({ repo, branch, pr, minCommits, expectedIssues });
  for (const g of result.gates) {
    process.stdout.write(`${g.pass ? 'PASS' : 'FAIL'} ${g.name}: ${g.detail}\n`);
  }
  process.stdout.write(`\nOverall: ${result.pass ? 'PASS' : 'FAIL'}\n`);
  process.exit(result.pass ? 0 : 1);
}
