import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { parse, stringify } from 'smol-toml';
import type { LlmProvider } from '../types.js';

const home = os.homedir();
export const FLEET_BASE = path.join(home, '.apra-fleet');
export const BIN_DIR = path.join(FLEET_BASE, 'bin');
export const HOOKS_DIR = path.join(FLEET_BASE, 'hooks');
export const SCRIPTS_DIR = path.join(FLEET_BASE, 'scripts');
export const DATA_DIR = path.join(FLEET_BASE, 'data');
export const INSTALL_CONFIG_PATH = path.join(DATA_DIR, 'install-config.json');
// Workflow subsystem (apra-fleet workflow <name>) -- see
// docs/workflow-subsystem-plan.md Section 2.1 for the on-disk layout.
export const NODE_MODULES_DIR = path.join(FLEET_BASE, 'node_modules');
export const SCHEMAS_DIR = path.join(FLEET_BASE, 'schemas');
export const WORKFLOWS_DIR = path.join(FLEET_BASE, 'workflows');

// Claude entries use the bare family aliases (haiku/sonnet/opus) instead of
// dated model IDs -- the claude CLI/settings.json resolve these to the
// current generation automatically, so they never go stale as Anthropic
// ships new models. Other providers' CLIs don't share this alias support,
// so their entries stay pinned to literal model IDs.
// The gemini-*/claude-*-thinking entries are AGY's (Antigravity's) own model
// ids, not the removed gemini provider's -- AGY is built on Google's Gemini
// stack and inherits its model catalog. They are the STABLE slug ids `agy
// models` prints, and must stay in step with AGY_MODEL_FOR_TIER in
// src/providers/agy.ts: a slug AGY does not recognize is not a soft fallback,
// it fails the dispatch outright with "invalid model selection".
export const CURATED_CHEAP_MODELS = [
  'gpt-oss-120b',
  'gpt-120',
  'gemini-3.8-flash-low',
  'haiku',
  'gpt-5.4-mini',
] as const;

export const CURATED_STANDARD_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.1-pro-low',
  'gpt-oss-120b',
  'gpt-120',
  'sonnet',
  'gpt-5.4',
] as const;

export const CURATED_PREMIUM_MODELS = [
  'sonnet',
  'opus',
  'gemini-3.1-pro-high',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b',
] as const;

export const PROVIDER_STANDARD_MODELS: Record<string, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.4',
  copilot: 'claude-sonnet-4-5',
  agy: 'gemini-3.8-flash-high',
  opencode: 'ollama/qwen3-coder:30b',
};

/** Supported install targets, in deterministic profile-discovery fallback order. */
export const INSTALLABLE_LLM_PROVIDERS: readonly LlmProvider[] = [
  'claude', 'codex', 'copilot', 'agy', 'opencode',
];

export interface ProviderInstallConfig {
  configDir: string;
  settingsFile: string;
  skillsDir: string;
  fleetSkillsDir: string;
  agentsDir: string | undefined;
  name: string;
}

export interface MultiProviderInstallConfig {
  providers: Record<string, {
    skill: 'none' | 'all' | 'fleet' | 'pm';
    // Optional for backward compatibility -- older install-config.json files
    // (written before the workflow subsystem existed) won't have this field.
    workflowsMode?: 'all' | 'none';
    installedAt: string;
  }>;
}

