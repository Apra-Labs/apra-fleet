// native-beads-sync.mjs -- the shared ingest/publishCarryOver implementation
// every bridge adapter with a native `bd <namespace> pull/push` integration
// wires in (fleet-bridge-implementation-plan.md Part B: "src/adapters/lib/
// native-beads-sync.mjs -- shared impl parameterised by 'ado' | 'github'").
//
// This is a thin wrapper over the injected beads client's trackerPull/
// trackerPush (see ../../beads-client.mjs) -- it adds no policy of its own
// beyond picking the namespace string. That is deliberate: it is what makes
// Phase 4 (the GitHub adapter) nearly free -- a github.mjs descriptor calls
// this exact factory with `namespace: 'github'` and differs from
// azure-devops.mjs in nothing else.
//
// DECLARATIVE ONLY: `nativeBeadsSync` (the capability flag a descriptor
// reports) selects WHICH implementation is wired into `ingest`/
// `publishCarryOver` at adapter-authoring time. No caller above the adapter
// layer may branch on it -- see test/adapters.test.mjs's source-scan guard,
// which asserts no file outside src/adapters/ references the string
// `nativeBeadsSync`.
//
// Nothing here touches process.env, node:fs, or a real network call: `beads`
// is injected by the caller (a verb's `deps`), exactly like every other
// fleet-bridge module.

import { BridgeError, BRIDGE_ERROR_CODES } from '../../errors.mjs';

/** The two tracker namespaces this factory (and the beads client it wraps)
 *  understands. Kept as an explicit list rather than inferred from usage, so
 *  a typo in a future adapter fails at construction, not at the first pull. */
const KNOWN_NAMESPACES = Object.freeze(['ado', 'github']);

/**
 * ---------------------------------------------------------------------------
 * REF NORMALIZATION -- why `ingest`'s match can't be plain string equality
 * ---------------------------------------------------------------------------
 * The caller passes `bd <namespace> pull` a bare work item id (`2`) --
 * that is the documented, correct positional-arg form (`bd ado pull --help`:
 * "Accepts bead IDs or external references as positional arguments"). But
 * beads stamps `external_ref` with the FULL tracker URL, not the bare id.
 * Verified live against a real Azure DevOps project:
 *
 *   external_ref = "https://dev.azure.com/apralabs/cf92b860-87bf-49f1-9400-b26a2963a20c/_workitems/edit/2"
 *
 * Note the project GUID sitting in the middle of that URL -- it contains the
 * digit sequences of plenty of other work item ids as substrings of itself,
 * and the org/project segments could too. So the one thing this match must
 * NEVER do is substring-search: "does the URL contain '2'" would match this
 * row for refs `2`, `92`, `20`, `926` (from the GUID), and more. A false
 * match here is worse than a missed one -- it would silently ingest the
 * wrong work item into a sprint. The only safe comparison is on the WHOLE
 * trailing identifier segment of each side, never a substring of either.
 *
 * This is not an Azure DevOps quirk -- GitHub external refs are URLs too --
 * so the rule below is generic, not URL-shape-specific: strip any query
 * string or fragment, then, if what is left looks like a URL or a path (it
 * contains a `/`), take its last non-empty segment; otherwise use the
 * trimmed value as-is. A bare id has no `/`, so it normalizes to itself; the
 * URL above normalizes to `"2"` -- the two now compare equal on identity,
 * whole-segment, with no substring involved anywhere.
 *
 * @param {*} value
 * @returns {string} the normalized identity, or `''` if `value` carries none
 *   (not a non-empty string, or normalizes away to nothing -- e.g. a bare
 *   `/`). An empty identity is never used as a match key: see `byIdentity`
 *   below, which only indexes non-empty identities.
 */
