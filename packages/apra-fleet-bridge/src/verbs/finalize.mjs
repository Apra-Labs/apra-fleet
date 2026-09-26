// finalize.mjs -- fleet-bridge-implementation-plan.md Part B, `fleet-bridge
// finalize`; the precise algorithm it implements is fleet-bridge-design.md
// Section 8 ("Carry-over: the precise algorithm"), as amended by
// implementation-plan.md's "Decisions that changed during design review"
// (both amendments are also recorded at the top of ../carry-over.mjs, which
// this module consumes rather than reimplements -- see that file's header).
//
// SEQUENCE (design.md Section 8 + implementation-plan.md Part B):
//   1. Assert the sprint is terminal (finalizing a live sprint would push
//      carry-over for work still in progress) -- FINALIZE_NOT_TERMINAL.
//   2. Query candidate rows: `bd list --status open,in_progress,blocked,
//      deferred --created-after <ISO-8601 startedAt>`. The ISO timestamp
//      contains ':', which beads-client.mjs's hasFreeTextArg() charset check
//      always routes through execBdSync, never execBdAsync -- see
//      queryCandidateRows()'s doc comment and the dedicated
//      "against the real beads-client" test in finalize.test.mjs.
//   3. Select via selectCarryOver() (../carry-over.mjs) -- pure, already
//      exhaustively tested; this module never reimplements its rules.
//   4. Dry run always first (adapter.publishCarryOver(..., dryRun: true),
//      logged), then publish for real UNLESS opts.dryRun -- per bead, not
//      batched, so one bead's publish failure cannot abort the rest (see
//      "FAILURE HANDLING" below).
//   5. A non-empty `suppressed` files exactly one local summary bead (never
//      silently stranding the rest in the local beads DB), which is then
//      published exactly like any other carry-over item.
//   6. A final comment is posted (best-effort; see "FAILURE HANDLING").
//      This module no longer decides WHICH work item receives it -- that
//      choice, and the REST/resolved-config plumbing, now live in the
//      per-sprint facade (../adapters/facade.mjs) that `deps.adapter` is
//      expected to be; this module calls only `adapter.comment(markdown)`.
//      See that file's header for why (the "adapter.comment has three
//      incompatible signatures" fix) and for the work-item-targeting rule
//      this module used to own alone.
//   7. `spool.complete(sprintId, result)` -- always, regardless of any
//      per-item publish/comment failure above; the caller must be able to
//      see what landed even when part of the batch did not.
//   8. If carry-over was selected and any of it went UNPUBLISHED, throw
//      CARRYOVER_PUBLISH_FAILED (exit 6) naming those bead ids -- after
//      step 7, so the record of what did land exists first. See
//      assertCarryOverPublished() for why partial counts, and why a dry
//      run never does.
//
// -----------------------------------------------------------------------------
// FAILURE HANDLING
// -----------------------------------------------------------------------------
// A failure publishing ONE carry-over item must never abandon the rest, and
// must never leave the caller unable to tell what landed -- `published`
// below carries one entry per attempted bead, each with its own
// `pushed`/`externalRef`/`error`. `CARRYOVER_PUBLISH_FAILED` (errors.mjs) is
// never thrown from the per-bead publish path -- it is recorded per-item in
// `published[i].error` instead, exactly so one bad bead cannot abort the
// batch. It IS thrown ONCE at the very end (step 8,
// assertCarryOverPublished) if anything selected went unpublished:
// isolating a failure is not the same as reporting success over it, and
// reporting success over it is what this verb used to do. A comment (or, in the future,
// build-status) failure is separately non-fatal: the carry-over is the
// valuable part of finalize and must not be rolled back, or even reported as
// a verb failure, because a comment failed to post.
//
// -----------------------------------------------------------------------------
// WHY "DRY RUN" TOUCHES NOTHING, NOT EVEN LOCALLY
// -----------------------------------------------------------------------------
// The pinned contract on adapter.publishCarryOver (../adapters/lib/
// native-beads-sync.mjs) only says `dryRun: true` stamps nothing on the
// TRACKER. This module takes the stronger, more useful reading for the whole
// verb: `opts.dryRun` also skips filing the local suppressed-summary bead and
// skips posting the final comment, so a dry-run finalize is safe to run
// against a real beads DB and a real tracker with zero side effects anywhere
// -- not just "the push part was skipped." `spool.complete()` still runs
// unconditionally (step 7 has no dry-run carve-out in the spec), so a dry run
// is still visible in the spool as a completed (not failed) finalize attempt.
//
// -----------------------------------------------------------------------------
// REUSE, NOT REIMPLEMENTATION
// -----------------------------------------------------------------------------
// verdict/prUrl/spend extraction from a supervisor-client.mjs `getSprint()`
// result is the same shape ../snapshot.mjs already derives a ProgressSnapshot
// from -- verdictFromSprint/prUrlFromSprint/spendUsdFromSprint are imported
// from there, which is their single owner (see that module's doc comments
// for the exact fallback order and why `undefined`, not `null`, is their
// "absent" sentinel: toProgressSnapshot() feeds them straight into
// makeProgressSnapshot(), which throws on `null` for an optional field).
// `computeBranchSlug` is imported straight from
// apra-fleet-se/fleet-sprint/sprint-report.mjs, the engine's own copy,
// following the deep-import style this package already uses elsewhere
// (snapshot.mjs -> apra-fleet-se/fleet-sprint/sprint-progress.mjs;
// supervisor-client.mjs -> apra-fleet-workflow/viewer/lean-state). Both were
// briefly reimplemented locally here while snapshot.mjs was being edited
// concurrently by another unit of this build; that risk is gone now, so the
// duplication is gone too. See analysisDocPathFor() below for the one thing
// this module still owns: turning that slug into this verb's specific path.
//
// Nothing here reaches for `process.env`, `node:fs`, or a real `fetch` --
// every collaborator (`supervisorClient`, `beads`, `adapter`, `spool`, `log`)
// arrives via `deps`, per this package's injected-I/O rule.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { selectCarryOver } from '../carry-over.mjs';
import {
  verdictFromSprint, prUrlFromSprint, spendUsdFromSprint, isSprintTerminal,
} from '../snapshot.mjs';
import { computeBranchSlug } from '@apralabs/apra-fleet-se/fleet-sprint/sprint-report.mjs';

