/**
 * Schedules: sprints that start themselves.
 *
 * A schedule says when (every day at a time, on chosen weekdays, or every N
 * hours), what (a fixed ask, or the oldest open GitHub issues with chosen
 * labels), with which design (a fixed one, or the advisor's pick), and within
 * which limits (sprints per day, usage per day, a quiet window, a clean
 * working tree, trusted issue authors only). The lazyfleet background process
 * calls tick() every half minute. Every decision, including a skip, is
 * written to the schedule's log with its reason, so "why didn't it run?"
 * always has an answer.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lazyDir } from './config.js';
import { askFromIssue, commentOnIssue, TRUSTED_ASSOCIATIONS, validRepo, type Issue } from './github.js';

export interface ScheduleWhen {
  /** 'daily': at `time` on `days`; 'interval': every `hours`. */
  type: 'daily' | 'interval';
  time?: string;
  /** 0 = Sunday ... 6 = Saturday; empty or missing means every day. */
  days?: number[];
  hours?: number;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  /** Local project folder the sprint runs in. */
  repo: string;
  source: { type: 'ask'; ask: string } | { type: 'issues'; repo: string; labels: string[]; trustedOnly: boolean };
  /** A design id, or 'auto' for the advisor's pick each time. */
  design: string;
  when: ScheduleWhen;
  /** Local "HH:MM-HH:MM" window the schedule may start in; empty means any time. */
  window?: string;
  limits: { perDay: number; usagePerDay?: number };
  requireClean: boolean;
  /** Comment on the issue when the sprint finishes. */
  comment: boolean;
  createdAt: string;
  lastFiredAt?: string;
  /** Earliest time to try again after a skip that may clear by itself. */
  retryAt?: string;
  log: ScheduleLogEntry[];
}

export interface ScheduleLogEntry {
  at: string;
  action: 'started' | 'skipped' | 'commented' | 'error';
  text: string;
  runId?: string;
  issue?: { repo: string; number: number; title: string; url: string };
}

const LOG_KEEP = 60;
const RETRY_MINUTES = 10;

function file(): string {
  return path.join(lazyDir(), 'schedules.json');
}

export function loadSchedules(): Schedule[] {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf-8')) as Schedule[];
  } catch {
    return [];
  }
}

function saveAll(list: Schedule[]): void {
  fs.mkdirSync(lazyDir(), { recursive: true, mode: 0o700 });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file());
}

