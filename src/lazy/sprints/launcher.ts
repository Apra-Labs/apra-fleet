/**
 * Start a sprint from one sentence, with no setup by the user.
 *
 * Layout per repo, all under ~/.lazyfleet/helpers/<slug>/:
 *   h0, h1, ...     one git clone per helper (h0 also runs the sprint's
 *                   own git/task bookkeeping); the user's checkout is never
 *                   edited -- finished work arrives as a branch in it
 *   tasks-remote/   a local folder the helpers' task databases sync through
 *
 * The sprint engine runs in "synced" mode, which is what makes separate
 * checkouts safe: git and task state are reconciled around every hand-off.
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lazyDir } from '../config.js';

export type SprintGoal = 'P1' | 'P1/P2' | 'P1/P2/P3';

export interface SprintRecord {
  runId: string;
  title: string;
  ask: string;
  repo: string;
  slug: string;
  workspace: string;
  branch: string;
  base: string;
  goal: SprintGoal;
  helpers: string[];
  rootIssue?: string;
  viewerPort?: number;
  pid?: number;
  logPath: string;
  createdAt: string;
  /** Setup happens before the engine starts; failures here never reach it. */
  setup: { state: 'preparing' | 'started' | 'failed'; steps: Array<{ at: string; text: string; ok: boolean }>; error?: string };
  publish: boolean;
  budget?: number;
}

export interface LaunchInput {
  repo: string;
  ask: string;
  title?: string;
  helpers?: number;
  goal?: SprintGoal;
  base?: string;
  publish?: boolean;
  budget?: number;
}

/** Collaborators, injectable so tests never touch a real fleet or git remote. */
export interface LauncherDeps {
  run: (cmd: string, args: string[], cwd: string) => Promise<string>;
  ensureHelpers: (names: Array<{ name: string; folder: string }>) => Promise<void>;
  startEngine: (rec: SprintRecord, args: string[]) => { pid?: number };
  freePort: () => Promise<number>;
  /** The sprint engine only talks to a running fleet server; make sure there is one. */
  ensureFleetServer: () => Promise<void>;
}

const GOALS = new Set(['P1', 'P1/P2', 'P1/P2/P3']);
export const MAX_HELPERS = 6;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function registryPath(): string {
  return path.join(lazyDir(), 'sprints.json');
}

export function loadRegistry(): SprintRecord[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
  } catch {
    return [];
  }
}

function saveRegistry(list: SprintRecord[]): void {
  fs.mkdirSync(lazyDir(), { recursive: true, mode: 0o700 });
  const tmp = registryPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, registryPath());
}

export function getRecord(runId: string): SprintRecord | undefined {
  return loadRegistry().find(r => r.runId === runId);
}

function upsert(rec: SprintRecord): void {
  const list = loadRegistry().filter(r => r.runId !== rec.runId);
  list.unshift(rec);
  saveRegistry(list.slice(0, 200));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(s: string, max = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '') || 'work';
}

/** Names the fleet accepts: letters, digits, dot, dash, underscore; <= 64. */
export function helperName(slug: string, i: number): string {
  return `lz-${slug.slice(0, 40)}-${i}`;
}

export function titleFromAsk(ask: string): string {
  const first = ask.trim().split(/[.\n!?]/)[0].trim();
  return (first.length > 70 ? first.slice(0, 67).trimEnd() + '...' : first) || 'Sprint';
}

