#!/usr/bin/env node
// Parse e2e checkpoints and provider telemetry (shared by the fleet and pm harnesses).
//
// Two entry paths, unioned here:
//   - Library API (imported by packages/apra-fleet-se/apra-pm/e2e/run-e2e.mjs):
//       parseCheckpointsFile / parseCheckpointsStdout / checkpointsHaveTerminal -- checkpoint
//       pass/fail evaluation; parseTelemetryFile -- token accounting from a provider's
//       stream-json log (claude usage events, gemini result.stats, agy brain-dir transcripts);
//       diagnoseFailure -- one-line failure reason from the last result event.
//   - CLI (invoked by .github/workflows/fleet-e2e.yml): assembles a results.json report from
//       one or more raw provider logs (claude JSONL, gemini result.stats, opencode parts, agy
//       FLEET_TRANSCRIPT-wrapped transcript) plus member-log JSONL, and writes it to stdout.
//
// Checkpoints: primary source is the checkpoints.json file the orchestrator appends
// to (one JSON object per line); a stdout parser is provided as a fallback. A run
// passes when the terminal checkpoint is PASS, every expected checkpoint is PASS,
// and no checkpoint FAILED.
//
// Telemetry: "all checks passed" alone is useless for tracking cost regressions run to
// run, so we surface tokens in/out and cache for every run.
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- checkpoints

function evaluate(checkpoints, terminal, expected) {
  const isPass = (c) => String(c.status).toUpperCase() === 'PASS';
  const anyFail = checkpoints.some((c) => String(c.status).toUpperCase() === 'FAIL');
  const term = checkpoints.find((c) => c.id === terminal && isPass(c));
  const missing = expected.filter((id) => !checkpoints.some((c) => c.id === id && isPass(c)));
  const pass = !!term && !anyFail && missing.length === 0;
  let reason = '';
  if (anyFail) reason = 'a checkpoint FAILED';
  else if (!term) reason = `terminal "${terminal}" missing`;
  else if (missing.length) reason = `missing: ${missing.join(', ')}`;
  return { checkpoints, pass, reason, missing };
}

function collect(text, re) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    try { out.push(JSON.parse(m[m.length - 1])); } catch { /* skip malformed */ }
  }
  return out;
}

export function parseCheckpointsFile(file, terminal, expected = []) {
  if (!fs.existsSync(file)) return { checkpoints: [], pass: false, reason: 'no checkpoints.json', missing: expected };
  return evaluate(collect(fs.readFileSync(file, 'utf-8'), /(\{.*\})\s*$/), terminal, expected);
}

export function parseCheckpointsStdout(stdout, terminal, expected = []) {
  return evaluate(collect(stdout, /CHECKPOINT:\s*(\{.*\})/), terminal, expected);
}

// Does the checkpoints file already carry the terminal step? Used by the agy resume
// loop to decide whether another --continue pass is needed.
export function checkpointsHaveTerminal(file, terminal) {
  if (!fs.existsSync(file)) return false;
  for (const c of collect(fs.readFileSync(file, 'utf-8'), /(\{.*\})\s*$/)) {
    if (c.id === terminal && String(c.status).toUpperCase() === 'PASS') return true;
  }
  return false;
}

// ----------------------------------------------------------------- telemetry

const EMPTY_TELEMETRY = { tokens_in: 0, tokens_out: 0, cache_creation: 0, cache_read: 0, available: false };

// Sum token usage from a provider's stream-json output.
//   claude: usage on every `assistant` event (includes subagent turns in-process)
//   gemini: `result` event `stats` (input = non-cached input, cached = cache reads)
//   agy:    transcript carries no token counts -> reported as unavailable
export function parseTelemetryFile(file, provider) {
  if (!fs.existsSync(file)) return { ...EMPTY_TELEMETRY };

  const content = fs.readFileSync(file, 'utf-8');

  if (provider === 'agy') {
    const ESTIMATED_OVERHEAD_PER_STEP = 1000; // Estimated prompt overhead for tool declarations, system instructions, and workspace schemas passed on each turn.
    let tIn = 0, tOut = 0, seen = false;

    // Find ONLY the parent conversation ID by matching the run's work dir against the cache,
    // exactly as run-e2e.mjs does.
    const norm = p => path.resolve(p).toLowerCase().split(path.sep).join('/');
    const target = norm(path.dirname(file));
    let parentCid = '';

    const home = process.env.USERPROFILE || process.env.HOME || '';
    const brainDir = path.join(home, '.gemini', 'antigravity-cli', 'brain');

    try {
      const cachePath = path.join(home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
      if (fs.existsSync(cachePath)) {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const k of Object.keys(cache)) {
          if (norm(k) === target) {
            parentCid = cache[k];
            break;
          }
        }
      }
    } catch {
      // ignore
    }

    const convIds = new Set();
    if (parentCid) {
      convIds.add(parentCid);

      // Parse the parent transcript to find all subagent conversation IDs that were spawned.
      const parentTranscriptPath = path.join(brainDir, parentCid, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(parentTranscriptPath)) {
        try {
          const parentTranscriptContent = fs.readFileSync(parentTranscriptPath, 'utf-8');
          const re = /"conversationId":\s*"([a-f0-9-]+)"/gi;
          let match;
          while ((match = re.exec(parentTranscriptContent)) !== null) {
            convIds.add(match[1]);
          }
        } catch {
          // ignore
        }
      }
    }

    for (const cid of convIds) {
      const tp = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(tp)) continue;

      seen = true;
      try {
        const transcriptLines = fs.readFileSync(tp, 'utf-8').split(/\r?\n/);
        for (const line of transcriptLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const step = JSON.parse(trimmed);

          const source = step.source;
          const stepContent = step.content || '';
          const thinking = step.thinking || '';

          if (source === 'MODEL') {
            tOut += Math.ceil((stepContent.length + thinking.length) / 4);
          } else {
            tIn += Math.ceil(stepContent.length / 4);
          }
          tIn += ESTIMATED_OVERHEAD_PER_STEP;
        }
      } catch {
        // ignore
      }
    }

    // Fallback if no transcripts found in brain directory (e.g. CI cleanup)
    if (!seen && content.length > 0) {
      tIn = Math.ceil(content.length / 3);
      tOut = Math.ceil(content.length / 8);
      seen = true;
    }

    return { tokens_in: tIn, tokens_out: tOut, cache_creation: 0, cache_read: 0, available: seen, estimated: true };
  }

  let tIn = 0, tOut = 0, cCreate = 0, cRead = 0, seen = false;

  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }

    if (provider === 'gemini') {
      if (o.type === 'result' && o.stats) {
        const s = o.stats;
        tIn += (s.input ?? 0);
        tOut += (s.output_tokens ?? 0);
        cRead += (s.cached ?? 0);
        seen = true;
      }
    } else { // claude
      if (o.type === 'assistant' && o.message?.usage) {
        const u = o.message.usage;
        tIn += (u.input_tokens ?? 0);
        tOut += (u.output_tokens ?? 0);
        cCreate += (u.cache_creation_input_tokens ?? 0);
        cRead += (u.cache_read_input_tokens ?? 0);
        seen = true;
      }
    }
  }

  return { tokens_in: tIn, tokens_out: tOut, cache_creation: cCreate, cache_read: cRead, available: seen };
}

