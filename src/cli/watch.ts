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
import { formatTranscriptLine } from '../services/watch/transcript-formatter.js';
import type { Agent } from '../types.js';

// A member is considered "active" if its newest transcript file was written
// within this window. Standalone proxy for busy state (no server round-trip).
const ACTIVE_WINDOW_MS = 90_000;
const POLL_INTERVAL_MS = 700;

const COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[35m', '\x1b[34m', '\x1b[31m', '\x1b[96m', '\x1b[92m'];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const useColor = (): boolean => process.stdout.isTTY === true && !process.env.NO_COLOR;

interface Activity {
  supported: boolean;
  file: string | null;
  active: boolean;
  lastText: string | null;
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
      if (m > bestM) {
        bestM = m;
        best = full;
      }
    } catch {
      /* ignore */
    }
  }
  return best;
}

/** Read the last non-empty formatted event of a transcript, for overview status. */
function lastEventText(provider: string, file: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const events = formatTranscriptLine(provider, lines[i]);
    if (events.length > 0) return events[events.length - 1].text;
  }
  return null;
}

function activityOf(agent: Agent): Activity {
  const dir = resolveSessionLogDir((agent.llmProvider ?? 'claude') as any, agent.workFolder);
  if (!dir) return { supported: false, file: null, active: false, lastText: null };
  const file = newestTranscript(dir);
  if (!file) return { supported: true, file: null, active: false, lastText: null };
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    /* ignore */
  }
  const active = Date.now() - mtime < ACTIVE_WINDOW_MS;
  return {
    supported: true,
    file,
    active,
    lastText: lastEventText(agent.llmProvider ?? 'claude', file),
  };
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

export async function runWatch(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // Hidden helper for shell completion: print member names, one per line.
  if (args.includes('--complete')) {
    for (const a of getAllAgents()) console.log(a.friendlyName);
    process.exit(0);
  }

  const listOnly = args.includes('--list');
  const projectDir = parseFlagValue(args, '--project');
  const feature = parseFlagValue(args, '--feature') ?? parseFlagValue(args, '--branch');
  const tailN = parseInt(parseFlagValue(args, '--tail') ?? '0', 10) || 0;

  const flagsWithValues = new Set(['--project', '--feature', '--branch', '--tail']);
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (flagsWithValues.has(a)) i++; // skip its value
      continue;
    }
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
    // Infer from cwd: if it is a repo we recognize, narrow to it; else whole fleet.
    const cwdKey = projectKeyForDir(process.cwd());
    const inCwd = contexts.filter((c) => projectKey(c) === cwdKey);
    if (inCwd.length > 0) {
      scope = inCwd;
      scopeLabel = path.basename(process.cwd());
    }
  }

  if (feature) {
    const f = feature.toLowerCase();
    scope = scope.filter((c) => c.branch != null && (c.branch.toLowerCase() === f || c.branch.toLowerCase().includes(f)));
  }

  if (scope.length === 0) {
    console.log(`No members in scope (${scopeLabel}).`);
    process.exit(0);
  }

  // --- Overview ---
  printOverview(scope, scopeLabel);

  if (listOnly) process.exit(0);

  // --- Build follow set ---
  const followers: Follower[] = [];
  let colorIdx = 0;
  // Follow every supported member in scope -- like `docker compose logs -f`.
  // Idle members are followed silently and stream as soon as they produce output;
  // there is no activity gate. (activityOf still feeds the overview status column.)
  for (const ctx of scope) {
    const act = activityOf(ctx.agent);
    if (!act.supported) continue;
    followers.push({
      agent: ctx.agent,
      provider: ctx.agent.llmProvider ?? 'claude',
      dir: resolveSessionLogDir((ctx.agent.llmProvider ?? 'claude') as any, ctx.agent.workFolder)!,
      file: act.file,
      offset: 0,
      leftover: '',
      color: COLORS[colorIdx++ % COLORS.length],
      backfilled: false,
    });
  }

  if (followers.length === 0) {
    console.log('');
    console.log('No members in scope have a live-viewable provider (Claude/Gemini).');
    process.exit(0);
  }

  const single = followers.length === 1;
  console.log('');
  console.log(`${DIM}Following ${followers.length} member(s); idle ones stream when they start. Press Ctrl-C to stop.${RESET}`);
  console.log('');

  // Prime offsets (with optional backfill), then poll.
  for (const f of followers) pump(f, single, tailN);

  const timer = setInterval(() => {
    for (const f of followers) {
      // Roll over to a newer session file if one appeared.
      const newest = newestTranscript(f.dir);
      if (newest && newest !== f.file) {
        f.file = newest;
        f.offset = 0;
        f.leftover = '';
        f.backfilled = true; // do not backfill a freshly rolled file
      }
      pump(f, single, tailN);
    }
  }, POLL_INTERVAL_MS);

  const stop = () => {
    clearInterval(timer);
    console.log('');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

interface Follower {
  agent: Agent;
  provider: string;
  dir: string;
  file: string | null;
  offset: number;
  leftover: string;
  color: string;
  backfilled: boolean;
}

/** Read new bytes from a follower's file, format them, and print. */
function pump(f: Follower, single: boolean, tailN: number): void {
  if (!f.file) {
    const newest = newestTranscript(f.dir);
    if (!newest) return;
    f.file = newest;
    f.offset = 0;
  }

  let size = 0;
  try {
    size = fs.statSync(f.file).size;
  } catch {
    return;
  }
  if (size < f.offset) {
    // File truncated/replaced; restart from the beginning.
    f.offset = 0;
    f.leftover = '';
  }

  // First read of a file: honor --tail backfill, else jump to EOF.
  if (!f.backfilled) {
    f.backfilled = true;
    if (tailN <= 0) {
      f.offset = size;
      return;
    }
  }

  if (size <= f.offset) return;

  let chunk = '';
  try {
    const fd = fs.openSync(f.file, 'r');
    const buf = Buffer.alloc(size - f.offset);
    fs.readSync(fd, buf, 0, buf.length, f.offset);
    fs.closeSync(fd);
    chunk = buf.toString('utf-8');
  } catch {
    return;
  }
  f.offset = size;

  const text = f.leftover + chunk;
  const parts = text.split('\n');
  f.leftover = parts.pop() ?? '';

  const collected: { time: string | null; text: string }[] = [];
  for (const line of parts) {
    for (const ev of formatTranscriptLine(f.provider, line)) collected.push(ev);
  }

  const toPrint = tailN > 0 && collected.length > tailN ? collected.slice(-tailN) : collected;
  for (const ev of toPrint) {
    emit(f, ev.time, ev.text, single);
  }
  // --tail only backfills the first read.
  tailN = 0;
}

function emit(f: Follower, time: string | null, text: string, single: boolean): void {
  const color = useColor();
  const ts = time ? `${time} ` : '';
  if (single) {
    const tsStr = color ? `${DIM}${ts}${RESET}` : ts;
    console.log(`${tsStr}${text}`);
    return;
  }
  const label = `${f.agent.icon ?? ''} ${f.agent.friendlyName}`.trim();
  if (color) {
    console.log(`${DIM}${ts}${RESET}${f.color}${label}${RESET} ${text}`);
  } else {
    console.log(`${ts}${label} | ${text}`);
  }
}

function printOverview(scope: MemberContext[], scopeLabel: string): void {
  const projects = groupByProject(scope);
  const single = projects.length === 1;
  if (!single) {
    console.log(`Fleet -- ${projects.length} project(s) in scope`);
    console.log('');
  }
  for (const proj of projects) {
    const featureCount = proj.features.length;
    console.log(`${proj.project} -- ${featureCount} feature(s)`);
    for (const feat of proj.features) {
      console.log(`  ${feat.feature}`);
      for (const ctx of feat.members) {
        const act = activityOf(ctx.agent);
        const icon = ctx.agent.icon ?? '';
        const name = ctx.agent.friendlyName;
        let status: string;
        if (!act.supported) status = `(live view not supported for ${ctx.agent.llmProvider})`;
        else if (act.active) status = act.lastText ? `working: ${act.lastText}` : 'working';
        else status = 'idle';
        console.log(`    ${icon} ${name}  ${status}`);
      }
    }
    console.log('');
  }
}

function printUsage(): void {
  console.log(`apra-fleet watch -- stream live member logs

Usage:
  apra-fleet watch                     Follow members (scope inferred from cwd)
  apra-fleet watch <name> [<name>...]  Follow specific members by name
  apra-fleet watch --project <dir>     Follow members working on the repo at <dir>
  apra-fleet watch --feature <name>    Follow members on one feature (branch match)
  apra-fleet watch --branch <ref>      Follow members on an exact branch
  apra-fleet watch --list              Print the overview and exit (no follow)
  apra-fleet watch --tail <n>          Backfill the last n events per member

Scope: project = git origin (folders cloned from the same repo group together),
feature = git branch. Live view supports Claude members; other providers are
listed in the overview but not tailed in this version.`);
}
