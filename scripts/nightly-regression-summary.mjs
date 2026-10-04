#!/usr/bin/env node
// Nightly regression report: turns the real-bd suite + slow lane status files
// into a verdict (PASS / FAIL / BROKEN) and a rich GitHub job summary.
//
// Used by .github/workflows/regression-nightly.yml. The nightly is advisory on
// main -- CI is the verdict there -- so this script NEVER fails its step on an
// outcome: it always exits 0 and reports the verdict as the summary headline,
// a `verdict=` line in --github-output, and a workflow annotation.
//
//   PASS   = every failure is covered by a live quarantine entry
//   FAIL   = one or more new failures (including expired quarantine entries)
//   BROKEN = the harness did not produce a trustworthy result: suite crashed or
//            timed out, no/corrupt status file, headSha mismatch, slow lane
//            missing or incomplete, invalid quarantine file. Never green by
//            absence -- BROKEN is stated loudly, but does not fail the job.
//
// Classification (quarantine, slow/ prefix, budget) reuses
// scripts/check-integ-suite-budget.mjs; that script's own modes and exit
// codes are unchanged.
//
// Usage (repo root):
//   node scripts/nightly-regression-summary.mjs
//     [--status=integ-suite-status.json] [--slow=slow-suite-status.json]
//     [--quarantine=tests/regression/quarantine.json]
//     [--integ-rc=<run-integ-suites --status exit>] [--slow-rc=<node --test exit>]
//     [--expected-sha=<tested commit>] [--previous=<dir with previous run's status files>]
//     [--summary=<markdown file to append>] [--github-output=<file>]
//     [--repo-url=<https://github.com/o/r>] [--run-url=<run url>] [--artifact-url=<url>]
// An empty --integ-rc= / --slow-rc= means the step never recorded an exit code
// (timed out or skipped) and is BROKEN; omitting the flag skips that check.

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUDGET_MS, SLOW_PREFIX, DEFAULT_QUARANTINE_FILE,
  loadQuarantine, loadStatusDoc, listSlowTestFiles, mergeSlowResults, classifyFailures,
} from './check-integ-suite-budget.mjs';

export const DETAIL_FILES_PER_GROUP = 25;
export const ERROR_LINES = 6;
export const SLOWEST_N = 10;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortSha = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 7) : 'unknown');

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Wall-clock of a lane: the supervisor's wallClockSeconds, else run timestamps. */
export function laneDurationMs(doc) {
  const run = doc && doc.run;
  if (!run) return null;
  if (typeof run.wallClockSeconds === 'number') return run.wallClockSeconds * 1000;
  const end = run.finishedAt || run.lastResultAt;
  if (run.startedAt && end) {
    const d = Date.parse(end) - Date.parse(run.startedAt);
    return Number.isFinite(d) ? d : null;
  }
  return null;
}

/** File and individual-test counts for one lane's results map. */
export function laneCounts(results) {
  const recs = Object.values(results || {});
  const files = { run: recs.length, passed: 0, failed: 0 };
  const tests = { run: 0, passed: 0, failed: 0, skipped: 0 };
  let withTests = 0;
  for (const r of recs) {
    if (r && r.passed === false) files.failed += 1; else files.passed += 1;
    if (r && r.tests && typeof r.tests.total === 'number') {
      withTests += 1;
      tests.run += r.tests.total;
      tests.passed += r.tests.passed || 0;
      tests.failed += r.tests.failed || 0;
      tests.skipped += r.tests.skipped || 0;
    }
  }
  return { files, tests: withTests ? tests : null, testsPartial: withTests > 0 && withTests < recs.length };
}

function mergedResults(integDoc, slowDoc) {
  const out = { ...((integDoc && integDoc.results) || {}) };
  for (const [f, rec] of Object.entries((slowDoc && slowDoc.results) || {})) out[SLOW_PREFIX + f] = rec;
  return out;
}

function readDoc(file, label, reasons) {
  try {
    const doc = loadStatusDoc(file);
    if (doc === null) reasons.push(`no ${label} status file (${path.basename(file)})`);
    return doc;
  } catch (e) {
    reasons.push(`${label} status file unreadable: ${e.message}`);
    return null;
  }
}

