/**
 * `apra-fleet supervisor [args...]` -- foreground launcher for the INSTALLED
 * fleet-sprint supervisor, run on the running binary's own embedded runtime.
 *
 * Why this exists: until now the only way to start the installed supervisor was
 * `node <FLEET_BASE>/workflows/fleet-sprint/bin/serve.mjs`, which needs a separate
 * Node on PATH. A fresh machine carrying nothing but the released SEA binary could
 * not start it at all. The SEA binary's embedded Node runs on-disk ESM (the same
 * property `apra-fleet workflow <name>` relies on -- see src/cli/workflow.ts), so
 * importing the installed serve.mjs from here is all that is needed.
 *
 * Why NOT `runWorkflow()`:
 *  - packages/apra-fleet-se/workflow.json declares `entry: bin/cli.mjs`, and cli.mjs
 *    has no `serve` subcommand, so the fleet-sprint workflow entry never reaches the
 *    supervisor.
 *  - runWorkflow()'s post-import contract wants `export const selfExecuting = true`
 *    or a callable main/run/default. serve.mjs exports neither (it exports
 *    `serveMain` and self-executes only behind its own isMainModule() guard), so
 *    runWorkflow() would print its "did not execute" error even when serve.mjs had
 *    in fact already run.
 *
 * THE DOUBLE-BOOT TRAP (the single most important property of this file):
 * serve.mjs ends with
 *
 *     if (isMainModule()) { serveMain().then(({exitCode}) => process.exit(exitCode)) }
 *
 * where isMainModule() compares `import.meta.url` against
 * `pathToFileURL(process.argv[1]).href`. src/cli/workflow.ts's trampoline rewrites
 * process.argv to `[execPath, entry, ...passthrough]` -- so doing BOTH the argv[1]
 * rewrite AND an explicit `serveMain()` call here would boot the supervisor twice
 * and the second HTTP listener would fail on the port. Exactly ONE mechanism is
 * chosen here: we deliberately DO NOT touch process.argv, and instead call the
 * exported `serveMain(passthrough)` ourselves. That also lets us propagate the
 * `{ exitCode }` it returns, which the argv-rewrite mechanism cannot do (serve.mjs
 * would call process.exit() itself). tests/supervisor-subcommand.test.ts pins this
 * by emulating serve.mjs's isMainModule() guard inside the fake module and asserting
 * serveMain runs exactly once.
 *
 * Everything filesystem/env/import shaped goes through the injectable `deps` bag, so
 * every branch is unit-testable with no real `~/.apra-fleet` install.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKFLOWS_DIR, SCHEMAS_DIR } from './config.js';

/** Workflow directory name the installer stages packages/apra-fleet-se under. */
export const SUPERVISOR_WORKFLOW_NAME = 'fleet-sprint';

/**
 * The installed fleet-sprint tree: `<FLEET_BASE>/workflows/fleet-sprint`. This file
 * is the canonical home of this constant -- other modules that need to launch the
 * installed supervisor (e.g. the OS service registration) import it from here rather
 * than recomputing it.
 */
export const SUPERVISOR_WORKING_DIR = path.join(WORKFLOWS_DIR, SUPERVISOR_WORKFLOW_NAME);

/** The installed supervisor entry point: `<SUPERVISOR_WORKING_DIR>/bin/serve.mjs`. */
export const SUPERVISOR_SERVE_SCRIPT = path.join(SUPERVISOR_WORKING_DIR, 'bin', 'serve.mjs');

/**
 * Default value for FLEET_SE_DATA_DIR -- byte-identical to what
 * packages/apra-fleet-se/src/supervisor/ledger.mjs's defaultDataDir() falls back to.
 *
 * Setting it here, in-process, is deliberate: under an OS service there is no shell
 * env at all, so the supervisor's ledger/history/log root must be decided by the
 * launcher rather than inherited. That is why the service unit needs no Environment=
 * plumbing for it.
 */
export const SUPERVISOR_DATA_DIR = path.join(os.homedir(), '.apra-fleet-se');

