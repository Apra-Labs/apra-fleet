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
import { execFileSync } from 'node:child_process';
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

/** The `.beads` directory name, the same one apra-fleet-se's
 *  `BEADS_DIR_NAME` carries (restated here for the same TypeScript/ESM
 *  boundary reason `SUPERVISOR_CONFIG_FILENAME` above is). */
const BEADS_DIR_NAME = '.beads';

/**
 * One synchronous child-process run, returning stdout. Injectable so
 * `seedSupervisorProjectDir()` below is unit-testable with no bd, no git and
 * no real project folder anywhere on the host.
 */
export type SeedProjectDirExec = (
  file: string,
  args: string[],
  options: { cwd?: string },
) => string;

/**
 * `shell: true` for `bd` only, and for the same reason `probeBdVersion()` in
 * ./install.ts uses it: on Windows bd resolves through a `.cmd`/`.ps1` shim
 * that CreateProcess cannot exec directly. `git` is a real executable
 * everywhere and is deliberately run WITHOUT a shell, so no part of a
 * caller-supplied path can ever be reinterpreted as a shell token.
 */
const realSeedProjectDirExec: SeedProjectDirExec = (file, args, options) =>
  String(
    execFileSync(file, args, {
      ...options,
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: file === 'bd',
    }) ?? '',
  );

/**
 * Value of a `bd config get <key> --json` answer ({ key, value, ... }), with
 * the plain (non-JSON) output of an older bd accepted as a fallback -- the
 * same two shapes `parseBdConfigValue()` in
 * packages/apra-fleet-se/fleet-sprint/beads-identity.mjs accepts. Restated
 * rather than imported for the TypeScript/ESM boundary reason documented on
 * `SUPERVISOR_CONFIG_FILENAME` above.
 */
function parseBdConfigValue(text: string): string {
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const obj = JSON.parse(text.slice(start));
      if (obj && typeof obj === 'object' && 'value' in obj) {
        return String((obj as { value: unknown }).value ?? '').trim();
      }
    } catch {
      // Not JSON after all -- fall through to the plain-output reading.
    }
  }
  return text.trim().split(/\r?\n/)[0].trim();
}

/**
 * Validate `projectDir` and, on success, write it to
 * `supervisor.config.json` under `dataDir` -- the exact shape
 * `readSupervisorConfig()` accepts: a JSON object with a non-empty string
 * `projectDir` key, resolved to an ABSOLUTE path before writing (the reader
 * otherwise resolves a relative value against ITS OWN cwd at read time,
 * which is not install's cwd and not stable across a service restart).
 *
 * VALIDATION is the same question the console's POST /api/project asks, and
 * for the same reason: the fleet-sprint engine's beads identity precondition
 * is FATAL, so a folder without an initialised `.beads`, a git `origin`
 * remote and a bd `sync.remote` cannot run a sprint at all. Seeding one at
 * install time would hand the operator a supervisor that boots cleanly and
 * then fails every launch, which is exactly the silent-wrong-thing this
 * option exists to prevent -- so all four checks run here:
 *
 *   1. the path exists and is a directory (a `.beads` path is normalised to
 *      its parent first, the same convenience `--beads-dir` and the console
 *      both offer),
 *   2. `<dir>/.beads` is itself a directory,
 *   3. `git -C <dir> remote get-url origin` succeeds and is non-empty,
 *   4. `bd config get sync.remote --json` (run in `<dir>`) is non-empty.
 *
 * bd MUST be runnable for step 4. When it is not, this fails LOUDLY rather
 * than skipping the check: a skipped check is indistinguishable from a
 * passed one to the operator, and would put back the unusable setting the
 * option is meant to make impossible.
 *
 * Never partially writes: every check runs before any write call, so a
 * rejected path leaves no new file behind and an already-existing config
 * (e.g. one an operator set from the console) is left untouched.
 *
 * THE WRITE ITSELF matches the runtime writer's two documented guarantees
 * (writeSupervisorConfig() in
 * packages/apra-fleet-se/src/supervisor/project-config.mjs), because the two
 * write the SAME file and an installer that only honoured one of them would
 * silently undo the other's work:
 *
 *   - UNKNOWN TOP-LEVEL KEYS ARE PRESERVED. A newer supervisor may have
 *     written a field this build has never heard of; an install must not
 *     destroy it. The existing file is read and merged under `projectDir`
 *     (a file that is missing, unreadable or not a JSON object simply
 *     yields nothing to preserve and is replaced by a good one).
 *   - THE WRITE IS ATOMIC: temp file in the SAME directory, then rename, so
 *     an interrupted install can never leave a truncated file that the
 *     supervisor's next boot has to reject.
 *
 * `fsImpl`/`execImpl` are injectable purely for tests -- production callers
 * always use the defaults (real `node:fs`, real child processes).
 */
