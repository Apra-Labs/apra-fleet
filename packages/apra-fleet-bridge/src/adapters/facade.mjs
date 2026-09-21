// facade.mjs -- the per-sprint adapter facade called out in
// fleet-bridge-build-log.md's "adapter.comment has three incompatible
// signatures" entry. Read that entry first; this file is its resolution.
//
// THE PROBLEM (recap): three modules each built and tested `comment()`
// against their own fake, and each passed:
//
//   adapters/azure-devops.mjs (the real registry adapter) assumes
//     comment({resolved, workItemId, body}, {restClient})
//   verbs/watch.mjs assumes
//     comment(markdownText) on a per-sprint-bound object
//   verbs/finalize.mjs assumed
//     adapter.comment() targeting handle.request.workItems[0] itself
//
// None of the three work against either of the others. This is the third
// producer/consumer gap on this branch (after adapter.ingest's unpinned
// return shape and snapshot's non-existent progress fields) and it arose
// the same way: two modules, two fakes, never tested together.
//
// THE FIX: watch.mjs's assumption was the one worth generalizing --
// `comment(markdown)` on an object already bound to one sprint is exactly
// the small conceptual surface both verbs want. This module builds that
// object. It wraps the REAL registry adapter (adapters/azure-devops.mjs,
// reached through adapters/index.mjs's registry -- never reimplemented or
// forked here), binds `resolved`/`handle`/`restClient`/`beads` ONCE at
// construction time, and exposes:
//
//   emitProgress(snapshot)          -- passthrough to adapter.emitProgress,
//                                      if the adapter has one; a logged
//                                      no-op otherwise.
//   comment(markdown)               -- the unified shape. Builds the real
//                                      adapter's {resolved, workItemId,
//                                      body} call internally; degrades to a
//                                      logged no-op when the adapter's own
//                                      capabilities().canComment is false,
//                                      and never throws (a REST failure is
//                                      caught and logged, never rethrown --
//                                      see "COMMENT NEVER THROWS" below).
//   setBuildStatus(state, url)      -- optional passthrough; a logged no-op
//                                      when the adapter has none.
//   ingest(opts, deps)              -- passthrough to adapter.ingest, using
//                                      the facade-bound `beads` as the
//                                      default `deps.beads` when the caller
//                                      does not supply its own. The pinned
//                                      call shape (adapters/azure-devops.mjs's
//                                      header, "Pinned contracts between
//                                      units" in the build log) is untouched.
//   publishCarryOver(opts, deps)    -- same passthrough treatment.
//   capabilities()                  -- the adapter's own frozen snapshot,
//                                      unchanged (adapters/index.mjs already
//                                      freezes it at registration).
//   targetWorkItem                  -- the work item this facade resolved
//                                      once at construction (see
//                                      resolveTargetWorkItem() below); a
//                                      read-only fact, exposed mainly so a
//                                      caller (or a test) can confirm two
//                                      facades built from the same
//                                      handle/resolved agree.
//
// WHO BUILDS THIS: the wiring layer (daemon.mjs, built alongside this file
// by another unit of this branch -- see this package's build-log for the
// "other agents are editing daemon.mjs" note) constructs exactly one facade
// per sprint and hands it to runWatch/runFinalize as `deps.adapter`. The
// registry adapter itself (adapters/azure-devops.mjs) is never handed to a
// verb directly -- verbs only ever see this facade. `adapters/azure-devops.mjs`
// is NOT modified by this file; its three exported signatures
// (`comment({resolved, workItemId, body}, {restClient})`,
// `setBuildStatus(...)`, `ingest`/`publishCarryOver`) stay exactly as they
// are. This facade is the ONLY caller that is allowed to know that shape.
//
// -----------------------------------------------------------------------------
// WORK-ITEM TARGETING -- THE SECOND HALF OF THE SAME BUG
// -----------------------------------------------------------------------------
// Before this file, `finalize` picked `handle.request.workItems[0]` itself
// and `watch` never decided at all -- two verbs, potentially two different
// answers, or one verb with no answer. Both now get the same answer because
// there is exactly one place the choice is made: resolveTargetWorkItem()
// below, computed once at construction and reused by every comment() call
// this facade ever makes for this sprint.
//
// The FIRST work item is the right one: contracts.mjs's validateSprintRequest
// requires `workItems` to be a non-empty array, and workItems[0] is already
// the external tracker ref an operator recognizes from the pipeline trigger
// -- the "root" work item the sprint was launched against. This is exactly
// finalize.mjs's prior rule (see its previous postFinalComment doc comment),
// now generalized to watch as well instead of being finalize's private
// assumption.
//
// -----------------------------------------------------------------------------
// COMMENT NEVER THROWS
// -----------------------------------------------------------------------------
// A comment is a reporting side-effect, never a gate. `verbs/finalize.mjs`'s
// module header states this for carry-over: "a failed comment must not roll
// it back". `verbs/watch.mjs` states the equivalent for a two-day
// observation run: "a failing comment API must never end a two-day
// observation run." This facade is now the single place that guarantee is
// implemented, so neither verb has to reimplement its own try/catch around
// the adapter call -- comment() (and setBuildStatus(), and emitProgress())
// catch and log internally and resolve, never reject.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';

