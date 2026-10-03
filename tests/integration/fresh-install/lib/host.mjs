// Pure driver-selection and host opt-in logic for the fresh-install harness.
// No side effects on import: unit-tested by host-baseline.test.ts.
//
// The `host` driver runs a pass directly on the current machine: it installs
// apra-fleet into the real home, registers a real service, installs Node.js
// and removes nothing afterwards. It is meant only for disposable machines
// (GitHub hosted runners), so it refuses unless BOTH CI=true and the explicit
// flag are given -- a loud refusal, never a warning.

export const PLATFORMS = Object.freeze(['windows', 'linux', 'macos']);
export const DRIVERS = Object.freeze(['sandbox', 'docker', 'host']);
export const HOST_OPT_IN_FLAG = '--i-am-disposable';

/** Harness platform name for a Node `process.platform` value, or null. */
export function platformOf(nodePlatform) {
  return { win32: 'windows', linux: 'linux', darwin: 'macos' }[nodePlatform] ?? null;
}

/**
 * Resolve { platform, driver } from the CLI options and the host OS.
 * Defaults: windows -> sandbox, linux -> docker, macos -> host (no other
 * isolation exists for it). Throws with a user-facing message on a bad combo.
 */
export function selectDriver({ driver, platform, hostPlatform }) {
  if (driver !== undefined && !DRIVERS.includes(driver)) throw new Error(`--driver must be one of ${DRIVERS.join('|')}`);
  const plat = platform ?? (driver === 'host' ? hostPlatform : undefined);
  if (!PLATFORMS.includes(plat)) throw new Error(`--platform must be one of ${PLATFORMS.join('|')}`);
  const drv = driver ?? { windows: 'sandbox', linux: 'docker', macos: 'host' }[plat];
  if (drv === 'sandbox' && plat !== 'windows') throw new Error('the sandbox driver (Windows Sandbox) only runs the windows platform');
  if (drv === 'docker' && plat !== 'linux') throw new Error('the docker driver (ubuntu:24.04 container) only runs the linux platform');
  if (drv === 'host' && plat !== hostPlatform) {
    throw new Error(`the host driver runs passes on this machine, which is ${hostPlatform ?? 'an unsupported OS'}; --platform ${plat} does not match`);
  }
  return { platform: plat, driver: drv };
}

/**
 * Refuse the host driver unless the operator stated, twice, that this machine
 * is disposable: env CI=true AND --i-am-disposable. Also refuses more than one
 * pass per run (passes assume a fresh machine and the host is never reset) and
 * a machine that already has an apra-fleet install.
 * Returns null when allowed, else the refusal message.
 */
export function hostRefusal({ env = {}, optInFlag = false, passes = [], fleetHomeExists = false, fleetHome = '~/.apra-fleet' }) {
  const why = [];
  if (env.CI !== 'true') why.push('env CI is not "true"');
  if (!optInFlag) why.push(`${HOST_OPT_IN_FLAG} was not passed`);
  if (why.length) {
    return `REFUSED: the host driver installs apra-fleet, a service and Node.js onto THIS machine and never cleans up; it only runs on a disposable CI VM (${why.join('; ')}). Set CI=true and pass ${HOST_OPT_IN_FLAG} only on a throwaway machine.`;
  }
  if (passes.length !== 1) {
    return `REFUSED: the host driver runs exactly one pass per fresh machine (got ${passes.length}: ${passes.join(',')}); passes assume a clean box and the host is not reset between them. Run one job per pass.`;
  }
  if (fleetHomeExists) {
    return `REFUSED: ${fleetHome} already exists, so this machine is not fresh; the host driver needs a machine that never had apra-fleet installed.`;
  }
  return null;
}

const NODE_NAMES = ['node', 'node.exe', 'npm', 'npm.cmd'];

/**
 * Drop every PATH entry that holds node or npm, so a pass sees a machine
 * without Node.js (hosted runners preinstall it). `exists(file)` is injected.
 * Returns { path, dropped }.
 */
export function scrubNodeFromPath(pathValue, { sep, join, exists }) {
  const kept = [];
  const dropped = [];
  for (const dir of String(pathValue ?? '').split(sep)) {
    if (!dir) continue;
    if (NODE_NAMES.some(n => exists(join(dir, n)))) dropped.push(dir);
    else kept.push(dir);
  }
  return { path: kept.join(sep), dropped };
}

/**
 * Environment for an in-box pass on the host: the caller's env with Node
 * scrubbed from PATH and the CI markers removed. Real users do not have CI
 * set, and tools the product installs change behaviour under it (the
 * @beads/bd postinstall skips its binary download when CI is set).
 */
export function hostPassEnv(env, scrubbedPath) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (/^(CI|CONTINUOUS_INTEGRATION|NODE_OPTIONS|npm_.*)$/i.test(k)) delete out[k];
    else if (/^path$/i.test(k)) delete out[k];
  }
  out[Object.keys(env).find(k => /^path$/i.test(k)) ?? 'PATH'] = scrubbedPath;
  return out;
}
