import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';
import { serverVersion } from '../version.js';
import type { LlmProvider } from '../types.js';

const home = os.homedir();
const FLEET_BASE = path.join(home, '.apra-fleet');
const BIN_DIR = path.join(FLEET_BASE, 'bin');
const HOOKS_DIR = path.join(FLEET_BASE, 'hooks');
const SCRIPTS_DIR = path.join(FLEET_BASE, 'scripts');
// NOTE: install NEVER writes to the data directory (~/.apra-fleet/data/).
// Registry (registry.json) and onboarding state (onboarding.json) live there and
// must not be touched by reinstalls or upgrades — see onboarding.ts upgrade detection.

interface ProviderInstallConfig {
  configDir: string;
  settingsFile: string;
  skillsDir: string;
  fleetSkillsDir: string;
  name: string;
}

function readConfig(paths: ProviderInstallConfig): any {
  if (!fs.existsSync(paths.settingsFile)) return {};
  const content = fs.readFileSync(paths.settingsFile, 'utf-8');
  if (paths.settingsFile.endsWith('.toml')) {
    return parse(content);
  }
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeConfig(paths: ProviderInstallConfig, config: any): void {
  fs.mkdirSync(paths.configDir, { recursive: true });
  let content = '';
  if (paths.settingsFile.endsWith('.toml')) {
    content = stringify(config);
  } else {
    content = JSON.stringify(config, null, 2) + '\n';
  }
  fs.writeFileSync(paths.settingsFile, content);
}

function getProviderInstallConfig(provider: LlmProvider): ProviderInstallConfig {
  switch (provider) {
    case 'gemini':
      return {
        configDir: path.join(home, '.gemini'),
        settingsFile: path.join(home, '.gemini', 'settings.json'),
        skillsDir: path.join(home, '.gemini', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.gemini', 'skills', 'fleet'),
        name: 'Gemini',
      };
    case 'codex':
      return {
        configDir: path.join(home, '.codex'),
        settingsFile: path.join(home, '.codex', 'config.toml'),
        skillsDir: path.join(home, '.codex', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.codex', 'skills', 'fleet'),
        name: 'Codex',
      };
    case 'copilot':
      return {
        configDir: path.join(home, '.copilot'),
        settingsFile: path.join(home, '.copilot', 'settings.json'),
        skillsDir: path.join(home, '.copilot', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.copilot', 'skills', 'fleet'),
        name: 'Copilot',
      };
    case 'claude':
    default:
      return {
        configDir: path.join(home, '.claude'),
        settingsFile: path.join(home, '.claude', 'settings.json'),
        skillsDir: path.join(home, '.claude', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.claude', 'skills', 'fleet'),
        name: 'Claude',
      };
  }
}

// Detect SEA mode
let _seaOverride: boolean | null = null;
/** Override isSea() result — for tests only. Pass null to restore default. */
export function _setSeaOverride(v: boolean | null): void { _seaOverride = v; }

function isSea(): boolean {
  if (_seaOverride !== null) return _seaOverride;
  try {
    const sea = require('node:sea');
    return sea.isSea();
  } catch {
    return false;
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
  const skills = collectFilesRec(path.join(root, 'skills', 'pm'), 'skills/pm');
  const fleetSkills = collectFilesRec(path.join(root, 'skills', 'fleet'), 'skills/fleet');
  const vf = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf-8'));
  return { version: vf.version, hooks, scripts, skills, fleetSkills };
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

function mergeHooksConfig(paths: ProviderInstallConfig, hooksConfig: any): void {
  const settings = readConfig(paths);
  settings.hooks = settings.hooks || {};
  settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];

  for (const newHook of hooksConfig.hooks.PostToolUse || []) {
    const idx = (settings.hooks.PostToolUse as any[]).findIndex(
      (h: any) => h.matcher === newHook.matcher
    );
    if (idx >= 0) {
      settings.hooks.PostToolUse[idx] = newHook;
    } else {
      settings.hooks.PostToolUse.push(newHook);
    }
  }

  writeConfig(paths, settings);
}

function mergePermissions(paths: ProviderInstallConfig): void {
  const settings = readConfig(paths);

  const requiredPerms = [
    'mcp__apra-fleet__*',
    'Agent(*)',
    `Read(${paths.skillsDir.replace(/\\/g, '/')}/**)`,
    `Read(${paths.fleetSkillsDir.replace(/\\/g, '/')}/**)`,
  ];

  settings.permissions = settings.permissions || {};
  settings.permissions.allow = settings.permissions.allow || [];
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

const PROVIDER_STANDARD_MODELS: Record<string, string> = {
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-3-flash-preview',
  codex: 'gpt-5.4',
  copilot: 'claude-sonnet-4-5',
};

function writeDefaultModel(paths: ProviderInstallConfig, standardModel: string): void {
  const settings = readConfig(paths);
  settings.defaultModel = standardModel;
  writeConfig(paths, settings);
}

function mergeCopilotConfig(paths: ProviderInstallConfig, mcpConfig: any): void {
  const settings = readConfig(paths);
  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers['apra-fleet'] = mcpConfig;

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
  apra-fleet install --llm <provider>  Target LLM provider: claude (default), gemini, codex, copilot
  apra-fleet install --help            Show this help

Options:
  --llm <provider>        LLM provider to configure. Supported: claude, gemini, codex, copilot.
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

  const supported: LlmProvider[] = ['claude', 'gemini', 'codex', 'copilot'];
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
  const totalSteps = (installFleet && installPm) ? 8 : installFleet ? 7 : installPm ? 8 : 6;

  if (llm === 'gemini' && (installFleet || installPm)) {
    console.warn(`\n⚠ Note: Gemini does not support background agents. If you plan to use Gemini as the\n  PM/orchestrator, fleet operations will run sequentially (no parallel dispatch).\n  For best orchestration performance, consider using Claude. See docs for details.\n`);
  }

  // --- Running-process guard (SEA mode only — dev mode runs via node, not the binary) ---
  if (isSea() && isApraFleetRunning()) {
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
  } else {
    console.log(`  [1/${totalSteps}] Dev mode — skipping binary copy`);
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
  const installedHooksConfig = JSON.parse(
    fs.readFileSync(path.join(HOOKS_DIR, 'hooks-config.json'), 'utf-8')
  );
  mergeHooksConfig(paths, installedHooksConfig);

  const statuslineScript = path.join(SCRIPTS_DIR, 'fleet-statusline.sh');
  configureStatusline(paths, statuslineScript);

  // Write defaultModel to provider settings so native CLI invocations default to standard tier
  const standardModel = PROVIDER_STANDARD_MODELS[llm] ?? PROVIDER_STANDARD_MODELS['claude'];
  writeDefaultModel(paths, standardModel);

  // --- Step 5: Register MCP server ---
  console.log(`  [5/${totalSteps}] Registering MCP server...`);

  const mcpConfig = isSea() 
    ? { command: binaryPath, args: [] }
    : { command: 'node', args: [path.join(findProjectRoot(), 'dist', 'index.js')] };

  if (llm === 'claude') {
    try {
      run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
    } catch { /* not registered */ }
    
    const cmd = mcpConfig.command === 'node' 
      ? `claude mcp add --scope user apra-fleet -- node "${mcpConfig.args[0]}"`
      : `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}"`;
    run(cmd);
  } else if (llm === 'gemini') {
    mergeGeminiConfig(paths, mcpConfig);
  } else if (llm === 'codex') {
    mergeCodexConfig(paths, mcpConfig);
  } else if (llm === 'copilot') {
    mergeCopilotConfig(paths, mcpConfig);
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
      // Dev mode: copy from project skills/pm/
      const pmSrc = path.join(findProjectRoot(), 'skills', 'pm');
      copyDirSync(pmSrc, paths.skillsDir);
    }
  }

  if (!installFleet && !installPm) {
    console.log(`  Skipping skills (use --skill all to install, or omit --skill for default)`);
  }

  // --- Step 8: Install Beads task tracker ---
  console.log(`  [${totalSteps}/${totalSteps}] Installing Beads task tracker...`);
  try {
    // Check if already installed
    try {
      execFileSync('bd', ['--version'], { stdio: 'pipe' });
      // already installed — skip
    } catch {
      // not installed — install it
      execFileSync('npm', ['install', '-g', '@beads/bd'], { stdio: 'inherit' });
    }
  } catch (err) {
    // non-fatal: warn but don't fail the install
    console.warn('  ⚠ Beads install skipped — npm not available or install failed');
  }

  // Finalize permissions
  mergePermissions(paths);

  // Write install-config.json
  const installConfig = { llm, skill: skillMode };
  const configDir = path.join(FLEET_BASE, 'data');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'install-config.json'), JSON.stringify(installConfig, null, 2), { mode: 0o600 });

  // --- Done ---
  let beadsVersion = 'installed';
  try {
    const versionOut = execFileSync('bd', ['--version'], { stdio: 'pipe', encoding: 'utf-8' });
    beadsVersion = (versionOut as string).trim() || 'installed';
  } catch {
    beadsVersion = 'not available';
  }

  const instructions = llm === 'claude' ? 'Run /mcp in Claude Code to load the server.' : `Restart ${paths.name} to load the server.`;
  const forceNote = force ? '\nRestart Claude Code to reload the MCP server.' : '';
  console.log(`
Apra Fleet ${serverVersion} installed successfully for ${paths.name}.
  Binary:      ${BIN_DIR}
  Hooks:       ${HOOKS_DIR}
  Scripts:     ${SCRIPTS_DIR}
  Settings:    ${paths.settingsFile}${installFleet ? `\n  Fleet Skill: ${paths.fleetSkillsDir}` : ''}${installPm ? `\n  PM Skill:    ${paths.skillsDir}` : ''}
  Beads:       ${beadsVersion}

${instructions}${forceNote}
`);
}
