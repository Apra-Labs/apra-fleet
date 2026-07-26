// Parse pm e2e checkpoints and telemetry.
//
// Checkpoints: primary source is the checkpoints.json file the orchestrator appends
// to (one JSON object per line); a stdout parser is provided as a fallback. A run
// passes when the terminal checkpoint is PASS, every expected checkpoint is PASS,
// and no checkpoint FAILED.
//
// Telemetry: token usage is parsed from the provider's stream-json output (cli.log).
// "all checks passed" alone is useless for tracking cost regressions run to run, so
// we surface tokens in/out and cache for every run.
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
