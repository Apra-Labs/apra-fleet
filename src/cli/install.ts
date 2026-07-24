import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { serverVersion } from '../version.js';
import type { LlmProvider } from '../types.js';
import { DEFAULT_PORT, LOG_FILE_PATH } from '../paths.js';
import { getServiceManager } from '../services/service-manager/index.js';
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
import { transformAgentForOpenCode, transformAgentForAgy } from './agent-transform.js';
import { extractWorkflowSubsystemAssets } from './workflow-assets.js';
import { downloadAndExtractDolt, verifyDolt } from './dolt-install.js';

// --- Dolt CLI install step: injectable deps + explicit gate ---
//
// The dolt install step below does a REAL network download (~40MB from
// GitHub) and, unless already installed, a real `dolt version` / scratch
// `dolt sql-server` smoke test (see dolt-install.ts verifyDolt). That is
// correct behavior in production but far too slow and non-hermetic to run
// unconditionally from every unit test that happens to call runInstall()
// without caring about dolt at all. Mirrors the interactive-bootstrap gate
// in register-member.ts:
// 1. Dependency injection: doltStepDeps.downloadAndExtractDolt / .verifyDolt
//    default to the real implementations but can be swapped for fakes in tests.
// 2. Explicit gate: in NODE_ENV=test (set globally by tests/setup.ts), the
//    whole step is skipped (dolt reported as "not available", non-fatal, same
//    as a real failure) UNLESS APRA_FLEET_ENABLE_DOLT_INSTALL=1 is also set --
//    an explicit, opt-in escape hatch for tests that specifically want to
//    exercise this path (and are expected to inject fakes via
//    _setDoltStepDeps when they do).
export interface DoltStepDeps {
  downloadAndExtractDolt: typeof downloadAndExtractDolt;
  verifyDolt: typeof verifyDolt;
}
const realDoltStepDeps: DoltStepDeps = { downloadAndExtractDolt, verifyDolt };
let doltStepDeps: DoltStepDeps = realDoltStepDeps;
/** Test-only: inject fakes for the dolt CLI install step's download/verify calls. */
export function _setDoltStepDeps(overrides: Partial<DoltStepDeps>): void {
  doltStepDeps = { ...realDoltStepDeps, ...overrides };
}
/** Test-only: restore the real (non-mocked) dolt step dependencies. */
export function _resetDoltStepDeps(): void {
  doltStepDeps = realDoltStepDeps;
}

function doltStepEnabled(): boolean {
  if (process.env.NODE_ENV !== 'test') return true;
  return process.env.APRA_FLEET_ENABLE_DOLT_INSTALL === '1';
}

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

// Claude-only helper skill packaged alongside apra-pm's auto-sprint workflow --
// installed into <configDir>/skills/auto-sprint-args, mirrors apra-pm/install.mjs.
const AUTO_SPRINT_ARGS_SKILL_NAME = 'auto-sprint-args';

interface AssetManifest {
  version: string;
  hooks: Record<string, string>;
  scripts: Record<string, string>;
  skills: Record<string, string>;
  fleetSkills: Record<string, string>;
  agents: Record<string, string>;
  workflows: Record<string, string>;
  // Optional: added for the workflow subsystem (apra-fleet workflow <name>).
  // Older manifests / existing tests that don't know about these keys still
  // work unmodified since they are additive-only.
  workflowRuntime?: Record<string, string>;
  agentSchemas?: Record<string, string>;
  builtinWorkflows?: Record<string, string>;
  // Optional for the same additive-only reason (0.3.5's installer shipped it
  // required, but every consumer already guards with `?? {}`).
  autoSprintArgsSkill?: Record<string, string>;
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

// Directory names excluded (recursively) when collecting a package tree for
// the workflow-runtime / agent-schemas / built-in-workflow sections -- mirrors
// scripts/gen-sea-config.mjs's PACKAGE_TREE_EXCLUDE_DIRS.
const PACKAGE_TREE_EXCLUDE_DIRS = new Set(['test', 'docs', 'scripts', 'examples']);

function collectFilesFilteredRec(
  dir: string, base: string, rootBase: string, excludeDirs: Set<string>
): Record<string, string> {
  const results: Record<string, string> = {};
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.join(base, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(results, collectFilesFilteredRec(fullPath, relPath, rootBase, excludeDirs));
    } else {
      results[path.relative(rootBase, relPath).replace(/\\/g, '/')] = relPath;
    }
  }
  return results;
}

