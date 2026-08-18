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
import { FLEET_DIR } from '../paths.js';
import { extractWorkflowSubsystemAssets } from './workflow-assets.js';
import { downloadAndExtractDolt, verifyDolt } from './dolt-install.js';
import { classifyRunningServer, getInstallDataDir } from './install-guard.js';
import { getOrCreateKey } from '../services/jwt.js';

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
  // getAsset returns ArrayBuffer - decode to string
  return new TextDecoder().decode(buf);
}

function getSeaAssetBuffer(key: string): Buffer {
  const sea = require('node:sea');
  return Buffer.from(sea.getAsset(key));
}

// Claude-only helper skill packaged alongside apra-pm's auto-sprint workflow --
// installed into <configDir>/skills/auto-sprint-args, mirrors apra-pm/install.mjs.
const AUTO_SPRINT_ARGS_SKILL_NAME = 'auto-sprint-args';

// Helper skill for the fleet-sprint workflow (`apra-fleet workflow
// fleet-sprint`), shipped inside the fleet-sprint package itself. NOT provider-
// specific: installed into <configDir>/skills/fleet-sprint-cli for every LLM
// provider (every provider's config layout is <configDir>/skills/<name>, same
// as the pm and fleet skills).
const FLEET_SPRINT_CLI_SKILL_NAME = 'fleet-sprint-cli';
const FLEET_SPRINT_CLI_SKILL_VENDOR_BASE =
  'packages/apra-fleet-se/fleet-sprint/skills/fleet-sprint-cli';

// Helper skill for driving fleet-sprints via the supervisor HTTP API
// (start/check/kill), as opposed to FLEET_SPRINT_CLI_SKILL_NAME above (direct
// CLI invocation). Ships alongside it, same provider-agnostic rationale.
const FLEET_SUPERVISOR_SKILL_NAME = 'fleet-supervisor';
const FLEET_SUPERVISOR_SKILL_VENDOR_BASE =
  'packages/apra-fleet-se/fleet-sprint/skills/fleet-supervisor';

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
  // Optional for the same additive-only reason: older manifests (built before
  // the fleet-sprint rename) simply omit it and the install step skips.
  fleetSprintCliSkill?: Record<string, string>;
  // Optional for the same additive-only reason: older manifests (built before
  // this skill existed) simply omit it and the install step skips.
  fleetSupervisorSkill?: Record<string, string>;
}

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find project root - works for both tsc (dist/cli/install.js) and esbuild (dist/sea-bundle.cjs)
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'version.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find project root (version.json not found)');
}

// Collect files recursively - used by dev-mode manifest generation
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

/**
 * Resolve a runtime dependency's package directory by walking the node_modules
 * chain upward from `root`, the way Node's own resolver does.
 *
 * Why this exists: gen-sea-config.mjs (the SEA parity source) can assume every
 * runtime dep sits at `root/node_modules/<pkg>` because it always runs from the
 * git/workspace checkout, where nothing is hoisted above the repo root. But
 * buildDevManifest() also runs at `apra-fleet install` time inside a REAL
 * npm-installed tree, where `root` is `node_modules/@apralabs/apra-fleet` and
 * npm HOISTS shared deps (ajv, undici, fast-uri, ...) up to a PARENT
 * node_modules. A fixed `root/node_modules/<pkg>` probe misses every hoisted
 * dep there, so the whole workflow-runtime section fails its existsSync gate and
 * silently drops out -- leaving `apra-fleet workflow fleet-sprint` dead with no
 * error (the exact class of failure tests/install-dev-manifest.test.ts guards).
 * Walking up the chain resolves the dep wherever npm actually placed it; in a
 * dev checkout the first candidate (`root/node_modules/<pkg>`) still wins, so
 * the manifest is byte-identical there. Returns null when the dep is nowhere on
 * the chain.
 */
function resolveNodeModulesDir(root: string, pkg: string): string | null {
  let dir = root;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkg);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

