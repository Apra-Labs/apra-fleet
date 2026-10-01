/**
 * Bridge adapter registry (fleet-bridge-implementation-plan.md Part B).
 *
 * Modeled directly on apra-fleet-se/fleet-sprint/vcs-providers/index.mjs's
 * registerVcsProvider(): an explicit import manifest (no directory scan --
 * this package has no build-time readdir either), validate-at-registration
 * so a malformed adapter fails here rather than deep inside a preflight or
 * launch call where the error would mask the real failure, and typed errors
 * naming the offending field.
 *
 * ADDING AN ADAPTER IS: write one file next to this one exporting a
 * descriptor of the REQUIRED EXPORT SHAPE below, then add it to
 * BUILT_IN_ADAPTERS -- no other file under src/ changes. Out-of-tree/test
 * adapters can also register at runtime via registerBridgeAdapter(); the
 * same one-descriptor contract applies.
 *
 * REQUIRED EXPORT SHAPE:
 *   {
 *     name: string,                          // required, non-empty
 *     resolveRequest: Function,               // required
 *     ingest: Function,                       // required
 *     publishCarryOver: Function,              // required
 *     capabilities: () => {                   // required; invoked EXACTLY
 *       nativeBeadsSync: boolean,             // ONCE, here, at registration
 *       canCreateWorkItem: boolean,           // time. Its result is
 *       canComment: boolean,                  // validated then frozen, and
 *       supportsAttached: boolean,            // that frozen snapshot -- not
 *       maxJobMinutes: number|null,           // the live function -- is
 *     },                                      // what getBridgeAdapter()
 *                                              // returns.
 *     comment?: Function,                     // optional; rejected if
 *     setBuildStatus?: Function,              // present but not a function
 *     emitProgress?: Function,
 *   }
 *
 * LOCKSTEP RULES (mirroring how vcs-providers keeps `builders` and
 * `capabilitiesForHost` from drifting apart) -- both checked HERE, at
 * registration, never deferred to preflight:
 *   - capabilities().canComment === true requires a `comment` function.
 *   - capabilities().supportsAttached === true requires
 *     `maxJobMinutes === null || maxJobMinutes >= 120` -- an attached job
 *     holds a runner slot for the whole sprint, so a short job-minutes cap
 *     paired with "supports attached" would be a silently self-contradicting
 *     descriptor.
 *
 * SELECTION IS EXPLICIT BY NAME ONLY. No host sniffing anywhere in this
 * module -- the tracker (this registry) and the git host (vcs-providers'
 * registry) are not necessarily the same vendor, and guessing would be wrong
 * exactly when it matters.
 *
 * ASCII only.
 */

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { AzureDevOpsBridgeAdapter } from './azure-devops.mjs';

export const BRIDGE_ADAPTER_CONTRACT_VERSION = 1;

const REQUIRED_FUNCTIONS = Object.freeze(['resolveRequest', 'ingest', 'publishCarryOver', 'capabilities']);
const OPTIONAL_FUNCTIONS = Object.freeze(['comment', 'setBuildStatus', 'emitProgress', 'createWorkItem']);
const CAPABILITY_BOOLEAN_FIELDS = Object.freeze(['nativeBeadsSync', 'canCreateWorkItem', 'canComment', 'supportsAttached']);

/** The minimum `maxJobMinutes` an adapter may declare while also declaring
 *  `supportsAttached: true` -- see the lockstep rule above. */
const MIN_ATTACHED_JOB_MINUTES = 120;

// Explicit import manifest -- see the file-level doc comment. GitHub and
// Bitbucket adapters (Phases 4-5) are out of scope for this build and are not
// listed here; adding them later is exactly "write the file, add it to this
// array", nothing else in this module changes.
const BUILT_IN_ADAPTERS = [
  AzureDevOpsBridgeAdapter,
];

const registry = new Map();

/**
 * Validates the SHAPE of a capabilities() result (field presence/types).
 * The lockstep cross-field rules live in registerBridgeAdapter(), which also
 * has `impl` in scope to check `comment`'s presence.
 * @param {string} name
 * @param {any} caps
 */
function validateCapabilityShape(name, caps) {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ADAPTER_INVALID,
      `Bridge adapter "${name}": capabilities() must return an object`,
      { name, field: 'capabilities' }
    );
  }
  for (const field of CAPABILITY_BOOLEAN_FIELDS) {
    if (typeof caps[field] !== 'boolean') {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.ADAPTER_INVALID,
        `Bridge adapter "${name}": capabilities().${field} must be a boolean, got ${JSON.stringify(caps[field])}`,
        { name, field }
      );
    }
  }
  const { maxJobMinutes } = caps;
  const validMaxJobMinutes = maxJobMinutes === null || (Number.isInteger(maxJobMinutes) && maxJobMinutes > 0);
  if (!validMaxJobMinutes) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ADAPTER_INVALID,
      `Bridge adapter "${name}": capabilities().maxJobMinutes must be a positive integer or null, got ${JSON.stringify(maxJobMinutes)}`,
      { name, field: 'maxJobMinutes' }
    );
  }
}