/**
 * Collects a package/module tree using its real root-relative path (so values
 * stay valid `join(root, value)` disk paths -- and thus valid dev-mode
 * extractAsset() keys), then re-keys the result under `manifestPrefix` so
 * multiple trees merge into one manifest section without key collisions.
 * Mirrors scripts/gen-sea-config.mjs's collectPackageTree exactly, so the
 * namespaced keys install.ts's workflow-install step consumes are identical
 * in dev mode and SEA mode.
 */
function collectPackageTree(
  root: string, sourceDir: string, manifestPrefix: string,
  excludeDirs: Set<string> = PACKAGE_TREE_EXCLUDE_DIRS
): Record<string, string> {
  const rootRelBase = path.relative(root, sourceDir).replace(/\\/g, '/');
  const raw = collectFilesFilteredRec(sourceDir, rootRelBase, rootRelBase, excludeDirs);
  const results: Record<string, string> = {};
  for (const [shortKey, diskPath] of Object.entries(raw)) {
    results[`${manifestPrefix}/${shortKey}`] = diskPath;
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

  // Source PM skills from apra-pm local package copy (dev mode), fall back to
  // dist/ for npm global installs. Skills have no
  // build-time resolution step, so reading directly is safe.
  const vendorPmSkills = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'skills', 'pm');
  const pmSkillsDir = fs.existsSync(vendorPmSkills) ? vendorPmSkills : path.join(root, 'dist', 'skills', 'pm');
  const pmBase = fs.existsSync(vendorPmSkills) ? 'packages/apra-fleet-se/apra-pm/skills/pm' : 'dist/skills/pm';

  // Read straight from the local package copy -- same as skills above.
  const agentsDir = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'agents');
  const agentsBase = 'packages/apra-fleet-se/apra-pm/agents';

  const skills = collectFilesRec(pmSkillsDir, pmBase, pmBase);
  const agents = collectFilesRec(agentsDir, agentsBase, agentsBase);
  const fleetSkills = collectFilesRec(path.join(root, 'skills', 'fleet'), 'skills/fleet');

  // auto-sprint-args helper skill (packaged alongside apra-pm's auto-sprint workflow;
  // claude-only install target, see the install flow's PM cost/workflow step).
  const vendorArgsSkill = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', '.claude', 'skills', 'auto-sprint-args');
  const distArgsSkill = path.join(root, 'dist', 'skills', 'auto-sprint-args');
  const argsSkillDir = fs.existsSync(vendorArgsSkill) ? vendorArgsSkill : distArgsSkill;
  const argsSkillBase = fs.existsSync(vendorArgsSkill)
    ? 'packages/apra-fleet-se/apra-pm/.claude/skills/auto-sprint-args'
    : 'dist/skills/auto-sprint-args';
  const autoSprintArgsSkill = collectFilesRec(argsSkillDir, argsSkillBase, argsSkillBase);

  // Collect auto-sprint.js from apra-pm/.claude/workflows (or dist/workflows fallback)
  const vendorWorkflows = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', '.claude', 'workflows');
  const workflowsSrc = fs.existsSync(vendorWorkflows)
    ? vendorWorkflows
    : path.join(root, 'dist', 'workflows');
  const workflows: Record<string, string> = {};
  if (fs.existsSync(workflowsSrc)) {
    for (const f of fs.readdirSync(workflowsSrc) as string[]) {
      if (f.endsWith('.js')) {
        workflows[f] = path.join(workflowsSrc, f).replace(/\\/g, '/');
      }
    }
  }

  // Workflow subsystem parity (mirrors scripts/gen-sea-config.mjs) so `node
  // dist/index.js install` behaves identically to the SEA binary. Each source
  // tree is optional -- an npm global install (no node_modules/ajv, no apra-pm
  // package, no packages/) simply omits the section, same as an older SEA
  // manifest built before this epic; the install step warns and skips.
  const workflowRuntimeDir = path.join(root, 'packages', 'apra-fleet-workflow');
  const clientDir = path.join(root, 'packages', 'apra-fleet-client');
  const ajvDir = path.join(root, 'node_modules', 'ajv');
  let workflowRuntime: Record<string, string> | undefined;
  if (fs.existsSync(workflowRuntimeDir) && fs.existsSync(clientDir) && fs.existsSync(ajvDir)) {
    workflowRuntime = {
      ...collectPackageTree(root, workflowRuntimeDir, '@apralabs/apra-fleet-workflow'),
      ...collectPackageTree(root, clientDir, '@apralabs/apra-fleet-client'),
      ...collectPackageTree(root, ajvDir, 'ajv'),
      ...collectPackageTree(root, path.join(root, 'node_modules', 'fast-deep-equal'), 'fast-deep-equal'),
      ...collectPackageTree(root, path.join(root, 'node_modules', 'fast-uri'), 'fast-uri'),
      ...collectPackageTree(root, path.join(root, 'node_modules', 'json-schema-traverse'), 'json-schema-traverse'),
      ...collectPackageTree(root, path.join(root, 'node_modules', 'require-from-string'), 'require-from-string'),
      // undici is a direct runtime dependency of apra-fleet-client's transport
      // (packages/apra-fleet-client/src/client/transport.mjs). undici-types is
      // a types-only peer dependency (no runtime require of it in undici's
      // lib), so it is intentionally not bundled here.
      ...collectPackageTree(root, path.join(root, 'node_modules', 'undici'), 'undici'),
    };
  }

  const agentSchemasDir = path.join(root, 'vendor', 'apra-pm', 'agents', 'schemas');
  let agentSchemas: Record<string, string> | undefined;
  if (fs.existsSync(agentSchemasDir)) {
    agentSchemas = collectPackageTree(root, agentSchemasDir, 'agentSchemas');
  }

  const autoSprintDir = path.join(root, 'packages', 'apra-fleet-se');
  const helloWorldDir = path.join(root, 'examples', 'workflows', 'hello-world');
  let builtinWorkflows: Record<string, string> | undefined;
  if (fs.existsSync(autoSprintDir) || fs.existsSync(helloWorldDir)) {
    builtinWorkflows = {
      ...(fs.existsSync(autoSprintDir) ? collectPackageTree(root, autoSprintDir, 'auto-sprint') : {}),
      ...(fs.existsSync(helloWorldDir) ? collectPackageTree(root, helloWorldDir, 'hello-world') : {}),
    };
  }

  const vf = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf-8'));
  return {
    version: vf.version, hooks, scripts, skills, fleetSkills, agents, workflows,
    workflowRuntime, agentSchemas, builtinWorkflows, autoSprintArgsSkill,
  };
}

