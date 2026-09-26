// ingest.mjs -- fleet-bridge-implementation-plan.md Part B, `fleet-bridge ingest`.
//
// WHY THIS VERB EXISTS (fleet-bridge-design.md Section 2.7, "A sprint cannot
// bootstrap itself from prose"):
//   - `target_issues` is required; no engine code path creates a root epic
//     from a file.
//   - Pre-sprint validation runs BEFORE the planner and refuses a childless
//     target with `NOTHING_TO_DO` -- and that refusal happens AFTER launch,
//     wasting the run.
//   - Scope resolution is a parent-child BFS from the root over every
//     descendant at any depth. A bead attached only by `blocked-by` is
//     invisible to it -- only `--parent` links count.
// So a flat set of pulled tracker refs is not launchable as-is. `ingest`
// exists to guarantee a launchable scope -- an epic with >= 1 properly
// `--parent`-ed child -- or fail in the first minute, before any of the
// two-day sprint budget is spent.
//
// PINNED CONTRACT (fleet-bridge-build-log.md "Pinned contracts between
// units"): the adapter is called exactly as
//   adapter.ingest({ refs, secretName }, { beads })
// This module never constructs a beads client or an adapter itself -- both
// arrive via `deps`, exactly like every other fleet-bridge module
// (implementation-plan.md "Verification": injected I/O only).
//
// THE ERROR RULE (fleet-bridge-build-log.md "The error rule"): every throw
// crossing this module's boundary is a BridgeError. A missing/malformed
// `opts` field is CONFIG_MISSING/CONFIG_INVALID (caller-supplied); a missing
// injected dependency is CONFIG_MISSING (permanent wiring defect, never
// SUPERVISOR_UNAVAILABLE or a retryable code); a genuine adapter/tracker
// failure is INGEST_PULL_FAILED; a `bd create`/`bd update` that does not do
// what beads-client.mjs promised is BEADS_FAILED; the two ingest-specific
// policy refusals are INGEST_NO_CHILDREN and INGEST_MISSING_CRITERIA. Two
// more refusals guard re-runs: a root that already exists for these refs but
// is CLOSED is INGEST_REF_AMBIGUOUS, and a reparent that would take a bead
// out of a live sprint's scope is LAUNCH_CONFLICT (SUPERVISOR_UNAVAILABLE
// when the supervisor that could have answered that question did not).
//
// Nothing here reaches for `process.env`, `node:fs`, or a real `fetch` --
// injected I/O only.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { assertValidTrackerRef } from '../contracts.mjs';

// ---------------------------------------------------------------------------
// Step 0: validate the verb's own inputs (not part of the plan's numbered
// steps, but every other step depends on this having already run once).
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes `runIngest`'s `opts`. `refs` is the set of
 * external-tracker references to pull (work-item ids, `owner/repo#123`
 * refs, ...); `secretName` is the STORED CREDENTIAL NAME the adapter forwards
 * to the member-dispatched `bd ado`/`bd github` pull (see beads-client.mjs's
 * buildTrackerCommand) -- this module never sees, requests, or forwards the
 * credential VALUE itself.
 *
 * `requireCriteria` defaults to `true` (fail on any pulled bead missing
 * acceptance criteria); `allowMissingCriteria: true` is the CLI's
 * `--allow-missing-criteria` override and always wins over `requireCriteria`.
 *
 * @param {{ refs?: string[], secretName?: string, requireCriteria?: boolean, allowMissingCriteria?: boolean, epicTitle?: string }} opts
 * @returns {{ refs: string[], secretName: string, requireCriteria: boolean, epicTitle: string|undefined }} frozen, normalized
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
export function validateIngestOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  const refs = o.refs;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'ingest: opts.refs is required and must be a non-empty array of external-tracker references (work-item ids or cross-repo refs)',
      { field: 'refs' }
    );
  }
  // Reuses contracts.mjs's own tracker-ref validation -- see
  // assertValidTrackerRef's doc comment: these are external-tracker refs
  // (workItems), not bead ids, so they get the same rule
  // validateSprintRequest applies to a SprintRequest's `workItems`.
  for (const ref of refs) {
    assertValidTrackerRef(ref, 'work item');
  }

  if (!o.secretName || typeof o.secretName !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'ingest: opts.secretName is required (the stored tracker-credential NAME, never a value)',
      { field: 'secretName' }
    );
  }

  // allowMissingCriteria is the explicit CLI override and always wins;
  // requireCriteria otherwise defaults to true (implementation-plan.md Part
  // B: "Default requireCriteria: true fails INGEST_MISSING_CRITERIA...
  // --allow-missing-criteria overrides").
  const requireCriteria = o.allowMissingCriteria === true
    ? false
    : (o.requireCriteria === undefined ? true : Boolean(o.requireCriteria));

  const epicTitle = typeof o.epicTitle === 'string' && o.epicTitle.length > 0 ? o.epicTitle : undefined;

  return Object.freeze({ refs, secretName: o.secretName, requireCriteria, epicTitle });
}