/**
 * Register (or replace) an adapter implementation. Validates the descriptor
 * shape up front -- including calling capabilities() exactly once -- so a
 * malformed adapter fails at registration time rather than inside
 * preflight/ingest/launch, where the error would mask the real failure.
 *
 * @param {object} impl
 * @returns {string} the registered adapter name
 */
export function registerBridgeAdapter(impl) {
  if (!impl || typeof impl !== 'object' || typeof impl.name !== 'string' || !impl.name.trim()) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ADAPTER_INVALID,
      'Bridge adapter: must be an object with a non-empty string `name`',
      { field: 'name' }
    );
  }
  const { name } = impl;

  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof impl[fn] !== 'function') {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.ADAPTER_INVALID,
        `Bridge adapter "${name}": missing required function \`${fn}\``,
        { name, field: fn }
      );
    }
  }

  for (const fn of OPTIONAL_FUNCTIONS) {
    if (impl[fn] != null && typeof impl[fn] !== 'function') {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.ADAPTER_INVALID,
        `Bridge adapter "${name}": \`${fn}\` must be a function when present, got ${typeof impl[fn]}`,
        { name, field: fn }
      );
    }
  }

  // capabilities() is invoked EXACTLY ONCE, here. Its result is validated,
  // then frozen, and that frozen snapshot -- never the live impl.capabilities
  // function -- is what the registered entry exposes from this point on.
  const rawCaps = impl.capabilities();
  validateCapabilityShape(name, rawCaps);

  if (rawCaps.canComment === true && typeof impl.comment !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ADAPTER_INVALID,
      `Bridge adapter "${name}": capabilities().canComment is true but no \`comment\` function was provided`,
      { name, field: 'canComment' }
    );
  }
  // Same lockstep rule as canComment, and it exists because the opposite
  // shipped: this adapter advertised canCreateWorkItem:true for the whole of
  // Part B with NO createWorkItem function behind it -- a capability flag
  // with nothing under it, which reads as "supported" to every caller and
  // silently is not.
  if (rawCaps.canCreateWorkItem === true && typeof impl.createWorkItem !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ADAPTER_INVALID,
      `Bridge adapter "${name}": capabilities().canCreateWorkItem is true but no \`createWorkItem\` function was provided`,
      { name, field: 'canCreateWorkItem' }
    );
  }
  if (rawCaps.supportsAttached === true) {
    const okMaxJobMinutes = rawCaps.maxJobMinutes === null || rawCaps.maxJobMinutes >= MIN_ATTACHED_JOB_MINUTES;
    if (!okMaxJobMinutes) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.ADAPTER_INVALID,
        `Bridge adapter "${name}": capabilities().supportsAttached is true but maxJobMinutes (${rawCaps.maxJobMinutes}) is neither null nor >= ${MIN_ATTACHED_JOB_MINUTES}`,
        { name, field: 'supportsAttached' }
      );
    }
  }

  // Whitelist the five known capability fields to prevent mutable nested
  // objects from being reachable through a shallow freeze. Build the frozen
  // snapshot from exactly those keys; reject any extras.
  const knownKeys = ['nativeBeadsSync', 'canCreateWorkItem', 'canComment', 'supportsAttached', 'maxJobMinutes'];
  for (const key of Object.keys(rawCaps)) {
    if (!knownKeys.includes(key)) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.ADAPTER_INVALID,
        `Bridge adapter "${name}": capabilities() returned unexpected field "${key}" -- only ${knownKeys.join(', ')} are allowed`,
        { name, field: key, allowedFields: knownKeys }
      );
    }
  }
  const frozenCaps = Object.freeze({
    nativeBeadsSync: rawCaps.nativeBeadsSync,
    canCreateWorkItem: rawCaps.canCreateWorkItem,
    canComment: rawCaps.canComment,
    supportsAttached: rawCaps.supportsAttached,
    maxJobMinutes: rawCaps.maxJobMinutes,
  });
  const entry = Object.freeze({ ...impl, capabilities: () => frozenCaps });

  registry.set(name, entry);
  return name;
}

/**
 * @param {string} name
 * @returns {object} the registered adapter entry.
 * @throws {BridgeError} ADAPTER_UNKNOWN, listing every currently known name.
 */
export function getBridgeAdapter(name) {
  const entry = registry.get(name);
  if (!entry) {
    const known = listBridgeAdapters();
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ADAPTER_UNKNOWN,
      `Unknown bridge adapter "${name}". Known adapters: ${known.length ? known.join(', ') : '(none registered)'}`,
      { name, known }
    );
  }
  return entry;
}

/** @returns {string[]} every registered adapter name, in registration order. */
export function listBridgeAdapters() {
  return [...registry.keys()];
}

/** Clears the registry. Tests only -- production code never calls this. */
export function resetBridgeAdapters() {
  registry.clear();
}

for (const impl of BUILT_IN_ADAPTERS) registerBridgeAdapter(impl);

export { AzureDevOpsBridgeAdapter };
