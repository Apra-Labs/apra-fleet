/**
 * AGY project binding (docs/compose-permissions-design.md section 8).
 *
 * A headless `agy -p` run only enforces a project's permissionGrants when the
 * run names that project with `--project <id>`; without it every run on the
 * machine shares default-cli-project. Each agy member therefore owns one agy
 * project, created once with `agy --new-project` and recorded on the Agent as
 * `agyProjectId`. compose_permissions writes grants into that project's file
 * and every dispatch passes `--project <agyProjectId>`.
 *
 * agy silently falls back to default-cli-project when `<id>.json` is missing
 * or unparseable (live-verified, section 8.5), so the file is probed before
 * it is relied on and the project is re-provisioned when the probe fails.
 */
import os from 'node:os';
import type { Agent, SSHExecResult } from '../types.js';
import { getStrategy } from './strategy.js';
import { updateAgent } from './registry.js';
import { buildAgyNodeCommand, AGY_MODEL_FOR_TIER } from '../providers/agy.js';
import { getModelOverride } from './user-config.js';
import { decryptPassword } from '../utils/crypto.js';
import { logLine, logWarn } from '../utils/log-helpers.js';

export type AgyExecFn = (command: string, timeoutMs?: number) => Promise<SSHExecResult>;

/** Raised when an agy project cannot be created or verified. */
export class AgyProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgyProjectError';
  }
}

/** agy project ids are UUIDs; anything else is refused before it is embedded
 *  in a member-side script or a command line. */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export function isValidAgyProjectId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_ID_RE.test(id);
}

const PROBE_MARKER = 'FLEET_AGY_PROJECT:';
const NEW_PROJECT_MARKER = 'FLEET_AGY_NEW_PROJECT:';
const DELETE_MARKER = 'FLEET_AGY_PROJECT_DELETE:';

/** The prompt of the one model turn `agy --new-project` needs. It asks for no
 *  tool use: the id is read from the new project file and agy's own log, never
 *  from the model (the model does not know it -- see section 8.5). */
export const AGY_NEW_PROJECT_PROMPT = 'Reply with only the word OK. Do not use any tools.';

const PROBE_TIMEOUT_MS = 30_000;
const NEW_PROJECT_SPAWN_TIMEOUT_MS = 180_000;
const NEW_PROJECT_EXEC_TIMEOUT_MS = 240_000;

/** JS expression for the member's home directory inside a member-side node
 *  script. A local member's home is this process's home (resolved here, in
 *  JS); a remote member's is the node process's own os.homedir() on the
 *  member -- never a shell variable, and never a probed MSYS path that node
 *  on Windows would misread. */
function homeExpr(home: string | null | undefined): string {
  return home ? JSON.stringify(home) : "require('os').homedir()";
}

export function buildAgyProjectProbeScript(projectId: string, home?: string | null): string {
  if (!isValidAgyProjectId(projectId)) throw new AgyProjectError(`invalid agy project id "${String(projectId)}"`);
  return `const fs = require('fs');
const path = require('path');
const home = ${homeExpr(home)};
const id = ${JSON.stringify(projectId)};
const f = path.join(home, '.gemini', 'config', 'projects', id + '.json');
let state = 'ok';
if (!fs.existsSync(f)) {
  state = 'missing';
} else {
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) state = 'corrupt';
    else if (j.id !== id) state = 'id_mismatch';
  } catch (e) {
    state = 'corrupt';
  }
}
console.log(${JSON.stringify(PROBE_MARKER)} + JSON.stringify({ state }));`;
}

export interface NewProjectScriptOptions {
  workFolder: string;
  model: string;
  home?: string | null;
  /** Extra environment for the agy process (the member's stored auth env vars). */
  env?: Record<string, string>;
  /** Test seam: run this executable (plus leading args) instead of `agy`. */
  agyCommand?: { file: string; args: string[] };
}

/**
 * Member-side node script: list ~/.gemini/config/projects, run
 * `agy --new-project` (spawned directly, no shell) in the work folder with a
 * --log-file, list again, and report the new file names plus the ids agy
 * logged as `created project "<name>" (id=<id>)`. The log file is deleted and
 * its content is never echoed (it carries the account e-mail).
 */