/**
 * Validates `runIngest`'s injected `deps`, defaulting `log` to a no-op.
 * A missing `beads`/`adapter` is a wiring defect (CONFIG_MISSING), never a
 * connectivity code -- see the error-rule corollary in the build log: "a
 * missing injected dependency is never SUPERVISOR_UNAVAILABLE".
 *
 * `supervisorClient` is OPTIONAL and the only dependency here that is: see
 * the "REPARENT GUARD" block below `findReusableRoot` for why ingest now
 * knows about the supervisor at all, and why its absence is a deployment
 * fact rather than a defect. Present-but-wrong-shape IS a defect, though,
 * and fails CONFIG_INVALID -- a caller that wired something up meant the
 * check to run, and must not get the no-supervisor degradation by accident.
 *
 * @param {{ beads?: object, adapter?: object, supervisorClient?: object, log?: Function }} deps
 * @returns {{ beads: object, adapter: object, supervisorClient: object|null, log: Function }}
 * @throws {BridgeError} CONFIG_MISSING, CONFIG_INVALID
 */
function validateIngestDeps(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};

  if (!d.beads || typeof d.beads.create !== 'function' || typeof d.beads.setParent !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'ingest: deps.beads must be an injected beads client exposing create() and setParent() -- none was provided to runIngest()',
      { param: 'deps.beads' }
    );
  }
  if (!d.adapter || typeof d.adapter.ingest !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'ingest: deps.adapter must be an injected bridge adapter exposing ingest() -- none was provided to runIngest()',
      { param: 'deps.adapter' }
    );
  }

  if (d.supervisorClient !== undefined && d.supervisorClient !== null
    && (typeof d.supervisorClient !== 'object' || typeof d.supervisorClient.listSprints !== 'function')) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'ingest: deps.supervisorClient, when provided, must expose listSprints() -- ingest reads the live reservation ledger through it to refuse reparenting a bead out of a running sprint',
      { param: 'deps.supervisorClient' }
    );
  }

  return {
    beads: d.beads,
    adapter: d.adapter,
    supervisorClient: d.supervisorClient || null,
    log: typeof d.log === 'function' ? d.log : () => {},
  };
}

// ---------------------------------------------------------------------------
// Step 1: pull via the adapter.
// ---------------------------------------------------------------------------

/** Unwraps an adapter.ingest() return value into a plain array, accepting
 *  either a bare array or a `{ pulled: [...] }` envelope. */
function coerceRawPulledList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.pulled)) return raw.pulled;
  return [];
}

/**
 * Normalizes one raw pulled-item record from `adapter.ingest()` into this
 * module's internal shape. `parent` (when present and itself one of the
 * pulled beadIds) is what `findNaturalParent` below reads to detect an
 * already-correct tracker-side hierarchy; it is dropped from the public
 * result (see `runIngest`), which only reports the fields callers need.
 *
 * A malformed record is a genuine external-service defect (the adapter/`bd`
 * pull did not deliver a usable bead), never a caller-input problem, so this
 * throws INGEST_PULL_FAILED, not CONFIG_INVALID.
 *
 * @param {any} raw
 * @param {number} index
 * @returns {{ beadId: string, externalRef: any, title: any, parent: string|null, hasAcceptanceCriteria: boolean }}
 * @throws {BridgeError} INGEST_PULL_FAILED
 */
export function normalizePulledItem(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.INGEST_PULL_FAILED,
      `ingest: adapter.ingest() returned a malformed pulled item at index ${index} -- expected an object, got ${JSON.stringify(raw)}`,
      { index, value: raw }
    );
  }
  if (typeof raw.beadId !== 'string' || raw.beadId.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.INGEST_PULL_FAILED,
      `ingest: adapter.ingest() returned a pulled item at index ${index} with no beadId`,
      { index, value: raw }
    );
  }

  const hasAcceptanceCriteria = raw.hasAcceptanceCriteria === true
    || (typeof raw.acceptanceCriteria === 'string' && raw.acceptanceCriteria.trim().length > 0);

  return {
    beadId: raw.beadId,
    externalRef: raw.externalRef,
    title: raw.title,
    parent: typeof raw.parent === 'string' && raw.parent.length > 0 ? raw.parent : null,
    hasAcceptanceCriteria,
  };
}

/**
 * Step 1 -- "Pull via the adapter." Calls the adapter with the pinned
 * contract shape (`{ refs, secretName }, { beads }`) and normalizes whatever
 * it returns into this module's internal pulled-item shape.
 *
 * @param {{ refs: string[], secretName: string }} validatedOpts
 * @param {{ adapter: object, beads: object, log: Function }} deps
 * @returns {Promise<Array<{ beadId: string, externalRef: any, title: any, parent: string|null, hasAcceptanceCriteria: boolean }>>}
 * @throws {BridgeError} INGEST_PULL_FAILED
 */
