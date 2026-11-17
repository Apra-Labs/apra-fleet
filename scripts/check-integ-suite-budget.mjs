#!/usr/bin/env node
// Guard for apra-fleet-eft.17.2: assert the real-bd suite single-file
// performance budget documented in
// packages/apra-fleet-se/test/INTEG-SUITE.md step 7 -- no single real-bd
// test file should exceed ~5 minutes (300000ms) -- so a future regression in
// the shared-fixture dolt caching (apra-fleet-eft.17.1, test/helpers/
// bd-replay.mjs) is caught instead of silently reappearing.
//
// Reads results{}.durationMs from integ-suite-status.json (produced by
// `node scripts/run-integ-suites.mjs --start`, see that script's header and
// INTEG-SUITE.md) and reports/exits non-zero if any file exceeds the
// budget, naming the offending file(s).
//
// Usage (from the repo root, after a completed real-bd suite pass):
//   node scripts/check-integ-suite-budget.mjs [status-file-path] [--quarantine[=path]]
//       [--budget-advisory] [--slow=<slow-status-file>] [--summary=<markdown-file>]
//
// --quarantine also classifies every failed file as NEW or QUARANTINED
// against tests/regression/quarantine.json (or the given path). An entry
// matches by fingerprint (the results key, i.e. the test file name) and,
// when it has `os`, process.platform. An EXPIRED entry does not quarantine:
// its failure counts as new and is called out loudly.
//
// --budget-advisory reports over-budget files but keeps them out of the exit
// code (the nightly gate: only new/expired failures fail the job).
//
// --slow=<file> merges a second status file (the slow lane, written by
// scripts/integ-file-results-reporter.mjs) into the results under a `slow/`
// prefix, so slow-lane failures go through the same quarantine. Every
// packages/apra-fleet-se/test/slow/*.test.mjs must have a result there, else
// exit 2 (a crashed lane must never read as green).
//
// --summary=<file> appends a markdown summary (headSha, totals, new vs
// quarantined, budget offenders) to that file, e.g. $GITHUB_STEP_SUMMARY.
//
// Exit codes:
//   0 = no file over budget (and, with --quarantine, no new failures)
//   1 = one or more files over budget, or (with --quarantine) one or more
//       new failures
//   2 = fail-loud: no status file / no recorded results (run the suite via
//       scripts/run-integ-suites.mjs first), or an invalid quarantine file
//
// This is a point-in-time check against whatever pass most recently
// completed -- it does not itself run the suite. See INTEG-SUITE.md for the
// full procedure (start/poll/wait for completion) before running this.

import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Matches the "~5 minutes" single-file budget from INTEG-SUITE.md step 7.
export const BUDGET_MS = 300000;

export const SLOW_TEST_DIR = path.join(repoRoot, 'packages', 'apra-fleet-se', 'test', 'slow');
export const SLOW_PREFIX = 'slow/';

export const DEFAULT_QUARANTINE_FILE = path.join(repoRoot, 'tests', 'regression', 'quarantine.json');
export const MAX_QUARANTINE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a parsed quarantine document and return its entries.
 * Throws (fail-loud) on a missing field, a bad date, an expiry more than
 * MAX_QUARANTINE_DAYS after addedAt, or a duplicate fingerprint+os.
 */
export function validateQuarantine(doc) {
  if (!doc || !Array.isArray(doc.entries)) throw new Error('quarantine file has no "entries" array');
  const seen = new Set();
  for (const [i, e] of doc.entries.entries()) {
    const where = `quarantine entry #${i} (${e?.fingerprint ?? '?'})`;
    for (const k of ['fingerprint', 'bead', 'reason', 'addedAt', 'expires']) {
      if (typeof e?.[k] !== 'string' || e[k].trim() === '') throw new Error(`${where}: missing "${k}"`);
    }
    if (e.os !== undefined && typeof e.os !== 'string') throw new Error(`${where}: "os" must be a string`);
    for (const k of ['addedAt', 'expires']) {
      if (!DATE_RE.test(e[k]) || Number.isNaN(Date.parse(e[k]))) throw new Error(`${where}: "${k}" must be YYYY-MM-DD`);
    }
    const days = (Date.parse(e.expires) - Date.parse(e.addedAt)) / DAY_MS;
    if (days < 0 || days > MAX_QUARANTINE_DAYS) {
      throw new Error(`${where}: expires must be 0-${MAX_QUARANTINE_DAYS} days after addedAt (got ${days})`);
    }
    const key = `${e.fingerprint}|${e.os ?? '*'}`;
    if (seen.has(key)) throw new Error(`${where}: duplicate fingerprint`);
    seen.add(key);
  }
  return doc.entries;
}

export function loadQuarantine(filePath) {
  if (!existsSync(filePath)) throw new Error(`quarantine file not found: ${filePath}`);
  return validateQuarantine(JSON.parse(readFileSync(filePath, 'utf8')));
}

