import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { serverVersion } from '../version.js';
import type { LlmProvider } from '../types.js';
import { DEFAULT_PORT, DEFAULT_HOST, LOG_FILE_PATH } from '../paths.js';
import { getServiceManager } from '../services/service-manager/index.js';
import { registerSupervisorService } from '../services/supervisor-service.js';
import { seedSupervisorProjectDir, validateProjectDirPreflight, seedSupervisorToolchain } from './supervisor.js';
import type { ServiceManager } from '../services/service-manager/types.js';
import { LINUX_UNIT_NAME, MACOS_PLIST_LABEL, WINDOWS_TASK_NAME } from '../services/service-manager/types.js';
import {
  BIN_DIR,
  HOOKS_DIR,
  SCRIPTS_DIR,
  getProviderInstallConfig,
  readConfig,
  writeConfig,
  writeInstallConfig,
  PROVIDER_STANDARD_MODELS,
  INSTALLABLE_LLM_PROVIDERS,
  ProviderInstallConfig
} from './config.js';
import { transformAgentForOpenCode, transformAgentForAgy, transformAgentForClaude } from './agent-transform.js';
import { FLEET_DIR } from '../paths.js';
import { extractWorkflowSubsystemAssets } from './workflow-assets.js';
import { downloadAndExtractDolt, verifyDolt } from './dolt-install.js';
import { BEADS_PACKAGE } from './beads-pin.js';
import { installBeads, type BeadsInstallDeps, type BeadsInstallResult } from './beads-install.js';
import {
  classifyRunningServer, relevantServerPids, getInstallDataDir, memberForceMayStop, fullInstallRefusalText,
  writeMemberInstallMarker, clearMemberInstallMarker, FORCE_STOP_FULL_INSTALL_FLAG,
} from './install-guard.js';
import { getOrCreateKey, fleetKeyPath } from '../services/jwt.js';
import { detectFleetSePrereqs, resolveFleetSeToolchainPaths, MIN_NODE_VERSION, FLEET_SE_PREREQ_FIX_LINE, type FleetSePrereqResult } from './fleet-se-prereqs.js';
import { convertClaudeAllowToAgyPermissions, formatAgyPermissionRules } from '../providers/agy.js';

// --- fleet-se prerequisite gate: injectable deps + explicit test-mode gate ---
//
// Mirrors the dolt CLI install step's pattern immediately below (same
// rationale): detectFleetSePrereqs() spawns real `node --version` / `npm
// --version` child processes, which is fast and safe in production but would
// spuriously fail under every existing unit test that mocks node:child_process
// without also stubbing those two calls (an automocked execFileSync returns
// undefined, which looks like "prerequisite absent"). So:
// 1. Dependency injection: fleetSePrereqStepDeps.detectFleetSePrereqs defaults
//    to the real implementation but can be swapped for a fake in tests.
// 2. Explicit gate: in NODE_ENV=test (set globally by tests/setup.ts), the
//    check is skipped (prerequisites assumed satisfied) UNLESS
//    APRA_FLEET_ENABLE_FLEET_SE_PREREQ_CHECK=1 is also set -- an explicit,
//    opt-in escape hatch for tests that specifically want to exercise this
//    gate (and are expected to inject a fake detector via
//    _setFleetSePrereqStepDeps when they do).
export interface FleetSePrereqStepDeps {
  detectFleetSePrereqs: typeof detectFleetSePrereqs;
}
const realFleetSePrereqStepDeps: FleetSePrereqStepDeps = { detectFleetSePrereqs };
let fleetSePrereqStepDeps: FleetSePrereqStepDeps = realFleetSePrereqStepDeps;
/** Test-only: inject a fake detector for the fleet-se prerequisite gate. */
export function _setFleetSePrereqStepDeps(overrides: Partial<FleetSePrereqStepDeps>): void {
  fleetSePrereqStepDeps = { ...realFleetSePrereqStepDeps, ...overrides };
}
/** Test-only: restore the real (non-mocked) fleet-se prerequisite gate deps. */
export function _resetFleetSePrereqStepDeps(): void {
  fleetSePrereqStepDeps = realFleetSePrereqStepDeps;
}

function fleetSePrereqCheckEnabled(): boolean {
  if (process.env.NODE_ENV !== 'test') return true;
  return process.env.APRA_FLEET_ENABLE_FLEET_SE_PREREQ_CHECK === '1';
}

// --- fleet-se toolchain-seed step: injectable deps + explicit test-mode gate ---
//
// apra-fleet-i9ag.19.2: mirrors the fleet-se prerequisite gate immediately
// above (same rationale). resolveFleetSeToolchainPaths() spawns real `node -p
// process.execPath` / bd-lookup child processes, which is fast and safe in
// production but would spuriously resolve to garbage (or collide with an
// unrelated execFileSync mock, e.g. one that answers every call the same way
// regardless of the command spawned) under the many existing unit tests that
// exercise runInstall() without caring about this step at all. So:
// 1. Dependency injection: fleetSeToolchainStepDeps.resolveFleetSeToolchainPaths
//    defaults to the real implementation but can be swapped for a fake.
// 2. Explicit gate: in NODE_ENV=test, the whole step is skipped UNLESS
//    APRA_FLEET_ENABLE_FLEET_SE_TOOLCHAIN_SEED=1 is also set -- an explicit,
//    opt-in escape hatch for tests that specifically want to exercise it.
export interface FleetSeToolchainStepDeps {
  resolveFleetSeToolchainPaths: typeof resolveFleetSeToolchainPaths;
}
const realFleetSeToolchainStepDeps: FleetSeToolchainStepDeps = { resolveFleetSeToolchainPaths };
let fleetSeToolchainStepDeps: FleetSeToolchainStepDeps = realFleetSeToolchainStepDeps;
/** Test-only: inject a fake resolver for the fleet-se toolchain-seed step. */
export function _setFleetSeToolchainStepDeps(overrides: Partial<FleetSeToolchainStepDeps>): void {
  fleetSeToolchainStepDeps = { ...realFleetSeToolchainStepDeps, ...overrides };
}
/** Test-only: restore the real (non-mocked) fleet-se toolchain-seed step deps. */
export function _resetFleetSeToolchainStepDeps(): void {
  fleetSeToolchainStepDeps = realFleetSeToolchainStepDeps;
}
function fleetSeToolchainStepEnabled(): boolean {
  if (process.env.NODE_ENV !== 'test') return true;
  return process.env.APRA_FLEET_ENABLE_FLEET_SE_TOOLCHAIN_SEED === '1';
}

/**
 * The bd the supervisor records is the one the Beads step ACTUALLY left
 * runnable (KB #605 vs v0.5 #561 recorded bdPath, resolved per the merge
 * ruling): a bd that resolves on PATH (pre-existing or npm -g) keeps the PATH
 * lookup's result; a bd the Beads step placed in, or found only in, BIN_DIR
 * (the user-level install when npm -g is not writable) is recorded as
 * <BIN_DIR>/bd[.exe] -- the NATIVE binary, which the supervisor runs directly
 * (exec-bd.mjs's configured non-shim branch), never via the recorded node.
 * bdPath is per-user (BIN_DIR is under this user's home). Exported for tests.
 */
