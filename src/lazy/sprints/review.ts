/**
 * Code review on a sprint's changes: comment threads pinned to lines of the
 * diff, kept on this machine (~/.lazyfleet/reviews/<runId>.json). Threads
 * follow their code as new commits land (by the text of the lines, not just
 * the line number) and are marked outdated once that code is gone. Sending
 * comments to the helpers files them as tasks in the sprint's own task list;
 * nothing here talks to GitHub.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lazyDir } from '../config.js';
import type { BeadsTask } from './board.js';
import { codeChanges, fileLines } from './code.js';
import type { SprintRecord } from './launcher.js';
import { addDependency, commentTask, createTask } from './tasks.js';

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  at: string;
  editedAt?: string;
  /** Written by the sprint (a helper finished the task), not by a person. */
  system?: boolean;
}

export interface Thread {
  id: string;
  file: string;
  side: 'old' | 'new';
  /** First and last line of the selection, on its side, when it was made. */
  line: number;
  endLine: number;
  /** The selected lines' text, which is how the thread finds its code again. */
  anchor: string[];
  /** The line just above the selection, to tell repeated code apart. */
  before?: string;
  /** Sprint commit the thread was made on. */
  madeAt: string;
  status: 'open' | 'resolved';
  sent?: { at: string; taskId?: string; followUp?: string };
  comments: ReviewComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Review {
  runId: string;
  rev: number;
  threads: Thread[];
  /** The sprint commit you last looked at, for "changed since you looked". */
  seenHead?: string;
}

export type AnchorState = 'current' | 'moved' | 'outdated';

export interface ThreadView extends Thread {
  state: AnchorState;
  /** Where the thread sits in the code now (same as line when current). */
  lineNow: number;
  endLineNow: number;
  task?: { id: string; status: string; reason?: string };
}

export interface ReviewView {
  runId: string;
  rev: number;
  head?: string;
  mergeBase?: string;
  seenHead?: string;
  threads: ThreadView[];
  counts: { open: number; resolved: number; outdated: number; unsent: number };
}

const MAX_THREADS = 500;
const MAX_BODY = 8000;

function reviewFile(runId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) throw new Error('bad sprint id');
  return path.join(lazyDir(), 'reviews', `${runId}.json`);
}

export function loadReview(runId: string): Review {
  try {
    const r = JSON.parse(fs.readFileSync(reviewFile(runId), 'utf-8')) as Review;
    if (r && Array.isArray(r.threads)) return { runId, rev: Number(r.rev) || 0, threads: r.threads, seenHead: r.seenHead };
  } catch {
    // none yet
  }
  return { runId, rev: 0, threads: [] };
}