export function realRun(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`));
      else resolve(stdout);
    });
  });
}

export function realFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** packages/apra-fleet-se/bin/cli.mjs, found from this file's location. */
export function engineCli(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'packages', 'apra-fleet-se', 'bin', 'cli.mjs');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('sprint engine not found (packages/apra-fleet-se/bin/cli.mjs)');
}

export function realStartEngine(rec: SprintRecord, args: string[]): { pid?: number } {
  fs.mkdirSync(path.dirname(rec.logPath), { recursive: true });
  const out = fs.openSync(rec.logPath, 'a');
  const child = spawn(process.execPath, [engineCli(), ...args], {
    // Not inside a clone: the engine writes its own snapshots to its cwd.
    cwd: (() => { const d = path.join(rec.workspace, 'engine'); fs.mkdirSync(d, { recursive: true }); return d; })(),
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, AUTO_SPRINT_FAILURE_GRACE_MS: '0' },
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid };
}

const HELPER_TOOLS = ['bd', 'claude', 'git', 'node', 'dolt'];

/** Directory holding `tool` on this process's PATH, if any. */
export function findOnPath(tool: string, pathVar = process.env.PATH ?? ''): string | undefined {
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    try {
      fs.accessSync(path.join(dir, tool), fs.constants.X_OK);
      return dir;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** PATH a helper's clean login shell starts with (what the fleet runs commands in). */
function loginShellPath(): Promise<string> {
  const seed = ['HOME', 'USER', 'LOGNAME', 'SHELL'].filter(k => process.env[k]).map(k => `${k}=${process.env[k]}`);
  return new Promise(resolve => {
    execFile('env', ['-i', ...seed, 'bash', '-l', '-c', 'printf %s "$PATH"'], { timeout: 15000 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

/**
 * Helpers run in a clean login shell, which on many machines (nvm, fish,
 * ~/.local/bin installs) cannot see bd or claude. Returns the PATH helpers
 * need, or null when the login shell already finds every tool.
 */
export async function helperPath(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const login = await loginShellPath();
  const loginDirs = login.split(':').filter(Boolean);
  const missing: string[] = [];
  for (const tool of HELPER_TOOLS) {
    if (findOnPath(tool, login)) continue;
    const dir = findOnPath(tool);
    if (dir && !missing.includes(dir)) missing.push(dir);
  }
  if (!missing.length) return null;
  return [...missing, ...loginDirs.filter(d => !missing.includes(d))].join(':');
}

/** Register (or reuse) one local helper per folder through the fleet server. */
export async function realEnsureHelpers(helpers: Array<{ name: string; folder: string }>): Promise<void> {
  const spec = '@apralabs/apra-fleet-client/server-resolution';
  const { connectFleet } = (await import(spec)) as { connectFleet: (deps?: { dirname?: string }) => Promise<any> };
  // Attach to the running fleet server if there is one; otherwise start this
  // install's own server (dist/index.js sits next to dist/lazy/).
  const { parseToolJson } = (await import('@apralabs/apra-fleet-client' as string)) as { parseToolJson: (r: unknown) => any };
  const { fleetApi, transport } = await connectFleet({ dirname: distDir() });
  // A first call can carry a welcome block ahead of the payload.
  const allText = (r: any) => (r?.content ?? []).map((c: any) => String(c?.text ?? '')).join('\n');
  try {
    const listed = await fleetApi.listMembers({ format: 'json' });
    let members: Array<{ name: string; folder: string }> = [];
    try {
      members = parseToolJson(listed).members ?? [];
    } catch {
      // An empty fleet answers in plain text ("No members registered.").
      if (!/no members/i.test(allText(listed))) throw new Error(`unexpected reply listing helpers: ${allText(listed).slice(0, 200)}`);
    }
    for (const h of helpers) {
      const existing = members.find(m => m.name === h.name);
      if (existing && path.resolve(existing.folder) === path.resolve(h.folder)) continue;
      if (existing) throw new Error(`a helper named ${h.name} already exists for a different folder`);
      const res = await fleetApi.registerMember({
        friendly_name: h.name,
        member_type: 'local',
        work_folder: h.folder,
        tags: ['auto', 'lazy-sprint'],
        unattended: 'auto',
      });
      const msg = allText(res);
      if (res?.isError || /NOT registered|\u274c/.test(msg)) {
        const why = msg.split('\n').find((l: string) => /NOT registered|\u274c|error/i.test(l)) ?? msg.split('\n')[0];
        throw new Error(`could not set up ${h.name}: ${why.trim()}`);
      }
      try {
        await fleetApi.composePermissions({ member_name: h.name, tags: ['doer'], project_folder: h.folder });
      } catch {
        // Permissions are refined by the engine per role; a default is fine.
      }
    }
  } finally {
    await transport?.close?.();
  }
  const toolPath = await helperPath();
  if (toolPath) {
    // Stored on the helper itself and exported before each of its commands.
    const { findAgentByName, updateAgent } = await import('../../services/registry.js');
    const { encryptPassword } = await import('../../utils/crypto.js');
    for (const h of helpers) {
      const agent = findAgentByName(h.name);
      if (agent) updateAgent(agent.id, { encryptedEnvVars: { ...agent.encryptedEnvVars, PATH: encryptPassword(toolPath) } });
    }
  }
}

function distDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export async function realEnsureFleetServer(): Promise<void> {
  const spec = '@apralabs/apra-fleet-client/server-resolution';
  const { checkRunningInstance } = (await import(spec)) as { checkRunningInstance: () => Promise<{ running: boolean }> };
  if ((await checkRunningInstance()).running) return;
  spawn(process.execPath, [path.join(distDir(), 'index.js'), 'start'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if ((await checkRunningInstance()).running) return;
  }
  throw new Error('The fleet background service did not start within 30 seconds');
}

export const realDeps: LauncherDeps = {
  run: realRun,
  ensureHelpers: realEnsureHelpers,
  startEngine: realStartEngine,
  freePort: realFreePort,
  ensureFleetServer: realEnsureFleetServer,
};

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export function validateLaunch(input: LaunchInput): Required<Pick<LaunchInput, 'repo' | 'ask'>> & { helpers: number; goal: SprintGoal } {
  const repo = String(input.repo ?? '').trim();
  const ask = String(input.ask ?? '').trim();
  if (!repo || !path.isAbsolute(repo)) throw new Error('Pick a project folder (full path)');
  if (!fs.existsSync(repo)) throw new Error(`Folder not found: ${repo}`);
  if (ask.length < 8) throw new Error('Say what you want done, in a sentence or two');
  if (ask.length > 8000) throw new Error('Keep the ask under 8000 characters');
  const helpers = Math.round(Number(input.helpers ?? 2));
  if (!Number.isFinite(helpers) || helpers < 1 || helpers > MAX_HELPERS) throw new Error(`Helpers must be 1-${MAX_HELPERS}`);
  const goal = (input.goal ?? 'P1/P2') as SprintGoal;
  if (!GOALS.has(goal)) throw new Error('Goal must be P1, P1/P2 or P1/P2/P3');
  if (input.budget !== undefined && (!Number.isFinite(Number(input.budget)) || Number(input.budget) < 0)) throw new Error('Budget must be a positive number');
  return { repo, ask, helpers, goal };
}

/**
 * Keep the task database out of the sprint's commits in a helper clone:
 * tracked files under .beads/ are frozen for git, untracked ones excluded,
 * and anything already staged is unstaged.
 */
async function hideLocalConfig(deps: LauncherDeps, dir: string): Promise<void> {
  let trackedFiles: string[] = [];
  try {
    // Committed files only: bd may already have staged a new export file.
    trackedFiles = (await deps.run('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.beads'], dir)).split('\n').filter(Boolean);
  } catch {
    // not a git checkout yet
  }
  if (trackedFiles.length) await deps.run('git', ['update-index', '--skip-worktree', '--', ...trackedFiles], dir);

  const exclude = path.join(dir, '.git', 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf-8') : '';
  const lines = cur.split('\n');
  const want = [...(trackedFiles.length ? [] : ['.beads/']), 'sprint-logs/'].filter(l => !lines.includes(l));
  if (want.length) fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}${want.join('\n')}\n`);

  try {
    await deps.run('git', ['reset', '--quiet', '--', '.beads'], dir);
  } catch {
    // nothing staged / no commits yet
  }
}