export async function pullWorkItems(validatedOpts, deps) {
  const { adapter, beads, log } = deps;

  let raw;
  try {
    raw = await adapter.ingest({ refs: validatedOpts.refs, secretName: validatedOpts.secretName }, { beads });
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError(
      BRIDGE_ERROR_CODES.INGEST_PULL_FAILED,
      `ingest: adapter.ingest() failed to pull work item(s) [${validatedOpts.refs.join(', ')}]: ${err && err.message ? err.message : String(err)}`,
      { refs: validatedOpts.refs, cause: err }
    );
  }

  const pulled = coerceRawPulledList(raw).map((item, index) => normalizePulledItem(item, index));
  log(`[ingest] pulled ${pulled.length} item(s) from the tracker`);
  return pulled;
}

// ---------------------------------------------------------------------------
// Step 2: resolve a root with at least one child.
// ---------------------------------------------------------------------------

/**
 * Finds the one pulled bead, if any, that is the direct `--parent` of every
 * OTHER pulled bead -- i.e. the tracker already delivered a proper
 * epic-plus-children shape and no synthetic wrapper is needed.
 *
 * A single pulled item trivially satisfies this (there are no "others" to
 * fail the check against), which is deliberate: it lets `resolveRoot` return
 * a `childCount` of 0 for that case through the exact same code path as the
 * zero-and-many-item cases, so `assertHasChildren` is the single place that
 * turns "no children" into `INGEST_NO_CHILDREN` -- see its doc comment for
 * why a lone item is never wrapped in a synthetic epic instead.
 *
 * @param {Array<{ beadId: string, parent: string|null }>} pulled
 * @returns {{ beadId: string }|null} the natural-parent item, or null
 */
export function findNaturalParent(pulled) {
  if (!Array.isArray(pulled) || pulled.length === 0) return null;
  for (const candidate of pulled) {
    const isParentOfEveryOther = pulled.every(
      (p) => p.beadId === candidate.beadId || p.parent === candidate.beadId
    );
    if (isParentOfEveryOther) return candidate;
  }
  return null;
}

/** Deterministic, caller-overridable default title for the synthetic epic --
 *  no ambient clock, so it stays exercisable with plain fakes. */
function defaultEpicTitle(pulled) {
  const refs = pulled.map((p) => p.externalRef || p.beadId).filter(Boolean);
  const shown = refs.slice(0, 5).join(', ');
  const suffix = refs.length > 5 ? `, +${refs.length - 5} more` : '';
  return `Ingest epic for ${pulled.length} item(s): ${shown}${suffix}`;
}

// ---------------------------------------------------------------------------
// Synthetic-root REUSE (idempotency) -- WHY THIS EXISTS:
//
// A pipeline retries. A transient tracker hiccup or a supervisor restart
// followed by a re-run of the exact same `ingest --refs ...` is the NORMAL
// case here, not the exception -- so "run it again with the same input"
// cannot leave a second root behind. Before this, `resolveRoot` had no way
// to recognize "I already made this epic" and unconditionally called
// `bd create` on every no-natural-parent run, orphaning the previous
// synthetic epic every single retry.
//
// IDENTITY SCHEME: the synthetic epic's `metadata` carries a marker
// (FLEET_BRIDGE_INGEST_ROOT_MARKER) plus a canonical key derived from the
// caller's REQUESTED refs (FLEET_BRIDGE_INGEST_REFS_KEY) -- not the pulled
// beadIds (those can shift between runs if the tracker's response changes)
// and never the title (title is a free-text, caller-overridable
// `--epic-title` -- explicitly excluded by this task's own brief, and
// mutable besides). `metadata` was chosen over `external_ref` for one
// concrete, code-backed reason: carry-over.mjs's `selectCarryOver` treats a
// non-empty `external_ref` as proof positive that a bead "came from the
// tracker" (its rule 2 doc comment, verbatim) and skips it on that basis.
// Stamping a synthetic, never-pushed-to-any-tracker epic with a fake
// `external_ref` would make that rule lie for this bead -- functionally
// masked today only because the synthetic root is *also* excluded ahead of
// the three rules by `syntheticRootId`, but a landmine for the next reader
// or the next carry-over rule that keys off `external_ref` for some other
// purpose. `metadata` carries no such contract, so it is the safe place to
// put a bridge-internal marker.
//
// NON-HIJACK RULE: a lookup that finds no metadata match for the current
// refsKey NEVER reuses a different epic -- it falls through to creating a
// new one, exactly as before this change. This is deliberate, not a gap:
//   - Different refs are a genuinely different scope. There is no principled
//     "closest" existing root to attach an unrelated (or superset/subset)
//     ref set to -- see design.md 2.7's own scope-resolution rule (a
//     parent-child BFS from ONE root), which already assumes an epic's
//     children are exactly its own sprint's scope, not a mixture.
//   - Failing outright instead of creating a new root was considered and
//     rejected: it would block a legitimate "add refs 5,6 to a fresh sprint"
//     ingest for no benefit -- there is nothing to reconcile, just a new,
//     unrelated scope that deserves its own root.
//   - Per this task's brief: "err toward creating a new root when identity
//     is uncertain" -- a refs mismatch is exactly that uncertainty, resolved
//     the safe way.
// A plain `issue_type !== 'epic'` filter plus the marker match together are
// also what keeps this from ever touching one of the tracker's own
// unrelated feature/epic beads that merely happen to share a title or a
// coincidental metadata key -- only a bead THIS module itself stamped can
// ever match.
// ---------------------------------------------------------------------------

