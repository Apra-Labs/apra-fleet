// CLI argument parsing for fleet-bridge.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';

/**
 * The authoritative list of verbs that fleet-bridge supports (or will support).
 * Exported so that bin/fleet-bridge.mjs and tests can reference the same list.
 */
export const VERBS = [
  'preflight',
  'ingest',
  'launch',
  'watch',
  'finalize',
  'status',
  'daemon',
  'viewer',
];

export const USAGE_TEXT = `Usage: fleet-bridge <verb> [options]

Verbs:
  preflight   Verify prerequisites and connectivity
  ingest      Ingest work items from a platform
  launch      Launch a new sprint
  watch       Monitor sprint progress
  finalize    Finalize and publish sprint results
  status      Get current sprint status
  daemon      Run the bridge as a background service
  viewer      Start the web viewer for sprint results

Remote observability (watch, daemon, finalize):
  --blob-account-url <url>   Azure Storage account URL, e.g. https://<account>.blob.core.windows.net
  --blob-container <name>    Container that receives <sprintId>.jsonl and sprints/<sprintId>/

  Set BOTH to enable the append-blob progress sink and the finalize archive
  export, or NEITHER to run with the local JSONL sink only. Setting one alone
  is a startup error, not a silent downgrade. Equivalent environment
  variables: FLEET_BRIDGE_BLOB_ACCOUNT_URL, FLEET_BRIDGE_BLOB_CONTAINER;
  equivalent bridge.config.json keys: blobAccountUrl, blobContainer.

  FLEET_BRIDGE_BLOB_SAS      (env var ONLY) container SAS with create+write
                             permission. Deliberately not a flag and not a
                             config-file key: a SAS is a live credential and
                             must never reach argv or a committed file.
                             See docs/setup.md for the exact SAS to mint.

  Enabling blob storage never disables the local JSONL sink -- the local file
  stays the record of last resort when a remote write fails.
`;

/**
 * Parse raw argv into {verb, flags, positionals}.
 * Supports --flag value, --flag=value, boolean --flag, --no-flag, and -- passthrough.
 * Unknown flags are NOT rejected here (verbs validate their own).
 *
 * @param {string[]} argv - raw argument array (process.argv.slice(2) or similar)
 * @returns {{verb: string, flags: Map<string, any>, positionals: string[]}}
 */
export function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  let verb;
  let passthroughStartIndex = -1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Handle passthrough marker
    if (arg === '--') {
      passthroughStartIndex = i + 1;
      break;
    }

    // Handle flags
    if (arg.startsWith('--')) {
      // --no-flag to negate a boolean
      if (arg.startsWith('--no-')) {
        const flagName = arg.slice('--no-'.length);
        flags.set(flagName, false);
        continue;
      }

      // --flag=value form
      if (arg.includes('=')) {
        const [flagName, ...valueParts] = arg.slice('--'.length).split('=');
        const value = valueParts.join('=');
        flags.set(flagName, value.length === 0 ? true : value);
        continue;
      }

      // --flag form (may or may not have a value following)
      const flagName = arg.slice('--'.length);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        // Peek ahead: if next arg doesn't start with --, treat it as the value
        i++;
        flags.set(flagName, argv[i]);
      } else {
        // Boolean flag
        flags.set(flagName, true);
      }
      continue;
    }

    // Positional argument
    if (!verb) {
      verb = arg;
    } else {
      positionals.push(arg);
    }
  }

  // Add passthrough args to positionals
  if (passthroughStartIndex >= 0) {
    positionals.push(...argv.slice(passthroughStartIndex));
  }

  return {
    verb,
    flags,
    positionals,
  };
}

/**
 * Require a flag to be present and non-empty; coerce to the specified type.
 * Throws BridgeError naming both the flag and the pipeline parameter.
 *
 * @param {Map<string, any>} flags - from parseArgs().flags
 * @param {string} name - flag name (without --)
 * @param {{as?: 'string'|'int'|'number'|'bool', pipelineParam?: string}} options
 * @returns {any} coerced value
 * @throws {BridgeError} CONFIG_MISSING if absent or empty
 */
export function requireFlag(flags, name, options = {}) {
  const { as = 'string', pipelineParam = name } = options;

  const value = flags.get(name);
  if (value === undefined || value === '' || value === null) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      `Missing required flag --${name} (pipeline parameter: ${pipelineParam})`,
      { flag: name, pipelineParam }
    );
  }

  // Coerce to the requested type
  switch (as) {
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `Invalid boolean flag --${name}: must be 'true' or 'false'`,
        { flag: name }
      );

    case 'int':
      const intVal = Number.parseInt(value, 10);
      if (Number.isNaN(intVal)) {
        throw new BridgeError(
          BRIDGE_ERROR_CODES.CONFIG_INVALID,
          `Invalid integer flag --${name}: got "${value}"`,
          { flag: name }
        );
      }
      return intVal;

    case 'number':
      const numVal = Number.parseFloat(value);
      if (Number.isNaN(numVal)) {
        throw new BridgeError(
          BRIDGE_ERROR_CODES.CONFIG_INVALID,
          `Invalid number flag --${name}: got "${value}"`,
          { flag: name }
        );
      }
      return numVal;

    case 'string':
    default:
      return String(value);
  }
}