export function getProviderInstallConfig(provider: LlmProvider, homeDir = home): ProviderInstallConfig {
  switch (provider) {
    case 'agy':
      return {
        configDir: path.join(homeDir, '.gemini', 'antigravity-cli'),
        settingsFile: path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'),
        skillsDir: path.join(homeDir, '.gemini', 'antigravity-cli', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.gemini', 'antigravity-cli', 'skills', 'fleet'),
        agentsDir: path.join(homeDir, '.gemini', 'antigravity-cli', 'agents'),
        name: 'Antigravity',
      };
    case 'codex':
      return {
        configDir: path.join(homeDir, '.codex'),
        settingsFile: path.join(homeDir, '.codex', 'config.toml'),
        skillsDir: path.join(homeDir, '.codex', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.codex', 'skills', 'fleet'),
        agentsDir: undefined,
        name: 'Codex',
      };
    case 'copilot':
      return {
        configDir: path.join(homeDir, '.copilot'),
        settingsFile: path.join(homeDir, '.copilot', 'settings.json'),
        skillsDir: path.join(homeDir, '.copilot', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.copilot', 'skills', 'fleet'),
        agentsDir: undefined,
        name: 'Copilot',
      };
    case 'opencode':
      return {
        configDir: path.join(homeDir, '.config', 'opencode'),
        settingsFile: path.join(homeDir, '.config', 'opencode', 'opencode.json'),
        skillsDir: path.join(homeDir, '.config', 'opencode', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.config', 'opencode', 'skills', 'fleet'),
        agentsDir: path.join(homeDir, '.config', 'opencode', 'agents'),
        name: 'OpenCode',
      };
    case 'claude':
    default:
      return {
        configDir: path.join(homeDir, '.claude'),
        settingsFile: path.join(homeDir, '.claude', 'settings.json'),
        skillsDir: path.join(homeDir, '.claude', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.claude', 'skills', 'fleet'),
        agentsDir: path.join(homeDir, '.claude', 'agents'),
        name: 'Claude',
      };
  }
}

/**
 * Home-relative agents dir for a provider (e.g. '.claude/agents'), or undefined
 * when the provider has no agents dir (codex, copilot). Derived from
 * getProviderInstallConfig() so install and remote provisioning cannot drift.
 */
export function getAgentsDirRelative(provider: LlmProvider): string | undefined {
  const paths = getProviderInstallConfig(provider);
  if (!paths.agentsDir) return undefined;
  return path.relative(home, paths.agentsDir).replace(/\\/g, '/');
}

export function readConfig(paths: ProviderInstallConfig): any {
  if (!fs.existsSync(paths.settingsFile)) return {};
  const content = fs.readFileSync(paths.settingsFile, 'utf-8').trim();
  if (!content) return {};

  if (paths.settingsFile.endsWith('.toml')) {
    try {
      return parse(content);
    } catch {
      return {};
    }
  }
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Write a file that carries a credential: owner-only (0600), never briefly
 * readable by others. writeFileSync's mode applies only when the file is
 * created, so an existing file (a provider config the user already had, at
 * 0644) is chmod-ed BEFORE the credential is written into it; a new file is
 * created 0600. The final chmod pins exactly 0600 whatever the umask.
 */
export function writeOwnerOnlyFile(file: string, content: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Upper bound, in ms, of the rename retries of the atomic owner-only writers:
 * a Windows antivirus scan or indexer can hold a just-written file for a
 * second or more, so a few seconds of backoff absorbs that, still bounded.
 */
export const RENAME_RETRY_BUDGET_MS = 4000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The file changed between the caller's read and the replace (or appeared /
 * disappeared): the replace was refused and the file left as the other writer
 * left it. Thrown only by a writer given an `expected` precondition.
 */
export class FileChangedError extends Error {
  constructor(public readonly filePath: string) {
    super(`${filePath} was changed by another writer since it was read; the replace was refused`);
    this.name = 'FileChangedError';
  }
}

/**
 * The current bytes of `file`, or null when it does not exist (existsSync
 * first, then a read; a file removed in between also reads as null).
 */
export function readFileBytesOrNull(file: string): Buffer | null {
  if (!fs.existsSync(file)) return null;
  try {
    const data: unknown = fs.readFileSync(file);
    return Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Throws FileChangedError unless `target` holds exactly `expected` (null = absent). */
function assertUnchanged(target: string, expected: Buffer | null | undefined): void {
  if (expected === undefined) return;
  const now = readFileBytesOrNull(target);
  if (expected === null ? now !== null : (now === null || !now.equals(expected))) throw new FileChangedError(target);
}

/**
 * Writes `content` to an owner-only (`mode`) temp file next to `target` and
 * renames it over `target`; the live file is never opened for writing. A
 * failed rename (e.g. EBUSY/EPERM while another process holds the file on
 * Windows) is retried with exponential backoff (25 ms doubling, at most 1 s
 * per wait) for up to RENAME_RETRY_BUDGET_MS. Then the temp file is removed
 * and the error names the target, the attempts and the elapsed time; the
 * target is left byte-identical. With `expected` set (the bytes the caller
 * read; null = the file did not exist) the target is compared right before
 * every rename attempt, and a mismatch removes the temp file and throws
 * FileChangedError (compare-and-swap; the remaining window is the rename
 * call itself).
 */
function replaceByRename(target: string, content: string, mode: number, expected?: Buffer | null): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode, flag: 'wx' });
    fs.chmodSync(tmp, mode);
    const start = Date.now();
    for (let attempt = 1; ; attempt++) {
      assertUnchanged(target, expected);
      try { fs.renameSync(tmp, target); return; } catch (err: unknown) {
        const elapsed = Date.now() - start;
        const wait = Math.min(25 * 2 ** (attempt - 1), 1000);
        if (elapsed + wait > RENAME_RETRY_BUDGET_MS) {
          throw new Error(`could not replace ${target} after ${attempt} attempts over ${elapsed} ms: ${err instanceof Error ? err.message : String(err)}; it was left unchanged`);
        }
        sleepSync(wait);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* not created / already moved */ }
    throw err;
  }
}

/**
 * writeOwnerOnlyFile for a file another process saves concurrently (Claude
 * Code's ~/.claude.json): the content goes to an owner-only temp file in the
 * same directory, then replaces the target by rename, so a crash or a racing
 * save never leaves it truncated. The live file is never written in place:
 * when the rename keeps failing (e.g. the target held open on Windows) the
 * bounded retries of replaceByRename run out and this throws naming the file,
 * which is left byte-identical. A symlinked file keeps its link: the temp
 * file is placed next to, and renamed over, the link's real target. The temp
 * file takes the existing file's owner permission bits (never group/other).
 *
 * One deliberate exception, POSIX only: a file owned by ANOTHER uid (e.g.
 * install run under sudo against the invoking user's config) is written in
 * place, because a rename would hand the file to the current user. That case
 * cannot be atomic; it is kept so a sudo install still updates the user's
 * config instead of failing (the `expected` check still runs first).
 *
 * `opts.expected` makes the replace a compare-and-swap: the bytes the caller
 * read (null = the file did not exist); when the file no longer holds them
 * this throws FileChangedError and writes nothing (see
 * updateClaudeConfigFile for the re-read loop).
 */
export function writeOwnerOnlyFileAtomic(file: string, content: string, opts: { expected?: Buffer | null } = {}): void {
  let target = file;
  try { const real = fs.realpathSync(file); if (typeof real === 'string' && real) target = real; } catch { /* missing: write at `file` */ }
  let st: fs.Stats | undefined;
  try { st = fs.statSync(target); } catch { /* new file */ }
  const getuid = (process as { getuid?: () => number }).getuid;
  if (st && typeof getuid === 'function' && typeof st.uid === 'number' && st.uid !== getuid()) {
    assertUnchanged(target, opts.expected);
    writeOwnerOnlyFile(target, content);
    return;
  }
  const mode = st && typeof st.mode === 'number' && (st.mode & 0o700) ? (st.mode & 0o700) | 0o600 : 0o600;
  replaceByRename(target, content, mode, opts.expected);
}

/**
 * Strict sibling of writeOwnerOnlyFileAtomic for a file whose loss is
 * unrecoverable (registry.json): the content goes to an owner-only (0600)
 * temp file in the same directory and replaces the target by rename, and the
 * live file is NEVER opened for writing. A transient rename failure (e.g. an
 * antivirus scan holding the file on Windows) is retried with backoff for a
 * bounded few seconds (replaceByRename); on final failure the temp file is
 * removed and the error names the attempts and the elapsed time, leaving the
 * target byte-identical. Unlike writeOwnerOnlyFileAtomic there is no in-place
 * write even for an existing file owned by another uid (POSIX): that throws a
 * clear error instead, since a rename would hand the file to the current user
 * and an in-place write is exactly what this helper exists to avoid.
 * A symlinked target keeps its link (temp file placed next to the real file).
 */
export function writeOwnerOnlyFileAtomicStrict(file: string, content: string): void {
  let target = file;
  try { const real = fs.realpathSync(file); if (typeof real === 'string' && real) target = real; } catch { /* missing: write at `file` */ }
  let st: fs.Stats | undefined;
  try { st = fs.statSync(target); } catch { /* new file */ }
  const getuid = (process as { getuid?: () => number }).getuid;
  if (st && typeof getuid === 'function' && typeof st.uid === 'number' && st.uid !== getuid()) {
    throw new Error(`${target} is owned by another user (uid ${st.uid}); refusing to replace or rewrite it in place`);
  }
  replaceByRename(target, content, 0o600);
}

export function writeConfig(paths: ProviderInstallConfig, config: any, opts: { ownerOnly?: boolean } = {}): void {
  fs.mkdirSync(paths.configDir, { recursive: true });
  let content = '';
  if (paths.settingsFile.endsWith('.toml')) {
    content = stringify(config);
  } else {
    content = JSON.stringify(config, null, 2) + '\n';
  }
  if (opts.ownerOnly) writeOwnerOnlyFile(paths.settingsFile, content);
  else fs.writeFileSync(paths.settingsFile, content);
}

export function readInstallConfig(installConfigPath = INSTALL_CONFIG_PATH): MultiProviderInstallConfig {
  if (!fs.existsSync(installConfigPath)) {
    return { providers: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(installConfigPath, 'utf-8'));
    // Handle old format migration
    if (data.llm && data.skill) {
      return {
        providers: {
          [data.llm]: {
            skill: data.skill,
            installedAt: new Date().toISOString()
          }
        }
      };
    }
    // Ensure providers object exists
    if (!data.providers || typeof data.providers !== 'object') {
      return { providers: {} };
    }
    return data as MultiProviderInstallConfig;
  } catch {
    return { providers: {} };
  }
}

export function writeInstallConfig(
  llm: string,
  skill: 'none' | 'all' | 'fleet' | 'pm',
  workflowsMode: 'all' | 'none' = 'all'
): void {
  const config = readInstallConfig();
  config.providers[llm] = {
    skill,
    workflowsMode,
    installedAt: new Date().toISOString()
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INSTALL_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