export function seedSupervisorProjectDir(
  projectDir: string,
  dataDir: string = SUPERVISOR_DATA_DIR,
  fsImpl: Pick<typeof fs, 'existsSync' | 'statSync' | 'mkdirSync' | 'writeFileSync' | 'readFileSync' | 'renameSync'> = fs,
  execImpl: SeedProjectDirExec = realSeedProjectDirExec,
): SeedProjectDirResult {
  const given = path.resolve(projectDir);
  const isDirectory = (p: string): boolean => {
    try {
      return fsImpl.existsSync(p) && fsImpl.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (!isDirectory(given)) {
    return {
      ok: false,
      resolvedPath: given,
      error: `project folder '${given}' does not exist or is not a directory`,
    };
  }
  // Accept `<project>/.beads` as well as `<project>`, exactly as the
  // supervisor's own --beads-dir flag and POST /api/project do, so the three
  // inputs cannot disagree about the same folder.
  const resolvedPath = path.basename(given) === BEADS_DIR_NAME ? path.dirname(given) : given;

  if (!isDirectory(path.join(resolvedPath, BEADS_DIR_NAME))) {
    return {
      ok: false,
      resolvedPath,
      error: `project folder '${resolvedPath}' has no initialised beads database (${BEADS_DIR_NAME}): run 'bd init' there`,
    };
  }

  try {
    const origin = execImpl('git', ['-C', resolvedPath, 'remote', 'get-url', 'origin'], {}).trim();
    if (!origin) throw new Error('empty origin');
  } catch {
    return {
      ok: false,
      resolvedPath,
      error: `project folder '${resolvedPath}' has no git 'origin' remote: run 'git remote add origin <url>' there`,
    };
  }

  // bd must be RUNNABLE before its answer can mean anything. Probing the
  // version separately is what lets the two failures stay distinguishable:
  // "bd is missing" (an install-machine problem) and "sync.remote is unset"
  // (a project problem) have completely different fixes.
  try {
    execImpl('bd', ['--version'], {});
  } catch {
    return {
      ok: false,
      resolvedPath,
      error: "bd could not be run, and is required to validate a project folder: install bd and make sure it is on PATH",
    };
  }
  let syncRemote = '';
  try {
    syncRemote = parseBdConfigValue(execImpl('bd', ['config', 'get', 'sync.remote', '--json'], { cwd: resolvedPath }));
  } catch {
    syncRemote = '';
  }
  if (!syncRemote) {
    return {
      ok: false,
      resolvedPath,
      error: `project folder '${resolvedPath}' has no beads 'sync.remote' setting: run 'bd config set sync.remote <url>' there`,
    };
  }

  fsImpl.mkdirSync(dataDir, { recursive: true });
  const configPath = supervisorConfigPath(dataDir);
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(fsImpl.readFileSync(configPath, 'utf-8')));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // No file, unreadable, or not JSON -- there is nothing to preserve, and
    // a corrupt file is replaced by a good one rather than blocking the
    // write (the same total-read stance the runtime reader takes).
    existing = {};
  }
  const tmpPath = `${configPath}.tmp`;
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify({ ...existing, projectDir: resolvedPath }, null, 2)}\n`, 'utf-8');
  fsImpl.renameSync(tmpPath, configPath);
  return { ok: true, resolvedPath };
}
