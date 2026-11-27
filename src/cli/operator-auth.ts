/**
 * Operator-host GitHub credential that refreshes itself.
 *
 *   apra-fleet git-credential [--label <label>] <get|store|erase>
 *       A git credential helper. On `get` for https://github.com it prints an
 *       installation token minted on demand from the GitHub App configured by
 *       setup_git_app, cached owner-only under FLEET_DIR and re-minted once it
 *       is within 5 minutes of expiry -- so operator git never holds an expired
 *       token. `store`/`erase` and any other host print nothing and exit 0.
 *
 *   apra-fleet operator-auth github [--label <l>] [--access <level>] [--repos o/n,...] [--remove]
 *       One-time operator setup: records {label, access, repos}, removes ONLY
 *       fleet's own legacy helper value(s) from the global
 *       credential.https://github.com.helper key (0.4.5 and older), and
 *       registers the git-credential helper above for that key. Idempotent.
 *
 *   apra-fleet operator-auth exec [--label <l>] -- <cmd> [args...]
 *       Runs <cmd> with GH_TOKEN set to a fresh token (same mint and cache) in
 *       that child's environment only, for gh. The token is never printed or
 *       returned to the caller: only the child's exit code comes back.
 *
 * Reads only files (git-config.json, the App key, the operator record): no
 * fleet server needs to be running. The token is written only to stdout (and
 * the owner-only cache file); it never reaches argv, logs or stderr.
 *
 * Every entry point is an in-process function with injectable stdin/stdout/
 * stderr and clock; src/index.ts maps the returned exit code to process.exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { FLEET_DIR } from '../paths.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';
import { escapeShellArg } from '../utils/shell-escape.js';
import { createStreamRedactor, TOKEN_REDACTION } from '../utils/redact-secret.js';
import { OPERATOR_SCOPE_URL, operatorAuthRecordPath } from '../services/operator-auth-record.js';

export { OPERATOR_SCOPE_URL };
export const OPERATOR_HELPER_KEY = `credential.${OPERATOR_SCOPE_URL}.helper`;
export const OPERATOR_SETUP_COMMAND = 'apra-fleet operator-auth github';
export const DEFAULT_OPERATOR_LABEL = 'github';
export const DEFAULT_OPERATOR_ACCESS = 'push+pr';
/** A cached token is reused until it is this close to its expiry. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const ACCESS_LEVELS = ['read', 'push', 'push+pr', 'admin', 'issues', 'full'] as const;
const LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export interface OperatorIo {
  /** Full stdin text (git credential protocol). Default: read process.stdin to EOF. */
  readStdin?: () => Promise<string>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Clock in ms. Default Date.now. */
  now?: () => number;
  /**
   * The command that runs this fleet binary, one absolute path per element
   * (SEA: [binary]; node: [node, script]). Default: resolved from this process.
   */
  selfCommand?: string[];
  /**
   * Runs `exec`'s child with `env` (stdin inherited); every stdout/stderr
   * chunk goes to `onStdout`/`onStderr`, which redact the token before
   * printing. Resolves to the exit code once both streams are drained.
   * Default: child_process.spawn, no shell.
   */
  runChild?: (command: string, args: string[], env: NodeJS.ProcessEnv,
    onStdout: (chunk: Buffer | string) => void, onStderr: (chunk: Buffer | string) => void) => Promise<number>;
}

export interface OperatorRecord {
  label: string;
  access: string;
  repos: string[];
  /** The exact helper value registered in the global git config. */
  helper: string;
  /**
   * True when operator-auth github put the empty reset entry at the head of
   * the key itself (so --remove takes it out again once nothing else is left).
   */
  resetAdded?: boolean;
}

interface OperatorFile {
  version: 1;
  github: Record<string, OperatorRecord>;
}

interface TokenCache {
  token: string;
  expiresAt: string;
  access: string;
  repos: string[];
  appId: string;
  installationId: number;
}

class OperatorAuthError extends Error {}

