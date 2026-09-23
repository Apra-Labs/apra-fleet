// launch.mjs -- fleet-bridge-implementation-plan.md Part B, `fleet-bridge
// launch`, and section 7.1 ("the `--await-until` gate") for the outcome ->
// exit-colour mapping this module's result exists to carry.
//
// SEQUENCE:
//   1. `validateSprintRequest` (contracts.mjs) is the single source of
//      truth for what a launch may contain -- this module never re-derives
//      or loosens it.
//   2. `supervisorClient.postSprint(body)` -- `body` is built by
//      `buildPostSprintBody()`, the ONE place this module translates the
//      bridge's own platform-neutral SprintRequest vocabulary
//      (targetBranch/baseBranch/member/workItems/...) into the vocabulary
//      the supervisor actually validates
//      (packages/apra-fleet-se/src/supervisor/api.mjs's
//      validateLaunchRequest/launch: issue/branch/base/members/...) -- see
//      that function's own doc comment for the full mapping table and the
//      bridge-only fields it deliberately drops. `overrideRelaunchGate` is
//      included ONLY when the operator explicitly flagged it (see point 3
//      below). A 400/409 from the supervisor is already mapped by
//      supervisor-client.mjs into LAUNCH_INVALID / LAUNCH_CONFLICT /
//      LAUNCH_RELAUNCH_GATE with the server's own message intact; this
//      module never catches or rewraps those (point 4).
//   3. `makeSprintHandle` (contracts.mjs) builds the SprintHandle from the
//      launch response, the validated request, `now()`, and
//      `opts.syntheticRootId` -- which arrives here verbatim from
//      `runIngest`'s result (that field exists specifically so no
//      translation happens in this module; see ingest.mjs's own doc
//      comment on `syntheticRootId`). `makeSprintHandle` runs
//      `assertNoSecrets` before freezing (point 2) -- this module never
//      works around that by stashing anything secret on the handle itself.
//   4. `spool.write(handle)` -- persisted before the await gate runs, so a
//      caller that crashes mid-await still finds the handle on disk.
//   5. The `--await-until` gate: `opts.awaitUntil === 'launch'` skips it
//      ENTIRELY (zero supervisor calls at all -- the 201 already answered
//      that; see await-gate.mjs's own `spec.kind === 'launch'` short
//      circuit, which this module additionally never even reaches for).
//      Any other value (default `'plan-approved'`) is parsed via
//      `parseAwaitUntil` and run through `awaitMilestone` (await-gate.mjs).
//
//   6. The watcher check (`opts.watcher`, default `'daemon'`): confirm that
//      a live process -- in practice `fleet-bridge daemon` -- has CLAIMED this
//      sprint's handle in the spool launch just wrote. See "WHY LAUNCH
//      CONFIRMS A WATCHER" below.
//
// WHY LAUNCH CONFIRMS A WATCHER. In detached mode nothing in the launching
// process ever watches or finalizes the sprint: that is the daemon's job, and
// finalize is where carry-over is published. If no daemon is running -- or one
// is running as a different user, or against a different spool directory, so
// it never sees this handle -- the sprint runs for days, ends, and carry-over
// is simply never published. Nothing fails; nothing says so; the pipeline
// that launched it went green. So launch looks for positive evidence: a claim
// on THIS handle, in THIS spool, by a process `isAlive()` confirms. A daemon
// heartbeat file checked by preflight was considered and rejected: it proves
// "some daemon is up", not "a daemon can see this sprint", and the second is
// the part that actually goes wrong (wrong user, wrong spool dir). Missing
// evidence makes the result `watcher.ok: false`, which bin/ turns into a
// non-zero exit AFTER the handle has been printed, so the caller still has the
// sprint id. Recovery needs no special step: the daemon's startup scan claims
// every unclaimed handle it finds, so starting it later still watches and
// finalizes the sprint. `watcher: 'none'` is the explicit opt-out for an
// operator who will run `watch`/`finalize` by hand; it is logged loudly, never
// assumed.
//
// THE AWAIT OUTCOME DECIDES THE EXIT COLOUR (implementation-plan.md's
// "`--await-until`: the configurable hold", also restated in this
// package's build log): `reached` -> green; `terminal` before the milestone
// -> red, carrying the engine's own reason VERBATIM (never wrapped,
// reworded, or truncated); `timeout` -> green, "milestone not reached, now
// detached", and NEVER a stop. This module holds no stop/cancel capability
// in its `deps` at all (`deps = { supervisorClient, spool, sleep, now,
// log }` -- no way to issue one even if it wanted to), so "never a stop" is
// structural here, not merely observed. `runLaunch`'s result carries both
// the raw `awaited` outcome and a precomputed `color` field so `bin/` can
// make the exit-colour call without re-deriving it.
//
// THE ERROR RULE (fleet-bridge-build-log.md "The error rule"): every throw
// crossing this module's boundary is a BridgeError. A missing/malformed
// `opts` field is CONFIG_MISSING/CONFIG_INVALID; a missing injected
// dependency is CONFIG_MISSING (a permanent wiring defect, never a
// retryable code); the supervisor's own LAUNCH_INVALID / LAUNCH_CONFLICT /
// LAUNCH_RELAUNCH_GATE / SUPERVISOR_UNAVAILABLE / SUPERVISOR_UNAUTHORIZED
// propagate unchanged from supervisor-client.mjs and await-gate.mjs.
//
// Nothing here reaches for `process.env`, `node:fs`, or a real `fetch` --
// every collaborator (`supervisorClient`, `spool`, `sleep`, `now`, `log`)
// arrives via `deps`, per this package's injected-I/O rule.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { validateSprintRequest, parseAwaitUntil, makeSprintHandle } from '../contracts.mjs';
import { awaitMilestone } from '../await-gate.mjs';
import { DEFAULT_LOG_TAIL_LINES } from './watch.mjs';

