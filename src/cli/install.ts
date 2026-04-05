import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';
import { serverVersion } from '../version.js';
import type { LlmProvider } from '../types.js';

const home = os.homedir();
const FLEET_BASE = path.join(home, '.apra-fleet');
const BIN_DIR = path.join(FLEET_BASE, 'bin');
const HOOKS_DIR = path.join(FLEET_BASE, 'hooks');
const SCRIPTS_DIR = path.join(FLEET_BASE, 'scripts');

interface ProviderInstallConfig {
  configDir: string;
  settingsFile: string;
  skillsDir: string;
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
    content = JSON.stringify(config, null, 2) + '
';
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
        name: 'Gemini',
      };
    case 'codex':
      return {
        configDir: path.join(home, '.codex'),
        settingsFile: path.join(home, '.codex', 'config.toml'),
        skillsDir: path.join(home, '.codex', 'skills', 'pm'),
        name: 'Codex',
      };
    case 'copilot':
      return {
        configDir: path.join(home, '.copilot'),
        settingsFile: path.join(home, '.copilot', 'settings.json'),
        skillsDir: path.join(home, '.copilot', 'skills', 'pm'),
        name: 'Copilot',
      };
    case 'claude':
    default:
      return {
        configDir: path.join(home, '.claude'),
        settingsFile: path.join(home, '.claude', 'settings.json'),
        skillsDir: path.join(home, '.claude', 'skills', 'pm'),
        name: 'Claude',
      };
  }
}

// Detect SEA mode
function isSea(): boolean {
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
}

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
    const relPath = path.join(base, entry.name).replace(/\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(results, collectFilesRec(fullPath, relPath, effectiveRootBase));
    } else {
      results[path.relative(effectiveRootBase, relPath).replace(/\/g, '/')] = relPath;
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
  const vf = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf-8'));
  return { version: vf.version, hooks, scripts, skills };
}

function loadManifest(): AssetManifest {
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

function mergePermissions(paths: ProviderInstallConfig, mcpKey: string): void {
  const settings = readConfig(paths);

  const requiredPerms = [
    `mcp__${mcpKey}__*`,
    'Agent(*)',
    `Read(${paths.skillsDir.replace(/\/g, '/')}/**)`,
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

function mergeGeminiConfig(paths: ProviderInstallConfig, mcpConfig: any, mcpKey: string): void {
  const settings = readConfig(paths);
  settings.mcpServers = settings.mcpServers || {};
  // Clean up old keys
  for (const key in settings.mcpServers) {
    if (key.startsWith('apra-fleet') && key !== mcpKey) {
      delete settings.mcpServers[key];
    }
  }
  settings.mcpServers[mcpKey] = {
    ...mcpConfig,
    trust: true,
  };

  writeConfig(paths, settings);
}

const PROVIDER_STANDARD_MODELS: Record<string, string> = {
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
  codex: 'gpt-5.4',
  copilot: 'claude-sonnet-4-5',
};

function writeDefaultModel(paths: ProviderInstallConfig, standardModel: string): void {
  const settings = readConfig(paths);
  settings.defaultModel = standardModel;
  writeConfig(paths, settings);
}

function mergeCopilotConfig(paths: ProviderInstallConfig, mcpConfig: any, mcpKey: string): void {
  const settings = readConfig(paths);
  settings.mcpServers = settings.mcpServers || {};
    // Clean up old keys
  for (const key in settings.mcpServers) {
    if (key.startsWith('apra-fleet') && key !== mcpKey) {
      delete settings.mcpServers[key];
    }
  }
  settings.mcpServers[mcpKey] = mcpConfig;

  writeConfig(paths, settings);
}

function mergeCodexConfig(paths: ProviderInstallConfig, mcpConfig: any, mcpKey: string): void {
  const settings = readConfig(paths);
  settings.mcp_servers = settings.mcp_servers || {};
    // Clean up old keys
  for (const key in settings.mcp_servers) {
    if (key.startsWith('apra-fleet') && key !== mcpKey) {
      delete settings.mcp_servers[key];
    }
  }
  settings.mcp_servers[mcpKey] = {
    command: mcpConfig.command.replace(/\/g, '/'),
    args: mcpConfig.args.map((a: string) => a.replace(/\/g, '/')),
  };

  writeConfig(paths, settings);
}

function run(cmd: string, opts?: Record<string, unknown>): void {
  // Windows needs a shell for .cmd executables (e.g. claude.cmd)
  const shellOpt = process.platform === 'win32' ? { shell: 'cmd.exe' } : {};
  execSync(cmd, { stdio: 'inherit', ...shellOpt, ...opts });
}

export async function runInstall(args: string[]): Promise<void> {
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
  const installSkill = args.includes('--skill');
  const totalSteps = installSkill ? 6 : 5;
  const mcpKey = `apra-fleet_${serverVersion.replace(/\+/g, '_')}`;

  if (llm === 'gemini' && installSkill) {
    console.warn(`
⚠ Note: Gemini does not support background agents. If you plan to use Gemini as the
  PM/orchestrator, fleet operations will run sequentially (no parallel dispatch).
  For best orchestration performance, consider using Claude. See docs for details.
`);
  }

  console.log(`
Installing Apra Fleet ${serverVersion} for ${paths.name}...
`);

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
      // Remove legacy key. We can't easily find/remove other versioned keys.
      run('claude mcp remove apra-fleet', { stdio: 'ignore' });
    } catch { /* not registered */ }
    
    const cmd = mcpConfig.command === 'node' 
      ? `claude mcp add --scope user ${mcpKey} -- node "${mcpConfig.args[0]}"`
      : `claude mcp add --scope user ${mcpKey} -- "${mcpConfig.command}"`;
    run(cmd);
  } else if (llm === 'gemini') {
    mergeGeminiConfig(paths, mcpConfig, mcpKey);
  } else if (llm === 'codex') {
    mergeCodexConfig(paths, mcpConfig, mcpKey);
  } else if (llm === 'copilot') {
    mergeCopilotConfig(paths, mcpConfig, mcpKey);
  }

  // --- Step 6: Install PM skill (optional) ---
  if (installSkill) {
    console.log(`  [6/${totalSteps}] Installing PM skill...`);
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
  } else {
    console.log(`  Skipping PM skill (use --skill to install)`);
  }

  // Finalize permissions
  mergePermissions(paths, mcpKey);

  // --- Done ---
  const instructions = llm === 'claude' ? 'Run /mcp in Claude Code to load the server.' : `Restart ${paths.name} to load the server.`;
  console.log(`
Apra Fleet ${serverVersion} installed successfully for ${paths.name}.
  Binary:      ${BIN_DIR}
  Hooks:       ${HOOKS_DIR}
  Scripts:     ${SCRIPTS_DIR}
  Settings:    ${paths.settingsFile}${installSkill ? `
  PM Skill:    ${paths.skillsDir}` : ''}

${instructions}
`);
}