/**
 * Statuses selectCarryOver treats as "not closed" -- mirrored here (that
 * module does not export its own copy) ONLY to narrow the `bd list` query
 * before selection runs. selectCarryOver re-applies this rule itself and is
 * the sole authority on what actually counts as carry-over; a drift here
 * would just mean an unnecessary or overly narrow `bd list`, never a wrong
 * carry-over decision.
 */
const OPEN_CARRYOVER_STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'deferred']);

/**
 * Mirrors carry-over.mjs's own (private, unexported) DEFAULT_MAX_CARRY_OVER.
 * Used ONLY to word the suppressed-items summary bead's human-readable
 * "current limit" note -- selectCarryOver applies the authoritative default
 * itself regardless of this constant, so a drift here affects wording, never
 * the actual cut.
 */
const DEFAULT_MAX_CARRY_OVER = 25;

const noopLog = () => {};

// ---------------------------------------------------------------------------
// Step 0: validate this verb's own inputs.
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes `runFinalize`'s `opts`.
 *
 * @param {{ handle?: object, secretName?: string, dryRun?: boolean, maxCarryOver?: number, resolved?: object }} opts
 * @returns {{ handle: object, secretName: string, dryRun: boolean, maxCarryOver: number|undefined, resolved: object|undefined }}
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
export function validateFinalizeOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  const handle = o.handle;
  if (!handle || typeof handle !== 'object') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'finalize: opts.handle (the SprintHandle written by launch) is required',
      { field: 'handle' }
    );
  }
  if (typeof handle.sprintId !== 'string' || handle.sprintId.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'finalize: opts.handle.sprintId must be a non-empty string',
      { field: 'handle.sprintId' }
    );
  }
  if (handle.startedAt === undefined || handle.startedAt === null) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'finalize: opts.handle.startedAt is required -- carry-over rule 3 ("attributable to this sprint") has nothing to compare created_at against otherwise',
      { field: 'handle.startedAt' }
    );
  }

  if (!o.secretName || typeof o.secretName !== 'string') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'finalize: opts.secretName is required (the stored tracker-credential NAME, never a value) -- publishCarryOver forwards it to the adapter',
      { field: 'secretName' }
    );
  }

  let maxCarryOver;
  if (o.maxCarryOver !== undefined) {
    if (!Number.isInteger(o.maxCarryOver) || o.maxCarryOver < 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `finalize: opts.maxCarryOver must be a non-negative integer, got ${JSON.stringify(o.maxCarryOver)}`,
        { field: 'maxCarryOver' }
      );
    }
    maxCarryOver = o.maxCarryOver;
  }

  return Object.freeze({
    handle,
    secretName: o.secretName,
    dryRun: o.dryRun === true,
    maxCarryOver,
    resolved: o.resolved,
  });
}

/**
 * Validates `runFinalize`'s injected `deps`, defaulting `log` to a no-op.
 * A missing injected dependency is CONFIG_MISSING, never a connectivity code
 * -- see the error-rule corollary in fleet-bridge-build-log.md: "a missing
 * injected dependency is never SUPERVISOR_UNAVAILABLE".
 *
 * @param {{ supervisorClient?: object, beads?: object, adapter?: object, spool?: object, log?: Function }} deps
 * @returns {{ supervisorClient: object, beads: object, adapter: object, spool: object, log: Function }}
 * @throws {BridgeError} CONFIG_MISSING
 */
