#!/usr/bin/env node
/**
 * Extract telemetry from:
 *   logs/fleet-pm.log      — doer/reviewer per-call stats (primary source)
 *   raw-output.txt         — PM (Claude Code) token counts and wall time
 *   logs/*-session.jsonl   — fallback if fleet log has no entries for a member
 *
 * Fleet log exit-line format (tag=execute_prompt):
 *   {"ts":"...","level":"info","tag":"execute_prompt","inv":"xxx",
 *    "mid":"<id>","mem":"<name>","msg":"exit=0 in=N out=N elapsed=Nms"}
 *
 * Injects a `telemetry` array into results.json and prints a summary table.
 */
'use strict';
const fs = require('fs');

// ── Parsers ────────────────────────────────────────────────────────────────

function parseFleetLog(path) {
  // Returns { [memberName]: { tokIn, tokOut, durationMs, firstTs, lastTs } }
  const members = {};
  if (!fs.existsSync(path)) return members;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.tag !== 'execute_prompt' || !obj.mem) continue;
      // Exit lines carry elapsed=; entry lines do not
      const elapsedM = obj.msg && obj.msg.match(/elapsed=(\d+)ms/);
      if (!elapsedM) continue;
      const inM  = obj.msg.match(/\bin=(\d+)/);
      const outM = obj.msg.match(/\bout=(\d+)/);
      const mem  = obj.mem;
      if (!members[mem]) members[mem] = { tokIn: 0, tokOut: 0, durationMs: 0, firstTs: null, lastTs: null };
      members[mem].tokIn      += inM  ? parseInt(inM[1])      : 0;
      members[mem].tokOut     += outM ? parseInt(outM[1])     : 0;
      members[mem].durationMs += parseInt(elapsedM[1]);
      const endT   = new Date(obj.ts).getTime();
      const startT = endT - parseInt(elapsedM[1]);
      if (!members[mem].firstTs || startT < members[mem].firstTs) members[mem].firstTs = startT;
      if (!members[mem].lastTs  || endT   > members[mem].lastTs)  members[mem].lastTs  = endT;
    } catch {}
  }
  return members;
}

function parseSessionJsonl(path) {
  let tokIn = 0, tokOut = 0, firstTs = null, lastTs = null;
  if (!fs.existsSync(path)) return { tokIn, tokOut, firstTs, lastTs };
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.message?.usage) {
        tokIn  += obj.message.usage.input_tokens  || 0;
        tokOut += obj.message.usage.output_tokens || 0;
      }
      if (obj.timestamp) {
        const t = new Date(obj.timestamp).getTime();
        if (!firstTs || t < firstTs) firstTs = t;
        if (!lastTs  || t > lastTs)  lastTs  = t;
      }
    } catch {}
  }
  return { tokIn, tokOut, firstTs, lastTs };
}

function parsePmRawOutput(path) {
  let tokIn = 0, tokOut = 0, wallMs = 0, firstTs = null, lastTs = null;
  if (!fs.existsSync(path)) return { tokIn, tokOut, wallMs, firstTs, lastTs };
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
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
// Member names follow project conventions (e.g. fleet-dev, fleet-rev).
// Match by name pattern; fall back to token-count ordering (doer generates more).

function assignRoles(members) {
  const keys = Object.keys(members);
  if (keys.length === 0) return { doerKey: null, revKey: null };
  const doerPat = /dev|doer|impl/i;
  const revPat  = /rev|reviewer/i;
  const doerKey = keys.find(k => doerPat.test(k))
    ?? keys.sort((a, b) => members[b].tokOut - members[a].tokOut)[0];
  const revKey  = keys.find(k => revPat.test(k) && k !== doerKey)
    ?? keys.find(k => k !== doerKey) ?? null;
  return { doerKey, revKey };
}

function memberStats(key, members) {
  if (!key || !members[key]) return { wall_time_s: 0, active_time_s: 0, tokens_in: 0, tokens_out: 0, name: key || '' };
  const m = members[key];
  const wall = m.firstTs && m.lastTs ? Math.round((m.lastTs - m.firstTs) / 1000) : Math.round(m.durationMs / 1000);
  return { wall_time_s: wall, active_time_s: Math.round(m.durationMs / 1000), tokens_in: m.tokIn, tokens_out: m.tokOut, name: key };
}

function sessionStats(path) {
  const s = parseSessionJsonl(path);
  const wall = s.firstTs && s.lastTs ? Math.round((s.lastTs - s.firstTs) / 1000) : 0;
  return { wall_time_s: wall, active_time_s: wall, tokens_in: s.tokIn, tokens_out: s.tokOut, name: '' };
}

// ── Main ───────────────────────────────────────────────────────────────────

const fleetMembers = parseFleetLog('logs/fleet-pm.log');
const { doerKey, revKey } = assignRoles(fleetMembers);

const pm   = parsePmRawOutput('raw-output.txt');
const pmWall   = pm.firstTs && pm.lastTs ? Math.round((pm.lastTs - pm.firstTs) / 1000) : Math.round(pm.wallMs / 1000);
const pmActive = Math.round(pm.wallMs / 1000);

let doer = memberStats(doerKey, fleetMembers);
let rev  = memberStats(revKey,  fleetMembers);

// Fall back to session JSONLs if fleet log had no entries
if (doer.tokens_in === 0 && doer.tokens_out === 0) doer = sessionStats('logs/doer-session.jsonl');
if (rev.tokens_in  === 0 && rev.tokens_out  === 0) rev  = sessionStats('logs/reviewer-session.jsonl');

const telemetry = [
  { role: 'pm',       wall_time_s: pmWall,           active_time_s: pmActive,           tokens_in: pm.tokIn,   tokens_out: pm.tokOut,   tokens_total: pm.tokIn   + pm.tokOut   },
  { role: 'doer',     wall_time_s: doer.wall_time_s,  active_time_s: doer.active_time_s,  tokens_in: doer.tokens_in, tokens_out: doer.tokens_out, tokens_total: doer.tokens_in + doer.tokens_out },
  { role: 'reviewer', wall_time_s: rev.wall_time_s,   active_time_s: rev.active_time_s,   tokens_in: rev.tokens_in,  tokens_out: rev.tokens_out,  tokens_total: rev.tokens_in  + rev.tokens_out  },
];

// Inject into results.json
if (fs.existsSync('results.json')) {
  try {
    const r = JSON.parse(fs.readFileSync('results.json', 'utf8'));
    r.telemetry = telemetry;
    fs.writeFileSync('results.json', JSON.stringify(r, null, 2));
  } catch {}
}

// Print table
const hdr = 'Role        Member               Wall(s)  Active(s)  Tok-in   Tok-out    Total';
const sep = '-'.repeat(hdr.length);
console.log('\n' + hdr);
console.log(sep);
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
