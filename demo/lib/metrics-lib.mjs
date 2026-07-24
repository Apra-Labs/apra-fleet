// demo/lib/metrics-lib.mjs
//
// Shared, dependency-free (Node 22 builtins only) functions used by
// collect-metrics.mjs, gain-report.mjs, and selftest.mjs. Kept as pure
// functions where possible so selftest.mjs can exercise them directly
// against fixtures without needing a live sandbox or a real sprint run.
//
// Every reader in this file is designed to DEGRADE GRACEFULLY: missing
// files, missing tables, missing binaries -- all return an
// { available: false, notes: [...] } shape instead of throwing. The one
// exception is obviously-wrong CLI arguments, which fail fast in the CLI
// wrappers (collect-metrics.mjs / gain-report.mjs), not in this library.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// git log
// ---------------------------------------------------------------------------

// Returns { available, count, commits: [{hash, subject}], notes }.
// `pathspec` (optional) restricts the log to a single file, e.g.
// '.fleet/kb-canonical.json', for the bible-commit count.
export function readGitLog(repoDir, pathspec, limit = 50) {
  const notes = [];
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    return { available: false, count: 0, commits: [], notes: ['no .git in ' + repoDir] };
  }
  try {
    const args = ['log', '--format=%H%x1f%s', '-n', String(limit)];
    if (pathspec) args.push('--', pathspec);
    const out = execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = out.split('\n').filter(Boolean);
    const commits = lines.map(l => {
      const [hash, subject] = l.split('\x1f');
      return { hash, subject: subject ?? '' };
    });
    // Full count can exceed `limit`; ask separately with --oneline | count.
    const countArgs = ['rev-list', '--count', 'HEAD'];
    if (pathspec) countArgs.push('--', pathspec);
    let count = commits.length;
    try {
      count = parseInt(execFileSync('git', countArgs, { cwd: repoDir, encoding: 'utf-8' }).trim(), 10) || commits.length;
    } catch {
      // pathspec with no matching commits, or no HEAD yet -- fall back to what we counted above.
    }
    return { available: true, count, commits, notes };
  } catch (err) {
    notes.push('git log failed: ' + (err && err.message ? err.message : String(err)));
    return { available: false, count: 0, commits: [], notes };
  }
}

// ---------------------------------------------------------------------------
// progress.json dispatches ledger (see vendor/apra-pm/skills/pm/tpl-progress.json)
// ---------------------------------------------------------------------------

// Recursively finds files named progress.json under `dir`, skipping heavy or
// irrelevant subtrees. PM writes progress.json inside "the track's worktree"
// (skills/pm/SKILL.md R2) -- for a single-track sprint on a fresh sandbox
// that is usually the sandbox root itself, but we search a few levels deep
// so a nested track worktree is still found.
function findProgressJsonFiles(dir, depth = 5, skip = new Set(['.git', 'node_modules', '.gitnexus', '.beads'])) {
  const found = [];
  function walk(d, remaining) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'progress.json' && e.isFile()) {
        found.push(path.join(d, e.name));
        continue;
      }
      if (e.isDirectory() && remaining > 0 && !skip.has(e.name)) {
        walk(path.join(d, e.name), remaining - 1);
      }
    }
  }
  walk(dir, depth);
  return found;
}