async function restoreGitignore(deps: LauncherDeps, dir: string): Promise<void> {
  const inHead = (await deps.run('git', ['ls-tree', '--name-only', 'HEAD', '--', '.gitignore'], dir)).trim().length > 0;
  if (inHead) await deps.run('git', ['checkout', '--quiet', '--', '.gitignore'], dir);
  else fs.rmSync(path.join(dir, '.gitignore'), { force: true });
}

/** Loud failure beats a sprint whose first commit quietly carries setup files. */
async function assertClean(deps: LauncherDeps, dir: string, who: string): Promise<void> {
  const dirty = (await deps.run('git', ['status', '--porcelain'], dir)).trim();
  if (dirty) throw new Error(`${who}'s copy has unexpected changes after setup: ${dirty.split('\n').slice(0, 5).join(', ')}`);
}

/** Set top-level keys in a clone's .beads/config.yaml, replacing any existing value. */
export function setBeadsConfig(dir: string, values: Record<string, string>): void {
  const cfg = path.join(dir, '.beads', 'config.yaml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true, mode: 0o700 });
  let text = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf-8') : '';
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}: ${value}`;
    const re = new RegExp(`^${key.replace(/[.]/g, '\\.')}:.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  fs.writeFileSync(cfg, text);
}

/** Point a clone at the shared task folder; never let bd stage files in git. */
function setSyncRemote(dir: string, url: string): void {
  setBeadsConfig(dir, { 'sync.remote': JSON.stringify(url), 'export.git-add': 'false' });
}