/** Metadata key marking a bead as a synthetic root this module created. */
const FLEET_BRIDGE_INGEST_ROOT_MARKER = 'fleetBridgeIngestRoot';
/** Metadata key holding the canonical, sorted/deduped refs identity. */
const FLEET_BRIDGE_INGEST_REFS_KEY = 'fleetBridgeIngestRefsKey';

/**
 * Canonicalizes the caller's requested refs into one deterministic string:
 * de-duplicated, sorted, comma-joined. Order-independent on purpose -- an
 * operator re-running `--refs 4,2,3` after `--refs 2,3,4` is still the same
 * request. Returns `null` for a missing/empty list so callers can skip the
 * reuse lookup entirely rather than matching against a degenerate `''` key.
 * @param {string[]|undefined} refs
 * @returns {string|null}
 */
function canonicalRefsKey(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const unique = Array.from(new Set(refs.map(String)));
  unique.sort();
  return unique.join(',');
}

/**
 * Is this `bd list` row a closed bead? Two independent signals are checked
 * because neither is guaranteed alone: `status` is what `bd list --json`
 * reports, `closed_at` is what survives on a row whose status field a caller
 * (or a fake) omitted. Either one being present means closed -- erring
 * toward "closed" is the safe direction here, since the consequence is a
 * surfaced refusal rather than a silent duplicate root.
 * @param {any} row
 * @returns {boolean}
 */
function isClosedRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (typeof row.status === 'string' && row.status.toLowerCase() === 'closed') return true;
  return Boolean(row.closed_at);
}

/**
 * Looks for an existing synthetic root this module created for the exact
 * same `refsKey`. Returns its bead id, or `null` when none exists (fresh
 * refs, first-ever run, or the injected `beads` cannot be queried at all).
 *
 * Feature-detects `beads.list` rather than requiring it: the pinned contract
 * for `deps.beads` (see `validateIngestDeps`) only ever guaranteed
 * `create()`/`setParent()`. An older or minimal injected client that has not
 * picked up `list()` is a capability gap, not a defect worth failing the
 * whole ingest over -- it just means this run degrades to the pre-fix
 * behavior (always create) for that one call, same as a `list()` call that
 * itself throws. (That fall-through is still exactly "create a new root",
 * which the NON-HIJACK RULE above already sanctions as the safe answer
 * whenever identity cannot be established.)
 *
 * CLOSED ROOTS ARE PART OF THE SEARCH SPACE. `bd list` defaults to OPEN
 * issues only, so before this the lookup could not see a root an operator
 * had closed -- and "invisible" is indistinguishable from "absent", which
 * silently re-armed the duplicate-root creation this whole scheme exists to
 * prevent. The scan therefore runs with `all: true` (`bd list --all`, see
 * beads-client.mjs's `list`) and classifies the matches itself:
 *   - any OPEN match wins, exactly as before -- the idempotent re-run path
 *     is untouched, and a closed sibling never outranks a live root.
 *   - only-closed matches are a REFUSAL (INGEST_REF_AMBIGUOUS), not a
 *     revival and not a new root. Reviving is wrong because the operator
 *     closed that root deliberately; ingest cannot know whether they retired
 *     the scope or merely tidied a stale artifact, and re-opening a retired
 *     sprint scope from a pipeline retry is the more damaging guess. Quietly
 *     creating a second root is the bug this module already refuses to
 *     commit. So the only honest move is to stop and make the human choose,
 *     with the closed root named so the choice is one command away.
 * @param {object} beads
 * @param {string} refsKey
 * @param {Function} log
 * @returns {Promise<string|null>}
 * @throws {BridgeError} INGEST_REF_AMBIGUOUS when the only match is closed
 */