// Returns { found, path, dispatches, totals: {tokens, toolUses, ms, count},
//           by_role: {role: {tokens, toolUses, ms, count}},
//           doer_model_mix: [{model, tokens, count}], notes }
export function readProgressLedger(sandboxDir) {
  const notes = [];
  const files = findProgressJsonFiles(sandboxDir);
  if (files.length === 0) {
    notes.push('no progress.json found under ' + sandboxDir + ' -- expected for a vendored pm with no dispatches ledger, or a simple-sprint flow with no PLAN.md/progress.json');
    return { found: false, path: null, dispatches: [], totals: null, by_role: {}, doer_model_mix: [], notes };
  }
  // Pick the most recently modified progress.json if more than one track exists.
  let chosen = files[0];
  let chosenMtime = 0;
  for (const f of files) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m >= chosenMtime) { chosen = f; chosenMtime = m; }
    } catch { /* ignore */ }
  }
  if (files.length > 1) {
    notes.push('multiple progress.json found (' + files.length + '); using most recently modified: ' + chosen);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(chosen, 'utf-8'));
  } catch (err) {
    notes.push('progress.json found but failed to parse: ' + (err && err.message ? err.message : String(err)));
    return { found: true, path: chosen, dispatches: [], totals: null, by_role: {}, doer_model_mix: [], notes };
  }

  const dispatches = Array.isArray(parsed.dispatches) ? parsed.dispatches : [];
  if (dispatches.length === 0) {
    notes.push('progress.json has no dispatches recorded yet (ledger schema present but empty -- vendored pm may not populate it, or the sprint has not dispatched a subagent yet)');
  }

  const totals = { tokens: 0, toolUses: 0, ms: 0, count: dispatches.length };
  const by_role = {};
  const doerModelTotals = new Map();

  for (const d of dispatches) {
    const tokens = typeof d.tokens === 'number' ? d.tokens : 0;
    const toolUses = typeof d.toolUses === 'number' ? d.toolUses : 0;
    const ms = typeof d.ms === 'number' ? d.ms : 0;
    totals.tokens += tokens;
    totals.toolUses += toolUses;
    totals.ms += ms;

    const role = d.role || 'unknown';
    if (!by_role[role]) by_role[role] = { tokens: 0, toolUses: 0, ms: 0, count: 0 };
    by_role[role].tokens += tokens;
    by_role[role].toolUses += toolUses;
    by_role[role].ms += ms;
    by_role[role].count += 1;

    if (role === 'doer') {
      const model = d.model || 'unknown';
      const cur = doerModelTotals.get(model) || { tokens: 0, count: 0 };
      cur.tokens += tokens;
      cur.count += 1;
      doerModelTotals.set(model, cur);
    }
  }

  const doer_model_mix = [...doerModelTotals.entries()].map(([model, v]) => ({ model, tokens: v.tokens, count: v.count }));

  return { found: true, path: chosen, dispatches, totals, by_role, doer_model_mix, notes };
}

// ---------------------------------------------------------------------------
// KB stats (direct sqlite read -- mirrors src/tools/kb-stats.ts + sqlite-provider.ts's stats())
// ---------------------------------------------------------------------------

// slug logic mirrors src/services/knowledge/project-slug.ts's resolveProjectSlug():
// 1. git remote get-url origin, slugified
// 2. git rev-parse --show-toplevel basename, slugified
// 3. 'default'
function slugify(s) {
  return s
    .replace(/^https?:\/\/[^@]*@?/, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/[:/]/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function resolveProjectSlug(cwd) {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const slug = slugify(remote);
    if (slug) return slug;
  } catch { /* fall through */ }
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const slug = slugify(path.basename(root));
    if (slug) return slug;
  } catch { /* fall through */ }
  return 'default';
}