function update(id: string, fn: (s: Schedule) => void): Schedule | null {
  const list = loadSchedules();
  const s = list.find(x => x.id === id);
  if (!s) return null;
  fn(s);
  s.log = s.log.slice(-LOG_KEEP);
  saveAll(list);
  return s;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const LABEL_RE = /^[^,\n\r]{1,50}$/;

/** Check and fill in a schedule from the page. Throws with a message a person can act on. */
export function normalizeSchedule(raw: any, existing?: Schedule): Schedule {
  const name = String(raw?.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('Give the schedule a name (up to 80 characters)');
  const repo = String(raw?.repo ?? '').trim();
  if (!repo || !path.isAbsolute(repo)) throw new Error('Pick the project folder (a full path)');
  if (raw?.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('enabled must be true or false');
  let source: Schedule['source'];
  if (raw?.source?.type === 'issues') {
    const labels = (Array.isArray(raw.source.labels) ? raw.source.labels : String(raw.source.labels ?? '').split(','))
      .map((l: unknown) => String(l).trim()).filter(Boolean);
    if (!labels.length) throw new Error('Name at least one label, so only issues you marked get picked up');
    if (labels.some((l: string) => !LABEL_RE.test(l))) throw new Error('Labels are separated by commas');
    source = { type: 'issues', repo: validRepo(raw.source.repo), labels, trustedOnly: raw.source.trustedOnly !== false };
  } else {
    const ask = String(raw?.source?.ask ?? '').trim();
    if (ask.length < 10) throw new Error('Describe what the sprint should do (at least a sentence)');
    if (ask.length > 8000) throw new Error('Keep the job under 8000 characters');
    source = { type: 'ask', ask };
  }
  const w = raw?.when ?? {};
  let when: ScheduleWhen;
  if (w.type === 'interval') {
    const hours = w.hours;
    if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('Repeat every 1 to 168 hours');
    when = { type: 'interval', hours };
  } else {
    const time = String(w.time ?? '');
    if (!TIME_RE.test(time)) throw new Error('Pick a time like 02:00');
    if (w.days !== undefined && !Array.isArray(w.days)) throw new Error('Days are a list');
    const days: number[] = w.days ?? [];
    if (days.some(d => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Days are 0 (Sunday) to 6 (Saturday)');
    when = { type: 'daily', time, days: [...new Set<number>(days)].sort() };
  }
  const window = String(raw?.window ?? '').trim();
  if (window && !WINDOW_RE.test(window)) throw new Error('A time window looks like 22:00-07:00');
  if (window) {
    const [a, b] = window.split('-');
    if (a === b) throw new Error('The time window starts and ends at the same time, so it would never run');
    if (when.type === 'daily' && !inWindow(window, new Date(2000, 0, 1, ...(when.time!.split(':').map(Number) as [number, number])))) {
      throw new Error(`${when.time} is outside the window ${window}, so it would never run`);
    }
  }
  const perDay = raw?.limits?.perDay ?? 1;
  if (typeof perDay !== 'number' || !Number.isInteger(perDay) || perDay < 1 || perDay > 20) throw new Error('Sprints per day: a whole number from 1 to 20');
  const usage = raw?.limits?.usagePerDay;
  const usagePerDay = usage === undefined || usage === null || usage === '' ? undefined : usage;
  if (usagePerDay !== undefined && (typeof usagePerDay !== 'number' || !Number.isFinite(usagePerDay) || usagePerDay < 0.01 || usagePerDay > 1000)) throw new Error('Usage per day: between $0.01 and $1000 (an estimate)');
  const design = String(raw?.design ?? 'auto').trim() || 'auto';
  if (!/^[a-z0-9-]{1,40}$/.test(design)) throw new Error('Pick a design');
  return {
    id: existing?.id ?? crypto.randomBytes(6).toString('hex'),
    name,
    enabled: raw?.enabled !== false,
    repo,
    source,
    design,
    when,
    ...(window ? { window } : {}),
    limits: { perDay, ...(usagePerDay !== undefined ? { usagePerDay } : {}) },
    requireClean: raw?.requireClean !== false,
    comment: source.type === 'issues' && raw?.comment !== false,
    ...(raw?.requireClean !== undefined && typeof raw.requireClean !== 'boolean' ? (() => { throw new Error('requireClean must be true or false'); })() : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastFiredAt: existing?.lastFiredAt,
    log: existing?.log ?? [],
  };
}

export function saveSchedule(raw: any): Schedule {
  const list = loadSchedules();
  const existing = raw?.id ? list.find(s => s.id === raw.id) : undefined;
  const s = normalizeSchedule(raw, existing);
  // A changed timing starts fresh rather than firing at once for a missed slot.
  if (existing && JSON.stringify(existing.when) !== JSON.stringify(s.when)) s.lastFiredAt = new Date().toISOString();
  if (!existing) s.lastFiredAt = new Date().toISOString();
  delete s.retryAt;
  saveAll(existing ? list.map(x => (x.id === s.id ? s : x)) : [...list, s]);
  return s;
}

export function deleteSchedule(id: string): boolean {
  const list = loadSchedules();
  if (!list.some(s => s.id === id)) return false;
  saveAll(list.filter(s => s.id !== id));
  return true;
}

export function setEnabled(id: string, enabled: boolean): Schedule | null {
  return update(id, s => { s.enabled = enabled; delete s.retryAt; });
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** When this schedule is next due: the first daily slot after `after`, or one interval after the last start. */
export function nextRun(s: Pick<Schedule, 'when' | 'lastFiredAt' | 'createdAt'>, after: Date): Date {
  if (s.when.type === 'interval') {
    // Counted from the last start, so a slot missed while asleep runs once on waking.
    return new Date(Date.parse(s.lastFiredAt ?? s.createdAt) + (s.when.hours ?? 24) * 3600000);
  }
  const [h, m] = (s.when.time ?? '02:00').split(':').map(Number);
  const days = s.when.days && s.when.days.length ? s.when.days : [0, 1, 2, 3, 4, 5, 6];
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
    if (c.getTime() > after.getTime() && days.includes(c.getDay())) return c;
  }
  return new Date(after.getTime() + 7 * 86400000);
}

/** Is the schedule due now? A slot missed while the machine slept runs once, not once per missed slot. */
export function isDue(s: Schedule, now: Date): boolean {
  if (!s.enabled) return false;
  if (s.retryAt && Date.parse(s.retryAt) > now.getTime()) return false;
  if (s.retryAt) return true;
  const since = new Date(Date.parse(s.lastFiredAt ?? s.createdAt));
  return nextRun(s, since).getTime() <= now.getTime();
}

export function inWindow(window: string | undefined, now: Date): boolean {
  if (!window) return true;
  const [a, b] = window.split('-');
  const t = now.getHours() * 60 + now.getMinutes();
  const start = minutesOf(a), end = minutesOf(b);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Plain words for the page: "Weekdays at 02:00, 22:00-07:00 only". */
export function describeWhen(s: Pick<Schedule, 'when' | 'window'>): string {
  let out: string;
  if (s.when.type === 'interval') out = s.when.hours === 1 ? 'Every hour' : `Every ${s.when.hours} hours`;
  else {
    const days = s.when.days && s.when.days.length ? s.when.days : [0, 1, 2, 3, 4, 5, 6];
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const label = days.length === 7 ? 'Every day' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends' : days.map(d => names[d]).join(', ');
    out = `${label} at ${s.when.time}`;
  }
  return s.window ? `${out}, only ${s.window}` : out;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface SprintSummaryLike {
  runId: string;
  repo?: string;
  live: boolean;
  status: string;
  startedAt?: string;
  cost: number;
  verdict?: string;
  branch?: string;
  title: string;
  scheduleId?: string;
  issue?: { repo: string; number: number };
}

export interface TickDeps {
  now: () => Date;
  listSprints: () => SprintSummaryLike[];
  launch: (input: { repo: string; ask: string; title?: string; design?: string; issue?: Issue; scheduleId?: string }) => Promise<{ runId: string }>;
  recommend: (ask: string, repo: string) => { designId: string };
  /** Token for GitHub, or null when signed out. */
  githubToken: () => Promise<string | null>;
  listIssues: (token: string, repo: string, labels: string[]) => Promise<Issue[]>;
  comment: (token: string, repo: string, n: number, body: string) => Promise<string>;
  repoIsClean: (folder: string) => Promise<boolean | null>;
  /** Issues already sprinted, so each is picked up once. */
  sprintedIssues: () => Set<string>;
  reportedRuns: () => Set<string>;
  markReported: (runId: string) => void;
}

export function gitIsClean(folder: string): Promise<boolean | null> {
  return new Promise(resolve => {
    execFile('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: folder, timeout: 15000 }, (err, out) => resolve(err ? null : String(out).trim() === ''));
  });
}

function log(id: string, entry: Omit<ScheduleLogEntry, 'at'>, now: Date, patch: Partial<Schedule> = {}): void {
  update(id, s => {
    s.log.push({ at: now.toISOString(), ...entry });
    Object.assign(s, patch);
    if (patch.retryAt === undefined && 'retryAt' in patch) delete s.retryAt;
  });
}

/** Why this schedule may not start now, or null when it may. */
async function blocker(s: Schedule, now: Date, deps: TickDeps): Promise<{ text: string; retry: boolean } | null> {
  if (!inWindow(s.window, now)) return { text: `outside its window (${s.window})`, retry: true };
  const sprints = deps.listSprints();
  const busy = sprints.find(x => x.live && x.repo && path.resolve(x.repo) === path.resolve(s.repo));
  if (busy) return { text: `a sprint is already running in this project ("${busy.title}")`, retry: true };
  const mine = sprints.filter(x => x.scheduleId === s.id && x.startedAt && sameLocalDay(new Date(x.startedAt), now));
  if (mine.length >= s.limits.perDay) return { text: `already started ${mine.length} of ${s.limits.perDay} sprint${s.limits.perDay === 1 ? '' : 's'} today`, retry: false };
  if (s.limits.usagePerDay !== undefined) {
    const used = mine.reduce((a, x) => a + (x.cost || 0), 0);
    if (used >= s.limits.usagePerDay) return { text: `today's usage limit is spent ($${used.toFixed(2)} of $${s.limits.usagePerDay.toFixed(2)})`, retry: false };
  }
  if (!fs.existsSync(s.repo)) return { text: `the project folder ${s.repo} is missing`, retry: false };
  const clean = await deps.repoIsClean(s.repo);
  if (clean === null) return { text: `the project folder ${s.repo} is not a git checkout`, retry: false };
  if (s.requireClean && !clean) return { text: 'the project has uncommitted changes (you may be working in it)', retry: true };
  return null;
}

/** Folders a sprint is being started in right now, so two starts never race into one folder. */
const starting = new Set<string>();

/** Why Run now would normally not start: shown to the person, who may start it anyway. */
export async function runNowWarnings(s: Schedule, deps: TickDeps): Promise<string[]> {
  const out: string[] = [];
  if (!s.enabled) out.push('the schedule is off');
  const block = await blocker(s, deps.now(), deps);
  if (block) out.push(block.text);
  return out;
}

/**
 * Start one sprint for this schedule now, or log why not. Returns the run id
 * when it started. `override` (Run now, after the person confirmed) skips the
 * limits and the clean-folder check, but never starts a second sprint in a
 * folder that already has one running or starting.
 */
export async function fire(s: Schedule, deps: TickDeps, { override = false, manual = false } = {}): Promise<string | null> {
  const now = deps.now();
  const key = path.resolve(s.repo);
  if (starting.has(key)) {
    log(s.id, { action: 'skipped', text: 'Not started: another sprint is being started in this project right now.' }, now, { retryAt: new Date(now.getTime() + RETRY_MINUTES * 60000).toISOString() });
    return null;
  }
  const block = await blocker(s, now, deps);
  const busy = block && /already running in this project|folder .* is missing|not a git checkout/.test(block.text);
  if (block && (!override || busy)) {
    log(s.id, { action: 'skipped', text: `Not started: ${block.text}.` }, now, block.retry ? { retryAt: new Date(now.getTime() + RETRY_MINUTES * 60000).toISOString() } : { lastFiredAt: now.toISOString(), retryAt: undefined });
    return null;
  }
  starting.add(key);
  try {
    return await start(s, deps, now, manual ? (block ? `Run now by you, overriding: ${block.text}` : 'Run now by you') : '');
  } finally {
    starting.delete(key);
  }
}

async function start(s: Schedule, deps: TickDeps, now: Date, how: string): Promise<string | null> {
  let ask: string, title: string | undefined, issue: Issue | undefined;
  if (s.source.type === 'issues') {
    const token = await deps.githubToken();
    if (!token) {
      log(s.id, { action: 'skipped', text: 'Not started: sign in to GitHub to pick up issues.' }, now, { lastFiredAt: now.toISOString(), retryAt: undefined });
      return null;
    }
    let issues: Issue[];
    try {
      issues = await deps.listIssues(token, s.source.repo, s.source.labels);
    } catch (e) {
      log(s.id, { action: 'error', text: `Could not read issues from ${s.source.repo}: ${(e as Error).message}.` }, now, { retryAt: new Date(now.getTime() + RETRY_MINUTES * 60000).toISOString() });
      return null;
    }
    const done = deps.sprintedIssues();
    const fresh = issues.filter(i => !done.has(`${i.repo}#${i.number}`));
    const eligible = s.source.trustedOnly ? fresh.filter(i => TRUSTED_ASSOCIATIONS.has(i.association)) : fresh;
    if (!eligible.length) {
      const labeled = s.source.labels.join(' and ');
      // Say what happened to each issue, so "why not #15?" has an answer.
      const each = issues.slice(0, 8).map(i => done.has(`${i.repo}#${i.number}`) ? `#${i.number} already has a sprint` : `#${i.number} is from ${i.author}, not a repo member`);
      const why = issues.length ? `${issues.length} open issue${issues.length === 1 ? '' : 's'} labeled ${labeled}, none to pick up (${each.join('; ')}${issues.length > 8 ? '; ...' : ''})` : `no open issues labeled ${labeled}`;
      log(s.id, { action: 'skipped', text: `Nothing to do: ${why}.` }, now, { lastFiredAt: now.toISOString(), retryAt: undefined });
      return null;
    }
    issue = eligible[0];
    ask = askFromIssue(issue);
    title = `#${issue.number} ${issue.title}`.slice(0, 80);
  } else {
    ask = s.source.ask;
  }
  const design = s.design === 'auto' ? deps.recommend(ask, s.repo).designId : s.design;
  try {
    const { runId } = await deps.launch({ repo: s.repo, ask, title, design, issue, scheduleId: s.id });
    log(s.id, { action: 'started', text: `${how ? how + '. S' : 'S'}tarted "${title ?? ask.slice(0, 60)}" with the ${design} design.`, runId, ...(issue ? { issue: { repo: issue.repo, number: issue.number, title: issue.title, url: issue.url } } : {}) }, now, { lastFiredAt: now.toISOString(), retryAt: undefined });
    return runId;
  } catch (e) {
    log(s.id, { action: 'error', text: `Could not start: ${(e as Error).message}.` }, now, { lastFiredAt: now.toISOString(), retryAt: undefined });
    return null;
  }
}

/** The comment left on an issue when its sprint finishes. */
export function resultComment(x: SprintSummaryLike): string {
  const verdict = x.verdict === 'PASS' ? 'passed its final review'
    : x.verdict === 'DONE' ? 'finished with every task done'
    : x.verdict === 'OPEN' ? 'finished with tasks still open (see the board for what it found)'
    : x.verdict === 'FAIL' ? 'finished, but its final review found problems'
    : `ended (${x.status})`;
  return [
    `lazyfleet sprint "${x.title}" ${verdict}.`,
    '',
    x.branch ? `The work is on branch \`${x.branch}\`.` : '',
    `Estimated usage: $${(x.cost || 0).toFixed(2)}.`,
  ].filter(Boolean).join('\n');
}

const waitingForSignIn = new Set<string>();

/** One pass: start what is due, then report finished sprints back to their issues. */
export async function tick(deps: TickDeps): Promise<void> {
  const now = deps.now();
  for (const s of loadSchedules()) {
    if (isDue(s, now)) await fire(s, deps);
  }
  const reported = deps.reportedRuns();
  const byId = new Map(loadSchedules().map(s => [s.id, s]));
  for (const x of deps.listSprints()) {
    if (x.live || !x.issue || !x.scheduleId || reported.has(x.runId)) continue;
    const s = byId.get(x.scheduleId);
    if (!s || !s.comment) { deps.markReported(x.runId); continue; }
    const token = await deps.githubToken();
    if (!token) {
      if (!waitingForSignIn.has(x.runId)) {
        waitingForSignIn.add(x.runId);
        log(s.id, { action: 'error', text: `Could not report the result on ${x.issue.repo}#${x.issue.number}: signed out of GitHub. It will be posted once you sign in again.` }, now);
      }
      continue;
    }
    try {
      const url = await deps.comment(token, x.issue.repo, x.issue.number, resultComment(x));
      deps.markReported(x.runId);
      log(s.id, { action: 'commented', text: `Commented on ${x.issue.repo}#${x.issue.number}: "${resultComment(x).split('\n')[0]}"`, runId: x.runId, issue: { repo: x.issue.repo, number: x.issue.number, title: x.title, url } }, now);
    } catch (e) {
      log(s.id, { action: 'error', text: `Could not comment on ${x.issue.repo}#${x.issue.number}: ${(e as Error).message}.` }, now);
      deps.markReported(x.runId);
    }
  }
}