const noopLog = () => {};

/** How long launch waits for a watcher to claim the handle by default: several
 *  of the daemon's own 10s scan intervals (daemon.mjs DEFAULT_SCAN_INTERVAL_MS),
 *  so one slow scan is not reported as "no daemon". */
export const DEFAULT_WATCHER_TIMEOUT_MS = 60 * 1000;
const WATCHER_POLL_MS = 2 * 1000;
export const WATCHER_MODES = Object.freeze(['daemon', 'none']);
/** Spool states only a watcher ever writes -- evidence one has already worked
 *  the sprint even if its claim was released by the time we looked. */
const WATCHER_WRITTEN_STATES = Object.freeze(['watching', 'finalizing', 'completed', 'failed']);

// ---------------------------------------------------------------------------
// Step 0: validate this verb's own inputs -- see ingest.mjs/finalize.mjs for
// the same split (a pure opts validator, a pure internal deps validator).
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes `runLaunch`'s `opts`. `opts.request` is run
 * through contracts.mjs's `validateSprintRequest` here (the single source
 * of truth for a launchable SprintRequest), not deferred to `runLaunch` --
 * mirroring ingest.mjs's own style of validating deeply inside the opts
 * validator rather than splitting that across two functions.
 *
 * @param {{
 *   request?: object,
 *   syntheticRootId: string,
 *   awaitUntil?: string,
 *   overrideRelaunchGate?: boolean,
 *   timeoutMs?: number,
 *   pollMs?: number,
 * }} opts
 * @returns {{
 *   request: object,
 *   syntheticRootId: string,
 *   awaitUntil: string|undefined,
 *   overrideRelaunchGate: boolean,
 *   timeoutMs: number|undefined,
 *   pollMs: number|undefined,
 * }} frozen, normalized
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
export function validateLaunchOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  if (!o.request || typeof o.request !== 'object' || Array.isArray(o.request)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'launch: opts.request is required (the raw SprintRequest fields to validate and post)',
      { field: 'request' }
    );
  }
  // validateSprintRequest (contracts.mjs) is this package's single source of
  // truth for a launchable SprintRequest; any CONFIG_MISSING/CONFIG_INVALID
  // it throws propagates unchanged.
  const request = validateSprintRequest(o.request);

  // syntheticRootId arrives here verbatim from runIngest's result -- see the
  // module header. REQUIRED, not optional: buildPostSprintBody() below has
  // no other source for the supervisor's required `issue` field (the CLI's
  // launch verb exposes no separate "root bead id" flag today -- launching
  // against a tracker-native epic with no synthetic root is presently
  // unsupported by this verb). Checked here, at validation time, rather than
  // left to surface only when the body is built or -- worse -- only when the
  // supervisor rejects an `issue: undefined` it was never given a name for:
  // this is the fix for the defect where a caller's missing
  // --synthetic-root-id silently posted `issue: undefined` and the
  // supervisor answered with its own opaque `Invalid issue id "undefined"`,
  // naming no bridge flag at all. buildPostSprintBody() below repeats an
  // equivalent check (belt and braces) so it stays safe to call directly
  // (as this package's tests do) without going through this validator.
  if (o.syntheticRootId === undefined) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'launch: opts.syntheticRootId is required -- pass --synthetic-root-id, which is exactly ' +
      'ingest\'s syntheticRootId output (e.g. "ado_toy-e3z"), so the supervisor has an issue root ' +
      'to launch against',
      { field: 'syntheticRootId' }
    );
  }
  if (typeof o.syntheticRootId !== 'string' || o.syntheticRootId.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'launch: opts.syntheticRootId must be a non-empty string when provided',
      { field: 'syntheticRootId' }
    );
  }
  const syntheticRootId = o.syntheticRootId;

  // Deliberately NOT defaulted here -- runLaunch compares this raw value
  // against 'launch' to decide whether the await gate runs at all, and only
  // defaults to 'plan-approved' inside the branch that actually needs a
  // parsed spec (see the module header, point 5).
  let awaitUntil;
  if (o.awaitUntil !== undefined) {
    if (typeof o.awaitUntil !== 'string' || o.awaitUntil.length === 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'launch: opts.awaitUntil must be a non-empty string when provided',
        { field: 'awaitUntil' }
      );
    }
    awaitUntil = o.awaitUntil;
  }

  // Forwarded ONLY when the operator explicitly passed true -- see the
  // module header, point 3. Any other value (undefined, false, a truthy
  // non-boolean) normalizes to false, which buildPostSprintBody() below
  // treats as "omit the key entirely", never "forward false".
  const overrideRelaunchGate = o.overrideRelaunchGate === true;

  let timeoutMs;
  if (o.timeoutMs !== undefined) {
    if (typeof o.timeoutMs !== 'number' || !Number.isFinite(o.timeoutMs) || o.timeoutMs < 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'launch: opts.timeoutMs must be a non-negative finite number when provided',
        { field: 'timeoutMs' }
      );
    }
    timeoutMs = o.timeoutMs;
  }

  let pollMs;
  if (o.pollMs !== undefined) {
    if (typeof o.pollMs !== 'number' || !Number.isFinite(o.pollMs) || o.pollMs <= 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'launch: opts.pollMs must be a positive finite number when provided',
        { field: 'pollMs' }
      );
    }
    pollMs = o.pollMs;
  }

  // Defaulted to 'daemon', the safe choice: see the module header, "WHY
  // LAUNCH CONFIRMS A WATCHER". Opting out must be an explicit 'none'.
  const watcher = o.watcher === undefined ? 'daemon' : o.watcher;
  if (!WATCHER_MODES.includes(watcher)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `launch: --watcher must be one of ${WATCHER_MODES.join(', ')} (got "${watcher}")`,
      { field: 'watcher' }
    );
  }

  let watcherTimeoutMs = DEFAULT_WATCHER_TIMEOUT_MS;
  if (o.watcherTimeoutMs !== undefined) {
    if (typeof o.watcherTimeoutMs !== 'number' || !Number.isFinite(o.watcherTimeoutMs) || o.watcherTimeoutMs < 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        'launch: opts.watcherTimeoutMs must be a non-negative finite number when provided',
        { field: 'watcherTimeoutMs' }
      );
    }
    watcherTimeoutMs = o.watcherTimeoutMs;
  }

  return Object.freeze({ request, syntheticRootId, awaitUntil, overrideRelaunchGate, timeoutMs, pollMs, watcher, watcherTimeoutMs });
}