/** An entry is expired once the whole `expires` day (UTC) has passed. */
export function isExpired(entry, now = new Date()) {
  return now.getTime() >= Date.parse(entry.expires) + DAY_MS;
}

/**
 * Split failed files into new vs quarantined.
 * @returns {{ newFailures: {file: string, expired?: object}[], quarantined: {file: string, entry: object}[] }}
 */
export function classifyFailures(results, entries, now = new Date(), platform = process.platform) {
  const newFailures = [];
  const quarantined = [];
  const failed = Object.entries(results).filter(([, rec]) => rec && rec.passed === false).map(([f]) => f).sort();
  for (const file of failed) {
    const matches = entries.filter((e) => e.fingerprint === file && (!e.os || e.os === platform));
    const live = matches.find((e) => !isExpired(e, now));
    if (live) quarantined.push({ file, entry: live });
    else newFailures.push(matches.length ? { file, expired: matches[0] } : { file });
  }
  return { newFailures, quarantined };
}

/**
 * Load a run-integ-suites.mjs status file's `results` map from disk.
 *
 * Returns null (not a throw) when the file is missing, so callers can
 * distinguish "no run recorded yet" from a genuinely empty results map.
 * Throws if the file exists but is not parseable JSON, or lacks a
 * `results` object -- that is a corrupt/foreign file, not "no run yet".
 */
export function loadResults(statusFilePath) {
  if (!existsSync(statusFilePath)) return null;
  const parsed = JSON.parse(readFileSync(statusFilePath, 'utf8'));
  if (!parsed || typeof parsed.results !== 'object' || parsed.results === null) {
    throw new Error(`status file ${statusFilePath} has no "results" object`);
  }
  return parsed.results;
}

/**
 * Load the whole status document (results plus headSha/run metadata).
 * Same null/throw contract as loadResults.
 */
export function loadStatusDoc(statusFilePath) {
  if (!existsSync(statusFilePath)) return null;
  const parsed = JSON.parse(readFileSync(statusFilePath, 'utf8'));
  if (!parsed || typeof parsed.results !== 'object' || parsed.results === null) {
    throw new Error(`status file ${statusFilePath} has no "results" object`);
  }
  return parsed;
}

export function listSlowTestFiles(dir = SLOW_TEST_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
}

/**
 * Merge slow-lane results into the main results under the `slow/` prefix.
 * Throws (fail-loud) when an expected slow test file has no recorded result.
 */
export function mergeSlowResults(results, slowResults, expectedFiles) {
  const missing = expectedFiles.filter((f) => !slowResults[f]);
  if (missing.length) {
    throw new Error(`slow lane has no recorded result for: ${missing.join(', ')} (lane crashed or never ran?)`);
  }
  const merged = { ...results };
  for (const [f, rec] of Object.entries(slowResults)) merged[SLOW_PREFIX + f] = rec;
  return merged;
}

