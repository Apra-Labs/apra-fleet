import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { serverVersion } from '../version.js';
import type { LlmProvider } from '../types.js';
import {
  BIN_DIR,
  HOOKS_DIR,
  SCRIPTS_DIR,
  getProviderInstallConfig,
  readConfig,
  writeConfig,
  writeInstallConfig,
  PROVIDER_STANDARD_MODELS,
  ProviderInstallConfig
} from './config.js';
import { transformAgentForOpenCode } from './agent-transform.js';

// Detect SEA mode
let _seaOverride: boolean | null = null;
/** Override isSea() result -- for tests only. Pass null to restore default. */
export function _setSeaOverride(v: boolean | null): void { _seaOverride = v; }

export function isSea(): boolean {
  if (_seaOverride !== null) return _seaOverride;
  try {
    const sea = require('node:sea');
    return sea.isSea();
  } catch {
    return false;
  }
}

/**
 * Detect npm global install mode: the script runs from a node_modules-managed
 * location (npm bin) rather than the SEA binary or the project's own dev dist.
 * Returns false under SEA. Distinguishes npm global installs from `npm test` /
 * dev-mode runs (which execute the project's own dist/index.js).
 *
 * Key insight: when npm installs globally, findProjectRoot() resolves to the
 * npm package's root (where version.json is), which has no .git/. Dev mode has
 * a .git/ directory at or above the root. This allows us to distinguish them.
 */
export function isNpmGlobalInstall(): boolean {
  if (isSea()) return false;
  const scriptPath = process.argv[1];
  if (!scriptPath || !scriptPath.includes('node_modules')) return false;
  // Check if the resolved project root is a git repo (has .git). If not, we
  // assume npm global install mode. This is more reliable than comparing paths
  // because npm package root and git repo root differ when npm is global.
  try {
    const projectRoot = findProjectRoot();
    const hasGit = fs.existsSync(path.join(projectRoot, '.git'));
    return !hasGit; // npm mode if no .git at project root
  } catch {
    // If we can't find a project root, assume npm (not in a known git repo)
    return true;
  }
}

function getSeaAsset(key: string): string {
  const sea = require('node:sea');
  const buf = sea.getAsset(key);
  // getAsset returns ArrayBuffer — decode to string
  return new TextDecoder().decode(buf);
}

function getSeaAssetBuffer(key: string): Buffer {
  const sea = require('node:sea');
  return Buffer.from(sea.getAsset(key));
}

interface AssetManifest {
  version: string;
  hooks: Record<string, string>;
  scripts: Record<string, string>;
  skills: Record<string, string>;
  fleetSkills: Record<string, string>;
  agents: Record<string, string>;
}

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find project root — works for both tsc (dist/cli/install.js) and esbuild (dist/sea-bundle.cjs)
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'version.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find project root (version.json not found)');
}

// Collect files recursively — used by dev-mode manifest generation
function collectFilesRec(dir: string, base: string, rootBase?: string): Record<string, string> {
  const effectiveRootBase = rootBase ?? base;
  const results: Record<string, string> = {};
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.join(base, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(results, collectFilesRec(fullPath, relPath, effectiveRootBase));
    } else {
      results[path.relative(effectiveRootBase, relPath).replace(/\\/g, '/')] = relPath;
    }
  }
  return results;
}