let _manifestOverride: AssetManifest | null = null;
/** Inject a manifest for tests — avoids SEA asset extraction. Pass null to restore default. */
export function _setManifestOverride(m: AssetManifest | null): void { _manifestOverride = m; }

/**
 * Test-only escape hatch to exercise the real buildDevManifest() (against the
 * real filesystem, not the mocked node:fs used elsewhere in
 * tests/install-workflows.test.ts) so regressions like apra-fleet-eft.19
 * (dev-mode install omitting undici from the workflowRuntime bundle) are
 * caught by a direct assertion on the generated manifest, not just on the
 * mocked-fs runInstall() flow.
 */
export function _buildDevManifestForTest(root: string): AssetManifest { return buildDevManifest(root); }

function loadManifest(): AssetManifest {
  if (_manifestOverride !== null) return _manifestOverride;
  if (isSea()) {
    return JSON.parse(getSeaAsset('manifest.json'));
  }
  // Dev mode: generate manifest on-the-fly from project files
  return buildDevManifest(findProjectRoot());
}

/**
 * Recursively load every agent asset (role agents + _shared/ + schemas/) as
 * {relPath, content} pairs, relPath relative to the agents dir root.
 * Shared by install (writes to disk) and agent-provisioner (hashes for remote diffing).
 */
