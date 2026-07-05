import fs from 'node:fs';
import path from 'node:path';
import { getAllAgents } from '../services/registry.js';
import { resolveSessionLogDir } from '../services/stall/index.js';
import {
  enrichMember,
  groupByProject,
  projectKey,
  projectKeyForDir,
  type MemberContext,
} from '../services/watch/project-resolver.js';
import { formatTranscriptLine, type FormattedEvent, type LineKind } from '../services/watch/transcript-formatter.js';
import {
  resolveFleetLogFile,
  formatFleetLogLine,
  readRecentActivity,
  type RecentActivity,
} from '../services/watch/fleet-log.js';
import type { Agent } from '../types.js';

const ACTIVE_WINDOW_MS = 90_000; // a member is "active" if it produced activity within this window
const POLL_INTERVAL_MS = 700;

const COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[35m', '\x1b[34m', '\x1b[31m', '\x1b[96m', '\x1b[92m'];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

const useColor = (): boolean => process.stdout.isTTY === true && !process.env.NO_COLOR;

// ---------------------------------------------------------------------------
// Sources. Two kinds of activity are merged per member:
//   1. Fleet activity log (universal spine) -- every dispatch the server makes,
//      for local AND remote members, tailed once from the local fleet log.
//   2. Provider transcript (local members only) -- the LLM session's rich
//      reasoning/edits/output, tailed per local member.
// ---------------------------------------------------------------------------

interface Follower {
  agent: Agent;
  provider: string;
  color: string;
  // transcript state (local members with a resolvable provider log dir; else null)
  txDir: string | null;
  txFile: string | null;
  txOffset: number;
  txLeftover: string;
  txBackfilled: boolean;
}

interface FleetLogState {
  file: string | null;
  offset: number;
  leftover: string;
  backfilled: boolean;
  mtime: number;
}

/** Newest *.jsonl in a directory, or null. */
function newestTranscript(dir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestM = -1;
  for (const f of entries) {
    const full = path.join(dir, f);
    try {
      const m = fs.statSync(full).mtimeMs;
      if (m > bestM) { bestM = m; best = full; }
    } catch { /* ignore */ }
  }
  return best;
}

function mtimeOf(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** Read the last non-empty formatted transcript event, for overview status. */
function lastTranscriptText(provider: string, file: string): { ms: number; text: string } | null {
  let content: string;
  try { content = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const events = formatTranscriptLine(provider, lines[i]);
    if (events.length > 0) return { ms: mtimeOf(file), text: events[events.length - 1].text };
  }
  return null;
}

interface Activity { active: boolean; lastText: string | null; txDir: string | null; txFile: string | null; }

/**
 * Overview status for a member. Activity is universal (from the fleet log);
 * the transcript adds a richer "last did" snippet for local members.
 */
function activityOf(agent: Agent, recent: Map<string, RecentActivity>): Activity {
  const isLocal = agent.agentType !== 'remote';
  const provider = agent.llmProvider ?? 'claude';

  let txDir: string | null = null;
  let txFile: string | null = null;
  let txMs = 0;
  let txText: string | null = null;
  if (isLocal) {
    txDir = resolveSessionLogDir(provider as any, agent.workFolder);
    if (txDir) {
      txFile = newestTranscript(txDir);
      if (txFile) {
        const last = lastTranscriptText(provider, txFile);
        if (last) { txMs = last.ms; txText = last.text; }
      }
    }
  }

  const rec = recent.get(agent.id) ?? recent.get(agent.friendlyName.toLowerCase());
  const flMs = rec?.ms ?? 0;
  const flText = rec?.text ?? null;

  const lastMs = Math.max(txMs, flMs);
  const active = lastMs > 0 && Date.now() - lastMs < ACTIVE_WINDOW_MS;
  const lastText = txMs >= flMs ? (txText ?? flText) : (flText ?? txText);
  return { active, lastText, txDir, txFile };
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

export async function runWatch(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { printUsage(); process.exit(0); }

  if (args.includes('--complete')) {
    for (const a of getAllAgents()) console.log(a.friendlyName);
    process.exit(0);
  }

  const listOnly = args.includes('--list');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const projectDir = parseFlagValue(args, '--project');
  const feature = parseFlagValue(args, '--feature') ?? parseFlagValue(args, '--branch');
  const tailN = parseInt(parseFlagValue(args, '--tail') ?? '0', 10) || 0;

  const flagsWithValues = new Set(['--project', '--feature', '--branch', '--tail']);
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) { if (flagsWithValues.has(a)) i++; continue; }
    names.push(a);
  }

  const contexts = getAllAgents().map(enrichMember);
  if (contexts.length === 0) {
    console.log('No members registered. Use register_member to add one.');
    process.exit(0);
  }

  // --- Determine scope ---
  let scope = contexts;
  let scopeLabel = 'fleet';

  if (names.length > 0) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    scope = contexts.filter((c) => wanted.has(c.agent.friendlyName.toLowerCase()));
    scopeLabel = names.join(', ');
    const found = new Set(scope.map((c) => c.agent.friendlyName.toLowerCase()));
    const missing = names.filter((n) => !found.has(n.toLowerCase()));
    if (missing.length > 0) {
      console.error(`Unknown member(s): ${missing.join(', ')}`);
      console.error(`Known members: ${contexts.map((c) => c.agent.friendlyName).join(', ')}`);
      process.exit(1);
    }
  } else if (projectDir) {
    const key = projectKeyForDir(projectDir);
    scope = contexts.filter((c) => projectKey(c) === key);
    scopeLabel = path.basename(path.resolve(projectDir));
  } else {
    const cwdKey = projectKeyForDir(process.cwd());
    const inCwd = contexts.filter((c) => projectKey(c) === cwdKey);
    if (inCwd.length > 0) { scope = inCwd; scopeLabel = path.basename(process.cwd()); }
  }

  if (feature) {
    const f = feature.toLowerCase();
    scope = scope.filter((c) => c.branch != null && (c.branch.toLowerCase() === f || c.branch.toLowerCase().includes(f)));
  }

  if (scope.length === 0) {
    console.log(`No members in scope (${scopeLabel}).`);
    process.exit(0);
  }

  const fleetLogFile = resolveFleetLogFile();
  const recent = fleetLogFile ? readRecentActivity(fleetLogFile) : new Map<string, RecentActivity>();

  // --- Overview ---
  printOverview(scope, recent);
  if (listOnly) process.exit(0);

  // --- Build follow set: every member in scope (fleet log covers all) ---
  const followers: Follower[] = [];
  const byKey = new Map<string, Follower>();
  let colorIdx = 0;
  for (const ctx of scope) {
    const isLocal = ctx.agent.agentType !== 'remote';
    const provider = ctx.agent.llmProvider ?? 'claude';
    const txDir = isLocal ? resolveSessionLogDir(provider as any, ctx.agent.workFolder) : null;
    const f: Follower = {
      agent: ctx.agent,
      provider,
      color: COLORS[colorIdx++ % COLORS.length],
      txDir,
      txFile: txDir ? newestTranscript(txDir) : null,
      txOffset: 0,
      txLeftover: '',
      txBackfilled: false,
    };
    followers.push(f);
    byKey.set(ctx.agent.friendlyName.toLowerCase(), f);
    byKey.set(ctx.agent.id, f);
  }

  const single = followers.length === 1;
  console.log('');
  console.log(`${DIM}Following ${followers.length} member(s); idle ones stream when they start. Press Ctrl-C to stop.${RESET}`);
  if (!fleetLogFile) console.log(`${DIM}(no fleet server log found -- command activity will not show until the server logs one)${RESET}`);
  console.log('');

  const fl: FleetLogState = {
    file: fleetLogFile, offset: 0, leftover: '', backfilled: false,
    mtime: fleetLogFile ? mtimeOf(fleetLogFile) : 0,
  };

  // Prime (with optional backfill), then poll.
  pumpFleetLog(fl, byKey, single, tailN, verbose);
  for (const f of followers) pumpTranscript(f, single, tailN, verbose);

  const timer = setInterval(() => {
    // The server rolls its log on restart (new pid). Follow a STRICTLY newer log
    // (not just any different one -- short-lived servers create noise logs with
    // fresh mtimes), and jump to its END rather than replaying its history.
    const newestLog = resolveFleetLogFile();
    if (newestLog && newestLog !== fl.file) {
      const m = mtimeOf(newestLog);
      if (m > fl.mtime) {
        fl.file = newestLog;
        fl.mtime = m;
        try { fl.offset = fs.statSync(newestLog).size; } catch { fl.offset = 0; }
        fl.leftover = '';
        fl.backfilled = true;
      }
    }
    pumpFleetLog(fl, byKey, single, 0, verbose);

    for (const f of followers) {
      if (!f.txDir) continue;
      const newest = newestTranscript(f.txDir);
      if (newest && newest !== f.txFile) {
        f.txFile = newest; f.txOffset = 0; f.txLeftover = ''; f.txBackfilled = true;
      }
      pumpTranscript(f, single, 0, verbose);
    }
  }, POLL_INTERVAL_MS);

  const stop = () => { clearInterval(timer); console.log(''); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** Read appended bytes of a file since `offset`; returns new complete lines. */
function readNewLines(
  file: string,
  state: { offset: number; leftover: string; backfilled: boolean },
  tailN: number,
): string[] | null {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size < state.offset) { state.offset = 0; state.leftover = ''; }

  if (!state.backfilled) {
    state.backfilled = true;
    if (tailN <= 0) { state.offset = size; return null; } // no backfill: jump to EOF
  }
  if (size <= state.offset) return null;

  let chunk = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - state.offset);
    fs.readSync(fd, buf, 0, buf.length, state.offset);
    fs.closeSync(fd);
    chunk = buf.toString('utf-8');
  } catch {
    return null;
  }
  state.offset = size;
  const parts = (state.leftover + chunk).split('\n');
  state.leftover = parts.pop() ?? '';
  return parts;
}

/** Tail the fleet activity log; dispatch each line to the matching follower. */
function pumpFleetLog(fl: FleetLogState, byKey: Map<string, Follower>, single: boolean, tailN: number, verbose: boolean): void {
  if (!fl.file) { fl.file = resolveFleetLogFile(); if (!fl.file) return; fl.offset = 0; }
  const lines = readNewLines(fl.file, fl, tailN);
  if (!lines) return;

  const collected: { f: Follower; ev: FormattedEvent }[] = [];
  for (const line of lines) {
    const entry = formatFleetLogLine(line, verbose);
    if (!entry) continue;
    const f = (entry.mem && byKey.get(entry.mem.toLowerCase())) || (entry.mid ? byKey.get(entry.mid) : undefined);
    if (!f) continue;
    for (const ev of entry.events) collected.push({ f, ev });
  }
  const toPrint = tailN > 0 && collected.length > tailN ? collected.slice(-tailN) : collected;
  for (const { f, ev } of toPrint) emit(f, ev, single);
}

/** Tail one local member's provider transcript for LLM-session detail. */
function pumpTranscript(f: Follower, single: boolean, tailN: number, verbose: boolean): void {
  if (!f.txDir) return;
  if (!f.txFile) {
    const newest = newestTranscript(f.txDir);
    if (!newest) return;
    f.txFile = newest; f.txOffset = 0;
  }
  const state = { offset: f.txOffset, leftover: f.txLeftover, backfilled: f.txBackfilled };
  const lines = readNewLines(f.txFile, state, tailN);
  f.txOffset = state.offset; f.txLeftover = state.leftover; f.txBackfilled = state.backfilled;
  if (!lines) return;

  const collected: FormattedEvent[] = [];
  for (const line of lines) {
    for (const ev of formatTranscriptLine(f.provider, line, verbose)) collected.push(ev);
  }
  const toPrint = tailN > 0 && collected.length > tailN ? collected.slice(-tailN) : collected;
  for (const ev of toPrint) emit(f, ev, single);
}

const TIME_W = 8; // "HH:MM:SS"

function paintBody(kind: LineKind | undefined, text: string): string {
  switch (kind) {
    case 'add': return `${GREEN}${text}${RESET}`;
    case 'del': return `${RED}${text}${RESET}`;
    case 'dim':
    case 'out': return `${DIM}${text}${RESET}`;
    default: return text;
  }
}

function paintMarker(marker: string): string {
  switch (marker) {
    case '>': return `${CYAN}>${RESET}`;
    case '*': return `${YELLOW}*${RESET}`;
    case '$': return `${GREEN}$${RESET}`;
    default: return ' ';
  }
}

function emit(f: Follower, ev: FormattedEvent, single: boolean): void {
  const color = useColor();

  if (!color) {
    const who = single ? '' : `${f.agent.friendlyName} | `;
    if (ev.detail) { console.log(`${' '.repeat(single ? 6 : 0)}${who}  ${ev.text}`); return; }
    const mk = ev.marker ? `${ev.marker} ` : '  ';
    const ts = ev.time ? `${ev.time} ` : ' '.repeat(TIME_W + 1);
    console.log(`${ts}${who}${mk}${ev.text}`);
    return;
  }

  const tsCell = `${DIM}${(ev.time ?? '').padEnd(TIME_W)}${RESET}`;
  const label = single ? '' : ` ${f.color}${(f.agent.icon ?? '')} ${f.agent.friendlyName}${RESET}`;

  if (ev.detail) {
    const indent = ' '.repeat(TIME_W);
    console.log(`${indent}${label}    ${paintBody(ev.kind, ev.text)}`);
    return;
  }
  console.log(`${tsCell}${label}  ${paintMarker(ev.marker)} ${paintBody(ev.kind, ev.text)}`);
}

function printOverview(scope: MemberContext[], recent: Map<string, RecentActivity>): void {
  const projects = groupByProject(scope);
  if (projects.length > 1) {
    console.log(`Fleet -- ${projects.length} project(s) in scope`);
    console.log('');
  }
  for (const proj of projects) {
    console.log(`${proj.project} -- ${proj.features.length} feature(s)`);
    for (const feat of proj.features) {
      console.log(`  ${feat.feature}`);
      for (const ctx of feat.members) {
        const act = activityOf(ctx.agent, recent);
        const icon = ctx.agent.icon ?? '';
        const kind = ctx.agent.agentType === 'remote' ? ' (remote)' : '';
        const status = act.active ? (act.lastText ? `working: ${act.lastText}` : 'working') : 'idle';
        console.log(`    ${icon} ${ctx.agent.friendlyName}${kind}  ${status}`);
      }
    }
    console.log('');
  }
}

function printUsage(): void {
  console.log(`apra-fleet watch -- stream live member activity

Usage:
  apra-fleet watch                     Follow members (scope inferred from cwd)
  apra-fleet watch <name> [<name>...]  Follow specific members by name
  apra-fleet watch --project <dir>     Follow members working on the repo at <dir>
  apra-fleet watch --feature <name>    Follow members on one feature (branch match)
  apra-fleet watch --branch <ref>      Follow members on an exact branch
  apra-fleet watch --list              Print the overview and exit (no follow)
  apra-fleet watch --tail <n>          Backfill the last n events per member
  apra-fleet watch --verbose | -v      Show edit diffs, file contents, commands + output, thinking

Sources: the fleet activity log (all shell commands + prompt dispatches, for
local AND remote members) plus, for local members, the LLM session transcript
(reasoning, edits, output). Scope: project = git origin, feature = git branch.`);
}
