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
  process.stdout.write(JSON.stringify({ overall: 'FAIL', error: \ile not found: \ }, null, 2) + '\n');
  process.exit(0);
}

const content = readFileSync(rawOutputPath, 'utf8');

// 1. Reassemble ALL assistant text from ALL turns and chunks
let allAssistantText = '';
let pmTokensIn = 0;
let pmTokensOut = 0;

for (const line of content.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let obj;
  try { obj = JSON.parse(trimmed); } catch { continue; }

  // PM Usage (Claude/Gemini compatible)
  if (obj.type === 'result' && obj.usage) {
    pmTokensIn += (obj.usage.input ?? obj.usage.input_tokens ?? 0);
    pmTokensOut += (obj.usage.output ?? obj.usage.output_tokens ?? 0);
  }

  // Content reassembly
  if (obj.type === 'result' && obj.result) {
    allAssistantText += '\n' + obj.result;
  } else if (obj.type === 'assistant') {
    for (const block of obj.message?.content ?? []) {
      if (block?.type === 'text' && block.text) allAssistantText += '\n' + block.text;
    }
  } else if (obj.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
    allAssistantText += obj.content;
  }
}

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

telemetry.push({ role: 'doer', ...sumMemberLogs('doer') });
telemetry.push({ role: 'reviewer', ...sumMemberLogs('reviewer') });

// 3. Extract Checkpoints from the giant reassembled string
// We look for all CHECKPOINT: [...] patterns and take the last valid one.
let checkpoints = [];
const regex = /CHECKPOINT:\s*(\[.*?\])/g;
let match;
while ((match = regex.exec(allAssistantText)) !== null) {
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) checkpoints = parsed;
  } catch {}
}

const overall = checkpoints.length === 0 || checkpoints.some(t => t.status === 'FAIL') ? 'FAIL' : 'PASS';

const report = {
  run: {
    suite,
    pm_os:       pmOs,
    pm_provider: pmProvider,
    timestamp:   new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  },
  results: checkpoints,
  overall,
  telemetry,
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