function normalizeRefIdentity(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  // Drop a query string or fragment wherever it starts -- this is a plain
  // "cut at the first ? or #", not a URL parse, so it also works for a
  // scheme-less path like "workitems/2?_a=edit".
  const withoutQueryOrFragment = trimmed.split(/[?#]/, 1)[0];

  // Not path-like: no separator to split on, so the whole (query/fragment-
  // stripped) value IS the identifier -- e.g. a bare id ("2") or a
  // non-URL external ref with no internal structure.
  if (!withoutQueryOrFragment.includes('/')) return withoutQueryOrFragment;

  // Path-like (a URL or a bare path): the identifier is the LAST non-empty
  // segment -- e.g. ".../edit/2" -> "2" -- never any earlier segment (the
  // GUID, the org, the project), and never a substring match against the
  // segment itself.
  const segments = withoutQueryOrFragment.split('/').filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

/**
 * ---------------------------------------------------------------------------
 * ACCEPTANCE-CRITERIA RESOLUTION -- why this doesn't just read one field
 * ---------------------------------------------------------------------------
 * The naive read is `row.acceptance_criteria`. Verified live against a real
 * Azure DevOps project (Basic process template, `Issue` work item type):
 * `bd show <id> --json` returns no `acceptance_criteria` key AT ALL, so that
 * read is `undefined` on every single row, every time -- not a missing-data
 * edge case, the normal case.
 *
 * This is not a beads quirk, it's a tracker-field-coverage problem the gate
 * has to design around. A dedicated acceptance-criteria field
 * (`Microsoft.VSTS.Common.AcceptanceCriteria` on Azure DevOps) exists only on
 * SOME work item types in SOME process templates -- Agile's `User Story` has
 * it, Basic's `Issue` (what this project uses) does not, and a custom
 * process could go either way. GitHub issues have no such field, ever;
 * neither does Bitbucket. A gate that reads only the dedicated field and
 * nothing else can therefore never pass on GitHub at all, and passes on
 * Azure DevOps only for particular work item types -- which is exactly the
 * kind of type-shaped assumption this bridge is contractually forbidden from
 * making (docs/setup.md "A note on work item types": "The bridge never
 * assumes a work item type").
 *
 * What beads DOES reliably carry, regardless of tracker or work item type,
 * is `description` -- already converted from the tracker's HTML/markdown
 * into markdown text. So resolution falls back to a criteria section
 * extracted from `description` when the dedicated field is absent or empty.
 * First hit wins, in this priority order:
 *   1. `row.acceptance_criteria`, if the row actually carries it (checked
 *      for presence, never assumed) AND it is non-empty. This stays highest
 *      priority: when a process template DOES populate a dedicated field,
 *      that's the highest-quality, most deliberately-authored source, and it
 *      should win over parsing prose.
 *   2. A criteria section extracted from `description` (see
 *      `extractCriteriaFromDescription` below).
 *   3. Neither -> `undefined`, meaning the bead genuinely has no criteria.
 *      This is a real "missing criteria" result, not a resolution failure --
 *      `verbs/ingest.mjs`'s audit gate depends on being able to tell the
 *      difference between "no criteria found anywhere" and "found, but
 *      empty," and both of those are folded into `undefined` here on
 *      purpose (an empty dedicated field and a heading with nothing under it
 *      are the same non-answer to "what should the doer implement").
 *
 * @param {*} row a `bd show`/`bd list` row (shape varies by beads version and
 *   tracker; never assume any field beyond `description` is present)
 * @returns {string|undefined}
 */
function resolveAcceptanceCriteria(row) {
  if (row && typeof row.acceptance_criteria === 'string' && row.acceptance_criteria.trim().length > 0) {
    return row.acceptance_criteria;
  }
  return extractCriteriaFromDescription(row && row.description);
}

/**
 * ---------------------------------------------------------------------------
 * DESCRIPTION-BODY EXTRACTION -- the recognized forms, and why so few
 * ---------------------------------------------------------------------------
 * Finds a heading that introduces acceptance criteria and returns everything
 * from just after it up to the next heading of the same-or-higher level (or
 * the end of the description if there is none). A no-content or
 * whitespace-only result is treated as "no heading found" (returns
 * `undefined`), not as an empty-but-present criteria block -- see
 * `resolveAcceptanceCriteria`'s point 3 above.
 *
 * Deliberately NOT handled: this does not fall back to "use the whole
 * description" when no heading is found. That would make the gate
 * meaningless -- every bead with any description at all would pass,
 * defeating the reason the gate exists (design.md 2.7: catching vague input
 * before a sprint burns time guessing at it). No heading means no criteria,
 * full stop.
 *
 * Only two heading FORMS are recognized, on purpose -- this is a deliberately
 * small list, not an attempt at a general markdown/HTML parser:
 *   - Bold-as-heading: a line that is ENTIRELY `**text**` (optionally with a
 *     trailing colon), e.g. `**Acceptance criteria**`. This is what beads'
 *     real Azure DevOps conversion produces live.
 *   - ATX heading: `#` through `######` followed by text, e.g.
 *     `## Acceptance criteria`. Equally likely from a human- or
 *     other-tool-authored description.
 * A bold heading has no explicit nesting level, so it is treated as the
 * deepest possible level (6, same as `######`) for the "next heading of the
 * same-or-higher level" comparison: any following heading, bold or ATX,
 * closes a bold-opened section. An ATX heading keeps its real level, so a
 * deeper ATX heading nested under it (e.g. `###` under an opening `##`) is
 * treated as part of the section, not a boundary -- only a sibling-or-higher
 * heading ends it.
 *
 * The heading text is matched case-insensitively against a small set of
 * common spellings: "Acceptance criteria", "AC", "Acceptance" (a trailing
 * colon on the heading text is ignored before matching).
 *
 * @param {*} description
 * @returns {string|undefined}
 */
const CRITERIA_HEADING_NAMES = new Set(['acceptance criteria', 'ac', 'acceptance']);

/** @param {string} line @returns {{ level: number, text: string }|null} */
function matchHeadingLine(line) {
  const atx = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (atx) return { level: atx[1].length, text: atx[2] };

  const bold = line.trim().match(/^\*\*([^*]+)\*\*:?\s*$/);
  if (bold) return { level: 6, text: bold[1] };

  return null;
}

export function extractCriteriaFromDescription(description) {
  if (typeof description !== 'string' || description.length === 0) return undefined;

  const lines = description.split(/\r\n|\r|\n/);

  let startIndex = -1;
  let startLevel = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = matchHeadingLine(lines[i]);
    if (!heading) continue;
    const normalized = heading.text.trim().replace(/:+\s*$/, '').trim().toLowerCase();
    if (CRITERIA_HEADING_NAMES.has(normalized)) {
      startIndex = i;
      startLevel = heading.level;
      break;
    }
  }
  if (startIndex === -1) return undefined;

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const heading = matchHeadingLine(lines[i]);
    if (heading && heading.level <= startLevel) {
      endIndex = i;
      break;
    }
  }

  const section = lines.slice(startIndex + 1, endIndex).join('\n').trim();
  return section.length > 0 ? section : undefined;
}

/**
 * ---------------------------------------------------------------------------
 * PINNED CONTRACTS -- read before changing either return shape below
 * ---------------------------------------------------------------------------
 * `bd <namespace> pull`/`push` are fire-and-forget against the local beads
 * DB: they report dispatch success, not structured bead data (see `ingest`'s
 * doc comment for why a read-back is required). Both return shapes below are
 * pinned so a producer (this file) and a consumer written independently
 * cannot drift apart -- the exact failure mode that motivated this comment
 * (fleet-bridge-build-log.md "Pinned contracts between units").
 *
 * `ingest({ refs, secretName })` resolves to the contract
 * `verbs/ingest.mjs`'s `normalizePulledItem()` depends on:
 *   Promise<Array<{
 *     beadId: string,               // local bd id (`bd list`/`show`'s `id`)
 *     externalRef: string,          // the input ref this record matched on,
 *                                   // verbatim (never a tracker-normalised
 *                                   // form)
 *     title: string|undefined,
 *     parent: string|null,          // the bead's local --parent, or null
 *     acceptanceCriteria: string|undefined, // see resolveAcceptanceCriteria:
 *                                   // dedicated field if present and
 *                                   // non-empty, else a criteria section
 *                                   // extracted from description, else
 *                                   // undefined
 *   }>>
 * One entry per input `ref`, in no particular order; a `ref` that matches no
 * bead after the pull is never silently dropped -- see `ingest` below.
 *
 * `publishCarryOver({ beadIds, secretName, dryRun })` resolves to the
 * contract the not-yet-built `verbs/finalize.mjs` will depend on -- pinned
 * here ahead of that consumer landing, per fleet-bridge-design.md Section 8
 * ("the push stamps `external_ref` back onto the bead, which makes the whole
 * operation idempotent"):
 *   Promise<Array<{
 *     beadId: string,
 *     externalRef: string|null,     // the ref the push stamped onto the
 *                                   // bead, confirmed by a post-push local
 *                                   // read; null if not (yet) stamped
 *     pushed: boolean,              // true iff a non-empty externalRef was
 *                                   // confirmed -- always false for
 *                                   // `dryRun: true`, which stamps nothing
 *                                   // by design (design.md Section 8: "Run
 *                                   // --dry-run first, log the plan")
 *   }>>
 * One entry per input `beadId`, in input order.
 *
 * @param {{ namespace: 'ado'|'github', beads: { trackerPull: Function, trackerPush: Function, list: Function, show: Function } }} opts
 * @returns {{ ingest: Function, publishCarryOver: Function }}
 */
/**
 * ---------------------------------------------------------------------------
 * WHY A `bd show` RESULT IS UNWRAPPED BEFORE ANY FIELD IS READ
 * ---------------------------------------------------------------------------
 * `bd show <id> --json` prints an ARRAY of one row, not the row -- verified
 * live against a real beads DB. Reading `result.external_ref` straight off
 * that array is not an error at runtime, it is `undefined`, on every row,
 * every time: the exact silent-null shape this package has been bitten by
 * before. Every read of a `bd show` result therefore goes through here
 * first, and a multi-row result is refused rather than guessed at -- `show`
 * is called with one id, so more than one row means the assumption that an
 * id identifies a bead has broken and a silent `[0]` would hide it.
 *
 * @param {any} result whatever `beads.show(id)` resolved to
 * @param {string} beadId for the error message only
 * @returns {object|null} the single row, or null if there is none
 */
export function unwrapShowRow(result, beadId) {
  if (Array.isArray(result)) {
    if (result.length === 0) return null;
    if (result.length > 1) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.BEADS_FAILED,
        `bd show ${beadId} returned ${result.length} rows -- an id must identify exactly one bead; refusing to guess which row is meant`,
        { beadId, rowCount: result.length }
      );
    }
    return result[0] && typeof result[0] === 'object' ? result[0] : null;
  }
  return result && typeof result === 'object' ? result : null;
}