// Direct sqlite read of FLEET_DIR/knowledge/<slug>/kb.sqlite using the
// Node 22 builtin node:sqlite module (no dependency install needed in the
// sandbox -- more robust than shelling out to the MCP server, which needs
// a stdio handshake this collector script does not speak). Async because
// node:sqlite is reached via dynamic import (works whether or not the
// experimental flag/warning is present, and needs no createRequire setup).
export async function readKbStats(dataDir, sandboxDir) {
  const notes = [];
  const slug = resolveProjectSlug(sandboxDir);
  const dbPath = path.join(dataDir, 'knowledge', slug, 'kb.sqlite');
  if (!fs.existsSync(dbPath)) {
    notes.push('kb.sqlite not found at ' + dbPath + ' -- Env A has no KB/code-intelligence layer (pre-v0.3.x KB feature), or Env B has not run kb_session_prime/kb_capture yet');
    return { available: false, db_path: dbPath, slug, notes };
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (err) {
    notes.push('node:sqlite unavailable (needs Node 22+): ' + (err && err.message ? err.message : String(err)));
    return { available: false, db_path: dbPath, slug, notes };
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const byConfidenceRows = db.prepare('SELECT confidence, COUNT(*) as c FROM entries GROUP BY confidence').all();
    const by_confidence = { CONFIRMED: 0, INFERRED: 0, UNVERIFIED: 0 };
    let total = 0;
    for (const row of byConfidenceRows) { by_confidence[row.confidence] = row.c; total += row.c; }

    const byTypeRows = db.prepare('SELECT type, COUNT(*) as c FROM entries GROUP BY type').all();
    const by_type = { 'context-cache': 0, learning: 0, knowledge: 0, runbook: 0, 'user-directive': 0 };
    for (const row of byTypeRows) { by_type[row.type] = row.c; }

    const staleRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE stale = 1').get();
    const flaggedRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE flagged_for_review = 1').get();
    const supersededRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE superseded_at IS NOT NULL').get();
    const liveRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE superseded_at IS NULL AND stale = 0').get();
    const retrievedRow = db.prepare('SELECT COUNT(*) as c FROM entries WHERE use_count > 0 AND superseded_at IS NULL AND stale = 0').get();
    const totalUsesRow = db.prepare('SELECT COALESCE(SUM(use_count), 0) as s FROM entries').get();
    const hit_rate = liveRow.c > 0 ? retrievedRow.c / liveRow.c : null;

    db.close();

    return {
      available: true,
      db_path: dbPath,
      slug,
      totals: { by_confidence, by_type, total },
      stale: staleRow.c,
      flagged: flaggedRow.c,
      superseded: supersededRow.c,
      retrieval: { entries_retrieved: retrievedRow.c, total_uses: totalUsesRow.s, hit_rate },
      notes,
    };
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    notes.push('kb.sqlite read failed: ' + (err && err.message ? err.message : String(err)));
    return { available: false, db_path: dbPath, slug, notes };
  }
}

// ---------------------------------------------------------------------------
// canonical bible (.fleet/kb-canonical.json)
// ---------------------------------------------------------------------------

// Returns { present, entries, commits, notes }. `commits` is the git-log
// commit count for that single file (F6a: kb_export auto-commits it).
export function readBible(sandboxDir) {
  const notes = [];
  const biblePath = path.join(sandboxDir, '.fleet', 'kb-canonical.json');
  let entries = 0;
  let present = false;
  if (fs.existsSync(biblePath)) {
    present = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(biblePath, 'utf-8'));
      entries = Array.isArray(parsed) ? parsed.length : 0;
    } catch (err) {
      notes.push('kb-canonical.json present but failed to parse: ' + (err && err.message ? err.message : String(err)));
    }
  } else {
    notes.push('.fleet/kb-canonical.json not present -- no kb_export has run yet (or Env A, which has no KB layer at all)');
  }
  const log = readGitLog(sandboxDir, '.fleet/kb-canonical.json');
  return { present, entries, commits: log.available ? log.count : 0, notes: notes.concat(log.notes) };
}

// ---------------------------------------------------------------------------
// usage.jsonl (code-intelligence tool call telemetry)
// ---------------------------------------------------------------------------

// IMPORTANT VERIFIED FACT (see src/tools/code-intelligence-telemetry.ts):
// USAGE_DIR is hardcoded to join(homedir(), '.apra-fleet', 'data',
// 'code-intelligence') -- it does NOT honor APRA_FLEET_DATA_DIR. So this
// file is NOT per-sandbox-isolated; every env/run on one machine appends to
// the SAME physical usage.jsonl. We isolate per-env by filtering records on
// their `repo` field (the resolved repo path recorded at call time) rather
// than by file location. `realHomeDir` is overridable for tests so selftest
// never reads the operator's actual ~/.apra-fleet history.
export function readUsage(realHomeDir, sandboxDir) {
  const notes = [];
  const dir = path.join(realHomeDir, '.apra-fleet', 'data', 'code-intelligence');
  const files = [path.join(dir, 'usage.jsonl'), path.join(dir, 'usage.jsonl.1')];
  const target = path.resolve(sandboxDir);
  const targetNorm = target.replace(/\\/g, '/').toLowerCase();

  let anyFile = false;
  const counts = new Map();
  let total = 0;

  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    anyFile = true;
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf-8');
    } catch (err) {
      notes.push('failed to read ' + f + ': ' + (err && err.message ? err.message : String(err)));
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const repo = typeof rec.repo === 'string' ? rec.repo.replace(/\\/g, '/').toLowerCase() : null;
      if (repo !== targetNorm) continue;
      const tool = rec.tool || 'unknown';
      counts.set(tool, (counts.get(tool) || 0) + 1);
      total += 1;
    }
  }

  if (!anyFile) {
    notes.push('usage.jsonl not found under ' + dir + ' -- no code-intelligence tool calls recorded yet, or this is Env A (no code intelligence layer)');
  }
  notes.push('usage.jsonl is NOT env-isolated (hardcoded to real homedir, ignores APRA_FLEET_DATA_DIR) -- counts are filtered by repo path match, not by file location');

  return {
    available: anyFile,
    total_calls: total,
    by_tool: Object.fromEntries(counts.entries()),
    notes,
  };
}