export function loadAgentAssets(): Array<{ relPath: string; content: string }> {
  const results: Array<{ relPath: string; content: string }> = [];
  if (isSea()) {
    const manifest = loadManifest();
    for (const [relPath, assetKey] of Object.entries(manifest.agents)) {
      results.push({ relPath, content: extractAsset(assetKey) });
    }
    return results;
  }

  const root = findProjectRoot();
  const vendorAgents = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'agents');
  const agentsSrc = fs.existsSync(vendorAgents) ? vendorAgents : path.join(root, 'dist', 'agents');
  const agentsBase = fs.existsSync(vendorAgents) ? 'packages/apra-fleet-se/apra-pm/agents' : 'dist/agents';

  const collected = collectFilesRec(agentsSrc, agentsBase, agentsBase);
  for (const [relPath, rootRelativeLabel] of Object.entries(collected)) {
    results.push({ relPath, content: fs.readFileSync(path.join(root, rootRelativeLabel), 'utf-8') });
  }
  return results;
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

function mergePermissions(paths: ProviderInstallConfig, extraPerms: string[] = []): void {
  const settings = readConfig(paths);

  const requiredPerms = [...buildRequiredPerms(paths), ...extraPerms];

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
  settings.mcp['apra-fleet'] = mcpConfig.url
    ? { type: 'remote', url: mcpConfig.url, enabled: true }
    : {
        type: 'local',
        command: [mcpConfig.command, ...(mcpConfig.args || [])],
        enabled: true,
      };
  writeConfig(paths, settings);
}

