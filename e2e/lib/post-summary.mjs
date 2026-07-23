#!/usr/bin/env node
// Render an e2e results report to the console and, in GitHub Actions, to the job
// summary ($GITHUB_STEP_SUMMARY). Shared by the fleet and pm harnesses.
//
// Two entry paths, unioned here:
//   - Library API postSummary(results) (called by packages/apra-fleet-se/apra-pm/e2e/
//     run-e2e.mjs): renders the pm report -- a clickable link to the PR's commits (which
//     stays live even after teardown deletes the branch), per-run token telemetry, and the
//     validation-gate breakdown -- to the console and the job summary.
//   - CLI (invoked by .github/workflows/fleet-e2e.yml as `node post-summary.mjs`): reads
//     results.json from the cwd and renders the fleet per-suite step/telemetry summary,
//     with SUITE taken from the environment.
import fs from 'node:fs';

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '');

// ---------------------------------------------------- pm report (library API)

function buildReport(results) {
  const lines = [];
  lines.push('## pm e2e');
  lines.push('');

  // Results + inspection links
  lines.push('| Suite | Provider | OS | Result | Gates | Commits | Notes |');
  lines.push('|-------|----------|----|--------|-------|---------|-------|');
  for (const r of results) {
    const link = r.pr ? `[PR #${r.pr.number} (${r.pr.commits.length} commits)](${r.pr.commitsUrl})` : '_none_';
    const notes = (r.notes || '').replace(/\|/g, '\\|');
    const gates = Array.isArray(r.gates) ? `${r.gates.filter((g) => g.pass).length}/${r.gates.length}` : 'n/a';
    lines.push(`| ${r.id} | ${r.provider} | ${r.os} | ${r.status} | ${gates} | ${link} | ${notes} |`);
  }
  lines.push('');

  // Validation gates -- the independent proof a disciplined sprint happened.
  if (results.some((r) => Array.isArray(r.gates))) {
    lines.push('### Validation gates');
    lines.push('');
    for (const r of results) {
      if (!Array.isArray(r.gates)) continue;
      lines.push(`**${r.id}**`);
      lines.push('');
      for (const g of r.gates) lines.push(`- ${g.pass ? 'PASS' : 'FAIL'} \`${g.name}\` -- ${(g.detail || '').replace(/\|/g, '\\|')}`);
      lines.push('');
    }
  }

  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  const tally = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  lines.push(`_${tally}_`);
  lines.push('');

  // Telemetry -- one row per run, so cost is comparable across runs.
  lines.push('### Telemetry (tokens)');
  lines.push('');
  lines.push('| Suite | Provider | In | Out | Total | Cache created | Cache read |');
  lines.push('|-------|----------|----|----|-------|---------------|------------|');
  for (const r of results) {
    const t = r.telemetry;
    if (t && t.available) {
      const total = (t.tokens_in || 0) + (t.tokens_out || 0);
      const provStr = t.estimated ? `${r.provider} (~est)` : r.provider;
      const inStr = t.estimated ? `~${fmt(t.tokens_in)}` : fmt(t.tokens_in);
      const outStr = t.estimated ? `~${fmt(t.tokens_out)}` : fmt(t.tokens_out);
      const totStr = t.estimated ? `~${fmt(total)}` : fmt(total);
      lines.push(`| ${r.id} | ${provStr} | ${inStr} | ${outStr} | ${totStr} | ${fmt(t.cache_creation)} | ${fmt(t.cache_read)} |`);
    } else {
      lines.push(`| ${r.id} | ${r.provider} | n/a | n/a | n/a | n/a | n/a |`);
    }
  }
  lines.push('');

  // Per-run commit detail (so the progression is legible without leaving the page).
  for (const r of results) {
    if (!r.pr || !r.pr.commits.length) continue;
    lines.push(`<details><summary>${r.id}: ${r.pr.commits.length} commits -> PR #${r.pr.number}</summary>`);
    lines.push('');
    for (const c of r.pr.commits) lines.push(`- \`${c.sha}\` ${c.author ? `**${c.author}** ` : ''}${c.msg.replace(/\|/g, '\\|')}`);
    lines.push('');
    lines.push(`[View all commits](${r.pr.commitsUrl})`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return { text: lines.join('\n'), tally };
}

export function postSummary(results) {
  const { text, tally } = buildReport(results);

  console.log('\n' + text + '\n');
  console.log(`pm e2e: ${tally}`);
  for (const r of results) {
    if (r.pr) console.log(`  ${r.id} commits: ${r.pr.commitsUrl}`);
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try { fs.appendFileSync(summaryFile, text + '\n'); } catch { /* non-fatal */ }
  }
}

// ---------------------------------------------------------- fleet report (CLI)

// Read results.json from the cwd and render the fleet per-suite step + telemetry summary.
function runCli() {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  const suite = process.env.SUITE || 'unknown';

  function append(line) {
    if (summaryFile) fs.appendFileSync(summaryFile, line + '\n');
    else console.log(line);
  }

  let report = {};
  try {
    report = JSON.parse(fs.readFileSync('results.json', 'utf8'));
  } catch {
    append(`## Fleet E2E - Suite ${suite}`);
    append('');
    append('**Overall: FAIL** -- could not read results.json');
    process.exit(0);
  }

  append(`## Fleet E2E - Suite ${suite}`);
  append('');
  append('| Step | Status | Notes |');
  append('|------|--------|-------|');

  for (const t of report.results ?? []) {
    const notes = (t.notes ?? '').replace(/\|/g, '\\|');
    append(`| ${t.id} | ${t.status} | ${notes} |`);
  }
  if (!(report.results ?? []).length) {
    append('| - | - | No step results recorded |');
  }

  append('');
  append(`**Overall: ${report.overall ?? 'FAIL'}**`);
  if (Array.isArray(report.missing_terminals) && report.missing_terminals.length > 0) {
    append('');
    append(`**Incomplete:** missing terminal checkpoint(s): ${report.missing_terminals.join(', ')}`);
  }
  append('');

  if (Array.isArray(report.telemetry) && report.telemetry.length > 0) {
    const pmSprint = report.telemetry.find(t => t.role === 'pm-sprint');
    const pmSetup  = report.telemetry.find(t => t.role === 'pm-setup');

    if (pmSprint) {
      const sprintTotal = (pmSprint.tokens_in ?? 0) + (pmSprint.tokens_out ?? 0);
      append(`**Sprint PM cost (headline): ${sprintTotal.toLocaleString()} tokens** (in: ${pmSprint.tokens_in ?? 0}, out: ${pmSprint.tokens_out ?? 0})`);
      if (pmSprint.cache_creation_input_tokens || pmSprint.cache_read_input_tokens) {
        append(`  Cache: ${pmSprint.cache_creation_input_tokens ?? 0} created, ${pmSprint.cache_read_input_tokens ?? 0} read`);
      }
      append('');
    }

    if (pmSetup) {
      const setupTotal = (pmSetup.tokens_in ?? 0) + (pmSetup.tokens_out ?? 0);
      append(`> **Setup PM cost (one-time): ${setupTotal.toLocaleString()} tokens** (in: ${pmSetup.tokens_in ?? 0}, out: ${pmSetup.tokens_out ?? 0})`);
      append('');
    }

    append('### Telemetry');
    append('');
    append('| Role | Tokens In | Tokens Out | Cache Created | Cache Read |');
    append('|------|-----------|------------|---------------|------------|');
    for (const t of report.telemetry) {
      append(`| ${t.role} | ${t.tokens_in ?? ''} | ${t.tokens_out ?? ''} | ${t.cache_creation_input_tokens ?? ''} | ${t.cache_read_input_tokens ?? ''} |`);
    }
  }
}

// ---- CLI entry ----------------------------------------------------------------
// Import-safe: the guard is false when another module imports this file.

if (process.argv[1] && (process.argv[1].endsWith('post-summary.mjs') || process.argv[1].endsWith('post-summary'))) {
  runCli();
}
