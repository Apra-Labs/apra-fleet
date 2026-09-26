// config.mjs -- configuration resolution for the fleet-bridge composition
// root (bin/fleet-bridge.mjs).
//
// Governing rule (fleet-bridge-implementation-plan.md Part C): "the bridge
// ships with zero deployment-specific defaults... there is no machine-level
// or user-level config file: a runner shared by several projects must not
// carry ambient state that silently changes which tenant a sprint talks to."
//
// PRECEDENCE (Part C, "Configuration precedence"): CLI flag > environment
// variable > repo `bridge.config.json` (non-secret values only) > fail with a
// named error. A missing required value is CONFIG_MISSING, naming both the
// logical config name and the pipeline parameter that supplies it -- never a
// silent guess.
//
// This module never reads `process.env` or the real filesystem itself: `env`
// and the `readFile` used by `loadRepoConfig` both arrive via the caller
// (bin/fleet-bridge.mjs), per this package's injected-I/O rule -- the same
// rule every src/verbs/*.mjs module already follows.
//
// SECRETS: `bridge.config.json` may only ever carry a credential NAME (e.g.
// `secretName: "fleet_bridge_azdevops_pat"`), never a value -- this module does not enforce
// that (it has no way to tell a name from a value), but every caller in this
// package that resolves a `secretName`-shaped config entry only ever forwards
// it to `{{secret.NAME}}`-style interpolation (see beads-client.mjs,
// rest-client.mjs), never reads or logs it as a value.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';

/** The one repo-level config file this module reads. No machine/user-level
 *  equivalent exists -- see the module header. */
export const REPO_CONFIG_FILENAME = 'bridge.config.json';

/**
 * Reads and parses `<cwd>/bridge.config.json`. A missing file is NOT an
 * error -- the repo config layer is optional, and every value it could carry
 * still falls through to a CLI flag or env var. A PRESENT but malformed file
 * (bad JSON, or not a plain object) is CONFIG_INVALID: a broken config file
 * an operator forgot about is worth surfacing, not silently ignoring.
 *
 * @param {{ readFile: (path: string, encoding: string) => Promise<string> }} fs - injected.
 * @param {string} cwd
 * @returns {Promise<object>} plain object (possibly empty)
 * @throws {BridgeError} CONFIG_MISSING (no `fs` injected), CONFIG_INVALID (malformed file)
 */
export async function loadRepoConfig(fs, cwd) {
  if (!fs || typeof fs.readFile !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'loadRepoConfig requires an injected fs.readFile -- none was provided',
      { param: 'fs' }
    );
  }
  const base = String(cwd || '.').replace(/[/\\]+$/, '');
  const filePath = `${base}/${REPO_CONFIG_FILENAME}`;

  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `config: could not read ${filePath}: ${err && err.message ? err.message : String(err)}`,
      { path: filePath }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `config: ${filePath} is not valid JSON: ${err.message}`,
      { path: filePath }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `config: ${filePath} must contain a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`,
      { path: filePath }
    );
  }
  return parsed;
}

/**
 * Resolve one configuration value against the precedence chain: CLI flag >
 * env var > repo config (`sources.repoConfig[name]`) > `spec.default` > fail.
 *
 * @param {{
 *   name: string,                - logical config name; also the repoConfig key.
 *   flagName?: string,            - flags Map key (cli/args.mjs's parseArgs output). Defaults to `name`.
 *   envVar?: string,              - environment variable name; omit to skip the env tier entirely.
 *   pipelineParam?: string,       - named in the CONFIG_MISSING message. Defaults to `name`.
 *   required?: boolean,           - default true.
 *   default?: any,
 * }} spec
 * @param {{ flags: Map<string, any>, env: Record<string, string|undefined>, repoConfig: object }} sources
 * @returns {any}
 * @throws {BridgeError} CONFIG_MISSING if required and absent from every tier and no default.
 */
export function resolveConfigValue(spec, sources) {
  const {
    name,
    flagName = name,
    envVar,
    pipelineParam = name,
    required = true,
    default: defaultValue,
  } = spec || {};
  const { flags, env, repoConfig } = sources || {};

  if (flags && typeof flags.has === 'function' && flags.has(flagName)) {
    const v = flags.get(flagName);
    if (v !== undefined && v !== '') return v;
  }
  if (envVar && env && env[envVar] !== undefined && env[envVar] !== '') {
    return env[envVar];
  }
  if (repoConfig && Object.prototype.hasOwnProperty.call(repoConfig, name)) {
    const v = repoConfig[name];
    if (v !== undefined && v !== '') return v;
  }
  if (defaultValue !== undefined) return defaultValue;
  if (!required) return undefined;

  const settableVia = [`--${flagName}`];
  if (envVar) settableVia.push(`the ${envVar} environment variable`);
  settableVia.push(`"${name}" in ${REPO_CONFIG_FILENAME}`);

  throw new BridgeError(
    BRIDGE_ERROR_CODES.CONFIG_MISSING,
    `config: missing required value "${name}" (pipeline parameter: ${pipelineParam}). Set it via ${settableVia.join(', ')}.`,
    { name, flagName, envVar, pipelineParam }
  );
}

/**
 * Resolve a batch of configuration values against one shared precedence
 * chain. Fails fast on the first missing required value (in `specs` order) --
 * a caller wanting an "every missing value, all at once" report (like
 * preflight's own "run every check" style) should call
 * `resolveConfigValue` per entry itself and collect the individual failures.
 *
 * @param {Array<object>} specs - see `resolveConfigValue`'s `spec` shape.
 * @param {{ flags: Map, env: object, repoConfig: object }} sources
 * @returns {object} keyed by each spec's `name`
 * @throws {BridgeError} CONFIG_MISSING (the first missing required value)
 */
export function resolveConfig(specs, sources) {
  const out = {};
  for (const spec of specs) {
    out[spec.name] = resolveConfigValue(spec, sources);
  }
  return out;
}
