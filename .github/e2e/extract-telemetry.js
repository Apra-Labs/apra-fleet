#!/usr/bin/env node
/**
 * Extract telemetry for the three roles: pm, doer, reviewer.
 *
 * Sources and what each is good for:
 *
 *   raw-output.txt      PM token counts (assistant events) and wall/active time
 *                       (result event duration_ms). Authoritative for the PM.
 *
 *   logs/fleet-pm.log   Per-call timing for doer/reviewer: wall time (first/last
 *                       ts per member), active time (sum of elapsed= on
 *                       execute_prompt exit lines). NOT used for tokens because
 *                       some large execute_prompt calls omit usage data.
 *
 *   logs/*-session.jsonl  Member token counts. Each assistant turn records
 *                         input_tokens/output_tokens including all internal
 *                         reasoning turns within an execute_prompt call.
 *                         Authoritative for doer/reviewer tokens.
 *
 * Fleet log exit-line format:
 *   {"ts":"...","tag":"execute_prompt","mem":"<name>","msg":"exit=0 in=N out=N elapsed=Nms"}
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

// ── Parsers ────────────────────────────────────────────────────────────────

function parseFleetLog(path) {
  // Returns timing per member: { [name]: { durationMs, firstTs, lastTs } }
  // Tokens from fleet log are unreliable (some calls omit usage) — ignored here.
  const members = {};
  if (!existsSync(path)) return members;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj.mem) continue;
      const mem = obj.mem;
      if (!members[mem]) members[mem] = { durationMs: 0, firstTs: null, lastTs: null };
      // Accumulate active time from execute_prompt exit lines only
      if (obj.tag === 'execute_prompt') {
        const elapsedM = obj.msg && obj.msg.match(/elapsed=(\d+)ms/);
        if (elapsedM) {
          members[mem].durationMs += parseInt(elapsedM[1]);
        }
      }
      // Track wall time span from all log entries for this member
      const t = new Date(obj.ts).getTime();
      if (!isNaN(t)) {
        if (!members[mem].firstTs || t < members[mem].firstTs) members[mem].firstTs = t;
        if (!members[mem].lastTs  || t > members[mem].lastTs)  members[mem].lastTs  = t;
      }
    } catch {}
  }
  return members;
}

function parseSessionJsonl(path) {
  // Token counts from member session — counts all LLM turns including internal reasoning.
  let tokIn = 0, tokOut = 0;
  if (!existsSync(path)) return { tokIn, tokOut };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message?.usage) {
        tokIn  += obj.message.usage.input_tokens  || 0;
        tokOut += obj.message.usage.output_tokens || 0;
      }
    } catch {}
  }
  return { tokIn, tokOut };
}

function parsePmRawOutput(path) {
  let tokIn = 0, tokOut = 0, wallMs = 0, firstTs = null, lastTs = null;
  if (!existsSync(path)) return { tokIn, tokOut, wallMs, firstTs, lastTs };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message?.usage) {
        tokIn  += obj.message.usage.input_tokens  || 0;
        tokOut += obj.message.usage.output_tokens || 0;
      }
      if (obj.type === 'result' && obj.duration_ms) {
        wallMs = Math.max(wallMs, obj.duration_ms);
      }
      if (obj.timestamp) {
        const t = new Date(obj.timestamp).getTime();
        if (!firstTs || t < firstTs) firstTs = t;
        if (!lastTs  || t > lastTs)  lastTs  = t;
      }
    } catch {}
  }
  return { tokIn, tokOut, wallMs, firstTs, lastTs };
}

// ── Role assignment ────────────────────────────────────────────────────────

function assignRoles(timing) {
  const keys = Object.keys(timing);
  if (keys.length === 0) return { doerKey: null, revKey: null };
  const doerPat = /dev|doer|impl/i;
  const revPat  = /rev|reviewer/i;
  // Prefer name-pattern match; fall back to most active time = doer
  const doerKey = keys.find(k => doerPat.test(k))
    ?? keys.sort((a, b) => timing[b].durationMs - timing[a].durationMs)[0];
  const revKey  = keys.find(k => revPat.test(k) && k !== doerKey)
    ?? keys.find(k => k !== doerKey) ?? null;
  return { doerKey, revKey };
}

// ── Main ───────────────────────────────────────────────────────────────────

const fleetTiming = parseFleetLog('logs/fleet-pm.log');
const { doerKey, revKey } = assignRoles(fleetTiming);

// PM: tokens + timing from raw-output.txt
const pm      = parsePmRawOutput('raw-output.txt');
const pmWall  = pm.firstTs && pm.lastTs ? Math.round((pm.lastTs - pm.firstTs) / 1000) : Math.round(pm.wallMs / 1000);
const pmActive = Math.round(pm.wallMs / 1000);

// Doer/reviewer: timing from fleet log, tokens from session JSONLs
function memberRow(key, sessionPath) {
  const t    = key ? fleetTiming[key] : null;
  const wall = t && t.firstTs && t.lastTs ? Math.round((t.lastTs - t.firstTs) / 1000) : 0;
  const active = t ? Math.round(t.durationMs / 1000) : 0;
  const toks = parseSessionJsonl(sessionPath);
  return { wall_time_s: wall, active_time_s: active, tokens_in: toks.tokIn, tokens_out: toks.tokOut, name: key || '' };
}

const doer = memberRow(doerKey, 'logs/doer-session.jsonl');
const rev  = memberRow(revKey,  'logs/reviewer-session.jsonl');

const telemetry = [
  { role: 'pm',       wall_time_s: pmWall,           active_time_s: pmActive,           tokens_in: pm.tokIn,      tokens_out: pm.tokOut,      tokens_total: pm.tokIn    + pm.tokOut    },
  { role: 'doer',     wall_time_s: doer.wall_time_s,  active_time_s: doer.active_time_s,  tokens_in: doer.tokens_in, tokens_out: doer.tokens_out, tokens_total: doer.tokens_in + doer.tokens_out },
  { role: 'reviewer', wall_time_s: rev.wall_time_s,   active_time_s: rev.active_time_s,   tokens_in: rev.tokens_in,  tokens_out: rev.tokens_out,  tokens_total: rev.tokens_in  + rev.tokens_out  },
];

// Inject into results.json
if (existsSync('results.json')) {
  try {
    const r = JSON.parse(readFileSync('results.json', 'utf8'));
    r.telemetry = telemetry;
    writeFileSync('results.json', JSON.stringify(r, null, 2));
  } catch {}
}

// Print table
const hdr = 'Role        Member               Wall(s)  Active(s)  Tok-in   Tok-out    Total';
console.log('\n' + hdr);
console.log('-'.repeat(hdr.length));
const names = ['pm', doer.name || '-', rev.name || '-'];
for (let i = 0; i < telemetry.length; i++) {
  const t = telemetry[i];
  console.log(
    t.role.padEnd(12) +
    (names[i] || '').padEnd(21) +
    String(t.wall_time_s).padStart(7)  + '  ' +
    String(t.active_time_s).padStart(9) + '  ' +
    String(t.tokens_in).padStart(7)    + '  ' +
    String(t.tokens_out).padStart(8)   + '  ' +
    String(t.tokens_total).padStart(8)
  );
}
