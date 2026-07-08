import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAllAgents } from '../services/registry.js';
import { resolveSessionLogDir } from '../services/stall/index.js';
import { encodeClaudeProjectDir } from '../services/stall/log-path-resolver.js';
import { execCommand, execStream, type SSHStream } from '../services/ssh.js';
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
import { escapeShellArg } from '../utils/shell-escape.js';
import { getTaskCredentials } from '../services/credential-store.js';
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
// Sources. Four kinds of activity are merged per member:
//   1. Fleet activity log (universal spine) -- every dispatch the server makes,
//      for local AND remote members, tailed once from the local fleet log.
//   2. Provider transcript (local members) -- the LLM session's rich
//      reasoning/edits/output, tailed per local member from the local FS.
//   3. Remote provider transcript (remote Claude members) -- the same rich
//      session detail, streamed over a dedicated long-lived `tail -F` SSH
//      channel since the .jsonl lives on the member's own disk (ensureRemoteTail).
//   4. Long-running task logs (execute_command with long_running=true) -- each
//      active task's ~/.fleet-tasks/<id>/task.log, tailed the same way as the
//      transcript: local FS polling for local members, a `tail -F` SSH channel
//      for remote members. A member may run several tasks concurrently. The
//      LOCAL ~/.fleet-tasks dir is a single shared directory (the operator's
//      own home), not per-member, so local tasks are tailed ONCE per watch
//      process (not once per local follower) and printed under a neutral
//      label -- the directory carries no member attribution to trust.
// ---------------------------------------------------------------------------

/** Tail state for one long-running task's ~/.fleet-tasks/<id>/task.log. */
interface TaskTailState {
  offset: number;             // local: byte offset already read
  leftover: string;           // trailing partial line carried across reads/chunks
  backfilled: boolean;        // first read primes to EOF so history is not dumped
  stream: SSHStream | null;   // remote: live `tail -F` channel; null for local tasks
  headerShown: boolean;       // "task <id> output:" is deferred until real output exists
}

/** Whatever emit() needs to attribute and color a line -- a Follower, or a neutral stand-in. */
type Emittable = { agent: Pick<Agent, 'friendlyName' | 'icon'>; color: string };

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
  // remote transcript state (remote Claude members; rtEnc null = unsupported)
  rtEnc: string | null;         // encoded ~/.claude/projects/<seg> dir segment
  rtFile: string | null;        // remote .jsonl currently being tailed
  rtStream: SSHStream | null;   // live `tail -F` channel (push, not poll)
  rtLeftover: string;           // trailing partial line carried across chunks
  rtStarted: boolean;           // first tail primes to EOF; rotations read from top
  rtBusy: boolean;              // an open/rotate check is in progress -- do not stack
  // long-running task log state (REMOTE members only -- local tasks are tailed
  // once globally, see localTaskTails in runWatch). A member may have MULTIPLE
  // concurrent tasks.
  taskTails: Map<string, TaskTailState>; // taskId -> tail state
  taskBusy: boolean;             // remote task discovery/rotate check in progress -- do not stack
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
    // Remote Claude members: tail the transcript over SSH (it lives on their disk).
    const rtEnc = !isLocal && provider === 'claude' ? encodeClaudeProjectDir(ctx.agent.workFolder) : null;
    const f: Follower = {
      agent: ctx.agent,
      provider,
      color: COLORS[colorIdx++ % COLORS.length],
      txDir,
      txFile: txDir ? newestTranscript(txDir) : null,
      txOffset: 0,
      txLeftover: '',
      txBackfilled: false,
      rtEnc,
      rtFile: null,
      rtStream: null,
      rtLeftover: '',
      rtStarted: false,
      rtBusy: false,
      taskTails: new Map(),
      taskBusy: false,
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

  // Local ~/.fleet-tasks is a single shared directory (the operator's own home),
  // not per-member -- tail it ONCE for the whole process, under a neutral label,
  // regardless of how many local members are in scope.
  const localTaskTails = new Map<string, TaskTailState>();
  const localTaskLabel: Emittable = { agent: { friendlyName: 'local-tasks' }, color: DIM };
  const hasLocalFollower = followers.some((f) => f.agent.agentType !== 'remote');

  // Prime (with optional backfill), then poll.
  pumpFleetLog(fl, byKey, single, tailN, verbose);
  for (const f of followers) pumpTranscript(f, single, tailN, verbose);
  // Open the remote tail channels immediately (they stream on their own after this).
  for (const f of followers) void ensureRemoteTail(f, single, verbose);
  // Same for long-running task logs: remote members get their task.log(s) tailed
  // over a dedicated SSH channel; local tasks are polled from the shared dir above.
  for (const f of followers) if (f.agent.agentType === 'remote') void ensureRemoteTaskTails(f, single);
  if (hasLocalFollower) pumpLocalTaskTails(localTaskTails, localTaskLabel, single);

  // Remote tails push content on their own; we only periodically check whether a
  // channel died or the session rotated (a cheap `ls`), not every poll tick.
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
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
      if (f.txDir) {
        const newest = newestTranscript(f.txDir);
        if (newest && newest !== f.txFile) {
          f.txFile = newest; f.txOffset = 0; f.txLeftover = ''; f.txBackfilled = true;
        }
        pumpTranscript(f, single, 0, verbose);
      }
      if (tick % RT_CHECK_EVERY_TICKS === 0) void ensureRemoteTail(f, single, verbose);
      if (f.agent.agentType === 'remote' && tick % RT_CHECK_EVERY_TICKS === 0) void ensureRemoteTaskTails(f, single);
    }
    if (hasLocalFollower) pumpLocalTaskTails(localTaskTails, localTaskLabel, single); // cheap fs polling -- every tick, like pumpTranscript
  }, POLL_INTERVAL_MS);

  const stop = () => {
    clearInterval(timer);
    for (const f of followers) {
      if (f.rtStream) { try { f.rtStream.close(); } catch { /* best-effort */ } }
      for (const state of f.taskTails.values()) {
        if (state.stream) { try { state.stream.close(); } catch { /* best-effort */ } }
      }
    }
    console.log('');
    process.exit(0);
  };
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
    // "Transcript owns the prompt": for members whose full transcript is tailed
    // (local, or remote Claude with a live SSH channel), skip the fleet-log prompt
    // preview so the prompt isn't shown twice. Fall back to the preview line
    // whenever no transcript is actually streaming right now (e.g. the remote
    // tail channel is down or still connecting), so the prompt isn't dropped.
    if (entry.promptLine && (f.txDir || f.rtStream)) continue;
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