function validateFinalizeDeps(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};

  if (!d.supervisorClient || typeof d.supervisorClient.getSprint !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'finalize: deps.supervisorClient must expose getSprint() -- none was provided to runFinalize()',
      { param: 'deps.supervisorClient' }
    );
  }
  if (!d.beads || typeof d.beads.list !== 'function' || typeof d.beads.create !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'finalize: deps.beads must expose list() and create() -- none was provided to runFinalize()',
      { param: 'deps.beads' }
    );
  }
  if (!d.adapter || typeof d.adapter.publishCarryOver !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'finalize: deps.adapter must expose publishCarryOver() -- none was provided to runFinalize()',
      { param: 'deps.adapter' }
    );
  }
  if (!d.spool || typeof d.spool.complete !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'finalize: deps.spool must expose complete() -- none was provided to runFinalize()',
      { param: 'deps.spool' }
    );
  }

  // `archive` is OPTIONAL, and duck-typed rather than required: an
  // operator who has configured no blob storage must still be able to
  // finalize. A value that IS present but cannot publish is a wiring
  // mistake worth failing on, though -- silently ignoring it is how a
  // configured-but-dead export stays invisible.
  if (d.archive !== undefined && d.archive !== null && typeof d.archive.publish !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'finalize: deps.archive, when provided, must expose publish({ sprintId, state })',
      { param: 'deps.archive' }
    );
  }

  return {
    supervisorClient: d.supervisorClient,
    beads: d.beads,
    adapter: d.adapter,
    spool: d.spool,
    archive: d.archive || null,
    log: typeof d.log === 'function' ? d.log : noopLog,
  };
}

// ---------------------------------------------------------------------------
// Step 1: assert terminal state.
// ---------------------------------------------------------------------------

/**
 * Step 1 -- "Assert terminal state." Finalizing a live sprint would push
 * carry-over for work still in progress, so this refuses anything that is
 * not `terminal: true` per supervisorClient.getSprint()'s normalised shape
 * (a missing sprint -- getSprint() returning null/undefined -- is refused
 * the same way: there is nothing terminal to finalize).
 *
 * @param {string} sprintId
 * @param {{ getSprint: (id: string) => Promise<any> }} supervisorClient
 * @returns {Promise<object>} the sprint object, guaranteed `terminal: true`
 * @throws {BridgeError} FINALIZE_NOT_TERMINAL
 */
export async function assertSprintTerminal(sprintId, supervisorClient) {
  const sprint = await supervisorClient.getSprint(sprintId);
  // Terminality is decided by snapshot.mjs's isSprintTerminal() -- the one
  // definition -- NOT by a local `sprint.terminal` test. That flag is present
  // only in getSprint()'s dashboard-linger shape; a finished sprint whose
  // reservation has been released comes back as `{live:false, history, ...}`
  // with no flag at all, and this function used to read that as "still live"
  // and refuse forever. See isSprintTerminal()'s header for the three shapes
  // and why a second copy of this rule is what broke it.
  if (!isSprintTerminal(sprint)) {
    const reason = !sprint
      ? 'not found'
      : (sprint.live === true
        ? 'still live'
        : 'not confirmed finished (no terminal event recorded for it yet)');
    throw new BridgeError(
      BRIDGE_ERROR_CODES.FINALIZE_NOT_TERMINAL,
      `finalize: sprint "${sprintId}" is ${reason} -- finalize refuses to run against a non-terminal sprint, since it would push carry-over for work still in progress`,
      { sprintId, found: Boolean(sprint), live: Boolean(sprint && sprint.live) }
    );
  }
  return sprint;
}

// ---------------------------------------------------------------------------
// Step 2: query candidate rows.
// ---------------------------------------------------------------------------

/**
 * Normalizes a SprintHandle's `startedAt` (epoch-ms number OR ISO-8601
 * string -- contracts.mjs's makeSprintHandle accepts either, matching
 * carry-over.mjs's own `toEpochMs`) into an ISO-8601 string suitable for a
 * `bd list --created-after` value. An ISO string is returned unchanged
 * (never reparsed and reformatted, so a caller-supplied value's exact
 * representation survives).
 *
 * @param {number|string} value
 * @returns {string}
 * @throws {BridgeError} CONFIG_INVALID
 */
