/**
 * One view over every sprint on this machine: the ones started from the
 * lazyfleet page (with repo/branch known, so code changes work) and any the
 * sprint engine ran from elsewhere (board only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, findRun, listRunFiles, runTitle, taskDetail, type Board, type BeadsTask, type RunFile } from './board.js';
import { codeChanges, commitDiff, fileDiff, fileLines } from './code.js';
import { getRecord, loadRegistry, type SprintRecord } from './launcher.js';
import { designSteps, getDesign } from './designs.js';
import { liveTasks, taskComments, taskDir } from './tasks.js';

export interface SprintSummary {
  runId: string;
  title: string;
  status: string;
  live: boolean;
  startedAt?: string;
  endedAt?: string | null;
  progress: { done: number; total: number };
  working: number;
  helpers: number;
  currentPhase?: string;
  cost: number;
  branch?: string;
  repo?: string;
  setup?: SprintRecord['setup'];
  design?: string;
  /** The final reviewer's PASS/FAIL once the sprint has finished. */
  verdict?: string;
  issue?: SprintRecord['issue'];
  scheduleId?: string;
}

function engineGone(rec: SprintRecord): boolean {
  if (!rec.pid) return true;
  try {
    process.kill(rec.pid, 0);
    return false;
  } catch {
    return true;
  }
}

function verdictOf(result: unknown): string | undefined {
  const r = result && typeof result === 'object' ? (result as { verdict?: unknown; notes?: unknown }) : undefined;
  const v = r?.verdict;
  if (typeof v !== 'string') return undefined;
  // Designs without a final review decide from task state: say that, not "review failed".
  if (typeof r?.notes === 'string' && /final review is turned off/i.test(r.notes)) return v === 'PASS' ? 'DONE' : 'OPEN';
  return v;
}

/** The steps of the design a sprint follows, when it was started from this page. */
function designFor(rec: SprintRecord | undefined) {
  if (!rec?.designId) return undefined;
  try {
    const d = getDesign(rec.designId, rec.repo);
    return { id: d.id, name: d.name, steps: designSteps(d) };
  } catch {
    return { id: rec.designId, name: rec.designName ?? rec.designId, steps: [] };
  }
}