/**
 * Validates `runLaunch`'s injected `deps`, defaulting `log` to a no-op. A
 * missing injected dependency is CONFIG_MISSING, never a connectivity code
 * -- see the error-rule corollary in fleet-bridge-build-log.md: "a missing
 * injected dependency is never SUPERVISOR_UNAVAILABLE".
 *
 * @param {{ supervisorClient?: object, spool?: object, sleep?: Function, now?: Function, log?: Function }} deps
 * @returns {{ supervisorClient: object, spool: object, sleep: Function, now: Function, log: Function }}
 * @throws {BridgeError} CONFIG_MISSING
 */
function validateLaunchDeps(deps, { watcher = 'daemon' } = {}) {
  const d = deps && typeof deps === 'object' ? deps : {};

  if (!d.supervisorClient || typeof d.supervisorClient.postSprint !== 'function' || typeof d.supervisorClient.getSprint !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'launch: deps.supervisorClient must expose postSprint() and getSprint() -- none was provided to runLaunch()',
      { param: 'deps.supervisorClient' }
    );
  }
  if (!d.spool || typeof d.spool.write !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'launch: deps.spool must expose write() -- none was provided to runLaunch()',
      { param: 'deps.spool' }
    );
  }
  if (typeof d.sleep !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'launch: deps.sleep is required (never a real timer -- the await gate polls through it)',
      { param: 'deps.sleep' }
    );
  }
  if (typeof d.now !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'launch: deps.now is required (injected clock)',
      { param: 'deps.now' }
    );
  }

  if (watcher === 'daemon' && (typeof d.spool.read !== 'function' || typeof d.isAlive !== 'function')) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'launch: the watcher check needs deps.spool.read() and deps.isAlive() -- without them it cannot tell whether a daemon claimed the sprint',
      { param: typeof d.spool.read !== 'function' ? 'deps.spool.read' : 'deps.isAlive' }
    );
  }

  return {
    supervisorClient: d.supervisorClient,
    spool: d.spool,
    sleep: d.sleep,
    now: d.now,
    isAlive: d.isAlive,
    log: typeof d.log === 'function' ? d.log : noopLog,
  };
}