function recordPath(): string {
  return operatorAuthRecordPath();
}

/** Cache file of the token minted for `label` (owner-only). */
export function operatorTokenCachePath(label: string): string {
  return path.join(FLEET_DIR, `operator-token-${label}.json`);
}

function writeOwnerOnly(file: string, text: string): void {
  if (!fs.existsSync(FLEET_DIR)) fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  enforceOwnerOnly(file);
}

function loadRecords(): OperatorFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath(), 'utf8')) as Partial<OperatorFile>;
    return { version: 1, github: parsed && typeof parsed.github === 'object' && parsed.github ? parsed.github : {} };
  } catch {
    return { version: 1, github: {} };
  }
}

function saveRecords(file: OperatorFile): void {
  const text = JSON.stringify(file, null, 2) + '\n';
  let current: string | null = null;
  try { current = fs.readFileSync(recordPath(), 'utf8'); } catch { /* absent */ }
  if (current === text) return;
  writeOwnerOnly(recordPath(), text);
}

/** The operator record for `label`, or undefined when operator-auth github never ran for it. */
export function getOperatorRecord(label: string): OperatorRecord | undefined {
  return loadRecords().github[label];
}

function missingRecordMessage(label: string): string {
  const flag = label === DEFAULT_OPERATOR_LABEL ? '' : ` --label ${label}`;
  return `apra-fleet: no operator GitHub credential is set up for label '${label}'. Run '${OPERATOR_SETUP_COMMAND}${flag}' first.`;
}

/**
 * A token for the operator record `label`: the cached one while it is more
 * than REFRESH_MARGIN_MS from expiry, else a freshly minted one (cached).
 * Throws OperatorAuthError (no token in the message) on any failure.
 */
export async function getOperatorToken(label: string, now: () => number = Date.now): Promise<{ token: string; expiresAt: string; minted: boolean }> {
  const record = getOperatorRecord(label);
  if (!record) throw new OperatorAuthError(missingRecordMessage(label));

  const { getGitHubApp } = await import('../services/git-config.js');
  const app = getGitHubApp();
  if (!app) {
    throw new OperatorAuthError(`apra-fleet: no GitHub App is configured on this host (run the setup_git_app tool), so '${OPERATOR_SETUP_COMMAND}' has nothing to mint tokens from.`);
  }

  const cacheFile = operatorTokenCachePath(label);
  let cached: TokenCache | undefined;
  try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as TokenCache; } catch { cached = undefined; }
  if (cached
    && typeof cached.token === 'string' && cached.token.length > 0
    && cached.access === record.access
    && JSON.stringify(cached.repos) === JSON.stringify(record.repos)
    && cached.appId === app.appId
    && cached.installationId === app.installationId) {
    const expiry = Date.parse(cached.expiresAt);
    if (Number.isFinite(expiry) && expiry - now() > REFRESH_MARGIN_MS) {
      return { token: cached.token, expiresAt: cached.expiresAt, minted: false };
    }
  }

  const { loadPrivateKey, mintGitToken, mapAccessLevel } = await import('../services/github-app.js');
  let minted: { token: string; expiresAt: string };
  try {
    const key = loadPrivateKey(app.privateKeyPath);
    minted = await mintGitToken(app.appId, key, app.installationId,
      record.repos.length > 0 ? record.repos : ['*'], mapAccessLevel(record.access));
  } catch (err) {
    throw new OperatorAuthError(`apra-fleet: could not mint a GitHub App token for label '${label}': ${(err as Error).message}`);
  }
  if (typeof minted.token !== 'string' || minted.token.length === 0) {
    throw new OperatorAuthError(`apra-fleet: GitHub returned no token for label '${label}'.`);
  }
  const entry: TokenCache = {
    token: minted.token, expiresAt: minted.expiresAt, access: record.access, repos: record.repos,
    appId: app.appId, installationId: app.installationId,
  };
  writeOwnerOnly(cacheFile, JSON.stringify(entry) + '\n');
  return { token: minted.token, expiresAt: minted.expiresAt, minted: true };
}