function buildDevManifest(root: string): AssetManifest {
  const hooks: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(root, 'hooks'))) {
    hooks[entry] = `hooks/${entry}`;
  }
  const scripts: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(root, 'scripts'))) {
    if (entry.endsWith('.mjs')) continue; // skip build scripts
    scripts[entry] = `scripts/${entry}`;
  }

  // Source PM skills and agents from vendor/apra-pm submodule (dev mode),
  // fall back to dist/ for npm global installs where submodule is absent.
  const vendorPmSkills = path.join(root, 'vendor', 'apra-pm', 'skills', 'pm');
  const vendorAgents = path.join(root, 'vendor', 'apra-pm', 'agents');
  const pmSkillsDir = fs.existsSync(vendorPmSkills) ? vendorPmSkills : path.join(root, 'dist', 'skills', 'pm');
  const agentsDir = fs.existsSync(vendorAgents) ? vendorAgents : path.join(root, 'dist', 'agents');
  const pmBase = fs.existsSync(vendorPmSkills) ? 'vendor/apra-pm/skills/pm' : 'dist/skills/pm';
  const agentsBase = fs.existsSync(vendorAgents) ? 'vendor/apra-pm/agents' : 'dist/agents';

  const skills = collectFilesRec(pmSkillsDir, pmBase, pmBase);
  const agents = collectFilesRec(agentsDir, agentsBase, agentsBase);
  const fleetSkills = collectFilesRec(path.join(root, 'skills', 'fleet'), 'skills/fleet');
  const vf = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf-8'));
  return { version: vf.version, hooks, scripts, skills, fleetSkills, agents };
}

let _manifestOverride: AssetManifest | null = null;
/** Inject a manifest for tests — avoids SEA asset extraction. Pass null to restore default. */
export function _setManifestOverride(m: AssetManifest | null): void { _manifestOverride = m; }

function loadManifest(): AssetManifest {
  if (_manifestOverride !== null) return _manifestOverride;
  if (isSea()) {
    return JSON.parse(getSeaAsset('manifest.json'));
  }
  // Dev mode: generate manifest on-the-fly from project files
  return buildDevManifest(findProjectRoot());
}

function extractAsset(key: string): string {
  if (isSea()) {
    return getSeaAsset(key);
  }
  const root = findProjectRoot();
  return fs.readFileSync(path.join(root, key), 'utf-8');
}

function extractAssetBuffer(key: string): Buffer {
  if (isSea()) {
    return getSeaAssetBuffer(key);
  }
  const root = findProjectRoot();
  return fs.readFileSync(path.join(root, key));
}

function clearDirSync(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function writeAssetFile(destPath: string, content: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content);
}

// Gemini CLI uses different hook event names than Claude CLI.
const GEMINI_HOOK_NAME_MAP: Record<string, string> = {
  PostToolUse:      'AfterTool',
  PreToolUse:       'BeforeTool',
  UserPromptSubmit: 'BeforeAgent',
  Stop:             'SessionEnd',
  PreCompact:       'PreCompress',
};