function mergeCodexConfig(paths: ProviderInstallConfig, mcpConfig: any): void {
  const settings = readConfig(paths);
  settings.mcp_servers = settings.mcp_servers || {};
  if (mcpConfig.url) {
    settings.mcp_servers['apra-fleet'] = { url: mcpConfig.url };
  } else {
    settings.mcp_servers['apra-fleet'] = {
      command: mcpConfig.command.replace(/\\/g, '/'),
      args: mcpConfig.args.map((a: string) => a.replace(/\\/g, '/')),
    };
  }

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
  apra-fleet install --workflows none  Skip installing the workflow runtime + built-in workflows
  apra-fleet install --force           Stop a running server before installing
  apra-fleet install --llm <provider>  Target LLM provider: claude (default), gemini, codex, copilot, agy, opencode
  apra-fleet install --transport http  Register MCP server with HTTP transport (default)
  apra-fleet install --transport stdio Register MCP server with stdio transport (legacy)
  apra-fleet install --help            Show this help

Options:
  --llm <provider>        LLM provider to configure. Supported: claude, gemini, codex, copilot, agy, opencode.
                          Defaults to claude. Note: --llm gemini shows a warning about sequential
                          dispatch — Gemini does not support background agents, so fleet operations
                          run sequentially rather than in parallel.
  --transport <mode>      MCP transport to use: http (default) or stdio. HTTP uses the singleton
                          fleet server at http://localhost:7523/mcp. stdio runs fleet as a subprocess.
  --skill <mode>          Which skills to install: all (default), fleet, pm, or none.
  --no-skill              Alias for --skill none.
  --workflows <mode>      Which workflow assets to install: all (default) or none. Installs
                          ~/.apra-fleet/node_modules (workflow runtime), /schemas (agent role
                          schemas), and /workflows/{auto-sprint,hello-world} (built-in workflows).
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

  // Parse --workflows flag: default (no flag) = all; accepts all|none
  type WorkflowsMode = 'all' | 'none';
  let workflowsMode: WorkflowsMode = 'all';
  const workflowsEqualArg = args.find(a => a.startsWith('--workflows='));
  if (workflowsEqualArg) {
    const val = workflowsEqualArg.split('=')[1];
    if (val === 'all' || val === 'none') {
      workflowsMode = val;
    } else {
      console.error(`Error: --workflows value must be one of: all, none (got "${val}")`);
      process.exit(1);
    }
  } else {
    const workflowsIdx = args.indexOf('--workflows');
    if (workflowsIdx >= 0) {
      const nextArg = args[workflowsIdx + 1];
      if (nextArg === 'all' || nextArg === 'none') {
        workflowsMode = nextArg;
      } else {
        console.error(`Error: --workflows requires a value: all or none.`);
        process.exit(1);
      }
    }
  }

  // Parse --force flag
  const force = args.includes('--force');

  // Parse --transport flag (default: http)
  type TransportMode = 'http' | 'stdio';
  let transport: TransportMode = 'http';
  const transportEqualArg = args.find(a => a.startsWith('--transport='));
  if (transportEqualArg) {
    const val = transportEqualArg.split('=')[1];
    if (val === 'http' || val === 'stdio') {
      transport = val;
    } else {
      console.error(`Error: --transport value must be one of: http, stdio (got "${val}")`);
      process.exit(1);
    }
  } else {
    const transportIdx = args.indexOf('--transport');
    if (transportIdx >= 0 && transportIdx < args.length - 1) {
      const val = args[transportIdx + 1];
      if (val === 'http' || val === 'stdio') {
        transport = val;
      } else {
        console.error(`Error: --transport value must be one of: http, stdio (got "${val}")`);
        process.exit(1);
      }
    }
  }

  // Reject unknown flags to catch typos early
  const knownFlagPrefixes = ['--llm=', '--skill=', '--transport=', '--workflows='];
  const knownFlagExact = new Set(['--llm', '--skill', '--no-skill', '--workflows', '--force', '--transport', '--help', '-h']);
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
  const installWorkflows = workflowsMode === 'all';
  const serviceStep = isSea() && transport === 'http';
  let totalSteps = (installFleet && installPm) ? 8 : installFleet ? 7 : installPm ? 8 : 6;
  if (installAgents) totalSteps++;
  if (installPm) totalSteps++; // cost.js extraction + workflow copy step
  if (installWorkflows) totalSteps++; // workflow-subsystem runtime/schemas/built-ins step
  totalSteps++; // dolt CLI install step (apra-fleet-ire.3) -- unconditional, mirrors Beads step
  if (serviceStep) totalSteps++;

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

  const fleetPort = DEFAULT_PORT;
  const fleetUrl = `http://localhost:${fleetPort}/mcp`;

  if (transport === 'http') {
    if (llm === 'claude') {
      try {
        run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
      } catch { /* not registered */ }
      run(`claude mcp add --scope user --transport http apra-fleet ${fleetUrl}`);
    } else if (llm === 'gemini') {
      mergeGeminiConfig(paths, { httpUrl: fleetUrl });
    } else if (llm === 'codex') {
      mergeCodexConfig(paths, { url: fleetUrl });
    } else if (llm === 'copilot') {
      mergeCopilotConfig(paths, { url: fleetUrl, type: 'http' });
    } else if (llm === 'agy') {
      mergeAgyConfig(paths, { url: fleetUrl });
    } else if (llm === 'opencode') {
      mergeOpenCodeConfig(paths, { url: fleetUrl });
    }
  } else {
    // 'run --transport stdio' starts the stdio MCP server; passed as trailing args so
    // LLM providers invoke `apra-fleet run` (or `node dist/index.js run`) and the no-arg
    // default (installation) is never accidentally triggered by the MCP host.
    const mcpConfig = isSea()
      ? { command: binaryPath, args: ['run', '--transport', 'stdio'] }
      : isNpmGlobalInstall()
      ? { command: process.execPath, args: [process.argv[1], 'run', '--transport', 'stdio'] }
      : { command: 'node', args: [path.join(findProjectRoot(), 'dist', 'index.js'), 'run', '--transport', 'stdio'] };

    if (llm === 'claude') {
      try {
        run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
      } catch { /* not registered */ }

      // Build the claude MCP command from the actual mcpConfig structure.
      // All args are quoted and joined so paths with spaces (e.g. Windows "Program Files") work.
      const quotedArgs = mcpConfig.args.map((a: string) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
      const cmd = `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}" ${quotedArgs}`;
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
      // Dev/npm mode: prefer apra-pm local copy, fall back to dist/
      const root = findProjectRoot();
      const vendorPm = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'skills', 'pm');
      const pmSrc = fs.existsSync(vendorPm) ? vendorPm : path.join(root, 'dist', 'skills', 'pm');
      copyDirSync(pmSrc, paths.skillsDir);
    }
  }

  // --- Step 8: cost.js extraction + auto-sprint workflow copy (PM only) ---
  if (installPm) {
    console.log(`  [8/${totalSteps}] Installing PM cost functions + workflow...`);

    // Locate auto-sprint.js source
    let workflowContent: string | null = null;
    if (isSea()) {
      try { workflowContent = extractAsset('auto-sprint.js'); } catch { /* absent in older SEA build */ }
    } else {
      const root = findProjectRoot();
      const wfPath = path.join(root, 'vendor', 'apra-pm', '.claude', 'workflows', 'auto-sprint.js');
      const wfFallback = path.join(root, 'dist', 'workflows', 'auto-sprint.js');
      const wfSrc = fs.existsSync(wfPath) ? wfPath : fs.existsSync(wfFallback) ? wfFallback : null;
      if (wfSrc) workflowContent = fs.readFileSync(wfSrc, 'utf-8');
    }

    if (workflowContent) {
      // Extract PURE_FUNCTIONS_BEGIN/END block and write cost.js to skill dir
      const blockStart  = workflowContent.indexOf('// PURE_FUNCTIONS_BEGIN');
      const blockEndIdx = workflowContent.indexOf('// PURE_FUNCTIONS_END');
      const blockEnd    = blockEndIdx >= 0 ? blockEndIdx + '// PURE_FUNCTIONS_END'.length : -1;
      if (blockStart >= 0 && blockEnd > blockStart) {
        const block = workflowContent.slice(blockStart, blockEnd);
        const costJs = [
          '// Auto-generated by apra-fleet install -- do not edit directly.',
          '// Source: apra-pm/.claude/workflows/auto-sprint.js (PURE_FUNCTIONS_BEGIN..END block)',
          '',
          block,
          '',
          "if (typeof module !== 'undefined') {",
          '  module.exports = {',
          '    DEFAULT_CALIBRATION,',
          '    computeSprintQuote,',
          '    computeSprintAnalysis,',
          '    accumulateBucketTokens,',
          '    computeUpdatedCalibration,',
          '    buildSprintSummary,',
          '    buildExecutionSummary,',
          '    reviewerModelFor,',
          '  };',
          '}',
        ].join('\n');
        writeAssetFile(path.join(paths.skillsDir, 'cost.js'), costJs);
      } else {
        console.warn('  [!] PURE_FUNCTIONS_BEGIN/END markers not found -- cost.js not written');
      }

      // Claude only: copy full auto-sprint.js to ~/.claude/workflows/
      if (llm === 'claude') {
        const wfDest = path.join(os.homedir(), '.claude', 'workflows', 'auto-sprint.js');
        fs.mkdirSync(path.dirname(wfDest), { recursive: true });
        writeAssetFile(wfDest, workflowContent);
      }
    } else {
      console.warn('  [!] auto-sprint.js not found -- cost.js and workflow not written');
    }

    // Claude only: install the auto-sprint-args helper skill (args contract for
    // the auto-sprint workflow) into <configDir>/skills/auto-sprint-args -- mirrors
    // apra-pm's own install.mjs semantics.
    if (llm === 'claude') {
      const argsSkillDest = path.join(paths.configDir, 'skills', AUTO_SPRINT_ARGS_SKILL_NAME);
      const argsSkillEntries = isSea()
        ? Object.entries(manifest.autoSprintArgsSkill ?? {}).map(([relPath, assetKey]) => ({
            relPath,
            content: extractAsset(assetKey),
          }))
        : (() => {
            const root = findProjectRoot();
            const vendorArgsSkill = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', '.claude', 'skills', AUTO_SPRINT_ARGS_SKILL_NAME);
            const distArgsSkill = path.join(root, 'dist', 'skills', AUTO_SPRINT_ARGS_SKILL_NAME);
            const argsSkillSrc = fs.existsSync(vendorArgsSkill) ? vendorArgsSkill : distArgsSkill;
            const argsSkillBase = fs.existsSync(vendorArgsSkill)
              ? `packages/apra-fleet-se/apra-pm/.claude/skills/${AUTO_SPRINT_ARGS_SKILL_NAME}`
              : `dist/skills/${AUTO_SPRINT_ARGS_SKILL_NAME}`;
            const collected = collectFilesRec(argsSkillSrc, argsSkillBase, argsSkillBase);
            return Object.entries(collected).map(([relPath, rootRelativeLabel]) => ({
              relPath,
              content: fs.readFileSync(path.join(root, rootRelativeLabel), 'utf-8'),
            }));
          })();

      if (argsSkillEntries.length > 0) {
        clearDirSync(argsSkillDest);
        for (const { relPath, content } of argsSkillEntries) {
          writeAssetFile(path.join(argsSkillDest, relPath), content);
        }
      } else {
        console.warn(`  [!] ${AUTO_SPRINT_ARGS_SKILL_NAME} skill source not found -- skill not installed`);
      }
    }
  }

  if (!installFleet && !installPm) {
    console.log(`  Skipping skills (use --skill all to install, or omit --skill for default)`);
  }

  // --- Agent install step (only when agentsDir is defined and PM is installed) ---
  if (installAgents) {
    const agentStep = (installFleet && installPm) ? 9 : installPm ? 9 : 7;
    console.log(`  [${agentStep}/${totalSteps}] Installing PM agents...`);
    const agentsDestDir = paths.agentsDir!;
    fs.mkdirSync(agentsDestDir, { recursive: true });
    // #336's loadAgentAssets() unifies SEA and dev-mode sourcing; its
    // dev-mode path reads packages/apra-fleet-se/apra-pm/agents directly (dist/agents only
    // as a fallback), preserving this branch's no-dist/agents rule, and it
    // recurses into _shared/ and schemas/ which the old flat readdir missed.
    for (const { relPath, content: rawContent } of loadAgentAssets()) {
      const content = llm === 'opencode' ? transformAgentForOpenCode(rawContent, relPath) : llm === 'agy' ? transformAgentForAgy(rawContent, relPath) : rawContent;
      writeAssetFile(path.join(agentsDestDir, relPath), content);
    }
  }

  // --- Workflow-subsystem install step (optional, --workflows all|none) ---
  // Writes ~/.apra-fleet/{node_modules,schemas,workflows/{auto-sprint,hello-world}}.
  // See docs/workflow-subsystem-plan.md Section 6 / Section 2.1 for the layout.
  if (installWorkflows) {
    // Two steps follow workflows (dolt, then Beads) before the optional service step.
    const workflowsStepNum = serviceStep ? totalSteps - 3 : totalSteps - 2;
    console.log(`  [${workflowsStepNum}/${totalSteps}] Installing workflow runtime...`);
    // Extraction itself (node_modules / schemas / built-in workflows / .installed.json)
    // lives in workflow-assets.ts -- the SAME code path workflow.ts's self-heal
    // launcher path uses on-demand (apra-fleet-7pm.8).
    extractWorkflowSubsystemAssets({
      manifest,
      extractAssetBuffer,
      version: serverVersion,
    });
  }

  // --- Dolt CLI install step (apra-fleet-ire.3) ---
  // Portable dolt binary, downloaded straight into BIN_DIR (never system PATH).
  // Mirrors the Beads install step immediately below: already-installed check
  // first, download+extract+verify otherwise. NON-FATAL, same as Beads -- a
  // missing/broken dolt must never fail "apra-fleet install".
  const doltStep = serviceStep ? totalSteps - 2 : totalSteps - 1;
  console.log(`  [${doltStep}/${totalSteps}] Installing Dolt CLI...`);
  let doltVersion = 'not available';
  if (doltStepEnabled()) {
    try {
      const doltBinaryName = process.platform === 'win32' ? 'dolt.exe' : 'dolt';
      const doltPath = path.join(BIN_DIR, doltBinaryName);
      let installed = false;
      // Check if already installed
      if (fs.existsSync(doltPath)) {
        try {
          const result = await doltStepDeps.verifyDolt(doltPath);
          doltVersion = result.version;
          installed = true;
        } catch {
          // existing binary is broken/unusable -- fall through and (re)download
        }
      }
      if (!installed) {
        // not installed (or broken) -- download and verify it
        const extractedPath = await doltStepDeps.downloadAndExtractDolt(BIN_DIR);
        const result = await doltStepDeps.verifyDolt(extractedPath);
        doltVersion = result.version;
      }
    } catch (err) {
      // non-fatal: warn but don't fail the install
      console.warn(`  Dolt install skipped -- ${(err as Error).message}`);
    }
  }

  // --- Beads install step ---
  // shell:true required on Windows — npm global packages install as .cmd wrappers
  // that cannot be directly spawned by Node without a shell
  const beadsStep = serviceStep ? totalSteps - 1 : totalSteps;
  console.log(`  [${beadsStep}/${totalSteps}] Installing Beads task tracker...`);
  try {
    // Check if already installed
    try {
      execFileSync('bd', ['--version'], { stdio: 'pipe', shell: true });
      // already installed — skip
    } catch {
      // not installed — install it
      execFileSync('npm', ['install', '-g', '@beads/bd@1.0.4'], { stdio: 'inherit', shell: true });
    }
  } catch (err) {
    // non-fatal: warn but don't fail the install
    console.warn('  ⚠ Beads install skipped — npm not available or install failed');
  }

  // OpenCode uses --dangerously-skip-permissions and per-agent permission: frontmatter;
  // a top-level "permissions" key is invalid in opencode.json
  if (llm !== 'opencode') {
    const extraPerms = (llm === 'claude' && installPm)
      ? ['Bash(*)', 'Skill(auto-sprint)', 'Workflow(auto-sprint)']
      : [];
    mergePermissions(paths, extraPerms);
  }

  // Write install-config.json (merge provider entry)
  writeInstallConfig(llm, skillMode, workflowsMode);

  // --- Step N: Register and start service (SEA + HTTP mode only) ---
  let serviceRegistered = false;
  if (serviceStep) {
    console.log(`  [${totalSteps}/${totalSteps}] Registering and starting service...`);
    const svcMgr = await getServiceManager();
    try {
      await svcMgr.register(binaryPath, ['--transport', 'http'], LOG_FILE_PATH);
      try {
        await svcMgr.start();
        serviceRegistered = true;
      } catch (startErr) {
        try { await svcMgr.unregister(); } catch {}
        throw startErr;
      }
    } catch (err) {
      console.warn(`    Service registration skipped: ${(err as Error).message}`);
    }
  }

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
  const serviceLine = serviceStep ? `\n  Service:     ${serviceRegistered ? 'registered and running' : 'registration skipped'}` : '';
  console.log(`
Apra Fleet ${serverVersion} installed successfully for ${paths.name}.
  Binary:      ${BIN_DIR}
  Hooks:       ${HOOKS_DIR}
  Scripts:     ${SCRIPTS_DIR}
  Settings:    ${paths.settingsFile}${installFleet ? `\n  Fleet Skill: ${paths.fleetSkillsDir}` : ''}${installPm ? `\n  PM Skill:    ${paths.skillsDir}` : ''}${installAgents ? `\n  Agents:      ${paths.agentsDir}` : ''}
  Beads:       ${beadsVersion}
  Dolt:        ${doltVersion}${serviceLine}

${instructions}${forceNote}
`);

  if (llm === 'claude' && installPm) {
    console.log('  /auto-sprint BD-1              (native workflow, current branch)');
    console.log('  /auto-sprint BD-1 BD-2         (multiple sprint goals)');
    console.log('  /pm                            (provider-agnostic skill, fleet-ready)');
    console.log('');
  }
}