// ---------------------------------------------------------------------------
// snapshot assembly
// ---------------------------------------------------------------------------

export async function buildSnapshot({ env, sprint, sandboxDir, dataDir, realHomeDir }) {
  const notes = [];
  const gitLog = readGitLog(sandboxDir);
  const progress = readProgressLedger(sandboxDir);
  notes.push(...progress.notes);

  const snapshot = {
    env,
    sprint,
    collected_at: new Date().toISOString(),
    sandbox_dir: sandboxDir,
    data_dir: dataDir,
    git: { available: gitLog.available, commit_count: gitLog.count, recent: gitLog.commits.slice(0, 10), notes: gitLog.notes },
    progress: { found: progress.found, path: progress.path, totals: progress.totals, by_role: progress.by_role, doer_model_mix: progress.doer_model_mix, notes: progress.notes },
    kb: null,
    bible: null,
    usage: null,
    notes,
  };

  if (env === 'B') {
    snapshot.kb = await readKbStats(dataDir, sandboxDir);
    snapshot.bible = readBible(sandboxDir);
    snapshot.usage = readUsage(realHomeDir ?? os.homedir(), sandboxDir);
  } else {
    snapshot.notes.push('Env A: skipping KB/bible/usage collection -- released v0.3.4 has no KB/code-intelligence layer');
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// gain report rendering
// ---------------------------------------------------------------------------

// Picks the latest snapshot for a given sprint out of a metrics array
// (there should normally be exactly one, but a re-run of collect-metrics for
// the same sprint should not crash the report -- last write wins).
function latestForSprint(snapshots, sprint) {
  const matches = (snapshots || []).filter(s => s && s.sprint === sprint);
  return matches.length ? matches[matches.length - 1] : null;
}

function fmt(n) {
  if (n === null || n === undefined) return '<span class="na">n/a</span>';
  if (typeof n === 'number') return n.toLocaleString('en-US');
  return String(n);
}

function pct(delta, base) {
  if (base === null || base === undefined || base === 0 || delta === null || delta === undefined) return null;
  return (delta / base) * 100;
}

function deltaLabel(a, b) {
  // a = Env A (baseline), b = Env B. Positive delta means B used MORE than A.
  if (typeof a !== 'number' || typeof b !== 'number') return '<span class="na">n/a</span>';
  const d = b - a;
  const p = pct(d, a);
  const sign = d > 0 ? '+' : '';
  const cls = d > 0 ? 'worse' : d < 0 ? 'better' : 'flat';
  const pctStr = p === null ? '' : ` (${sign}${p.toFixed(0)}%)`;
  return `<span class="delta ${cls}">${sign}${d.toLocaleString('en-US')}${pctStr}</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sprintTable(sprintLabel, snapA, snapB) {
  const aTokens = snapA?.progress?.totals?.tokens ?? null;
  const bTokens = snapB?.progress?.totals?.tokens ?? null;
  const aTools = snapA?.progress?.totals?.toolUses ?? null;
  const bTools = snapB?.progress?.totals?.toolUses ?? null;
  const aMs = snapA?.progress?.totals?.ms ?? null;
  const bMs = snapB?.progress?.totals?.ms ?? null;
  const aDispatches = snapA?.progress?.totals?.count ?? null;
  const bDispatches = snapB?.progress?.totals?.count ?? null;
  const aCommits = snapA?.git?.commit_count ?? null;
  const bCommits = snapB?.git?.commit_count ?? null;

  const aMix = (snapA?.progress?.doer_model_mix || []).map(m => `${escapeHtml(m.model)}: ${fmt(m.tokens)} tok (${m.count}x)`).join('<br>') || '<span class="na">n/a</span>';
  const bMix = (snapB?.progress?.doer_model_mix || []).map(m => `${escapeHtml(m.model)}: ${fmt(m.tokens)} tok (${m.count}x)`).join('<br>') || '<span class="na">n/a</span>';

  return `
  <div class="section">
    <div class="section-title">${escapeHtml(sprintLabel)}</div>
    <table class="cmp">
      <thead><tr><th>Metric</th><th>Env A (v0.3.4 release)</th><th>Env B (this branch)</th><th>Delta (B - A)</th></tr></thead>
      <tbody>
        <tr><td>Dispatches</td><td>${fmt(aDispatches)}</td><td>${fmt(bDispatches)}</td><td>${deltaLabel(aDispatches, bDispatches)}</td></tr>
        <tr><td>Tokens</td><td>${fmt(aTokens)}</td><td>${fmt(bTokens)}</td><td>${deltaLabel(aTokens, bTokens)}</td></tr>
        <tr><td>Tool uses</td><td>${fmt(aTools)}</td><td>${fmt(bTools)}</td><td>${deltaLabel(aTools, bTools)}</td></tr>
        <tr><td>Wall-clock (ms)</td><td>${fmt(aMs)}</td><td>${fmt(bMs)}</td><td>${deltaLabel(aMs, bMs)}</td></tr>
        <tr><td>Commits</td><td>${fmt(aCommits)}</td><td>${fmt(bCommits)}</td><td>${deltaLabel(aCommits, bCommits)}</td></tr>
        <tr><td>Doer model mix</td><td>${aMix}</td><td>${bMix}</td><td>--</td></tr>
      </tbody>
    </table>
  </div>`;
}

function headlineDelta(snapA2, snapB2) {
  const aTokens = snapA2?.progress?.totals?.tokens;
  const bTokens = snapB2?.progress?.totals?.tokens;
  if (typeof aTokens !== 'number' || typeof bTokens !== 'number') {
    return '<p class="headline na">Sprint 2 token totals unavailable for one or both envs -- run both sprints through collect-metrics before drawing a headline number.</p>';
  }
  const d = bTokens - aTokens;
  const p = pct(d, aTokens);
  const verb = d < 0 ? 'fewer' : 'more';
  const cls = d < 0 ? 'better' : 'worse';
  return `<p class="headline ${cls}">Sprint 2: Env B used <b>${Math.abs(d).toLocaleString('en-US')} ${verb} tokens</b> than Env A` +
    (p !== null ? ` (<b>${Math.abs(p).toFixed(0)}%</b> ${verb})` : '') +
    ` -- this is where sprint-1 KB capture (note-archiving) gets reused for sprint-2 (pagination), which touches the same listing code.</p>`;
}

function capabilitiesRow(snapB1, snapB2) {
  const kb = snapB2?.kb || snapB1?.kb;
  const bible = snapB2?.bible || snapB1?.bible;
  const usage = snapB2?.usage || snapB1?.usage;
  const kbEntries = kb?.available ? kb.totals?.total : null;
  const hitRate = kb?.available ? kb.retrieval?.hit_rate : null;
  const bibleEntries = bible?.present ? bible.entries : null;
  const bibleCommits = bible?.present ? bible.commits : null;
  const usageCalls = usage?.available ? usage.total_calls : null;

  return `
  <div class="section">
    <div class="section-title">ENV B ONLY -- KNOWLEDGE BANK / CODE INTELLIGENCE (no Env A equivalent -- pre-KB release)</div>
    <table class="cmp caps">
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>KB entries captured (project KB)</td><td>${fmt(kbEntries)}</td></tr>
        <tr><td>KB retrieval hit rate</td><td>${hitRate === null || hitRate === undefined ? '<span class="na">n/a</span>' : (hitRate * 100).toFixed(0) + '%'}</td></tr>
        <tr><td>Canonical bible (.fleet/kb-canonical.json) entries</td><td>${fmt(bibleEntries)}</td></tr>
        <tr><td>Bible auto-commits (git log on kb-canonical.json)</td><td>${fmt(bibleCommits)}</td></tr>
        <tr><td>Code-intelligence tool calls (usage.jsonl, this sandbox)</td><td>${fmt(usageCalls)}</td></tr>
      </tbody>
    </table>
  </div>`;
}

function collectAllNotes(snaps) {
  const notes = [];
  for (const s of snaps) {
    if (!s) continue;
    const tag = `[env ${s.env} / ${s.sprint}]`;
    for (const n of s.notes || []) notes.push(`${tag} ${n}`);
  }
  return notes;
}

// Builds the full gain-report.html document as a string. metricsA/metricsB
// are the raw arrays read from metrics-A.json / metrics-B.json (each an
// array of per-sprint snapshots as produced by buildSnapshot()).
export function buildGainReportHtml(metricsA, metricsB) {
  const a1 = latestForSprint(metricsA, 'sprint1');
  const a2 = latestForSprint(metricsA, 'sprint2');
  const b1 = latestForSprint(metricsB, 'sprint1');
  const b2 = latestForSprint(metricsB, 'sprint2');

  const notes = collectAllNotes([a1, a2, b1, b2]);
  const notesHtml = notes.length
    ? `<ul>${notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : '<p>No missing data -- every metric below was collected successfully.</p>';

  const generatedAt = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Apra Fleet -- Upgrade Demo: Gain Report</title>
<style>
  :root {
    --bg: #0f1117; --panel: #161b26; --border: #232b3b;
    --text: #e2e8f0; --dim: #94a3b8; --faint: #64748b;
    --green: #22c55e; --green-bg: #0a1f12;
    --red: #f87171; --red-bg: #1f0f0f;
    --amber: #fbbf24; --amber-bg: #1f1a0a;
    --blue: #60a5fa; --blue-bg: #0e1a2e;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 36px 20px; display: flex; flex-direction: column; align-items: center; }
  h1 { font-size: 21px; margin: 0 0 4px; }
  .sub { color: var(--faint); font-size: 13px; margin: 0 0 30px; }
  .section { width: 100%; max-width: 1060px; margin-bottom: 30px; }
  .section-title { font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
    color: var(--dim); border-bottom: 1px solid var(--border);
    padding-bottom: 8px; margin-bottom: 14px; text-transform: uppercase; }
  table.cmp { width: 100%; border-collapse: collapse; background: var(--panel);
    border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-size: 12px; }
  table.cmp th, table.cmp td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  table.cmp th { color: var(--dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  table.cmp tr:last-child td { border-bottom: none; }
  .na { color: var(--faint); font-style: italic; }
  .delta.better { color: var(--green); font-weight: 600; }
  .delta.worse { color: var(--red); font-weight: 600; }
  .delta.flat { color: var(--dim); }
  .headline { width: 100%; max-width: 1060px; background: var(--blue-bg); border: 1px solid #1d4ed8;
    border-radius: 8px; padding: 16px 18px; font-size: 14px; line-height: 1.6; margin-bottom: 30px; }
  .headline.better { border-color: #14532d; background: var(--green-bg); }
  .headline.worse { border-color: #7f1d1d; background: var(--red-bg); }
  .headline b { color: var(--text); }
  .footnote { width: 100%; max-width: 1060px; font-size: 11px; color: var(--dim);
    background: var(--amber-bg); border: 1px solid #713f12; border-radius: 8px; padding: 14px 16px; }
  .footnote ul { margin: 6px 0 0; padding-left: 18px; }
  .footnote li { margin-bottom: 4px; }
  .caps th, .caps td { font-size: 12px; }
</style>
</head>
<body>

<h1>Upgrade Demo -- Gain Report</h1>
<p class="sub">Env A: released apra-fleet v0.3.4 (no KB/code-intelligence layer) vs Env B: this branch build -- generated ${generatedAt}</p>

${headlineDelta(a2, b2)}

${sprintTable('Sprint 1 -- note archiving (feature_list.json)', a1, b1)}
${sprintTable('Sprint 2 -- pagination (touches the same listing code sprint 1 changed)', a2, b2)}
${capabilitiesRow(b1, b2)}

<div class="footnote section">
  <b>Honesty note.</b> Sprint 1 is a cold start for Env B too -- KB capture overhead can make sprint 1 cost
  MORE tokens on Env B than Env A. The gain shows up in sprint 2 (KB reuse against sprint 1's listing-code
  changes) and compounds over further sprints. Any metric below marked n/a was genuinely unavailable at
  collection time (see notes) -- it is not hidden or assumed to be zero.
  <br><br>
  <b>Data notes from this run:</b>
  ${notesHtml}
</div>

</body>
</html>
`;
}

export function appendSnapshot(metricsPath, snapshot) {
  let arr = [];
  if (fs.existsSync(metricsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // Corrupt/partial file -- start fresh rather than throw, but say so.
      snapshot.notes.push('existing ' + metricsPath + ' was not valid JSON; starting a new array');
    }
  }
  arr.push(snapshot);
  fs.writeFileSync(metricsPath, JSON.stringify(arr, null, 2) + '\n');
  return arr;
}
