/**
 * Deploy-path launcher for the shared MCP server singleton
 * ("apra-fleet run --transport http", port 7523 -- see deploy.md's Deploy
 * section).
 *
 * apra-fleet-5ti7.2: routes the Windows detached launch through the
 * hidden-launch helper (launchDetachedHidden, ../os/windows.ts) instead of a
 * hand-rolled per-session Invoke-CimMethod/`cmd /c start` incantation -- the
 * pattern that silently died from cmd.exe quote-stripping and left visible
 * console windows (apra-fleet-5ti7). On non-Windows this uses a detached
 * `spawn` + `unref()`, the programmatic equivalent of deploy.md's documented
 * `nohup ... & disown`.
 *
 * CLI usage (after `npm run build`):
 *   node dist/cli/launch-mcp-server-windows.js [execPath]
 * `execPath` defaults to the installed binary under BIN_DIR
 * (~/.apra-fleet/bin/apra-fleet[.exe]). Exits non-zero with the failure
 * message on the console when the launch fails -- never a silent no-op
 * (apra-fleet-5ti7 AC4).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchDetachedHidden } from '../os/windows.js';
import type { DetachedLaunchExecutor, DetachedLaunchResult } from '../os/windows.js';
import { BIN_DIR } from './config.js';
import { LOG_FILE_PATH } from '../paths.js';

/** The MCP server's fixed HTTP port (see paths.ts DEFAULT_PORT / deploy.md). */
export const MCP_SERVER_PORT = 7523;

export interface LaunchMcpServerOptions {
  /** Absolute path to the apra-fleet executable. Defaults to BIN_DIR/apra-fleet[.exe]. */
  execPath?: string;
  /** Absolute working directory for the child. Defaults to BIN_DIR. */
  cwd?: string;
  /** Absolute path of the file that receives the child's stdout/stderr. Defaults to LOG_FILE_PATH. */
  logFile?: string;
}

function defaultExecPath(): string {
  const binaryName = process.platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet';
  return path.join(BIN_DIR, binaryName);
}

function resolveOptions(opts: LaunchMcpServerOptions): { execPath: string; cwd: string; logFile: string } {
  return {
    execPath: opts.execPath ?? defaultExecPath(),
    cwd: opts.cwd ?? BIN_DIR,
    logFile: opts.logFile ?? LOG_FILE_PATH,
  };
}

/**
 * Windows: launch the MCP server detached and hidden via the shared helper.
 * `exec` is an injectable executor seam so tests can spy on the command
 * without spawning a real process -- see tests/windows-hidden-launch-helper.test.ts.
 */
export function launchMcpServerWindows(
  opts: LaunchMcpServerOptions = {},
  exec?: DetachedLaunchExecutor,
): DetachedLaunchResult {
  const { execPath, cwd, logFile } = resolveOptions(opts);
  return launchDetachedHidden({ command: execPath, args: ['run', '--transport', 'http'], cwd, logFile }, exec);
}

/** POSIX: detached spawn + unref, the `nohup ... & disown` equivalent. */
export function launchMcpServerPosix(
  opts: LaunchMcpServerOptions = {},
): { ok: true; pid: number } | { ok: false; error: string } {
  const { execPath, cwd, logFile } = resolveOptions(opts);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');
    const child = spawn(execPath, ['run', '--transport', 'http'], {
      cwd,
      detached: true,
      stdio: ['ignore', out, err],
    });
    // A nonexistent executable (or other spawn failure) sets child.pid to
    // undefined synchronously, but the underlying ENOENT/EACCES only
    // surfaces asynchronously as an 'error' event -- with no listener
    // attached, Node's default EventEmitter behaviour is to rethrow it as
    // an unhandled exception and crash the process. Swallow it here: the
    // pid check below already reports the structured failure synchronously.
    child.on('error', () => {});
    child.unref();
    if (child.pid == null) return { ok: false, error: 'spawn produced no pid' };
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isMainModule(): boolean {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const execPath = process.argv[2];
  const opts: LaunchMcpServerOptions = execPath ? { execPath } : {};

  if (process.platform === 'win32') {
    const result = launchMcpServerWindows(opts);
    if (!result.ok) {
      console.error(`Failed to launch the MCP server detached: ${result.error}\n${result.stderr}`);
      process.exit(1);
    }
    console.log(`MCP server launched (pid=${result.pid}); poll port ${MCP_SERVER_PORT} and ${resolveOptions(opts).logFile} to confirm it came up.`);
  } else {
    const result = launchMcpServerPosix(opts);
    if (!result.ok) {
      console.error(`Failed to launch the MCP server detached: ${result.error}`);
      process.exit(1);
    }
    console.log(`MCP server launched (pid=${result.pid}); poll port ${MCP_SERVER_PORT} and ${resolveOptions(opts).logFile} to confirm it came up.`);
  }
}