export function recordedBdFromBeadsStep(
  toolchain: ReturnType<typeof resolveFleetSeToolchainPaths>,
  beadsResult: BeadsInstallResult | null,
): ReturnType<typeof resolveFleetSeToolchainPaths> {
  if (!beadsResult || beadsResult.state === 'missing') return toolchain;
  if (beadsResult.location !== 'bin-dir' || !beadsResult.binPath) return toolchain;
  return {
    ...toolchain,
    bd: {
      path: beadsResult.binPath,
      version: /\d+\.\d+\.\d+/.exec(beadsResult.version)?.[0] ?? null,
      ok: true,
      reason: null,
    },
  };
}

/**
 * Probes whether `bd` is actually RUNNABLE on this machine, returning its
 * reported version string, '' when it runs but prints nothing recognizable,
 * or null when it cannot be run at all.
 *
 * "npm install -g succeeded" and "bd is runnable" are two different facts: the
 * npm global bin directory is routinely absent from PATH under nvm/volta and
 * on Windows. The installer must never report fleet-se "ready" off the first
 * fact alone (apra-fleet-i9ag.13.7.2) -- it probes here, once, and both the
 * Beads step and the final summary use THIS result so the two can never
 * disagree. shell: true because bd resolves through a shim on Windows.
 */
function probeBdVersion(): string | null {
  try {
    const out = execFileSync('bd', ['--version'], { stdio: 'pipe', encoding: 'utf-8', shell: true });
    return out === undefined || out === null ? '' : String(out).trim();
  } catch {
    return null;
  }
}

/**
 * Renders the bd part of the installer's `fleet-se: ready (...)` summary line,
 * which prefixes it with a literal `bd `.
 *
 * probeBdVersion() above returns the RAW `bd --version` output, and bd names
 * itself there ('bd version 1.3.0 (f45b249c)'), so interpolating it after that
 * literal rendered 'bd bd version 1.3.0 (f45b249c)' -- found by the fresh-install
 * smoke for apra-fleet-i9ag.13. Stripping ONE leading 'bd ' keeps the line to a
 * single program name whatever bd's own wording is, rather than pattern-matching
 * bd's current version format. The non-version fallback summaries ('installed',
 * 'not available') carry no such prefix and pass through untouched, so they still
 * read as 'bd installed' / 'bd not available'.
 *
 * Exported for direct unit testing -- the doubling was only ever observable in
 * the fully-composed summary string.
 */
export function formatFleetSeBdPart(beadsSummary: string): string {
  return beadsSummary.replace(/^bd\s+/, '');
}

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

/** Real transports for the Beads step (execFileSync is mocked by the install tests). */
function beadsStepDeps(): BeadsInstallDeps {
  return {
    platform: process.platform,
    exec: (cmd, args, opts) => execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf-8', shell: opts.shell }) as unknown as string,
    existsSync: p => fs.existsSync(p),
    mkdirSync: p => { fs.mkdirSync(p, { recursive: true }); },
    rmSync: p => { fs.rmSync(p, { recursive: true, force: true }); },
    copyFileSync: (src, dest) => fs.copyFileSync(src, dest),
    chmodSync: (p, mode) => fs.chmodSync(p, mode),
  };
}

function doltStepEnabled(): boolean {
  if (process.env.NODE_ENV !== 'test') return true;
  return process.env.APRA_FLEET_ENABLE_DOLT_INSTALL === '1';
}

// Detect SEA mode
let _seaOverride: boolean | null = null;
/** Override isSea() result -- for tests only. Pass null to restore default. */
export function _setSeaOverride(v: boolean | null): void { _seaOverride = v; }

/**
 * After the service step's start: wait until the server answers /health.
 * true = answering, false = not within the timeout, null = not checked
 * (APRA_FLEET_INSTALL_HEALTH_TIMEOUT_MS=0). Injectable for tests.
 */
export type ServiceHealthWait = () => Promise<boolean | null>;
let _serviceHealthWaitOverride: ServiceHealthWait | null = null;
export function _setServiceHealthWaitOverride(fn: ServiceHealthWait | null): void { _serviceHealthWaitOverride = fn; }

async function waitForServiceHealth(): Promise<boolean | null> {
  if (_serviceHealthWaitOverride) return _serviceHealthWaitOverride();
  const raw = parseInt(process.env.APRA_FLEET_INSTALL_HEALTH_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
  if (timeoutMs === 0) return null;
  const { checkRunningInstance } = await import('../services/singleton.js');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await checkRunningInstance()).running) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

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
  // Optional for the same additive-only reason: older manifests (built before
  // the console shell shipped) simply omit it. UNLIKE every other section
  // above, install.ts never extracts this one to disk: src/console/static.ts
  // seaSource() reads 'ui/'-prefixed SEA assets directly via getAsset() at
  // request time (apra-fleet-v6t7.3.1), so the runtime never needs UI files
  // on disk. Present here only so gen-sea-config.mjs's manifest shape and
  // install.ts's AssetManifest type stay in lockstep.
  ui?: Record<string, string>;
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

function writeAssetFile(destPath: string, content: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content);
}

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
    const eventName = claudeName;

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

/** AGY validates every permissions.allow entry against this regex (verbatim
 *  from the agy CLI binary, 1.2.8) and ignores anything that fails it. */
const AGY_RULE_RE = /^(command|read_file|write_file|read_url|mcp|execute_url|unsandboxed)\s*\(.*\)$/;

