// Error definitions for the fleet bridge.
// Codes and exit codes for the command-line interface.

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export const BRIDGE_ERROR_CODES = Object.freeze({
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  PREFLIGHT_UNAVAILABLE: 'PREFLIGHT_UNAVAILABLE',
  INGEST_NO_CHILDREN: 'INGEST_NO_CHILDREN',
  INGEST_MISSING_CRITERIA: 'INGEST_MISSING_CRITERIA',
  INGEST_PULL_FAILED: 'INGEST_PULL_FAILED',
  INGEST_REF_AMBIGUOUS: 'INGEST_REF_AMBIGUOUS',
  LAUNCH_INVALID: 'LAUNCH_INVALID',
  LAUNCH_CONFLICT: 'LAUNCH_CONFLICT',
  LAUNCH_RELAUNCH_GATE: 'LAUNCH_RELAUNCH_GATE',
  LAUNCH_FAILED: 'LAUNCH_FAILED',
  WATCH_LOST: 'WATCH_LOST',
  FINALIZE_NOT_TERMINAL: 'FINALIZE_NOT_TERMINAL',
  CARRYOVER_LIMIT: 'CARRYOVER_LIMIT',
  CARRYOVER_PUBLISH_FAILED: 'CARRYOVER_PUBLISH_FAILED',
  SUPERVISOR_UNAVAILABLE: 'SUPERVISOR_UNAVAILABLE',
  SUPERVISOR_UNAUTHORIZED: 'SUPERVISOR_UNAUTHORIZED',
  BEADS_FAILED: 'BEADS_FAILED',
  BEADS_BARE_SYNC_REFUSED: 'BEADS_BARE_SYNC_REFUSED',
  CONFIG_MISSING: 'CONFIG_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',
  ADAPTER_UNKNOWN: 'ADAPTER_UNKNOWN',
  ADAPTER_INVALID: 'ADAPTER_INVALID',
  USAGE: 'USAGE',
  // A verb read a CLI flag its own VERB_FLAGS entry (src/cli/flags.mjs) does
  // not declare. Never caused by the operator's input -- the command line has
  // already been checked against the same table -- so it is a wiring defect
  // in this package, bucketed with the other internal/tooling defects.
  FLAG_UNDECLARED: 'FLAG_UNDECLARED',
});

export function exitCodeFor(codeOrError) {
  let code;
  if (codeOrError instanceof BridgeError) {
    code = codeOrError.code;
  } else if (typeof codeOrError === 'string') {
    code = codeOrError;
  } else {
    return 1;
  }

  // Exit code meanings:
  // 1 = unrecognized error or plain Error (catch-all)
  // 2 = usage/configuration error (caller provided invalid input or missing required config)
  // 3 = preflight check failure (environment/setup issue detected)
  // 4 = ingest phase failure (work item ingestion problem)
  // 5 = launch phase failure (sprint launch problem)
  // 6 = finalize/carryover failure (sprint conclusion issue)
  // 7 = launch conflict (detected relaunch/conflict scenario)
  // 8 = infrastructure/connectivity (supervisor unavailable, watch lost, authorization denied)
  // 9 = internal/tooling defect (beads invocation failed, sync refused, adapter invalid)
  switch (code) {
    case BRIDGE_ERROR_CODES.USAGE:
    case BRIDGE_ERROR_CODES.CONFIG_MISSING:
    case BRIDGE_ERROR_CODES.CONFIG_INVALID:
    case BRIDGE_ERROR_CODES.ADAPTER_UNKNOWN:
      return 2;

    case BRIDGE_ERROR_CODES.PREFLIGHT_FAILED:
    case BRIDGE_ERROR_CODES.PREFLIGHT_UNAVAILABLE:
      return 3;

    case BRIDGE_ERROR_CODES.INGEST_NO_CHILDREN:
    case BRIDGE_ERROR_CODES.INGEST_MISSING_CRITERIA:
    case BRIDGE_ERROR_CODES.INGEST_PULL_FAILED:
    case BRIDGE_ERROR_CODES.INGEST_REF_AMBIGUOUS:
      return 4;

    case BRIDGE_ERROR_CODES.LAUNCH_INVALID:
    case BRIDGE_ERROR_CODES.LAUNCH_FAILED:
    case BRIDGE_ERROR_CODES.LAUNCH_RELAUNCH_GATE:
      return 5;

    case BRIDGE_ERROR_CODES.LAUNCH_CONFLICT:
      return 7;

    case BRIDGE_ERROR_CODES.FINALIZE_NOT_TERMINAL:
    case BRIDGE_ERROR_CODES.CARRYOVER_LIMIT:
    case BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED:
      return 6;

    case BRIDGE_ERROR_CODES.WATCH_LOST:
    case BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE:
    case BRIDGE_ERROR_CODES.SUPERVISOR_UNAUTHORIZED:
      return 8;

    case BRIDGE_ERROR_CODES.BEADS_FAILED:
    case BRIDGE_ERROR_CODES.BEADS_BARE_SYNC_REFUSED:
    case BRIDGE_ERROR_CODES.ADAPTER_INVALID:
    case BRIDGE_ERROR_CODES.FLAG_UNDECLARED:
      return 9;

    default:
      return 1;
  }
}
