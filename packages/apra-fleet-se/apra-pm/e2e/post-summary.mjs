// Render an e2e results report to the console and, in GitHub Actions, to the job
// summary ($GITHUB_STEP_SUMMARY).
//
// The report carries the two things a reviewer actually wants: a clickable link to
// the PR's commits (so they can see how the sprint progressed -- the /commits URL
// stays live even after teardown deletes the branch), and per-run token telemetry
// (so cost regressions are visible run to run, not hidden behind "all checks passed").
import fs from 'node:fs';

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '');

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
