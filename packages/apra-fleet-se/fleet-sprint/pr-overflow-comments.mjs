// Publishes the part of a sprint PR description that did not fit (the
// reviewer-notes overflow, see pr-body.mjs buildSprintPrBody /
// buildOverflowComments) as engine-marked PR comments, and keeps them in step
// on a relaunch (the listing follows the provider's pages, bounded).
//
// WHY A SEPARATE MODULE. raiseVcsPrForMember (vcs-auth.mjs) owns the REST
// round trip (credential handoff, staged request body, one-shot auth
// self-heal); this module owns only the upsert DECISIONS, through the `run`
// callback it is handed, so it does no I/O of its own and is unit-testable
// with a scripted `run`.
//
// UPSERT. Each engine comment carries a hidden marker (pr-body.mjs
// OVERFLOW_COMMENT_MARKER) with its chunk index. On a PR that already existed
// (a relaunch), the engine lists the PR's comments first, then for chunk i
// updates the i-th marked comment in place (skipped when already identical)
// or posts a new one, and deletes every marked comment past the new chunk
// count -- or, when a delete fails, rewrites it as an empty superseded stub
// that a later run reuses. Engine chunks are therefore never duplicated.
//
// FAILURE. Any failed list/post/update is returned (never thrown) with the PR
// and chunk it concerned and logged as a WARNING; the caller then points the
// description at the run log. A failed surplus clean-up is only a WARNING:
// the current notes were posted in full.
//
// ASCII only.

import { parseOverflowComment, OVERFLOW_SUPERSEDED_COMMENT } from './pr-body.mjs';
import {
    buildCommentCommand,
    buildListCommentsCommand,
    buildUpdateCommentCommand,
    buildDeleteCommentCommand,
} from './vcs-module.mjs';

/** Upper bound on comment-list pages followed (100 comments each), so a
 *  misbehaving API that always answers a next page cannot loop forever. */
export const MAX_COMMENT_LIST_PAGES = 20;

/**
 * @param {object} opts
 * @param {string[]} opts.comments the comment bodies to publish, in order
 *   (pr-body.mjs buildOverflowComments)
 * @param {string|number} opts.prId the provider's PR id
 * @param {string} [opts.prLabel] how log lines name the PR (e.g. its URL)
 * @param {boolean} opts.existing true when the PR already existed before this
 *   publish (a relaunch): earlier engine comments are listed and upserted
 * @param {(buildFn: () => object, what: string) => Promise<{ ok: boolean, built?: object, body?: unknown, error?: string }>} opts.run
 *   one REST round trip (raiseVcsPrForMember's runUpdatePathCall)
 * @param {() => object} opts.coords the provider coordinates + token
 *   placeholder + os/shell every builder takes
 * @param {() => string} opts.payloadPath a fresh member-side request-body path
 * @param {Function} [opts.log]
 * @param {string} [opts.logPrefix]
 * @returns {Promise<{ ok: boolean, posted: number, updated: number, unchanged: number, removed: number, error: string|null }>}
 */
export async function publishPrOverflowComments({
    comments, prId, prLabel, existing, run, coords, payloadPath, log = () => {}, logPrefix = '[Publish PR]',
}) {
    const list = Array.isArray(comments) ? comments : [];
    const pr = prLabel ? `PR ${prLabel}` : `PR #${prId}`;
    const total = list.length;
    const out = { ok: true, posted: 0, updated: 0, unchanged: 0, removed: 0, error: null };
    const fail = (error) => {
        log(`${logPrefix}: WARNING: ${error} -- the reviewer notes that did not fit the description are NOT all on the PR; the full notes are in this run log.`);
        return { ...out, ok: false, error };
    };

    let prior = [];
    if (existing) {
        // Follow the provider's pages (the built command's optional
        // nextPage(body) -> params | null), bounded by MAX_COMMENT_LIST_PAGES.
        const mapped = [];
        let pageParams = {};
        for (let n = 0; n < MAX_COMMENT_LIST_PAGES; n++) {
            const listed = await run(() => buildListCommentsCommand({ ...coords(), pull_request_id: prId, ...pageParams }), 'list-comments');
            if (!listed.ok) return fail(`could not list the comments of ${pr} to upsert the reviewer-notes overflow: ${listed.error}`);
            let pageItems;
            try {
                pageItems = listed.built.mapResponse(listed.body);
            } catch (err) {
                return fail(`could not read the comment list of ${pr}: ${err && err.message ? err.message : err}`);
            }
            mapped.push(...(Array.isArray(pageItems) ? pageItems : []));
            let next = null;
            try {
                next = typeof listed.built.nextPage === 'function' ? listed.built.nextPage(listed.body) : null;
            } catch {
                next = null;
            }
            if (!next) break;
            if (n === MAX_COMMENT_LIST_PAGES - 1) {
                log(`${logPrefix}: WARNING: ${pr} has more than ${MAX_COMMENT_LIST_PAGES} pages of comments; only the first ${mapped.length} were checked for earlier reviewer-notes overflow comments.`);
                break;
            }
            pageParams = next;
        }
        const marked = mapped
            .map((c, order) => ({ ...c, order, parsed: parseOverflowComment(c.body) }))
            .filter((c) => c.parsed);
        // Chunks in index order first, then superseded stubs (reused before
        // any new comment is posted); list order breaks ties.
        const rank = (c) => (c.parsed.superseded ? Number.MAX_SAFE_INTEGER : c.parsed.index);
        prior = marked.sort((a, b) => (rank(a) - rank(b)) || (a.order - b.order));
    }

    const normalize = (s) => String(s ?? '').replace(/\r\n?/g, '\n');
    for (let i = 0; i < total; i++) {
        const text = list[i];
        const old = prior[i];
        if (old) {
            if (normalize(old.body) === text) {
                out.unchanged++;
                continue;
            }
            const upd = await run(() => buildUpdateCommentCommand({
                ...coords(), pull_request_id: prId, comment_ref: old.ref, body: text, payload_path: payloadPath(),
            }), 'update-comment');
            if (!upd.ok) return fail(`could not update reviewer-notes overflow comment ${i + 1} of ${total} on ${pr}: ${upd.error}`);
            out.updated++;
        } else {
            const made = await run(() => buildCommentCommand({
                ...coords(), pull_request_id: prId, body: text, payload_path: payloadPath(),
            }), 'comment');
            if (!made.ok) return fail(`could not post reviewer-notes overflow comment ${i + 1} of ${total} on ${pr}: ${made.error}`);
            out.posted++;
        }
    }

    for (const old of prior.slice(total)) {
        if (old.parsed.superseded) continue;
        const del = await run(() => buildDeleteCommentCommand({ ...coords(), pull_request_id: prId, comment_ref: old.ref }), 'delete-comment');
        if (del.ok) {
            out.removed++;
            continue;
        }
        const emptied = await run(() => buildUpdateCommentCommand({
            ...coords(), pull_request_id: prId, comment_ref: old.ref, body: OVERFLOW_SUPERSEDED_COMMENT, payload_path: payloadPath(),
        }), 'update-comment');
        if (emptied.ok) {
            out.removed++;
        } else {
            log(`${logPrefix}: WARNING: could not delete or empty an earlier run's reviewer-notes overflow comment on ${pr} (delete: ${del.error}; empty: ${emptied.error}) -- remove it by hand.`);
        }
    }
    return out;
}
