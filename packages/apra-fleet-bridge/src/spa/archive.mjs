// archive.mjs -- fleet-bridge-implementation-plan.md Part D, section D1
// ("archive SPA (ship first; small)").
//
// At `finalize`, export a terminal sprint as a self-contained static site
// bundle: the SAME real dashboard/history page the live viewer serves
// (@apralabs/apra-fleet-se's `renderHistoryPageHtml()`, itself a thin,
// pure, synchronous wrapper around @apralabs/apra-fleet-workflow's
// `HTML_TEMPLATE`), plus every per-item blob its lazy-load click handlers
// need. We deliberately do NOT build a second renderer -- history-view.mjs
// already IS the page shell in "process-free" mode (poll loop + SSE gated
// off, Stop/Pause hidden), fed a frozen state object exactly like this
// module feeds it.
//
// THE BUG THIS FIXES (see plan Part D1): History mode gates the poll loop
// and SSE, but NOT the lazy-load click handlers -- "more..." on a capped
// activity and expanding an extension's on-demand detail (e.g. a bead
// description) call `fetch('/activities/:id/output')` and
// `fetch('/extensions/:extId/detail/:itemId')` against an origin that,
// once a sprint is finished and archived, serves neither: silent 404s on a
// finished sprint today. Materialising those responses as
// `activities/<id>.json` and `extensions/<extId>/<itemId>.json` is what
// makes the archived page's lazy-load actually resolve.
//
// PURITY (Constraints, this package-wide): this module does no I/O of any
// kind -- no fs, no fetch, no network. It takes a plain `state` object and
// returns a plain list of {path, contentType, body} descriptors; the
// caller (verbs/finalize.mjs or a future daemon.mjs upload path) is the one
// that writes them to disk or uploads them to blob storage. This is what
// keeps the same bundle usable for both destinations and keeps this module
// unit-testable with zero fixtures beyond an in-memory object.
//
// DOMAIN NEUTRALITY: this module never imports or names a specific
// extension (e.g. "beads"). `extensions` arrives as data from the caller,
// exactly as apra-fleet-se's bin/cli.mjs wires `dashboardExtensions:
// [beadsExtension]` into createHistoryView() -- see that file and
// history-view.mjs's own `deps.dashboardExtensions` seam, which this module
// mirrors rather than reinvents. Each extension is expected to shape
// `{ id: string, detailLookup?: (state, itemId) => {text, updatedAt} | null }`
// -- the SAME generic hook contract
// @apralabs/apra-fleet-workflow/src/viewer/index.mjs's GET
// /extensions/:extId/detail/:itemId route already calls.
//
// PAYLOAD SHAPES -- pinned field-for-field against the two live route
// handlers in @apralabs/apra-fleet-workflow/src/viewer/index.mjs so a
// materialised blob is byte-for-byte what the live route would have
// returned (a mismatch here is invisible until someone clicks -- see this
// module's test file for exactly which route lines each shape was read
// from):
//
//   GET /activities/:id/output  (index.mjs ~1472-1505)
//     Primary path reads an in-memory, per-process, never-persisted store
//     (command-output-cap.mjs's `getFullOutput`) that cannot exist once the
//     process that ran the sprint is gone -- which is exactly the situation
//     `finalize` runs in. This module therefore always takes that route's
//     OTHER path: the `state.tree` fallback (index.mjs's `findActivityById`
//     + the `typeof act.output === 'string'` / `typeof act.error ===
//     'string'` checks), producing the exact same response shape:
//     `{ id, output?, error? }`, only the keys present as strings included.
//     Per the plan brief: the terminal state handed to this module is the
//     UN-LEANED record from old_runs/<id>.json (lean-state.mjs's truncation
//     is a GET /state wire-shaping step this snapshot never went through),
//     so an `agent` activity's full text is present. A `command` activity's
//     `output`/`error` may still carry command-output-cap.mjs's permanent
//     head+tail excerpt applied at STORAGE time (a separate, earlier
//     mechanism from lean-state.mjs's wire-shaping) -- whatever is on
//     `state.tree` is the best available offline; there is no way to
//     recover a capped command's original bytes from a persisted snapshot
//     alone once the process that captured them has exited.
//
//   GET /extensions/:extId/detail/:itemId  (index.mjs ~1432-1459)
//     `{ id: itemId, text: detail.text || '', updatedAt: detail.updatedAt ?? null }`
//     -- reproduced exactly, including the `|| ''` / `?? null` coercions.
//
// ENUMERATING EXTENSION ITEM IDS (an ambiguity this module had to resolve;
// see this module's test file and the task report for detail): the generic
// extension hook contract only offers `detailLookup(state, itemId)` --
// look ONE item up given its id -- never "list every id this extension
// has". There is no existing enumeration hook anywhere in the codebase to
// reuse (checked: viewer/index.mjs, viewer-extensions.mjs, history-view.mjs
// -- none exists). Inventing an extension-specific one here would mean
// hardcoding "beads" knowledge into a domain-neutral package, which this
// package must never do. Instead, `collectCandidateIds()` below walks
// `state.extensions[ext.id]` GENERICALLY for any nested object carrying an
// `id` field (string or number) -- exactly mirroring, without naming, the
// shape `viewer-extensions.mjs`'s `findBeadById()` already relies on
// (`state.extensions.beads.{sprintTasks,backlogTasks}`, each entry `{id,
// ...}`). Every candidate id is then fed back through the extension's OWN
// `detailLookup(state, id)`; only a truthy result is materialised, so a
// false-positive candidate (some unrelated nested object that happens to
// carry an `id` field) costs nothing beyond one skipped lookup -- it can
// never produce a wrong file, only a missing one for an id shape no
// extension recognises.

