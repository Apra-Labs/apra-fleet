/**
 * Turn a sprint run's live state file into a board: columns of task cards,
 * epic swimlanes, the helpers working right now, phases and totals.
 *
 * The run state is written by the sprint engine's viewer
 * (<fleet data>/running/<runId>.json while live, old_runs/ once finished).
 * Everything here is pure so it can be tested from fixtures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../paths.js';

export type Column = 'todo' | 'blocked' | 'progress' | 'done';

export const COLUMNS: Array<{ key: Column; title: string }> = [
  { key: 'todo', title: 'To Do' },
  { key: 'blocked', title: 'Blocked' },
  { key: 'progress', title: 'In Progress' },
  { key: 'done', title: 'Done' },
];

export interface BeadsTask {
  id: string;
  title?: string;
  description?: string;
  acceptance_criteria?: string;
  notes?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  assignee?: string;
  parent?: string;
  ready?: boolean;
  placement?: string;
  created_at?: string;
  started_at?: string;
  closed_at?: string;
  close_reason?: string;
  metadata?: Record<string, unknown>;
  dependencies?: Array<{ issue_id: string; depends_on_id: string; type: string }>;
}

export interface Activity {
  id: string;
  type?: string;
  phase?: string;
  label?: string;
  member?: string;
  model?: string;
  startTime?: number;
  isRunning?: boolean;
  duration?: number;
  cost?: number;
  success?: boolean;
  command?: string;
}

export interface RunState {
  workflowName?: string;
  status?: string;
  runId: string;
  args?: { members?: string[]; targetIssues?: string[]; goal?: string } | null;
  result?: unknown;
  terminalReason?: string | null;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string | null;
  stats?: { activitiesCount?: number; totalTokens?: number; totalCost?: number; durationMs?: number };
  pause?: { status?: string; reason?: string | null };
  tree?: Array<{ title?: string; phases?: Array<{ title?: string; phaseStartedAt?: string; phaseEndedAt?: string | null; events?: Array<{ type?: string; data?: Activity }> }> }>;
  extensions?: {
    beads?: { sprintTasks?: BeadsTask[]; backlogTasks?: BeadsTask[]; goalMax?: number; decomposedParentIds?: string[] };
    pipeline?: PipelineState;
  };
}

/** What the engine's build pipeline publishes (fleet-sprint phases/develop-pipeline.mjs). */
export interface PipelineState {
  cycle?: number;
  parallel?: boolean;
  limit?: number | null;
  builders?: string[];
  freeBuilders?: number;
  building?: Array<{ taskId: string; member: string; since?: number; stage?: 'building' | 'landing' | 'fixing' }>;
  waitingForMember?: number;
  landedIds?: string[];
  givenUpIds?: string[];
  events?: Array<{ at: string; kind: 'started' | 'landed' | 'bounce' | 'given-back' | 'notified'; taskId: string; member: string; detail?: string }>;
}

export interface WorkingOn {
  member: string;
  label: string;
  text: string;
  model?: string;
  phase?: string;
  since?: number;
}

export interface Card {
  id: string;
  title: string;
  type: string;
  priority: number;
  column: Column;
  status: string;
  lane: string;
  inSprint: boolean;
  model?: string;
  /** Helpers on this task right now. */
  working: WorkingOn[];
  /** Last helper that touched it, when nobody is on it now. */
  lastHelper?: string;
  blockedBy: string[];
  startedAt?: string;
  closedAt?: string;
  /** Pipeline mode: where the task is between building and landing. */
  stage?: 'building' | 'landing' | 'fixing';
  /** Pipeline mode: times it could not land and went back to its doer. */
  bounces: number;
}

export interface Lane {
  id: string;
  title: string;
  type: string;
  status: string;
  total: number;
  done: number;
}

export interface HelperNow {
  member: string;
  label: string;
  text: string;
  phase?: string;
  model?: string;
  since?: number;
  taskIds: string[];
  kind: 'agent' | 'command';
}

export const STAGES = ['Plan', 'Build', 'Review', 'Test', 'Wrap up'] as const;
export type Stage = (typeof STAGES)[number];

/** Engine phase title ("Develop C2 R1") -> the plain stage it belongs to, and its cycle. */
export function stageOf(title: string): { stage: Stage | null; cycle: number | null } {
  const m = /\bC(\d+)\b/.exec(title);
  const cycle = m ? Number(m[1]) : null;
  const t = title.toLowerCase();
  let stage: Stage | null = null;
  if (/^(re-?)?plan\b|^replan/.test(t)) stage = 'Plan';
  else if (/^develop/.test(t)) stage = 'Build';
  else if (/review/.test(t)) stage = 'Review';
  else if (/deploy|integ|regression|test/.test(t)) stage = 'Test';
  else if (/harvest|publish/.test(t)) stage = 'Wrap up';
  return { stage, cycle };
}

