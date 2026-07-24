/**
 * `apra-fleet workflow <name> [args...]` -- the import-trampoline launcher.
 *
 * Plan: docs/workflow-subsystem-plan.md Section 1 (launcher mechanics) + Section 3
 * (CLI surface). Server reachability follows docs/adr-workflow-server-resolution.md
 * (apra-fleet-7pm.6), which is BINDING:
 *
 *   - Resolution order = APRA_FLEET_TRANSPORT override -> HTTP-singleton probe
 *     (attach, spawn nothing) -> stdio self-spawn fallback (the four command tiers).
 *   - That order lives in exactly ONE place --
 *     `@apralabs/apra-fleet-client/server-resolution`. This file CALLS it and never
 *     copies `resolveFleetServerCommand()`.
 *   - The launcher and the MCP server are always separate processes; nothing here
 *     merges them.
 *
 * Mechanics: resolve `~/.apra-fleet/workflows/<name>/workflow.json` -> `entry`,
 * set the two env defaults the workflow contract promises (never clobbering a
 * caller-set value), rewrite `process.argv` so the workflow's own arg parser sees
 * exactly what the user typed after `<name>`, then `await import()` the entry from
 * disk (the SEA binary's embedded Node runs on-disk ESM -- proved by apra-fleet-7pm.1).
 *
 * Everything filesystem/env/import-shaped goes through the injectable `deps` bag, so
 * every branch is unit-testable without a real `~/.apra-fleet/` install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { serverVersion } from '../version.js';
import { WORKFLOWS_DIR, SCHEMAS_DIR, BIN_DIR, NODE_MODULES_DIR } from './config.js';
import { extractWorkflowSubsystemAssets, BUILTIN_WORKFLOW_NAMES } from './workflow-assets.js';

/** Fallback entry filenames, in order, when a workflow ships no workflow.json. */
export const ENTRY_CONVENTIONS = ['main.mjs', 'index.mjs', 'runner.js'];

/** The SEA asset-manifest sections this subsystem needs (R9). */
const REQUIRED_ASSET_SECTIONS = ['workflowRuntime', 'agentSchemas', 'builtinWorkflows'];

export interface WorkflowInfo {
  name: string;
  description: string;
  builtin: boolean;
}

export interface WorkflowDeps {
  env: Record<string, string | undefined>;
  /** ~/.apra-fleet/workflows */
  workflowsDir: string;
  /** ~/.apra-fleet/node_modules -- the workflow runtime tree; self-heal (R-self-heal)
   *  treats it, alongside workflowsDir, as the "is this install missing?" signal. */
  nodeModulesDir: string;
  /** ~/.apra-fleet/schemas -- the APRA_FLEET_SE_SCHEMAS_DIR default */
  schemasDir: string;
  /** The apra-fleet server executable -- the APRA_FLEET_SERVER_BIN default */
  serverBin: string;
  /** Version of the running binary (R10 mismatch check) */
  version: string;
  /** node executable path used for the argv[0] rewrite */
  execPath: string;
  exists(p: string): boolean;
  readFile(p: string): string;
  /** Immediate subdirectory names of `p` ([] when `p` does not exist) */
  listDirs(p: string): string[];
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** await import(<file url>) -- injectable so tests never touch the loader */
  importModule(url: string): Promise<Record<string, unknown>>;
  /** R9: does this binary's asset manifest carry the workflow sections? */
  hasWorkflowAssets(): boolean;
  /**
   * Self-heal (docs/workflow-subsystem-plan.md Section 3): on-demand extraction of
   * the shared runtime/schemas (+ built-in workflows when `includeBuiltins`) using
   * the SAME extraction code path install.ts's installer uses
   * (extractWorkflowSubsystemAssets in workflow-assets.ts). Returns true when it
   * actually performed an extraction (so the caller prints exactly one notice
   * line); a no-op (e.g. dev/npm mode, no SEA assets to extract from) returns false.
   */
  selfHeal(includeBuiltins: boolean): boolean;
  /** ADR resolution order -- injected so tests never probe a real server */
  resolveConnection(env: Record<string, string | undefined>): Promise<{ mode: string; reason: string }>;
}

