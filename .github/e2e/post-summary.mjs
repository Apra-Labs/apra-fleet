#!/usr/bin/env node
import { readFileSync, existsSync, appendFileSync } from 'node:fs';

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const suite = process.env.SUITE || 'unknown';

function append(line) {
  if (summaryFile) appendFileSync(summaryFile, line + '\n');
  else console.log(line);
}

let report = {};
try {
  report = JSON.parse(readFileSync('results.json', 'utf8'));
} catch {
  append(`## Fleet E2E – Suite ${suite}`);
  append('');
  append('**Overall: FAIL** — could not read results.json');
  process.exit(0);
}

append(`## Fleet E2E – Suite ${suite}`);
append('');
append('| Test | Status | Notes |');
append('|------|--------|-------|');

for (const t of report.results ?? []) {
  const notes = (t.notes ?? '').replace(/\|/g, '\\|');
  append(`| ${t.test} | ${t.status} | ${notes} |`);
}
if (!(report.results ?? []).length) {
  append('| — | — | No test results recorded |');
}

append('');
append(`**Overall: ${report.overall ?? 'FAIL'}**`);
append('');

if (Array.isArray(report.telemetry) && report.telemetry.length > 0) {
  append('### Telemetry');
  append('');
  append('| Role | Wall (s) | Active (s) | Tokens In | Tokens Out | Total |');
  append('|------|----------|------------|-----------|------------|-------|');
  for (const t of report.telemetry) {
    append(`| ${t.role} | ${t.wall_time_s} | ${t.active_time_s} | ${t.tokens_in} | ${t.tokens_out} | ${t.tokens_total} |`);
  }
}