// Best-effort one-line failure reason from a stream-json log: the last `result`
// event's subtype + truncated text. Turns an opaque timeout into a diagnosis.
export function diagnoseFailure(file) {
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type === 'result') {
      const subtype = o.subtype || (o.is_error ? 'error' : '?');
      const msg = (o.result || o.error || '').toString().replace(/\s+/g, ' ').slice(0, 200);
      return `${subtype}${msg ? ': ' + msg : ''}`;
    }
  }
  return '';
}

// ---------------------------------------------------- CLI report assembly (fleet)

// Parse a single raw provider log into assistant text + token usage. Handles the agy
// FLEET_TRANSCRIPT-wrapped transcript, opencode parts, gemini result.stats, and claude
// assistant/result events.
function processRawFile(filePath, provider) {
  let assistantText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheCreate = 0;
  let cacheRead = 0;

  if (!fs.existsSync(filePath)) {
    return { assistantText, tokensIn, tokensOut, cacheCreate, cacheRead };
  }

  const content = fs.readFileSync(filePath, 'utf8');

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

  if (provider === 'opencode') {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }
      if (obj.type === 'text' && obj.part?.text) {
        assistantText += '\n' + obj.part.text;
      }
      if (obj.type === 'step_finish' && obj.part?.tokens) {
        const t = obj.part.tokens;
        tokensIn += (t.input ?? 0);
        tokensOut += (t.output ?? 0);
        cacheCreate += (t.cache?.write ?? 0);
        cacheRead += (t.cache?.read ?? 0);
      }
    }
    return { assistantText, tokensIn, tokensOut, cacheCreate, cacheRead };
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

// Sum member telemetry from ground-truth JSONL logs under <runDir>/logs/<member>/.
function sumMemberLogs(runDir, memberName) {
  let in_t = 0;
  let out_t = 0;
  const dir = path.join(runDir, 'logs', memberName);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.jsonl')) {
        const logContent = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const line of logContent.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            // Claude session JSONL: usage lives on assistant events at
            // message.usage.{input,output}_tokens, not a top-level "tokens" field.
            if (entry.type === 'assistant' && entry.message?.usage) {
              in_t += (entry.message.usage.input_tokens ?? 0);
              out_t += (entry.message.usage.output_tokens ?? 0);
            }
          } catch {}
        }
      }
    }
  }
  return { tokens_in: in_t, tokens_out: out_t };
}

// Assemble the fleet results.json report from raw provider logs + member logs.
function runCli() {
  const args = process.argv.slice(2);

  if (args.length < 4) {
    process.stderr.write('Usage: extract-results.mjs <suite> <pm_os> <pm_provider> <raw-file1> [raw-file2 ...]\n');
    process.exit(1);
  }

  const [suite, pmOs, pmProvider, ...rawFiles] = args;

  const runDir = rawFiles[0].split(/[\\/]/).slice(0, -1).join('/');

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
  telemetry.push({ role: 'doer', ...sumMemberLogs(runDir, 'alice') });
  telemetry.push({ role: 'reviewer', ...sumMemberLogs(runDir, 'bella') });

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
  const checkpointFile = path.join(runDir, 'checkpoints.json');
  if (fs.existsSync(checkpointFile)) {
    for (const line of fs.readFileSync(checkpointFile, 'utf8').split('\n')) {
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
    if (label && TERMINALS[label] && fs.existsSync(rawFiles[i])) {
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
}

// ---- CLI entry ----------------------------------------------------------------
// Import-safe: the guard is false when another module imports this file.

if (process.argv[1] && (process.argv[1].endsWith('extract-results.mjs') || process.argv[1].endsWith('extract-results'))) {
  runCli();
}
