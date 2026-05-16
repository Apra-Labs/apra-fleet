#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

if (args.length < 4) {
  process.stderr.write('Usage: extract-results.mjs <suite> <pm_os> <pm_provider> <raw-file1> [raw-file2 ...]\n');
  process.exit(1);
}

const [suite, pmOs, pmProvider, ...rawFiles] = args;

const runDir = rawFiles[0].split(/[\\/]/).slice(0, -1).join('/');

function processRawFile(filePath) {
  let assistantText = '';
  let tokensIn = 0;
  let tokensOut = 0;

  if (!existsSync(filePath)) {
    return { assistantText, tokensIn, tokensOut };
  }

  const content = readFileSync(filePath, 'utf8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.type === 'result' && obj.usage) {
      tokensIn += (obj.usage.input ?? obj.usage.input_tokens ?? 0);
      tokensOut += (obj.usage.output ?? obj.usage.output_tokens ?? 0);
    }

    if (obj.type === 'result' && obj.result) {
      assistantText += '\n' + obj.result;
    } else if (obj.type === 'assistant') {
      for (const block of obj.message?.content ?? []) {
        if (block?.type === 'text' && block.text) assistantText += '\n' + block.text;
      }
    } else if (obj.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
      assistantText += obj.content;
    }
  }

  return { assistantText, tokensIn, tokensOut };
}

let allAssistantText = '';
let pmTokensIn = 0;
let pmTokensOut = 0;

for (const filePath of rawFiles) {
  const result = processRawFile(filePath);
  allAssistantText += result.assistantText;
  pmTokensIn += result.tokensIn;
  pmTokensOut += result.tokensOut;
}

// Sum member telemetry from ground-truth JSONL logs
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

// Extract Checkpoints from all phases merged
let checkpoints = [];
const regex = /CHECKPOINT:\s*(\[.*?\])/g;
let match;
while ((match = regex.exec(allAssistantText)) !== null) {
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) {
      for (const cp of parsed) {
        const existing = checkpoints.findIndex(c => c.test === cp.test);
        if (existing >= 0) {
          checkpoints[existing] = cp;
        } else {
          checkpoints.push(cp);
        }
      }
    }
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
