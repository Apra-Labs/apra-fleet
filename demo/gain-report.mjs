#!/usr/bin/env node
// demo/gain-report.mjs
//
// Usage: node demo/gain-report.mjs
//
// Reads demo/metrics-A.json + demo/metrics-B.json (each an array of
// snapshots written by collect-metrics.mjs) and writes demo/gain-report.html:
// a side-by-side table per sprint (tokens, dispatches, tool uses, wall-clock,
// doer model mix), the sprint-2-vs-sprint-2 delta headline, an Env-B-only
// capabilities section (KB entries, bible commits, retrieval hits), and an
// honest footnote listing exactly what data was unavailable.
//
// Env var overrides (for demo/selftest.mjs):
//   DEMO_METRICS_A   overrides the path to metrics-A.json
//   DEMO_METRICS_B   overrides the path to metrics-B.json
//   DEMO_REPORT_OUT  overrides the output HTML path

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGainReportHtml } from './lib/metrics-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const metricsAPath = process.env.DEMO_METRICS_A || path.join(__dirname, 'metrics-A.json');
const metricsBPath = process.env.DEMO_METRICS_B || path.join(__dirname, 'metrics-B.json');
const outPath = process.env.DEMO_REPORT_OUT || path.join(__dirname, 'gain-report.html');

function readMetrics(p) {
  if (!fs.existsSync(p)) {
    console.warn('gain-report: ' + p + ' not found -- treating as no snapshots collected yet');
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('gain-report: ' + p + ' failed to parse (' + (err && err.message ? err.message : String(err)) + ') -- treating as no snapshots collected yet');
    return [];
  }
}

const metricsA = readMetrics(metricsAPath);
const metricsB = readMetrics(metricsBPath);

const html = buildGainReportHtml(metricsA, metricsB);
fs.writeFileSync(outPath, html);

console.log('gain-report: wrote ' + outPath);
console.log('  Env A snapshots: ' + metricsA.length + ' (' + metricsAPath + ')');
console.log('  Env B snapshots: ' + metricsB.length + ' (' + metricsBPath + ')');
