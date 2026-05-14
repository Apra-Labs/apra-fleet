#!/usr/bin/env node
// Usage: node extract-results.mjs <raw-output.txt> <suite> <pm_os> <pm_provider>
// Reads CHECKPOINT lines from a Claude stream-json file and writes results.json to stdout.
import { readFileSync, existsSync } from 'node:fs';

const [rawOutputPath, suite, pmOs, pmProvider] = process.argv.slice(2);

if (!rawOutputPath) {
  process.stderr.write('Usage: extract-results.mjs <raw-output.txt> <suite> <pm_os> <pm_provider>\n');
  process.exit(1);
}

if (!existsSync(rawOutputPath)) {
  process.stdout.write(JSON.stringify({ overall: 'FAIL', error: `file not found: ${rawOutputPath}` }, null, 2) + '\n');
  process.exit(0);
}

const content = readFileSync(rawOutputPath, 'utf8');
const allTexts = [];

let currentMessage = '';
for (const line of content.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let obj;
  try { obj = JSON.parse(trimmed); } catch { continue; }

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

let checkpoints = null;
for (const text of allTexts) {
  for (const rawLine of text.split('\n')) {
    // Strip markdown decoration the LLM may have added: backticks, bold markers, whitespace
    const line = rawLine.trim()
      .replace(/^[`*_]+/, '').replace(/[`*_]+$/, '').trim();
    // Match CHECKPOINT: with optional whitespace after colon
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
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
