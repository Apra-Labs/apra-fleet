/**
 * Registration helpers for the 'fleet-supervisor' OS service -- the always-on
 * fleet-sprint supervisor (the sprint dashboard / HTTP API process), which is
 * registered independently of the apra-fleet MCP server's own service so it
 * survives reboots on its own.
 *
 * WHAT THE UNIT RUNS: the installed apra-fleet binary's own `supervisor`
 * subcommand -- `<BIN_DIR>/apra-fleet supervisor`, ONE argument, no `node` and
 * no serve.mjs path anywhere in the unit. src/cli/supervisor.ts's runSupervisor()
 * resolves and boots the installed serve.mjs on the binary's embedded runtime.
 *
 * Why it is no longer `node <installed>/bin/serve.mjs`: that shape needed a real
 * `node` on PATH at install time, resolved by a node-resolution helper this
 * module used to own. Under the released SEA binary process.execPath IS the
 * apra-fleet binary rather than node, so that helper fell through to a PATH
 * lookup and returned null on a clean Windows machine -- which is precisely why
 * the supervisor was never registered there. Pointing the unit at the binary's
 * own subcommand removes the external-runtime dependency outright.
 *
 * The installed tree is still probed before registering: the binary's subcommand
 * needs <FLEET_BASE>/workflows/fleet-sprint/bin/serve.mjs to exist, so a unit
 * pointing at an absent tree is still a failure, not a success.
 *
 * EVERY not-registered outcome here is a LOUD install failure at the call site
 * (src/cli/install.ts) -- a registered-looking install whose supervisor unit was
 * silently skipped is the exact bug this replaces. The one legitimate skip,
 * `install --workflows none`, is decided by the caller and never reaches this
 * function.
 */
import fs from 'node:fs';
import { SUPERVISOR_LOG_FILE_PATH, isNonDefaultInstance } from '../paths.js';
import { SUPERVISOR_SERVE_SCRIPT, SUPERVISOR_WORKING_DIR } from '../cli/supervisor.js';
import { getServiceManager } from './service-manager/index.js';

/**
 * Platforms getServiceManager() has a REAL service manager for. Anything else
 * gets NoopServiceManager, whose register()/start() resolve without doing
 * anything -- a silent success that would report a supervisor which does not
 * exist, so it is rejected up front instead.
 */
const SERVICE_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(['win32', 'linux', 'darwin']);

/** The single argument the registered unit passes to the apra-fleet binary. */
export const SUPERVISOR_SUBCOMMAND = 'supervisor';

export interface SupervisorRegistrationResult {
  registered: boolean;
  /** Human-readable reason when registered === false. Always set in that case. */
  reason?: string;
}

/**
 * Register (and start) the fleet-supervisor service as
 * `<binaryPath> supervisor`.
 *
 * @param binaryPath absolute path of the INSTALLED apra-fleet binary
 *   (install.ts's binaryPath: <BIN_DIR>/apra-fleet or apra-fleet.exe).
 * @returns registered: true, or registered: false plus the reason the caller
 *   must surface as a loud, non-zero install failure.
 */
export async function registerSupervisorService(
  binaryPath: string,
): Promise<SupervisorRegistrationResult> {
  if (!SERVICE_CAPABLE_PLATFORMS.has(process.platform)) {
    return {
      registered: false,
      reason:
        `OS service management is not supported on platform '${process.platform}' ` +
        `(supported: linux, darwin, win32), so the supervisor cannot be registered to survive a reboot`,
    };
  }

  // A machine-global unit records no APRA_FLEET_DATA_DIR / APRA_FLEET_PORT, so it
  // would boot the supervisor against the DEFAULT instance while this operator
  // installed an overridden one -- a unit that silently serves the wrong data.
  if (isNonDefaultInstance()) {
    return {
      registered: false,
      reason:
        'this install overrides APRA_FLEET_DATA_DIR or APRA_FLEET_PORT, but the fleet-supervisor ' +
        'service is machine-global and would run against the DEFAULT instance. Install without ' +
        'those overrides to register the supervisor, or run it in the foreground with ' +
        "'apra-fleet supervisor'",
    };
  }

  if (!binaryPath) {
    return {
      registered: false,
      reason:
        'the installed apra-fleet binary path is empty, so the service unit would have no ' +
        'executable to run',
    };
  }

  if (!fs.existsSync(SUPERVISOR_SERVE_SCRIPT)) {
    return {
      registered: false,
      reason: `supervisor entry point not found at ${SUPERVISOR_SERVE_SCRIPT} (bin/serve.mjs is missing from the installed fleet-sprint tree)`,
    };
  }

  const mgr = await getServiceManager('fleet-supervisor');
  try {
    await mgr.register(binaryPath, [SUPERVISOR_SUBCOMMAND], SUPERVISOR_LOG_FILE_PATH, {
      workingDirectory: SUPERVISOR_WORKING_DIR,
    });
  } catch (err) {
    return { registered: false, reason: (err as Error).message };
  }
  try {
    await mgr.start();
  } catch (err) {
    // Leave no half-registered unit behind: a unit that exists but was never
    // started is the worst of both worlds, since `status` would report it
    // installed while nothing is serving.
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