async function findReusableRoot(beads, refsKey, log) {
  if (typeof beads.list !== 'function') return null;

  let candidates;
  try {
    candidates = await beads.list({ type: 'epic', limit: 0, all: true });
  } catch (err) {
    log(`[ingest] root-reuse lookup failed (${err && err.message ? err.message : String(err)}) -- falling back to creating a new synthetic epic`);
    return null;
  }
  if (!Array.isArray(candidates)) return null;

  let matches = candidates.filter((c) => (
    c && typeof c === 'object'
    && c.issue_type === 'epic'
    && c.metadata && typeof c.metadata === 'object'
    && c.metadata[FLEET_BRIDGE_INGEST_ROOT_MARKER] === true
    && c.metadata[FLEET_BRIDGE_INGEST_REFS_KEY] === refsKey
    && typeof c.id === 'string' && c.id.length > 0
  ));
  if (matches.length === 0) return null;

  const closed = matches.filter(isClosedRow);
  matches = matches.filter((c) => !isClosedRow(c));
  if (matches.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.INGEST_REF_AMBIGUOUS,
      `ingest: refs [${refsKey}] already have a synthetic root (${closed.map((c) => c.id).join(', ')}), but it is CLOSED. `
      + 'Refusing to silently revive a root an operator closed on purpose, and refusing to create a second root for the same refs '
      + '(that is the duplicate-root bug this identity scheme exists to prevent). Either reopen that root '
      + `(bd update ${closed[0].id} --status open) and re-run, or ingest a different ref set.`,
      { refsKey, closedRoots: closed.map((c) => c.id) }
    );
  }

  if (matches.length > 1) {
    // Should never happen once this fix is in place -- its entire purpose is
    // preventing exactly this. Its presence means duplicates from BEFORE the
    // fix (or a still-unfixed concurrent writer). Rather than compound the
    // mess with yet another new root, pick deterministically (oldest
    // created_at, id tiebreak) and surface a loud warning so an operator
    // notices and cleans up the rest -- silently ignoring the ambiguity
    // would be worse than either alternative.
    matches.sort((a, b) => {
      const ta = Date.parse(a.created_at || '') || 0;
      const tb = Date.parse(b.created_at || '') || 0;
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    log(
      `[ingest] WARNING: ${matches.length} existing synthetic roots already match refs [${refsKey}] `
      + `(${matches.map((m) => m.id).join(', ')}) -- reusing the oldest (${matches[0].id}); `
      + `an operator should investigate and close/reparent the rest`
    );
  }

  return matches[0].id;
}

// ---------------------------------------------------------------------------
// REPARENT GUARD -- WHY INGEST NOW KNOWS ABOUT THE SUPERVISOR:
//
// Step 2 ends by `--parent`-ing every pulled bead onto the resolved root.
// That loop predates the reuse feature and was only ever reasoned about as a
// no-op on the reuse path. It is not a no-op on the OTHER path. Re-running
// `ingest` with a changed ref list resolves a DIFFERENT root (the NON-HIJACK
// RULE above, deliberately), and then MOVES beads off whatever parent they
// already had onto it.
//
// That move is not local. The supervisor resolves a live sprint's scope by
// re-expanding its `issueRoots` with a BFS at EVERY check
// (apra-fleet-se/src/supervisor/scope-overlap.mjs -- deliberately never a
// launch-time snapshot, so that planners can grow a subtree mid-run). So
// reparenting a bead out from under a reserved root silently SHRINKS a
// running sprint's scope. The subtree-overlap guard cannot catch it: that
// guard is keyed on roots, and reparenting is precisely the operation that
// relocates beads between roots.
//
// SCOPE OF THE CHECK: only beads that would actually CHANGE parent. A bead
// already sitting under the resolved root, or with no parent at all, is not
// being taken from anyone -- the idempotent re-run path therefore never
// consults the supervisor at all, and costs nothing.
//
// THE DEPENDENCY, AND WHAT AN UNREACHABLE SUPERVISOR MEANS. Three states,
// deliberately kept distinguishable:
//   1. `deps.supervisorClient` injected and answering -> enforce: a move off
//      a reserved root is refused (LAUNCH_CONFLICT -- this is a conflict
//      with a RUNNING sprint, the same family as the launch-time overlap
//      refusal, and it carries that family's exit code).
//   2. injected but the call FAILS -> refuse the whole ingest
//      (SUPERVISOR_UNAVAILABLE). This is the case the fix exists for: an
//      unreachable supervisor must never collapse into "no reservations
//      exist". The operator wired a supervisor; ingest will not quietly
//      decide it does not matter because a socket was refused.
//   3. NOT injected at all -> proceed, with a loud per-bead WARNING naming
//      every bead being moved and stating that no reservation check ran.
//      Refusing here was considered and rejected: ingest is a standalone
//      verb that legitimately runs against a plain beads DB with no
//      supervisor in the deployment, and a hard failure would make the
//      no-supervisor setup unusable to buy nothing. The distinction that
//      matters is the one the brief demands -- "nobody told me where the
//      supervisor is" is a deployment fact that is announced, whereas
//      "the supervisor I was told about did not answer" is a stop.
// ---------------------------------------------------------------------------

/**
 * The bead's parent AS THE DB HAS IT RIGHT NOW, which is not necessarily the
 * `parent` the tracker pull reported: a previous ingest may have reparented
 * it locally since. `beads.show` is feature-detected for the same reason
 * `beads.list` is (the pinned `deps.beads` contract only guarantees
 * `create`/`setParent`), and a failing `show` falls back to the pulled
 * record's own `parent` rather than failing the run -- a worse signal, but a
 * signal, and the guard below only ever uses it to ask for MORE scrutiny.
 * @param {object} beads
 * @param {{ beadId: string, parent: string|null }} item
 * @returns {Promise<string|null>}
 */
async function currentParentOf(beads, item) {
  if (typeof beads.show === 'function') {
    try {
      const row = await beads.show(item.beadId);
      if (row && typeof row === 'object') {
        return typeof row.parent === 'string' && row.parent.length > 0 ? row.parent : null;
      }
    } catch {
      // fall through to the pulled record's own view
    }
  }
  return item.parent || null;
}

/**
 * Flattens a `GET /api/sprints` body into `rootBeadId -> sprintId`. The
 * supervisor's own shape is `{ sprints: [{ sprintId, issueRoots, ... }] }`
 * (apra-fleet-se/src/supervisor/api.mjs `listSprints`); anything unexpected
 * yields an empty map rather than throwing, because the CALLER decides what
 * an unusable answer means -- see `assertReparentAllowed`.
 * @param {any} body
 * @returns {Map<string, string>}
 */
export function reservedRootsFrom(body) {
  const out = new Map();
  const sprints = body && Array.isArray(body.sprints) ? body.sprints : [];
  for (const s of sprints) {
    if (!s || typeof s !== 'object') continue;
    const roots = Array.isArray(s.issueRoots) ? s.issueRoots : [];
    for (const root of roots) {
      if (typeof root === 'string' && root.length > 0 && !out.has(root)) {
        out.set(root, typeof s.sprintId === 'string' ? s.sprintId : '<unnamed sprint>');
      }
    }
  }
  return out;
}

/**
 * The guard itself -- see the REPARENT GUARD block above for the full
 * rationale behind each of the three supervisor states.
 *
 * @param {Array<{ beadId: string, from: string }>} moves beads that would change parent
 * @param {string} rootBeadId the root they would be moved ONTO
 * @param {{ supervisorClient: object|null, log: Function }} deps
 * @throws {BridgeError} LAUNCH_CONFLICT, SUPERVISOR_UNAVAILABLE
 */
export async function assertReparentAllowed(moves, rootBeadId, deps) {
  if (!Array.isArray(moves) || moves.length === 0) return;

  const { supervisorClient, log } = deps;
  if (!supervisorClient) {
    log(
      `[ingest] WARNING: ${moves.length} bead(s) will be moved onto ${rootBeadId} `
      + `(${moves.map((m) => `${m.beadId} from ${m.from}`).join('; ')}) and NO supervisor client was injected, `
      + 'so no live-sprint reservation check ran -- if one of those parents is a running sprint\'s issue root, '
      + 'this shrinks that sprint\'s scope. Wire deps.supervisorClient to have this checked.'
    );
    return;
  }

  let reserved;
  try {
    reserved = reservedRootsFrom(await supervisorClient.listSprints());
  } catch (err) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE,
      `ingest: ${moves.length} bead(s) would be reparented onto ${rootBeadId}, but the supervisor could not be asked which issue roots are reserved by live sprints `
      + `(${err && err.message ? err.message : String(err)}). Refusing: an unreachable supervisor is NOT the same answer as "no sprint holds these beads". `
      + 'Restore the supervisor and re-run, or re-run with the same refs as the sprint that owns them.',
      { rootBeadId, moves: moves.map((m) => m.beadId), cause: err }
    );
  }

  for (const move of moves) {
    const sprintId = reserved.get(move.from);
    if (sprintId) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.LAUNCH_CONFLICT,
        `ingest: refusing to reparent bead ${move.beadId} from ${move.from} onto ${rootBeadId} -- ${move.from} is a reserved issue root of the live sprint ${sprintId}, `
        + 'and that sprint resolves its scope by re-expanding its roots on every check, so the move would silently shrink a running sprint. '
        + 'Wait for that sprint to finish (or stop it) before re-ingesting these refs under a different root.',
        { beadId: move.beadId, fromRoot: move.from, toRoot: rootBeadId, sprintId }
      );
    }
  }
}

