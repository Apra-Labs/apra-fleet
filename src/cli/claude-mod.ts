/**
 * The fleet-status Claude Code mod (plugins/claude-code/fleet-status/): a
 * plugin with function hooks that shows apra-fleet member status in Claude
 * Code's status line and a /fleet-status pane, reading the fleet_snapshot MCP
 * tool. `apra-fleet install --llm claude` installs it in place of the
 * statusLine script; uninstall removes it.
 *
 * Layout on disk -- a local folder marketplace under the apra-fleet home:
 *   <FLEET_BASE>/claude-plugins/.claude-plugin/marketplace.json  (apra-fleet-local)
 *   <FLEET_BASE>/claude-plugins/fleet-status/...                  (the plugin)
 * A plugin installed from a folder marketplace whose entry is a relative path
 * is read from that folder, so an upgrade only re-copies the files.
 *
 * Every `claude` call is argv-based (no shell, no variable expansion), with
 * windowsHide and an explicit timeout. This module must not import install.ts:
 * uninstall.ts uses it and its tests mock install.ts wholesale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FLEET_BASE, readConfig, writeConfig, type ProviderInstallConfig } from './config.js';
import { findExecutableOnPath, splitPath } from '../utils/find-on-path.js';

export const CLAUDE_MOD_MARKETPLACE = 'apra-fleet-local';
export const CLAUDE_MOD_PLUGIN = 'fleet-status';
export const CLAUDE_MOD_ID = `${CLAUDE_MOD_PLUGIN}@${CLAUDE_MOD_MARKETPLACE}`;
/** Repo-relative source folder of the mod (packaged as the claudePlugins manifest section). */
export const CLAUDE_MOD_SOURCE_DIR = 'plugins/claude-code/fleet-status';

/**
 * Paths (relative to the mod folder, forward slashes) that are authoring-time
 * only and never shipped: generated type stubs (gitignored, ~1MB), tests, and
 * the tsconfig that extends those stubs. Mirrored EXACTLY by
 * scripts/gen-sea-config.mjs (claudeModRuntimeFile) so the SEA binary and a
 * dev/npm install ship the same tree.
 */
const CLAUDE_MOD_EXCLUDED_DIRS = new Set(['tests', 'test', 'node_modules']);
export function isClaudeModRuntimeFile(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'tsconfig.json') return false;
  if (p.startsWith('.claude-plugin/types/')) return false;
  const parts = p.split('/');
  if (parts.slice(0, -1).some((d) => CLAUDE_MOD_EXCLUDED_DIRS.has(d))) return false;
  if (parts[parts.length - 1] === '.gitignore') return false;
  return true;
}

/** <apra-fleet home>/claude-plugins -- the local marketplace root. */
export function claudePluginsDir(): string {
  return path.join(FLEET_BASE, 'claude-plugins');
}

/** The marketplace manifest written next to the plugin folder. */
export function claudeModMarketplaceJson(): string {
  return JSON.stringify({
    name: CLAUDE_MOD_MARKETPLACE,
    owner: { name: 'Apra Labs' },
    description: 'Claude Code plugins installed locally by apra-fleet.',
    plugins: [
      {
        name: CLAUDE_MOD_PLUGIN,
        source: `./${CLAUDE_MOD_PLUGIN}`,
        description: 'apra-fleet member status in the status line and a /fleet-status pane.',
      },
    ],
  }, null, 2) + '\n';
}

// --- statusLine ownership (all providers) ---

/**
 * True when `statusLine` is the entry apra-fleet install wrote: its command
 * runs apra-fleet's fleet-statusline script. Anything else is the user's own
 * and is never overwritten or removed.
 */
export function isApraFleetStatusLine(statusLine: unknown): boolean {
  const cmd = (statusLine as { command?: unknown } | null | undefined)?.command;
  return typeof cmd === 'string' && cmd.includes('fleet-statusline');
}

/** Remove the statusLine from `paths`' settings only if apra-fleet wrote it. Returns true when removed. */
export function removeApraFleetStatusLine(paths: ProviderInstallConfig): boolean {
  const settings = readConfig(paths);
  if (!settings.statusLine || !isApraFleetStatusLine(settings.statusLine)) return false;
  delete settings.statusLine;
  writeConfig(paths, settings);
  return true;
}

// --- claude CLI: injectable deps + explicit test-mode gate ---
//
// Same pattern as install.ts's dolt / fleet-se steps: the real step spawns the
// user's `claude` binary and edits ~/.claude/settings.json, so in NODE_ENV=test
// it is skipped UNLESS APRA_FLEET_ENABLE_CLAUDE_MOD_STEP=1 is set (tests that
// opt in inject fakes via _setClaudeModDeps and never reach the real HOME).