export function pruneInvalidRules(allow: string[], providerName: string): string[] {
  if (providerName === 'Antigravity') {
    // Self-heal: strip Claude-syntax entries a previous install wrote into
    // AGY's settings.json (mcp__apra-fleet__*, Agent(*), tracker_*, ...). AGY
    // rejects them already, so removing them changes no effective grant -- it
    // only stops fleet from leaving junk in a file the human user also owns.
    return allow.filter(rule => AGY_RULE_RE.test(rule));
  }
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

  let requiredPerms = [...buildRequiredPerms(paths), ...extraPerms];
  if (paths.name === 'Antigravity') {
    // buildRequiredPerms speaks Claude's permission vocabulary. AGY accepts
    // only `action(target)` strings from a fixed action set, so the Read(<dir>)
    // grants are translated to read_file(<dir>) and the tokens with no AGY
    // equivalent (mcp__apra-fleet__*, activate_skill(*), Agent(*), tracker_*)
    // are dropped -- same "no Antigravity equivalent" handling the agent
    // transform already applies to unsupported tools. Writing them verbatim
    // left AGY with an allow-list it discarded wholesale, so every headless
    // dispatch hit the auto-deny wall on its first tool call.
    requiredPerms = formatAgyPermissionRules(convertClaudeAllowToAgyPermissions(requiredPerms));
  }

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

/**
 * PIDs of every apra-fleet process currently running other than this one, as
 * strings.
 *
 * OS-global on purpose -- isApraFleetRunning() is defined in terms of this and
 * is the install guard's cheap first filter and uninstall.ts's running check.
 * It is NOT what install --force stops or watches: that is scoped to
 * relevantServerPids() (install-guard.ts). The current process is always
 * excluded: the installer may itself be named apra-fleet (the fleet's member
 * upgrade runs <home>/.apra-fleet/staging/apra-fleet, and a self-update runs
 * the installed binary).
 */
export function apraFleetPids(): string[] {
  try {
    const currentPid = process.pid.toString();
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq apra-fleet.exe" /NH /FO CSV', { encoding: 'utf-8', stdio: 'pipe' });
      // Each CSV line: "apra-fleet.exe","<PID>","..." - exclude the current installer process
      return out.split('\n')
        .map(line => line.match(/"apra-fleet\.exe","(\d+)"/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map(match => match[1])
        .filter(pid => pid !== currentPid);
    } else {
      // -x = exact name match; the installer itself may be named apra-fleet,
      // so the current PID is excluded.
      const out = execSync('pgrep -x apra-fleet', { encoding: 'utf-8', stdio: 'pipe' });
      return out.split('\n')
        .map(line => line.trim())
        .filter(pid => pid !== '' && pid !== currentPid);
    }
  } catch {
    return [];
  }
}

export function isApraFleetRunning(): boolean {
  return apraFleetPids().length > 0;
}

/**
 * Signal the given apra-fleet pids -- by PID, never by process name. A
 * name-based kill (pkill -x apra-fleet / taskkill /IM apra-fleet.exe) also
 * matches the installer when it is named apra-fleet, which killed the fleet's
 * member upgrade mid-install (exit 143), and every unrelated apra-fleet server
 * of the same user (apra-fleet-b4g.72). This process is never signalled, even
 * when passed in. A pid that already exited is ignored.
 */
export function killApraFleet(pids: ReadonlyArray<number | string>, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  for (const raw of pids) {
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      if (process.platform === 'win32') {
        // taskkill /F is already forceful -- no softer signal to escalate from,
        // so SIGKILL escalation on Windows just reissues the same command.
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      } else {
        process.kill(pid, signal);
      }
    } catch {
      // Already gone (ESRCH / taskkill "not found"): nothing to stop.
    }
  }
}

/** Manual stop advice: the pids still running, plus the by-name fallback. */
function manualStopHint(pids: string[]): string {
  const byName = process.platform === 'win32' ? '    taskkill /F /IM apra-fleet.exe' : '    pkill -x apra-fleet';
  if (pids.length === 0) return byName;
  const byPid = process.platform === 'win32'
    ? pids.map(pid => `    taskkill /F /PID ${pid}`).join('\n')
    : `    kill ${pids.join(' ')}`;
  return `${byPid}\n  or, when no other apra-fleet server of yours must keep running:\n${byName}`;
}

// --- install --force termination polling: bounded wait + SIGKILL escalation ---
//
// killApraFleet() above only sends SIGTERM (or the already-forceful Windows
// taskkill /F). A singleton that is mid-request can take longer than a flat
// sleep to exit, which previously produced ETXTBSY on fs.copyFileSync (the
// old apra-fleet binary was still open). waitForApraFleetToStop() polls the
// pids relevant to this install over a grace window instead of sleeping a
// fixed duration, and escalates to SIGKILL against those still alive once
// that window elapses.
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
 * Wait for the relevant apra-fleet pids (`listPids`, re-evaluated on every
 * poll; never this process) to exit after killApraFleet() sends SIGTERM. If
 * any is still alive once the grace window elapses, escalates to SIGKILL
 * against exactly those and polls again over a second (shorter) window.
 * Returns as soon as none is detected, or once both windows have elapsed --
 * callers should not assume termination is guaranteed in the latter case (see
 * apra-fleet-l7n.3 for surfacing that failure to the operator instead of
 * asserting success).
 */
export async function waitForApraFleetToStop(listPids: () => string[]): Promise<void> {
  const { pollIntervalMs, graceMs, killGraceMs } = installForceTiming();

  let deadline = Date.now() + graceMs;
  let pids = listPids();
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    pids = listPids();
  }

  if (pids.length === 0) return;

  // Grace window elapsed and a relevant apra-fleet process is still alive -- escalate.
  killApraFleet(pids, 'SIGKILL');
  deadline = Date.now() + killGraceMs;
  while (listPids().length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

// --- install --force service-aware stop ---
//
// killApraFleet() signals the server's pid directly. When the server is
// registered with the platform service manager that is a race the installer
// cannot win: the macOS LaunchAgent this installer writes declares
// KeepAlive/SuccessfulExit=false (src/services/service-manager/macos.ts), so
// launchd relaunches the server under a NEW pid the instant a SIGKILL takes it
// down, and the liveness poll below then reports "still running" forever. The
// systemd unit's Restart=on-failure has the same shape. The remedy is to stop
// the SERVICE first: ServiceManager.stop() performs a graceful shutdown that
// exits 0, which neither supervisor restarts.

/**
 * The platform ServiceManager, but only when a service is actually registered.
 * Any failure to determine that (no systemd, unsupported platform, adapter
 * error) is indistinguishable from "nothing registered" for the guard's
 * purposes, so it degrades to the historical kill path rather than throwing.
 */
async function registeredServiceManager(): Promise<ServiceManager | null> {
  try {
    const mgr = await getServiceManager();
    return (await mgr.isInstalled()) ? mgr : null;
  } catch {
    return null;
  }
}

/** Exact command an operator can run to bring the registered service back up. */
export function serviceRestartCommand(): string {
  switch (process.platform) {
    // A stop disables the task (its repeating trigger would undo the stop);
    // apra-fleet start re-enables it before running it.
    case 'win32': return 'apra-fleet start';
    case 'linux': return `systemctl --user start ${LINUX_UNIT_NAME}`;
    case 'darwin': return `launchctl kickstart -k gui/${macosGuiUid()}/${MACOS_PLIST_LABEL}`;
    default: return 'apra-fleet install';
  }
}

/** Exact command an operator can run to take the registered service down. */
export function serviceStopCommand(): string {
  switch (process.platform) {
    // apra-fleet stop disables the task (its repeating trigger would undo a
    // bare /end) and records the stop so nothing restarts the server.
    case 'win32': return 'apra-fleet stop';
    case 'linux': return `systemctl --user stop ${LINUX_UNIT_NAME}`;
    case 'darwin': return `launchctl bootout gui/${macosGuiUid()}/${MACOS_PLIST_LABEL}`;
    default: return 'apra-fleet uninstall';
  }
}

// Resolved in JS, never left to shell expansion: the printed command must be
// copy-pasteable as-is (mirrors getUid() in service-manager/macos.ts).
function macosGuiUid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '501';
}

/**
 * Poll for the server to disappear after ServiceManager.stop(), WITHOUT
 * signalling it -- signalling is exactly what loses the race against a
 * supervisor relaunch. Returns the pids still observed once the window closes
 * (empty when the service is down).
 */
async function waitForServiceStop(listPids: () => string[]): Promise<string[]> {
  const { pollIntervalMs, graceMs } = installForceTiming();
  const deadline = Date.now() + graceMs;
  let pids = listPids();
  while (pids.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    pids = listPids();
  }
  return pids;
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
  apra-fleet install --member          Member install: server + user-mode auto-start only (see below)
  apra-fleet install --force           Stop a running server before installing
  apra-fleet install --llm <provider>  Target LLM provider: claude (default), codex, copilot, agy, opencode
  apra-fleet install --transport http  Register MCP server with HTTP transport (default)
  apra-fleet install --transport stdio Register MCP server with stdio transport (legacy)
  apra-fleet install --project-dir <path>  Seed the fleet-supervisor's project folder before it starts
  apra-fleet install --help            Show this help

Options:
  --llm <provider>        LLM provider to configure. Supported: claude, codex, copilot, agy, opencode.
                          Defaults to claude.
  --transport <mode>      MCP transport to use: http (default) or stdio. HTTP uses the singleton
                          fleet server at http://localhost:7523/mcp. stdio runs fleet as a subprocess.
  --skill <mode>          Which skills to install: all (default), fleet, pm, or none.
  --no-skill              Alias for --skill none.
  --member                Install only the server and its user-mode auto-start. Implies
                          --skill none --workflows none; writes NO user-scope MCP entry,
                          hooks/statusline/permissions settings or ~/.claude/CLAUDE.md block.
                          Fails with E-MEMBER-AUTOSTART if the auto-start cannot be registered.
  --workflows <mode>      Which workflow assets to install: all (default) or none. Installs
                          ~/.apra-fleet/node_modules (workflow runtime), /schemas (agent role
                          schemas), and /workflows/{fleet-sprint,hello-world} (built-in workflows).
                          fleet-se requires Node.js 22.16+ and npm.
  --project-dir <path>    Seed the fleet-supervisor's persisted project folder (the folder whose
                          .beads tracker the supervisor runs against) before the supervisor service
                          is registered and started, so the first boot already resolves the right
                          project instead of the installed engine path. The folder must be one a
                          sprint can actually run in: it must exist, contain an initialised .beads
                          (bd init), have a git 'origin' remote, and have bd's sync.remote set. A
                          folder failing any of those is refused and nothing is written. bd must be
                          on PATH for this check. Omitting this leaves any project folder set
                          earlier (e.g. from the console) untouched; this can also be set later
                          from the console's Projects page or by re-running install with this flag.
  --force                 Stop a running apra-fleet server before installing (SEA mode only).
                          With --member, only a server a previous member install left behind
                          is stopped; anything else is refused (E-FULL-INSTALL-RUNNING).
  --force-stop-full-install
                          With --member --force: also stop a running server that was not started
                          by a member install (e.g. a full install on a shared machine).

Services (SEA + --transport http):
  Two OS services are registered, each with its own unit/task and its own
  start/stop/status reporting: the apra-fleet MCP server, and the fleet-sprint
  supervisor, registered as the binary's own 'apra-fleet supervisor' subcommand
  (needs no separate node on PATH; skipped with --workflows none).`);
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

  const supported = INSTALLABLE_LLM_PROVIDERS;
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
  const forceStopFullInstall = args.includes(FORCE_STOP_FULL_INSTALL_FLAG);

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

  // Parse --project-dir flag (apra-fleet-i9ag.17.4.1): the fleet-supervisor's
  // project folder, seeded into supervisor.config.json before the supervisor
  // service is registered (see the seeding step below). Both spellings,
  // matching every other flag in this file. undefined = option omitted --
  // the seeding step below must then write nothing and touch nothing.
  let projectDirArg: string | undefined;
  const projectDirEqualArg = args.find(a => a.startsWith('--project-dir='));
  if (projectDirEqualArg) {
    projectDirArg = projectDirEqualArg.slice('--project-dir='.length);
  } else {
    const projectDirIdx = args.indexOf('--project-dir');
    if (projectDirIdx >= 0) {
      if (projectDirIdx < args.length - 1) {
        projectDirArg = args[projectDirIdx + 1];
      } else {
        console.error('Error: --project-dir requires a path.');
        process.exit(1);
      }
    }
  }

  // Reject unknown flags to catch typos early
  const memberMode = args.includes('--member');
  if (memberMode) {
    // A member install carries the server only: no skills, no workflows.
    skillMode = 'none';
    workflowsMode = 'none';
  }

  const knownFlagPrefixes = ['--llm=', '--skill=', '--transport=', '--workflows=', '--project-dir='];
  const knownFlagExact = new Set(['--member', '--llm', '--skill', '--no-skill', '--workflows', '--force', FORCE_STOP_FULL_INSTALL_FLAG, '--transport', '--project-dir', '--help', '-h']);
  for (const a of args) {
    if (knownFlagExact.has(a)) continue;
    if (knownFlagPrefixes.some(p => a.startsWith(p))) continue;
    if (!a.startsWith('-')) continue; // non-flag positional (e.g. value token for --skill)
    console.error(`Error: Unknown option "${a}". Run apra-fleet install --help for usage.`);
    process.exit(1);
  }

  // Validate --project-dir EARLY -- before any other install side effect runs
  // (same "fail loudly before a single file is written" philosophy as the
  // fleet-se prerequisite gate below), so an unusable path aborts a fresh
  // install cleanly with nothing written and no existing config disturbed.
  //
  // Only the checks that need NO bd run here (path exists and is a directory,
  // an initialised <dir>/.beads, a git 'origin' remote). The fourth check --
  // bd's sync.remote -- and the config write itself are DEFERRED to just
  // before service registration further down, because bd is something this
  // very install provisions in its Beads step: running the bd check up front
  // made `apra-fleet install --project-dir <clone>` fail on every fresh
  // machine that did not already have bd, for a prerequisite the install was
  // about to satisfy itself (apra-fleet-i9ag.17). Deferring the WRITE with it
  // keeps the never-partially-write guarantee: a path rejected at either
  // point leaves nothing behind.
  //
  // Omitting --project-dir entirely (projectDirArg undefined) calls nothing
  // here or below, leaving today's behaviour -- including any config an
  // operator already set from the console -- byte-identical.
  if (projectDirArg !== undefined) {
    const preflight = validateProjectDirPreflight(projectDirArg);
    if (!preflight.ok) {
      console.error(`Error: --project-dir: ${preflight.error}.`);
      process.exit(1);
    }
  }

  const installFleet = skillMode === 'fleet' || skillMode === 'pm' || skillMode === 'all';
  const installPm = skillMode === 'pm' || skillMode === 'all';
  const installAgents = installPm && paths.agentsDir !== undefined;
  const installWorkflows = workflowsMode === 'all';
  // The Beads (bd) step runs for fleet-se (--workflows all) and for a --member
  // install (KB #605/#618: sprint roles on a member need bd).
  const installBeadsStep = installWorkflows || memberMode;

  // --- fleet-se prerequisite gate (apra-fleet-i9ag.13, apra-fleet-i9ag.12.15) ---
  // fleet-se (fleet-sprint engine, fleet supervisor, bd) requires Node.js
  // 22.16+ and npm by design (owner re-scope recorded on apra-fleet-i9ag.13).
  // This gate runs FIRST -- before the running-process guard stops anything,
  // before the fleet.key mint, and before a single file is written -- so a
  // machine that cannot support fleet-se is left exactly as it was found
  // rather than half-installed. (It used to sit further down, after the key
  // mint, binary copy, hooks and settings had already run.) A missing
  // prerequisite fails loudly here instead of silently skipping bd (the
  // original apra-fleet-i9ag.13.7 defect); `--workflows none` opts out of
  // fleet-se entirely and skips this gate. fleetSePrereqs stays in scope for
  // the final summary line's fleet-se row.
  let fleetSePrereqs: FleetSePrereqResult | null = null;
  if (installWorkflows && fleetSePrereqCheckEnabled()) {
    fleetSePrereqs = fleetSePrereqStepDeps.detectFleetSePrereqs();
    if (!fleetSePrereqs.ok) {
      const reasons: string[] = [];
      if (!fleetSePrereqs.node.present) {
        reasons.push('node: NOT INSTALLED');
      } else if (!fleetSePrereqs.node.satisfiesMin) {
        reasons.push(`node: ${fleetSePrereqs.node.version} (requires ${MIN_NODE_VERSION}+)`);
      }
      if (!fleetSePrereqs.npm.present) {
        reasons.push('npm: NOT INSTALLED');
      }
      console.error(`\nError: fleet-se prerequisite check failed -- ${reasons.join(', ')}\n${FLEET_SE_PREREQ_FIX_LINE}\n`);
      process.exit(1);
    }
  }

  const serviceStep = isSea() && transport === 'http';
  // A member install exists to leave an auto-starting server behind. With no
  // service step (stdio transport or non-SEA install) nothing would register
  // the auto-start, so fail loudly before touching anything.
  if (memberMode && !serviceStep) {
    const why = transport !== 'http'
      ? `--transport ${transport} has no auto-start (use --transport http)`
      : 'a non-SEA (dev) install has no auto-start (use the SEA binary)';
    console.error(`
Error: E-MEMBER-AUTOSTART: --member requires the user-mode auto-start, but ${why}.
Nothing was installed.
`);
    process.exitCode = 1;
    return;
  }
  // Base counts no longer bake in an always-on Beads slot (apra-fleet-i9ag.13.7.2):
  // bd is part of fleet-se under the owner re-scope on apra-fleet-i9ag.13, so its
  // step (like the workflow-runtime step) is only counted when installWorkflows.
  let totalSteps = (installFleet && installPm) ? 7 : installFleet ? 6 : installPm ? 7 : 5;
  if (installAgents) totalSteps++;
  if (installPm) totalSteps++; // cost.js extraction + workflow copy step
  if (installWorkflows) totalSteps++; // workflow-subsystem runtime/schemas/built-ins step
  if (installBeadsStep) totalSteps++; // Beads install step -- fleet-se (workflows) or a --member install
  totalSteps++; // dolt CLI install step (apra-fleet-ire.3) -- unconditional
  totalSteps++; // KB + code intelligence setup -- unconditional, runs after Beads
  if (serviceStep) totalSteps++;

  // --- Step-number derivation for the fleet-se tail of the pipeline ---
  // (workflow runtime -> dolt -> beads -> KB -> [service]). The fleet-se
  // prereq gate is deliberately NOT in this list: it runs before any step is
  // printed and consumes no step number.
  // kb is always second-to-last-or-last; dolt/beads/workflow-runtime step
  // backward from kb. workflow-runtime is only PRINTED when installWorkflows
  // is true and beads only when installBeadsStep is, so dolt sits one slot
  // earlier than kb when beads is skipped, two slots earlier when it runs.
  const kbStep = serviceStep ? totalSteps - 1 : totalSteps;
  const doltStep = installBeadsStep ? kbStep - 2 : kbStep - 1;
  const beadsStep = kbStep - 1;
  const workflowsStepNum = doltStep - 1;

  // --- Running-process guard (SEA + npm modes -- dev mode runs via node, not a managed binary) ---
  //
  // isApraFleetRunning() is OS-global on purpose (uninstall.ts depends on
  // that). It is only the cheap first filter here:
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
  // Set when the --force guard below stopped a REGISTERED service, so the
  // binary-copy step can bring it back up instead of leaving it down.
  let guardServiceMgr: ServiceManager | null = null;
  let guardStoppedService = false;
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
    // A member install (fleet's remote upgrade path) never stops a server it
    // did not start unless explicitly told to: nothing has been stopped yet.
    if (!memberForceMayStop({ memberMode, overridden: forceStopFullInstall })) {
      console.error(fullInstallRefusalText(runningScope.detail));
      process.exit(3);
    }
    // Only the pids relevant to THIS install are stopped or watched -- by pid,
    // never by name, never this process (which may itself be named apra-fleet).
    // Unrelated apra-fleet servers of the same user are left alone.
    const relevantPids = (): string[] => relevantServerPids(BIN_DIR).map(String);
    // Snapshot BEFORE anything is stopped: a pid that is present afterwards but
    // absent here is a supervisor relaunch, not a process refusing to die.
    const pidsBeforeStop = relevantPids();
    guardServiceMgr = await registeredServiceManager();

    if (guardServiceMgr) {
      // A service is registered: stop the SERVICE, never pkill first.
      console.log('  Registered service detected -- stopping it through the service manager.');
      try {
        await guardServiceMgr.stop();
        guardStoppedService = true;
      } catch (err) {
        console.warn(`    Service stop failed: ${(err as Error).message}`);
      }
      const stillUp = await waitForServiceStop(relevantPids);
      // Escalate ONLY when the very same pids are still there -- i.e. nothing
      // relaunched the server and there is no supervisor race to lose. If a NEW
      // pid appeared, signalling is futile and is deliberately skipped so the
      // relaunch is reported instead of retried forever.
      if (stillUp.length > 0 && stillUp.every(pid => pidsBeforeStop.includes(pid))) {
        killApraFleet(stillUp);
        await waitForApraFleetToStop(relevantPids);
      }
    } else {
      // No service registered: signal the relevant pids directly.
      killApraFleet(pidsBeforeStop);
      await waitForApraFleetToStop(relevantPids);
    }

    const pidsAfterStop = relevantPids();
    if (pidsAfterStop.length > 0) {
      const relaunchedPids = pidsAfterStop.filter(pid => !pidsBeforeStop.includes(pid));
      if (relaunchedPids.length > 0) {
        console.error(`
Error: the apra-fleet server was RELAUNCHED by its service supervisor while
install --force was stopping it -- the observed pid changed between polls (was
${pidsBeforeStop.join(', ') || 'none'}, now ${pidsAfterStop.join(', ')}), so it did not merely refuse to die.
Signalling the process cannot win that race. Stop the service itself,
then re-run the install:
    ${serviceStopCommand()}
`);
        process.exit(1);
      }
      console.error(`
Error: could not stop the running apra-fleet server (it is still running after
SIGTERM and a SIGKILL escalation). Stop it manually before installing:
${manualStopHint(pidsAfterStop)}
`);
      process.exit(1);
    }
    console.log(pidsBeforeStop.length > 0 || guardStoppedService
      ? '  Stopped running server.'
      : '  No running server process of this install was found to stop.');
  }

  console.log(`\nInstalling Apra Fleet ${serverVersion} for ${paths.name}...\n`);
  // Installing is an explicit (re)start intent: end a previous 'apra-fleet stop'.
  {
    const { clearStoppedMarker } = await import('../services/stopped-marker.js');
    clearStoppedMarker();
  }

  // --- Fleet key mint (apra-fleet-i9ag.12.1) ---
  //
  // Runs BEFORE every numbered step on purpose: ~/.apra-fleet/fleet.key is the
  // HS256 secret behind both the JWT issuer and the loopback bearer check, and
  // several later paths are gated on it -- most importantly the supervisor
  // service this install may register and START as its final step, which needs
  // the key to register its workflow package. Before this step NO install-time
  // or CLI-startup path minted the key (getOrCreateKey() had zero call sites in
  // this file), so on a fresh machine the key only appeared the first time some
  // request happened to need it -- and a supervisor that started earlier had
  // already skipped registration.
  //
  // Deliberately UNNUMBERED: it is a sub-second local file write, not a
  // user-visible install stage, and numbering it would renumber every step
  // below (and the totalSteps arithmetic each one derives from).
  //
  // getOrCreateKey() is already mint-or-reuse: it returns an existing 64-char
  // key untouched and only writes (mode 0600, via mkdir -p) when the file is
  // missing, unreadable or the wrong length. So re-running install is a no-op
  // on the key bytes. The key VALUE is never logged -- only its path.
  try {
    getOrCreateKey();
    console.log(`  Fleet key ready at ${fleetKeyPath()}`);
  } catch (err) {
    // Non-fatal, but LOUD: naming the path and the reason. An unwritable home
    // must not silently produce an install whose key-gated features fail later
    // with an unrelated-looking error.
    console.warn(
      `  [WARN] Could not create the fleet key at ${fleetKeyPath()}: ${(err as Error).message}\n` +
        `         Features that need it (workflow-package registration, console auth) will fail\n` +
        `         until this path is writable. Fix the permissions and re-run 'apra-fleet install'.`,
    );
  }

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

  // A registered service that the --force guard stopped must never be left
  // permanently down. When serviceStep is set the final install step
  // re-registers and starts it, so restarting here would only add a redundant
  // bootout/bootstrap cycle mid-install; otherwise nothing else would ever
  // bring it back, so start it now that the new binary is in place. Either way
  // the exact restart command is printed, so a failure at any later step stays
  // recoverable by hand.
  if (guardStoppedService && guardServiceMgr) {
    console.log(`  The registered service was stopped by --force. Restart command: ${serviceRestartCommand()}`);
    if (!serviceStep) {
      try {
        await guardServiceMgr.start();
        console.log('  Restarted the registered service.');
      } catch (err) {
        console.warn(`  [WARN] Could not restart the registered service: ${(err as Error).message}`);
      }
    }
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
  if (memberMode) {
    console.log('    Skipped (--member): user-scope settings are left untouched.');
  } else if (llm !== 'opencode') {
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

  if (memberMode) {
    // The per-folder member entry is written by compose_permissions; a member
    // install must never register apra-fleet in any provider's user-scope config.
    console.log('    Skipped (--member): no user-scope MCP registration.');
  } else if (transport === 'http') {
    if (llm === 'claude') {
      if (!isCommandAvailable('claude')) {
        console.warn(
          `  Warning: the 'claude' CLI was not found on PATH -- skipping MCP server registration.\n` +
          `  Install Claude Code (https://claude.com/claude-code), then re-run 'apra-fleet install'\n` +
          `  to register apra-fleet with it, or register manually with:\n` +
          `    claude mcp add --scope user --transport http apra-fleet ${fleetUrl}`
        );
      } else {
        try {
          run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });
        } catch { /* not registered */ }
        run(`claude mcp add --scope user --transport http apra-fleet ${fleetUrl}`);
      }
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
      // Every branch runs a transform -- the default one is NOT a passthrough. Claude
      // keeps the source frontmatter and every conditional's if-branch, but the
      // conditional markers themselves still have to be stripped or they ship
      // verbatim into the installed agent file (apra-fleet-oomh.1).
      const content = llm === 'opencode'
        ? transformAgentForOpenCode(rawContent, relPath)
        : llm === 'agy'
        ? transformAgentForAgy(rawContent, relPath)
        : transformAgentForClaude(rawContent, relPath);
      writeAssetFile(path.join(agentsDestDir, relPath), content);
    }
  }

  // --- Workflow-subsystem install step (optional, --workflows all|none) ---
  // Writes ~/.apra-fleet/{node_modules,schemas,workflows/{fleet-sprint,hello-world}}.
  // See docs/workflow-subsystem-plan.md Section 6 / Section 2.1 for the layout.
  if (installWorkflows) {
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
  // first, download+extract+verify otherwise. NON-FATAL for dolt (unlike
  // Beads below) -- a missing/broken dolt must never fail "apra-fleet install".
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
  // KB #605 Beads step (src/cli/beads-install.ts): a working bd on PATH, or one
  // already in BIN_DIR, is left untouched; else `npm install -g` (kept only
  // when bd then resolves); else a user-level `npm install --prefix` whose
  // NATIVE bd binary is copied into BIN_DIR (no writable global prefix needed).
  // dispatch/execute_command append BIN_DIR to PATH.
  //
  // When it runs: with --workflows all (bd is part of fleet-se, v0.5
  // apra-fleet-i9ag.13 re-scope) AND for a --member install (sprint roles on a
  // member need bd; KB #618 sets up the member's beads before dispatch).
  //
  // Failure: FATAL with --workflows all -- fleet-se without a runnable bd is a
  // false success (apra-fleet-i9ag.13.7.2), so the reason and fix are printed
  // and the install exits non-zero. LOUD but non-fatal for a --member install
  // (the member's server is still useful for kb_*/code_*), and repeated in the
  // summary. beadsResult stays null when the step did not run, so the summary
  // can tell "ran and found X" from "never ran".
  let beadsResult: BeadsInstallResult | null = null;
  if (installBeadsStep) {
    console.log(`  [${beadsStep}/${totalSteps}] Installing Beads task tracker...`);
    beadsResult = installBeads(BIN_DIR, beadsStepDeps());
    if (beadsResult.state !== 'missing' && beadsResult.location === 'bin-dir') {
      // Later steps of THIS install (the --project-dir check runs
      // `bd config get sync.remote`) must find the BIN_DIR bd too.
      process.env.PATH = `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    if (beadsResult.state === 'installed' && beadsResult.location === 'bin-dir') {
      console.log(`  - bd installed for this user at ${beadsResult.binPath} (fleet commands find it there; add ${BIN_DIR} to your own shell PATH to use bd by hand)`);
    } else if (beadsResult.state === 'missing') {
      if (installWorkflows) {
        console.error(
          `\nError: failed to install Beads (${BEADS_PACKAGE}): ${beadsResult.reason}\n` +
            `       Fix: ${beadsResult.fix}\n`,
        );
        process.exit(1);
      }
      console.warn(`  [!] Beads (bd) NOT installed: ${beadsResult.reason}`);
      console.warn(`  [!] Fix: ${beadsResult.fix}`);
      console.warn('  - Sprint work on this member needs bd and will fail until it is installed');
    }
  }

  // --- KB + code intelligence setup step ---
  // Only runs when the installer is invoked from inside a git repository.
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
      console.warn('    [!] .mcp.json cleanup skipped:', err instanceof Error ? err.message : String(err));
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
    console.warn('    [!] Code intelligence config skipped:', err instanceof Error ? err.message : String(err));
  }

  // Write code intelligence routing instruction to ~/.claude/CLAUDE.md
  // (never for a --member install: that file belongs to the member's user)
  if (!memberMode) try {
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
    console.warn('    [!] ~/.claude/CLAUDE.md update skipped:', err instanceof Error ? err.message : String(err));
  }

  // OpenCode uses --dangerously-skip-permissions and per-agent permission: frontmatter;
  // a top-level "permissions" key is invalid in opencode.json
  if (llm !== 'opencode' && !memberMode) {
    const extraPerms = (llm === 'claude' && installPm)
      ? ['Bash(*)', 'Skill(auto-sprint)', 'Workflow(auto-sprint)']
      : [];
    mergePermissions(paths, extraPerms);
  }

  // Write install-config.json (merge provider entry)
  writeInstallConfig(llm, skillMode, workflowsMode);

  // --- Seed the supervisor's persisted project folder (--project-dir) ---
  // Placed HERE, after the Beads step above and before the supervisor service
  // is registered below, for two reasons that pin it from both sides
  // (apra-fleet-i9ag.17):
  //   - AFTER Beads: the remaining check runs `bd config get sync.remote` in
  //     the folder, and bd is only guaranteed runnable once the Beads step has
  //     run. Before it, a fresh machine failed a check for a tool the install
  //     itself was about to provide.
  //   - BEFORE registration: the supervisor's FIRST boot must already see the
  //     config, or it resolves the wrong project and needs a restart -- which
  //     is the whole point of the option.
  // The preflight near the top of runInstall() has already rejected a bad
  // path, so a failure here means bd is missing (e.g. --workflows none on a
  // machine without bd) or the folder has no beads 'sync.remote'. Both stay
  // FATAL and loud: a skipped check is indistinguishable from a passed one,
  // and would seed a setting whose first sprint launch is guaranteed to fail.
  if (projectDirArg !== undefined) {
    const seedResult = seedSupervisorProjectDir(projectDirArg);
    if (!seedResult.ok) {
      console.error(`Error: --project-dir: ${seedResult.error}.`);
      process.exit(1);
    }
  }

  // --- Record the resolved node/bd toolchain into supervisor.config.json ---
  // (apra-fleet-i9ag.19.2) Placed HERE, after the Beads step above (so bd's
  // resolved path reflects what the Beads step actually provisioned rather
  // than an ordering artefact) and before the supervisor service is
  // registered below (so the service's very first start already reads a
  // recorded toolchain). Only attempted when the workflow assets that
  // contain the supervisor were installed (installWorkflows) -- `--workflows
  // none` writes nothing here, same as the project-dir seed above.
  //
  // Node unresolved is a LOUD, fatal install failure: the fleet-se
  // prerequisite gate above has already confirmed node is present and
  // satisfies MIN_NODE_VERSION, so a node whose absolute path still could not
  // be resolved is a genuine defect, not an environment condition. bd
  // unresolved is NOT a failure -- seedSupervisorToolchain() records a null
  // bdPath and this step continues, matching install's existing "bd not
  // available" tolerance elsewhere.
  if (installWorkflows && fleetSeToolchainStepEnabled()) {
    const toolchain = recordedBdFromBeadsStep(
      fleetSeToolchainStepDeps.resolveFleetSeToolchainPaths(),
      beadsResult,
    );
    const toolchainResult = seedSupervisorToolchain(toolchain);
    if (!toolchainResult.ok) {
      console.error(
        `\nError: could not resolve node's absolute path for the fleet-supervisor service: ` +
          `${toolchainResult.error}.\n` +
          `       This is required so the always-on supervisor can find node without depending on\n` +
          `       the service manager's inherited PATH. Resolve the reason above and re-run\n` +
          `       'apra-fleet install'.\n`,
      );
      process.exit(1);
    }
  }

  // --- Step N: Register and start services (SEA + HTTP mode only) ---
  //
  // TWO independent OS-level services are registered here (see
  // src/services/service-manager/types.ts's ServiceId):
  //   1. 'mcp-server'       -- the apra-fleet MCP server binary (unchanged).
  //   2. 'fleet-supervisor' -- the fleet-sprint supervisor (bin/serve.mjs),
  //      only when the workflow assets that contain it were installed.
  // Each has its own unit/plist/task, so one can be stopped, restarted or
  // uninstalled without touching the other.
  let serviceRegistered = false;
  let supervisorServiceRegistered = false;
  let supervisorServiceAttempted = false;
  let serviceHealthy: boolean | null = null;
  let serviceReused = false;
  let serviceRunKey = false;
  if (serviceStep) {
    console.log(`  [${totalSteps}/${totalSteps}] Registering and starting services...`);
    // The server refuses to start when its configured port is taken (no
    // random-port fallback, GitHub #584) -- say so here rather than leaving a
    // service that exits on every launch with the reason only in the log.
    {
      const { checkRunningInstance, isPortInUse, portInUseMessage, readServerInfoPid } = await import('../services/singleton.js');
      const probe = await checkRunningInstance();
      if (probe.state === 'gone' && await isPortInUse(DEFAULT_PORT, DEFAULT_HOST)) {
        console.warn(`    Warning: ${portInUseMessage(DEFAULT_PORT, readServerInfoPid())}`);
      }
    }
    const svcMgr = await getServiceManager();
    try {
      const registered = await svcMgr.register(binaryPath, ['--transport', 'http'], LOG_FILE_PATH);
      serviceReused = registered === 'reused';
      serviceRunKey = registered === 'run-key';
      if (serviceReused) console.log('    Could not recreate the service task -- existing task reused.');
      if (serviceRunKey) {
        console.log('    Could not create the scheduled task -- registered a per-user logon entry (HKCU Run) instead.');
        console.log('    This starts the server at logon but does NOT restart it if it stops; use apra-fleet start.');
      }
      try {
        await svcMgr.start();
        serviceRegistered = true;
        // Never report "running" on the strength of the start call alone (a
        // launcher that cannot run, a refused port, a crash): ask /health.
        serviceHealthy = await waitForServiceHealth();
        if (serviceHealthy === false) {
          console.warn(`    Service registered, but the server is not answering /health. Check ${LOG_FILE_PATH} and run apra-fleet status.`);
        }
      } catch (startErr) {
        // Never delete a reused task: it predates this install (e.g. elevated).
        if (!serviceReused) { try { await svcMgr.unregister(); } catch {} }
        throw startErr;
      }
    } catch (err) {
      console.warn(`    Service registration skipped: ${(err as Error).message}`);
      // A member install exists to leave an auto-starting server behind; without
      // the auto-start it is not a success, so say so with a typed status.
      if (memberMode) {
        console.error(`
Error: E-MEMBER-AUTOSTART: the member install could not register the user-mode
auto-start (${(err as Error).message}). The server binary is installed but will
not start automatically.
`);
        process.exitCode = 1;
        return;
      }
      // --force stopped the server; reporting success would leave it down silently.
      if (force && (runningScope?.relevant || guardStoppedService)) {
        const restartHint = guardStoppedService
          ? `Start it with:\n    ${serviceRestartCommand()}\nor re-run the install from an elevated prompt.`
          : 'Start it with:\n    apra-fleet start';
        console.error(`
Error: install --force stopped the running apra-fleet server, but the service
could not be registered/started, so the server is NOT running.
${restartHint}
`);
        process.exit(1);
      }
    }

    // The supervisor lives inside the installed fleet-sprint workflow tree, so
    // it can only be registered when that tree was just installed.
    //
    // Unlike the MCP server step above, a supervisor registration failure is
    // FATAL. An install that reports success while the always-on supervisor was
    // silently skipped is a false success: nothing restarts it after a reboot
    // and the operator has no way to notice until a sprint silently stops
    // running. The one legitimate non-registration -- `--workflows none`, where
    // the supervisor was never installed to begin with -- is reported explicitly
    // and leaves the install successful.
    if (installWorkflows) {
      supervisorServiceAttempted = true;
      const result = await registerSupervisorService(binaryPath);
      supervisorServiceRegistered = result.registered;
      if (result.registered) {
        console.log('    [OK] fleet-supervisor service registered and started');
      } else {
        console.error(
          `\nError: the fleet-supervisor service could not be registered: ${result.reason}\n` +
            `       The always-on fleet-sprint supervisor would not survive a reboot, so this\n` +
            `       install is incomplete. Resolve the reason above and re-run 'apra-fleet install'\n` +
            `       (or install with --workflows none if you do not want the supervisor at all).`,
        );
        process.exit(1);
      }
    } else {
      console.log(
        '    fleet-supervisor service NOT registered: installed with --workflows none, so the ' +
          'workflow assets that contain the supervisor are absent.',
      );
    }
  }

  // --- Done ---
  if (memberMode) writeMemberInstallMarker(serverVersion); else clearMemberInstallMarker();
  // When the Beads step ran it has ALREADY established bd's state (and exited
  // non-zero under --workflows all if bd was not runnable), so 'ready ... bd
  // not available' is unreachable (apra-fleet-i9ag.13.7.2). Only when the step
  // was skipped by design (--workflows none, not --member) is bd probed here,
  // and reported honestly without failing.
  let beadsSummary: string;
  if (beadsResult === null) {
    const probed = probeBdVersion();
    beadsSummary = probed === null ? 'not available' : probed || 'installed';
  } else if (beadsResult.state === 'missing') {
    beadsSummary = `not available -- ${beadsResult.reason}. Fix: ${beadsResult.fix}`;
  } else {
    beadsSummary = `${beadsResult.version}${beadsResult.location === 'bin-dir' ? ` (${beadsResult.binPath})` : ''}`;
  }

  const clientName = llm === 'claude' ? 'Claude Code' : paths.name;
  const instructions = llm === 'claude' ? 'Run /mcp in Claude Code to load the server.' : `Restart ${paths.name} to load the server.`;
  const forceNote = force ? `\nRestart ${clientName} to reload the MCP server.` : '';
  const supervisorLine = supervisorServiceAttempted
    // "started", never "running": like the server line (main #629), "running"
    // is reserved for a state this install actually verified.
    ? `\n  Supervisor:  ${supervisorServiceRegistered ? 'registered and started' : 'registration skipped'}`
    : '';
  // fleet-se summary line (apra-fleet-i9ag.13.7.2): "ready" with the detected
  // node/npm/bd versions when --workflows all, else NOT INSTALLED with the
  // fix line -- the --workflows none case is a legitimate, documented opt-out,
  // not a silent gap. When the prereq gate itself was bypassed (NODE_ENV=test
  // without the opt-in env var), fleetSePrereqs is null and node/npm versions
  // are reported as 'n/a' rather than fabricated.
  const fleetSeLine = installWorkflows
    ? `\n  fleet-se:    ready (node ${fleetSePrereqs?.node.version ?? 'n/a'}, npm ${fleetSePrereqs?.npm.version ?? 'n/a'}, bd ${formatFleetSeBdPart(beadsSummary)})`
    : `\n  fleet-se:    NOT INSTALLED -- ${FLEET_SE_PREREQ_FIX_LINE}`;
  const serviceState = serviceHealthy === true ? 'registered and running' : serviceHealthy === false ? 'registered, but NOT answering /health (see the warning above)' : 'registered (health not checked)';
  const serviceLine = serviceStep ? `\n  Service:     ${serviceRegistered ? `${serviceState}${serviceReused ? ' (existing task reused)' : ''}${serviceRunKey ? ' (logon autostart via HKCU Run, no automatic restart)' : ''}` : 'registration skipped'}` : '';
  console.log(`
Apra Fleet ${serverVersion} installed successfully for ${paths.name}.
  Binary:      ${BIN_DIR}
  Hooks:       ${HOOKS_DIR}
  Scripts:     ${SCRIPTS_DIR}
  Settings:    ${paths.settingsFile}${installFleet ? `\n  Fleet Skill: ${paths.fleetSkillsDir}` : ''}${installPm ? `\n  PM Skill:    ${paths.skillsDir}` : ''}${installAgents ? `\n  Agents:      ${paths.agentsDir}` : ''}
  Beads:       ${beadsSummary}
  Dolt:        ${doltVersion}${serviceLine}${supervisorLine}${fleetSeLine}

${instructions}${forceNote}
`);

  if (llm === 'claude' && installPm) {
    console.log('  /auto-sprint BD-1              (native workflow, current branch)');
    console.log('  /auto-sprint BD-1 BD-2         (multiple sprint goals)');
    console.log('  /pm                            (provider-agnostic skill, fleet-ready)');
    console.log('');
  }
}