const noopLog = () => {};

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * The one place the target work item is decided -- see the file header's
 * "WORK-ITEM TARGETING" section. Prefers `handle.request.workItems` (the
 * SprintHandle written by launch -- the authoritative record of what this
 * sprint actually launched against) and falls back to
 * `resolved.sprintRequest.workItems` (the registry adapter's own
 * resolveRequest() output) when no handle was supplied. Returns `null`,
 * never throws, when neither source has one: a facade with no resolvable
 * target is a degraded facade (comment() logs and no-ops), not a
 * construction failure -- a bad/missing handle must never stop a sprint's
 * progress from being observed or its carry-over from being published.
 *
 * @param {{ resolved?: object, handle?: object }} ctx
 * @returns {string|number|null}
 */
export function resolveTargetWorkItem({ resolved, handle } = {}) {
  const handleWorkItems = handle && handle.request && Array.isArray(handle.request.workItems)
    ? handle.request.workItems
    : null;
  if (handleWorkItems && handleWorkItems.length > 0) {
    const first = handleWorkItems[0];
    if (first !== undefined && first !== null && first !== '') return first;
  }

  const resolvedWorkItems = resolved && resolved.sprintRequest && Array.isArray(resolved.sprintRequest.workItems)
    ? resolved.sprintRequest.workItems
    : null;
  if (resolvedWorkItems && resolvedWorkItems.length > 0) {
    const first = resolvedWorkItems[0];
    if (first !== undefined && first !== null && first !== '') return first;
  }

  return null;
}

/**
 * Builds the per-sprint adapter facade. See the file header for the full
 * rationale; this is the wiring layer's one entry point into this module.
 *
 * @param {{
 *   adapter: object,        - the real registry adapter (adapters/index.mjs's
 *                              getBridgeAdapter() entry). Required.
 *   resolved?: object,      - the adapter's own resolveRequest() output.
 *   handle?: object,        - the SprintHandle written by launch. Preferred
 *                              over `resolved` for work-item targeting (see
 *                              resolveTargetWorkItem()).
 *   restClient?: Function,  - injected REST transport, forwarded verbatim to
 *                              adapter.comment()/setBuildStatus() -- this
 *                              facade never reaches for a real fetch either.
 *   beads?: object,         - injected beads client, used as the DEFAULT
 *                              `deps.beads` for ingest()/publishCarryOver()
 *                              when the caller does not supply its own (a
 *                              verb that already holds its own beads client,
 *                              e.g. finalize.mjs, keeps passing it exactly as
 *                              it always did -- see ingest()/publishCarryOver()
 *                              below).
 *   log?: Function,
 * }} ctx
 * @returns {object} frozen facade -- see the file header for its exact surface.
 * @throws {BridgeError} CONFIG_MISSING if `ctx.adapter` is missing or does
 *   not expose `capabilities()`.
 */