export interface SupervisorDeps {
  /** Mutated in place, exactly like workflow.ts's applyEnvDefaults(). */
  env: Record<string, string | undefined>;
  /** <FLEET_BASE>/workflows/fleet-sprint */
  workingDir: string;
  /** <FLEET_BASE>/workflows/fleet-sprint/bin/serve.mjs */
  serveScript: string;
  /** <FLEET_BASE>/schemas -- the APRA_FLEET_SE_SCHEMAS_DIR default */
  schemasDir: string;
  /** The FLEET_SE_DATA_DIR default */
  dataDir: string;
  exists(p: string): boolean;
  error(msg: string): void;
  /** await import(<file url>) -- injectable so tests never touch the loader */
  importModule(url: string): Promise<Record<string, unknown>>;
}

export function defaultDeps(): SupervisorDeps {
  return {
    env: process.env,
    workingDir: SUPERVISOR_WORKING_DIR,
    serveScript: SUPERVISOR_SERVE_SCRIPT,
    schemasDir: SCHEMAS_DIR,
    dataDir: SUPERVISOR_DATA_DIR,
    exists: (p) => fs.existsSync(p),
    error: (m) => console.error(m),
    importModule: (url) => import(url) as Promise<Record<string, unknown>>,
  };
}

/**
 * Env defaults for the supervisor -- never clobber a caller-set value (the same rule
 * workflow.ts's applyEnvDefaults() follows).
 */
export function applySupervisorEnvDefaults(deps: SupervisorDeps): Record<string, string | undefined> {
  const env = deps.env;
  if (!env.APRA_FLEET_SE_SCHEMAS_DIR) env.APRA_FLEET_SE_SCHEMAS_DIR = deps.schemasDir;
  if (!env.FLEET_SE_DATA_DIR) env.FLEET_SE_DATA_DIR = deps.dataDir;
  return env;
}

/** Actionable "you have not installed it yet" message -- never a raw module-not-found stack. */
export function missingInstallMessage(deps: SupervisorDeps): string {
  return (
    `Error: the installed fleet-sprint supervisor was not found at ${deps.serveScript}.\n` +
    `       Run 'apra-fleet install' to install the built-in workflows, then retry ` +
    `'apra-fleet supervisor'.`
  );
}

export function supervisorLauncherHelp(): string {
  return `apra-fleet supervisor -- run the installed fleet-sprint supervisor in the foreground

Usage:
  apra-fleet supervisor [options]   Everything after 'supervisor' is passed to the
                                    supervisor verbatim (never re-parsed here), so
                                    'apra-fleet supervisor --help' prints the
                                    supervisor's own usage.`;
}

/**
 * The launcher.
 *
 * @param argv everything typed after `supervisor`, passed to serve.mjs verbatim.
 * @returns process exit code (the caller owns process.exit).
 */
export async function runSupervisor(
  argv: string[],
  depsOverride?: Partial<SupervisorDeps>,
): Promise<number> {
  const deps: SupervisorDeps = { ...defaultDeps(), ...depsOverride };

  // R8: a missing installed tree is an operator condition with an obvious fix, not
  // an ERR_MODULE_NOT_FOUND stack. Checked BEFORE the import so the loader never
  // gets the chance to throw one.
  if (!deps.exists(deps.serveScript)) {
    deps.error(missingInstallMessage(deps));
    return 1;
  }

  applySupervisorEnvDefaults(deps);

  let mod: Record<string, unknown>;
  try {
    // NOTE: process.argv is intentionally left alone -- see THE DOUBLE-BOOT TRAP
    // in this file's header. argv[1] stays pointed at the apra-fleet entry, so
    // serve.mjs's isMainModule() is false and only our explicit serveMain() call
    // below boots the supervisor.
    mod = await deps.importModule(pathToFileURL(deps.serveScript).href);
  } catch (err) {
    const e = err as Error;
    deps.error(
      `Error: failed to load the installed supervisor from ${deps.serveScript}.\n${e.stack ?? String(e)}`,
    );
    return 1;
  }

  const serveMain = mod.serveMain;
  if (typeof serveMain !== 'function') {
    deps.error(
      `Error: ${deps.serveScript} does not export a callable 'serveMain'. ` +
        `The installed fleet-sprint tree looks incompatible with this apra-fleet binary -- ` +
        `run 'apra-fleet install' to refresh it.`,
    );
    return 1;
  }

  try {
    const result = (await (serveMain as (args: string[]) => unknown)(argv)) as
      | { exitCode?: unknown }
      | undefined;
    const code = result?.exitCode;
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    const e = err as Error;
    deps.error(e.stack ?? String(e));
    return 1;
  }
}