/**
 * The tracker ref currently stamped on a bead, or `null` when it carries
 * none. One definition, because "is this bead already published" is the
 * question carry-over idempotency turns on and two spellings of it would
 * eventually disagree.
 *
 * @param {{ show: Function }} beads
 * @param {string} beadId
 * @returns {Promise<string|null>}
 */
export async function readExternalRef(beads, beadId) {
  const row = unwrapShowRow(await beads.show(beadId), beadId);
  return row && typeof row.external_ref === 'string' && row.external_ref.length > 0
    ? row.external_ref
    : null;
}

export function createNativeBeadsSync({ namespace, beads } = {}) {
  if (!KNOWN_NAMESPACES.includes(namespace)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ADAPTER_INVALID,
      `createNativeBeadsSync: namespace must be one of ${KNOWN_NAMESPACES.join(', ')}, got ${JSON.stringify(namespace)}`,
      { namespace }
    );
  }
  if (!beads
    || typeof beads.trackerPull !== 'function'
    || typeof beads.trackerPush !== 'function'
    || typeof beads.list !== 'function'
    || typeof beads.show !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      `createNativeBeadsSync (namespace "${namespace}"): requires an injected beads client exposing trackerPull/trackerPush/list/show -- one or more was not provided`,
      { namespace }
    );
  }

  /**
   * Pulls the given external-tracker refs into the local beads DB via
   * `bd <namespace> pull <refs...>`, dispatched to a member (see
   * beads-client.mjs's dispatchTrackerCommand -- the credential never
   * reaches this module or the bridge process), THEN reads back what landed.
   *
   * `bd <namespace> pull` writes into the local beads DB; it does not return
   * bead records. So this is two steps, not one:
   *   1. Dispatch the pull (as above) -- tracker-touching, credential-needing.
   *   2. Read back what landed via `beads.list()` -- LOCAL and
   *      credential-free, so it goes through the injected beads client's
   *      exec-bd-in-process path, never `dispatchTrackerCommand`/
   *      `execute_command` again (beads-client.mjs's hard local/
   *      tracker-touching split).
   *
   * Read-back strategy: list-then-filter by `external_ref`, not `show(id)`.
   * `beads.list()` has no `external_ref` filter (only status/createdAfter/
   * labels/limit/parent), and `show(id)` needs a bead id -- exactly the
   * thing this call is trying to discover FROM a tracker ref. So this lists
   * the local DB and matches rows by `external_ref`, the natural key
   * `bd <namespace> pull` stamps on every bead it creates or updates
   * (fleet-bridge-design.md 2.3/8). `createdAfter` is deliberately NOT used
   * to narrow the list call: a ref pulled by an earlier `ingest` legitimately
   * predates this call, and filtering it out would silently reproduce the
   * exact bug this two-step fix exists to close.
   *
   * The match itself is NOT plain string equality against `row.external_ref`
   * -- see `normalizeRefIdentity` above for why (bare id vs. full tracker
   * URL, and the false-match trap a substring check would be). It is, in
   * priority order: (1) exact literal equality, the cheapest possible check
   * and always correct when it hits; (2) failing that, both sides reduced to
   * their normalized identity and compared whole. Two DIFFERENT beads
   * reducing to the same identity as one supplied ref is a genuine ambiguity,
   * not a coin flip -- see the `INGEST_REF_AMBIGUOUS` branch below, and never
   * the old "keep the first, ignore the rest" behavior.
   *
   * A ref that survives the pull but matches no bead afterwards (the tracker
   * didn't have it, or the sync silently skipped it) is never dropped
   * silently -- it would make `verbs/ingest.mjs`'s own child-count assertion
   * pass or fail for the wrong reason. It is collected and surfaced as a
   * named `INGEST_PULL_FAILED` naming every offending ref, together with
   * what it normalized to (so the next person sees at a glance why nothing
   * lined up, instead of having to re-derive it by hand).
   *
   * @param {{ refs?: string[], secretName: string }} opts
   * @returns {Promise<Array<{ beadId: string, externalRef: string, title: any, parent: string|null, acceptanceCriteria: any }>>}
   * @throws {BridgeError} INGEST_PULL_FAILED if any ref matches no bead after the pull.
   * @throws {BridgeError} INGEST_REF_AMBIGUOUS if any ref's normalized identity matches more than one bead.
   */
  async function ingest({ refs, secretName } = {}) {
    const refList = Array.isArray(refs) ? refs : [];

    await beads.trackerPull(namespace, refList, { secretName });

    if (refList.length === 0) return [];

    const rows = await beads.list({});

    // Cheapest check first (an exact literal match needs no parsing at all).
    // Kept exactly as it worked before this fix: if two rows happen to share
    // a literal external_ref -- a pre-existing DB anomaly, not something a
    // ref-matching fix owes an opinion on -- the first one wins here.
    const byRawRef = new Map();
    // Every row indexed by its NORMALIZED identity, so the ambiguity check
    // below can see every bead a given identity could mean, not just the
    // first -- this is what replaces the old `!byExternalRef.has(ref)`
    // keep-first guard.
    const byIdentity = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const ref = row && row.external_ref;
      if (typeof ref !== 'string' || ref.length === 0) continue;
      if (!byRawRef.has(ref)) byRawRef.set(ref, row);

      const identity = normalizeRefIdentity(ref);
      if (identity.length === 0) continue; // no usable identity -- never a match key
      const bucket = byIdentity.get(identity);
      if (bucket) {
        bucket.push(row);
      } else {
        byIdentity.set(identity, [row]);
      }
    }

    const missing = [];
    const ambiguous = [];
    const pulled = [];
    for (const ref of refList) {
      let row = byRawRef.get(ref);

      if (!row) {
        const identity = normalizeRefIdentity(ref);
        const candidates = identity.length > 0 ? byIdentity.get(identity) : undefined;
        if (candidates && candidates.length > 1) {
          // Two different beads normalize to this ref's identity: refuse to
          // guess. Ingesting the wrong one into a sprint is exactly the
          // false-match failure mode this whole fix exists to close, so this
          // fails as loudly as the "matches nothing" case below, naming
          // every candidate bead id.
          ambiguous.push({ ref, identity, beadIds: candidates.map((r) => r.id) });
          continue;
        }
        row = candidates && candidates.length === 1 ? candidates[0] : undefined;
      }

      if (!row) {
        missing.push({ ref, identity: normalizeRefIdentity(ref) });
        continue;
      }

      pulled.push({
        beadId: row.id,
        externalRef: ref,
        title: row.title,
        parent: typeof row.parent === 'string' && row.parent.length > 0 ? row.parent : null,
        acceptanceCriteria: resolveAcceptanceCriteria(row),
      });
    }

    if (ambiguous.length > 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.INGEST_REF_AMBIGUOUS,
        `createNativeBeadsSync (namespace "${namespace}"): ${ambiguous.length} of ${refList.length} ref(s) normalize to an identity shared by more than one local bead -- refusing to guess which one is right: ` +
          `${ambiguous.map((a) => `${a.ref} (normalized "${a.identity}") -> beads ${a.beadIds.join(', ')}`).join('; ')}`,
        { namespace, refs: refList, ambiguous }
      );
    }

    if (missing.length > 0) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.INGEST_PULL_FAILED,
        `createNativeBeadsSync (namespace "${namespace}"): tracker pull completed but ${missing.length} of ${refList.length} ref(s) produced no matching bead (by external_ref) in the local beads DB afterwards: ` +
          `${missing.map((m) => `${m.ref} (normalized "${m.identity}")`).join(', ')} -- the tracker may not have had them, or the sync silently skipped them`,
        { namespace, refs: refList, missing: missing.map((m) => m.ref) }
      );
    }

    return pulled;
  }

  /**
   * Pushes the given bead ids to the tracker via `bd <namespace> push
   * <beadIds...>` -- always ID-scoped, never a bare `sync` (enforced inside
   * beads-client.mjs's buildTrackerCommand/assertNoBareSync) -- THEN reads
   * back, per id, whether the push stamped an `external_ref` onto it
   * (design.md Section 8: this stamp is what makes carry-over publishing
   * idempotent on a rerun). Unlike `ingest`, the local id is already known
   * here, so the read-back is a per-id `beads.show(id)` rather than a
   * list-then-filter -- still LOCAL and credential-free, never dispatched.
   *
   * `dryRun: true` stamps nothing on the tracker by design, so `pushed` is
   * unconditionally `false` in that case; the read-back still runs and may
   * report a pre-existing `externalRef` from an earlier real push.
   *
   * @param {{ beadIds?: string[], secretName: string, dryRun?: boolean }} opts
   * @returns {Promise<Array<{ beadId: string, externalRef: string|null, pushed: boolean }>>}
   */
  async function publishCarryOver({ beadIds, secretName, dryRun } = {}) {
    const idList = Array.isArray(beadIds) ? beadIds : [];

    await beads.trackerPush(namespace, idList, { secretName, dryRun });

    if (idList.length === 0) return [];

    const results = [];
    for (const beadId of idList) {
      // eslint-disable-next-line no-await-in-loop -- ordered local reads
      // against the same beads DB; nothing to gain by parallelizing.
      // unwrapShowRow, not a raw field read -- see its doc comment: a real
      // `bd show --json` resolves to an ARRAY, and this read-back used to
      // report `externalRef: null` for every bead on every run because of
      // it.
      const externalRef = await readExternalRef(beads, beadId);
      results.push({
        beadId,
        externalRef,
        pushed: !dryRun && externalRef !== null,
      });
    }
    return results;
  }

  return { ingest, publishCarryOver };
}

export default createNativeBeadsSync;
