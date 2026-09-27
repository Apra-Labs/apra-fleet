/**
 * The sprint's own task list, read and changed through bd in helper 1's copy
 * of the project. Everything stays on this machine: no GitHub calls, and a
 * running sprint picks new or changed tasks up on its next look at the list.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BeadsTask } from './board.js';
import type { SprintRecord } from './launcher.js';

export type BdRunner = (args: string[], cwd: string) => Promise<string>;

const LOCKED_RE = /lock|busy|database is locked|resource temporarily unavailable/i;

export const realBd: BdRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('bd', args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, BEADS_ACTOR: 'you' } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').filter(l => !/^Warning:/.test(l))[0] || 'bd failed'));
      else resolve(stdout);
    });
  });

let runner: BdRunner = realBd;
/** Tests swap in a fake bd. */
export function setBdRunner(r: BdRunner | null): void {
  runner = r ?? realBd;
  cache.clear();
}

/** bd is safe to call next to the engine, but a busy database gets a few retries. */
async function bd(args: string[], cwd: string): Promise<string> {
  let last: Error | undefined;
  for (let i = 0; i < 4; i++) {
    try {
      return await runner(args, cwd);
    } catch (e) {
      last = e as Error;
      if (!LOCKED_RE.test(last.message)) throw last;
      await new Promise(r => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw last!;
}

function parseJson<T>(raw: string): T {
  const start = raw.search(/[[{]/);
  return JSON.parse(start > 0 ? raw.slice(start) : raw) as T;
}

/** Helper 1's copy holds the task database; null for sprints it does not have. */
export function taskDir(rec: SprintRecord | undefined): string | null {
  if (!rec?.rootIssue) return null;
  const h0 = path.join(rec.workspace, 'h0');
  return fs.existsSync(path.join(h0, '.beads')) ? h0 : null;
}

const GOAL_MAX: Record<string, number> = { P1: 1, 'P1/P2': 2, 'P1/P2/P3': 3 };

interface Cached { at: number; tasks: Promise<BeadsTask[]> }
const cache = new Map<string, Cached>();
const FRESH_MS = 1500;

/** Every task under the sprint's root issue, straight from bd (cached briefly). */
export function liveTasks(rec: SprintRecord): Promise<BeadsTask[]> | null {
  const dir = taskDir(rec);
  if (!dir) return null;
  const hit = cache.get(rec.runId);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.tasks;
  const tasks = bd(['list', '--json', '--all', '--limit', '0'], dir).then(raw => scopeTasks(parseJson<BeadsTask[]>(raw), rec));
  cache.set(rec.runId, { at: Date.now(), tasks });
  tasks.catch(() => cache.delete(rec.runId));
  return tasks;
}

export function forget(runId: string): void {
  cache.delete(runId);
}

/** The root issue and everything below it, marked in or out of the sprint's goal. */
export function scopeTasks(all: BeadsTask[], rec: Pick<SprintRecord, 'rootIssue' | 'goal'>): BeadsTask[] {
  const byId = new Map(all.map(t => [t.id, t]));
  const inScope = (t: BeadsTask): boolean => {
    const seen = new Set<string>();
    let cur: BeadsTask | undefined = t;
    while (cur && !seen.has(cur.id)) {
      if (cur.id === rec.rootIssue) return true;
      seen.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return false;
  };
  const max = GOAL_MAX[rec.goal] ?? 2;
  return all.filter(inScope).map(t => {
    const open = (t.dependencies ?? []).some(d => d.type === 'blocks' && d.issue_id === t.id && byId.get(d.depends_on_id)?.status !== 'closed');
    return { ...t, ready: t.status === 'open' ? !open : t.ready, placement: typeof t.priority === 'number' && t.priority > max ? 'backlog' : 'sprint' };
  });
}

export interface TaskComment { id: string; author: string; text: string; created_at: string }

export async function taskComments(rec: SprintRecord, id: string): Promise<TaskComment[]> {
  const dir = taskDir(rec);
  if (!dir) return [];
  try {
    return parseJson<TaskComment[]>(await bd(['comments', checkId(id), '--json'], dir)) ?? [];
  } catch {
    return [];
  }
}

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
function checkId(id: string): string {
  if (!ID_RE.test(id) || id.startsWith('-')) throw new Error('bad task id');
  return id;
}

function needDir(rec: SprintRecord): string {
  const dir = taskDir(rec);
  if (!dir) throw new Error('This sprint has no task list on this machine');
  return dir;
}

function cleanText(s: unknown, max: number, what: string): string {
  const t = typeof s === 'string' ? s.replace(/\r\n/g, '\n').trim() : '';
  if (!t) throw new Error(`${what} is empty`);
  if (t.length > max) throw new Error(`${what} is too long (at most ${max} characters)`);
  return t;
}

export interface NewTask {
  title: string;
  description?: string;
  acceptance?: string;
  type?: 'task' | 'bug' | 'chore';
  priority?: number;
  /** A lane (epic/feature) under the root; defaults to the root issue. */
  parent?: string;
  labels?: string[];
}

export async function createTask(rec: SprintRecord, input: NewTask): Promise<BeadsTask> {
  const dir = needDir(rec);
  const title = cleanText(input.title, 200, 'The title');
  const type = input.type && ['task', 'bug', 'chore'].includes(input.type) ? input.type : 'task';
  const priority = Number.isInteger(input.priority) && input.priority! >= 0 && input.priority! <= 4 ? input.priority! : 1;
  const parent = input.parent ? checkId(input.parent) : rec.rootIssue!;
  if (parent !== rec.rootIssue) {
    const tasks = (await liveTasks(rec)) ?? [];
    if (!tasks.some(t => t.id === parent)) throw new Error('That group is not part of this sprint');
  }
  // The engine only hands 'task' issues made after planning to builders, so a
  // bug or chore from the board is a task that carries its kind as a label.
  const args = ['create', '--type', 'task', '--priority', String(priority), '--parent', parent, '--title', title, '--json'];
  if (input.description?.trim()) args.push('--description', cleanText(input.description, 20000, 'The description'));
  if (input.acceptance?.trim()) args.push('--acceptance', cleanText(input.acceptance, 8000, 'The acceptance criteria'));
  const labels = [...(input.labels ?? []), ...(type === 'task' ? [] : [`kind:${type}`])].filter(l => /^[a-z0-9:_-]{1,40}$/i.test(l));
  if (labels.length) args.push('--labels', labels.join(','));
  const out = parseJson<BeadsTask | BeadsTask[]>(await bd(args, dir));
  forget(rec.runId);
  return Array.isArray(out) ? out[0] : out;
}

export interface TaskChange { priority?: number; title?: string }

export async function updateTask(rec: SprintRecord, id: string, change: TaskChange): Promise<void> {
  const dir = needDir(rec);
  const args = ['update', checkId(id)];
  if (change.priority !== undefined) {
    if (!Number.isInteger(change.priority) || change.priority < 0 || change.priority > 4) throw new Error('Priority is 0 (highest) to 4 (lowest)');
    args.push('--priority', String(change.priority));
  }
  if (change.title !== undefined) args.push('--title', cleanText(change.title, 200, 'The title'));
  if (args.length === 2) throw new Error('Nothing to change');
  await mustBeInSprint(rec, id);
  await bd(args, dir);
  forget(rec.runId);
}

export async function commentTask(rec: SprintRecord, id: string, text: string): Promise<TaskComment> {
  const dir = needDir(rec);
  await mustBeInSprint(rec, id);
  const out = parseJson<TaskComment>(await bd(['comments', 'add', checkId(id), cleanText(text, 8000, 'The comment'), '--author', 'you', '--json'], dir));
  forget(rec.runId);
  return out;
}

/** Take a task off the sprint. Never one a helper is on, so no work is thrown away mid-build. */
export async function skipTask(rec: SprintRecord, id: string, reason?: string): Promise<void> {
  const dir = needDir(rec);
  const t = await mustBeInSprint(rec, id);
  if (t.status === 'in_progress') throw new Error('A helper is working on this one; wait for it to land, or stop the sprint');
  if (t.status === 'closed') throw new Error('This task is already done');
  await bd(['close', checkId(id), '--reason', (reason?.trim() || 'Skipped from the dashboard').slice(0, 500)], dir);
  forget(rec.runId);
}

export async function reopenTask(rec: SprintRecord, id: string): Promise<void> {
  const dir = needDir(rec);
  const t = await mustBeInSprint(rec, id);
  if (t.status !== 'closed') throw new Error('This task is not done');
  await bd(['reopen', checkId(id)], dir);
  forget(rec.runId);
}

async function mustBeInSprint(rec: SprintRecord, id: string): Promise<BeadsTask> {
  checkId(id);
  forget(rec.runId);
  const tasks = (await liveTasks(rec)) ?? [];
  const t = tasks.find(x => x.id === id);
  if (!t) throw new Error('That task is not part of this sprint');
  return t;
}