export function buildAgyNewProjectScript(opts: NewProjectScriptOptions): string {
  const file = opts.agyCommand?.file ?? 'agy';
  const leadArgs = opts.agyCommand?.args ?? [];
  const args = [
    ...leadArgs,
    '--add-dir', opts.workFolder,
    '--model', opts.model,
    '--output-format', 'json',
    '--log-file', '__LOG_FILE__',
    '--new-project',
    '-p', AGY_NEW_PROJECT_PROMPT,
  ];
  return `const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const home = ${homeExpr(opts.home)};
const dir = path.join(home, '.gemini', 'config', 'projects');
function list() {
  try { return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.json'); }); } catch (e) { return []; }
}
const before = new Set(list());
const logFile = path.join(os.tmpdir(), 'fleet-agy-new-project-' + process.pid + '-' + Date.now() + '.log');
const env = Object.assign({}, process.env, ${JSON.stringify(opts.env ?? {})});
['ANTIGRAVITY_SOURCE_METADATA', 'CLAUDE_SOURCE_METADATA', 'COPILOT_SOURCE_METADATA', 'CODEX_SOURCE_METADATA'].forEach(function (k) { delete env[k]; });
const pathKey = Object.keys(env).find(function (k) { return k.toUpperCase() === 'PATH'; }) || 'PATH';
const extra = [path.join(home, '.local', 'bin')];
if (process.platform === 'win32' && env.LOCALAPPDATA) extra.push(path.join(env.LOCALAPPDATA, 'agy', 'bin'));
env[pathKey] = extra.join(path.delimiter) + path.delimiter + (env[pathKey] || '');
const args = ${JSON.stringify(args)}.map(function (a) { return a === '__LOG_FILE__' ? logFile : a; });
const r = cp.spawnSync(${JSON.stringify(file)}, args, { cwd: ${JSON.stringify(opts.workFolder)}, env: env, encoding: 'utf8', timeout: ${NEW_PROJECT_SPAWN_TIMEOUT_MS}, windowsHide: true });
const created = list().filter(function (f) { return !before.has(f); }).map(function (f) { return f.slice(0, -5); });
const logIds = [];
try {
  const log = fs.readFileSync(logFile, 'utf8');
  const re = /created project "[^"]*" \\(id=([A-Za-z0-9-]+)\\)/g;
  let m;
  while ((m = re.exec(log)) !== null) { if (logIds.indexOf(m[1]) < 0) logIds.push(m[1]); }
} catch (e) {}
try { fs.unlinkSync(logFile); } catch (e) {}
console.log(${JSON.stringify(NEW_PROJECT_MARKER)} + JSON.stringify({
  created: created,
  logIds: logIds,
  status: r.status,
  spawnError: r.error ? String(r.error.message || r.error) : undefined,
  stderrTail: String(r.stderr || '').slice(-400),
}));`;
}

function extractMarkedJson(stdout: string, marker: string): any | undefined {
  // indexOf, not startsWith: Windows PowerShell can prefix the line with its
  // own CLIXML progress record ("...</Objs>FLEET_AGY_...").
  const line = stdout.split(/\r?\n/).reverse().find(l => l.includes(marker));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim());
  } catch {
    return undefined;
  }
}

/**
 * Member-side script for remove_member's best-effort cleanup: deletes the
 * member's own `<projectId>.json` plus, if present, the legacy
 * `fleet-<memberId>.json` from an earlier design (docs/compose-permissions-
 * design.md section 8.4), from ~/.gemini/config/projects only. A missing
 * target is not an error (fs.rm's force:true); any other failure (e.g.
 * permission denied) is reported back per target so the caller can decide
 * whether it is warning-worthy.
 */
export function buildAgyProjectDeleteScript(projectId: string, memberId: string, home?: string | null): string {
  if (!isValidAgyProjectId(projectId)) throw new AgyProjectError(`invalid agy project id "${String(projectId)}"`);
  return `const fs = require('fs');
const path = require('path');
const home = ${homeExpr(home)};
const dir = path.join(home, '.gemini', 'config', 'projects');
const targets = [${JSON.stringify(projectId + '.json')}, ${JSON.stringify('fleet-' + memberId + '.json')}];
const deleted = [];
const errors = [];
for (const name of targets) {
  const f = path.join(dir, name);
  try {
    fs.unlinkSync(f);
    deleted.push(name);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') errors.push(name + ': ' + (e && e.message ? e.message : String(e)));
  }
}
console.log(${JSON.stringify(DELETE_MARKER)} + JSON.stringify({ deleted, errors }));`;
}

export interface AgyProjectDeleteResult {
  deleted: string[];
  errors: string[];
}

