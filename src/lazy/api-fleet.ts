/**
 * The Home, Issues and Schedules API, and the scheduler's heartbeat.
 * Routes live under /_lazy/api/ next to the sprint routes; the caller has
 * already checked the sign-in cookie and the CSRF header.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as gh from './github.js';
import type { Vault } from './vault.js';
import { evolveDesigns, outcomes, recommend, statsFor } from './sprints/advisor.js';
import { listDesigns } from './sprints/designs.js';
import { listSprints } from './sprints/index.js';
import { loadRegistry, markIssueReported, type LaunchInput } from './sprints/launcher.js';
import * as sched from './schedules.js';
import { lazyDir } from './config.js';

/** First-run welcome: done once, never nagging again. */
function welcomeFile(): string {
  return path.join(lazyDir(), 'welcome.json');
}
export function welcomeDone(): boolean {
  try {
    return JSON.parse(fs.readFileSync(welcomeFile(), 'utf-8')).done === true;
  } catch {
    return false;
  }
}
export function markWelcomeDone(): void {
  fs.mkdirSync(lazyDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(welcomeFile(), JSON.stringify({ done: true, at: new Date().toISOString() }) + '\n');
}
function ghCliReady(): Promise<boolean> {
  return new Promise(resolve => {
    import('node:child_process').then(({ execFile }) => execFile('gh', ['auth', 'token'], { timeout: 8000 }, err => resolve(!err)));
  });
}

export interface FleetDeps {
  vault: Vault;
  launch: (input: LaunchInput) => Promise<{ runId: string }>;
  now?: () => Date;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 256 * 1024) throw new Error('request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

// ---------------------------------------------------------------------------
// Pieces shared by the routes and the scheduler
// ---------------------------------------------------------------------------

function sprintedIssues(): Map<string, { runId: string; title: string }> {
  const m = new Map<string, { runId: string; title: string }>();
  for (const r of loadRegistry()) if (r.issue) m.set(`${r.issue.repo}#${r.issue.number}`, { runId: r.runId, title: r.title });
  return m;
}

export function schedulerDeps(deps: FleetDeps): sched.TickDeps {
  return {
    now: deps.now ?? (() => new Date()),
    listSprints: () => listSprints(),
    launch: input => deps.launch(input as LaunchInput),
    recommend: (ask, repo) => recommend(ask, repo),
    githubToken: () => gh.currentToken(deps.vault),
    listIssues: gh.listIssues,
    comment: gh.commentOnIssue,
    repoIsClean: sched.gitIsClean,
    sprintedIssues: () => new Set(sprintedIssues().keys()),
    reportedRuns: () => new Set(loadRegistry().filter(r => r.issueReported).map(r => r.runId)),
    markReported: markIssueReported,
  };
}

let running = false;
/** Check schedules every 30 seconds, and let designs learn from finished sprints once an hour. */
export function startScheduler(deps: FleetDeps, everyMs = 30000): () => void {
  let lastEvolve = 0;
  const beat = async () => {
    if (running) return;
    running = true;
    try {
      await sched.tick(schedulerDeps(deps));
      if (Date.now() - lastEvolve > 3600000) {
        lastEvolve = Date.now();
        evolveDesigns();
      }
    } catch {
      // A bad tick must never take the process down; the next one retries.
    } finally {
      running = false;
    }
  };
  const t = setInterval(beat, everyMs);
  t.unref?.();
  setTimeout(beat, 2000).unref?.();
  return () => clearInterval(t);
}

async function githubStatus(vault: Vault) {
  const s = gh.loadGithubSettings();
  return {
    signedIn: !!(await gh.currentToken(vault)),
    source: s.source ?? null,
    login: s.login ?? null,
    avatarUrl: s.avatarUrl ?? null,
    clientIdSet: !!s.clientId,
    projects: s.projects ?? {},
  };
}

async function needToken(vault: Vault): Promise<string> {
  const t = await gh.currentToken(vault);
  if (!t) throw new Error('Sign in to GitHub first');
  return t;
}

const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;

async function signIn(vault: Vault, token: string, source: 'stored' | 'gh') {
  const me = await gh.whoami(token);
  if (source === 'stored') gh.saveStoredToken(token);
  if (vault.valueOf(gh.TOKEN_NAME) !== undefined) vault.delete(gh.TOKEN_NAME);
  gh.updateGithubSettings({ source, login: me.login, avatarUrl: me.avatarUrl });
  return me;
}

function folderState(folder: string): 'ready' | 'dirty' | 'missing' | 'not-git' {
  if (!fs.existsSync(folder)) return 'missing';
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: folder, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    return out.trim() ? 'dirty' : 'ready';
  } catch {
    return 'not-git';
  }
}

function scheduleView(s: sched.Schedule, now: Date) {
  const due = sched.isDue(s, now);
  const next = !s.enabled ? null : s.retryAt ? s.retryAt : due ? now.toISOString() : sched.nextRun(s, new Date(Math.max(now.getTime(), Date.parse(s.lastFiredAt ?? s.createdAt)))).toISOString();
  const lastSkip = [...s.log].reverse().find(e => e.action === 'skipped' || e.action === 'error');
  return {
    ...s, whenText: sched.describeWhen(s), nextAt: next, log: s.log.slice(-40).reverse(),
    folder: folderState(s.repo),
    retryReason: s.retryAt && lastSkip ? lastSkip.text.replace(/^Not started: /, '').replace(/\.$/, '') : null,
  };
}

/** A project folder has to be a git checkout; the path alone is not enough. */
export function checkProjectFolder(folder: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(folder);
  } catch {
    throw new Error(`${folder} does not exist`);
  }
  if (!st.isDirectory()) throw new Error(`${folder} is a file, not a project folder`);
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: folder, stdio: 'ignore', timeout: 10000 });
  } catch {
    throw new Error(`${folder} is not a git checkout; sprints work on git projects`);
  }
}