// ---------------------------------------------------------------------------
// argv helpers
// ---------------------------------------------------------------------------

interface ParsedArgs { flags: Record<string, string | true>; positional: string[] }

function parseArgs(argv: string[], valueFlags: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) flags[name] = a.slice(eq + 1);
      else if (valueFlags.includes(name)) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new OperatorAuthError(`apra-fleet: --${name} needs a value.`);
        flags[name] = v;
        i++;
      } else flags[name] = true;
    } else if (a === '-h') {
      flags.help = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function labelFrom(flags: Record<string, string | true>): string {
  const v = flags.label;
  if (v === undefined) return DEFAULT_OPERATOR_LABEL;
  if (typeof v !== 'string' || !LABEL_RE.test(v)) {
    throw new OperatorAuthError(`apra-fleet: invalid --label (allowed: letters, digits, '_', '-', at most 64).`);
  }
  return v;
}

function defaultIo(io: OperatorIo): Required<Omit<OperatorIo, 'selfCommand'>> & { selfCommand?: string[] } {
  return {
    runChild: io.runChild ?? spawnChild,
    readStdin: io.readStdin ?? readProcessStdin,
    stdout: io.stdout ?? (s => { process.stdout.write(s); }),
    stderr: io.stderr ?? (s => { process.stderr.write(s); }),
    now: io.now ?? Date.now,
    selfCommand: io.selfCommand,
  };
}

/** No shell: the command and its arguments are passed as an argv array, never parsed. */
function spawnChild(command: string, args: string[], env: NodeJS.ProcessEnv,
  onStdout: (chunk: Buffer | string) => void, onStderr: (chunk: Buffer | string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], env, shell: false, windowsHide: true });
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', err => reject(new OperatorAuthError(`apra-fleet: could not start '${command}': ${err.message}`)));
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function readProcessStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Parse git credential protocol text into its key=value attributes. */
export function parseCredentialInput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line === '') break;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// apra-fleet git-credential
// ---------------------------------------------------------------------------

export const GIT_CREDENTIAL_USAGE = `apra-fleet git-credential [--label <label>] <get|store|erase>

A git credential helper (git credential protocol on stdin/stdout) for
https://github.com. On 'get' it prints username=x-access-token and a GitHub
App installation token, minted on demand from the App configured by
setup_git_app and cached until 5 minutes before it expires. 'store' and
'erase' do nothing; any other host prints nothing so git asks the next helper.

Registered by '${OPERATOR_SETUP_COMMAND}'; you normally never run it by hand.`;