/**
 * Step 2 -- "Resolve a root with at least one child." If exactly one pulled
 * bead is a natural parent of the others, it becomes the root untouched.
 * Otherwise a synthetic epic is created and EVERY pulled item is `--parent`-ed beneath
 * it, flattening any partial pre-existing hierarchy (design.md 2.7: "create a
 * synthetic epic ... and `--parent` every pulled item beneath it"). The
 * synthetic root is local-only -- this function never calls anything that
 * would push it to the tracker.
 *
 * Never called for a zero-pulled-item ingest: there is nothing to root, so
 * this returns `childCount: 0` directly rather than creating an empty epic.
 *
 * `epicTitle`, when given, overrides `defaultEpicTitle`'s deterministic name
 * (only consulted on the synthetic-epic path).
 *
 * IDEMPOTENCY: before creating a new synthetic epic, this looks for one it
 * already created for the exact same `opts.refs` (see the "Synthetic-root
 * REUSE" block above `defaultEpicTitle` for the full identity scheme and
 * why re-running with different refs never hijacks an unrelated root). A
 * match is reused -- children are still (re-)`--parent`-ed onto it below,
 * which is a no-op when they are already there -- so re-running
 * `ingest` with the same refs converges instead of creating another orphan.
 * `opts.refs` is optional precisely so every pre-existing caller/test that
 * never passed it keeps the old always-create behavior unchanged.
 *
 * NOTE on naming: this function's return value has NO `syntheticRootId`
 * field -- only `rootBeadId` (which one of the two branches happens to be
 * the synthetic epic's id) and the `syntheticRoot` boolean. The local
 * variable below holding the resolved (created OR reused) synthetic epic id
 * is deliberately named `epicId`, not `syntheticRootId`, precisely so it is
 * never mistaken for a field on the object this function returns -- see
 * `runIngest`, which is what actually derives the public `syntheticRootId`
 * field from `syntheticRoot` and `rootBeadId` together.
 *
 * @param {Array<{ beadId: string, externalRef: any, parent: string|null }>} pulled
 * REPARENT GUARD: beads that would be MOVED off a different existing parent
 * are checked against the supervisor's live reservation ledger first -- see
 * the REPARENT GUARD block above `currentParentOf` for the full rationale
 * and for what an absent vs unreachable supervisor each mean.
 *
 * @param {{ beads: { create: Function, setParent: Function, list?: Function, show?: Function }, supervisorClient?: object|null, log: Function }} deps
 * @param {{ epicTitle?: string, refs?: string[] }} [opts]
 * @returns {Promise<{ rootBeadId: string|null, syntheticRoot: boolean, childCount: number }>}
 * @throws {BridgeError} BEADS_FAILED if `bd create` does not return a usable
 *   id; INGEST_REF_AMBIGUOUS if the only matching root is closed;
 *   LAUNCH_CONFLICT / SUPERVISOR_UNAVAILABLE from the reparent guard
 */