async function ensureClone(deps: LauncherDeps, rec: SprintRecord, dir: string, originUrl: string): Promise<void> {
  if (fs.existsSync(path.join(dir, '.git'))) {
    await deps.run('git', ['fetch', '--quiet', 'origin'], dir);
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await deps.run('git', ['clone', '--quiet', rec.repo, dir], path.dirname(dir));
  }
  await deps.run('git', ['remote', 'set-url', 'origin', originUrl], dir);
  if (originUrl !== rec.repo) await deps.run('git', ['fetch', '--quiet', 'origin'], dir);
  // Our own clone: always start clean from the base branch.
  await deps.run('git', ['checkout', '--quiet', '-B', rec.base, `origin/${rec.base}`], dir);
  await deps.run('git', ['reset', '--quiet', '--hard', `origin/${rec.base}`], dir);
  await deps.run('git', ['clean', '-fdq', '-e', '.beads/'], dir);
}

/**
 * Prepare everything and start the engine. Returns as soon as the record
 * exists; progress lands in rec.setup, which the board shows live.
 */
export async function launchSprint(input: LaunchInput, deps: LauncherDeps = realDeps): Promise<SprintRecord> {
  const v = validateLaunch(input);
  const repo = (await deps.run('git', ['rev-parse', '--show-toplevel'], v.repo)).trim() || v.repo;
  const base = (input.base?.trim() || (await deps.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim());
  if (!base || base === 'HEAD') throw new Error('Could not tell which branch to start from; pick a base branch');
  const slug = slugify(path.basename(repo), 30);
  const workspace = path.join(lazyDir(), 'helpers', slug);

  const busy = loadRegistry().find(r => r.workspace === workspace && r.setup.state === 'preparing');
  if (busy) throw new Error(`A sprint for this project is still being set up (${busy.title})`);

  const runId = crypto.randomUUID();
  const title = input.title?.trim() || titleFromAsk(v.ask);
  const rec: SprintRecord = {
    runId,
    title,
    ask: v.ask,
    repo,
    slug,
    workspace,
    branch: `feat/${slugify(title, 40)}-${runId.slice(0, 6)}`,
    base,
    goal: v.goal,
    helpers: Array.from({ length: v.helpers }, (_, i) => helperName(slug, i)),
    logPath: path.join(lazyDir(), 'sprints', `${runId}.log`),
    createdAt: new Date().toISOString(),
    setup: { state: 'preparing', steps: [] },
    publish: !!input.publish,
    budget: input.budget !== undefined ? Number(input.budget) : undefined,
  };
  upsert(rec);
  void prepareAndStart(rec, deps);
  return rec;
}

function step(rec: SprintRecord, text: string, ok = true): void {
  rec.setup.steps.push({ at: new Date().toISOString(), text, ok });
  upsert(rec);
}

export async function prepareAndStart(rec: SprintRecord, deps: LauncherDeps): Promise<SprintRecord> {
  try {
    await deps.ensureFleetServer();
    const originUrl = rec.publish
      ? (await deps.run('git', ['remote', 'get-url', 'origin'], rec.repo)).trim()
      : rec.repo;
    if (!originUrl) throw new Error('This project has no remote to publish to; untick "Open a pull request"');
    const remoteDir = path.join(rec.workspace, 'tasks-remote');
    const remoteUrl = `file://${remoteDir}`;
    fs.mkdirSync(remoteDir, { recursive: true, mode: 0o700 });

    // Helper 0 owns the task database and the sprint's bookkeeping.
    const h0 = path.join(rec.workspace, 'h0');
    await ensureClone(deps, rec, h0, originUrl);
    step(rec, `Prepared a private copy of ${path.basename(rec.repo)} for helper 1`);

    const hasDb = fs.existsSync(path.join(h0, '.beads', 'embeddeddolt')) || fs.existsSync(path.join(h0, '.beads', 'dolt'));
    if (!hasDb) {
      if (fs.existsSync(path.join(h0, '.beads', 'issues.jsonl')) || fs.existsSync(path.join(h0, '.beads', 'config.yaml'))) {
        await deps.run('bd', ['bootstrap', '--yes'], h0);
      } else {
        // --setup-exclude keeps bd from committing its files; it still edits
        // .gitignore, which we put back so the sprint branch stays clean.
        await deps.run('bd', ['init', '--non-interactive', '--quiet', '--skip-agents', '--skip-hooks', '--setup-exclude', '--prefix', rec.slug.slice(0, 20)], h0);
        await restoreGitignore(deps, h0);
      }
    }
    await hideLocalConfig(deps, h0);
    try {
      await deps.run('bd', ['dolt', 'remote', 'remove', 'origin'], h0);
    } catch {
      // none yet
    }
    await deps.run('bd', ['dolt', 'remote', 'add', 'origin', remoteUrl], h0);
    setSyncRemote(h0, remoteUrl);

    const created = await deps.run('bd', ['create', '--type', 'epic', '--priority', '1', '--title', rec.title, '--description', rec.ask, '--json'], h0);
    rec.rootIssue = JSON.parse(created).id;
    try {
      await deps.run('bd', ['dolt', 'commit', '-m', `sprint: ${rec.title}`], h0);
    } catch {
      // nothing pending
    }
    await deps.run('bd', ['dolt', 'push'], h0);
    await hideLocalConfig(deps, h0);
    await assertClean(deps, h0, 'Helper 1');
    step(rec, `Created the sprint issue ${rec.rootIssue}: ${rec.title}`);

    // Other helpers join the same task database through the shared folder.
    for (let i = 1; i < rec.helpers.length; i++) {
      const dir = path.join(rec.workspace, `h${i}`);
      await ensureClone(deps, rec, dir, originUrl);
      await hideLocalConfig(deps, dir);
      setSyncRemote(dir, remoteUrl);
      const joined = fs.existsSync(path.join(dir, '.beads', 'embeddeddolt')) || fs.existsSync(path.join(dir, '.beads', 'dolt'));
      await deps.run('bd', joined ? ['dolt', 'pull'] : ['bootstrap', '--yes'], dir);
      await hideLocalConfig(deps, dir);
      await assertClean(deps, dir, `Helper ${i + 1}`);
      step(rec, `Prepared helper ${i + 1}`);
    }

    await deps.ensureHelpers(rec.helpers.map((name, i) => ({ name, folder: path.join(rec.workspace, `h${i}`) })));
    step(rec, `${rec.helpers.length} helper${rec.helpers.length > 1 ? 's' : ''} ready`);

    rec.viewerPort = await deps.freePort();
    const args = [
      '--issue', rec.rootIssue!,
      '--members', rec.helpers.join(','),
      '--branch', rec.branch,
      '--base', rec.base,
      '--goal', rec.goal,
      '--viewer-port', String(rec.viewerPort),
      '--run-id', rec.runId,
      '--role-map', JSON.stringify({ orchestrator: [rec.helpers[0]] }),
      '--sync',
    ];
    if (rec.budget !== undefined) args.push('--budget', String(rec.budget));
    const { pid } = deps.startEngine(rec, args);
    rec.pid = pid;
    rec.setup.state = 'started';
    step(rec, 'Sprint started - helpers are planning the work');
    return rec;
  } catch (e) {
    rec.setup.state = 'failed';
    rec.setup.error = (e as Error).message;
    step(rec, `Could not start: ${(e as Error).message}`, false);
    return rec;
  }
}

/** Ask the engine to stop; fall back to signalling the process. */
export async function stopSprint(runId: string): Promise<boolean> {
  const rec = getRecord(runId);
  if (!rec) return false;
  if (rec.viewerPort) {
    try {
      const r = await fetch(`http://127.0.0.1:${rec.viewerPort}/stop`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      // viewer gone -- try the process
    }
  }
  if (rec.pid) {
    try {
      process.kill(rec.pid, 'SIGINT');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
