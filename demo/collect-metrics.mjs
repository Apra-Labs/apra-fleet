#!/usr/bin/env node
// demo/collect-metrics.mjs
//
// Usage: node demo/collect-metrics.mjs <A|B> <sprint1|sprint2>
//
// Collects one metrics snapshot for one env+sprint from the sandbox that
// demo/setup-env.ps1 built, and appends it to demo/metrics-<env>.json (an
// array of snapshots -- one call per sprint, so run it once after sprint 1
// and again after sprint 2 for each env).
//
// What it reads (see demo/lib/metrics-lib.mjs for the readers):
//   - progress.json dispatches ledger (tokens/toolUses/ms per dispatch) --
//     DEGRADES to nulls+notes if the vendored v0.3.4 pm has no ledger, or the
//     sprint used the no-PLAN.md simple-sprint flow.
//   - git log --oneline commit counts in the sandbox repo.
//   - Env B only: kb_stats-equivalent via a direct, read-only node:sqlite
//     read of the sandbox's kb.sqlite (more robust than speaking the MCP
//     stdio protocol from a plain collector script); .fleet/kb-canonical.json
//     entry count + its own git log; usage.jsonl code-tool call counts
//     (filtered by repo path -- see the big note in metrics-lib.mjs about
//     usage.jsonl NOT being APRA_FLEET_DATA_DIR-isolated).
//
// Never throws on missing data: every reader returns nulls + a human-
// readable note instead. The one thing this script WILL fail loudly on is
// bad CLI usage or a sandbox dir that plainly does not exist.
//
// Env var overrides (mainly for demo/selftest.mjs, so tests never touch the
// operator's real ~/.apra-fleet or C:\ws_yash\demo-upgrade):
//   DEMO_SANDBOX_DIR   overrides the default sandbox path
//   DEMO_DATA_DIR      overrides the default per-env data dir
//   DEMO_METRICS_DIR   overrides where metrics-<env>.json is written (default: demo/)
//   DEMO_REAL_HOMEDIR  overrides the "real homedir" used for usage.jsonl

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, appendSnapshot } from './lib/metrics-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = path.resolve(__dirname);

const REAL_REPO_ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error('collect-metrics: ' + msg);
  process.exit(1);
}

const [, , envArg, sprintArg] = process.argv;
const env = (envArg || '').toUpperCase();
const sprint = sprintArg || '';

if (env !== 'A' && env !== 'B') {
  fail('first argument must be A or B (got ' + JSON.stringify(envArg) + ')\nUsage: node demo/collect-metrics.mjs <A|B> <sprint1|sprint2>');
}
if (sprint !== 'sprint1' && sprint !== 'sprint2') {
  fail('second argument must be sprint1 or sprint2 (got ' + JSON.stringify(sprintArg) + ')\nUsage: node demo/collect-metrics.mjs <A|B> <sprint1|sprint2>');
}

const sandboxDir = process.env.DEMO_SANDBOX_DIR
  || path.join('C:\\ws_yash\\demo-upgrade', 'sandbox-' + env.toLowerCase());
const dataDir = process.env.DEMO_DATA_DIR
  || path.join('C:\\ws_yash\\demo-upgrade', 'data-' + env.toLowerCase());
const metricsDir = process.env.DEMO_METRICS_DIR || DEMO_ROOT;
const realHomeDir = process.env.DEMO_REAL_HOMEDIR; // undefined -> os.homedir() inside the lib

// Safety net (constraint: never run against the real apra-fleet repo as a "sandbox").
const resolvedSandbox = path.resolve(sandboxDir);
if (resolvedSandbox === path.resolve(REAL_REPO_ROOT)) {
  fail('refusing to collect metrics with sandboxDir pointed at this repo (' + REAL_REPO_ROOT + ')');
}

if (!fs.existsSync(sandboxDir)) {
  fail('sandbox dir does not exist: ' + sandboxDir + '\nRun demo/setup-env.ps1 -Env ' + env + ' first (or set DEMO_SANDBOX_DIR for a test run).');
}

const metricsPath = path.join(metricsDir, 'metrics-' + env + '.json');

const snapshot = await buildSnapshot({ env, sprint, sandboxDir, dataDir, realHomeDir });
appendSnapshot(metricsPath, snapshot);

console.log('collect-metrics: appended snapshot for env=' + env + ' sprint=' + sprint + ' to ' + metricsPath);
if (snapshot.notes.length) {
  console.log('  notes:');
  for (const n of snapshot.notes) console.log('  - ' + n);
}
console.log('  git commits in sandbox: ' + (snapshot.git.commit_count ?? 'n/a'));
console.log('  progress ledger found: ' + snapshot.progress.found + (snapshot.progress.totals ? (' (tokens=' + snapshot.progress.totals.tokens + ', toolUses=' + snapshot.progress.totals.toolUses + ')') : ''));
if (env === 'B') {
  console.log('  kb.sqlite available: ' + (snapshot.kb && snapshot.kb.available));
  console.log('  bible present: ' + (snapshot.bible && snapshot.bible.present) + ' entries=' + (snapshot.bible && snapshot.bible.entries));
  console.log('  usage.jsonl calls matched to this sandbox: ' + (snapshot.usage && snapshot.usage.total_calls));
}