import { renderHistoryPageHtml } from '@apralabs/apra-fleet-se/src/supervisor/history-view.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';

/**
 * Depth-first walk of `state.tree` (groups -> phases -> events) yielding
 * every event of `type === 'activity'`, exactly the shape
 * @apralabs/apra-fleet-workflow's `findActivityById()` scans over. Tolerant
 * of a missing/malformed tree, group, phase, or event -- a malformed
 * terminal state must still produce a usable (if partial) bundle, never a
 * throw, per this module's contract.
 * @param {object} state
 * @returns {Generator<{id: unknown, data: object}>}
 */
function* walkActivityEvents(state) {
    const tree = Array.isArray(state.tree) ? state.tree : [];
    for (const group of tree) {
        const phases = Array.isArray(group?.phases) ? group.phases : [];
        for (const phase of phases) {
            const events = Array.isArray(phase?.events) ? phase.events : [];
            for (const event of events) {
                if (event && typeof event === 'object' && event.type === 'activity'
                    && event.id !== undefined && event.id !== null) {
                    yield event;
                }
            }
        }
    }
}

/**
 * Generic, extension-agnostic collection of candidate detail-item ids: any
 * `id` (string or number) found on an object anywhere under `node`. See
 * this module's header ("ENUMERATING EXTENSION ITEM IDS") for why this
 * exists and why it cannot be domain-specific. Guards against cycles with a
 * `seen` WeakSet, though a JSON-round-tripped terminal state cannot
 * actually contain one.
 * @param {unknown} node
 * @param {Set<string>} ids
 * @param {WeakSet<object>} seen
 * @returns {Set<string>}
 */
function collectCandidateIds(node, ids = new Set(), seen = new WeakSet()) {
    if (node === null || typeof node !== 'object') return ids;
    if (seen.has(node)) return ids;
    seen.add(node);
    if (Array.isArray(node)) {
        for (const item of node) collectCandidateIds(item, ids, seen);
        return ids;
    }
    if ((typeof node.id === 'string' && node.id.length > 0) || typeof node.id === 'number') {
        ids.add(String(node.id));
    }
    for (const value of Object.values(node)) {
        if (value && typeof value === 'object') collectCandidateIds(value, ids, seen);
    }
    return ids;
}