/** The GitHub repo a checkout's origin points at, if it is on GitHub. */
function remoteRepo(folder: string): string | null {
  try {
    return gh.repoFromRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: folder, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }));
  } catch {
    return null;
  }
}

/** A folder picked for a GitHub repo must not be a checkout of a different one. */
export function checkFolderMatchesRepo(folder: string, repo: string): void {
  const r = remoteRepo(folder);
  if (r && r.toLowerCase() !== repo.toLowerCase()) throw new Error(`${folder} is a checkout of ${r}, not ${repo}`);
}

function checkScheduleTarget(raw: any): void {
  const folder = String(raw?.repo ?? '').trim();
  if (folder && path.isAbsolute(folder)) checkProjectFolder(folder);
  if (raw?.source?.type === 'issues' && raw.source.repo && folder) checkFolderMatchesRepo(folder, gh.validRepo(raw.source.repo));
  const design = String(raw?.design ?? 'auto');
  if (design !== 'auto' && !listDesigns(folder || undefined).some(d => d.id === design)) throw new Error(`There is no sprint design called "${design}"`);
}

/** Folder for a GitHub repo: remembered, or found among this machine's recent sprints. */
function folderFor(repo: string, given?: string): string | undefined {
  if (given && given.trim()) return given.trim();
  return gh.projectFolder(repo);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function handleFleet(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: FleetDeps): Promise<boolean> {
  const p = url.pathname.replace(/^\/_lazy\/api/, '');
  const m = req.method ?? 'GET';
  const now = (deps.now ?? (() => new Date()))();

  if (p === '/home' && m === 'GET') {
    const sprints = listSprints();
    const week = sprints.filter(x => !x.live && x.startedAt && now.getTime() - Date.parse(x.startedAt) < 7 * 86400000);
    const passed = week.filter(x => x.verdict === 'PASS' || x.verdict === 'DONE').length;
    const schedules = sched.loadSchedules().map(s => scheduleView(s, now)).filter(s => s.nextAt).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!));
    const autos = listDesigns().filter(d => d.auto);
    const hist = outcomes();
    {
      send(res, 200, {
        now: now.toISOString(),
        github: await githubStatus(deps.vault),
        running: sprints.filter(x => x.live),
        recent: sprints.filter(x => !x.live).slice(0, 8),
        next: schedules.slice(0, 4),
        week: { sprints: week.length, passed, cost: week.reduce((a, x) => a + (x.cost || 0), 0) },
        learned: { designs: autos.map(d => ({ id: d.id, name: d.name, description: d.description, evidence: d.auto!.evidence, runs: d.auto!.runs, updatedAt: d.auto!.updatedAt })), finished: hist.length, stats: statsFor(hist) },
        schedulesTotal: sched.loadSchedules().length,
        // Folders to offer in the project box: recent sprints first, then linked GitHub repos.
        folders: [...new Set([...loadRegistry().slice().reverse().map(r => r.repo), ...Object.values(gh.loadGithubSettings().projects ?? {})])].slice(0, 12),
      });
    }
    return true;
  }

  // ---- first-run welcome --------------------------------------------------
  if (p === '/welcome' && m === 'GET') {
    let service: { autostart?: boolean; note?: string | null } = {};
    try { service = JSON.parse(fs.readFileSync(path.join(lazyDir(), 'service.json'), 'utf-8')); } catch { /* not installed through the CLI */ }
    send(res, 200, { done: welcomeDone(), github: await githubStatus(deps.vault), ghCli: await ghCliReady(), pageUrl: `http://${req.headers.host}/_lazy/`, autostart: service.autostart !== false, serviceNote: service.note ?? null });
    return true;
  }
  if (p === '/welcome/done' && m === 'POST') {
    markWelcomeDone();
    send(res, 200, { ok: true });
    return true;
  }

  // ---- advisor ------------------------------------------------------------
  if (p === '/advisor/recommend' && m === 'POST') {
    const b = await body(req);
    send(res, 200, recommend(String(b.ask ?? ''), b.repo ? String(b.repo) : undefined));
    return true;
  }
  if (p === '/advisor/evolve' && m === 'POST') {
    const r = evolveDesigns();
    send(res, 200, { created: r.created.map(d => d.name), updated: r.updated.map(d => d.name), skipped: r.skipped });
    return true;
  }

  // ---- GitHub -------------------------------------------------------------
  if (p === '/github' && m === 'GET') {
    send(res, 200, await githubStatus(deps.vault));
    return true;
  }
  if (p === '/github/settings' && m === 'POST') {
    const b = await body(req);
    const clientId = String(b.clientId ?? '').trim();
    if (clientId && !/^[A-Za-z0-9._-]{4,100}$/.test(clientId)) throw new Error('That does not look like a client id');
    gh.updateGithubSettings({ clientId: clientId || undefined });
    send(res, 200, await githubStatus(deps.vault));
    return true;
  }
  if (p === '/github/token' && m === 'POST') {
    const token = String((await body(req)).token ?? '').trim();
    if (token.length > 300) throw new Error('That is too long for a token; paste only the token itself');
    if (!TOKEN_RE.test(token)) throw new Error('That does not look like a GitHub token. They start with ghp_, gho_ or github_pat_ and have no spaces.');
    const me = await signIn(deps.vault, token, 'stored');
    send(res, 200, { ok: true, login: me.login });
    return true;
  }
  if (p === '/github/use-cli' && m === 'POST') {
    const token = await new Promise<string | null>(resolve => {
      import('node:child_process').then(({ execFile }) => execFile('gh', ['auth', 'token'], { timeout: 10000 }, (err, out) => resolve(err ? null : String(out).trim() || null)));
    });
    if (!token) throw new Error('The GitHub CLI is not signed in here. Run `gh auth login` in a terminal, then try again.');
    const me = await signIn(deps.vault, token, 'gh');
    send(res, 200, { ok: true, login: me.login });
    return true;
  }
  if (p === '/github/device/start' && m === 'POST') {
    const s = gh.loadGithubSettings();
    if (!s.clientId) throw new Error('Signing in in the browser needs a GitHub OAuth app client id (Settings). You can use the GitHub CLI or a token instead.');
    send(res, 200, await gh.startDeviceFlow(s.clientId));
    return true;
  }
  if (p === '/github/device/poll' && m === 'POST') {
    const s = gh.loadGithubSettings();
    const r = await gh.pollDeviceFlow(s.clientId ?? '', String((await body(req)).deviceCode ?? ''));
    if (r.token) {
      const me = await signIn(deps.vault, r.token, 'stored');
      send(res, 200, { ok: true, login: me.login });
    } else send(res, 200, { pending: true, slowDown: !!r.slowDown });
    return true;
  }
  if (p === '/github/logout' && m === 'POST') {
    if (deps.vault.valueOf(gh.TOKEN_NAME) !== undefined) deps.vault.delete(gh.TOKEN_NAME);
    gh.clearStoredToken();
    const s = gh.loadGithubSettings();
    gh.saveGithubSettings({ clientId: s.clientId, projects: s.projects });
    send(res, 200, { ok: true });
    return true;
  }
  if (p === '/github/repos' && m === 'GET') {
    const repos = await gh.listRepos(await needToken(deps.vault));
    const projects = gh.loadGithubSettings().projects ?? {};
    send(res, 200, { repos: repos.map(r => ({ ...r, folder: projects[r.fullName] ?? null })) });
    return true;
  }
  if (p === '/github/issues' && m === 'GET') {
    const repo = gh.validRepo(url.searchParams.get('repo'));
    const labels = (url.searchParams.get('labels') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const issues = await gh.listIssues(await needToken(deps.vault), repo, labels);
    const done = sprintedIssues();
    const live = new Map(listSprints().map(x => [x.runId, x]));
    const folder = gh.projectFolder(repo) ?? null;
    send(res, 200, {
      repo, folder,
      issues: issues.map(i => {
        const hit = done.get(`${i.repo}#${i.number}`);
        const run = hit ? live.get(hit.runId) : undefined;
        const r = recommend(gh.askFromIssue(i), folder ?? undefined);
        return {
          ...i, body: i.body.slice(0, 1200),
          trusted: gh.TRUSTED_ASSOCIATIONS.has(i.association),
          sprint: hit ? { runId: hit.runId, status: run?.status ?? 'unknown', verdict: run?.verdict ?? null } : null,
          suggested: { designId: r.designId, designName: r.designName, kind: r.profile.kind, size: r.profile.size, why: r.reasons.slice(0, 2).join(' ') },
        };
      }),
    });
    return true;
  }
  if (p === '/github/project' && m === 'POST') {
    const b = await body(req);
    const repo = gh.validRepo(b.repo);
    const folder = String(b.folder ?? '').trim();
    if (!path.isAbsolute(folder)) throw new Error('Pick the folder where this repo is checked out (a full path)');
    checkProjectFolder(folder);
    checkFolderMatchesRepo(folder, repo);
    gh.rememberProjectFolder(repo, folder);
    send(res, 200, { ok: true });
    return true;
  }
  if (p === '/github/sprint' && m === 'POST') {
    const b = await body(req);
    const repo = gh.validRepo(b.repo);
    const n = b.number;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new Error('The issue number must be a whole number');
    const token = await needToken(deps.vault);
    const folder = folderFor(repo, b.folder);
    if (!folder) throw new Error(`Pick the folder where ${repo} is checked out on this machine`);
    if (!path.isAbsolute(folder)) throw new Error('Pick the folder where this repo is checked out (a full path)');
    checkProjectFolder(folder);
    checkFolderMatchesRepo(folder, repo);
    const issue = await gh.getIssue(token, repo, n);
    if (b.folder) gh.rememberProjectFolder(repo, folder);
    const ask = gh.askFromIssue(issue);
    const design = String(b.design || '') || recommend(ask, folder).designId;
    const rec = await deps.launch({ repo: folder, ask, title: `#${issue.number} ${issue.title}`.slice(0, 80), design, issue: { repo, number: issue.number, title: issue.title, url: issue.url } });
    send(res, 200, { ok: true, runId: rec.runId, design });
    return true;
  }

  // ---- schedules ----------------------------------------------------------
  if (p === '/schedules' && m === 'GET') {
    send(res, 200, { schedules: sched.loadSchedules().map(s => scheduleView(s, now)) });
    return true;
  }
  if (p === '/schedules' && m === 'POST') {
    const raw = await body(req);
    checkScheduleTarget(raw);
    const saved = sched.saveSchedule(raw);
    send(res, 200, { ok: true, schedule: scheduleView(saved, now) });
    return true;
  }
  if (p === '/schedules/preview' && m === 'POST') {
    try {
      const s = sched.normalizeSchedule(await body(req));
      s.lastFiredAt = now.toISOString();
      send(res, 200, { ok: true, whenText: sched.describeWhen(s), nextAt: sched.nextRun(s, now).toISOString(), schedule: s });
    } catch (e) {
      send(res, 200, { ok: false, error: (e as Error).message });
    }
    return true;
  }
  const sm = /^\/schedules\/([a-f0-9]{12})(\/(enable|run|delete))?$/.exec(p);
  if (sm && m === 'POST') {
    const id = sm[1];
    const action = sm[3];
    if (action === 'enable') {
      const s = sched.setEnabled(id, !!(await body(req)).enabled);
      send(res, s ? 200 : 404, s ? { ok: true } : { error: 'no such schedule' });
      return true;
    }
    if (action === 'run') {
      const s = sched.loadSchedules().find(x => x.id === id);
      if (!s) { send(res, 404, { error: 'no such schedule' }); return true; }
      const override = (await body(req)).override === true;
      if (!override) {
        const warnings = await sched.runNowWarnings(s, schedulerDeps(deps));
        if (warnings.length) { send(res, 200, { needsConfirm: true, warnings }); return true; }
      }
      const runId = await sched.fire(s, schedulerDeps(deps), { override, manual: true });
      const after = sched.loadSchedules().find(x => x.id === id);
      send(res, 200, { ok: true, runId, last: after?.log.slice(-1)[0] ?? null });
      return true;
    }
    if (action === 'delete') {
      send(res, sched.deleteSchedule(id) ? 200 : 404, { ok: true });
      return true;
    }
  }
  return false;
}