// ---------------------------------------------------------------------------
// Step 2: the postSprint body -- the ONE translation from the bridge's
// SprintRequest vocabulary to the supervisor's own launch vocabulary.
// ---------------------------------------------------------------------------

/**
 * Builds the exact body `supervisorClient.postSprint()` receives.
 *
 * THE DEFECT THIS FIXES: the supervisor
 * (packages/apra-fleet-se/src/supervisor/api.mjs, `validateLaunchRequest`
 * and `launch`) does not speak SprintRequest at all -- it wants
 * `issue`/`branch`/`base`/`members`, and 400s with `[Arg Contract] Invalid
 * issue id "undefined"` on the very first live launch when those never
 * arrive. Previously this function spread the request verbatim and mapped
 * exactly one field (`patSecretName`), so every field the supervisor
 * actually validates arrived as `undefined`. The mapping is now explicit:
 *
 *   supervisor field | source
 *   -----------------|-----------------------------------------------------
 *   issue            | `syntheticRootId` (see below -- NOT `request.workItems`)
 *   branch           | `request.targetBranch`
 *   base             | `request.baseBranch`
 *   members          | `[request.member]` (the engine wants a list; a
 *                    | SprintRequest only ever carries one member)
 *   goal             | `request.goal` (pass through unchanged)
 *   maxCycles        | `request.maxCycles` (pass through unchanged)
 *   budget           | `request.budget` (pass through unchanged)
 *   requirementsFile | `request.requirementsFile` (pass through unchanged)
 *   overrideRelaunchGate | `overrideRelaunchGate` -- ONLY when exactly
 *                    | `true` (see below), never implicit
 *   vcs_pat_secret_name | `request.patSecretName` -- ONLY when present
 *                    | (unchanged from before this fix; see below)
 *
 * `issue` <- `syntheticRootId`, NOT `request.workItems`: `workItems` are
 * EXTERNAL TRACKER work-item numbers (e.g. "2,3,4" -- see
 * contracts.mjs's `assertValidTrackerRef`), not beads ids. Posting them as
 * `issue` would ask the engine to launch against issue roots that do not
 * exist. `syntheticRootId` is the actual bead id (e.g. "ado_toy-e3z") --
 * `runIngest`'s own `syntheticRootId` output, threaded through
 * `runLaunch`'s `opts.syntheticRootId` (the `--synthetic-root-id` flag) --
 * so it is the only correct source. A missing root throws below rather
 * than posting `issue: undefined` and letting the supervisor's own opaque
 * 400 stand in for a bridge-side config error.
 *
 * DELIBERATELY DROPPED, never forwarded: `platform`, `repo`, `workItems`,
 * `mode`, `triggeredBy`, `runUrl`. These are the bridge's own SprintRequest
 * concepts, not the supervisor's vocabulary -- the supervisor ignores
 * unknown keys today, so sending them is currently harmless, but they are
 * dropped anyway so a future supervisor version can never mistake one of
 * them for something it should interpret.
 *
 * `overrideRelaunchGate: true` is included ONLY when `overrideRelaunchGate`
 * is `true` -- never set implicitly (module header, point 3). The gate
 * exists to stop a second multi-day run on a failure that will recur;
 * silently overriding it defeats the guard, so a caller that never asked
 * for it must see no such key in the posted body at all, not merely a
 * falsy one.
 *
 * `request.patSecretName` (contracts.mjs's platform-neutral SprintRequest
 * field -- see KNOWN_REQUEST_KEYS' doc comment there for why it is neutral,
 * not `adoPatSecretName`) is renamed onto the sprint engine's own
 * `vcs_pat_secret_name` launch field (fleet-sprint/sprint-args.mjs's
 * KNOWN_ARG_KEYS) ONLY when present -- omitted entirely otherwise, so the
 * engine falls back to ITS OWN default (`azdevops_pat`) rather than ever
 * receiving an explicit `undefined`. This is the fix for the two-PAT-
 * consumer gap: the bridge's own `adoPatSecretName` (azure-devops.mjs,
 * `bd ado pull/push` / REST comments) and the engine's own PAT (this field,
 * for `provision_vcs_auth`) are configured SEPARATELY; without this mapping
 * the engine always reached for `azdevops_pat` regardless of what the
 * bridge was configured with. `request.patSecretName` itself is NEVER
 * forwarded under its own name -- only ever renamed onto the engine's key --
 * so `body` never carries a `*Secret*`-named key the supervisor could
 * mistake for anything but a NAME.
 *
 * @param {object} request - the frozen, validated SprintRequest
 * @param {string} syntheticRootId - the issue root to launch against
 *   (ingest's `syntheticRootId` output); REQUIRED
 * @param {boolean} overrideRelaunchGate
 * @returns {object} a plain (unfrozen) object suitable for JSON.stringify
 * @throws {BridgeError} CONFIG_MISSING if `syntheticRootId` is missing --
 *   see the module's error rule (header): a missing bridge-side input is
 *   always a caller-input error, never a value silently posted as
 *   `undefined` for the supervisor to reject with its own opaque message.
 */