/**
 * apra-fleet-i9ag.17.4.1: the supervisor's persisted project-folder setting
 * -- `supervisor.config.json` under `SUPERVISOR_DATA_DIR` -- written here
 * (install time) and read by packages/apra-fleet-se's own
 * `readSupervisorConfig()`/`resolveProjectDir()`
 * (packages/apra-fleet-se/src/supervisor/project-config.mjs,
 * beads-identity.mjs). This is the ONLY writer of that file on the install
 * side, mirroring the reader's own "one owner" rule.
 *
 * SCHEMA DRIFT: this package cannot import the .mjs reader directly to
 * share one schema definition -- the root package is TypeScript under
 * `rootDir: ./src` with `allowJs` off, and does not depend on
 * `@apralabs/apra-fleet-se` (the dependency runs the other way, through
 * `@apralabs/apra-fleet-client`; see src/services/sprint-coordination.ts's
 * header for the identical constraint already documented there). Drift is
 * instead caught by a parity test (tests/install-supervisor-service.test.ts)
 * that imports the REAL reader and asserts it accepts exactly what this
 * writer produces, rather than two hand-restated copies of the same JSON
 * shape checked against each other in name only.
 */
export const SUPERVISOR_CONFIG_FILENAME = 'supervisor.config.json';

/** Absolute path of `supervisor.config.json` for a given supervisor data
 *  dir (default `SUPERVISOR_DATA_DIR`) -- byte-identical in shape to
 *  packages/apra-fleet-se/src/supervisor/project-config.mjs's own
 *  `supervisorConfigPath()`. */
export function supervisorConfigPath(dataDir: string = SUPERVISOR_DATA_DIR): string {
  return path.join(dataDir, SUPERVISOR_CONFIG_FILENAME);
}

export interface SeedProjectDirResult {
  ok: boolean;
  /** The resolved absolute path, whether or not the seed succeeded -- so a
   *  caller can name it in an error message without re-resolving. */
  resolvedPath: string;
  /** Present only when `ok` is false. */
  error?: string;
}

/**
 * Validate `projectDir` (must exist and be a directory) and, on success,
 * write it to `supervisor.config.json` under `dataDir` -- the exact shape
 * `readSupervisorConfig()` accepts: a JSON object with a non-empty string
 * `projectDir` key, resolved to an ABSOLUTE path before writing (the reader
 * otherwise resolves a relative value against ITS OWN cwd at read time,
 * which is not install's cwd and not stable across a service restart).
 *
 * Never partially writes: the existence/directory check runs before any
 * `fs.writeFileSync` call, so a rejected path leaves no new file behind and
 * an already-existing config (e.g. one an operator set from the console) is
 * left completely untouched by a rejected call.
 *
 * `fsImpl` is injectable purely for tests -- production callers always use
 * the default (real `node:fs`).
 */
export function seedSupervisorProjectDir(
  projectDir: string,
  dataDir: string = SUPERVISOR_DATA_DIR,
  fsImpl: Pick<typeof fs, 'existsSync' | 'statSync' | 'mkdirSync' | 'writeFileSync'> = fs,
): SeedProjectDirResult {
  const resolvedPath = path.resolve(projectDir);
  let isDir = false;
  try {
    isDir = fsImpl.existsSync(resolvedPath) && fsImpl.statSync(resolvedPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      ok: false,
      resolvedPath,
      error: `project folder '${resolvedPath}' does not exist or is not a directory`,
    };
  }
  fsImpl.mkdirSync(dataDir, { recursive: true });
  const configPath = supervisorConfigPath(dataDir);
  fsImpl.writeFileSync(configPath, `${JSON.stringify({ projectDir: resolvedPath }, null, 2)}\n`, 'utf-8');
  return { ok: true, resolvedPath };
}
