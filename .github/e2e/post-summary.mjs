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