export function parseAgyProjectDeleteResult(result: SSHExecResult): AgyProjectDeleteResult {
  const parsed = extractMarkedJson(result.stdout ?? '', DELETE_MARKER);
  if (!parsed) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
    throw new AgyProjectError(`agy project delete produced no result (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return {
    deleted: Array.isArray(parsed.deleted) ? parsed.deleted.filter((c: unknown): c is string => typeof c === 'string') : [],
    errors: Array.isArray(parsed.errors) ? parsed.errors.filter((c: unknown): c is string => typeof c === 'string') : [],
  };
}

export type AgyProjectState = 'ok' | 'missing' | 'corrupt' | 'id_mismatch';

export function parseAgyProjectProbe(result: SSHExecResult): AgyProjectState {
  const parsed = extractMarkedJson(result.stdout ?? '', PROBE_MARKER);
  const state = parsed?.state;
  if (state === 'ok' || state === 'missing' || state === 'corrupt' || state === 'id_mismatch') return state;
  const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
  throw new AgyProjectError(`agy project probe produced no result (exit ${result.code})${detail ? `: ${detail}` : ''}`);
}

/**
 * Validates the output of the new-project script: exactly one new
 * `<uuid>.json` must have appeared, and agy's own log must name the same id.
 * Anything else throws with the evidence.
 */
export function parseAgyNewProjectResult(result: SSHExecResult): string {
  const parsed = extractMarkedJson(result.stdout ?? '', NEW_PROJECT_MARKER);
  if (!parsed) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
    throw new AgyProjectError(`agy --new-project could not be run on the member (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  const created: string[] = Array.isArray(parsed.created) ? parsed.created.filter((c: unknown) => typeof c === 'string') : [];
  const logIds: string[] = Array.isArray(parsed.logIds) ? parsed.logIds.filter((c: unknown) => typeof c === 'string') : [];
  const agyFailure = parsed.spawnError
    ? ` agy could not be started: ${parsed.spawnError}.`
    : (parsed.status !== 0 ? ` agy exited ${parsed.status}${parsed.stderrTail ? `: ${String(parsed.stderrTail).trim()}` : ''}.` : '');
  if (created.length !== 1) {
    throw new AgyProjectError(
      `agy --new-project must create exactly one project file in ~/.gemini/config/projects, found ${created.length}` +
      `${created.length ? ` (${created.join(', ')})` : ''}.${agyFailure}`,
    );
  }
  const id = created[0];
  if (!isValidAgyProjectId(id)) {
    throw new AgyProjectError(`agy --new-project created an unexpected project file "${id}.json".${agyFailure}`);
  }
  if (logIds.length !== 1 || logIds[0] !== id) {
    throw new AgyProjectError(
      `agy --new-project created "${id}.json" but agy's log names ${logIds.length ? logIds.join(', ') : 'no created project'}; ` +
      `refusing to bind an unconfirmed project id.${agyFailure}`,
    );
  }
  if (parsed.spawnError || parsed.status !== 0) {
    throw new AgyProjectError(`agy --new-project created "${id}.json" but did not complete.${agyFailure}`);
  }
  return id;
}

/** Stored auth env vars for the member (e.g. ANTIGRAVITY_API_KEY), passed to
 *  the agy process through node's spawn env rather than a shell prefix. */
function memberAuthEnv(agent: Agent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, encrypted] of Object.entries(agent.encryptedEnvVars ?? {})) {
    try {
      out[name] = decryptPassword(encrypted);
    } catch {
      // an undecryptable entry is skipped; agy then falls back to its own auth
    }
  }
  return out;
}

function defaultExec(agent: Agent): AgyExecFn {
  const strategy = getStrategy(agent);
  return (command, timeoutMs) => strategy.execCommand(command, timeoutMs);
}

function homeFor(agent: Agent): string | null {
  return agent.agentType === 'local' ? os.homedir() : null;
}

function memberOs(agent: Agent): 'linux' | 'macos' | 'windows' {
  return agent.os ?? 'linux';
}

export async function probeAgyProject(agent: Agent, projectId: string, exec: AgyExecFn = defaultExec(agent)): Promise<AgyProjectState> {
  const cmd = buildAgyNodeCommand(buildAgyProjectProbeScript(projectId, homeFor(agent)), memberOs(agent), 'FLEET_AGY_PROBE_EOF');
  return parseAgyProjectProbe(await exec(cmd, PROBE_TIMEOUT_MS));
}

/**
 * remove_member's best-effort cleanup: deletes the member's own agy project
 * file (and a legacy fleet-<id>.json, if present) from its machine. Callers
 * must skip this entirely when another registered member shares the same
 * agyProjectId, and must treat any thrown AgyProjectError as a warning, not a
 * reason to abort the removal.
 */
export async function removeAgyProject(agent: Agent, exec: AgyExecFn = defaultExec(agent)): Promise<AgyProjectDeleteResult> {
  if (!agent.agyProjectId) throw new AgyProjectError(`member "${agent.friendlyName}" has no agy project id`);
  const cmd = buildAgyNodeCommand(buildAgyProjectDeleteScript(agent.agyProjectId, agent.id, homeFor(agent)), memberOs(agent), 'FLEET_AGY_PROJECT_DELETE_EOF');
  return parseAgyProjectDeleteResult(await exec(cmd, PROBE_TIMEOUT_MS));
}