/**
 * Build the `tail -F` command for a remote transcript file. `file` is untrusted
 * (it comes from `ls -t` on the member's disk), so it is shell-escaped before
 * interpolation. `startFlag` is caller-controlled (`-n0` / `-n +1`).
 */
export function buildTailCommand(startFlag: string, file: string): string {
  return `tail ${startFlag} -F ${escapeShellArg(file)}`;
}

// A remote tail is re-checked every this-many poll ticks (~POLL_INTERVAL_MS each)
// -- only to detect a dead channel or a rotated session, NOT to fetch content
// (the tail streams that on its own). Rotations are rare, so this stays light.
const RT_CHECK_EVERY_TICKS = 5;

/** Feed a chunk of tailed transcript bytes out as formatted lines, keeping any trailing partial line. */
function processRemoteChunk(f: Follower, chunk: string, single: boolean, verbose: boolean): void {
  const parts = (f.rtLeftover + chunk).split('\n');
  f.rtLeftover = parts.pop() ?? '';
  for (const line of parts) {
    for (const ev of formatTranscriptLine(f.provider, line, verbose)) emit(f, ev, single);
  }
}

/**
 * Ensure a remote Claude member has a live `tail -F` channel on its newest
 * session transcript. The transcript .jsonl lives on the member's own disk, so
 * we stream it over a dedicated long-lived SSH channel (push, not poll). This
 * runs once at startup and then only periodically -- just to (re)open a channel
 * that died or to follow a session rotation. A cheap `ls` finds the newest file:
 *   - first open primes to EOF (`-n0`) so no history is dumped;
 *   - a rotation opens the new session from its top (`-n +1`) so nothing is missed.
 * Fails soft: connect/exec errors leave rtStream null and the next check retries.
 */