// Runtime deps of the workflow subsystem that live under node_modules (as
// opposed to the first-party packages/ trees). Each tuple is [package name on
// disk, manifest prefix]; the two coincide today but are kept explicit to
// mirror gen-sea-config.mjs's collectPackageTree(..., '<prefix>') calls exactly.
const WORKFLOW_RUNTIME_NODE_MODULES_DEPS: ReadonlyArray<readonly [string, string]> = [
  ['ajv', 'ajv'],
  ['fast-deep-equal', 'fast-deep-equal'],
  ['fast-uri', 'fast-uri'],
  ['json-schema-traverse', 'json-schema-traverse'],
  ['require-from-string', 'require-from-string'],
  // undici is a direct runtime dependency of apra-fleet-client's transport
  // (packages/apra-fleet-client/src/client/transport.mjs). undici-types is a
  // types-only peer dependency (no runtime require of it in undici's lib), so
  // it is intentionally not bundled here.
  ['undici', 'undici'],
];

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

// Exported for tests: the dev-mode manifest is what gates the entire workflow
// subsystem install, and its inputs are filesystem paths that can silently go
// stale when directories move (see agentSchemasDir below).
export function buildDevManifest(root: string): AssetManifest {
  const hooks: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(root, 'hooks'))) {
    hooks[entry] = `hooks/${entry}`;
  }
  const scripts: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(root, 'scripts'), { withFileTypes: true })) {
    if (!entry.isFile()) continue; // skip subdirectories (e.g. agent-doc-partials/)
    if (entry.name.endsWith('.mjs')) continue; // skip build scripts
    scripts[entry.name] = `scripts/${entry.name}`;
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

  // fleet-sprint-cli helper skill (ships inside the fleet-sprint package;
  // documents the `apra-fleet workflow fleet-sprint` CLI flag contract).
  // Provider-agnostic -- installed for every LLM provider.
  const vendorCliSkill = path.join(root, ...FLEET_SPRINT_CLI_SKILL_VENDOR_BASE.split('/'));
  const distCliSkill = path.join(root, 'dist', 'skills', FLEET_SPRINT_CLI_SKILL_NAME);
  const cliSkillDir = fs.existsSync(vendorCliSkill) ? vendorCliSkill : distCliSkill;
  const cliSkillBase = fs.existsSync(vendorCliSkill)
    ? FLEET_SPRINT_CLI_SKILL_VENDOR_BASE
    : `dist/skills/${FLEET_SPRINT_CLI_SKILL_NAME}`;
  const fleetSprintCliSkill = collectFilesRec(cliSkillDir, cliSkillBase, cliSkillBase);

  // fleet-supervisor helper skill (ships inside the fleet-sprint package;
  // documents the supervisor HTTP API contract for starting/checking/killing
  // sprints). Provider-agnostic -- installed for every LLM provider.
  const vendorSupervisorSkill = path.join(root, ...FLEET_SUPERVISOR_SKILL_VENDOR_BASE.split('/'));
  const distSupervisorSkill = path.join(root, 'dist', 'skills', FLEET_SUPERVISOR_SKILL_NAME);
  const supervisorSkillDir = fs.existsSync(vendorSupervisorSkill) ? vendorSupervisorSkill : distSupervisorSkill;
  const supervisorSkillBase = fs.existsSync(vendorSupervisorSkill)
    ? FLEET_SUPERVISOR_SKILL_VENDOR_BASE
    : `dist/skills/${FLEET_SUPERVISOR_SKILL_NAME}`;
  const fleetSupervisorSkill = collectFilesRec(supervisorSkillDir, supervisorSkillBase, supervisorSkillBase);

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
  // tree is optional -- an npm global install missing any piece simply omits
  // the section, same as an older SEA manifest built before this epic; the
  // install step warns and skips. The first-party packages/ trees resolve
  // relative to root (shipped inside the tarball by the files allowlist); the
  // node_modules runtime deps resolve via resolveNodeModulesDir() so a real
  // npm-installed tree (which hoists them above root) still finds them.
  const workflowRuntimeDir = path.join(root, 'packages', 'apra-fleet-workflow');
  const clientDir = path.join(root, 'packages', 'apra-fleet-client');
  const resolvedRuntimeDeps = WORKFLOW_RUNTIME_NODE_MODULES_DEPS.map(
    ([pkg, prefix]) => [prefix, resolveNodeModulesDir(root, pkg)] as const
  );
  const allRuntimeDepsResolved = resolvedRuntimeDeps.every(([, dir]) => dir !== null);
  let workflowRuntime: Record<string, string> | undefined;
  if (fs.existsSync(workflowRuntimeDir) && fs.existsSync(clientDir) && allRuntimeDepsResolved) {
    workflowRuntime = {
      ...collectPackageTree(root, workflowRuntimeDir, '@apralabs/apra-fleet-workflow'),
      ...collectPackageTree(root, clientDir, '@apralabs/apra-fleet-client'),
    };
    for (const [prefix, dir] of resolvedRuntimeDeps) {
      Object.assign(workflowRuntime, collectPackageTree(root, dir as string, prefix));
    }
  }

  const agentSchemasDir = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'agents', 'schemas');
  let agentSchemas: Record<string, string> | undefined;
  if (fs.existsSync(agentSchemasDir)) {
    agentSchemas = collectPackageTree(root, agentSchemasDir, 'agentSchemas');
  }

  const fleetSprintDir = path.join(root, 'packages', 'apra-fleet-se');
  const helloWorldDir = path.join(root, 'examples', 'workflows', 'hello-world');
  let builtinWorkflows: Record<string, string> | undefined;
  if (fs.existsSync(fleetSprintDir) || fs.existsSync(helloWorldDir)) {
    builtinWorkflows = {
      ...(fs.existsSync(fleetSprintDir) ? collectPackageTree(root, fleetSprintDir, 'fleet-sprint') : {}),
      ...(fs.existsSync(helloWorldDir) ? collectPackageTree(root, helloWorldDir, 'hello-world') : {}),
    };
  }

  const vf = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf-8'));
  return {
    version: vf.version, hooks, scripts, skills, fleetSkills, agents, workflows,
    workflowRuntime, agentSchemas, builtinWorkflows, autoSprintArgsSkill,
    fleetSprintCliSkill, fleetSupervisorSkill,
  };
}