/**
 * Builds the archive SPA bundle for one finished sprint's terminal state:
 * the real history-mode page plus every per-item blob its lazy-load click
 * handlers need (fixing the silent-404 bug described in this module's
 * header). Pure -- no I/O; the caller writes `files` to disk or uploads
 * them to blob storage.
 *
 * @param {{
 *   state: object,
 *   extensions?: Array<{ id: string, detailLookup?: (state: object, itemId: string) => ({text?: string, updatedAt?: unknown} | null) }>,
 * }} args
 * @returns {{ files: Array<{ path: string, contentType: string, body: string }> }}
 */
export function buildArchiveBundle({ state, extensions } = {}) {
    if (state === undefined) {
        throw new BridgeError(
            BRIDGE_ERROR_CODES.CONFIG_MISSING,
            'buildArchiveBundle requires a `state` object (the sprint\'s terminal state) and none was provided.',
        );
    }
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
        throw new BridgeError(
            BRIDGE_ERROR_CODES.CONFIG_INVALID,
            `buildArchiveBundle received a malformed \`state\`: expected an object, got ${Array.isArray(state) ? 'an array' : state === null ? 'null' : typeof state}.`,
        );
    }

    let exts = extensions;
    if (exts === undefined) exts = [];
    if (!Array.isArray(exts)) {
        throw new BridgeError(
            BRIDGE_ERROR_CODES.CONFIG_INVALID,
            `buildArchiveBundle received a malformed 'extensions': expected an array, got ${typeof exts}.`,
        );
    }

    const files = [];

    // index.html -- the real, full-fidelity history-mode page. Never a
    // second renderer: renderHistoryPageHtml() is HTML_TEMPLATE(extensions,
    // { history: true, state }), the exact function history-view.mjs uses
    // to serve GET /sprints/:id/history.
    files.push({
        path: 'index.html',
        contentType: 'text/html; charset=utf-8',
        body: renderHistoryPageHtml(state, exts),
    });

    // activities/<activityId>.json -- one file per activity that actually
    // carries output and/or error text; an activity with neither emits NO
    // file (matching the live route's own 404-worthy "nothing to fetch"
    // case) rather than an empty/near-empty one nobody would ever request.
    for (const event of walkActivityEvents(state)) {
        const data = event.data;
        const body = {};
        if (data && typeof data.output === 'string') body.output = data.output;
        if (data && typeof data.error === 'string') body.error = data.error;
        if (Object.keys(body).length === 0) continue;
        files.push({
            path: `activities/${encodeURIComponent(String(event.id))}.json`,
            contentType: 'application/json',
            body: JSON.stringify({ id: event.id, ...body }),
        });
    }

    // extensions/<extId>/<itemId>.json -- materialised on-demand detail for
    // every extension that opts into `detailLookup`, for every candidate id
    // that extension actually recognises (see collectCandidateIds() above).
    const stateExtensions = (state.extensions && typeof state.extensions === 'object' && !Array.isArray(state.extensions))
        ? state.extensions
        : {};
    for (const ext of exts) {
        if (!ext || typeof ext !== 'object') continue;
        if (typeof ext.id !== 'string' || ext.id.length === 0) continue;
        if (typeof ext.detailLookup !== 'function') continue;

        const namespaceData = stateExtensions[ext.id];
        const candidateIds = collectCandidateIds(namespaceData);
        for (const itemId of candidateIds) {
            const detail = ext.detailLookup(state, itemId);
            if (!detail) continue;
            files.push({
                path: `extensions/${encodeURIComponent(ext.id)}/${encodeURIComponent(itemId)}.json`,
                contentType: 'application/json',
                body: JSON.stringify({ id: itemId, text: detail.text || '', updatedAt: detail.updatedAt ?? null }),
            });
        }
    }

    return { files };
}