export interface Board {
  runId: string;
  title: string;
  status: string;
  live: boolean;
  startedAt?: string;
  endedAt?: string | null;
  updatedAt?: string;
  goal?: string;
  members: string[];
  phases: Array<{ title: string; startedAt?: string; endedAt?: string | null; current: boolean }>;
  currentPhase?: string;
  /** The five plain stages for the current cycle. */
  stages: Array<{ stage: Stage; state: 'done' | 'current' | 'todo' }>;
  cycle: number;
  columns: typeof COLUMNS;
  lanes: Lane[];
  cards: Card[];
  helpersNow: HelperNow[];
  recent: Array<{ member: string; label: string; text: string; phase?: string; success?: boolean; duration?: number; cost?: number; endedAt?: number; taskIds: string[] }>;
  progress: { done: number; total: number };
  cost: number;
  tokens: number;
  result?: unknown;
  /** Present when the sprint runs in pipeline mode. */
  pipeline?: {
    building: number;
    landing: number;
    waitingForMember: number;
    builders: number;
    limit: number | null;
    events: NonNullable<PipelineState['events']>;
  };
}

export function fleetDataDir(): string {
  return process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** A run state belongs on the board only if it is a sprint (it carries tasks). */
export function isSprintRun(s: RunState | null): s is RunState {
  return !!s && typeof s.runId === 'string' && (!!s.extensions?.beads || /sprint/i.test(s.workflowName ?? ''));
}

export interface RunFile {
  state: RunState;
  live: boolean;
  file: string;
}

/** Every sprint run on this machine, newest first. */
export function listRunFiles(dataDir = fleetDataDir()): RunFile[] {
  const out: RunFile[] = [];
  for (const [dir, live] of [['running', true], ['old_runs', false]] as const) {
    const full = path.join(dataDir, dir);
    let names: string[] = [];
    try {
      names = fs.readdirSync(full).filter(n => n.endsWith('.json'));
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(full, n);
      const state = readJson<RunState>(file);
      if (isSprintRun(state)) out.push({ state, live, file });
    }
  }
  out.sort((a, b) => (b.state.startedAt ?? '').localeCompare(a.state.startedAt ?? ''));
  return out;
}

export function findRun(runId: string, dataDir = fleetDataDir()): RunFile | null {
  return listRunFiles(dataDir).find(r => r.state.runId === runId) ?? null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Task ids mentioned in `text`, whole ids only (x.1 does not match inside x.10 or x.1.2). */
export function mentionedIds(text: string, ids: string[]): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const id of ids) {
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(id)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`);
    if (re.test(text)) hits.push(id);
  }
  return hits;
}

/** What a helper is doing, in plain words instead of the engine's step names. */
export function describeActivity(label: string, taskIds: string[], titleOf: (id: string) => string | undefined): string {
  const l = label.trim();
  const first = taskIds[0] ? titleOf(taskIds[0]) ?? taskIds[0] : '';
  const more = taskIds.length > 1 ? ` (+${taskIds.length - 1} more)` : '';
  const on = first ? `: ${first}${more}` : '';
  if (/streak assignment/i.test(l)) return 'Splitting the work between helpers';
  if (/plan review|review.*plan/i.test(l)) return 'Checking the plan';
  if (/re-?plan/i.test(l)) return 'Re-planning what is left';
  if (/planner|^plan\b/i.test(l)) return 'Planning the work and creating issues';
  if (/final review/i.test(l)) return 'Final review of the whole sprint';
  if (/re-?review|review/i.test(l)) return `Reviewing${on}`;
  if (/streak|doer|impl/i.test(l)) return `Working on${on}`;
  if (/deploy/i.test(l)) return 'Setting up a test environment';
  if (/regression/i.test(l)) return 'Checking nothing else broke';
  if (/integ|test/i.test(l)) return 'Testing the changes';
  if (/harvest/i.test(l)) return 'Writing up what was learned';
  if (/publish|pull request|\bpr\b/i.test(l)) return 'Opening the pull request';
  return first ? `${l}${on}` : l;
}

export function columnFor(t: BeadsTask): Column {
  switch (t.status) {
    case 'closed':
      return 'done';
    case 'in_progress':
      return 'progress';
    case 'blocked':
    case 'deferred':
      return 'blocked';
    default:
      return t.ready === false ? 'blocked' : 'todo';
  }
}

function activities(state: RunState): Activity[] {
  const out: Activity[] = [];
  for (const g of state.tree ?? []) {
    for (const p of g.phases ?? []) {
      for (const e of p.events ?? []) {
        if (e?.type === 'activity' && e.data && typeof e.data.id === 'string') out.push({ phase: p.title, ...e.data });
      }
    }
  }
  return out;
}

const PARENT_TYPES = new Set(['epic', 'feature']);

export function runTitle(state: RunState, fallback?: string): string {
  const roots = state.args?.targetIssues ?? [];
  const tasks = [...(state.extensions?.beads?.sprintTasks ?? []), ...(state.extensions?.beads?.backlogTasks ?? [])];
  const root = tasks.find(t => roots.includes(t.id));
  return root?.title ?? fallback ?? (roots.length ? roots.join(', ') : state.runId);
}

export function buildBoard(run: RunFile, opts: { title?: string } = {}): Board {
  const { state, live } = run;
  const beads = state.extensions?.beads ?? {};
  const sprint = (beads.sprintTasks ?? []).map(t => ({ ...t, inSprint: true }));
  const backlog = (beads.backlogTasks ?? []).map(t => ({ ...t, inSprint: false }));
  const all = [...sprint, ...backlog];
  const byId = new Map(all.map(t => [t.id, t]));
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length);

  // Anything with children, or typed epic/feature, is a lane rather than a card.
  const parents = new Set<string>(beads.decomposedParentIds ?? []);
  for (const t of all) {
    if (t.parent) parents.add(t.parent);
    if (PARENT_TYPES.has(t.issue_type ?? '')) parents.add(t.id);
  }

  // Only AI work counts as a helper working; the engine's own git/bd
  // bookkeeping steps are recorded as 'command' activities and would drown it.
  const acts = activities(state).filter(a => a.type !== 'command');
  const pipe = state.extensions?.pipeline;
  const stageOfTask = new Map((live ? pipe?.building ?? [] : []).map(b => [b.taskId, b.stage ?? 'building']));
  const bounceCount = new Map<string, number>();
  for (const e of pipe?.events ?? []) if (e.kind === 'bounce') bounceCount.set(e.taskId, (bounceCount.get(e.taskId) ?? 0) + 1);
  const running = acts.filter(a => a.isRunning);
  const workingBy = new Map<string, WorkingOn[]>();
  const lastBy = new Map<string, string>();
  const helpersNow: HelperNow[] = [];
  const leafIds = ids.filter(id => !parents.has(id));
  const titleOf = (id: string) => byId.get(id)?.title;
  const say = (a: Activity, hit: string[]) => describeActivity(a.label ?? a.phase ?? '', hit, titleOf);

  for (const a of acts) {
    const hit = mentionedIds(`${a.label ?? ''} ${a.command ?? ''}`, leafIds);
    if (a.isRunning) {
      for (const id of hit) {
        const list = workingBy.get(id) ?? [];
        list.push({ member: a.member ?? 'helper', label: a.label ?? '', text: say(a, hit), model: a.model, phase: stageOf(a.phase ?? '').stage ?? a.phase, since: a.startTime });
        workingBy.set(id, list);
      }
    } else if (a.member) {
      for (const id of hit) lastBy.set(id, a.member);
    }
  }
  for (const a of running) {
    const taskIds = mentionedIds(`${a.label ?? ''} ${a.command ?? ''}`, leafIds);
    helpersNow.push({
      member: a.member ?? 'helper',
      label: a.label ?? '',
      text: say(a, taskIds),
      phase: stageOf(a.phase ?? '').stage ?? a.phase,
      model: a.model,
      since: a.startTime,
      taskIds,
      kind: a.type === 'command' ? 'command' : 'agent',
    });
  }

  // Nearest ancestor that is a lane.
  const laneOf = (t: BeadsTask): string => {
    let cur = t.parent;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (parents.has(cur)) return cur;
      cur = byId.get(cur)?.parent;
    }
    return '';
  };

  const cards: Card[] = [];
  for (const t of all) {
    if (parents.has(t.id)) continue;
    const blockedBy = (t.dependencies ?? [])
      .filter(d => d.type === 'blocks' && d.issue_id === t.id)
      .map(d => d.depends_on_id)
      .filter(id => byId.get(id)?.status !== 'closed');
    const working = workingBy.get(t.id) ?? [];
    let column = columnFor(t);
    // A helper on it is the truth, even before the task's status catches up.
    if (working.length && column !== 'done') column = 'progress';
    cards.push({
      id: t.id,
      title: t.title ?? t.id,
      type: t.issue_type ?? 'task',
      priority: typeof t.priority === 'number' ? t.priority : 2,
      column,
      status: t.status ?? 'open',
      lane: laneOf(t),
      inSprint: t.inSprint,
      model: typeof t.metadata?.model === 'string' ? (t.metadata.model as string) : undefined,
      working,
      lastHelper: working.length ? undefined : lastBy.get(t.id) ?? t.assignee,
      blockedBy,
      startedAt: t.started_at,
      closedAt: t.closed_at,
      ...(stageOfTask.has(t.id) && column !== 'done' ? { stage: stageOfTask.get(t.id) } : {}),
      bounces: bounceCount.get(t.id) ?? 0,
    });
  }
  cards.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, undefined, { numeric: true }));

  const lanes: Lane[] = [];
  const laneIds = [...new Set(cards.map(c => c.lane))];
  for (const id of laneIds) {
    const t = id ? byId.get(id) : undefined;
    const members = cards.filter(c => c.lane === id);
    lanes.push({
      id,
      title: id ? t?.title ?? id : 'Other work',
      type: id ? t?.issue_type ?? 'epic' : 'none',
      status: id ? t?.status ?? 'open' : 'open',
      total: members.length,
      done: members.filter(c => c.column === 'done').length,
    });
  }
  lanes.sort((a, b) => (a.id === '' ? 1 : b.id === '' ? -1 : a.id.localeCompare(b.id, undefined, { numeric: true })));

  const phases: Board['phases'] = [];
  for (const g of state.tree ?? []) {
    for (const p of g.phases ?? []) {
      if (!p.title || p.title === 'Initialization') continue;
      phases.push({ title: p.title, startedAt: p.phaseStartedAt, endedAt: p.phaseEndedAt ?? null, current: false });
    }
  }
  const current = live ? [...phases].reverse().find(p => !p.endedAt) : undefined;
  if (current) current.current = true;

  const staged = phases.map(p => ({ ...p, ...stageOf(p.title) })).filter(p => p.stage);
  const last = staged[staged.length - 1];
  const cycle = last?.cycle ?? 1;
  const inCycle = staged.filter(p => (p.cycle ?? cycle) === cycle);
  const currentStage = current ? stageOf(current.title).stage : null;
  const reached = new Set(inCycle.map(p => p.stage));
  const furthest = Math.max(-1, ...inCycle.map(p => STAGES.indexOf(p.stage!)));
  const stages = STAGES.map((stage, i) => ({
    stage,
    state: (stage === currentStage ? 'current' : reached.has(stage) || (!live && i <= furthest) || i < STAGES.indexOf(currentStage ?? 'Plan') ? 'done' : 'todo') as 'done' | 'current' | 'todo',
  }));

  const recent = acts
    .filter(a => !a.isRunning && a.member)
    .map(a => ({
      member: a.member!,
      label: a.label ?? '',
      text: say(a, mentionedIds(`${a.label ?? ''} ${a.command ?? ''}`, leafIds)),
      phase: stageOf(a.phase ?? '').stage ?? a.phase,
      success: a.success,
      duration: a.duration,
      cost: a.cost,
      endedAt: a.startTime !== undefined && a.duration !== undefined ? a.startTime + a.duration : a.startTime,
      taskIds: mentionedIds(`${a.label ?? ''} ${a.command ?? ''}`, leafIds),
    }))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 40);

  const inSprintCards = cards.filter(c => c.inSprint);
  return {
    runId: state.runId,
    title: opts.title ?? runTitle(state),
    status: live ? (state.pause?.status && state.pause.status !== 'none' ? state.pause.status : 'running') : state.status ?? 'finished',
    live,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    updatedAt: state.updatedAt,
    goal: state.args?.goal,
    members: state.args?.members ?? [],
    phases,
    currentPhase: current ? stageOf(current.title).stage ?? current.title : undefined,
    stages,
    cycle,
    columns: COLUMNS,
    lanes,
    cards,
    helpersNow,
    recent,
    progress: { done: inSprintCards.filter(c => c.column === 'done').length, total: inSprintCards.length },
    cost: state.stats?.totalCost ?? 0,
    tokens: state.stats?.totalTokens ?? 0,
    result: live ? undefined : state.result,
    ...(pipe ? {
      pipeline: {
        building: live ? (pipe.building ?? []).filter(b => b.stage !== 'landing').length : 0,
        landing: live ? (pipe.building ?? []).filter(b => b.stage === 'landing').length : 0,
        waitingForMember: live ? pipe.waitingForMember ?? 0 : 0,
        builders: (pipe.builders ?? []).length,
        limit: pipe.limit ?? null,
        events: (pipe.events ?? []).slice(-60).reverse(),
      },
    } : {}),
  };
}

/** Everything one card's detail drawer needs, from the same run state. */
export function taskDetail(run: RunFile, id: string): (BeadsTask & { history: Board['recent'] }) | null {
  const beads = run.state.extensions?.beads ?? {};
  const t = [...(beads.sprintTasks ?? []), ...(beads.backlogTasks ?? [])].find(x => x.id === id);
  if (!t) return null;
  const board = buildBoard(run);
  return { ...t, history: board.recent.filter(r => r.taskIds.includes(id)) };
}
