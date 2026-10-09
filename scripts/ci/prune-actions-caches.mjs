#!/usr/bin/env node
// Prune GitHub Actions caches so the repo stays under its 10 GB cache limit.
// Rules are table-driven (RULES below) and evaluated in order; the first rule
// that returns a verdict wins. decide() is pure so it is unit-testable
// (tests/prune-actions-caches.test.ts).
//
// Usage:
//   node scripts/ci/prune-actions-caches.mjs --repo owner/name [--input caches.json] [--delete]
// Without --delete it is a dry run: it prints every decision and deletes nothing.
// --input reads a saved `gh cache list --json id,key,ref,sizeInBytes,lastAccessedAt,createdAt`
// listing instead of calling gh.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

export const LIMITS = {
  recentAccessMs: DAY,        // never delete anything accessed this recently
  staleMs: 3 * DAY,           // "not accessed in 3 days"
  largeBytes: 200 * MB,       // big caches are deleted once stale, regardless of family
  keepPerFamily: 2,           // newest N per (family, ref) by lastAccessedAt are kept
};

const CODEQL_OVERLAY = /^codeql-overlay-base-database-/;
// A family is the key minus its trailing content hash (sha256 / long hex),
// e.g. node-cache-Linux-x64-npm-<sha256> -> node-cache-Linux-x64-npm.
const TRAILING_HASH = /-[0-9a-f]{16,}$/;

export function familyOf(key) {
  if (CODEQL_OVERLAY.test(key)) return 'codeql-overlay-base-database';
  return key.replace(TRAILING_HASH, '');
}

const ms = (iso) => Date.parse(iso);

// Per-listing context the rules consult.
function buildContext(caches) {
  const groups = new Map();
  for (const c of caches) {
    const g = `${familyOf(c.key)}|${c.ref}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const newestCodeql = new Map(); // ref -> id of newest overlay by createdAt
  const familyRank = new Map();   // id -> 0-based rank by lastAccessedAt desc within (family, ref)
  for (const list of groups.values()) {
    if (CODEQL_OVERLAY.test(list[0].key)) {
      const newest = [...list].sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
      newestCodeql.set(newest.ref, newest.id);
    }
    [...list]
      .sort((a, b) => ms(b.lastAccessedAt) - ms(a.lastAccessedAt))
      .forEach((c, i) => familyRank.set(c.id, i));
  }
  return { newestCodeql, familyRank };
}

// Each rule: (cache, ctx, now) -> { action, reason } | null (= not applicable).
export const RULES = [
  {
    name: 'recent-access',
    apply: (c, _ctx, now) =>
      now - ms(c.lastAccessedAt) < LIMITS.recentAccessMs
        ? { action: 'KEEP', reason: 'accessed in last 24h' } : null,
  },
  {
    name: 'large-stale',
    apply: (c, _ctx, now) =>
      c.sizeInBytes > LIMITS.largeBytes && now - ms(c.lastAccessedAt) >= LIMITS.staleMs
        ? { action: 'DELETE', reason: '>200 MB and not accessed in 3d' } : null,
  },
  {
    name: 'codeql-overlay',
    apply: (c, ctx) => {
      if (!CODEQL_OVERLAY.test(c.key)) return null;
      return ctx.newestCodeql.get(c.ref) === c.id
        ? { action: 'KEEP', reason: 'newest codeql overlay for ref' }
        : { action: 'DELETE', reason: 'superseded codeql overlay' };
    },
  },
  {
    name: 'family',
    apply: (c, ctx, now) => {
      const rank = ctx.familyRank.get(c.id);
      if (rank < LIMITS.keepPerFamily) return { action: 'KEEP', reason: `newest ${LIMITS.keepPerFamily} in family/ref (#${rank + 1})` };
      if (now - ms(c.lastAccessedAt) >= LIMITS.staleMs) return { action: 'DELETE', reason: `older than newest ${LIMITS.keepPerFamily} in family/ref, idle 3d+` };
      return { action: 'KEEP', reason: 'older in family/ref but accessed in last 3d' };
    },
  },
];

export function decide(caches, now = Date.now()) {
  const ctx = buildContext(caches);
  return caches.map((c) => {
    for (const r of RULES) {
      const v = r.apply(c, ctx, now);
      if (v) return { ...c, family: familyOf(c.key), rule: r.name, ...v };
    }
    return { ...c, family: familyOf(c.key), rule: 'default', action: 'KEEP', reason: 'no rule matched' };
  });
}

export function summarize(decisions) {
  const del = decisions.filter((d) => d.action === 'DELETE');
  const sum = (xs) => xs.reduce((n, d) => n + d.sizeInBytes, 0);
  return {
    total: decisions.length,
    totalBytes: sum(decisions),
    deleteCount: del.length,
    deleteBytes: sum(del),
    keepCount: decisions.length - del.length,
  };
}

const fmtMb = (b) => (b / MB).toFixed(1);

export function formatTable(decisions) {
  const rows = [...decisions].sort((a, b) =>
    a.family.localeCompare(b.family) || a.ref.localeCompare(b.ref) || ms(b.lastAccessedAt) - ms(a.lastAccessedAt));
  const lines = ['| action | key | ref | MB | lastAccessed | reason |', '|---|---|---|---:|---|---|'];
  for (const d of rows) {
    const key = d.key.length > 90 ? `${d.key.slice(0, 60)}...${d.key.slice(-24)}` : d.key;
    lines.push(`| ${d.action} | ${key} | ${d.ref} | ${fmtMb(d.sizeInBytes)} | ${d.lastAccessedAt.slice(0, 16)} | ${d.reason} |`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const a = { repo: process.env.GITHUB_REPOSITORY, input: null, del: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') a.repo = argv[++i];
    else if (argv[i] === '--input') a.input = argv[++i];
    else if (argv[i] === '--delete') a.del = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!a.repo && (!a.input || a.del)) throw new Error('--repo (or GITHUB_REPOSITORY) is required');
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = args.input
    ? readFileSync(args.input, 'utf8')
    : execFileSync('gh', ['cache', 'list', '--repo', args.repo, '--limit', '1000',
      '--json', 'id,key,ref,sizeInBytes,lastAccessedAt,createdAt'], { encoding: 'utf8' });
  const decisions = decide(JSON.parse(raw));
  const s = summarize(decisions);
  const mode = args.del ? 'DELETE' : 'DRY RUN (nothing deleted)';
  const report = [
    `## Actions cache prune - ${mode}`,
    '',
    `${s.total} caches, ${fmtMb(s.totalBytes)} MB total. DELETE ${s.deleteCount} (${fmtMb(s.deleteBytes)} MB freed), KEEP ${s.keepCount}.`,
    '',
    formatTable(decisions),
    '',
  ].join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

  if (!args.del) return;
  let deleted = 0, gone = 0, failed = 0;
  for (const d of decisions.filter((x) => x.action === 'DELETE')) {
    try {
      execFileSync('gh', ['cache', 'delete', String(d.id), '--repo', args.repo], { stdio: ['ignore', 'pipe', 'pipe'] });
      deleted++;
    } catch (e) {
      const msg = `${e.stderr ?? ''}${e.stdout ?? ''}`;
      // Evicted by GitHub (or a concurrent run) between list and delete: benign.
      if (/not found|404/i.test(msg)) { gone++; continue; }
      failed++;
      console.error(`failed to delete cache ${d.id} (${d.key}): ${msg.trim()}`);
    }
  }
  console.log(`deleted ${deleted}, already gone ${gone}, failed ${failed} (of ${s.deleteCount})`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