function saveReview(r: Review): Review {
  const file = reviewFile(r.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  r.rev += 1;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return r;
}

function newId(): string {
  return crypto.randomBytes(6).toString('hex');
}

function body(text: unknown): string {
  const t = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  if (!t) throw new Error('The comment is empty');
  if (t.length > MAX_BODY) throw new Error(`The comment is too long (at most ${MAX_BODY} characters)`);
  return t;
}

const norm = (s: string) => s.replace(/\s+$/, '');

/**
 * Where a thread's code is in `lines` now. Same place -> current; the same
 * text elsewhere -> moved (the nearest match, preferring one whose line above
 * also matches); gone -> outdated.
 */
export function locate(t: Pick<Thread, 'line' | 'endLine' | 'anchor' | 'before'>, lines: string[]): { state: AnchorState; line: number; endLine: number } {
  const len = t.anchor.length;
  const want = t.anchor.map(norm);
  const matchAt = (i: number) => {
    if (i < 0 || i + len > lines.length) return false;
    for (let k = 0; k < len; k++) if (norm(lines[i + k]) !== want[k]) return false;
    return true;
  };
  const start = t.line - 1;
  if (len && matchAt(start)) return { state: 'current', line: t.line, endLine: t.endLine };
  let best = -1;
  let bestScore = Infinity;
  if (len && want.some(w => w.trim())) {
    for (let i = 0; i + len <= lines.length; i++) {
      if (!matchAt(i)) continue;
      const beforeOk = t.before === undefined || (i > 0 && norm(lines[i - 1]) === norm(t.before));
      const score = Math.abs(i - start) + (beforeOk ? 0 : 100000);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
  }
  if (best >= 0) return { state: 'moved', line: best + 1, endLine: best + len };
  return { state: 'outdated', line: t.line, endLine: t.endLine };
}

export interface ReviewContext {
  rec: SprintRecord;
  /** Where to read git from (helper 1's copy). */
  repo: string;
  tasks?: BeadsTask[];
  /** Is the sprint still running? */
  live: boolean;
  /** Helpers building right now, by name. */
  building?: string[];
  /** Starts a follow-up sprint once this one has finished. */
  launch?: (input: { repo: string; ask: string; title: string; base: string; design?: string; goal?: SprintRecord['goal'] }) => Promise<{ runId: string }>;
}

export async function reviewView(ctx: ReviewContext): Promise<ReviewView> {
  const r = loadReview(ctx.rec.runId);
  const changes = await codeChanges(ctx.repo, ctx.rec.branch, ctx.rec.base);
  const files = new Set(changes.files.map(f => f.path));
  const sideLines = new Map<string, string[] | null>();
  const linesFor = async (file: string, side: 'old' | 'new'): Promise<string[] | null> => {
    const key = `${side}:${file}`;
    if (!sideLines.has(key)) {
      sideLines.set(key, changes.available && files.has(file) ? (await fileLines(ctx.repo, ctx.rec.branch, ctx.rec.base, file, side).catch(() => null))?.lines ?? null : null);
    }
    return sideLines.get(key)!;
  };
  const byId = new Map((ctx.tasks ?? []).map(t => [t.id, t]));
  const threads: ThreadView[] = [];
  for (const t of r.threads) {
    const lines = await linesFor(t.file, t.side);
    const at = lines ? locate(t, lines) : { state: 'outdated' as const, line: t.line, endLine: t.endLine };
    const task = t.sent?.taskId ? byId.get(t.sent.taskId) : undefined;
    const comments = [...t.comments];
    if (task?.status === 'closed') {
      comments.push({ id: `task-${task.id}`, author: 'Helper', body: `Handled in ${task.id}: ${task.close_reason || 'done'}`, at: task.closed_at ?? t.updatedAt, system: true });
    }
    threads.push({
      ...t,
      comments,
      state: at.state,
      lineNow: at.line,
      endLineNow: at.endLine,
      ...(t.sent?.taskId ? { task: { id: t.sent.taskId, status: task?.status ?? 'open', reason: task?.close_reason } } : {}),
    });
  }
  return {
    runId: r.runId,
    rev: r.rev,
    head: changes.head,
    mergeBase: changes.mergeBase,
    seenHead: r.seenHead,
    threads,
    counts: {
      open: threads.filter(t => t.status === 'open').length,
      resolved: threads.filter(t => t.status === 'resolved').length,
      outdated: threads.filter(t => t.state === 'outdated').length,
      unsent: threads.filter(t => t.status === 'open' && !t.sent).length,
    },
  };
}

export interface NewThread {
  file: string;
  side?: 'old' | 'new';
  line: number;
  endLine?: number;
  body: string;
}

export async function addThread(ctx: ReviewContext, input: NewThread): Promise<Thread> {
  const text = body(input.body);
  const side = input.side === 'old' ? 'old' : 'new';
  const line = Math.floor(Number(input.line));
  const endLine = Math.floor(Number(input.endLine ?? input.line));
  if (!Number.isFinite(line) || line < 1 || endLine < line || endLine - line > 400) throw new Error('Pick one line, or a range of up to 400 lines');
  if (typeof input.file !== 'string' || !input.file) throw new Error('Which file?');
  const { lines, rev } = await fileLines(ctx.repo, ctx.rec.branch, ctx.rec.base, input.file, side);
  if (endLine > lines.length) throw new Error('Those lines are not in the file any more; the view will refresh');
  const r = loadReview(ctx.rec.runId);
  if (r.threads.length >= MAX_THREADS) throw new Error(`A sprint can have at most ${MAX_THREADS} comment threads`);
  const now = new Date().toISOString();
  const thread: Thread = {
    id: newId(),
    file: input.file,
    side,
    line,
    endLine,
    anchor: lines.slice(line - 1, endLine),
    ...(line > 1 ? { before: lines[line - 2] } : {}),
    madeAt: rev,
    status: 'open',
    comments: [{ id: newId(), author: 'You', body: text, at: now }],
    createdAt: now,
    updatedAt: now,
  };
  r.threads.push(thread);
  saveReview(r);
  return thread;
}

function editThread(runId: string, id: string, edit: (t: Thread, r: Review) => void): Thread | null {
  const r = loadReview(runId);
  const t = r.threads.find(x => x.id === id);
  if (!t) throw new Error('That comment thread is gone');
  edit(t, r);
  const kept = r.threads.includes(t);
  if (kept) t.updatedAt = new Date().toISOString();
  saveReview(r);
  return kept ? t : null;
}

export function replyThread(runId: string, id: string, text: string): Thread {
  const b = body(text);
  return editThread(runId, id, t => {
    t.comments.push({ id: newId(), author: 'You', body: b, at: new Date().toISOString() });
    // A new reply on a resolved thread reopens it, as a reviewer would expect.
    t.status = 'open';
  })!;
}

export function editComment(runId: string, id: string, commentId: string, text: string): Thread {
  const b = body(text);
  return editThread(runId, id, t => {
    const c = t.comments.find(x => x.id === commentId);
    if (!c || c.system) throw new Error('That comment is gone');
    c.body = b;
    c.editedAt = new Date().toISOString();
  })!;
}

/** Delete one comment; deleting the last one deletes the thread. */
export function deleteComment(runId: string, id: string, commentId: string): Thread | null {
  return editThread(runId, id, (t, r) => {
    const i = t.comments.findIndex(x => x.id === commentId);
    if (i < 0) throw new Error('That comment is gone');
    t.comments.splice(i, 1);
    if (!t.comments.length) r.threads.splice(r.threads.indexOf(t), 1);
  });
}

export function deleteThread(runId: string, id: string): void {
  editThread(runId, id, (t, r) => {
    r.threads.splice(r.threads.indexOf(t), 1);
  });
}

export function resolveThread(runId: string, id: string, resolved: boolean): Thread {
  return editThread(runId, id, t => {
    t.status = resolved ? 'resolved' : 'open';
  })!;
}

export function markSeen(runId: string, head: string): void {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('bad commit id');
  const r = loadReview(runId);
  if (r.seenHead === head) return;
  r.seenHead = head;
  saveReview(r);
}

function quote(lines: string[], first: number): string {
  const w = String(first + lines.length - 1).length;
  return lines.map((l, i) => `${String(first + i).padStart(w)} | ${l}`).join('\n');
}

/** What a helper reads: each comment with the code it is about. */
export function taskText(file: string, threads: Array<Thread & { lineNow?: number }>): string {
  const parts = [`Review comments on ${file} from the person reviewing this sprint. Address each one in the code, then commit.`, ''];
  threads.forEach((t, i) => {
    const line: number = t.lineNow ?? t.line;
    const side = t.side === 'old' ? ' (in the old version of the file, before this sprint)' : '';
    const last = line + t.anchor.length - 1;
    parts.push(`${i + 1}. ${last === line ? `Line ${line}` : `Lines ${line}-${last}`}${side}:`);
    parts.push('```');
    parts.push(quote(t.anchor.slice(0, 40), line));
    if (t.anchor.length > 40) parts.push(`... (${t.anchor.length - 40} more lines)`);
    parts.push('```');
    for (const c of t.comments.filter(x => !x.system)) {
      parts.push(c.body.replace(/```suggestion\n([\s\S]*?)```/g, (_m, s) => `Suggested replacement for those lines:\n\`\`\`\n${s}\`\`\``));
    }
    parts.push('');
  });
  return parts.join('\n').trim();
}

export interface SendResult {
  mode: 'tasks' | 'follow-up';
  /** added: joined a task that was already waiting; after: queued behind one a helper is on. */
  tasks?: Array<{ id: string; file: string; threads: number; added?: boolean; after?: string }>;
  followUp?: string;
  notified?: number;
}

/**
 * Hand open, unsent comments to the helpers. A running sprint gets one task
 * per file in its task list (and a heads-up to the helpers building now); a
 * finished one gets a follow-up sprint that starts from its branch.
 */
export async function sendThreads(ctx: ReviewContext, ids?: string[]): Promise<SendResult> {
  const view = await reviewView(ctx);
  const pick = view.threads.filter(t => t.status === 'open' && !t.sent && (!ids || ids.includes(t.id)));
  if (!pick.length) throw new Error('No open comments to send');
  const byFile = new Map<string, ThreadView[]>();
  for (const t of pick) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  const now = new Date().toISOString();
  const sent = new Map<string, NonNullable<Thread['sent']>>();
  let result: SendResult;

  if (ctx.live) {
    const tasks: NonNullable<SendResult['tasks']> = [];
    const statusOf = new Map((ctx.tasks ?? []).map(t => [t.id, t.status]));
    for (const [file, list] of byFile) {
      // Comments sent earlier on this file: add to that task while nobody has
      // started it, or queue the new task behind it so two helpers never
      // change the same file at once.
      const earlier = [...new Set(view.threads.filter(t => t.file === file && t.sent?.taskId).map(t => t.sent!.taskId!))];
      const waiting = earlier.find(id => statusOf.get(id) === 'open');
      if (waiting) {
        await commentTask(ctx.rec, waiting, `More review comments on this file:\n\n${taskText(file, list)}`);
        tasks.push({ id: waiting, file, threads: list.length, added: true });
        for (const t of list) sent.set(t.id, { at: now, taskId: waiting });
        continue;
      }
      const created = await createTask(ctx.rec, {
        title: `Address review comments on ${file}`.slice(0, 200),
        description: taskText(file, list),
        acceptance: `Every review comment on ${file} listed above is addressed in the code.`,
        type: 'task',
        priority: 1,
        labels: ['review'],
      });
      const busy = earlier.find(id => statusOf.get(id) === 'in_progress');
      if (busy) await addDependency(ctx.rec, created.id, busy).catch(() => {});
      tasks.push({ id: created.id, file, threads: list.length, ...(busy ? { after: busy } : {}) });
      for (const t of list) sent.set(t.id, { at: now, taskId: created.id });
    }
    result = { mode: 'tasks', tasks, notified: notifyBuilders(ctx, tasks) };
  } else {
    if (!ctx.launch) throw new Error('This sprint has finished, and no follow-up can be started from here');
    const ask = [
      `Address the review comments on the work from the sprint "${ctx.rec.title}". The work is already on this branch; change only what the comments ask for.`,
      '',
      ...[...byFile].map(([file, list]) => taskText(file, list)),
    ].join('\n\n');
    const launched = await ctx.launch({
      repo: ctx.rec.repo,
      ask: ask.slice(0, 60000),
      title: `Review fixes: ${ctx.rec.title}`.slice(0, 120),
      base: ctx.rec.branch,
      design: ctx.rec.designId,
      goal: ctx.rec.goal,
    });
    for (const t of pick) sent.set(t.id, { at: now, followUp: launched.runId });
    result = { mode: 'follow-up', followUp: launched.runId };
  }

  const r = loadReview(ctx.rec.runId);
  for (const t of r.threads) {
    const s = sent.get(t.id);
    if (s) {
      t.sent = s;
      t.updatedAt = now;
    }
  }
  saveReview(r);
  return result;
}

/** A short note, through each busy helper's inbox, that review work was filed. */
function notifyBuilders(ctx: ReviewContext, tasks: NonNullable<SendResult['tasks']>): number {
  let n = 0;
  const files = tasks.map(t => t.file).join(', ');
  const note = `Note from the sprint: the person reviewing this sprint left comments on ${files}. They were filed as ${tasks.map(t => t.id).join(', ')} and another helper will take them; do not start them yourself. If you are changing those files right now, expect that follow-up work.\n`;
  for (const name of new Set(ctx.building ?? [])) {
    const i = ctx.rec.helpers.indexOf(name);
    if (i < 0) continue;
    const clone = path.join(ctx.rec.workspace, `h${i}`);
    if (!fs.existsSync(path.join(clone, '.git'))) continue;
    const dir = path.join(clone, '.lazyfleet');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'inbox.txt'), note);
      n++;
    } catch {
      // a helper copy that is gone just misses the note
    }
  }
  return n;
}