export async function resolveRoot(pulled, deps, opts = {}) {
  const { beads, log } = deps;

  const natural = findNaturalParent(pulled);
  if (natural) {
    // A natural parent (an already-correct tracker-side hierarchy) always
    // wins over any synthetic root, reused or new -- checked first, before
    // the reuse lookup even runs, so it is never in competition with it.
    const childCount = pulled.length - 1;
    log(`[ingest] natural parent found: ${natural.beadId} (${childCount} child(ren))`);
    return { rootBeadId: natural.beadId, syntheticRoot: false, childCount };
  }

  if (pulled.length === 0) {
    return { rootBeadId: null, syntheticRoot: false, childCount: 0 };
  }

  const refsKey = canonicalRefsKey(opts.refs);
  let epicId = refsKey ? await findReusableRoot(beads, refsKey, log) : null;

  if (epicId) {
    log(`[ingest] reusing existing synthetic epic ${epicId} for refs [${refsKey}] -- idempotent re-run, no new epic created`);
  } else {
    const title = opts.epicTitle || defaultEpicTitle(pulled);
    const metadata = refsKey
      ? { [FLEET_BRIDGE_INGEST_ROOT_MARKER]: true, [FLEET_BRIDGE_INGEST_REFS_KEY]: refsKey }
      : undefined;
    const created = await beads.create({ title, issueType: 'epic', metadata });
    epicId = created && created.id;
    if (typeof epicId !== 'string' || epicId.length === 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.BEADS_FAILED,
        `ingest: bd create did not return a usable id for the synthetic epic (title=${JSON.stringify(title)})`,
        { title, created }
      );
    }
    log(`[ingest] no natural parent -- created synthetic epic ${epicId} ("${title}")`);
  }

  // Which beads would actually CHANGE parent -- computed BEFORE any write,
  // so the guard below can refuse the whole batch rather than discover the
  // problem half way through it (a partially-reparented sprint scope is
  // strictly worse than either outcome). See the REPARENT GUARD block above.
  const moves = [];
  for (const item of pulled) {
    // eslint-disable-next-line no-await-in-loop -- same ordered-local-reads
    // reasoning as the setParent loop below.
    const from = await currentParentOf(beads, item);
    if (from && from !== epicId) moves.push({ beadId: item.beadId, from });
  }
  await assertReparentAllowed(moves, epicId, deps);

  for (const item of pulled) {
    // eslint-disable-next-line no-await-in-loop -- these are ordered `bd
    // update` calls against the same local beads DB; parallelizing them
    // buys nothing and risks interleaved writes. Re-running this against an
    // item already parented onto `epicId` (the reuse path) is a harmless
    // no-op `bd update` -- it is what makes the reuse path converge to the
    // exact same DB state as a fresh run, not just the exact same root id.
    await beads.setParent(item.beadId, epicId);
  }

  return { rootBeadId: epicId, syntheticRoot: true, childCount: pulled.length };
}

// ---------------------------------------------------------------------------
// Step 3: assert child count >= 1.
// ---------------------------------------------------------------------------

/**
 * Step 3 -- "Assert child count >= 1 before returning; fail
 * INGEST_NO_CHILDREN otherwise." This is also what makes a lone pulled item
 * fail cleanly: `resolveRoot` gives it `childCount: 0` (trivially its own
 * natural parent, with no others), and this is the one place that turns
 * "zero children" into the ingest-specific refusal -- deliberately never
 * papered over by wrapping a single item in a synthetic epic, which would
 * satisfy the engine's own `NOTHING_TO_DO` check but not fix the real
 * problem: one undecomposed item is not a sprint-ready scope.
 *
 * @param {number} childCount
 * @throws {BridgeError} INGEST_NO_CHILDREN
 */
export function assertHasChildren(childCount) {
  if (!Number.isInteger(childCount) || childCount < 1) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.INGEST_NO_CHILDREN,
      `ingest: resolved root has ${childCount} child(ren); at least 1 is required before a sprint can be launched (design.md 2.7 -- scope resolution is a parent-child BFS from the root, so a flat/childless target is not a launchable scope)`,
      { childCount }
    );
  }
}

