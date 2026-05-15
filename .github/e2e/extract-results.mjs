#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [rawOutputPath, suite, pmOs, pmProvider] = process.argv.slice(2);

if (!rawOutputPath) {
  process.stderr.write('Usage: extract-results.mjs <raw-output.txt> <suite> <pm_os> <pm_provider>\n');
  process.exit(1);
}

const runDir = rawOutputPath.split(/[\\/]/).slice(0, -1).join('/');

if (!existsSync(rawOutputPath)) {
  process.stdout.write(JSON.stringify({ overall: 'FAIL', error: `file not found: ${rawOutputPath}` }, null, 2) + '\n');
  process.exit(0);
}

const content = readFileSync(rawOutputPath, 'utf8');
const allTexts = [];

// 1. Extract PM text and token usage from stream-json output
let pmTokensIn = 0;
let pmTokensOut = 0;
let currentMessage = '';

for (const line of content.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let obj;
  try { obj = JSON.parse(trimmed); } catch { continue; }

  // Claude stream-json: end-of-session result carries cumulative usage
  if (obj.type === 'result' && obj.usage) {
    pmTokensIn += (obj.usage.input ?? obj.usage.input_tokens ?? 0);
    pmTokensOut += (obj.usage.output ?? obj.usage.output_tokens ?? 0);
  }

  if (obj.type === 'result' && obj.result) {
    if (currentMessage) { allTexts.push(currentMessage); currentMessage = ''; }
    allTexts.push(obj.result);
  } else if (obj.type === 'assistant') {
    if (currentMessage) { allTexts.push(currentMessage); currentMessage = ''; }
    for (const block of obj.message?.content ?? []) {
      if (block?.type === 'text' && block.text) allTexts.push(block.text);
    }
  } else if (obj.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
    currentMessage += obj.content;
  }
}
if (currentMessage) { allTexts.push(currentMessage); }

// 2. Sum member telemetry from ground-truth JSONL logs
const telemetry = [
  { role: 'pm', tokens_in: pmTokensIn, tokens_out: pmTokensOut }
];

function sumMemberLogs(role) {
  let in_t = 0;
  let out_t = 0;
  const dir = join(runDir, 'logs', role);
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.jsonl')) {
        const logContent = readFileSync(join(dir, file), 'utf8');
        for (const line of logContent.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.tokens) {
              in_t += (entry.tokens.input ?? entry.tokens.input_tokens ?? 0);
              out_t += (entry.tokens.output ?? entry.tokens.output_tokens ?? 0);
            }
          } catch {}
        }
      }
    }
  }
  return { tokens_in: in_t, tokens_out: out_t };
}

const doerStats = sumMemberLogs('doer');
telemetry.push({ role: 'doer', ...doerStats });

const reviewerStats = sumMemberLogs('reviewer');
telemetry.push({ role: 'reviewer', ...reviewerStats });

// 3. Reassemble fragmented PM JSON chunks and extract checkpoints
let checkpoints = null;
for (const text of allTexts) {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().replace(/^[\*_]+/, '').replace(/[*_]+$/, '').trim();
    const m = line.match(/^CHECKPOINT:\s*/);
    if (!m) continue;
    try {
      const parsed = JSON.parse(line.slice(m[0].length));
      if (Array.isArray(parsed)) checkpoints = parsed;
    } catch {}
  }
}

const results = checkpoints ?? [];
const overall = results.length === 0 || results.some(t => t.status === 'FAIL') ? 'FAIL' : 'PASS';

const report = {
  run: {
    suite,
    pm_os:       pmOs,
    pm_provider: pmProvider,
    timestamp:   new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  },
  results,
  overall,
  telemetry,
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
