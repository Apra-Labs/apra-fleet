import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { serverVersion } from '../version.js';

const home = os.homedir();
const FLEET_BASE = path.join(home, '.apra-fleet');
const BIN_DIR = path.join(FLEET_BASE, 'bin');
const HOOKS_DIR = path.join(FLEET_BASE, 'hooks');
const SCRIPTS_DIR = path.join(FLEET_BASE, 'scripts');
const CLAUDE_DIR = path.join(home, '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills', 'pm');

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

function mergeHooksConfig(hooksConfig: any): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });

  let settings: any = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  }
  settings.hooks = settings.hooks || {};
  settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];

  for (const newHook of hooksConfig.hooks.PostToolUse || []) {
    const idx = settings.hooks.PostToolUse.findIndex(
      (h: any) => h.matcher === newHook.matcher
    );
    if (idx >= 0) {
      settings.hooks.PostToolUse[idx] = newHook;
    } else {
      settings.hooks.PostToolUse.push(newHook);
    }
  }

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

function mergePermissions(): void {
  let settings: any = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  }

  const requiredPerms = [
    'mcp__apra-fleet__*',
    'Agent(*)',
    'Read(~/.claude/skills/pm/**)',
  ];

  settings.permissions = settings.permissions || {};
  settings.permissions.allow = settings.permissions.allow || [];
  const existing = new Set(settings.permissions.allow as string[]);
  for (const perm of requiredPerms) {
    if (!existing.has(perm)) {
      settings.permissions.allow.push(perm);
    }
  }

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

function configureStatusline(scriptPath: string): void {
  // settings.json should already exist from mergeHooksConfig, but be defensive
  let settings: any = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  }
  // Windows: Claude Code can't execute .sh directly — prefix with bash
  const command = process.platform === 'win32' ? `bash "${scriptPath}"` : scriptPath;
  settings.statusLine = {
    type: 'command',
    command,
  };
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

function run(cmd: string, opts?: Record<string, unknown>): void {
  // Windows needs a shell for .cmd executables (e.g. claude.cmd)
  const shellOpt = process.platform === 'win32' ? { shell: 'cmd.exe' } : {};
  execSync(cmd, { stdio: 'inherit', ...shellOpt, ...opts });
}

export async function runInstall(args: string[]): Promise<void> {
  const installSkill = args.includes('--skill');
  const totalSteps = installSkill ? 6 : 5;

  console.log(`\nInstalling Apra Fleet ${serverVersion}...\n`);

  // --- Step 1: Copy binary ---
  if (isSea()) {
    console.log(`  [1/${totalSteps}] Installing binary...`);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const binaryName = process.platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet';
    const destBinary = path.join(BIN_DIR, binaryName);
    fs.copyFileSync(process.execPath, destBinary);
    if (process.platform !== 'win32') {
      fs.chmodSync(destBinary, 0o755);
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
  console.log(`  [4/${totalSteps}] Configuring Claude settings...`);
  const installedHooksConfig = JSON.parse(
    fs.readFileSync(path.join(HOOKS_DIR, 'hooks-config.json'), 'utf-8')
  );
  mergeHooksConfig(installedHooksConfig);
  mergePermissions();

  const statuslineScript = path.join(SCRIPTS_DIR, 'fleet-statusline.sh');
  configureStatusline(statuslineScript);

  // --- Step 5: Register MCP server ---
  console.log(`  [5/${totalSteps}] Registering MCP server...`);
  try {
    run('claude mcp remove apra-fleet', { stdio: 'ignore' });
  } catch { /* not registered */ }

  if (isSea()) {
    const binaryName = process.platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet';
    const binaryPath = path.join(BIN_DIR, binaryName);
    run(`claude mcp add --scope user apra-fleet -- "${binaryPath}"`);
  } else {
    // Dev mode: use node + dist/index.js
    const root = findProjectRoot();
    const indexJs = path.join(root, 'dist', 'index.js');
    run(`claude mcp add --scope user apra-fleet -- node "${indexJs}"`);
  }

  // --- Step 6: Install PM skill (optional) ---
  if (installSkill) {
    console.log(`  [6/${totalSteps}] Installing PM skill...`);
    if (isSea()) {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      for (const [name, assetKey] of Object.entries(manifest.skills)) {
        const content = extractAsset(assetKey);
        writeAssetFile(path.join(SKILLS_DIR, name), content);
      }
    } else {
      // Dev mode: copy from project skills/pm/
      const pmSrc = path.join(findProjectRoot(), 'skills', 'pm');
      copyDirSync(pmSrc, SKILLS_DIR);
    }
  } else {
    console.log(`  Skipping PM skill (use --skill to install)`);
  }

  // --- Done ---
  console.log(`
Apra Fleet ${serverVersion} installed successfully.
  Binary:      ${BIN_DIR}
  Hooks:       ${HOOKS_DIR}
  Scripts:     ${SCRIPTS_DIR}
  Settings:    ${SETTINGS_FILE}${installSkill ? `\n  PM Skill:    ${SKILLS_DIR}` : ''}

Run /mcp in Claude Code to load the server.
`);
}