// ---------------------------------------------------------------------------
// Step 4: acceptance-criteria audit.
// ---------------------------------------------------------------------------

/**
 * Step 4 -- "Acceptance-criteria audit." Lists every PULLED bead (never the
 * synthetic root, which is not a pulled bead) lacking acceptance criteria.
 *
 * @param {Array<{ beadId: string, hasAcceptanceCriteria: boolean }>} pulled
 * @returns {{ missing: string[], total: number }}
 */
export function auditAcceptanceCriteria(pulled) {
  const missing = pulled.filter((p) => !p.hasAcceptanceCriteria).map((p) => p.beadId);
  return { missing, total: pulled.length };
}

/**
 * Enforces the audit: `requireCriteria` (default true, see
 * `validateIngestOpts`) fails INGEST_MISSING_CRITERIA naming every offending
 * bead id; `allowMissingCriteria`/`requireCriteria: false` overrides and lets
 * `runIngest` proceed with `criteriaAudit.missing` populated for visibility.
 *
 * @param {{ missing: string[], total: number }} audit
 * @param {boolean} requireCriteria
 * @throws {BridgeError} INGEST_MISSING_CRITERIA
 */
export function assertCriteriaComplete(audit, requireCriteria) {
  if (requireCriteria && audit.missing.length > 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.INGEST_MISSING_CRITERIA,
      `ingest: ${audit.missing.length} of ${audit.total} pulled bead(s) have no acceptance criteria: ${audit.missing.join(', ')}. Looked for a dedicated criteria field on the bead and for an "Acceptance criteria" heading in its description -- neither was present. The doer is contractually instructed to skip beads without criteria rather than guess (design.md 2.7) -- add an "Acceptance criteria" heading to the work item description (or fix the dedicated field, if your tracker has one) or re-run with allowMissingCriteria to proceed anyway.`,
      { missing: audit.missing, total: audit.total }
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

/**
 * `fleet-bridge ingest`: tracker work items -> a sprint-ready beads scope.
 * See the file-level doc comment for why this verb is load-bearing.
 *
 * @param {{ refs: string[], secretName: string, requireCriteria?: boolean, allowMissingCriteria?: boolean, epicTitle?: string }} opts
 * @param {{ beads: object, adapter: object, supervisorClient?: object, log?: Function }} deps
 * @returns {Promise<{
 *   rootBeadId: string,
 *   syntheticRoot: boolean,
 *   syntheticRootId: string|undefined,
 *   pulled: Array<{ beadId: string, externalRef: any, title: any, hasAcceptanceCriteria: boolean }>,
 *   childCount: number,
 *   criteriaAudit: { missing: string[], total: number },
 * }>} `syntheticRootId` is `rootBeadId` when `syntheticRoot` is true and
 *   `undefined` otherwise -- i.e. the exact translation
 *   `makeSprintHandle({ ..., syntheticRootId })` (contracts.mjs) and
 *   `selectCarryOver(rows, { syntheticRootId, ... })` (carry-over.mjs) both
 *   want, done once here rather than by every future caller (e.g. the
 *   not-yet-written `launch.mjs`). `syntheticRoot` is kept alongside it
 *   purely for readability at call sites that only need the boolean.
 * @throws {BridgeError} CONFIG_MISSING, CONFIG_INVALID, INGEST_PULL_FAILED,
 *   INGEST_NO_CHILDREN, INGEST_MISSING_CRITERIA, INGEST_REF_AMBIGUOUS,
 *   LAUNCH_CONFLICT, SUPERVISOR_UNAVAILABLE, BEADS_FAILED
 */
export async function runIngest(opts, deps) {
  const validated = validateIngestOpts(opts);
  const d = validateIngestDeps(deps);

  const pulled = await pullWorkItems(validated, d);

  const { rootBeadId, syntheticRoot, childCount } = await resolveRoot(
    pulled, d, { epicTitle: validated.epicTitle, refs: validated.refs }
  );
  assertHasChildren(childCount);

  // The translation downstream consumers want -- see the doc comment above.
  // Computed once, here, rather than left for launch.mjs to reconstruct.
  const syntheticRootId = syntheticRoot ? rootBeadId : undefined;

  const criteriaAudit = auditAcceptanceCriteria(pulled);
  assertCriteriaComplete(criteriaAudit, validated.requireCriteria);

  d.log(
    `[ingest] root=${rootBeadId} syntheticRoot=${syntheticRoot} children=${childCount} `
    + `criteriaMissing=${criteriaAudit.missing.length}/${criteriaAudit.total}`
  );

  return Object.freeze({
    rootBeadId,
    syntheticRoot,
    syntheticRootId,
    pulled: pulled.map(({ beadId, externalRef, title, hasAcceptanceCriteria }) => (
      { beadId, externalRef, title, hasAcceptanceCriteria }
    )),
    childCount,
    criteriaAudit,
  });
}

export default runIngest;
