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

function processRawFile(filePath, provider) {
  let assistantText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheCreate = 0;
  let cacheRead = 0;

  if (!existsSync(filePath)) {
    return { assistantText, tokensIn, tokensOut, cacheCreate, cacheRead };
  }

  const content = readFileSync(filePath, 'utf8');

  if (provider === 'agy') {
    // The raw file contains the stdout of the agy invocation. After agy exits,
    // fleet appends the transcript JSONL wrapped in FLEET_TRANSCRIPT_START/END markers.
    // We extract text from PLANNER_RESPONSE entries in the JSONL so that CHECKPOINT lines
    // embedded in the agent's responses can be detected.
    const startMarker = 'FLEET_TRANSCRIPT_START';
    const endMarker = 'FLEET_TRANSCRIPT_END';
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      const section = content.substring(startIdx + startMarker.length, endIdx);
      let extracted = '';
      for (const line of section.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry.type === 'PLANNER_RESPONSE' && entry.status === 'DONE' && typeof entry.content === 'string' && entry.content.trim()) {
            extracted += '\n' + entry.content.trim();
          }
        } catch { /* skip malformed lines */ }
      }
      return {
        assistantText: extracted || content,
        tokensIn: 0,
        tokensOut: 0,
        cacheCreate: 0,
        cacheRead: 0,
      };
    }
    // No markers: treat raw content as plain text (fallback for empty or unexpected output)
    return {
      assistantText: content,
      tokensIn: 0,
      tokensOut: 0,
      cacheCreate: 0,
      cacheRead: 0,
    };
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (provider === 'gemini') {
      // Gemini: accumulate from result event stats (input = non-cached input, cached = cache reads)
      if (obj.type === 'result' && obj.stats) {
        const s = obj.stats;
        tokensIn += (s.input ?? 0);
        tokensOut += (s.output_tokens ?? 0);
        cacheRead += (s.cached ?? 0);
        // cacheCreate stays 0: gemini does not report cache writes
      }
    } else {
      // Claude: sum usage across every assistant event (not just the final result turn)
      if (obj.type === 'assistant' && obj.message?.usage) {
        const u = obj.message.usage;
        tokensIn += (u.input_tokens ?? 0);
        tokensOut += (u.output_tokens ?? 0);
        cacheCreate += (u.cache_creation_input_tokens ?? 0);
        cacheRead += (u.cache_read_input_tokens ?? 0);
      }
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

  return { assistantText, tokensIn, tokensOut, cacheCreate, cacheRead };
}

// Phase labels: index 0 = setup, index 1 = sprint, extras get phase<n>
const phaseLabels = ['setup', 'sprint'];

let allAssistantText = '';
const pmPhases = [];

for (let i = 0; i < rawFiles.length; i++) {
  const label = phaseLabels[i] ?? `phase${i + 1}`;
  const result = processRawFile(rawFiles[i], pmProvider);
  allAssistantText += result.assistantText;
  pmPhases.push({
    role: `pm-${label}`,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    cache_creation_input_tokens: result.cacheCreate,
    cache_read_input_tokens: result.cacheRead,
  });
}

// Sum member telemetry from ground-truth JSONL logs
const telemetry = [...pmPhases];

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

// Extract checkpoints: one JSON object per "CHECKPOINT:" line (text-based, legacy)
let checkpoints = [];
const regex = /CHECKPOINT:\s*(\{[\s\S]*?\})/g;
let match;
while ((match = regex.exec(allAssistantText)) !== null) {
  try {
    const cp = JSON.parse(match[1]);
    if (cp && cp.id) {
      const existing = checkpoints.findIndex(c => c.id === cp.id);
      if (existing >= 0) checkpoints[existing] = cp;
      else checkpoints.push(cp);
    }
  } catch {}
}

// Also read file-based checkpoints written by the PM via Add-Content (agy-specific approach).
// These are more reliable -- the PM writes them as tool calls (no agy exit risk).
// File-based entries take precedence over text-based ones.
const checkpointFile = join(runDir, 'checkpoints.json');
if (existsSync(checkpointFile)) {
  for (const line of readFileSync(checkpointFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const cp = JSON.parse(line.trim());
      if (cp && cp.id) {
        const existing = checkpoints.findIndex(c => c.id === cp.id);
        if (existing >= 0) checkpoints[existing] = cp;
        else checkpoints.push(cp);
      }
    } catch {}
  }
}

// A phase passes only if its terminal checkpoint was emitted.
const TERMINALS = { setup: 'T2-done', sprint: 'T3-done' };
const requiredTerminals = [];
for (let i = 0; i < rawFiles.length; i++) {
  const label = phaseLabels[i];
  if (label && TERMINALS[label] && existsSync(rawFiles[i])) {
    requiredTerminals.push(TERMINALS[label]);
  }
}
const ids = new Set(checkpoints.map(c => c.id));
const missingTerminals = requiredTerminals.filter(t => !ids.has(t));
const hasFail = checkpoints.some(c => c.status === 'FAIL');
const overall = (checkpoints.length === 0 || hasFail || missingTerminals.length > 0) ? 'FAIL' : 'PASS';

const report = {
  run: {
    suite,
    pm_os:       pmOs,
    pm_provider: pmProvider,
    timestamp:   new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  },
  results: checkpoints,
  overall,
  missing_terminals: missingTerminals,
  telemetry,
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