export function createAdapterFacade(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const { adapter, resolved, handle, restClient, beads } = c;
  const log = typeof c.log === 'function' ? c.log : noopLog;

  if (!adapter || typeof adapter.capabilities !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'createAdapterFacade: ctx.adapter (the registry adapter) is required and must expose capabilities()',
      { param: 'adapter' }
    );
  }

  const caps = adapter.capabilities();
  const targetWorkItem = resolveTargetWorkItem({ resolved, handle });

  /**
   * Passthrough to adapter.emitProgress(). Not every adapter has one (it is
   * an OPTIONAL export per adapters/index.mjs's REQUIRED_FUNCTIONS list), so
   * a missing one is a logged no-op, not an error -- emitting progress is a
   * convenience for the tracker, never load-bearing for the sprint itself.
   * @param {object} snapshot
   * @returns {Promise<void>}
   */
  async function emitProgress(snapshot) {
    if (typeof adapter.emitProgress !== 'function') {
      log('[facade] adapter has no emitProgress() -- skipping');
      return;
    }
    try {
      await adapter.emitProgress(snapshot);
    } catch (err) {
      log(`[facade] emitProgress() failed (non-fatal): ${safeMessage(err)}`);
    }
  }

  /**
   * The unified comment surface both verbs consume: `comment(markdown)`.
   * Internally builds the real adapter's pinned
   * `comment({resolved, workItemId, body}, {restClient})` call -- see the
   * file header. Degrades to a logged no-op, never a throw, when:
   *   - capabilities().canComment is false (the tracker cannot comment at
   *     all -- a two-day sprint's reporting step must not fail because of
   *     it, see verbs/finalize.mjs and verbs/watch.mjs's own module
   *     headers, both of which this facade now serves identically); or
   *   - no target work item could be resolved for this sprint.
   * A REST failure surfacing from the real adapter's comment() call is
   * likewise caught and logged, never rethrown -- see "COMMENT NEVER
   * THROWS" above.
   * @param {string} markdown
   * @returns {Promise<void>}
   */
  async function comment(markdown) {
    if (!caps.canComment) {
      log('[facade] adapter capabilities().canComment is false -- comment() is a no-op');
      return;
    }
    if (typeof adapter.comment !== 'function') {
      // Defensive only: adapters/index.mjs's registerBridgeAdapter() already
      // refuses to register canComment:true without a comment() function,
      // so a properly-registered adapter can never reach this branch.
      log('[facade] adapter declares canComment but has no comment() function -- comment() is a no-op');
      return;
    }
    if (targetWorkItem === null || targetWorkItem === undefined) {
      log('[facade] no target work item resolved for this sprint -- comment() is a no-op');
      return;
    }
    try {
      await adapter.comment({ resolved, workItemId: targetWorkItem, body: markdown }, { restClient });
    } catch (err) {
      log(`[facade] comment() failed (non-fatal): ${safeMessage(err)}`);
    }
  }

  /**
   * Optional passthrough to adapter.setBuildStatus(). Neither verb currently
   * calls this (kept for the facade's declared surface, per the fix
   * described in the build log), so it mirrors comment()'s degrade rules
   * without yet having a caller to prove them against: a missing
   * setBuildStatus() is a logged no-op, and a REST failure is caught and
   * logged, never rethrown.
   * @param {string} state
   * @param {string} [url]
   * @returns {Promise<void>}
   */
  async function setBuildStatus(state, url) {
    if (typeof adapter.setBuildStatus !== 'function') {
      log('[facade] adapter has no setBuildStatus() -- skipping (unsupported by this tracker)');
      return;
    }
    try {
      await adapter.setBuildStatus({ resolved, state, targetUrl: url }, { restClient });
    } catch (err) {
      log(`[facade] setBuildStatus() failed (non-fatal): ${safeMessage(err)}`);
    }
  }

  /**
   * Passthrough to adapter.ingest() -- the pinned call shape
   * (adapters/azure-devops.mjs's header, "Pinned contracts between units" in
   * the build log) is untouched: `adapter.ingest({refs, secretName}, {beads})`.
   * When the caller (a verb) does not supply its own `deps`, this facade's
   * own bound `beads` is used as the default so a caller with no beads
   * client of its own can still use this method; a verb that already holds
   * its own beads client (finalize.mjs does, for querying/creating beads
   * directly) keeps passing it exactly as it always did.
   * @param {object} opts
   * @param {{ beads?: object }} [deps]
   * @returns {Promise<any>}
   */
  async function ingest(opts, deps) {
    return adapter.ingest(opts, deps || { beads });
  }

  /**
   * Passthrough to adapter.publishCarryOver() -- same treatment as
   * ingest() above; the pinned call shape
   * `adapter.publishCarryOver({beadIds, secretName, dryRun}, {beads})` is
   * untouched.
   * @param {object} opts
   * @param {{ beads?: object }} [deps]
   * @returns {Promise<any>}
   */
  async function publishCarryOver(opts, deps) {
    // MERGED, not "caller's deps or mine". The Azure DevOps adapter's
    // carry-over path now CREATES work items over REST for any bead that
    // carries no external_ref yet (see that adapter's "BEADS CANNOT CREATE
    // HERE" note), so it needs `restClient`/`resolved` -- and its one real
    // caller, verbs/finalize.mjs, passes `{ beads }` explicitly because it
    // holds its own beads client. Under the old "deps || {beads}" rule that
    // explicit `{ beads }` silently REPLACED this facade's bound
    // transport, so the create path could never have a REST client at all.
    // The caller's own entries still win; the facade only fills the gaps.
    return adapter.publishCarryOver(opts, { beads, restClient, resolved, log, ...(deps || {}) });
  }

  return Object.freeze({
    emitProgress,
    comment,
    setBuildStatus,
    ingest,
    publishCarryOver,
    capabilities: () => caps,
    targetWorkItem,
  });
}

export default createAdapterFacade;