// One `agy --new-project` at a time per machine: the new id is identified by
// diffing the projects directory, which two concurrent creations would break.
const provisionLocks = new Map<string, Promise<unknown>>();

function machineKey(agent: Agent): string {
  if (agent.agentType === 'local') return 'local';
  if (agent.agentType === 'relay') return `relay:${agent.relayMemberId ?? agent.id}`;
  return `remote:${agent.host ?? agent.id}`;
}

async function withMachineLock<T>(agent: Agent, fn: () => Promise<T>): Promise<T> {
  const key = machineKey(agent);
  const prev = provisionLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  provisionLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (provisionLocks.get(key) === run) provisionLocks.delete(key);
  }
}

let agyCommandOverride: { file: string; args: string[] } | undefined;

/** Test seam: run a stand-in executable instead of the real `agy` on the
 *  member (undefined restores the default). */
export function setAgyCommandForTests(cmd: { file: string; args: string[] } | undefined): void {
  agyCommandOverride = cmd;
}

/** Creates a new agy project for the member and returns its id. Does not
 *  persist it -- see ensureAgyProject. */
export async function provisionAgyProject(
  agent: Agent,
  exec: AgyExecFn = defaultExec(agent),
  agyCommand: { file: string; args: string[] } | undefined = agyCommandOverride,
): Promise<string> {
  if (!agent.workFolder) throw new AgyProjectError('member has no work folder');
  // Under the test suite (NODE_ENV=test, set by tests/setup.ts) never spawn
  // the real agy: it would create projects in the developer's real
  // ~/.gemini and run a model turn. Without a test override the stand-in
  // exits 97 and provisioning fails ("agy exited 97").
  if (!agyCommand && process.env.NODE_ENV === 'test') {
    agyCommand = { file: process.execPath, args: ['-e', 'process.exit(97)', '--'] };
  }
  const model = getModelOverride('agy', 'cheap') ?? AGY_MODEL_FOR_TIER.cheap;
  const script = buildAgyNewProjectScript({
    workFolder: agent.workFolder,
    model,
    home: homeFor(agent),
    env: memberAuthEnv(agent),
    agyCommand,
  });
  const cmd = buildAgyNodeCommand(script, memberOs(agent), 'FLEET_AGY_NEW_PROJECT_EOF');
  return withMachineLock(agent, async () => parseAgyNewProjectResult(await exec(cmd, NEW_PROJECT_EXEC_TIMEOUT_MS)));
}

export interface EnsureAgyProjectResult {
  projectId: string;
  /** Set when a project was created by this call, with the reason. */
  provisioned?: 'no_project_id' | 'missing' | 'corrupt' | 'id_mismatch' | 'invalid_project_id';
}

export interface EnsureAgyProjectOptions {
  exec?: AgyExecFn;
  /** Write a newly created id to the registry (default true). register_member
   *  passes false because the member is not in the registry yet. */
  persist?: boolean;
  /** Test seam, forwarded to provisionAgyProject. */
  agyCommand?: { file: string; args: string[] };
}

/**
 * Returns a verified project id for an agy member, creating the project when
 * the member has none (upgrade path for members registered before project
 * binding) or when its project file is missing, unparseable or names a
 * different id. Sets `agent.agyProjectId` on the passed object and, unless
 * persist is false, in the registry. Throws AgyProjectError on failure --
 * callers must treat that as a hard error, never fall back to running agy
 * without --project.
 */
export async function ensureAgyProject(agent: Agent, options: EnsureAgyProjectOptions = {}): Promise<EnsureAgyProjectResult> {
  if ((agent.llmProvider ?? 'claude') !== 'agy') {
    throw new AgyProjectError(`member "${agent.friendlyName}" is not an agy member`);
  }
  const exec = options.exec ?? defaultExec(agent);
  let reason: EnsureAgyProjectResult['provisioned'];
  const current = agent.agyProjectId;
  if (current === undefined || current === '') {
    reason = 'no_project_id';
  } else if (!isValidAgyProjectId(current)) {
    reason = 'invalid_project_id';
  } else {
    const state = await probeAgyProject(agent, current, exec);
    if (state === 'ok') return { projectId: current };
    reason = state;
  }

  if (reason !== 'no_project_id') {
    logWarn('agy_project', `agy project "${current}" for "${agent.friendlyName}" is ${reason} -- creating a new project`, agent);
  }
  const projectId = await provisionAgyProject(agent, exec, options.agyCommand ?? agyCommandOverride);
  agent.agyProjectId = projectId;
  if (options.persist !== false) {
    updateAgent(agent.id, { agyProjectId: projectId });
  }
  logLine('agy_project', `created agy project ${projectId} for "${agent.friendlyName}" (${reason})`, agent);
  return { projectId, provisioned: reason };
}