function mergeHooksConfig(paths: ProviderInstallConfig, hooksConfig: any, provider: LlmProvider): void {
  let settingsFile = paths.settingsFile;
  const isAgy = provider === 'agy';

  let settings: any = {};
  if (isAgy) {
    const configDir = path.join(os.homedir(), '.gemini', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    settingsFile = path.join(configDir, 'hooks.json');
    if (fs.existsSync(settingsFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      } catch {}
    }
  } else {
    settings = readConfig(paths);
  }

  settings.hooks = settings.hooks || {};

  for (const [claudeName, hookEntries] of Object.entries(hooksConfig.hooks || {})) {
    const eventName = provider === 'gemini'
      ? (GEMINI_HOOK_NAME_MAP[claudeName] ?? claudeName)
      : claudeName;

    // Remove stale Claude-style key if we're writing under a different Gemini name.
    if (provider === 'gemini' && claudeName in GEMINI_HOOK_NAME_MAP && claudeName !== eventName) {
      delete settings.hooks[claudeName];
    }

    settings.hooks[eventName] = settings.hooks[eventName] || [];

    for (const newHook of hookEntries as any[]) {
      const idx = (settings.hooks[eventName] as any[]).findIndex(
        (h: any) => h.matcher === newHook.matcher
      );
      if (idx >= 0) {
        settings.hooks[eventName][idx] = newHook;
      } else {
        settings.hooks[eventName].push(newHook);
      }
    }
  }

  if (isAgy) {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  } else {
    writeConfig(paths, settings);
  }
}



const CLAUDE_INVALID_RULES = ['tracker_*'];

export function pruneInvalidRules(allow: string[], providerName: string): string[] {
  if (providerName !== 'Claude') return allow;
  return allow.filter(rule => !CLAUDE_INVALID_RULES.includes(rule));
}

export function buildRequiredPerms(paths: ProviderInstallConfig): string[] {
  const perms = [
    'mcp__apra-fleet__*',
    'activate_skill(*)',
    'Agent(*)',
    `Read(${paths.skillsDir.replace(/\\/g, '/')}/**)`,
    `Read(${paths.fleetSkillsDir.replace(/\\/g, '/')}/**)`,
    `Read(${path.join(paths.configDir, 'skills').replace(/\\/g, '/')}/**)`,
  ];
  if (paths.agentsDir) {
    perms.push(`Read(${paths.agentsDir.replace(/\\/g, '/')}/**)`);
  }
  if (paths.name !== 'Claude') {
    perms.push('tracker_*');
  }
  return perms;
}

function mergePermissions(paths: ProviderInstallConfig): void {
  const settings = readConfig(paths);

  const requiredPerms = buildRequiredPerms(paths);

  settings.permissions = settings.permissions || {};
  settings.permissions.allow = settings.permissions.allow || [];
  settings.permissions.allow = pruneInvalidRules(settings.permissions.allow as string[], paths.name);
  const existing = new Set(settings.permissions.allow as string[]);
  for (const perm of requiredPerms) {
    if (!existing.has(perm)) {
      settings.permissions.allow.push(perm);
    }
  }

  writeConfig(paths, settings);
}

function configureStatusline(paths: ProviderInstallConfig, scriptPath: string): void {
  const settings = readConfig(paths);
  // Windows: Claude Code can't execute .sh directly — prefix with bash
  const command = process.platform === 'win32' ? `bash "${scriptPath}"` : scriptPath;
  settings.statusLine = {
    type: 'command',
    command,
  };
  writeConfig(paths, settings);
}

function mergeGeminiConfig(paths: ProviderInstallConfig, mcpConfig: any): void {
  const settings = readConfig(paths);
  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers['apra-fleet'] = {
    ...mcpConfig,
    trust: true,
  };

  writeConfig(paths, settings);
}

function mergeAgyConfig(paths: ProviderInstallConfig, mcpConfig: any): void {
  const configDir = path.join(os.homedir(), '.gemini', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');

  let settings: any = {};
  if (fs.existsSync(mcpConfigFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf-8'));
    } catch {}
  }

  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers['apra-fleet'] = mcpConfig;

  fs.writeFileSync(mcpConfigFile, JSON.stringify(settings, null, 2) + '\n');
}

function writeDefaultModel(paths: ProviderInstallConfig, standardModel: string): void {
  const settings = readConfig(paths);
  if (!settings.defaultModel) {
    settings.defaultModel = standardModel;
    writeConfig(paths, settings);
  }
}

function mergeCopilotConfig(paths: ProviderInstallConfig, mcpConfig: any): void {
  const settings = readConfig(paths);
  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers['apra-fleet'] = mcpConfig;

  writeConfig(paths, settings);
}

function mergeOpenCodeConfig(paths: ProviderInstallConfig, mcpConfig: any): void {
  const settings = readConfig(paths);
  settings.mcp = settings.mcp || {};
  settings.mcp['apra-fleet'] = {
    type: 'local',
    command: [mcpConfig.command, ...(mcpConfig.args || [])],
    enabled: true,
  };
  writeConfig(paths, settings);
}

function mergeCodexConfig(paths: ProviderInstallConfig, mcpConfig: any): void {
  const settings = readConfig(paths);
  settings.mcp_servers = settings.mcp_servers || {};
  settings.mcp_servers['apra-fleet'] = {
    command: mcpConfig.command.replace(/\\/g, '/'),
    args: mcpConfig.args.map((a: string) => a.replace(/\\/g, '/')),
  };

  writeConfig(paths, settings);
}

function run(cmd: string, opts?: Record<string, unknown>): void {
  // Windows needs a shell for .cmd executables (e.g. claude.cmd)
  const shellOpt = process.platform === 'win32' ? { shell: 'cmd.exe' } : {};
  execSync(cmd, { stdio: 'inherit', ...shellOpt, ...opts });
}

export function isApraFleetRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq apra-fleet.exe" /NH /FO CSV', { encoding: 'utf-8', stdio: 'pipe' });
      const currentPid = process.pid.toString();
      // Each CSV line: "apra-fleet.exe","<PID>","..." — exclude the current installer process
      return out.split('\n').some(line => {
        const match = line.match(/"apra-fleet\.exe","(\d+)"/);
        return match !== null && match[1] !== currentPid;
      });
    } else {
      // -x = exact name match; installer is apra-fleet-installer-* so won't match;
      // exclude current PID to handle self-update (installed apra-fleet binary running install)
      const out = execSync('pgrep -x apra-fleet', { encoding: 'utf-8', stdio: 'pipe' });
      const currentPid = process.pid.toString();
      return out.split('\n').some(line => line.trim() !== '' && line.trim() !== currentPid);
    }
  } catch {
    return false;
  }
}