export interface ClaudeModDeps {
  /** Absolute path of the claude executable, or null when it is not on PATH. */
  resolveClaude: () => string | null;
  /** Run `file args...`; resolves on exit 0, throws (with stderr/stdout attached) otherwise. */
  exec: (file: string, args: string[], timeoutMs: number) => void;
}

/** Quote one argument for a cmd.exe command line (Windows paths never contain `"`). */
function cmdQuote(arg: string): string {
  return /[\s"&|<>^()%!,;=]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * The spawn for `file args...` without a shell. Node refuses to spawn a
 * .cmd/.bat (npm's claude.cmd) without a shell (CVE-2024-27980), and
 * shell:true would join argv unquoted -- so for those the cmd.exe line is
 * built here with every argument quoted and passed verbatim. Exported for tests.
 */
export function claudeSpawnSpec(
  file: string, args: string[], platform: NodeJS.Platform = process.platform, comSpec = process.env.ComSpec,
): { cmd: string; argv: string[]; verbatim: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { cmd: comSpec || 'cmd.exe', argv: ['/d', '/s', '/c', `"${[file, ...args].map(cmdQuote).join(' ')}"`], verbatim: true };
  }
  return { cmd: file, argv: args, verbatim: false };
}

function realExec(file: string, args: string[], timeoutMs: number): void {
  const spec = claudeSpawnSpec(file, args);
  const r = spawnSync(spec.cmd, spec.argv, {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true, encoding: 'utf-8', windowsVerbatimArguments: spec.verbatim,
  });
  if (r.error) throw Object.assign(r.error, { stdout: r.stdout, stderr: r.stderr });
  if (r.status !== 0) {
    throw Object.assign(new Error(`exited ${r.status ?? r.signal}`), { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr });
  }
}

/**
 * The claude executable on PATH, without a shell. On Windows only real
 * launchers count (claude.exe from the native installer, claude.cmd/.bat from
 * npm): npm also drops an extensionless POSIX `claude` shim next to the .cmd,
 * which a plain PATHEXT walk ('' first) would pick and which cannot be spawned.
 */
function resolveClaudeOnPath(): string | null {
  if (process.platform !== 'win32') return findExecutableOnPath('claude');
  for (const dir of splitPath(process.env.PATH ?? '', 'win32')) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = path.win32.join(dir, `claude${ext}`);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
    }
  }
  return null;
}

const realClaudeModDeps: ClaudeModDeps = {
  resolveClaude: resolveClaudeOnPath,
  exec: realExec,
};
let claudeModDeps: ClaudeModDeps = realClaudeModDeps;
/** Test-only: inject fakes for the claude CLI calls. */
export function _setClaudeModDeps(overrides: Partial<ClaudeModDeps>): void {
  claudeModDeps = { ...realClaudeModDeps, ...overrides };
}
/** Test-only: restore the real claude CLI deps. */
export function _resetClaudeModDeps(): void {
  claudeModDeps = realClaudeModDeps;
}
export function claudeModStepEnabled(): boolean {
  if (process.env.NODE_ENV !== 'test') return true;
  return process.env.APRA_FLEET_ENABLE_CLAUDE_MOD_STEP === '1';
}

/** Per-call timeout for each `claude plugin ...` command. */
const CLAUDE_CLI_TIMEOUT_MS = 60_000;