let _manifestOverride: AssetManifest | null = null;
/** Inject a manifest for tests - avoids SEA asset extraction. Pass null to restore default. */
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

/**
 * Additive overlay copy: copies `src` into `dest` WITHOUT replacing any file the
 * destination already owns. Returns the dest-relative paths that were left alone.
 *
 * Root `skills/pm/` and the vendored apra-fleet-se PM skill both carry `SKILL.md`,
 * `doer-reviewer-loop.md` and `simple-sprint.md`. A clobbering copy lets the retired
 * 4-role root `SKILL.md` silently replace the vendored 8-role one and still report
 * install success, which is why the overlay must never overwrite.
 */
export function overlayDirSync(src: string, dest: string, relBase = ''): string[] {
  const skipped: string[] = [];
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    const rel = relBase ? path.join(relBase, entry.name) : entry.name;
    if (entry.isDirectory()) {
      skipped.push(...overlayDirSync(s, d, rel));
    } else if (fs.existsSync(d)) {
      skipped.push(rel);
    } else {
      fs.copyFileSync(s, d);
    }
  }
  return skipped;
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

function configureStatusline(paths: ProviderInstallConfig, scriptPath: string, llm?: LlmProvider): void {
  const settings = readConfig(paths);
  let command: string;

  if (process.platform === 'win32') {
    if (llm === 'agy') {
      const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
      const bashBin = fs.existsSync(gitBash) ? `"${gitBash}"` : 'bash';
      const formattedScriptPath = scriptPath.replace(/\\/g, '/');
      command = `${bashBin} "${formattedScriptPath}"`;
    } else {
      command = `bash "${scriptPath}"`;
    }
  } else {
    command = scriptPath;
  }

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
    ? {
        type: 'remote',
        url: mcpConfig.url,
        enabled: true,
        // headers carries the rmkb-lky.1 admin bearer (same shape OpenCodeProvider
        // uses for a member's JWT in src/providers/opencode.ts).
        ...(mcpConfig.headers ? { headers: mcpConfig.headers } : {}),
      }
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
    // headers carries the rmkb-lky.1 admin bearer for the HTTP transport; the
    // session sees only the restricted member tool set without it.
    settings.mcp_servers['apra-fleet'] = {
      url: mcpConfig.url,
      ...(mcpConfig.headers ? { headers: mcpConfig.headers } : {}),
    };
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

/** Is `cmd` resolvable on PATH? Used before shelling out to a provider's own
 *  CLI (e.g. `claude`) so a missing binary degrades to a clear warning
 *  instead of install crashing with a raw "Command failed" error. */
function isCommandAvailable(cmd: string): boolean {
  try {
    const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isApraFleetRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq apra-fleet.exe" /NH /FO CSV', { encoding: 'utf-8', stdio: 'pipe' });
      const currentPid = process.pid.toString();
      // Each CSV line: "apra-fleet.exe","<PID>","..." - exclude the current installer process
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

export function killApraFleet(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    // taskkill /F is already forceful -- no softer signal to escalate from,
    // so SIGKILL escalation on Windows just reissues the same command.
    execSync('taskkill /F /IM apra-fleet.exe', { stdio: 'ignore' });
  } else {
    // -x = exact name match
    const cmd = signal === 'SIGKILL' ? 'pkill -9 -x apra-fleet' : 'pkill -x apra-fleet';
    execSync(cmd, { stdio: 'ignore' });
  }
}

// --- install --force termination polling: bounded wait + SIGKILL escalation ---
//
// killApraFleet() above only sends SIGTERM (or the already-forceful Windows
// taskkill /F). A singleton that is mid-request can take longer than a flat
// sleep to exit, which previously produced ETXTBSY on fs.copyFileSync (the
// old apra-fleet binary was still open). waitForApraFleetToStop() polls
// isApraFleetRunning() over a grace window instead of sleeping a fixed
// duration, and escalates to SIGKILL if a non-installer apra-fleet process
// is still alive once that window elapses.
export interface InstallForceTiming {
  pollIntervalMs: number;
  graceMs: number;
  killGraceMs: number;
}
const PROD_INSTALL_FORCE_TIMING: InstallForceTiming = { pollIntervalMs: 200, graceMs: 3000, killGraceMs: 2000 };
// Tests run with NODE_ENV=test (see tests/setup.ts) and don't fake these timers,
// so default to a much shorter window there to keep the suite fast, unless a
// test explicitly overrides via _setInstallForceTimingOverride() to exercise
// the escalation path directly.
const TEST_INSTALL_FORCE_TIMING: InstallForceTiming = { pollIntervalMs: 2, graceMs: 20, killGraceMs: 20 };
let _installForceTimingOverride: InstallForceTiming | null = null;
/** Test-only: override the poll/grace timing used by waitForApraFleetToStop(). Pass null to restore default. */
export function _setInstallForceTimingOverride(t: InstallForceTiming | null): void {
  _installForceTimingOverride = t;
}
function installForceTiming(): InstallForceTiming {
  if (_installForceTimingOverride) return _installForceTimingOverride;
  return process.env.NODE_ENV === 'test' ? TEST_INSTALL_FORCE_TIMING : PROD_INSTALL_FORCE_TIMING;
}

/**
 * Wait for any non-installer apra-fleet process to exit after killApraFleet()
 * sends SIGTERM. Polls isApraFleetRunning() over a grace window; if the
 * process is still alive once the window elapses, escalates to SIGKILL and
 * polls again over a second (shorter) window. Returns as soon as no
 * non-installer apra-fleet process is detected, or once both windows have
 * elapsed -- callers should not assume termination is guaranteed in the
 * latter case (see apra-fleet-l7n.3 for surfacing that failure to the
 * operator instead of asserting success).
 */
export async function waitForApraFleetToStop(): Promise<void> {
  const { pollIntervalMs, graceMs, killGraceMs } = installForceTiming();

  let deadline = Date.now() + graceMs;
  while (isApraFleetRunning() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  if (!isApraFleetRunning()) return;

  // Grace window elapsed and a non-installer apra-fleet process is still alive -- escalate.
  killApraFleet('SIGKILL');
  deadline = Date.now() + killGraceMs;
  while (isApraFleetRunning() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
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

// T3.4 (F9b, D8): copy the repo's committed .fleet/kb-canonical-global.json
// (when present) into the shared global KB data dir
// (~/.apra-fleet/data/knowledge/global/kb-canonical-global.json) so EVERY
// project on this machine can see the platform-level global bible without
// carrying it in its own repo. NON-FATAL on every path: absent source file ->
// skip silently (not an error -- most repos never carry this file); any
// read/copy failure (permissions, disk full, malformed path) -> warn and
// continue. The installer must never fail because of the bible.
function copyGlobalBible(repoCwd: string): void {
  try {
    const srcPath = path.join(repoCwd, '.fleet', 'kb-canonical-global.json');
    if (!fs.existsSync(srcPath)) return;

    const destDir = path.join(FLEET_DIR, 'knowledge', 'global');
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, 'kb-canonical-global.json');
    fs.copyFileSync(srcPath, destPath);
    console.log('    [OK] Global knowledge bible copied to ' + destDir);
  } catch (err) {
    console.warn('    [WARN] Global knowledge bible copy skipped:', err instanceof Error ? err.message : String(err));
  }
}

export async function runInstall(args: string[]): Promise<void> {
  // --help / -h guard - must come first, before any side effects (#142)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`apra-fleet install

Install the apra-fleet binary, hooks, MCP server registration, and skills.

Usage:
  apra-fleet install                   Install binary + hooks + statusline + MCP + fleet & PM skills (default)
  apra-fleet install --skill all       Same as bare install (all skills)
  apra-fleet install --skill fleet     Install fleet skill only
  apra-fleet install --skill pm        Install PM skill (also installs fleet -- PM depends on fleet)
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
                          dispatch -- Gemini does not support background agents, so fleet operations
                          run sequentially rather than in parallel.
  --transport <mode>      MCP transport to use: http (default) or stdio. HTTP uses the singleton
                          fleet server at http://localhost:7523/mcp. stdio runs fleet as a subprocess.
  --skill <mode>          Which skills to install: all (default), fleet, pm, or none.
  --no-skill              Alias for --skill none.
  --workflows <mode>      Which workflow assets to install: all (default) or none. Installs
                          ~/.apra-fleet/node_modules (workflow runtime), /schemas (agent role
                          schemas), and /workflows/{fleet-sprint,hello-world} (built-in workflows).
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
        // --skill with no value - install both (backwards-compat)
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
  totalSteps++; // KB + code intelligence setup -- unconditional, runs after Beads
  if (serviceStep) totalSteps++;

  if (llm === 'gemini' && (installFleet || installPm)) {
    console.warn(`\n- Note: Gemini does not support background agents. If you plan to use Gemini as the\n  PM/orchestrator, fleet operations will run sequentially (no parallel dispatch).\n  For best orchestration performance, consider using Claude. See docs for details.\n`);
  }

  // --- Running-process guard (SEA + npm modes -- dev mode runs via node, not a managed binary) ---
  //
  // isApraFleetRunning() is OS-global on purpose (waitForApraFleetToStop() and
  // uninstall.ts depend on that). It is only the cheap first filter here:
  // classifyRunningServer() then decides whether the running server is actually
  // relevant to THIS install -- recorded live in the target data dir, or running
  // from the install prefix we are about to overwrite (ETXTBSY). An unrelated
  // server (isolated HOME/APRA_FLEET_DATA_DIR/prefix, e.g. ci.yml's clean temp
  // prefix step) no longer blocks the install. See apra-fleet-1aw.
  const runningScope = (isSea() || isNpmGlobalInstall()) && isApraFleetRunning()
    ? classifyRunningServer(BIN_DIR)
    : null;
  if (runningScope && !runningScope.relevant) {
    console.log(`\n  Note: an unrelated apra-fleet server is running -- ${runningScope.detail}.\n  It is not associated with this install (data dir ${getInstallDataDir()}, prefix ${BIN_DIR}), so it is left running.\n`);
  }
  if (runningScope?.relevant) {
    if (!force) {
      const killHint = process.platform === 'win32'
        ? '    taskkill /F /IM apra-fleet.exe'
        : '    pkill -x apra-fleet';
      console.error(`
Error: apra-fleet is currently running. Stop the server before installing.
  (${runningScope.detail})

  Run with --force to stop it automatically:
    apra-fleet install --force

  Or stop it manually:
${killHint}
`);
      process.exit(1);
    }
    killApraFleet();
    await waitForApraFleetToStop();
    if (isApraFleetRunning()) {
      console.error(`
Error: could not stop the running apra-fleet server (it is still running after
SIGTERM and a SIGKILL escalation). Stop it manually before installing:
${process.platform === 'win32' ? '    taskkill /F /IM apra-fleet.exe' : '    pkill -x apra-fleet'}
`);
      process.exit(1);
    }
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
    configureStatusline(paths, statuslineScript, llm);

    const standardModel = PROVIDER_STANDARD_MODELS[llm] ?? PROVIDER_STANDARD_MODELS['claude'];
    writeDefaultModel(paths, standardModel);
  }

  // --- Step 5: Register MCP server ---
  console.log(`  [5/${totalSteps}] Registering MCP server...`);

  const fleetPort = DEFAULT_PORT;
  const fleetUrl = `http://localhost:${fleetPort}/mcp`;

  // rmkb-lky.1: an HTTP MCP session gets the FULL tool surface only when it
  // presents the local signing key (~/.apra-fleet/fleet.key, mode 0o600) as a
  // bearer -- absence of identity now yields the RESTRICTED member scope, never
  // full. This host IS the orchestrator/PM session, so its registration must
  // carry that header or dispatch tools (execute_prompt, compose_permissions,
  // register_member ...) will not be visible to it at all.
  //
  // Failure to read/mint the key is non-fatal: register without the header and
  // say so, rather than aborting the whole install.
  let adminKey: string | null = null;
  if (transport === 'http') {
    try {
      adminKey = getOrCreateKey();
    } catch (err) {
      console.warn(
        `  Warning: could not read or create the fleet signing key (${(err as Error).message}).\n` +
        `  Registering apra-fleet WITHOUT the admin bearer -- this session will see only the\n` +
        `  restricted member tool set. Re-run 'apra-fleet install' once the key is writable.`
      );
    }
  }
  const adminHeaderObject = adminKey ? { headers: { Authorization: `Bearer ${adminKey}` } } : {};

  if (transport === 'http') {
    if (llm === 'claude') {
      const headerArg = adminKey ? ` --header "Authorization: Bearer ${adminKey}"` : '';
      if (!isCommandAvailable('claude')) {
        console.warn(
          `  Warning: the 'claude' CLI was not found on PATH -- skipping MCP server registration.\n` +
          `  Install Claude Code (https://claude.com/claude-code), then re-run 'apra-fleet install'\n` +
          `  to register apra-fleet with it, or register manually with:\n` +
          `    claude mcp add --scope user --transport http apra-fleet ${fleetUrl}${headerArg}`
        );
      } else {
        try {
          run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
        } catch { /* not registered */ }
        run(`claude mcp add --scope user --transport http apra-fleet ${fleetUrl}${headerArg}`);
      }
    } else if (llm === 'gemini') {
      mergeGeminiConfig(paths, { httpUrl: fleetUrl, ...adminHeaderObject });
    } else if (llm === 'codex') {
      mergeCodexConfig(paths, { url: fleetUrl, ...adminHeaderObject });
    } else if (llm === 'copilot') {
      mergeCopilotConfig(paths, { url: fleetUrl, type: 'http', ...adminHeaderObject });
    } else if (llm === 'agy') {
      mergeAgyConfig(paths, { url: fleetUrl, ...adminHeaderObject });
    } else if (llm === 'opencode') {
      mergeOpenCodeConfig(paths, { url: fleetUrl, ...adminHeaderObject });
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
      // Build the claude MCP command from the actual mcpConfig structure.
      // All args are quoted and joined so paths with spaces (e.g. Windows "Program Files") work.
      const quotedArgs = mcpConfig.args.map((a: string) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
      const cmd = `claude mcp add --scope user apra-fleet -- "${mcpConfig.command}" ${quotedArgs}`;
      if (!isCommandAvailable('claude')) {
        console.warn(
          `  Warning: the 'claude' CLI was not found on PATH -- skipping MCP server registration.\n` +
          `  Install Claude Code (https://claude.com/claude-code), then re-run 'apra-fleet install'\n` +
          `  to register apra-fleet with it, or register manually with:\n` +
          `    ${cmd}`
        );
      } else {
        try {
          run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
        } catch { /* not registered */ }
        run(cmd);
      }
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
    console.warn(`\n- Note: PM skill depends on fleet skill - installing fleet skill first.\n`);
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
      // Overlay apra-fleet-owned PM skill additions/overrides from skills/pm/ in repo root
      const root = findProjectRoot();
      const repoSkillsPm = path.join(root, 'skills', 'pm');
      if (fs.existsSync(repoSkillsPm) && fs.readdirSync(repoSkillsPm).length > 0) {
        const skipped = overlayDirSync(repoSkillsPm, paths.skillsDir);
        console.log('    [OK] Overlaid apra-fleet PM skill additions from skills/pm/');
        if (skipped.length > 0) {
          console.log(`    [--] Kept ${skipped.length} vendored PM skill file(s): ${skipped.join(', ')}`);
        }
      }
    } else {
      // Dev/npm mode: prefer apra-pm local copy, fall back to dist/
      const root = findProjectRoot();
      const vendorPm = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'skills', 'pm');
      const pmSrc = fs.existsSync(vendorPm) ? vendorPm : path.join(root, 'dist', 'skills', 'pm');
      copyDirSync(pmSrc, paths.skillsDir);
      // Overlay apra-fleet-owned PM skill additions/overrides from skills/pm/ in repo root
      const repoSkillsPm = path.join(root, 'skills', 'pm');
      if (fs.existsSync(repoSkillsPm) && fs.readdirSync(repoSkillsPm).length > 0) {
        const skipped = overlayDirSync(repoSkillsPm, paths.skillsDir);
        console.log('    [OK] Overlaid apra-fleet PM skill additions from skills/pm/');
        if (skipped.length > 0) {
          console.log(`    [--] Kept ${skipped.length} vendored PM skill file(s): ${skipped.join(', ')}`);
        }
      }
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
      const wfPath = path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', '.claude', 'workflows', 'auto-sprint.js');
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

  // --- fleet-sprint-cli helper skill (all providers) ---
  // Documents the `apra-fleet workflow fleet-sprint` CLI contract for any LLM
  // driving apra-fleet. Deliberately NOT gated on provider (every provider gets
  // it) and NOT gated on installPm (fleet-sprint ships independently of the PM
  // skill) -- only on "skills are being installed at all".
  if (installFleet || installPm) {
    const cliSkillDest = path.join(paths.configDir, 'skills', FLEET_SPRINT_CLI_SKILL_NAME);
    const cliSkillEntries = isSea()
      ? Object.entries(manifest.fleetSprintCliSkill ?? {}).map(([relPath, assetKey]) => ({
          relPath,
          content: extractAsset(assetKey),
        }))
      : (() => {
          const root = findProjectRoot();
          const vendorCliSkill = path.join(root, ...FLEET_SPRINT_CLI_SKILL_VENDOR_BASE.split('/'));
          const distCliSkill = path.join(root, 'dist', 'skills', FLEET_SPRINT_CLI_SKILL_NAME);
          const cliSkillSrc = fs.existsSync(vendorCliSkill) ? vendorCliSkill : distCliSkill;
          const cliSkillBase = fs.existsSync(vendorCliSkill)
            ? FLEET_SPRINT_CLI_SKILL_VENDOR_BASE
            : `dist/skills/${FLEET_SPRINT_CLI_SKILL_NAME}`;
          const collected = collectFilesRec(cliSkillSrc, cliSkillBase, cliSkillBase);
          return Object.entries(collected).map(([relPath, rootRelativeLabel]) => ({
            relPath,
            content: fs.readFileSync(path.join(root, rootRelativeLabel), 'utf-8'),
          }));
        })();

    if (cliSkillEntries.length > 0) {
      clearDirSync(cliSkillDest);
      for (const { relPath, content } of cliSkillEntries) {
        writeAssetFile(path.join(cliSkillDest, relPath), content);
      }
    } else {
      console.warn(`  [!] ${FLEET_SPRINT_CLI_SKILL_NAME} skill source not found -- skill not installed`);
    }
  }

  // --- fleet-supervisor helper skill (all providers) ---
  // Documents the supervisor HTTP API contract for starting/checking/killing
  // sprints. Same gating as fleet-sprint-cli above.
  if (installFleet || installPm) {
    const supervisorSkillDest = path.join(paths.configDir, 'skills', FLEET_SUPERVISOR_SKILL_NAME);
    const supervisorSkillEntries = isSea()
      ? Object.entries(manifest.fleetSupervisorSkill ?? {}).map(([relPath, assetKey]) => ({
          relPath,
          content: extractAsset(assetKey),
        }))
      : (() => {
          const root = findProjectRoot();
          const vendorSupervisorSkill = path.join(root, ...FLEET_SUPERVISOR_SKILL_VENDOR_BASE.split('/'));
          const distSupervisorSkill = path.join(root, 'dist', 'skills', FLEET_SUPERVISOR_SKILL_NAME);
          const supervisorSkillSrc = fs.existsSync(vendorSupervisorSkill) ? vendorSupervisorSkill : distSupervisorSkill;
          const supervisorSkillBase = fs.existsSync(vendorSupervisorSkill)
            ? FLEET_SUPERVISOR_SKILL_VENDOR_BASE
            : `dist/skills/${FLEET_SUPERVISOR_SKILL_NAME}`;
          const collected = collectFilesRec(supervisorSkillSrc, supervisorSkillBase, supervisorSkillBase);
          return Object.entries(collected).map(([relPath, rootRelativeLabel]) => ({
            relPath,
            content: fs.readFileSync(path.join(root, rootRelativeLabel), 'utf-8'),
          }));
        })();

    if (supervisorSkillEntries.length > 0) {
      clearDirSync(supervisorSkillDest);
      for (const { relPath, content } of supervisorSkillEntries) {
        writeAssetFile(path.join(supervisorSkillDest, relPath), content);
      }
    } else {
      console.warn(`  [!] ${FLEET_SUPERVISOR_SKILL_NAME} skill source not found -- skill not installed`);
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
      const content = llm === 'opencode'
        ? transformAgentForOpenCode(rawContent, relPath)
        : llm === 'agy'
        ? transformAgentForAgy(rawContent, relPath)
        : rawContent;
      writeAssetFile(path.join(agentsDestDir, relPath), content);
    }
  }

  // --- Workflow-subsystem install step (optional, --workflows all|none) ---
  // Writes ~/.apra-fleet/{node_modules,schemas,workflows/{fleet-sprint,hello-world}}.
  // See docs/workflow-subsystem-plan.md Section 6 / Section 2.1 for the layout.
  if (installWorkflows) {
    // Two steps follow workflows (dolt, then Beads) before the optional service step.
    const workflowsStepNum = serviceStep ? totalSteps - 4 : totalSteps - 3;
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
  const doltStep = serviceStep ? totalSteps - 3 : totalSteps - 2;
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
  // shell:true required on Windows - npm global packages install as .cmd wrappers
  // that cannot be directly spawned by Node without a shell
  // KB + code intelligence is the final step (before the optional service step),
  // so Beads sits one slot earlier than it does on main.
  const beadsStep = serviceStep ? totalSteps - 2 : totalSteps - 1;
  console.log(`  [${beadsStep}/${totalSteps}] Installing Beads task tracker...`);
  try {
    // Check if already installed
    try {
      execFileSync('bd', ['--version'], { stdio: 'pipe', shell: true });
      // already installed - skip
    } catch {
      // not installed - install it
      execFileSync('npm', ['install', '-g', '@beads/bd@1.1.2'], { stdio: 'inherit', shell: true });
    }
  } catch (err) {
    // non-fatal: warn but don't fail the install
    console.warn('  - Beads install skipped - npm not available or install failed');
  }

  // --- KB + code intelligence setup step ---
  // Only runs when the installer is invoked from inside a git repository.
  const kbStep = serviceStep ? totalSteps - 1 : totalSteps;
  console.log(`  [${kbStep}/${totalSteps}] Setting up Knowledge Bank and code intelligence...`);
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

  // T3.4 (F9b, D8): distribute the committed global bible (if this repo
  // carries one) to every project on the machine via the shared global KB
  // data dir. Independent of the .git check above -- the source file's own
  // presence is the only gate, and the step is fully non-fatal.
  copyGlobalBible(repoCwd);

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