export function toIsoTimestamp(value) {
  if (typeof value === 'string' && value.length > 0) {
    // Validated, not just passed through: a malformed string handle.startedAt
    // is caller-supplied bad input and must fail fast here (CONFIG_INVALID),
    // the same way carry-over.mjs's own startedAt validation would reject it
    // -- rather than silently reaching `bd list --created-after <garbage>`.
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  throw new BridgeError(
    BRIDGE_ERROR_CODES.CONFIG_INVALID,
    `finalize: handle.startedAt is not a valid timestamp: ${JSON.stringify(value)}`,
    { startedAt: value }
  );
}

/**
 * Step 2 -- "Query candidate rows." `bd list --status
 * open,in_progress,blocked,deferred --created-after <ISO-8601 startedAt>`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MUST ROUTE THROUGH beads-client.mjs's SYNC EXEC PATH
 * ---------------------------------------------------------------------------
 * `createdAfter` here is always an ISO-8601 string (see toIsoTimestamp()
 * above), which contains ':'. beads-client.mjs's `hasFreeTextArg()` routes
 * ANY argv containing a non-safe-charset element through `execBdSync`
 * (`execBdAsync` would throw on it) -- so this call, and therefore every
 * `bd list --created-after ...` finalize issues, always takes the sync path.
 * Getting this wrong (e.g. passing a bare epoch-ms number that some future
 * refactor stringifies without a colon, or narrowing the call to look
 * "safe") breaks carry-over silently AT RUNTIME against the real beads CLI,
 * never in a test built only against a hand-rolled fake -- see
 * finalize.test.mjs's dedicated test against the REAL beads-client
 * (mirroring ingest.test.mjs's own "against the real beads-client" section)
 * for the assertion that actually exercises this.
 *
 * @param {{ startedAt: number|string }} handle
 * @param {{ list: (opts: object) => Promise<any[]> }} beads
 * @returns {Promise<object[]>} raw `bd list --json` rows
 */
export async function queryCandidateRows(handle, beads) {
  const createdAfter = toIsoTimestamp(handle.startedAt);
  const rows = await beads.list({
    status: OPEN_CARRYOVER_STATUSES.join(','),
    createdAfter,
  });
  return Array.isArray(rows) ? rows : [];
}

// ---------------------------------------------------------------------------
// Step 4: dry run, then publish -- per item, so one failure never aborts the rest.
// ---------------------------------------------------------------------------

/** Best-effort, safe description of any thrown value (BridgeError or not). */
function describeError(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * The always-first dry-run preview: one BATCHED adapter.publishCarryOver()
 * call (the pinned contract's shape: one entry per input beadId, in input
 * order), logged so an operator can see the plan before anything real is
 * pushed. A failure here is non-fatal -- the preview is a convenience, not a
 * gate -- so it is logged and swallowed rather than blocking the real
 * publish attempts that follow.
 *
 * @param {string[]} beadIds
 * @param {{ adapter: object, beads: object, secretName: string, log: Function }} ctx
 * @returns {Promise<void>}
 */
async function previewPublish(beadIds, { adapter, beads, secretName, log }) {
  if (beadIds.length === 0) return;
  try {
    await adapter.publishCarryOver({ beadIds, secretName, dryRun: true }, { beads });
    log(`[finalize] dry-run publish plan: ${beadIds.length} bead(s) would be pushed: ${beadIds.join(', ')}`);
  } catch (err) {
    log(`[finalize] dry-run preview failed (continuing to real publish attempts): ${describeError(err)}`);
  }
}

/**
 * Publishes exactly one bead via adapter.publishCarryOver(), called with a
 * single-element `beadIds` array so a genuine publish failure for THIS bead
 * cannot throw out of the caller's loop and abort the rest of the batch --
 * see the module header's "FAILURE HANDLING". `CARRYOVER_PUBLISH_FAILED` is
 * never thrown from here: the failure is captured in the returned record's
 * `error` field instead.
 *
 * @param {string} beadId
 * @param {{ adapter: object, beads: object, secretName: string, log: Function }} ctx
 * @returns {Promise<{ beadId: string, externalRef: string|null, pushed: boolean, error: string|null }>}
 */
export async function publishOne(beadId, { adapter, beads, secretName, log }) {
  try {
    const raw = await adapter.publishCarryOver({ beadIds: [beadId], secretName, dryRun: false }, { beads });
    const result = Array.isArray(raw) ? raw[0] : raw;
    return {
      beadId,
      externalRef: result && typeof result.externalRef === 'string' ? result.externalRef : null,
      pushed: Boolean(result && result.pushed),
      error: null,
    };
  } catch (err) {
    const message = describeError(err);
    log(`[finalize] publishCarryOver failed for ${beadId} (continuing with the rest of the batch): ${message}`);
    return { beadId, externalRef: null, pushed: false, error: message };
  }
}

/**
 * Publishes every selected bead, one at a time, isolating each one's failure
 * per publishOne()'s doc comment.
 *
 * @param {string[]} beadIds
 * @param {{ adapter: object, beads: object, secretName: string, log: Function }} ctx
 * @returns {Promise<Array<{ beadId: string, externalRef: string|null, pushed: boolean, error: string|null }>>}
 */
export async function publishSelected(beadIds, ctx) {
  const published = [];
  for (const beadId of beadIds) {
    // eslint-disable-next-line no-await-in-loop -- ordered, ISOLATED per-item
    // publishes: see publishOne()'s doc comment for why this cannot become a
    // Promise.all (a rejection would abort the batch, exactly what this
    // module must never do).
    published.push(await publishOne(beadId, ctx));
  }
  return published;
}

// ---------------------------------------------------------------------------
// Step 5: suppressed items get one summary work item.
// ---------------------------------------------------------------------------

/**
 * Builds the local bead fields for the suppressed-items summary -- one item,
 * naming the count and how to retrieve the rest (`finalize --max-carry-over
 * <bigger>`), per implementation-plan.md's amendment: a `--max-carry-over`
 * breach no longer means "publish nothing and fail loudly", but it must
 * never silently strand the excess in the local beads DB either.
 *
 * @param {object[]} suppressed - CarryOverItem records (carry-over.mjs's `suppressed`)
 * @param {number} effectiveMaxCarryOver - the limit actually in effect, for the wording only
 * @returns {{ title: string, description: string, issueType: string }}
 */
export function buildSuppressedSummaryBead(suppressed, effectiveMaxCarryOver) {
  const ids = suppressed.map((item) => item && item.beadId).filter(Boolean);
  return {
    title: `[carry-over] ${suppressed.length} more item(s) suppressed by --max-carry-over (current limit: ${effectiveMaxCarryOver})`,
    description:
      `This sprint produced ${suppressed.length} additional carry-over candidate(s) beyond the `
      + `--max-carry-over limit (${effectiveMaxCarryOver}). They remain open, unpublished, in the local `
      + `beads DB -- re-run "finalize --max-carry-over <bigger>" to retrieve them. `
      + `Suppressed bead id(s): ${ids.join(', ')}`,
    issueType: 'task',
  };
}

/**
 * Step 5 -- files (and, unless dryRun, publishes) exactly one summary bead
 * when `suppressed` is non-empty. A no-op (returns `null`) when `suppressed`
 * is empty, or when `opts.dryRun` is set (see the module header's "WHY DRY
 * RUN TOUCHES NOTHING, NOT EVEN LOCALLY" -- a dry run must not create a real
 * local bead). `beads.create()` failing is treated the same way an
 * individual publish failure is: logged and swallowed, never thrown, so a
 * local-DB hiccup filing the SUMMARY item cannot roll back the selected
 * items already published in step 4.
 *
 * @param {object[]} suppressed
 * @param {{ maxCarryOver: number, dryRun: boolean }} opts
 * @param {{ beads: object, adapter: object, secretName: string, log: Function }} deps
 * @returns {Promise<{ beadId: string|null, published: object|null }|null>}
 */
export async function fileSuppressedSummary(suppressed, opts, deps) {
  if (!Array.isArray(suppressed) || suppressed.length === 0) return null;

  const { beads, adapter, secretName, log } = deps;
  const effectiveMaxCarryOver = typeof opts.maxCarryOver === 'number' ? opts.maxCarryOver : DEFAULT_MAX_CARRY_OVER;
  const fields = buildSuppressedSummaryBead(suppressed, effectiveMaxCarryOver);

  if (opts.dryRun) {
    log(`[finalize] dry-run: would file a suppressed-items summary bead ("${fields.title}") and push it to the tracker`);
    return { beadId: null, published: null };
  }

  let created;
  try {
    created = await beads.create(fields);
  } catch (err) {
    log(`[finalize] failed to file the suppressed-items summary bead (non-fatal, ${suppressed.length} item(s) remain silently strandable -- see log above): ${describeError(err)}`);
    return null;
  }
  const beadId = created && typeof created.id === 'string' && created.id.length > 0 ? created.id : null;
  if (!beadId) {
    log('[finalize] beads.create() for the suppressed-items summary did not return a usable id (non-fatal)');
    return null;
  }

  const published = await publishOne(beadId, { adapter, beads, secretName, log });
  return { beadId, published };
}

// ---------------------------------------------------------------------------
// Terminal facts: verdict / prUrl / spend, and the analysis-doc path.
// ---------------------------------------------------------------------------
// verdictFromSprint / prUrlFromSprint / spendUsdFromSprint are imported from
// ../snapshot.mjs (see this module's header); computeBranchSlug is imported
// from the engine's apra-fleet-se/fleet-sprint/sprint-report.mjs. Both used
// to be reimplemented here -- see the module header's "REUSE, NOT
// REIMPLEMENTATION" for why that duplication existed and why it is gone.

/**
 * The committed sprint-analysis doc's repo-relative path, or `null` when the
 * handle carries no targetBranch to derive it from (a malformed handle, not
 * something worth throwing over -- the rest of finalize still has useful
 * work to report).
 * @param {string|undefined} targetBranch
 * @returns {string|null}
 */
export function analysisDocPathFor(targetBranch) {
  if (typeof targetBranch !== 'string' || targetBranch.length === 0) return null;
  return `docs/sprint-analysis-${computeBranchSlug(targetBranch)}.md`;
}

// ---------------------------------------------------------------------------
// Step 6: final comment on the root work item.
// ---------------------------------------------------------------------------

/**
 * Builds the final comment body: verdict, PR link, the committed analysis
 * doc path, total spend, and the carry-over items created with their new
 * (tracker-side) ids.
 * `archive` is optional and only present when an archive destination is
 * configured (see the archive step in runFinalize). It is reported either
 * way when configured: the URL when the export landed, and an explicit
 * "export FAILED" line when it did not -- a missing line would read as "no
 * archive was wanted", which is exactly the ambiguity that lets a broken
 * export go unnoticed.
 * @param {{ verdict: string|undefined, prUrl: string|undefined, analysisDocPath: string|null, spendUsd: number|undefined, published: object[], suppressedSummary: {beadId:string|null,published:object|null}|null, archive?: object|null }} facts
 * @returns {string}
 */
export function buildFinalCommentBody({ verdict, prUrl, analysisDocPath, spendUsd, published, suppressedSummary, archive }) {
  const lines = [];
  lines.push(`Sprint finished: ${verdict || 'UNKNOWN'}`);
  lines.push(prUrl ? `PR: ${prUrl}` : 'PR: (none)');
  lines.push(analysisDocPath ? `Analysis: ${analysisDocPath}` : 'Analysis: (no targetBranch on the handle -- path not derivable)');
  lines.push(`Spend: ${typeof spendUsd === 'number' ? `$${spendUsd.toFixed(2)}` : 'unknown'}`);

  const pushed = published.filter((p) => p.pushed);
  if (pushed.length > 0) {
    lines.push(`Carry-over items created: ${pushed.map((p) => `${p.beadId} -> ${p.externalRef}`).join(', ')}`);
  } else {
    lines.push('Carry-over items created: none');
  }
  if (suppressedSummary && suppressedSummary.beadId) {
    const ref = suppressedSummary.published && suppressedSummary.published.externalRef;
    lines.push(`Suppressed-items summary filed as ${suppressedSummary.beadId}${ref ? ` (${ref})` : ''}`);
  }
  if (archive) {
    if (archive.ok && archive.indexUrl) {
      // A partial export still yields a usable link, so it belongs on the
      // Archive line rather than in the failure branch -- but say so, or an
      // operator opening a page with missing content has no way to know the
      // gap was known about.
      const missing = archive.partial && Array.isArray(archive.failures) ? archive.failures.length : 0;
      lines.push(missing > 0
        ? `Archive: ${archive.indexUrl} (incomplete -- ${missing} file(s) failed to upload)`
        : `Archive: ${archive.indexUrl}`);
    } else {
      const detail = archive.error || (Array.isArray(archive.failures) && archive.failures.length > 0
        ? `${archive.failures.length} of ${archive.attempted} file(s) failed: ${archive.failures[0].reason}`
        : 'no files were uploaded');
      lines.push(`Archive: export FAILED (${detail})`);
    }
  }
  return lines.join('\n');
}

/**
 * Step 6 -- posts the final comment, best-effort. `deps.adapter` is expected
 * to be the per-sprint facade (../adapters/facade.mjs) the wiring layer
 * builds for this sprint, so this function is now just
 * `adapter.comment(markdown)` -- which work item receives it, the
 * resolved-config plumbing, and the REST transport are all the facade's
 * concern, resolved once when it was constructed (see that file's
 * "WORK-ITEM TARGETING" section for the rule this module used to own
 * alone: workItems[0] of the original SprintRequest).
 *
 * Never throws: a missing adapter.comment(), or the comment call itself
 * failing, are both logged and swallowed -- see the module header's
 * "FAILURE HANDLING". In practice the facade already guarantees comment()
 * never rejects (its own "COMMENT NEVER THROWS" section), but this
 * try/catch is kept as this module's own defence -- it must not assume a
 * particular adapter implementation's behaviour, only its shape.
 *
 * @param {string} body
 * @param {{ adapter: object, log: Function }} deps
 * @returns {Promise<{ posted: boolean, error: string|null }>}
 */
export async function postFinalComment(body, deps) {
  const { adapter, log } = deps;

  if (!adapter || typeof adapter.comment !== 'function') {
    log('[finalize] adapter has no comment() method -- skipping the final comment');
    return { posted: false, error: null };
  }

  try {
    await adapter.comment(body);
    return { posted: true, error: null };
  } catch (err) {
    const message = describeError(err);
    log(`[finalize] final comment failed (non-fatal): ${message}`);
    return { posted: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Step 8: unpublished carry-over is a failure of the verb.
// ---------------------------------------------------------------------------

/**
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY PARTIAL COUNTS AS FAILURE
 * ---------------------------------------------------------------------------
 * A real run produced four `published` entries, every one `pushed: false`,
 * every `error: null`, and exit code 0. The verb KNEW nothing had been
 * published and reported success: the operator's carry-over evaporated in
 * silence, and a pipeline branching on the exit code learned nothing. The
 * cause was underneath (beads swallowing a 400 as a Warning with rc 0 --
 * see adapters/azure-devops.mjs), but the verb reporting success over a
 * batch it knew was empty is its own, separate defect, and it is the one
 * that made the first invisible.
 *
 * So: carry-over was SELECTED and something in it is not published ->
 * CARRYOVER_PUBLISH_FAILED (errors.mjs's finalize/carry-over bucket, exit
 * 6), naming the unpublished bead ids.
 *
 * PARTIAL IS A FAILURE TOO, deliberately. Silently losing three of eight
 * carry-over items is the same class of harm as losing eight: the operator
 * cannot see it either way, and "some work vanished" is not a warning-level
 * fact. Two things make failing safe rather than merely strict: this throws
 * only AFTER the spool record and the final comment are written, so the
 * partial outcome is fully recorded; and publishing is idempotent (a
 * published bead carries its external_ref, and the next run's adapter
 * neither recreates nor re-reports it), so the pipeline's natural response
 * -- retry -- picks up exactly the stragglers and cannot duplicate the rest.
 * A warning would have to be noticed by a human to mean anything; a
 * non-zero exit is noticed by the pipeline.
 *
 * TWO NON-FAILURES, both intentional:
 *   - `dryRun`: a dry run publishes nothing BY DESIGN (every entry is
 *     `pushed: false`), so it must still exit 0 or the documented
 *     "run --dry-run first" workflow would be unusable.
 *   - nothing selected: a sprint that finished all its work has no
 *     carry-over to lose. That is the good outcome, not a failure.
 *
 * @param {{ published: object[], dryRun: boolean, sprintId: string }} ctx
 * @throws {BridgeError} CARRYOVER_PUBLISH_FAILED
 */
export function assertCarryOverPublished({ published, dryRun, sprintId }) {
  if (dryRun) return;
  const attempted = Array.isArray(published) ? published : [];
  if (attempted.length === 0) return;

  const unpublished = attempted.filter((p) => !p || p.pushed !== true);
  if (unpublished.length === 0) return;

  const detail = unpublished
    .map((p) => `${p && p.beadId ? p.beadId : '(unknown bead)'}${p && p.error ? `: ${p.error}` : ': no error reported -- the publish reported no tracker ref for it'}`)
    .join('; ');

  throw new BridgeError(
    BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED,
    `finalize: ${unpublished.length} of ${attempted.length} carry-over item(s) for sprint "${sprintId}" were NOT published to the tracker -- ${detail}. `
      + 'The sprint result and any final comment were still recorded; re-running finalize republishes only the missing items (a published bead carries its tracker ref and is not published twice).',
    {
      sprintId,
      attempted: attempted.length,
      unpublished: unpublished.map((p) => p && p.beadId).filter(Boolean),
    }
  );
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

/**
 * `fleet-bridge finalize`: runs once a sprint reaches terminal state --
 * selects and publishes carry-over, files a suppressed-items summary when
 * needed, posts a final comment, and records completion in the spool. See
 * the file-level doc comment for the full sequence and its failure-handling
 * rules.
 *
 * @param {{ handle: object, secretName: string, dryRun?: boolean, maxCarryOver?: number, resolved?: object }} opts
 * @param {{ supervisorClient: object, beads: object, adapter: object, spool: object, log?: Function }} deps
 * @returns {Promise<{
 *   verdict: string|undefined,
 *   prUrl: string|undefined,
 *   analysisDocPath: string|null,
 *   spendUsd: number|undefined,
 *   carryOver: { selected: object[], published: object[], suppressed: object[], skipped: object[] },
 *   dryRun: boolean,
 * }>}
 * @throws {BridgeError} CONFIG_MISSING, CONFIG_INVALID, FINALIZE_NOT_TERMINAL,
 *   and whatever the injected collaborators themselves throw (e.g.
 *   SUPERVISOR_UNAVAILABLE, BEADS_FAILED) for a genuine infrastructure
 *   failure this verb cannot meaningfully proceed past.
 */
/**
 * Step 5b -- build and upload the archive SPA, when one is configured.
 * Returns `null` when no archive destination is wired (the common case for
 * an operator with no blob storage), or the publisher's structured result.
 * Never throws: see the archive step's rationale in `runFinalize`.
 *
 * @param {string} sprintId
 * @param {object} sprint - step 1's terminal sprint (its `.state` is the page's data).
 * @param {{ archive: object|null, log: Function }} d
 * @returns {Promise<object|null>}
 */
async function runArchiveExport(sprintId, sprint, d) {
  if (!d.archive) return null;
  const state = sprint && sprint.state;
  let result;
  try {
    result = await d.archive.publish({ sprintId, state });
  } catch (err) {
    // The publisher contracts not to throw; if it does anyway, that is a
    // defect in it and not a reason to lose an otherwise-good finalize.
    result = { attempted: 0, uploaded: 0, failures: [], indexUrl: null, ok: false, error: describeError(err) };
  }
  if (result && result.ok) {
    // `ok` now means "the index uploaded, so the link works" -- NOT "every
    // file uploaded". `partial` carries the difference. Reporting a partial
    // export with the same line as a clean one would hide a real gap behind
    // a success message, which is the failure shape this package keeps
    // hitting; name the missing files instead.
    if (result.partial) {
      const missing = Array.isArray(result.failures) ? result.failures : [];
      const first = missing.length > 0 ? ` first: ${missing[0].path} (${missing[0].reason})` : '';
      d.log(
        `[finalize] archive published WITH GAPS: ${result.uploaded} of ${result.attempted} file(s) -> `
        + `${result.indexUrl} -- ${missing.length} file(s) failed to upload, so the page will be `
        + `missing content.${first}`,
      );
      return result;
    }
    d.log(`[finalize] archive published: ${result.uploaded} file(s) -> ${result.indexUrl}`);
    return result;
  }
  const rule = '='.repeat(72);
  const detail = (result && result.error)
    || (result && Array.isArray(result.failures) && result.failures.length > 0
      ? `${result.failures.length} of ${result.attempted} file(s) failed; first: ${result.failures[0].path} (${result.failures[0].reason})`
      : 'no files were uploaded');
  d.log([
    rule,
    `  SPRINT ARCHIVE EXPORT FAILED: ${sprintId}`,
    rule,
    `  ${detail}`,
    '  An archive destination IS configured, so this is a real failure, not a skipped optional step.',
    '  The sprint result itself is unaffected: carry-over and the final comment are unchanged,',
    '  and the local JSONL mirror remains the complete record of this sprint.',
    '  Fix: check the SAS expiry and write permission (the archive needs create/write on the container),',
    '  then re-run finalize for this sprint -- the export overwrites and is safe to repeat.',
    rule,
  ].join('\n'));
  return result;
}

export async function runFinalize(opts, deps) {
  const validated = validateFinalizeOpts(opts);
  const d = validateFinalizeDeps(deps);
  const { handle, secretName, dryRun, maxCarryOver } = validated;

  // 1. Assert terminal state.
  const sprint = await assertSprintTerminal(handle.sprintId, d.supervisorClient);

  // 2. Query candidate rows.
  const rows = await queryCandidateRows(handle, d.beads);

  // 3. Select.
  const { selected, suppressed, skipped } = selectCarryOver(rows, {
    startedAt: handle.startedAt,
    syntheticRootId: handle.syntheticRootId,
    maxCarryOver,
  });
  const selectedBeadIds = selected.map((item) => item.beadId).filter(Boolean);

  // 4. Dry run always first, then publish for real unless opts.dryRun.
  await previewPublish(selectedBeadIds, { adapter: d.adapter, beads: d.beads, secretName, log: d.log });
  const published = dryRun
    ? selectedBeadIds.map((beadId) => ({ beadId, externalRef: null, pushed: false, error: null }))
    : await publishSelected(selectedBeadIds, { adapter: d.adapter, beads: d.beads, secretName, log: d.log });

  // 5. Suppressed items get one summary work item.
  const suppressedSummary = await fileSuppressedSummary(
    suppressed,
    { maxCarryOver, dryRun },
    { beads: d.beads, adapter: d.adapter, secretName, log: d.log }
  );
  if (suppressedSummary && suppressedSummary.published) {
    published.push(suppressedSummary.published);
  }

  // 5b. Archive export -- the D1 archive SPA (see spa/archive-publisher.mjs).
  //
  // WHY HERE: the design says "at finalize, export the terminal sprint as a
  // self-contained static site", and this is the only place that has the
  // terminal state in hand (step 1's getSprint) at a moment when it will
  // not change again. It runs BEFORE the final comment on purpose, so the
  // comment can carry the archive URL -- a permanent page nobody is told
  // about is not much better than no page.
  //
  // WHY IT CANNOT FAIL THIS VERB: the sprint is over and carry-over has
  // already been published; turning "the storage account was unreachable"
  // into a failed finalize would report a sprint failure that did not
  // happen. WHY IT IS STILL LOUD: the outcome is written into the returned
  // result, into the spool record, into the final comment, and -- on
  // failure -- into a multi-line log banner. A configured export that
  // quietly does nothing is the exact failure shape this package keeps
  // paying for.
  const archive = await runArchiveExport(handle.sprintId, sprint, d);

  // Terminal facts, and the analysis doc's deterministic path.
  const verdict = verdictFromSprint(sprint);
  const prUrl = prUrlFromSprint(sprint);
  const spendUsd = spendUsdFromSprint(sprint);
  const analysisDocPath = analysisDocPathFor(handle.request && handle.request.targetBranch);

  // 6. Final comment -- skipped entirely on a dry run (see the module
  // header's "WHY DRY RUN TOUCHES NOTHING, NOT EVEN LOCALLY"). Which work
  // item receives it is the facade's decision, not this module's -- see
  // postFinalComment()'s doc comment.
  if (dryRun) {
    d.log('[finalize] dry-run: skipping the final comment');
  } else {
    const body = buildFinalCommentBody({ verdict, prUrl, analysisDocPath, spendUsd, published, suppressedSummary, archive });
    await postFinalComment(body, { adapter: d.adapter, log: d.log });
  }

  const result = Object.freeze({
    verdict,
    prUrl,
    analysisDocPath,
    spendUsd,
    carryOver: { selected, published, suppressed, skipped },
    archive,
    dryRun,
  });

  // 7. spool.complete(sprintId, result) -- always, regardless of any
  // per-item publish/comment failure recorded above.
  await d.spool.complete(handle.sprintId, result);

  // 8. Unpublished carry-over is a FAILURE of this verb -- see
  // assertCarryOverPublished() for the full rationale. Deliberately AFTER
  // step 7: the spool record and the final comment describe what actually
  // landed, and they must exist before this throws.
  assertCarryOverPublished({ published, dryRun, sprintId: handle.sprintId });

  return result;
}

export default runFinalize;