function readPrevious(dir) {
  if (!dir || !existsSync(dir)) return null;
  try {
    const integ = loadStatusDoc(path.join(dir, 'integ-suite-status.json'));
    if (!integ) return null;
    let slow = null;
    try { slow = loadStatusDoc(path.join(dir, 'slow-suite-status.json')); } catch { slow = null; }
    let meta = {};
    try {
      const m = path.join(dir, 'meta.json');
      if (existsSync(m)) meta = JSON.parse(readFileSync(m, 'utf8'));
    } catch { meta = {}; }
    return { results: mergedResults(integ, slow), headSha: meta.headSha || integ.headSha || null, runUrl: meta.runUrl || null };
  } catch {
    return null;
  }
}

/**
 * Read status/quarantine/previous files and decide which harness checks fail.
 * Never throws: every problem becomes a BROKEN reason.
 */
export function collectNightlyInputs({
  statusFile, slowFile = null, quarantineFile = DEFAULT_QUARANTINE_FILE,
  integRc = null, slowRc = null, expectedSha = null, previousDir = null,
  slowExpected = null,
}) {
  const reasons = [];
  if (integRc !== null) {
    if (integRc === '') reasons.push('real-bd suite did not finish (no exit code recorded: timed out or never ran)');
    else if (integRc !== '0' && integRc !== '1') reasons.push(`real-bd suite did not complete (--status exit=${integRc})`);
  }
  if (slowRc !== null) {
    if (slowRc === '') reasons.push('slow lane did not finish (no exit code recorded: timed out or never ran)');
    else if (slowRc !== '0' && slowRc !== '1') reasons.push(`slow lane exited ${slowRc} (crashed, not a test failure)`);
  }

  const integDoc = readDoc(statusFile, 'real-bd suite', reasons);
  if (integDoc && Object.keys(integDoc.results).length === 0) {
    reasons.push('real-bd suite recorded zero results');
  }
  if (integDoc && expectedSha && integDoc.headSha !== expectedSha) {
    reasons.push(`real-bd status is for ${shortSha(integDoc.headSha)}, not the tested commit ${shortSha(expectedSha)}`);
  }

  let slowDoc = null;
  if (slowFile) {
    slowDoc = readDoc(slowFile, 'slow-lane', reasons);
    if (slowDoc) {
      try {
        mergeSlowResults({}, slowDoc.results, slowExpected || listSlowTestFiles());
      } catch (e) {
        reasons.push(e.message);
      }
    }
  }

  let entries = null;
  try {
    entries = loadQuarantine(quarantineFile);
  } catch (e) {
    reasons.push(`invalid quarantine file: ${e.message}`);
  }

  return {
    integDoc, slowDoc, entries, reasons, expectedSha,
    previous: readPrevious(previousDir),
  };
}

/** Failure groups: new, quarantined (live entry), expired (entry lapsed). */
export function groupFailures(results, entries, now, platform) {
  if (!entries) {
    const failed = Object.entries(results).filter(([, r]) => r && r.passed === false).map(([file]) => ({ file })).sort((a, b) => a.file.localeCompare(b.file));
    return { fresh: failed, quarantined: [], expired: [] };
  }
  const { newFailures, quarantined } = classifyFailures(results, entries, now, platform);
  return {
    fresh: newFailures.filter((f) => !f.expired),
    quarantined,
    expired: newFailures.filter((f) => f.expired),
  };
}

export function computeVerdict({ reasons, groups }) {
  const newCount = groups.fresh.length + groups.expired.length;
  const q = groups.quarantined.length;
  if (reasons.length) {
    const more = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : '';
    return { verdict: 'BROKEN', headline: `BROKEN -- ${reasons[0]}${more}` };
  }
  if (newCount > 0) {
    return { verdict: 'FAIL', headline: `FAIL -- ${plural(newCount, 'new failure')}${q ? ` (${q} quarantined)` : ''}` };
  }
  return { verdict: 'PASS', headline: `PASS -- 0 new failures (${q} quarantined)` };
}

function errorExcerpt(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const head = lines.slice(0, ERROR_LINES).join('\n').trimEnd();
  return lines.length > ERROR_LINES ? `${head}\n...` : head;
}

