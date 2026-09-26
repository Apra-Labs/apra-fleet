// =============================================================================
// Auto-sprint supervisor -- stable per-sprint dashboard-card anchor ids
// (apra-fleet-i9ag.5.2)
// =============================================================================
//
// dashboard.mjs renders one anchor id per running-sprint card in the Sprint
// Stack; proxy.mjs's live-view reverse proxy injects a back-link into the
// child viewer's HTML pointing at that SAME anchor. Both read the id from
// THIS one function so they can never derive a different id for the same
// sprint id -- the single-source requirement this task's parent feature
// (i9ag.3.3's manifest/served-route split) already established a pattern
// for.
//
// A sprint id is not guaranteed to be URL-fragment-safe (it is operator-
// supplied at launch time, apra-fleet-eft.4.1) -- it may contain '/', '#',
// '?', '&', whitespace, or other characters that are meaningful in a URL or
// illegal in an HTML `id` attribute. Every character outside a conservative
// allowlist is escaped to a `_<hex-codepoint>_` run, so the resulting id:
//   - is stable and deterministic across renders (same sprintId -> same id,
//     always);
//   - is a valid HTML `id` attribute value (letters/digits/'_'/'-' only,
//     after the fixed ASCII prefix);
//   - needs NO further percent-encoding to appear in a URL fragment
//     ('#' + id) -- it contains no character a fragment would otherwise
//     require escaping.
// =============================================================================

/**
 * Derives the stable dashboard-card anchor id for one sprint.
 *
 * DELIBERATELY SELF-CONTAINED -- no module-level constant, no closure over
 * anything outside this function body: dashboard.mjs's sprintStackLiveScript()
 * ships this function to the browser verbatim via `.toString()` (the same
 * technique mountHref() in mount-prefix.mjs already uses, for the same
 * reason -- see that module's own doc comment). `Function.prototype.toString()`
 * only ever returns the function's OWN source text; a reference to an outer
 * `const`/`let` would compile fine here but throw `ReferenceError` the moment
 * the embedded copy runs with no such binding in scope.
 *
 * @param {string} sprintId
 * @returns {string}
 */
export function sprintCardAnchorId(sprintId) {
    const prefix = 'sprint-card-';
    const safeChar = /^[A-Za-z0-9_-]$/;
    const raw = typeof sprintId === 'string' ? sprintId : String(sprintId == null ? '' : sprintId);
    let out = prefix;
    for (const ch of raw) {
        out += safeChar.test(ch) ? ch : ('_' + ch.codePointAt(0).toString(16) + '_');
    }
    return out;
}