export function killApraFleet(): void {
  if (process.platform === 'win32') {
    execSync('taskkill /F /IM apra-fleet.exe', { stdio: 'ignore' });
  } else {
    // -x = exact name match
    execSync('pkill -x apra-fleet', { stdio: 'ignore' });
  }
}

/**
 * Write empty .ignore overlay files into a LOCAL agy member's workspace to block
 * the global apra-fleet MCP server and PM/fleet skills from loading inside that
 * workspace.  Idempotent -- safe to call multiple times for the same folder.
 *
 * Only meaningful for LOCAL members (they share ~/.gemini/antigravity-cli/ with
 * the PM).  REMOTE members have their own home dir and no conflict.
 */
export function writeAgyWorkspaceOverlays(workFolder: string): void {
  const overlayPaths = [
    path.join(workFolder, '.gemini', 'antigravity-cli', 'mcp', 'apra-fleet', '.ignore'),
    path.join(workFolder, '.gemini', 'antigravity-cli', 'skills', 'fleet', '.ignore'),
    path.join(workFolder, '.gemini', 'antigravity-cli', 'skills', 'pm', '.ignore'),
  ];
  for (const filePath of overlayPaths) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', { mode: 0o644 });
  }
}

export async function runInstall(args: string[]): Promise<void> {
  // --help / -h guard — must come first, before any side effects (#142)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`apra-fleet install

Install the apra-fleet binary, hooks, MCP server registration, and skills.

Usage:
  apra-fleet install                   Install binary + hooks + statusline + MCP + fleet & PM skills (default)
  apra-fleet install --skill all       Same as bare install (all skills)
  apra-fleet install --skill fleet     Install fleet skill only
  apra-fleet install --skill pm        Install PM skill (also installs fleet — PM depends on fleet)
  apra-fleet install --skill none      Skip skill installation
  apra-fleet install --no-skill        Same as --skill none
  apra-fleet install --force           Stop a running server before installing
  apra-fleet install --llm <provider>  Target LLM provider: claude (default), gemini, codex, copilot, agy, opencode
  apra-fleet install --help            Show this help

Options:
  --llm <provider>        LLM provider to configure. Supported: claude, gemini, codex, copilot, agy, opencode.
                          Defaults to claude. Note: --llm gemini shows a warning about sequential
                          dispatch — Gemini does not support background agents, so fleet operations
                          run sequentially rather than in parallel.
  --skill <mode>          Which skills to install: all (default), fleet, pm, or none.
  --no-skill              Alias for --skill none.
  --force                 Stop a running apra-fleet server before installing (SEA mode only).`);
    process.exit(0);
    return;
  }

  // Parse --llm flag
  let llm: LlmProvider = 'claude';
  const llmArg = args.find(a => a.startsWith('--llm='));
  if (llmArg) {
    llm = llmArg.split('=')[1] as LlmProvider;
  } else {
    const idx = args.indexOf('--llm');
    if (idx >= 0 && idx < args.length - 1) {
      llm = args[idx + 1] as LlmProvider;
    }
  }

  const supported: LlmProvider[] = ['claude', 'gemini', 'codex', 'copilot', 'agy', 'opencode'];
  if (!supported.includes(llm)) {
    console.error(`Error: Unsupported LLM provider "${llm}". Supported: ${supported.join(', ')}`);
    process.exit(1);
  }

  const paths = getProviderInstallConfig(llm);

  // Parse --skill flag: default (no flag) = all; accepts all|fleet|pm|none; --no-skill = synonym for none
  type SkillMode = 'none' | 'all' | 'fleet' | 'pm';
  let skillMode: SkillMode = 'all';
  const skillEqualArg = args.find(a => a.startsWith('--skill='));
  if (skillEqualArg) {
    const val = skillEqualArg.split('=')[1];
    if (val === 'all' || val === 'fleet' || val === 'pm' || val === 'none') {
      skillMode = val;
    } else {
      console.error(`Error: --skill value must be one of: all, fleet, pm, none (got "${val}")`);
      process.exit(1);
    }
  } else {
    const skillIdx = args.indexOf('--skill');
    if (skillIdx >= 0) {
      const nextArg = args[skillIdx + 1];
      if (nextArg && !nextArg.startsWith('--') && (nextArg === 'all' || nextArg === 'fleet' || nextArg === 'pm' || nextArg === 'none')) {
        skillMode = nextArg;
      } else {
        // --skill with no value → install both (backwards-compat)
        skillMode = 'all';
      }
    }
  }

  // --no-skill is a synonym for --skill none
  if (args.includes('--no-skill')) {
    skillMode = 'none';
  }

  // Parse --force flag
  const force = args.includes('--force');

  // Reject unknown flags to catch typos early
  const knownFlagPrefixes = ['--llm=', '--skill='];
  const knownFlagExact = new Set(['--llm', '--skill', '--no-skill', '--force', '--help', '-h']);
  for (const a of args) {
    if (knownFlagExact.has(a)) continue;
    if (knownFlagPrefixes.some(p => a.startsWith(p))) continue;
    if (!a.startsWith('-')) continue; // non-flag positional (e.g. value token for --skill)
    console.error(`Error: Unknown option "${a}". Run apra-fleet install --help for usage.`);
    process.exit(1);
  }

  const installFleet = skillMode === 'fleet' || skillMode === 'pm' || skillMode === 'all';
  const installPm = skillMode === 'pm' || skillMode === 'all';
  const installAgents = installPm && paths.agentsDir !== undefined;
  let totalSteps = (installFleet && installPm) ? 9 : installFleet ? 8 : installPm ? 9 : 7;
  if (installAgents) totalSteps++;
  const beadsStep = totalSteps - 1;

  if (llm === 'gemini' && (installFleet || installPm)) {
    console.warn(`\n⚠ Note: Gemini does not support background agents. If you plan to use Gemini as the\n  PM/orchestrator, fleet operations will run sequentially (no parallel dispatch).\n  For best orchestration performance, consider using Claude. See docs for details.\n`);
  }

  // --- Running-process guard (SEA + npm modes -- dev mode runs via node, not a managed binary) ---
  if ((isSea() || isNpmGlobalInstall()) && isApraFleetRunning()) {
    if (!force) {
      const killHint = process.platform === 'win32'
        ? '    taskkill /F /IM apra-fleet.exe'
        : '    pkill -x apra-fleet';
      console.error(`
Error: apra-fleet is currently running. Stop the server before installing.

  Run with --force to stop it automatically:
    apra-fleet install --force

  Or stop it manually:
${killHint}
`);
      process.exit(1);
    }
    killApraFleet();
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log('  Stopped running server.');
  }

  console.log(`\nInstalling Apra Fleet ${serverVersion} for ${paths.name}...\n`);

  // --- Step 1: Copy binary ---
  let binaryPath = '';
  if (isSea()) {
    console.log(`  [1/${totalSteps}] Installing binary...`);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const binaryName = process.platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet';
    binaryPath = path.join(BIN_DIR, binaryName);
    fs.copyFileSync(process.execPath, binaryPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755);
    }
  } else if (isNpmGlobalInstall()) {
    console.log(`  [1/${totalSteps}] npm global install detected -- skipping binary copy`);
    binaryPath = process.argv[1];
  } else {
    console.log(`  [1/${totalSteps}] Dev mode -- skipping binary copy`);
  }

  // --- Step 2: Extract hooks ---
  console.log(`  [2/${totalSteps}] Installing hooks...`);
  const manifest = loadManifest();

  for (const [name, assetKey] of Object.entries(manifest.hooks)) {
    const content = extractAsset(assetKey);
    const destPath = path.join(HOOKS_DIR, name);
    writeAssetFile(destPath, content);
    if (process.platform !== 'win32') {
      fs.chmodSync(destPath, 0o755);
    }
  }

  // --- Step 3: Extract scripts ---
  console.log(`  [3/${totalSteps}] Installing scripts...`);
  for (const [name, assetKey] of Object.entries(manifest.scripts)) {
    const content = extractAsset(assetKey);
    const destPath = path.join(SCRIPTS_DIR, name);
    writeAssetFile(destPath, content);
    if (process.platform !== 'win32') {
      fs.chmodSync(destPath, 0o755);
    }
  }

  // --- Step 4: Configure hooks + statusline in settings.json ---
  console.log(`  [4/${totalSteps}] Configuring ${paths.name} settings...`);
  // OpenCode has a strict config schema -- hooks/statusLine/defaultModel are not valid keys
  if (llm !== 'opencode') {
    const installedHooksConfig = JSON.parse(
      fs.readFileSync(path.join(HOOKS_DIR, 'hooks-config.json'), 'utf-8')
    );
    mergeHooksConfig(paths, installedHooksConfig, llm);

    const statuslineScript = path.join(SCRIPTS_DIR, 'fleet-statusline.sh');
    configureStatusline(paths, statuslineScript);

    const standardModel = PROVIDER_STANDARD_MODELS[llm] ?? PROVIDER_STANDARD_MODELS['claude'];
    writeDefaultModel(paths, standardModel);
  }

  // --- Step 5: Register MCP server ---
  console.log(`  [5/${totalSteps}] Registering MCP server...`);

  const mcpConfig = isSea()
    ? { command: binaryPath, args: [] }
    : isNpmGlobalInstall()
    ? { command: process.execPath, args: [process.argv[1]] }
    : { command: 'node', args: [path.join(findProjectRoot(), 'dist', 'index.js')] };

  if (llm === 'claude') {
    try {
      run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
    } catch { /* not registered */ }
    
    // Build the claude MCP command from the actual mcpConfig structure.
    // SEA mode: { command: binaryPath, args: [] } -> register the binary alone.
    // npm/dev mode: { command: <node>, args: [<script>] } -> register node + script path.
    // Quote both segments so paths with spaces (e.g. Windows "Program Files") work.
    const cmd = mcpConfig.args.length > 0
      ? `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}" "${mcpConfig.args[0]}"`
      : `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}"`;
    run(cmd);
  } else if (llm === 'gemini') {
    mergeGeminiConfig(paths, mcpConfig);
  } else if (llm === 'codex') {
    mergeCodexConfig(paths, mcpConfig);
  } else if (llm === 'copilot') {
    mergeCopilotConfig(paths, mcpConfig);
  } else if (llm === 'agy') {
    mergeAgyConfig(paths, mcpConfig);
  } else if (llm === 'opencode') {
    mergeOpenCodeConfig(paths, mcpConfig);
  }

  // --- Step 6: Install fleet skill (optional) ---
  if (skillMode === 'pm') {
    console.warn(`\n⚠ Note: PM skill depends on fleet skill — installing fleet skill first.\n`);
  }
  if (installFleet) {
    console.log(`  [6/${totalSteps}] Installing fleet skill...`);
    clearDirSync(paths.fleetSkillsDir);
    if (isSea()) {
      fs.mkdirSync(paths.fleetSkillsDir, { recursive: true });
      for (const [name, assetKey] of Object.entries(manifest.fleetSkills)) {
        const content = extractAsset(assetKey);
        writeAssetFile(path.join(paths.fleetSkillsDir, name), content);
      }
    } else {
      // Dev mode: copy from project skills/fleet/
      const fleetSrc = path.join(findProjectRoot(), 'skills', 'fleet');
      copyDirSync(fleetSrc, paths.fleetSkillsDir);
    }
  }

  // --- Step 7: Install PM skill (optional) ---
  // Empty-submodule guard: vendor/apra-pm dir exists but was not initialized
  if (installPm && !isSea()) {
    const root = findProjectRoot();
    const vendorDir = path.join(root, 'vendor', 'apra-pm');
    if (fs.existsSync(vendorDir)) {
      const skillMarker = path.join(vendorDir, 'skills', 'pm', 'SKILL.md');
      if (!fs.existsSync(skillMarker)) {
        console.error(`Error: vendor/apra-pm exists but appears empty (non-recursive clone).
Run:  git submodule update --init --recursive
Then re-run:  apra-fleet install`);
        process.exit(1);
      }
    }
  }
  if (installPm) {
    console.log(`  [7/${totalSteps}] Installing PM skill...`);
    clearDirSync(paths.skillsDir);
    if (isSea()) {
      fs.mkdirSync(paths.skillsDir, { recursive: true });
      for (const [name, assetKey] of Object.entries(manifest.skills)) {
        const content = extractAsset(assetKey);
        writeAssetFile(path.join(paths.skillsDir, name), content);
      }
    } else {
      // Dev/npm mode: prefer vendor/apra-pm submodule, fall back to dist/
      const root = findProjectRoot();
      const vendorPm = path.join(root, 'vendor', 'apra-pm', 'skills', 'pm');
      const pmSrc = fs.existsSync(vendorPm) ? vendorPm : path.join(root, 'dist', 'skills', 'pm');
      copyDirSync(pmSrc, paths.skillsDir);
    }
  }

  if (!installFleet && !installPm) {
    console.log(`  Skipping skills (use --skill all to install, or omit --skill for default)`);
  }

  // --- Agent install step (only when agentsDir is defined and PM is installed) ---
  if (installAgents) {
    const agentStep = (installFleet && installPm) ? 8 : installPm ? 8 : 7;
    console.log(`  [${agentStep}/${totalSteps}] Installing PM agents...`);
    const agentsDestDir = paths.agentsDir!;
    fs.mkdirSync(agentsDestDir, { recursive: true });
    if (isSea()) {
      for (const [name, assetKey] of Object.entries(manifest.agents)) {
        let content = extractAsset(assetKey);
        if (llm === 'opencode') {
          content = transformAgentForOpenCode(content, name);
        }
        writeAssetFile(path.join(agentsDestDir, name), content);
      }
    } else {
      const root = findProjectRoot();
      const vendorAgents = path.join(root, 'vendor', 'apra-pm', 'agents');
      const agentsSrc = fs.existsSync(vendorAgents) ? vendorAgents : path.join(root, 'dist', 'agents');
      for (const entry of fs.readdirSync(agentsSrc, { withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        let content = fs.readFileSync(path.join(agentsSrc, entry.name), 'utf-8');
        if (llm === 'opencode') {
          content = transformAgentForOpenCode(content, entry.name);
        }
        writeAssetFile(path.join(agentsDestDir, entry.name), content);
      }
    }
  }

  // --- Beads install step ---
  // shell:true required on Windows — npm global packages install as .cmd wrappers
  // that cannot be directly spawned by Node without a shell
  console.log(`  [${beadsStep}/${totalSteps}] Installing Beads task tracker...`);
  try {
    // Check if already installed
    try {
      execFileSync('bd', ['--version'], { stdio: 'pipe', shell: true });
      // already installed — skip
    } catch {
      // not installed — install it
      execFileSync('npm', ['install', '-g', '@beads/bd'], { stdio: 'inherit', shell: true });
    }
  } catch (err) {
    // non-fatal: warn but don't fail the install
    console.warn('  ⚠ Beads install skipped — npm not available or install failed');
  }

  // --- Step 9: KB + code intelligence setup ---
  // Only runs when the installer is invoked from inside a git repository.
  console.log(`  [${totalSteps}/${totalSteps}] Setting up Knowledge Bank and code intelligence...`);
  const repoCwd = process.cwd();
  if (fs.existsSync(path.join(repoCwd, '.git'))) {
    // Clean up prior installs: remove legacy gitnexus entry from .mcp.json if present
    try {
      const mcpJsonPath = path.join(repoCwd, '.mcp.json');
      if (fs.existsSync(mcpJsonPath)) {
        const existing = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
        if (existing.mcpServers?.gitnexus) {
          delete existing.mcpServers.gitnexus;
          fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2));
          console.log('    [OK] Removed legacy gitnexus entry from .mcp.json');
        }
      }
    } catch (err) {
      console.warn('    ⚠ .mcp.json cleanup skipped:', err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log('    Skipped: not in a git repository. Run apra-fleet install from your project root to set up KB.');
  }

  // Write code intelligence provider config (provider-agnostic; fleet serves code intelligence tools)
  try {
    const ciConfigDir = path.join(os.homedir(), '.apra-fleet', 'data', 'code-intelligence');
    fs.mkdirSync(ciConfigDir, { recursive: true });
    fs.writeFileSync(path.join(ciConfigDir, 'config.json'), JSON.stringify({ provider: 'gitnexus' }, null, 2));
    console.log('    [OK] Code intelligence provider config written');
  } catch (err) {
    console.warn('    ⚠ Code intelligence config skipped:', err instanceof Error ? err.message : String(err));
  }

  // Write code intelligence routing instruction to ~/.claude/CLAUDE.md
  try {
    const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    const sentinel = '<!-- apra-fleet:code-intelligence -->';
    const block = `\n${sentinel}\nWhen code_graph, code_impact, code_query, or code_context tools are available,\nuse them for symbol lookups, call chain tracing, and impact analysis.\nNever use grep or file reads for structural questions when these tools are present.\n<!-- /apra-fleet:code-intelligence -->\n`;
    const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';
    if (!existing.includes(sentinel)) {
      fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
      fs.appendFileSync(claudeMdPath, block);
      console.log('    [OK] Code intelligence routing instruction written to ~/.claude/CLAUDE.md');
    }
  } catch (err) {
    console.warn('    ⚠ ~/.claude/CLAUDE.md update skipped:', err instanceof Error ? err.message : String(err));
  }

  // OpenCode uses --dangerously-skip-permissions and per-agent permission: frontmatter;
  // a top-level "permissions" key is invalid in opencode.json
  if (llm !== 'opencode') {
    mergePermissions(paths);
  }

  // Write install-config.json (merge provider entry)
  writeInstallConfig(llm, skillMode);

  // --- Done ---
  let beadsVersion = 'installed';
  try {
    const versionOut = execFileSync('bd', ['--version'], { stdio: 'pipe', encoding: 'utf-8', shell: true });
    beadsVersion = (versionOut as string).trim() || 'installed';
  } catch {
    beadsVersion = 'not available';
  }

  const clientName = llm === 'claude' ? 'Claude Code' : paths.name;
  const instructions = llm === 'claude' ? 'Run /mcp in Claude Code to load the server.' : `Restart ${paths.name} to load the server.`;
  const forceNote = force ? `\nRestart ${clientName} to reload the MCP server.` : '';
  console.log(`
Apra Fleet ${serverVersion} installed successfully for ${paths.name}.
  Binary:      ${BIN_DIR}
  Hooks:       ${HOOKS_DIR}
  Scripts:     ${SCRIPTS_DIR}
  Settings:    ${paths.settingsFile}${installFleet ? `\n  Fleet Skill: ${paths.fleetSkillsDir}` : ''}${installPm ? `\n  PM Skill:    ${paths.skillsDir}` : ''}${installAgents ? `\n  Agents:      ${paths.agentsDir}` : ''}
  Beads:       ${beadsVersion}

${instructions}${forceNote}
`);
}