async function ensureRemoteTail(f: Follower, single: boolean, verbose: boolean): Promise<void> {
  if (!f.rtEnc || f.rtBusy) return;
  f.rtBusy = true;
  try {
    const dir = `"$HOME/.claude/projects/${f.rtEnc}"`;
    const res = await execCommand(f.agent, `ls -t ${dir}/*.jsonl 2>/dev/null | head -1`, 8000);
    const newest = res.stdout.trim().split('\n')[0]?.trim();
    if (!newest) return;
    if (f.rtStream && newest === f.rtFile) return; // already tailing the current session

    // (Re)open: close any stale channel, then tail the newest file.
    if (f.rtStream) { try { f.rtStream.close(); } catch { /* best-effort */ } f.rtStream = null; }
    const primed = f.rtStarted; // first open = EOF; any later open = a new session, read from top
    const startFlag = primed ? '-n +1' : '-n0';
    f.rtLeftover = '';

    let stream: SSHStream;
    const onEnd = () => { if (f.rtStream === stream) f.rtStream = null; }; // channel died -> next check reopens
    stream = await execStream(
      f.agent,
      buildTailCommand(startFlag, newest),
      (chunk) => processRemoteChunk(f, chunk, single, verbose),
      onEnd,
    );
    f.rtFile = newest;
    f.rtStarted = true;
    f.rtStream = stream;
  } catch {
    // Member asleep / connection dropped -- leave rtStream null; the next check retries.
    if (f.rtStream) { try { f.rtStream.close(); } catch { /* best-effort */ } f.rtStream = null; }
  } finally {
    f.rtBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Long-running task log tailing (execute_command with long_running=true).
// A task's ~/.fleet-tasks/<id>/status.json flips through running -> retrying*
// -> completed|failed; task.log accumulates its stdout/stderr for the whole
// lifetime. `monitor_task` reads a snapshot of that log; `watch` streams it
// live, mirroring the transcript-tail design (poll for local, `tail -F` SSH
// channel for remote).
// ---------------------------------------------------------------------------

function fleetTasksDir(): string {
  return path.join(os.homedir(), '.fleet-tasks');
}

function nowTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

function taskHeaderEvent(taskId: string): FormattedEvent {
  return { time: nowTime(), marker: '$', kind: 'info', text: `task ${taskId} output:` };
}

function taskLogLineEvent(line: string): FormattedEvent {
  return { time: null, marker: '', kind: 'out', detail: true, text: line };
}

function taskEndEvent(taskId: string): FormattedEvent {
  return { time: null, marker: '', kind: 'dim', detail: true, text: `-> task ${taskId} finished` };
}

/** Redact registered task credentials from task-log output, same as monitor_task does for its snapshot. */
function redactTaskOutput(taskId: string, text: string): string {
  return getTaskCredentials(taskId).reduce(
    (out, c) => (c.plaintext.length > 0 ? out.replaceAll(c.plaintext, `[REDACTED:${c.name}]`) : out),
    text,
  );
}

/**
 * Emit newly-read task-log lines, redacted, deferring the "task <id> output:"
 * header until the first real line so a task that finishes without producing
 * output never gets a bare header immediately followed by "finished".
 */
function emitTaskLines(target: Emittable, taskId: string, state: TaskTailState, lines: string[] | null, single: boolean): void {
  if (!lines || lines.length === 0) return;
  if (!state.headerShown) { emit(target, taskHeaderEvent(taskId), single); state.headerShown = true; }
  for (const line of lines) emit(target, taskLogLineEvent(redactTaskOutput(taskId, line)), single);
}

/** Local ~/.fleet-tasks/<id>/status.json entries whose status is running or retrying. */
function listLocalActiveTasks(): Set<string> {
  const out = new Set<string>();
  let entries: string[];
  try { entries = fs.readdirSync(fleetTasksDir()); } catch { return out; }
  for (const taskId of entries) {
    try {
      const raw = fs.readFileSync(path.join(fleetTasksDir(), taskId, 'status.json'), 'utf-8');
      const status = JSON.parse(raw).status;
      if (status === 'running' || status === 'retrying') out.add(taskId);
    } catch { /* not a task dir yet, or status.json not written yet */ }
  }
  return out;
}

/**
 * Poll the shared local ~/.fleet-tasks dir for active tasks, opening/closing
 * per-task tails as needed. Runs ONCE per watch process (not once per local
 * follower): the directory is the operator's own home, shared by every local
 * member, and carries no per-task member attribution -- callers pass a neutral
 * `target` rather than a specific follower.
 */
function pumpLocalTaskTails(state: Map<string, TaskTailState>, target: Emittable, single: boolean): void {
  const active = listLocalActiveTasks();

  for (const [taskId, ts] of state) {
    if (active.has(taskId)) continue;
    // Flush output written between the last poll and the status flip (often the
    // task's final result/error) before announcing it's done, so it isn't lost.
    const finalLines = readNewLines(path.join(fleetTasksDir(), taskId, 'task.log'), ts, 0);
    emitTaskLines(target, taskId, ts, finalLines, single);
    if (ts.leftover) { emitTaskLines(target, taskId, ts, [ts.leftover], single); ts.leftover = ''; }
    state.delete(taskId);
    emit(target, taskEndEvent(taskId), single);
  }

  for (const taskId of active) {
    let ts = state.get(taskId);
    if (!ts) {
      ts = { offset: 0, leftover: '', backfilled: false, stream: null, headerShown: false };
      state.set(taskId, ts);
    }
    const lines = readNewLines(path.join(fleetTasksDir(), taskId, 'task.log'), ts, 0);
    emitTaskLines(target, taskId, ts, lines, single);
  }
}

/** Feed a chunk of tailed task-log bytes out as formatted lines, keeping any trailing partial line. */
function processTaskChunk(f: Follower, taskId: string, state: TaskTailState, chunk: string, single: boolean): void {
  const parts = (state.leftover + chunk).split('\n');
  state.leftover = parts.pop() ?? '';
  emitTaskLines(f, taskId, state, parts, single);
}

/**
 * Ensure a remote member's active long-running tasks each have a live `tail -F`
 * channel on their task.log. Discovers active tasks with a cheap shell scan of
 * ~/.fleet-tasks/*\/status.json (running or retrying), printing `taskId|logPath`
 * pairs so the remote shell resolves $HOME itself -- logPath is then a plain
 * absolute path, safe to hand to buildTailCommand's shell-escaping.
 *
 * A task keeps its TaskTailState entry across a dropped channel (stream=null
 * but the task is still running/retrying) so a dead `tail -F` gets reopened on
 * the next check instead of being abandoned for the task's remaining lifetime;
 * only a task that has actually left running/retrying is dropped. Every (re)open
 * re-primes to EOF (`-n0`) -- accepting a small gap in a reconnect scenario
 * rather than risking duplicated output. Fails soft, like ensureRemoteTail.
 */
async function ensureRemoteTaskTails(f: Follower, single: boolean): Promise<void> {
  if (f.taskBusy) return;
  f.taskBusy = true;
  try {
    const scan =
      'for d in "$HOME"/.fleet-tasks/*/; do ' +
      's=$(cat "${d}status.json" 2>/dev/null); ' +
      'case "$s" in *\'"status":"running"\'*|*\'"status":"retrying"\'*) printf \'%s|%s\\n\' "$(basename "$d")" "${d}task.log";; esac; ' +
      'done';
    const res = await execCommand(f.agent, scan, 8000);
    const active = new Map<string, string>(); // taskId -> absolute task.log path
    for (const line of res.stdout.split('\n')) {
      const idx = line.indexOf('|');
      if (idx === -1) continue;
      const taskId = line.slice(0, idx).trim();
      const logPath = line.slice(idx + 1).trim();
      if (taskId && logPath) active.set(taskId, logPath);
    }

    for (const [taskId, state] of f.taskTails) {
      if (active.has(taskId)) continue;
      // Flush a dangling partial line before announcing the task is done.
      if (state.leftover) { emitTaskLines(f, taskId, state, [state.leftover], single); state.leftover = ''; }
      if (state.stream) { try { state.stream.close(); } catch { /* best-effort */ } }
      f.taskTails.delete(taskId);
      emit(f, taskEndEvent(taskId), single);
    }

    for (const [taskId, logPath] of active) {
      const existing = f.taskTails.get(taskId);
      if (existing?.stream) continue; // already tailing live -- only a dead channel gets reopened

      const state: TaskTailState = existing ?? { offset: 0, leftover: '', backfilled: true, stream: null, headerShown: false };
      state.leftover = ''; // (re)opening -- discard any stale partial line, re-prime from EOF
      f.taskTails.set(taskId, state);
      const onEnd = () => { if (f.taskTails.get(taskId) === state) state.stream = null; }; // channel died -> next check reopens
      try {
        state.stream = await execStream(
          f.agent,
          buildTailCommand('-n0', logPath),
          (chunk) => processTaskChunk(f, taskId, state, chunk, single),
          onEnd,
        );
      } catch {
        // Leave the entry in place (stream stays null) so the next check retries
        // without losing headerShown state or re-announcing an already-seen task.
      }
    }
  } catch {
    // Member asleep / connection dropped -- leave existing channels as-is; the next check retries.
  } finally {
    f.taskBusy = false;
  }
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

function emit(f: Emittable, ev: FormattedEvent, single: boolean): void {
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
  apra-fleet watch --verbose | -v      Also show the model's thinking/reasoning
                                       (diffs, file contents + output show by default)

Sources: the fleet activity log (all shell commands + prompt dispatches, for
local AND remote members) plus the LLM session transcript (reasoning, edits,
output) -- read from disk for local members and tailed over SSH for remote
Claude members. Scope: project = git origin, feature = git branch.`);
}