/** One printable ASCII line describing why a claude call failed. */
function failureText(err: unknown): string {
  const e = err as { code?: string; status?: number | null; signal?: string | null; stderr?: unknown; stdout?: unknown; message?: string };
  if (e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM') return `timed out after ${CLAUDE_CLI_TIMEOUT_MS / 1000}s`;
  if (e?.code === 'ENOENT') return 'claude executable could not be started (ENOENT)';
  const pick = (v: unknown) => String(v ?? '').split(/\r?\n/).map((l) => l.replace(/[^\x20-\x7e]/g, '').trim()).find(Boolean);
  const detail = pick(e?.stderr) ?? pick(e?.stdout) ?? pick(e?.message) ?? 'unknown error';
  return typeof e?.status === 'number' ? `exit ${e.status}: ${detail}` : detail;
}

export type ClaudeModResult =
  | { status: 'installed'; dir: string; note?: string }
  | { status: 'skipped'; reason: string };

/** True when Claude's settings already have the mod enabled (an earlier install registered it). */
export function claudeModRegistered(paths: ProviderInstallConfig): boolean {
  return hasKey(readConfig(paths).enabledPlugins, CLAUDE_MOD_ID);
}

/**
 * Install (or upgrade) the fleet-status mod for Claude Code. `files` are the
 * mod's runtime files relative to the mod folder. Never throws: any failure is
 * returned as `skipped` with a one-line reason, and the caller keeps the
 * statusLine fallback. `installed` only when BOTH
 *   claude plugin marketplace add <dir> --scope user
 *   claude plugin install fleet-status@apra-fleet-local --scope user
 * exited 0 (both are idempotent: re-running them on an existing install exits 0).
 */
export function installClaudeMod(
  files: Array<{ relPath: string; content: Buffer | string }>,
  opts: { alreadyRegistered?: boolean } = {},
): ClaudeModResult {
  const runtime = files.filter((f) => isClaudeModRuntimeFile(f.relPath));
  if (!runtime.some((f) => f.relPath.replace(/\\/g, '/') === '.claude-plugin/plugin.json')) {
    return { status: 'skipped', reason: 'the mod files are not packaged in this apra-fleet build' };
  }
  const deps = claudeModDeps;
  let claude: string | null;
  try { claude = deps.resolveClaude(); } catch { claude = null; }
  const dir = claudePluginsDir();
  // An earlier install already registered the mod, which Claude reads in place
  // from `dir`: refresh the files even without the CLI (e.g. an update run with
  // a narrow PATH), rather than falling back to the statusLine script and
  // showing fleet status twice.
  const refreshOnly = !claude && opts.alreadyRegistered === true && fs.existsSync(dir);
  if (!claude && !refreshOnly) return { status: 'skipped', reason: "the 'claude' CLI was not found on PATH" };

  try {
    const pluginDir = path.join(dir, CLAUDE_MOD_PLUGIN);
    // Clear first so files dropped by a newer mod version do not linger.
    fs.rmSync(pluginDir, { recursive: true, force: true });
    for (const f of runtime) {
      const dest = path.join(pluginDir, ...f.relPath.replace(/\\/g, '/').split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content);
    }
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), claudeModMarketplaceJson());
  } catch (err) {
    return { status: 'skipped', reason: `could not write ${dir}: ${(err as Error).message}` };
  }

  if (!claude) {
    return { status: 'installed', dir, note: "already registered; files refreshed (the 'claude' CLI was not found on PATH)" };
  }

  const steps: string[][] = [
    ['plugin', 'marketplace', 'add', dir, '--scope', 'user'],
    ['plugin', 'install', CLAUDE_MOD_ID, '--scope', 'user'],
  ];
  for (const args of steps) {
    try {
      deps.exec(claude, args, CLAUDE_CLI_TIMEOUT_MS);
    } catch (err) {
      // An old claude without the `plugin` subcommand lands here too (non-zero exit).
      return { status: 'skipped', reason: `'claude ${args.slice(0, 3).join(' ')}' failed (${failureText(err)})` };
    }
  }
  return { status: 'installed', dir };
}

function hasKey(obj: unknown, key: string): boolean {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Remove the fleet-status mod: best-effort `claude plugin uninstall` and
 * `claude plugin marketplace remove` (non-zero exits mean "already gone"),
 * then the claude-plugins folder, and finally any leftover plugin/marketplace
 * keys in Claude's settings (for when the claude CLI is unavailable). Prints
 * one plan line (also under --dry-run). Returns true when anything was found.
 */
export function uninstallClaudeMod(paths: ProviderInstallConfig, dryRun: boolean): boolean {
  const dir = claudePluginsDir();
  const settings = readConfig(paths);
  const inSettings = hasKey(settings.enabledPlugins, CLAUDE_MOD_ID) || hasKey(settings.extraKnownMarketplaces, CLAUDE_MOD_MARKETPLACE);
  const onDisk = fs.existsSync(dir);
  if (!onDisk && !inSettings) return false;

  console.log(`  - Removing fleet-status Claude Code mod (${CLAUDE_MOD_ID}): ${dir}`);
  if (dryRun) return true;

  if (claudeModStepEnabled()) {
    let claude: string | null = null;
    try { claude = claudeModDeps.resolveClaude(); } catch { /* not on PATH */ }
    if (claude) {
      for (const args of [
        ['plugin', 'uninstall', CLAUDE_MOD_ID, '--scope', 'user'],
        ['plugin', 'marketplace', 'remove', CLAUDE_MOD_MARKETPLACE],
      ]) {
        try { claudeModDeps.exec(claude, args, CLAUDE_CLI_TIMEOUT_MS); } catch { /* already removed */ }
      }
    }
  }

  if (onDisk) fs.rmSync(dir, { recursive: true, force: true });

  // Re-read: the claude CLI above edits the same settings file.
  const after = readConfig(paths);
  let changed = false;
  if (hasKey(after.enabledPlugins, CLAUDE_MOD_ID)) {
    delete after.enabledPlugins[CLAUDE_MOD_ID];
    changed = true;
  }
  if (hasKey(after.extraKnownMarketplaces, CLAUDE_MOD_MARKETPLACE)) {
    delete after.extraKnownMarketplaces[CLAUDE_MOD_MARKETPLACE];
    changed = true;
  }
  if (changed) writeConfig(paths, after);
  return true;
}