function renderFileDetail(file, rec, note) {
  const failures = (rec && Array.isArray(rec.failures)) ? rec.failures : [];
  const failedCount = rec && rec.tests && typeof rec.tests.failed === 'number' && rec.tests.failed > 0
    ? rec.tests.failed : failures.length;
  const out = [
    '<details>',
    `<summary><code>${esc(file)}</code> -- ${plural(failedCount, 'failing test')}${note ? ` -- ${esc(note)}` : ''}</summary>`,
    '',
  ];
  if (failures.length === 0) out.push('<p>No per-test detail recorded for this file.</p>');
  // Blank line before <pre>: GFM then parses it as its own raw-HTML block
  // ending at </pre>, so blank lines inside an error stay inside the <pre>.
  for (const f of failures) {
    out.push(`<p><b>${esc(f.name)}</b></p>`, '', `<pre>${esc(errorExcerpt(f.error))}</pre>`, '');
  }
  if (failedCount > failures.length && failures.length) {
    out.push(`<p>... ${failedCount - failures.length} more failing test(s) not captured (see the artifact).</p>`);
  }
  out.push('</details>', '');
  return out;
}

function renderGroup(title, items, results, noteFor) {
  const lines = [`### ${title} (${items.length})`, ''];
  if (!items.length) return [...lines, 'None.', ''];
  items.slice(0, DETAIL_FILES_PER_GROUP).forEach((it) => lines.push(...renderFileDetail(it.file, results[it.file], noteFor(it))));
  const rest = items.slice(DETAIL_FILES_PER_GROUP);
  if (rest.length) {
    lines.push(`Plus ${rest.length} more (detail in the artifact):`, '');
    for (const it of rest) lines.push(`- \`${it.file}\`${noteFor(it) ? ` -- ${noteFor(it)}` : ''}`);
    lines.push('');
  }
  return lines;
}

function countRow(name, doc, present) {
  if (!present) return `| ${name} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`;
  const c = laneCounts(doc.results);
  const t = c.tests;
  const tc = (v) => (t ? `${v}${c.testsPartial ? '*' : ''}` : 'n/a');
  return `| ${name} | ${c.files.run} | ${c.files.passed} | ${c.files.failed} | ${tc(t && t.run)} | ${tc(t && t.passed)} | ${tc(t && t.failed)} | ${tc(t && t.skipped)} | ${formatDuration(laneDurationMs(doc))} |`;
}

/**
 * Pure renderer. Returns { verdict, headline, markdown }.
 */
export function renderNightlyReport({
  integDoc, slowDoc, entries, reasons = [], previous = null, expectedSha = null,
  now = new Date(), platform = process.platform, repoUrl = null, runUrl = null, artifactUrl = null,
  budgetMs = BUDGET_MS,
}) {
  const results = mergedResults(integDoc, slowDoc);
  const groups = groupFailures(results, entries, now, platform);
  const { verdict, headline } = computeVerdict({ reasons, groups });
  const sha = expectedSha || (integDoc && integDoc.headSha) || null;
  const shaText = sha ? (repoUrl ? `[\`${shortSha(sha)}\`](${repoUrl}/commit/${sha})` : `\`${shortSha(sha)}\``) : 'unknown';
  const date = `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  const md = [
    `## ${headline}`,
    '',
    `Nightly real-bd suite + slow lane. Tested commit ${shaText}, run ${date}. Advisory: this job never fails on test outcomes; CI is the verdict on main.`,
    '',
  ];
  if (reasons.length) {
    md.push('> [!CAUTION]', '> **BROKEN: the harness did not produce a trustworthy result.** Anything below is partial.', '>');
    for (const r of reasons) md.push(`> - ${r}`);
    md.push('');
  }

  const anyPartial = [integDoc, slowDoc].some((d) => d && laneCounts(d.results).testsPartial);
  md.push(
    '### Counts',
    '',
    '| Suite | Files run | Files passed | Files failed | Tests run | Tests passed | Tests failed | Tests skipped | Duration |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    countRow('real-bd suite', integDoc, !!integDoc),
    countRow('slow lane', slowDoc, !!slowDoc),
    '',
  );
  if (anyPartial) md.push('\\* some files recorded no per-test counts (crashed before reporting).', '');

  md.push(...renderGroup('New failures', groups.fresh, results, () => ''));
  md.push(...renderGroup('Quarantined failures', groups.quarantined, results,
    (q) => `quarantined until ${q.entry.expires}: ${q.entry.reason}`));
  md.push(...renderGroup('Expired-quarantine failures (count as new)', groups.expired, results,
    (f) => `quarantine expired ${f.expired.expires}; fix it or renew the entry`));

  const timed = Object.entries(results)
    .filter(([, r]) => r && typeof r.durationMs === 'number')
    .sort((a, b) => b[1].durationMs - a[1].durationMs)
    .slice(0, SLOWEST_N);
  const over = Object.values(results).filter((r) => r && typeof r.durationMs === 'number' && r.durationMs > budgetMs).length;
  md.push(`### Slowest files vs the ${Math.round(budgetMs / 1000)}s budget (advisory)`, '');
  if (!timed.length) md.push('No file durations recorded.', '');
  else {
    md.push(`${plural(over, 'file')} over budget.`, '', '| # | File | Duration | Budget |', '|---:|---|---:|---|');
    timed.forEach(([f, r], i) => md.push(`| ${i + 1} | \`${f}\` | ${formatDuration(r.durationMs)} | ${r.durationMs > budgetMs ? 'OVER' : 'ok'} |`));
    md.push('');
  }

  md.push('### Delta vs previous nightly run on main', '');
  if (!previous) md.push('No previous run to compare.', '');
  else {
    const prevRef = previous.runUrl ? `[previous run](${previous.runUrl})` : 'previous run';
    md.push(`Compared with the ${prevRef} at \`${shortSha(previous.headSha)}\`.`, '');
    const p = previous.results || {};
    const newlyFailing = Object.keys(results).filter((f) => results[f] && results[f].passed === false && !(p[f] && p[f].passed === false)).sort();
    const newlyPassing = Object.keys(results).filter((f) => results[f] && results[f].passed !== false && p[f] && p[f].passed === false).sort();
    md.push(`Newly failing (${newlyFailing.length}):`, '');
    if (newlyFailing.length) newlyFailing.forEach((f) => md.push(`- \`${f}\`${p[f] ? '' : ' (not run previously)'}`));
    else md.push('- none');
    md.push('', `Newly passing (${newlyPassing.length}):`, '');
    if (newlyPassing.length) newlyPassing.forEach((f) => md.push(`- \`${f}\``));
    else md.push('- none');
    md.push('');
  }

  md.push('### Links', '');
  md.push(`- Artifact (status files + run log): ${artifactUrl ? `[integ-suite-status](${artifactUrl})` : 'not uploaded'}`);
  md.push(`- Full log: ${runUrl ? `[workflow run](${runUrl})` : 'n/a'}`);
  md.push('');
  return { verdict, headline, markdown: md.join('\n') + '\n' };
}