/** True when running from a Node SEA binary (mirrors install.ts's isSea()). */
function isSea(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const sea = require('node:sea');
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

/**
 * R9: an apra-fleet binary built before this epic has no workflow asset sections in
 * its manifest. Detect that up front so the user gets "rebuild/reinstall", not a raw
 * "workflow not found" resolution failure. In dev/npm mode there is no SEA manifest
 * and nothing to be stale about -- report true.
 */
function seaHasWorkflowAssets(): boolean {
  if (!isSea()) return true;
  try {
    const require = createRequire(import.meta.url);
    const sea = require('node:sea');
    const manifest = JSON.parse(new TextDecoder().decode(sea.getAsset('manifest.json')));
    return REQUIRED_ASSET_SECTIONS.every(
      (k) => manifest[k] && Object.keys(manifest[k]).length > 0,
    );
  } catch {
    return false;
  }
}

/**
 * R-self-heal (SEA-only, mirrors seaHasWorkflowAssets()'s isSea() gate): extract
 * the shared runtime/schemas (+ built-ins when `includeBuiltins`) straight from
 * this binary's own embedded SEA assets, via the installer's own
 * extractWorkflowSubsystemAssets() -- never a re-implementation. Dev/npm mode has
 * no SEA assets to self-heal from (the project tree already IS the assets) so
 * this is a no-op there, same as seaHasWorkflowAssets()'s dev-mode "true" branch.
 */
function defaultSelfHeal(includeBuiltins: boolean): boolean {
  if (!isSea()) return false;
  try {
    const require = createRequire(import.meta.url);
    const sea = require('node:sea');
    const manifest = JSON.parse(new TextDecoder().decode(sea.getAsset('manifest.json')));
    extractWorkflowSubsystemAssets({
      manifest,
      extractAssetBuffer: (key: string) => Buffer.from(sea.getAsset(key)),
      version: serverVersion,
      includeBuiltins,
    });
    return true;
  } catch {
    return false;
  }
}

export function defaultDeps(): WorkflowDeps {
  return {
    env: process.env,
    workflowsDir: WORKFLOWS_DIR,
    nodeModulesDir: NODE_MODULES_DIR,
    schemasDir: SCHEMAS_DIR,
    // In SEA mode process.execPath IS the apra-fleet binary; in dev/npm mode the
    // installed binary (if any) lives in ~/.apra-fleet/bin.
    serverBin: isSea()
      ? process.execPath
      : path.join(BIN_DIR, process.platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet'),
    version: serverVersion,
    execPath: process.execPath,
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    listDirs: (p) => {
      try {
        return fs
          .readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
    importModule: (url) => import(url) as Promise<Record<string, unknown>>,
    hasWorkflowAssets: seaHasWorkflowAssets,
    selfHeal: defaultSelfHeal,
    resolveConnection: async (env) => {
      const { resolveFleetServerConnection } = await import(
        '@apralabs/apra-fleet-client/server-resolution'
      );
      return resolveFleetServerConnection({ env });
    },
  };
}

export function launcherHelp(): string {
  return `apra-fleet workflow -- run an installed workflow

Usage:
  apra-fleet workflow <name> [args...]   Run ~/.apra-fleet/workflows/<name>
                                         (everything after <name> is passed to the
                                          workflow verbatim -- e.g.
                                          'apra-fleet workflow auto-sprint --help'
                                          prints auto-sprint's own help)
  apra-fleet workflow --list             List installed workflows
  apra-fleet workflow --help             Show this help

The launcher sets these environment defaults for the workflow (a value you set
yourself always wins):
  APRA_FLEET_SERVER_BIN        the apra-fleet server executable
  APRA_FLEET_SE_SCHEMAS_DIR    the installed agent role schemas

Set APRA_FLEET_TRANSPORT=http|stdio to force how the workflow reaches the fleet
server. Default: attach to a running HTTP singleton if one is healthy, else
self-spawn a stdio server (docs/adr-workflow-server-resolution.md).`;
}

/** Installed workflows, name-sorted. Built-ins are the names in .installed.json. */
export function listWorkflows(deps: WorkflowDeps): WorkflowInfo[] {
  const builtins = new Set(readInstalledManifest(deps).builtin);
  return deps
    .listDirs(deps.workflowsDir)
    .sort()
    .map((name) => ({
      name,
      description: readDescription(deps, name),
      builtin: builtins.has(name),
    }));
}

export function formatWorkflowList(deps: WorkflowDeps): string {
  const workflows = listWorkflows(deps);
  if (workflows.length === 0) {
    return `No workflows installed in ${deps.workflowsDir}.\nRun 'apra-fleet install' to install the built-in workflows.`;
  }
  const width = Math.max(...workflows.map((w) => w.name.length));
  const lines = workflows.map(
    (w) => `  ${w.name.padEnd(width)}  ${w.builtin ? '[builtin]' : '[user]   '}  ${w.description}`,
  );
  return [`Installed workflows (${deps.workflowsDir}):`, ...lines].join('\n');
}

function readInstalledManifest(deps: WorkflowDeps): { version?: string; builtin: string[] } {
  const p = path.join(deps.workflowsDir, '.installed.json');
  try {
    const data = JSON.parse(deps.readFile(p));
    return { version: data.version, builtin: Array.isArray(data.builtin) ? data.builtin : [] };
  } catch {
    return { builtin: [] };
  }
}

function readWorkflowJson(deps: WorkflowDeps, name: string): Record<string, unknown> | null {
  const p = path.join(deps.workflowsDir, name, 'workflow.json');
  if (!deps.exists(p)) return null;
  try {
    const parsed = JSON.parse(deps.readFile(p));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readDescription(deps: WorkflowDeps, name: string): string {
  const wf = readWorkflowJson(deps, name);
  const desc = wf?.description;
  return typeof desc === 'string' && desc.length > 0 ? desc : '(no description)';
}

export class WorkflowError extends Error {}

/**
 * workflow.json -> entry (relative, must stay inside the workflow dir), else the
 * first existing filename in ENTRY_CONVENTIONS.
 * @throws WorkflowError with a user-facing message.
 */
export function resolveWorkflowEntry(deps: WorkflowDeps, name: string): string {
  const dir = path.join(deps.workflowsDir, name);
  if (!deps.exists(dir)) {
    throw new WorkflowError(
      `Error: workflow "${name}" not found in ${deps.workflowsDir}.\n\n${formatWorkflowList(deps)}`,
    );
  }

  const manifestPath = path.join(dir, 'workflow.json');
  if (deps.exists(manifestPath)) {
    const wf = readWorkflowJson(deps, name) ?? {};
    const entry = wf.entry;
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new WorkflowError(
        `Error: ${manifestPath} is missing a valid "entry" (a path relative to the workflow directory).`,
      );
    }
    const abs = path.resolve(dir, entry);
    const rel = path.relative(dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new WorkflowError(
        `Error: ${manifestPath} "entry" (${entry}) resolves outside the workflow directory ${dir}.`,
      );
    }
    if (!deps.exists(abs)) {
      throw new WorkflowError(
        `Error: ${manifestPath} "entry" (${entry}) does not exist at ${abs}.`,
      );
    }
    return abs;
  }

  for (const candidate of ENTRY_CONVENTIONS) {
    const abs = path.join(dir, candidate);
    if (deps.exists(abs)) return abs;
  }
  throw new WorkflowError(
    `Error: workflow "${name}" has no workflow.json and none of ${ENTRY_CONVENTIONS.join(', ')} in ${dir}.`,
  );
}

/**
 * Env defaults (never clobber a caller-set value).
 *
 * ADR note: APRA_FLEET_SERVER_BIN is read by the shared resolver as an *explicit
 * stdio request*. So it is only defaulted when the resolver already chose stdio --
 * defaulting it on the HTTP-attach path would sabotage the attach the ADR requires.
 */
export function applyEnvDefaults(
  deps: WorkflowDeps,
  mode: string | null,
): Record<string, string | undefined> {
  const env = deps.env;
  if (!env.APRA_FLEET_SE_SCHEMAS_DIR) env.APRA_FLEET_SE_SCHEMAS_DIR = deps.schemasDir;
  if (!env.APRA_FLEET_SERVER_BIN && !env.APRA_FLEET_SERVER_CMD && mode !== 'http') {
    env.APRA_FLEET_SERVER_BIN = deps.serverBin;
  }
  return env;
}

/** R10: warn (do not fail) when the installed workflows predate this binary. */
function checkVersionSkew(deps: WorkflowDeps): void {
  const { version } = readInstalledManifest(deps);
  if (version && version !== deps.version) {
    deps.warn(
      `[warn] workflows in ${deps.workflowsDir} were installed by apra-fleet ${version}, ` +
        `but this binary is ${deps.version}.\n` +
        `       Run 'apra-fleet install' to refresh the workflow runtime and built-in workflows.`,
    );
  }
}

/**
 * The launcher.
 * @returns process exit code (the caller owns process.exit).
 */
export async function runWorkflow(argv: string[], depsOverride?: Partial<WorkflowDeps>): Promise<number> {
  const deps: WorkflowDeps = { ...defaultDeps(), ...depsOverride };

  // --- Launcher-owned flags: only BEFORE <name> (or when no name is given).
  const nameIndex = argv.findIndex((a) => !a.startsWith('-'));
  const launcherFlags = nameIndex === -1 ? argv : argv.slice(0, nameIndex);
  const name = nameIndex === -1 ? undefined : argv[nameIndex];
  const passthrough = nameIndex === -1 ? [] : argv.slice(nameIndex + 1);

  for (const flag of launcherFlags) {
    if (flag === '--help' || flag === '-h') {
      deps.log(launcherHelp());
      return 0;
    }
    if (flag === '--list' || flag === '-l') {
      deps.log(formatWorkflowList(deps));
      return 0;
    }
    deps.error(`Error: unknown launcher option '${flag}'.\n\n${launcherHelp()}`);
    return 1;
  }

  if (!name) {
    deps.error(`Error: missing workflow name.\n\n${launcherHelp()}`);
    return 1;
  }

  // --- R9: an old binary has no workflow assets at all -- say so, actionably.
  if (!deps.exists(path.join(deps.workflowsDir, name)) && !deps.hasWorkflowAssets()) {
    deps.error(
      `Error: this apra-fleet binary was built without the workflow subsystem assets ` +
        `(no workflow runtime / built-in workflows in its embedded manifest), so ` +
        `workflow "${name}" cannot be resolved or self-healed.\n` +
        `       Rebuild the binary ('npm run build:binary') or reinstall a current release ` +
        `('apra-fleet update'), then run 'apra-fleet install' again.`,
    );
    return 1;
  }

  // --- Self-heal (docs/workflow-subsystem-plan.md Section 3): an empty/partial
  // ~/.apra-fleet install (workflows/ or node_modules/ missing) is repaired on
  // demand for a recognized built-in, using the SAME extraction code path
  // install.ts's installer uses. A non-built-in name never gets a fabricated
  // workflow directory -- only the shared runtime/schemas it also needs.
  if (!deps.exists(deps.workflowsDir) || !deps.exists(deps.nodeModulesDir)) {
    const isBuiltin = BUILTIN_WORKFLOW_NAMES.includes(name);
    const healed = deps.selfHeal(isBuiltin);
    if (healed) {
      deps.log(
        isBuiltin
          ? `[workflow] self-heal: extracted the workflow runtime, schemas, and built-in workflows to ${deps.workflowsDir} (missing on disk).`
          : `[workflow] self-heal: extracted the workflow runtime and schemas (missing on disk).`,
      );
    }
  }

  // --- R10: version skew between binary and installed workflows.
  checkVersionSkew(deps);

  let entry: string;
  try {
    entry = resolveWorkflowEntry(deps, name);
  } catch (err) {
    deps.error(err instanceof WorkflowError ? err.message : String(err));
    return 1;
  }

  // --- Fleet-server reachability (docs/adr-workflow-server-resolution.md).
  // Probe with the caller's REAL env first: the shared resolver reads a set
  // APRA_FLEET_SERVER_BIN as an *explicit stdio request* and skips the
  // HTTP-singleton probe entirely, so injecting the launcher's own default
  // into this probe meant `apra-fleet workflow` could never attach to a
  // running singleton (apra-fleet-eft.61). Only when the unmodified probe
  // fails (bare home: no singleton, no dev-monorepo dist/ -- the case behind
  // the old "could not resolve the fleet server" false positive on green CI
  // build-binary smoke runs) do we retry with the serverBin default, which is
  // exactly what applyEnvDefaults() hands the workflow child on that path.
  let mode: string | null = null;
  try {
    const resolution = await deps.resolveConnection({ ...deps.env });
    mode = resolution.mode;
    deps.log(`[workflow] fleet server: ${resolution.reason}`);
  } catch (firstErr) {
    const canDefaultServerBin =
      !deps.env.APRA_FLEET_SERVER_BIN && !deps.env.APRA_FLEET_SERVER_CMD;
    try {
      if (!canDefaultServerBin) throw firstErr;
      const fallbackEnv = { ...deps.env, APRA_FLEET_SERVER_BIN: deps.serverBin };
      const resolution = await deps.resolveConnection(fallbackEnv);
      mode = resolution.mode;
      deps.log(`[workflow] fleet server: ${resolution.reason}`);
    } catch (err) {
      // Not fatal: plenty of workflows never talk to the server (hello-world). The
      // workflow's own connect will fail with its own message if it does need one.
      deps.warn(`[warn] could not resolve the fleet server: ${(err as Error).message}`);
    }
  }

  applyEnvDefaults(deps, mode);

  // --- Import trampoline: the workflow sees exactly the args typed after <name>.
  const savedArgv = process.argv;
  process.argv = [deps.execPath, entry, ...passthrough];
  try {
    const mod = await deps.importModule(pathToFileURL(entry).href);
    // A self-executing entry (the documented default) runs on import and declares
    // itself with `export const selfExecuting = true`. Otherwise, call its exported
    // main/run/default with the raw pass-through args.
    if (!mod.selfExecuting) {
      const fn = [mod.main, mod.run, mod.default].find((f) => typeof f === 'function') as
        | ((args: string[]) => unknown)
        | undefined;
      if (fn) {
        await fn(passthrough);
      } else {
        // apra-fleet-eft.41.2: a module that neither self-executes nor exports a
        // callable entry used to fall through here silently, RETURNing 0 having
        // done nothing -- the worst failure mode (a no-op reported as success).
        // This is a defense-in-depth backstop even after the cli.mjs
        // isMainModule() fix (apra-fleet-eft.41.1): fail loud instead.
        deps.error(
          `Error: workflow "${name}" entry (${entry}) did not execute: it neither sets ` +
            `"export const selfExecuting = true" nor exports a callable main/run/default. ` +
            `Nothing happened.`,
        );
        return 1;
      }
    }
  } catch (err) {
    const e = err as Error;
    deps.error(e.stack ?? String(e));
    return 1;
  } finally {
    process.argv = savedArgv;
  }

  return 0;
}