/** Render the markdown job summary (no tracking-issue ids: printed at runtime). */
export function renderSummary({ pass, headSha, results, budget, budgetAdvisory, newFailures, quarantined }) {
  const all = Object.values(results);
  const failed = all.filter((r) => r && r.passed === false).length;
  const lines = [
    '## Nightly real-bd suite gate',
    '',
    `- result: ${pass ? 'PASS' : 'FAIL'}`,
    `- headSha: ${headSha ?? 'unknown'}`,
    `- files: total=${all.length} pass=${all.length - failed} fail=${failed}`,
    `- failures: new=${newFailures.length} quarantined=${quarantined.length}`,
    '',
  ];
  if (newFailures.length) {
    lines.push('### New failures', '');
    for (const f of newFailures) {
      lines.push(`- ${f.file}${f.expired ? ` (quarantine EXPIRED on ${f.expired.expires})` : ''}`);
    }
    lines.push('');
  }
  if (quarantined.length) {
    lines.push('### Quarantined failures', '');
    for (const q of quarantined) lines.push(`- ${q.file} (until ${q.entry.expires}): ${q.entry.reason}`);
    lines.push('');
  }
  if (!budget.ok) {
    lines.push(`### Over the single-file budget${budgetAdvisory ? ' (advisory)' : ''}`, '');
    for (const o of budget.offenders) lines.push(`- ${o.file} (${Math.round(o.durationMs / 1000)}s)`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

/**
 * Check every file's recorded durationMs against the budget.
 *
 * @param {Record<string, {durationMs?: number}>} results
 * @param {number} budgetMs
 * @returns {{ ok: boolean, offenders: {file: string, durationMs: number}[], message: string }}
 */
export function checkBudget(results, budgetMs = BUDGET_MS) {
  const offenders = Object.entries(results)
    .filter(([, rec]) => typeof rec?.durationMs === 'number' && rec.durationMs > budgetMs)
    .map(([file, rec]) => ({ file, durationMs: rec.durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs);

  if (offenders.length === 0) {
    const budgetSeconds = Math.round(budgetMs / 1000);
    return {
      ok: true,
      offenders,
      message: `OK: all ${Object.keys(results).length} file(s) are within the ${budgetSeconds}s single-file budget.`,
    };
  }

  const budgetSeconds = Math.round(budgetMs / 1000);
  const detail = offenders
    .map((o) => `${o.file} (${Math.round(o.durationMs / 1000)}s)`)
    .join(', ');
  return {
    ok: false,
    offenders,
    message:
      `FAIL: ${offenders.length} file(s) exceed the ${budgetSeconds}s single-file budget: ${detail}`,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const qArg = argv.find((a) => a === '--quarantine' || a.startsWith('--quarantine='));
  const quarantineFile = qArg === undefined ? null
    : (qArg.includes('=') ? path.resolve(qArg.slice(qArg.indexOf('=') + 1)) : DEFAULT_QUARANTINE_FILE);
  const valueOf = (name) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    return a === undefined ? null : path.resolve(a.slice(a.indexOf('=') + 1));
  };
  const budgetAdvisory = argv.includes('--budget-advisory');
  const slowFile = valueOf('slow');
  const summaryFile = valueOf('summary');
  const statusFile = argv.find((a) => !a.startsWith('--')) ?? path.join(repoRoot, 'integ-suite-status.json');
  // Fail loud (exit 2), and say so in the job summary too when one is wanted.
  const die = (msg) => {
    console.error(`[check-integ-suite-budget] ERROR: ${msg}`);
    if (summaryFile) {
      try {
        appendFileSync(summaryFile, `## Nightly real-bd suite gate\n\n- result: FAIL (incomplete/invalid run)\n- ${msg}\n`);
      } catch { /* best-effort */ }
    }
    process.exit(2);
  };

  let entries = null;
  if (quarantineFile) {
    try {
      entries = loadQuarantine(quarantineFile);
    } catch (e) {
      die(`invalid quarantine file ${quarantineFile}: ${e.message}`);
    }
  }

  let doc;
  try {
    doc = loadStatusDoc(statusFile);
  } catch (e) {
    die(e.message);
  }

  if (doc === null) {
    die(`no status file at ${statusFile} -- run the suite first (see packages/apra-fleet-se/test/INTEG-SUITE.md).`);
  }
  let results = doc.results;
  if (Object.keys(results).length === 0) {
    die(`${statusFile} has zero recorded results -- run/finish the suite first (see packages/apra-fleet-se/test/INTEG-SUITE.md).`);
  }

  if (slowFile) {
    try {
      const slowDoc = loadStatusDoc(slowFile);
      if (slowDoc === null) throw new Error(`no slow-lane status file at ${slowFile}`);
      results = mergeSlowResults(results, slowDoc.results, listSlowTestFiles());
    } catch (e) {
      die(e.message);
    }
  }

  const result = checkBudget(results);
  console.log(`[check-integ-suite-budget] ${result.message}${!result.ok && budgetAdvisory ? ' (advisory, not gating)' : ''}`);
  let newCount = 0;
  let newFailures = [];
  let quarantined = [];
  if (entries) {
    ({ newFailures, quarantined } = classifyFailures(results, entries));
    newCount = newFailures.length;
    console.log(`[check-integ-suite-budget] failures: new=${newFailures.length} quarantined=${quarantined.length}`);
    for (const f of newFailures) {
      if (f.expired) {
        console.log(`[check-integ-suite-budget]   NEW ${f.file} -- quarantine EXPIRED on ${f.expired.expires}; fix it or renew the entry`);
      } else {
        console.log(`[check-integ-suite-budget]   NEW ${f.file}`);
      }
    }
    for (const q of quarantined) {
      console.log(`[check-integ-suite-budget]   quarantined ${q.file} (until ${q.entry.expires}): ${q.entry.reason}`);
    }
    if (quarantined.length) console.log(`[check-integ-suite-budget]   tracking issue per entry: see ${quarantineFile}`);
  } else {
    newFailures = Object.entries(results).filter(([, r]) => r && r.passed === false).map(([file]) => ({ file }));
  }
  const pass = (result.ok || budgetAdvisory) && newCount === 0;
  if (summaryFile) {
    appendFileSync(summaryFile, renderSummary({
      pass, headSha: doc.headSha, results, budget: result, budgetAdvisory, newFailures, quarantined,
    }));
  }
  process.exit(pass ? 0 : 1);
}

// Only run when invoked directly (not when imported for tests).
// Windows-safe self-execution guard (same defect class as stabilization
// Issue 36 / apra-fleet-eft.41): a raw `file://${argv[1]}` comparison can
// never match on Windows (backslashes, drive-letter URL encoding), so main()
// silently never ran there -- the script exited 0 with no output regardless
// of budget state (windows-latest CI run 29866815136). Compare canonical
// file URLs on both sides instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