export async function runGitCredential(argv: string[], io: OperatorIo = {}): Promise<number> {
  const d = defaultIo(io);
  let parsed: ParsedArgs;
  let label: string;
  try {
    parsed = parseArgs(argv, ['label']);
    if (parsed.flags.help) { d.stdout(GIT_CREDENTIAL_USAGE + '\n'); return 0; }
    label = labelFrom(parsed.flags);
  } catch (err) {
    d.stderr(`${(err as Error).message}\n`);
    return 2;
  }
  const action = parsed.positional[parsed.positional.length - 1];
  // Drain stdin for every action: git writes the request before reading.
  const input = parseCredentialInput(await d.readStdin());
  if (action !== 'get') return 0;
  if ((input.protocol !== undefined && input.protocol !== 'https') || (input.host ?? '').toLowerCase() !== 'github.com') return 0;
  try {
    const { token, expiresAt } = await getOperatorToken(label, d.now);
    const expirySeconds = Math.floor(Date.parse(expiresAt) / 1000);
    d.stdout(`username=x-access-token\npassword=${token}\n`
      + (Number.isFinite(expirySeconds) ? `password_expiry_utc=${expirySeconds}\n` : ''));
    return 0;
  } catch (err) {
    d.stderr(`${(err as Error).message}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// apra-fleet operator-auth
// ---------------------------------------------------------------------------

export const OPERATOR_AUTH_USAGE = `apra-fleet operator-auth github [--label <label>] [--access <level>] [--repos owner/name,...]
apra-fleet operator-auth github --remove [--label <label>]
apra-fleet operator-auth exec [--label <label>] -- <command> [args...]

Gives git and gh on THIS host (your shell, cron, hooks) a GitHub credential
that never goes stale: a GitHub App installation token minted on demand from
the App configured by setup_git_app, re-minted 5 minutes before it expires.

  github     One-time setup. Records the label, access level (default
             ${DEFAULT_OPERATOR_ACCESS}; one of ${ACCESS_LEVELS.join(', ')}) and repos (default:
             every repo of the installation); removes only fleet's own legacy
             helper value(s) (0.4.5 and older) from the global git config key
             ${OPERATOR_HELPER_KEY}, keeping every other value; and puts
             'apra-fleet git-credential --label <label>' there as the first
             helper, right after an empty reset entry. Fleet members never
             use it.
             Running it again changes nothing.
  --remove   Undo: remove the helper this command added and its record.
  exec       Run <command> with GH_TOKEN set to a fresh token in its
             environment only (gh cannot use a git helper):
               apra-fleet operator-auth exec -- gh pr list
             The token is never printed: the command's output is piped
             back with the token redacted (so gh sees no terminal on
             stdout/stderr). The exit code is the command's. <command> runs
             directly, not through a shell; on Windows a .cmd/.bat shim
             (e.g. npm) needs an explicit 'cmd /c':
               apra-fleet operator-auth exec -- cmd /c npm run release`;

/** The command that runs this fleet binary: [binary] under SEA, [node, script] otherwise. */
export function resolveSelfCommand(): string[] {
  let sea = false;
  try {
    // Same probe as cli/install.ts isSea(), without importing that module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sea = require('node:sea').isSea();
  } catch { sea = false; }
  if (sea) return [process.execPath];
  return [process.execPath, path.resolve(process.argv[1] ?? '')];
}

/**
 * The global-config helper value for `label`: `!'<binary>' ['<script>'] git-credential --label <label>`.
 * git runs a `!` helper through its POSIX shell on every OS (Git for Windows
 * ships one), so each path is single-quoted with ' written as '\'' and, on
 * Windows, uses forward slashes -- the quoting docs/design-git-auth.md uses.
 */
export function operatorHelperValue(label: string, selfCommand: string[], platform: NodeJS.Platform = process.platform): string {
  const parts = selfCommand.map(p => escapeShellArg(platform === 'win32' ? p.replace(/\\/g, '/') : p));
  return `!${parts.join(' ')} git-credential --label ${label}`;
}

/** git is spawned directly (no shell) with argv arrays: no quoting layer but git's own. */
function gitExe(): string {
  return 'git';
}

function gitGetAll(key: string): string[] {
  try {
    const out = execFileSync(gitExe(), ['config', '--global', '-z', '--get-all', key],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return out.split('\0').slice(0, -1);
  } catch (err) {
    // Exit 1 = key absent.
    if ((err as { status?: number }).status === 1) return [];
    throw new OperatorAuthError(`apra-fleet: could not read the global git config: ${(err as Error).message}`);
  }
}

function git(args: string[]): void {
  try {
    execFileSync(gitExe(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
    throw new OperatorAuthError(`apra-fleet: git ${args.slice(0, 3).join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

/** Replace every value of the global key with `values`, in order (an empty list removes the key). */
function rewriteGlobalKey(key: string, values: string[]): void {
  if (gitGetAll(key).length > 0) git(['config', '--global', '--unset-all', key]);
  for (const v of values) git(['config', '--global', '--add', key, v]);
}

/** `key\nvalue` entries of one config scope matching the github.com credential helper keys, in file order. */
function helperEntries(scope: '--system' | '--global'): { key: string; value: string }[] {
  try {
    const out = execFileSync(gitExe(), ['config', scope, '-z', '--get-regexp', '^credential\\.(https://github\\.com\\.)?helper$'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return out.split('\0').slice(0, -1).map(e => {
      const nl = e.indexOf('\n');
      return nl < 0 ? { key: e, value: '' } : { key: e.slice(0, nl), value: e.slice(nl + 1) };
    });
  } catch {
    // Absent key, or no readable system config: nothing contributes.
    return [];
  }
}

/**
 * How many helpers git consults for https://github.com before `helper`:
 * system then global credential.helper / credential.https://github.com.helper
 * values in config order, each empty value resetting the list.
 */
function effectiveHelpersAhead(helper: string): number {
  const list: string[] = [];
  for (const e of [...helperEntries('--system'), ...helperEntries('--global')]) {
    if (e.key.toLowerCase() === OPERATOR_HELPER_KEY.toLowerCase() && e.value === helper) return list.length;
    if (e.value === '') list.length = 0;
    else list.push(e.value);
  }
  return 0;
}

/**
 * The values fleet 0.4.5 and older stored on the global key for `label`
 * (`<home>/.fleet-git-credential-<label>` on POSIX; the forward-slash .bat
 * path on Windows, from USERPROFILE and from Git Bash's HOME).
 */
export function legacyHelperValues(label: string, platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env): string[] {
  const stem = `.fleet-git-credential-${label}`;
  if (platform !== 'win32') return [`${os.homedir()}/${stem}`];
  const homes = [os.homedir(), env.USERPROFILE, env.HOME].filter((h): h is string => !!h);
  const values = homes.map(h => `${h.replace(/\\/g, '/').replace(/\/+$/, '')}/${stem}.bat`);
  return [...new Set(values)];
}

/**
 * Remove ONLY fleet's legacy helper value(s) for `label` from the global key,
 * through the same exact-value matcher provision_vcs_auth's upgrade migration
 * uses (posixLegacyHelperUnset / powershellLegacyHelperUnset). Config only:
 * the legacy file itself is left alone. Returns the number of values removed.
 */
async function removeLegacyHelperValues(label: string): Promise<{ removed: number; failed: boolean }> {
  const { parseLegacyHelperReport } = await import('../os/os-commands.js');
  let removed = 0;
  let failed = false;
  for (const value of legacyHelperValues(label)) {
    let out: string;
    if (process.platform === 'win32') {
      const { powershellLegacyHelperUnset } = await import('../os/windows.js');
      const { windowsExecutable } = await import('../os/windows-executable.js');
      const keyLiteral = OPERATOR_HELPER_KEY.replace(/'/g, "''");
      const script = powershellLegacyHelperUnset(keyLiteral, `'${value.replace(/'/g, "''")}'`);
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      out = execFileSync(windowsExecutable('powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } else {
      const { posixLegacyHelperUnset } = await import('../os/linux.js');
      out = execFileSync('sh', ['-c', posixLegacyHelperUnset(escapeShellArg(OPERATOR_HELPER_KEY), escapeShellArg(value))],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    }
    const report = parseLegacyHelperReport(out);
    if (!report || report.failed) failed = true;
    else removed += report.removed;
  }
  return { removed, failed };
}

function parseRepos(v: string | true | undefined): string[] {
  if (v === undefined) return [];
  if (typeof v !== 'string') throw new OperatorAuthError('apra-fleet: --repos needs a value.');
  const repos = v.split(',').map(s => s.trim()).filter(Boolean);
  const bad = repos.filter(r => !REPO_RE.test(r));
  if (bad.length > 0) throw new OperatorAuthError(`apra-fleet: invalid --repos entry '${bad[0]}' (expected owner/name).`);
  return repos;
}

async function operatorAuthGithub(flags: Record<string, string | true>, d: ReturnType<typeof defaultIo>): Promise<number> {
  const label = labelFrom(flags);
  const records = loadRecords();

  if (flags.remove) {
    const existing = records.github[label];
    if (!existing) { d.stdout(`No operator GitHub credential for label '${label}'; nothing to remove.\n`); return 0; }
    if (gitGetAll(OPERATOR_HELPER_KEY).includes(existing.helper)) {
      git(['config', '--global', '--fixed-value', '--unset-all', OPERATOR_HELPER_KEY, existing.helper]);
      d.stdout(`Removed the fleet git-credential helper (label '${label}') from ${OPERATOR_HELPER_KEY}.\n`);
    }
    // The reset entry this command put in front goes too; every other value
    // keeps its order.
    const rest = gitGetAll(OPERATOR_HELPER_KEY);
    if (existing.resetAdded && rest[0] === '') {
      rewriteGlobalKey(OPERATOR_HELPER_KEY, rest.slice(1));
      d.stdout(`Removed the empty reset entry it added to ${OPERATOR_HELPER_KEY}.\n`);
    }
    delete records.github[label];
    saveRecords(records);
    try { fs.rmSync(operatorTokenCachePath(label), { force: true }); } catch { /* best effort */ }
    d.stdout(`Removed the operator record for label '${label}'.\n`);
    return 0;
  }

  const access = flags.access === undefined ? DEFAULT_OPERATOR_ACCESS : flags.access;
  if (typeof access !== 'string' || !(ACCESS_LEVELS as readonly string[]).includes(access)) {
    throw new OperatorAuthError(`apra-fleet: invalid --access (one of ${ACCESS_LEVELS.join(', ')}).`);
  }
  const repos = parseRepos(flags.repos);

  const { getGitHubApp } = await import('../services/git-config.js');
  if (!getGitHubApp()) {
    throw new OperatorAuthError('apra-fleet: no GitHub App is configured on this host. Run the setup_git_app tool first, then re-run this command.');
  }

  const helper = operatorHelperValue(label, d.selfCommand ?? resolveSelfCommand());
  const changes: string[] = [];

  const previous = records.github[label];

  // (b) fleet's own legacy value(s) only.
  const legacy = await removeLegacyHelperValues(label);
  if (legacy.removed > 0) changes.push(`Removed ${legacy.removed} legacy fleet helper value(s) from ${OPERATOR_HELPER_KEY}; other values kept.`);
  if (legacy.failed) changes.push(`[WARN] git refused to remove a legacy fleet helper value from ${OPERATOR_HELPER_KEY}; edit it with 'git config --global --edit'.`);

  // (c) the refreshing helper; an older value of ours (other binary path) is replaced.
  let values = gitGetAll(OPERATOR_HELPER_KEY);
  if (previous && previous.helper !== helper && values.includes(previous.helper)) {
    git(['config', '--global', '--fixed-value', '--unset-all', OPERATOR_HELPER_KEY, previous.helper]);
    values = gitGetAll(OPERATOR_HELPER_KEY);
  }
  // The key must open with the empty reset entry, so a system or global
  // credential.helper (e.g. Git Credential Manager) is not asked before -- or
  // handed the minted token after -- the fleet helper for github.com. The
  // legacy migration drops the reset when it leaves nothing else on the key,
  // and a fresh host never had one. Foreign values keep their order after it.
  // The fleet helper goes directly after the reset: git uses the first helper
  // that answers, so a foreign value ahead of it (e.g. a stale token) would
  // keep answering. Foreign values keep their order after it; an inner empty
  // value would reset the list and drop the fleet helper, so it goes too.
  let resetAdded = previous?.resetAdded === true;
  const wanted = ['', helper, ...values.filter(v => v !== '' && v !== helper)];
  if (JSON.stringify(values) !== JSON.stringify(wanted)) {
    if (values[0] !== '') {
      resetAdded = true;
      changes.push(`Put an empty reset entry first on ${OPERATOR_HELPER_KEY}, so system and global credential.helper values are not used for github.com.`);
    }
    const others = wanted.length - 2;
    changes.push(values.includes(helper)
      ? `Moved the fleet git-credential helper to the front of ${OPERATOR_HELPER_KEY} (right after the reset entry).`
      : `Added the fleet git-credential helper to ${OPERATOR_HELPER_KEY}, right after the reset entry.`);
    if (others > 0) changes.push(`Kept ${others} other helper value(s) on ${OPERATOR_HELPER_KEY}, after the fleet helper.`);
    rewriteGlobalKey(OPERATOR_HELPER_KEY, wanted);
    values = gitGetAll(OPERATOR_HELPER_KEY);
  }

  // (a) the record git-credential and `operator-auth exec` read on every
  // mint, written last so a rerun computes the same record and writes nothing.
  const record: OperatorRecord = { label, access, repos, helper, ...(resetAdded ? { resetAdded: true } : {}) };
  if (JSON.stringify(previous) !== JSON.stringify(record)) {
    records.github[label] = record;
    saveRecords(records);
    changes.push(`Recorded operator credential '${label}' (access ${access}, repos ${repos.length ? repos.join(',') : 'all of the installation'}).`);
  }

  // (e) report.
  if (changes.length === 0) d.stdout(`Operator GitHub credential '${label}' is already set up; nothing changed.\n`);
  else for (const c of changes) d.stdout(`${c}\n`);
  const ahead = effectiveHelpersAhead(helper);
  if (ahead > 0) {
    d.stdout(`[WARN] ${ahead} other helper(s) are still asked before it for https://github.com (git uses the first that answers, so a stale one keeps failing). Remove them with 'git config --global --edit' (or 'git config --system --edit'), then re-run '${OPERATOR_SETUP_COMMAND}'.\n`);
  }
  d.stdout(`git: tokens are minted on demand and refreshed before they expire.\n`
    + `gh: run it through fleet, e.g. apra-fleet operator-auth exec${label === DEFAULT_OPERATOR_LABEL ? '' : ` --label ${label}`} -- gh pr list\n`);
  return 0;
}

export async function runOperatorAuth(argv: string[], io: OperatorIo = {}): Promise<number> {
  const d = defaultIo(io);
  try {
    // Everything after `--` belongs to exec's child, never to our flags.
    const dashes = argv.indexOf('--');
    const childArgv = dashes >= 0 ? argv.slice(dashes + 1) : [];
    const parsed = parseArgs(dashes >= 0 ? argv.slice(0, dashes) : argv, ['label', 'access', 'repos']);
    const sub = parsed.positional[0];
    if (parsed.flags.help || sub === undefined || sub === 'help') {
      d.stdout(OPERATOR_AUTH_USAGE + '\n');
      return sub === undefined && !parsed.flags.help ? 2 : 0;
    }
    if (sub === 'github') return await operatorAuthGithub(parsed.flags, d);
    if (sub === 'exec') {
      if (dashes < 0 || childArgv.length === 0) {
        d.stderr(`apra-fleet operator-auth exec: give the command after '--', e.g. apra-fleet operator-auth exec -- gh pr list
`);
        return 2;
      }
      const { token } = await getOperatorToken(labelFrom(parsed.flags), d.now);
      // The child's output is piped back through an exact-value redactor, so
      // a child that prints GH_TOKEN (e.g. `gh auth token`) shows only the
      // marker; output streams as it arrives.
      const out = createStreamRedactor(token, TOKEN_REDACTION, d.stdout);
      const err = createStreamRedactor(token, TOKEN_REDACTION, d.stderr);
      try {
        return await d.runChild(childArgv[0], childArgv.slice(1), { ...process.env, GH_TOKEN: token },
          c => out.push(c), c => err.push(c));
      } finally {
        out.end();
        err.end();
      }
    }
    d.stderr(`apra-fleet operator-auth: unknown subcommand '${sub}'.\n\n${OPERATOR_AUTH_USAGE}\n`);
    return 2;
  } catch (err) {
    d.stderr(`${(err as Error).message}\n`);
    return 1;
  }
}