export function listSprints(): SprintSummary[] {
  const records = loadRegistry();
  const byRun = new Map(records.map(r => [r.runId, r]));
  const out: SprintSummary[] = [];
  const seen = new Set<string>();

  for (const run of listRunFiles()) {
    const rec = byRun.get(run.state.runId);
    const b = buildBoard(run, { title: rec?.title });
    seen.add(run.state.runId);
    out.push({
      runId: b.runId,
      title: rec?.title ?? runTitle(run.state),
      // A "running" file whose engine died never gets moved; say so.
      status: run.live && rec && engineGone(rec) ? 'stopped' : b.status,
      live: run.live && !(rec && engineGone(rec)),
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      progress: b.progress,
      working: b.helpersNow.length,
      helpers: b.members.length,
      currentPhase: b.phaseText ?? b.currentPhase,
      cost: b.cost,
      branch: rec?.branch,
      repo: rec?.repo,
      setup: rec?.setup,
      design: rec?.designName,
      verdict: verdictOf(b.result),
      issue: rec?.issue,
      scheduleId: rec?.scheduleId,
    });
  }

  // Launched here but the engine has not written its first state yet (or never will).
  for (const rec of records) {
    if (seen.has(rec.runId)) continue;
    const starting = rec.setup.state === 'preparing' || (rec.setup.state === 'started' && !engineGone(rec));
    out.push({
      runId: rec.runId,
      title: rec.title,
      status: rec.setup.state === 'failed' ? 'failed' : starting ? 'starting' : 'stopped',
      live: starting,
      startedAt: rec.createdAt,
      progress: { done: 0, total: 0 },
      working: 0,
      helpers: rec.helpers.length,
      cost: 0,
      branch: rec.branch,
      repo: rec.repo,
      setup: rec.setup,
      design: rec.designName,
      issue: rec.issue,
      scheduleId: rec.scheduleId,
    });
  }
  out.sort((a, b) => Number(b.live) - Number(a.live) || (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return out;
}

export interface SprintView {
  record?: Omit<SprintRecord, 'pid'>;
  board?: Board;
  status: string;
  design?: { id: string; name: string; steps: Array<{ step: string; detail: string; on: boolean }> };
  verdict?: string;
}

export function sprintView(runId: string): SprintView | null {
  const rec = getRecord(runId);
  const run = findRun(runId);
  if (!rec && !run) return null;
  const record = rec ? (({ pid: _pid, ...rest }) => rest)(rec) : undefined;
  if (!run) {
    const status = rec!.setup.state === 'failed' ? 'failed' : rec!.setup.state === 'preparing' || !engineGone(rec!) ? 'starting' : 'stopped';
    return { record, status };
  }
  const board = buildBoard(run, { title: rec?.title });
  if (run.live && rec && engineGone(rec)) {
    board.live = false;
    board.status = 'stopped';
  }
  return { record, board, status: board.status, design: designFor(rec), verdict: verdictOf(board.result) };
}

/** The run with its task list read live from bd, so board changes show at once. */
async function withLiveTasks(rec: SprintRecord | undefined, run: RunFile): Promise<{ run: RunFile; tasks?: BeadsTask[] }> {
  const pending = rec ? liveTasks(rec) : null;
  if (!pending) return { run };
  try {
    const tasks = await pending;
    if (!tasks.length) return { run };
    const beads = run.state.extensions?.beads ?? {};
    const state = {
      ...run.state,
      extensions: {
        ...run.state.extensions,
        beads: { ...beads, sprintTasks: tasks.filter(t => t.placement !== 'backlog'), backlogTasks: tasks.filter(t => t.placement === 'backlog') },
      },
    };
    return { run: { ...run, state }, tasks };
  } catch {
    return { run };
  }
}

export interface LiveSprintView extends SprintView {
  /** Board changes (new task, priority, notes, skip) go through bd here. */
  canEdit: boolean;
}

export async function sprintViewLive(runId: string): Promise<LiveSprintView | null> {
  const rec = getRecord(runId);
  const run = findRun(runId);
  const base = sprintView(runId);
  if (!base) return null;
  if (!run || !base.board) return { ...base, canEdit: false };
  const live = await withLiveTasks(rec, run);
  if (live.run === run) return { ...base, canEdit: false };
  const board = buildBoard(live.run, { title: rec?.title });
  board.live = base.board.live;
  board.status = base.board.status;
  return { ...base, board, canEdit: !!taskDir(rec) && board.live };
}

export function sprintTask(runId: string, taskId: string) {
  const run = findRun(runId);
  return run ? taskDetail(run, taskId) : null;
}

export async function sprintTaskLive(runId: string, taskId: string) {
  const rec = getRecord(runId);
  const run = findRun(runId);
  if (!run) return null;
  const live = await withLiveTasks(rec, run);
  const t = taskDetail(live.run, taskId);
  if (!t) return null;
  return { ...t, comments: rec ? await taskComments(rec, taskId) : [], canEdit: !!taskDir(rec) && run.live };
}

/** The tasks a review can link to, and who is building right now. */
export async function reviewContextFor(runId: string) {
  const rec = getRecord(runId);
  if (!rec) throw new Error('Reviews work on sprints started from this page');
  const run = findRun(runId);
  const view = sprintView(runId);
  const tasks = run ? (await withLiveTasks(rec, run)).tasks ?? [...(run.state.extensions?.beads?.sprintTasks ?? []), ...(run.state.extensions?.beads?.backlogTasks ?? [])] : [];
  const live = !!view && (view.status === 'running' || view.status === 'starting' || view.status === 'pausing' || view.status === 'paused');
  const building = (run?.state.extensions?.pipeline?.building ?? []).map(b => b.member);
  return { rec, repo: codeRepo(rec), tasks, live, building };
}

/** Where to read git from: helper 1's clone has every sprint commit. */
function codeRepo(rec: SprintRecord): string {
  const h0 = path.join(rec.workspace, 'h0');
  return fs.existsSync(path.join(h0, '.git')) ? h0 : rec.repo;
}

export async function sprintCode(runId: string, opts: { since?: string } = {}) {
  const rec = getRecord(runId);
  if (!rec) return { available: false, reason: 'Code changes are shown for sprints started from this page', commits: [], files: [], totals: { added: 0, removed: 0, files: 0 } };
  return codeChanges(codeRepo(rec), rec.branch, rec.base, opts);
}

export async function sprintFileDiff(runId: string, file: string, opts: { since?: string; context?: number } = {}) {
  const rec = getRecord(runId);
  if (!rec) throw new Error('unknown sprint');
  return fileDiff(codeRepo(rec), rec.branch, rec.base, file, opts);
}

export async function sprintFileLines(runId: string, file: string, side: 'old' | 'new') {
  const rec = getRecord(runId);
  if (!rec) throw new Error('unknown sprint');
  return fileLines(codeRepo(rec), rec.branch, rec.base, file, side);
}

export async function sprintCommitDiff(runId: string, sha: string) {
  const rec = getRecord(runId);
  if (!rec) throw new Error('unknown sprint');
  return commitDiff(codeRepo(rec), rec.branch, rec.base, sha);
}

/** Last lines of the engine's own log, for when something goes wrong. */
export function sprintLog(runId: string, lines = 200): string {
  const rec = getRecord(runId);
  if (!rec) return '';
  try {
    const text = fs.readFileSync(rec.logPath, 'utf-8');
    return text.split('\n').slice(-Math.min(Math.max(lines, 10), 2000)).join('\n');
  } catch {
    return '';
  }
}
