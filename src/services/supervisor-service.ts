/**
 * Registration helpers for the 'fleet-supervisor' OS service -- the always-on
 * fleet-sprint supervisor (the sprint dashboard / HTTP API process), which is
 * registered independently of the apra-fleet MCP server's own service so it
 * survives reboots on its own.
 *
 * Canonical entry point: packages/apra-fleet-se/bin/serve.mjs in a source
 * checkout. The installer's workflow step (src/cli/workflow-assets.ts's
 * extractWorkflowSubsystemAssets) stages the whole packages/apra-fleet-se tree
 * under the 'fleet-sprint' built-in workflow name, so the INSTALLED location is
 * <FLEET_BASE>/workflows/fleet-sprint/bin/serve.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { WORKFLOWS_DIR } from '../cli/config.js';
import { SUPERVISOR_LOG_FILE_PATH } from '../paths.js';
import { getServiceManager } from './service-manager/index.js';

/** Installed fleet-sprint workflow directory -- the supervisor's WorkingDirectory. */
export const SUPERVISOR_WORKING_DIR = path.join(WORKFLOWS_DIR, 'fleet-sprint');

/** Installed path of the supervisor entry point. */
export const SUPERVISOR_SERVE_SCRIPT = path.join(SUPERVISOR_WORKING_DIR, 'bin', 'serve.mjs');

/**
 * Absolute path of a real `node` executable, or null when none can be found.
 *
 * systemd units, launchd plists and Windows scheduled tasks do NOT source the
 * operator's shell rc files, so a bare `node` in ExecStart fails outright when
 * node only exists on PATH via nvm/fnm/volta. The path must therefore be
 * resolved HERE, at install time (where the installer still has the operator's
 * PATH), and baked into the unit -- the same pattern install.ts already uses
 * for the MCP server's binaryPath. Never hardcode a version-specific nvm path.
 *
 * Order: the running interpreter when we are running under node (dev / npm
 * global install -- this is by definition the operator's active nvm node),
 * otherwise a PATH lookup.
 */
export function resolveNodeExecutable(): string | null {
  const execPath = process.execPath;
  // Under SEA, execPath is the apra-fleet binary, not node -- the name check
  // is what distinguishes the two without importing install.ts's isSea().
  if (execPath && /^node(\.exe)?$/i.test(path.basename(execPath))) {
    return execPath;
  }
  try {
    const lookup = process.platform === 'win32' ? 'where node' : 'command -v node';
    const out = execSync(lookup, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first) return first;
  } catch { /* node not on PATH */ }
  return null;
}

export interface SupervisorRegistrationResult {
  registered: boolean;
  /** Human-readable reason when registered === false. */
  reason?: string;
}

/**
 * Register (and start) the fleet-supervisor service. Non-fatal by contract:
 * every failure path returns a reason instead of throwing, mirroring the MCP
 * server's own "Service registration skipped: ..." behavior in install.ts.
 */
export async function registerSupervisorService(): Promise<SupervisorRegistrationResult> {
  if (!fs.existsSync(SUPERVISOR_SERVE_SCRIPT)) {
    return { registered: false, reason: `supervisor entry point not found at ${SUPERVISOR_SERVE_SCRIPT}` };
  }
  const nodePath = resolveNodeExecutable();
  if (!nodePath) {
    return { registered: false, reason: 'no node executable found on PATH (the supervisor service needs an absolute node path)' };
  }
  const mgr = await getServiceManager('fleet-supervisor');
  try {
    await mgr.register(nodePath, [SUPERVISOR_SERVE_SCRIPT], SUPERVISOR_LOG_FILE_PATH, {
      workingDirectory: SUPERVISOR_WORKING_DIR,
    });
  } catch (err) {
    return { registered: false, reason: (err as Error).message };
  }
  try {
    await mgr.start();
  } catch (err) {
    // Leave no half-registered unit behind, same as the MCP server step.
    try { await mgr.unregister(); } catch {}
    return { registered: false, reason: (err as Error).message };
  }
  return { registered: true };
}

/** Unregister the fleet-supervisor service. Idempotent and never throws. */
export async function unregisterSupervisorService(): Promise<void> {
  try {
    const mgr = await getServiceManager('fleet-supervisor');
    await mgr.unregister();
  } catch { /* not registered / unsupported platform */ }
}