function parseArgs(argv) {
  const get = (name) => {
    const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
    if (a === undefined) return null;
    return a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
  };
  const p = (v) => (v ? path.resolve(v) : null);
  return {
    statusFile: p(get('status')) || path.resolve('integ-suite-status.json'),
    slowFile: p(get('slow')),
    quarantineFile: p(get('quarantine')) || DEFAULT_QUARANTINE_FILE,
    integRc: get('integ-rc'),
    slowRc: get('slow-rc'),
    expectedSha: get('expected-sha') || null,
    previousDir: p(get('previous')),
    summaryFile: p(get('summary')),
    outputFile: p(get('github-output')),
    repoUrl: get('repo-url') || null,
    runUrl: get('run-url') || null,
    artifactUrl: get('artifact-url') || null,
  };
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  let report;
  try {
    const inputs = collectNightlyInputs(opts);
    report = renderNightlyReport({ ...inputs, repoUrl: opts.repoUrl, runUrl: opts.runUrl, artifactUrl: opts.artifactUrl });
  } catch (e) {
    const headline = `BROKEN -- summary renderer failed: ${e.message}`;
    report = { verdict: 'BROKEN', headline, markdown: `## ${headline}\n\nSee the job log.\n` };
  }
  const oneLine = report.headline.replace(/[\r\n]+/g, ' ');
  try { if (opts.summaryFile) appendFileSync(opts.summaryFile, report.markdown); } catch (e) {
    console.error(`[nightly-summary] could not write summary: ${e.message}`);
  }
  try { if (opts.outputFile) appendFileSync(opts.outputFile, `verdict=${report.verdict}\nheadline=${oneLine}\n`); } catch (e) {
    console.error(`[nightly-summary] could not write output: ${e.message}`);
  }
  // Annotations make the verdict visible without failing the job.
  if (report.verdict === 'BROKEN') console.log(`::error title=Nightly regression BROKEN::${oneLine}`);
  else if (report.verdict === 'FAIL') console.log(`::warning title=Nightly regression FAIL::${oneLine}`);
  console.log(`[nightly-summary] ${oneLine}`);
  // Also in the job log (step summaries are not retrievable via the API).
  console.log('::group::Nightly summary (markdown)');
  console.log(report.markdown);
  console.log('::endgroup::');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
  process.exit(0);
}