export function buildPostSprintBody(request, syntheticRootId, overrideRelaunchGate) {
  if (typeof syntheticRootId !== 'string' || syntheticRootId.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'launch: no issue root to launch against -- pass --synthetic-root-id, which is exactly ' +
      'ingest\'s syntheticRootId output (e.g. "ado_toy-e3z"). The supervisor requires an `issue` ' +
      'field; without this the bridge would have to post `issue: undefined` and let the ' +
      'supervisor reject it with its own opaque "Invalid issue id \\"undefined\\"" error.',
      { field: 'syntheticRootId' }
    );
  }

  const body = {
    issue: syntheticRootId,
    branch: request.targetBranch,
    base: request.baseBranch,
    members: [request.member],
  };

  if (request.goal !== undefined) body.goal = request.goal;
  if (request.maxCycles !== undefined) body.maxCycles = request.maxCycles;
  if (request.budget !== undefined) body.budget = request.budget;
  if (request.requirementsFile !== undefined) body.requirementsFile = request.requirementsFile;

  if (overrideRelaunchGate === true) {
    body.overrideRelaunchGate = true;
  }
  if (request.patSecretName !== undefined) {
    // `vcs_pat_secret_name`, not `azdevops_pat_secret_name`: the engine's
    // public launch contract dropped the provider brand, because naming one
    // provider in a generic engine's public surface forces either a misnomer
    // or a breaking rename the day a second PAT-based provider appears. The
    // supervisor still accepts the old spelling for one release and answers
    // with a deprecation warning -- we send the canonical name so we never
    // trigger it. The engine's INTERNAL args key keeps its original name;
    // that is not a public surface and renaming it would be churn.
    body.vcs_pat_secret_name = request.patSecretName;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Step 5: the await outcome decides the exit colour.
// ---------------------------------------------------------------------------

/**
 * Maps an `awaitMilestone()` outcome (or the synthesized "the gate was
 * skipped entirely because `awaitUntil === 'launch'`" case, which this
 * module shapes identically) to the exit colour `bin/` must use -- see the
 * module header. `reached` and `timeout` are both green: a timeout NEVER
 * stops the sprint (this module holds no stop/cancel capability to call
 * even if it wanted to). `terminal` is red; the caller is expected to
 * surface `awaited.reason` verbatim, never reworded.
 *
 * @param {{ outcome: 'reached'|'terminal'|'timeout' }} awaited
 * @returns {'green'|'red'}
 */
export function colorForAwaitOutcome(awaited) {
  if (awaited && awaited.outcome === 'terminal') return 'red';
  return 'green';
}

// ---------------------------------------------------------------------------
// Step 6: the watcher check. See the module header, "WHY LAUNCH CONFIRMS A
// WATCHER".
// ---------------------------------------------------------------------------

/**
 * Polls the spool until a live process has claimed `sprintId`'s handle (or a
 * watcher-only state shows one already worked it), or `timeoutMs` elapses.
 * Never throws for "not claimed" -- that is an outcome, returned as data, so
 * the caller can still print the handle it just created.
 *
 * @param {string} sprintId
 * @param {{ spool: object, isAlive: Function, sleep: Function, now: Function }} d
 * @param {number} timeoutMs
 * @returns {Promise<{ mode: 'daemon', ok: boolean, claimedBy: {pid: any, host: any}|null, state: string|null, message: string }>}
 */
export async function confirmWatcher(sprintId, d, timeoutMs) {
  const deadline = d.now() + timeoutMs;
  let lastState = null;
  for (;;) {
    const doc = await d.spool.read(sprintId);
    lastState = doc && typeof doc.state === 'string' ? doc.state : null;
    const claim = doc && doc.claim;
    if (claim && d.isAlive(claim.pid, claim.host)) {
      return {
        mode: 'daemon',
        ok: true,
        claimedBy: { pid: claim.pid, host: claim.host },
        state: lastState,
        message: `sprint ${sprintId} is claimed by pid ${claim.pid} on ${claim.host}; it will be watched and finalized`,
      };
    }
    if (lastState && WATCHER_WRITTEN_STATES.includes(lastState)) {
      return {
        mode: 'daemon',
        ok: true,
        claimedBy: null,
        state: lastState,
        message: `sprint ${sprintId} is already in watcher state "${lastState}"`,
      };
    }
    if (d.now() >= deadline) break;
    await d.sleep(WATCHER_POLL_MS);
  }
  return {
    mode: 'daemon',
    ok: false,
    claimedBy: null,
    state: lastState,
    message:
      `no live process claimed sprint ${sprintId} within ${Math.round(timeoutMs / 1000)}s, so nothing will watch or `
      + 'finalize it and its carry-over will never be published. Start `fleet-bridge daemon` on this machine, as '
      + 'the same user and with the same --spool-dir as this launch; its startup scan claims every unclaimed handle, '
      + 'including this one, so nothing is lost. The sprint itself is running -- do not relaunch it.',
  };
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

/**
 * `fleet-bridge launch`: validates a SprintRequest, posts it to the
 * supervisor, persists the resulting SprintHandle to the spool, and --
 * unless the operator asked only for `awaitUntil: 'launch'` -- holds until
 * the requested milestone is reached, the sprint goes terminal first, or a
 * timeout elapses. See the file-level doc comment for the full sequence and
 * the outcome -> exit-colour mapping.
 *
 * @param {{
 *   request: object,
 *   syntheticRootId?: string,
 *   awaitUntil?: string,
 *   overrideRelaunchGate?: boolean,
 *   timeoutMs?: number,
 *   pollMs?: number,
 * }} opts
 * @param {{ supervisorClient: object, spool: object, sleep: Function, now: Function, log?: Function }} deps
 * @returns {Promise<{
 *   handle: object,
 *   awaited: { outcome: 'reached'|'terminal'|'timeout', milestone: string, reason: string|null, snapshot: any },
 *   color: 'green'|'red',
 * }>}
 * @throws {BridgeError} CONFIG_MISSING, CONFIG_INVALID, LAUNCH_INVALID,
 *   LAUNCH_CONFLICT, LAUNCH_RELAUNCH_GATE, SUPERVISOR_UNAVAILABLE,
 *   SUPERVISOR_UNAUTHORIZED -- all propagated unchanged from
 *   supervisor-client.mjs / await-gate.mjs, never rewrapped.
 */
export async function runLaunch(opts, deps) {
  const validated = validateLaunchOpts(opts);
  const d = validateLaunchDeps(deps, { watcher: validated.watcher });
  const { request, syntheticRootId, awaitUntil, overrideRelaunchGate, timeoutMs, pollMs } = validated;

  // 2. POST to the supervisor. 400 -> LAUNCH_INVALID, 409 -> LAUNCH_CONFLICT
  // / LAUNCH_RELAUNCH_GATE are already mapped by supervisor-client.mjs;
  // deliberately no try/catch here (module header, point 4).
  const body = buildPostSprintBody(request, syntheticRootId, overrideRelaunchGate);
  const response = await d.supervisorClient.postSprint(body);

  // 3. Build and persist the handle. makeSprintHandle() runs assertNoSecrets
  // before freezing (module header, point 2). assertNoSecrets rejects a key
  // purely by NAME (contracts.mjs's isSecretKey substring rule), regardless
  // of what it holds -- and `patSecretName` trips that rule by name alone,
  // even though its value is only ever a stored credential NAME, never a
  // value. It has already done its one job above (buildPostSprintBody read
  // it from `request` to build `body`); nothing downstream ever reads it
  // back off a persisted handle (watch/finalize only ever read
  // handle.request.member/platform/targetBranch/workItems), so it is
  // dropped here rather than weakening assertNoSecrets' key-name guard for
  // every other caller of that shared function (log-safe.mjs's redactor
  // included).
  const { patSecretName: _patSecretName, ...requestForHandle } = request;
  const handle = makeSprintHandle({
    launchResponse: response,
    request: requestForHandle,
    startedAt: d.now(),
    syntheticRootId,
  });

  // 4. Persist before the await gate runs.
  await d.spool.write(handle);

  // 5. The await-until gate -- skipped ENTIRELY (zero supervisor calls) when
  // the operator asked only for 'launch'.
  let awaited;
  if (awaitUntil === 'launch') {
    awaited = { outcome: 'reached', milestone: 'launch', reason: null, snapshot: null };
  } else {
    const spec = parseAwaitUntil(awaitUntil ?? 'plan-approved');
    awaited = await awaitMilestone(
      handle,
      spec,
      {
        supervisorClient: d.supervisorClient,
        sleep: d.sleep,
        now: d.now,
        fetchLogTail: typeof d.supervisorClient.getLog === 'function'
          ? (sprintId) => d.supervisorClient.getLog(sprintId, { tail: DEFAULT_LOG_TAIL_LINES })
          : undefined,
      },
      { timeoutMs, pollMs }
    );
  }

  const color = colorForAwaitOutcome(awaited);
  d.log(`[launch] sprint ${handle.sprintId} launched; awaitUntil=${awaitUntil ?? 'plan-approved'} outcome=${awaited.outcome} color=${color}`);

  // 6. The watcher check -- after the await gate, which usually takes minutes,
  // so a running daemon has long since claimed the handle and this returns on
  // its first read.
  let watcher;
  if (validated.watcher === 'none') {
    watcher = {
      mode: 'none',
      ok: true,
      claimedBy: null,
      state: null,
      message: `--watcher none: nothing will watch or finalize sprint ${handle.sprintId} unless you run `
        + `"fleet-bridge watch --sprint-id ${handle.sprintId}" and then "fleet-bridge finalize --sprint-id ${handle.sprintId}" `
        + 'yourself. Carry-over is published only by finalize.',
    };
    d.log(`[launch] WARNING: ${watcher.message}`);
  } else {
    watcher = await confirmWatcher(handle.sprintId, d, validated.watcherTimeoutMs);
    d.log(watcher.ok ? `[launch] watcher: ${watcher.message}` : `[launch] ERROR: ${watcher.message}`);
  }

  return Object.freeze({ handle, awaited, color, watcher });
}

export default runLaunch;
