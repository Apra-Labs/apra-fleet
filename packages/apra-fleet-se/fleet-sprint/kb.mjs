// KB (Knowledge Bank) work for fleet-sprint: the per-dispatch relevance-ranked read (kb_query), the vetting
// and forwarding of a role's kb_captures/kb_promotions payload (kb_capture/
// kb_promote), the per-round bible commit (kb_bible_commit), the once-per-sprint
// priming client (kb_session_prime/kb_import) and the prompt-construction
// helpers that hand a role's primed knowledge and promotion candidates to
// its dispatch prompt -- extracted move-only out of runner.js
// (apra-fleet-3swo.4.4 for the original KB work concern; apra-fleet-3swo.6.11
// for createKbPrimingClient, KB_SELF_INJECTING_ROLES, kbQueryTerms,
// kbKnowledgeBlock and kbPromotionBlock). runner.js re-exports every symbol
// it previously exported from this region, so existing importers of
// fleet-sprint/runner.js resolve unchanged.
//
// Every kb_* call here is BEST-EFFORT and NON-FATAL: a KB outage (cold KB,
// unreachable server, a rejected or throwing member call) must only be logged,
// never fail a dispatch.
//
// SCOPE IS THE SESSION, NOT AN ARGUMENT. No kb_* tool takes a repo/scope
// argument: a kb_* call operates on the calling session's own KB, and a
// MEMBER session resolves that member's registered work folder. So every
// member-targeted kb_* call here goes through the injected memberCall(member,
// tool, args) (member-call.mjs) -- a member-scoped session on that member --
// rather than the orchestrator's own callTool, whose FULL session would
// resolve the server's folder instead (the apra-fleet-tm7 repo-blindness
// class). The orchestrator's callTool is used only for member_detail, to
// learn each member's id and type.

import { ROLES, wrapUntrustedBlock } from './contracts.mjs';
import { toolErrorText } from './mcp-result.mjs';
import { cleanQueryTerms } from './kb-hints.mjs';

// Local, validated role constant -- mirrors runner.js's own roleConst()
// pattern (kb.mjs does not import runner.js's private helper, to avoid a
// module import cycle) so a rename/typo in contracts.ROLES still throws
// here at module-load time instead of silently narrowing KB_PROMOTER_ROLES
// to nothing.
function kbRoleConst(name) {
    if (!ROLES.includes(name)) {
        throw new Error(`[Role Contract] '${name}' is not a member of contracts.ROLES: ${ROLES.join(', ')}`);
    }
    return name;
}
const ROLE_REVIEWER = kbRoleConst('reviewer');
// Same mirrored-local pattern as ROLE_REVIEWER above, needed by
// KB_SELF_INJECTING_ROLES below (moved verbatim from runner.js, which still
// keeps its own module-private ROLE_DOER for its other call sites).
const ROLE_DOER = kbRoleConst('doer');

/**
 * Cap on primed entries carried into a dispatch prompt. kb_session_prime can
 * return up to ~28 (10 direct FTS hits + 3 global + 5 graph-neighbour + 5
 * project-bible + 5 global-bible); a dispatch prompt is not a place to spend
 * that much budget on context the role may not need, and the entries are
 * already returned in relevance order.
 */
export const KB_MAX_KNOWLEDGE_ENTRIES = 12;

/**
 * The injection rule for every engine-built knowledge block: only CONFIRMED
 * entries that sit outside any unresolved contradiction reach a role prompt.
 * INFERRED/UNVERIFIED entries are the sprint's own unreviewed captures, and a
 * flagged or contradiction_of entry is one the KB itself says is disputed --
 * neither is knowledge a role should build on without checking.
 *
 * kb_query is ASKED for exactly this set (confidence + exclude_disputed), but
 * the engine re-applies it on every path regardless: an older fleet server
 * ignores the unknown params, kb_session_prime has no such filter, and a
 * hand-edited bible can carry anything. Defense in depth, not duplication.
 *
 * @param {object} e
 * @returns {boolean}
 */
export function isInjectableKbEntry(e) {
    return Boolean(e)
        && e.confidence === 'CONFIRMED'
        && !e.flagged_for_review
        && !e.contradiction_of;
}

/**
 * KB trust pipeline Phase 2, execution half for this engine.
 *
 * The role output schemas are SHARED with apra-pm (contracts.mjs loads them from
 * apra-pm/agents/schemas), so every role dispatched here is now asked for
 * kb_captures, and the reviewer for kb_promotions. Without a consumer those
 * fields would be silently dropped -- the knowledge would be gathered and
 * thrown away. This is that consumer.
 *
 * Unlike apra-pm's auto-sprint.js -- a Claude Workflow script with no tool
 * access, which must hand its vetted payload to an executor subagent -- this
 * engine runs in-process with an injected memberCall, so it makes the kb_capture
 * and kb_promote calls DIRECTLY, as the member whose repo learned them. Judgment still belongs to the role; execution
 * belongs here.
 *
 * Validation mirrors lib/vet-kb-work.mjs in apra-pm and the provider invariants
 * it reflects: a capture must cite at least one source file (SqliteProvider
 * rejects an entry the freshness sweep can never stale), a promotion needs a
 * recorded evidence string, and kb_promotions is refused from any role other
 * than reviewer -- widening capture to four roles must not widen promotion.
 *
 * @param {{ memberCall?: (member: object, name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {{ apply: (role: string, member: object, result: any) => Promise<{captured: number, promoted: number, refused: number}> }}
 */
export const KB_PROMOTER_ROLES = Object.freeze(new Set([ROLE_REVIEWER]));
export const KB_MIN_PROMOTE_REASON = 20;
export const KB_CAPTURE_TYPES = Object.freeze(['knowledge', 'learning', 'runbook']);

/**
 * True when an MCP tool result represents a tool-level failure. The MCP client
 * resolves such results instead of throwing (apra-fleet-23c), so callers that
 * only catch exceptions silently treat failures as successes. (memberCall
 * throws a typed MemberCallError instead; both shapes are handled.)
 */
function isToolError(res) {
    return !!(res && typeof res === 'object' && res.isError === true);
}

export function vetKbWork(role, result) {
    const captures = [];
    const promotions = [];
    const refused = [];
    const demotions = [];

    const rawCaptures = (result && Array.isArray(result.kb_captures)) ? result.kb_captures : [];
    for (const c of rawCaptures) {
        if (!c || typeof c.title !== 'string' || typeof c.summary !== 'string') {
            refused.push(`${role}: capture missing title/summary`);
            continue;
        }
        if (!Array.isArray(c.source_files) || c.source_files.length === 0) {
            refused.push(`${role}: capture "${c.title}" cites no source files`);
            continue;
        }
        if (!KB_CAPTURE_TYPES.includes(c.type)) {
            refused.push(`${role}: capture "${c.title}" has unsupported type ${String(c.type)}`);
            continue;
        }
        // apra-fleet-23c: kbCaptureSchema requires content (z.string().min(1)).
        // Omitting it here meant every kb_capture the engine sent failed zod
        // validation at the MCP boundary and persisted nothing.
        if (typeof c.content !== 'string' || c.content.trim().length === 0) {
            refused.push(`${role}: capture "${c.title}" has no content`);
            continue;
        }
        captures.push({
            type: c.type,
            title: c.title,
            summary: c.summary,
            content: c.content,
            source_files: c.source_files,
            symbols: Array.isArray(c.symbols) ? c.symbols : [],
        });
    }

    const rawPromotions = (result && Array.isArray(result.kb_promotions)) ? result.kb_promotions : [];
    if (rawPromotions.length > 0 && !KB_PROMOTER_ROLES.has(role)) {
        refused.push(`${role}: kb_promotions refused -- promotion is reviewer-only`);
    } else {
        for (const p of rawPromotions) {
            if (!p || typeof p.id !== 'string' || p.id.length === 0) {
                refused.push(`${role}: promotion missing id`);
                continue;
            }
            if (typeof p.reason !== 'string' || p.reason.trim().length < KB_MIN_PROMOTE_REASON) {
                refused.push(`${role}: promotion ${p.id} has no recorded evidence`);
                continue;
            }
            promotions.push({ id: p.id, reason: p.reason.trim() });
        }
    }

    // kb_discards: the reviewer's DISCARD judgement on a promotion candidate.
    // Same role gate and evidence bar as kb_promotions -- a discard removes an
    // entry from every read, so it is no less consequential than a promotion.
    const discards = [];
    const rawDiscards = (result && Array.isArray(result.kb_discards)) ? result.kb_discards : [];
    if (rawDiscards.length > 0 && !KB_PROMOTER_ROLES.has(role)) {
        refused.push(`${role}: kb_discards refused -- discard is reviewer-only`);
    } else {
        for (const d of rawDiscards) {
            if (!d || typeof d.id !== 'string' || d.id.length === 0) {
                refused.push(`${role}: discard missing id`);
                continue;
            }
            if (typeof d.reason !== 'string' || d.reason.trim().length < KB_MIN_PROMOTE_REASON) {
                refused.push(`${role}: discard ${d.id} has no recorded evidence`);
                continue;
            }
            discards.push({ id: d.id, reason: d.reason.trim() });
        }
    }

    // kb_demotions: the reviewer's DEMOTE judgement -- a CONFIRMED entry whose
    // basis is unchanged but a re-check shows the claim no longer holds, sent
    // back to INFERRED for a fresh look. Same role gate and evidence bar as
    // kb_promotions and kb_discards.
    const rawDemotions = (result && Array.isArray(result.kb_demotions)) ? result.kb_demotions : [];
    if (rawDemotions.length > 0 && !KB_PROMOTER_ROLES.has(role)) {
        refused.push(`${role}: kb_demotions refused -- demotion is reviewer-only`);
    } else {
        for (const d of rawDemotions) {
            if (!d || typeof d.id !== 'string' || d.id.length === 0) {
                refused.push(`${role}: demotion missing id`);
                continue;
            }
            if (typeof d.reason !== 'string' || d.reason.trim().length < KB_MIN_PROMOTE_REASON) {
                refused.push(`${role}: demotion ${d.id} has no recorded evidence`);
                continue;
            }
            const entry = { id: d.id, reason: d.reason.trim() };
            if (Array.isArray(d.evidence_files)) entry.evidence_files = d.evidence_files;
            demotions.push(entry);
        }
    }

    // One output may not judge the same entry more than one way: an id in
    // more than one of kb_promotions, kb_discards and kb_demotions is refused
    // in EVERY list it appears in, with a refusal logged per side naming the
    // other judgements. The pre-existing two-way promote/discard behaviour is
    // preserved exactly for the cases it already covered.
    const promotionIds = new Set(promotions.map((p) => p.id));
    const discardIds = new Set(discards.map((d) => d.id));
    const demotionIds = new Set(demotions.map((d) => d.id));
    const conflicted = new Set();
    for (const id of promotionIds) if (discardIds.has(id) || demotionIds.has(id)) conflicted.add(id);
    for (const id of discardIds) if (promotionIds.has(id) || demotionIds.has(id)) conflicted.add(id);
    for (const id of demotionIds) if (promotionIds.has(id) || discardIds.has(id)) conflicted.add(id);

    const otherSidesFor = (id, excludeKind) => {
        const sides = [];
        if (excludeKind !== 'promotion' && promotionIds.has(id)) sides.push('promotes');
        if (excludeKind !== 'discard' && discardIds.has(id)) sides.push('discards');
        if (excludeKind !== 'demotion' && demotionIds.has(id)) sides.push('demotes');
        return sides;
    };
    for (const p of promotions) {
        if (conflicted.has(p.id)) refused.push(`${role}: promotion ${p.id} refused -- the same output also ${otherSidesFor(p.id, 'promotion').join(' and ')} it (promote reason: ${p.reason})`);
    }
    for (const d of discards) {
        if (conflicted.has(d.id)) refused.push(`${role}: discard ${d.id} refused -- the same output also ${otherSidesFor(d.id, 'discard').join(' and ')} it (discard reason: ${d.reason})`);
    }
    for (const d of demotions) {
        if (conflicted.has(d.id)) refused.push(`${role}: demotion ${d.id} refused -- the same output also ${otherSidesFor(d.id, 'demotion').join(' and ')} it (demote reason: ${d.reason})`);
    }

    return {
        captures,
        promotions: promotions.filter((p) => !conflicted.has(p.id)),
        discards: discards.filter((d) => !conflicted.has(d.id)),
        demotions: demotions.filter((d) => !conflicted.has(d.id)),
        refused,
    };
}

/** Max promotion candidates offered to one reviewer, so the prompt stays bounded. */
export const KB_MAX_PROMOTION_CANDIDATES = 40;

/** Max demotion candidates offered to one reviewer, so the prompt stays bounded. */
export const KB_MAX_DEMOTION_CANDIDATES = 20;

/**
 * How many owned CONFIRMED rows the demotion-candidate READ asks for, which is
 * deliberately NOT the offer cap above.
 *
 * The cap is an OFFER cap -- how much of this prompt the candidate block may
 * occupy. Using it as the read limit instead makes it a PRE-filter: a
 * maintainer holding more owned CONFIRMED rows than the cap has an arbitrary
 * 20 of them fetched, and the eligibility/changed-file filters then run over
 * that arbitrary slice, so a genuinely relevant entry can be truncated away
 * before anything ever looks at whether it is relevant. Read wide, filter,
 * THEN cap.
 */
export const KB_DEMOTION_READ_LIMIT = 500;

/**
 * The EXACT kb_query arguments demotionCandidates issues, as a standalone
 * pure function so the real read path can be exercised end-to-end against a
 * real member session (tests/knowledge/) rather than only against a fake that
 * re-states these arguments and therefore cannot catch them being wrong.
 *
 * Every field is load-bearing, and the previous shape of this read returned
 * nothing in a real sprint:
 *
 *  - `own_scope: true` is the whole fix. In a MEMBER session getSelfReadKb
 *    routes any read that does not explicitly name INFERRED/UNVERIFIED to the
 *    member's CHECKOUT BIBLE VIEW, and bible-import.ts stamps every row of
 *    that view `tags: []` -- so a CONFIRMED read filtered by a member tag can
 *    never match anything, in any sprint. own_scope forces the PER-REPO DB
 *    with the caller's own ownerTag applied, which is exactly the row set
 *    kb_demote's ownerTag check can act on.
 *  - `tag` is still required: kb_query refuses a call carrying neither
 *    `query`, `tag` nor `flagged_only`, and this is a listing, not a search.
 *    It names the same member tag own_scope's server-side ownerTag applies.
 *  - `confidence: ['CONFIRMED']` -- kb_demote refuses anything else
 *    (E-DEMOTE-NOT-CONFIRMED).
 *  - `include_stale: true` and `exclude_disputed: false` ADMIT the rows most
 *    worth demoting. SqliteProvider.demote() documents a STALE entry as
 *    demotable on purpose (staleness is a freshness verdict; trust is a
 *    separate axis), and a contradiction-flagged row is likewise demotable.
 *    The default read drops both, which silently excluded the best
 *    candidates.
 *  - include_stale ALSO admits SUPERSEDED rows (kb_query maps the one input
 *    flag onto both provider options), and kb_demote refuses those
 *    (E-DEMOTE-SUPERSEDED) -- so the caller must drop them itself. See
 *    isDemotableCandidate below.
 *
 * @param {string} memberId the maintainer member uuid whose session the read runs in
 * @returns {object} kb_query arguments
 */
export function buildDemotionCandidateQuery(memberId) {
    return {
        tag: `member:${memberId}`,
        own_scope: true,
        confidence: ['CONFIRMED'],
        include_stale: true,
        exclude_disputed: false,
        limit: KB_DEMOTION_READ_LIMIT,
    };
}

/**
 * Whether kb_demote would ACCEPT this entry from its owner's session -- the
 * eligibility set read off SqliteProvider.demote()'s refusals rather than
 * guessed at, so the reviewer is never offered an id that can only produce a
 * refusal:
 *
 *   superseded_at set  -> E-DEMOTE-SUPERSEDED
 *   type user-directive -> E-DEMOTE-REFUSED-DIRECTIVE
 *   confidence != CONFIRMED -> E-DEMOTE-NOT-CONFIRMED
 *
 * Ownership ("Entry not found" for a row without the caller's member tag) is
 * enforced by the read itself (own_scope's ownerTag), not re-checked here.
 *
 * NOT a refusal, and deliberately NOT filtered: `stale` and
 * `flagged_for_review`/`contradiction_of`. demote() permits a stale entry
 * explicitly and calls those the ones most worth demoting.
 *
 * @param {object} entry
 * @returns {boolean}
 */
export function isDemotableCandidate(entry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) return false;
    if (entry.confidence !== 'CONFIRMED') return false;
    if (entry.type === 'user-directive') return false;
    if (entry.superseded_at) return false;
    return true;
}

/**
 * D6 in-sprint ping-pong guard: true when `entry` was demoted DURING THIS
 * SPRINT -- i.e. its `demoted_at` (an INFERRED entry's kb_query row carries
 * this when it was ever demoted, per rowToEntry) falls at or after the
 * sprint's start. `since` is the sprint start in ms
 * (createKbWorkClient's sprintStartMs()); when it is null the guard cannot
 * tell "this sprint" from "ever demoted", so it answers false -- the SAME
 * permissive default promotionCandidates' own created_at window filter uses
 * for an unknown sprint start, never a reason to exclude.
 *
 * @param {object} entry
 * @param {number|null} since
 * @returns {boolean}
 */
export function wasDemotedThisSprint(entry, since) {
    if (!entry || typeof entry.demoted_at !== 'string' || since === null) return false;
    const t = Date.parse(entry.demoted_at);
    return Number.isFinite(t) && t >= since;
}

/**
 * D6 in-sprint ping-pong guard: true when EVERY file `basis` (an entry's
 * demoted_basis_hashes snapshot, taken AS THE FILES WERE ON DISK AT DEMOTE
 * TIME) cites still hashes, in `current` (this moment's re-read), to the
 * SAME value -- i.e. nothing the demotion was based on has changed since.
 *
 * NEVER A MATCH -- so the entry stays offered rather than silently
 * ping-ponged out forever on an unprovable basis -- when: `basis` is
 * missing or empty (a legacy row, or one demoted before this snapshot
 * existed); `current` is missing (the disk-hash callback was never wired,
 * or its read failed); or any cited file is absent from `current` (deleted,
 * unreadable, or moved outside the checkout). This mirrors
 * isDemotableCandidate's own "never falsely suppress" rule for an
 * unparseable basis.
 *
 * @param {Record<string,string>|undefined} basis
 * @param {Record<string,string>|undefined} current
 * @returns {boolean}
 */
export function demotionBasisUnchanged(basis, current) {
    const files = basis ? Object.keys(basis) : [];
    if (files.length === 0 || !current) return false;
    return files.every((f) => typeof current[f] === 'string' && current[f] === basis[f]);
}

/** Display label for a member record in log lines. */
function memberLabel(member) {
    return (member && (member.name || member.id)) || 'unknown member';
}

/** The committed bible, relative to the maintainer's checkout root. */
const BIBLE_FILE = '.fleet/kb-canonical.json';

/**
 * memberCall error codes that mean the TOOL refused the call (the member was
 * reached and answered). Every other coded error -- a connect failure, a
 * send_files failure, an unparseable remote reply -- means the member could
 * not be reached, so the write stays queued for a later attempt.
 */
const KB_TOOL_REJECTION_CODES = Object.freeze(new Set(['E-TOOL', 'E-USAGE', 'E-ARGS-FILE', 'E-CALL']));

/** True when a thrown memberCall error means the member was unreachable. */
function isUnreachableError(err) {
    return !!(err && typeof err.code === 'string' && err.code.length > 0 && !KB_TOOL_REJECTION_CODES.has(err.code));
}

/** The member name a kb work call names (a member record or a bare name). */
function memberNameOf(member) {
    if (typeof member === 'string') return member;
    return (member && typeof member.name === 'string') ? member.name : null;
}

/**
 * Every KB write for a repository goes through that repository's
 * kb_maintainer (kb-maintainer.mjs), in the maintainer's MEMBER session --
 * never through the member whose dispatch produced it, and never through the
 * orchestrator's own session.
 *
 *   - apply() vets a role's kb_captures / kb_promotions / kb_demotions, then
 *     QUEUES them per repository and flushes that repository's queue.
 *   - A flush runs the existing G-pull (opts.gPull -> git-sync's bracketed
 *     syncMemberBefore) on the maintainer BEFORE the batch, so the
 *     maintainer's checkout holds the files a capture cites and the KB's
 *     basis check passes. A G-pull failure means the maintainer is
 *     unreachable: the batch stays queued and a WARN is logged.
 *   - A maintainer that is mid-dispatch (it is usually also a doer) is BUSY:
 *     its repository's writes stay queued and are applied between its
 *     dispatches, never during one. runner.js reports the dispatch lifecycle
 *     through dispatchStarted()/dispatchEnded(); the end of a dispatch
 *     flushes whatever queued up behind it.
 *   - A capture from a member whose work folder is not a repository has no
 *     maintainer and is dropped with a WARN.
 *   - A write the maintainer cannot be reached for mid-batch is put back at
 *     the head of the queue: nothing is lost and nothing is silently dropped.
 *
 * The bible commit (commitRound): every promotion the maintainer applied is
 * remembered per repository as a CONFIRMATION, and every successful demotion
 * as a pending DEMOTION, both awaiting the bible. After each review round
 * (reviewer, final reviewer, harvester) the engine calls commitRound(), which
 * per repository with confirmations and/or demotions runs, on the
 * maintainer: G-pull, kb_bible_commit {ids, demoted_ids, baseBranch,
 * baseCommit}, G-push -- ids and demoted_ids are ALWAYS sent in the same
 * call, so a round that both confirms and demotes entries makes exactly one
 * kb_bible_commit call. baseBranch is the sprint's TARGET BASE branch and
 * baseCommit the base commit the entries were verified against (opts.bibleBase
 * resolves both on the maintainer). A rejected G-push is retried exactly
 * once: abort any in-progress rebase, G-pull onto the new remote tip,
 * kb_bible_commit again with the same ids and demoted_ids (it merges at entry
 * level, so the concurrent change's entries survive with no manual merge) and
 * G-push again. A second failure keeps the ids/demoted_ids queued for the
 * next round with a WARN. When kb_bible_commit commits nothing
 * (committed:false) the ids leave the queue only once origin is shown to hold
 * the bible (opts.bibleUnpushed): an earlier round's bible commit still
 * unpushed on the maintainer is G-pushed (same retry and reset guards), and
 * an undecidable check keeps the ids queued with a WARN. After seal() (a FAIL
 * verdict or an aborted sprint) nothing further is committed.
 *
 * @param {{
 *   memberCall?: (member: object, name: string, args: object) => Promise<any>,
 *   maintainers?: object|(() => object),
 *   gPull?: (memberName: string, options?: { resetToRemoteTip?: boolean }) => Promise<any>,
 *   gPush?: (memberName: string) => Promise<any>,
 *   abortRebase?: (memberName: string) => Promise<any>,
 *   bibleBase?: (memberName: string) => Promise<{ baseBranch: string, baseCommit: string }|null>,
 *   canResetCheckout?: (memberName: string, bibleFile: string) => Promise<{ safe: boolean, reason?: string }>,
 *   checkedOutBranch?: (memberName: string) => Promise<{ branch: string|null, sprintBranch: string|null }>,
 *   bibleUnpushed?: (memberName: string, bibleFile: string) => Promise<{ unpushed: boolean|null, reason?: string }>,
 *   unpushedOnlyBible?: (memberName: string, bibleFile: string) => Promise<{ onlyBible: boolean, reason?: string }>,
 *   roundChangedFiles?: (memberName: string) => Promise<string[]>,
 *   sprintChangedFiles?: (memberName: string) => Promise<string[]>,
 *   sprintStartMs?: number|(() => number),
 *   log?: Function,
 * }} opts
 */
export function createKbWorkClient(opts = {}) {
    const {
        memberCall, gPull, gPush, abortRebase, bibleBase, canResetCheckout, checkedOutBranch, bibleUnpushed, unpushedOnlyBible,
        // THIS REVIEW ROUND's changed-file set for
        // demotionCandidates() -- (memberName: string) => Promise<string[]>.
        // Injected rather than computed here because the fetch/fast-forward
        // merge and the git diff are git operations kb.mjs has no access to
        // (every kb_* call here goes through memberCall, never a shell); see
        // runner.js's wiring for how this fetches, merges and diffs from the
        // previous round's tip (never the cumulative sprint diff diffFiles
        // computes for the KB-injection hint context -- that caller and
        // promotionCandidates are both left unchanged).
        roundChangedFiles,
        // The CUMULATIVE sprint changed-file set (baseBranch...branch) for a
        // demotionCandidates({ scope: 'sprint' }) read -- the FINAL review's
        // scope, because final review judges the whole sprint diff and so has
        // no "this round" to speak of. Injected for the same reason
        // roundChangedFiles is (the fetch/merge and git diff are git
        // operations kb.mjs has no access to), and kept a SEPARATE injection
        // rather than a flag on one callback so which diff a scope means is
        // decided once, in runner.js's wiring, instead of inside a git helper.
        sprintChangedFiles,
        // D6 in-sprint ping-pong guard's disk-hash read --
        // (memberName: string, files: string[]) => Promise<Record<string, string>>,
        // the CURRENT sha256 of each file in `files` on `memberName`'s own
        // checkout (absent files are simply missing from the result, never a
        // fabricated hash). Injected for the same reason roundChangedFiles is:
        // kb.mjs has no shell/fs access of its own, and this is the one disk
        // fact kb_query cannot answer -- demoted_basis_hashes (surfaced on an
        // INFERRED entry's kb_query row) is a demote-TIME snapshot, not a live
        // one. MUST hash the SAME way SqliteProvider's demoteBasisHashes does
        // (plain sha256 of the raw bytes) so the two sides compare like for
        // like; see promotionCandidates' guard below. Optional: when not
        // wired, the guard degrades to "never exclude" (see
        // demotionBasisUnchanged), never to a failed or wrongly-filtered read.
        currentFileHashes,
        log = () => {},
    } = opts;
    /** The sprint's start time (ms since epoch) from the sprint state, or null when unknown. */
    const sprintStartMs = () => {
        const v = typeof opts.sprintStartMs === 'function' ? opts.sprintStartMs() : opts.sprintStartMs;
        return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    };
    const active = typeof memberCall === 'function';

    /** The kb_maintainer selector (createKbMaintainerSelector), or null. */
    function selector() {
        const m = typeof opts.maintainers === 'function' ? opts.maintainers() : opts.maintainers;
        return (m && typeof m.maintainerForMember === 'function') ? m : null;
    }

    /** repo -> queued writes, oldest first: { kind, role, payload }. */
    const queues = new Map();
    /** repo -> Set of candidate ids the latest promotionCandidates() call offered. */
    const offeredCandidates = new Map();
    /** repo -> Set of candidate ids the latest demotionCandidates() call offered. */
    const offeredDemotions = new Map();
    /** repo -> tail of the serialized flush chain for that repository. */
    const flushChains = new Map();
    /** member name -> open dispatch count (nested brackets count once each). */
    const busy = new Map();
    /** member name -> the write currently in flight to it, if any. */
    const inFlight = new Map();
    /** repo -> ids the maintainer CONFIRMED that are not yet in a pushed bible commit (insertion order). */
    const confirmations = new Map();
    /** repo -> ids the maintainer DEMOTED that are not yet in a pushed bible commit (insertion order). */
    const demotedPending = new Map();
    /** Why the bible commit was sealed (a FAIL verdict, an abort), or null while open. */
    let sealedReason = null;

    const isBusy = (memberName) => (busy.get(memberName) || 0) > 0;

    /** Best-effort JSON out of an MCP result (string, content-block, or plain object). */
    function parseResult(result) {
        if (typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
        if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
            try { return JSON.parse(result.content[0].text); } catch { return null; }
        }
        return (result && typeof result === 'object') ? result : null;
    }

    /**
     * The maintainer selection ({repo, member, record}) KB writes produced by
     * `memberName` go to, or null. A member whose own work folder is not a
     * repository has none.
     */
    function maintainerFor(memberName) {
        const sel = selector();
        if (!sel || !memberName) return null;
        const m = sel.maintainerForMember(memberName);
        return (m && m.member && m.record) ? m : null;
    }

    /**
     * The maintainer a REVIEWER's candidates come from and its CONFIRM/DISCARD
     * judgements go to: the reviewer's own repository's maintainer, or -- for
     * a reviewer whose work folder is not a checkout -- the sprint's only
     * maintainer when exactly one repository has one.
     */
    function reviewMaintainerFor(memberName) {
        if (!memberName) return null;
        const own = maintainerFor(memberName);
        if (own) return own;
        const sel = selector();
        if (!sel || typeof sel.maintainers !== 'function' || typeof sel.getKbMaintainer !== 'function') return null;
        const repos = [...sel.maintainers()].filter(([, m]) => m && m.member).map(([repo]) => repo);
        if (repos.length !== 1) return null;
        const m = sel.getKbMaintainer(repos[0]);
        return (m && m.member && m.record) ? m : null;
    }

    /**
     * The record knowledge reads run as: the repository kb_maintainer of
     * `member`'s repository (see reviewMaintainerFor). Without a selector at
     * all (unit-test seam) the member itself, when it is a record.
     */
    function readTarget(member) {
        const sel = selector();
        if (!sel) return (member && typeof member === 'object' && member.id) ? member : null;
        const m = reviewMaintainerFor(memberNameOf(member));
        return m ? m.record : null;
    }

    /** kb_query on the target: CONFIRMED, undisputed entries (direct hits, then graph-related). */
    async function queryEntries(record, query) {
        try {
            const res = await memberCall(record, 'kb_query', {
                query,
                limit: KB_MAX_KNOWLEDGE_ENTRIES,
                expand_related: true,
                confidence: ['CONFIRMED'],
                exclude_disputed: true,
            });
            // apra-fleet-23c: a tool-level failure RESOLVES with {isError:true}
            // rather than throwing; log it instead of reading it as "no hits".
            if (isToolError(res)) {
                log(`[kb-work] kb_query rejected for ${memberLabel(record)} (non-fatal): ${toolErrorText(res)}`);
                return [];
            }
            const parsed = parseResult(res);
            if (!parsed) return [];
            const hits = Array.isArray(parsed.l1_results) ? parsed.l1_results : [];
            const related = Array.isArray(parsed.related_claims) ? parsed.related_claims : [];
            const seen = new Set();
            const out = [];
            for (const e of hits) {
                if (typeof e?.id !== 'string' || !isInjectableKbEntry(e) || seen.has(e.id)) continue;
                seen.add(e.id);
                out.push(e);
            }
            // Related claims sit BELOW every direct hit and carry a marker.
            for (const e of related) {
                if (typeof e?.id !== 'string' || !isInjectableKbEntry(e) || seen.has(e.id)) continue;
                seen.add(e.id);
                out.push({ ...e, via: 'kb-graph' });
            }
            return out.slice(0, KB_MAX_KNOWLEDGE_ENTRIES);
        } catch (err) {
            log(`[kb-work] kb_query failed for ${memberLabel(record)} (non-fatal): ${err.message}`);
            return [];
        }
    }

    /** kb_session_prime with the role's hints; only injectable entries survive. */
    async function primeEntries(record, hintSymbols, hintModules) {
        try {
            const res = await memberCall(record, 'kb_session_prime', {
                ...(hintSymbols.length > 0 ? { hint_symbols: hintSymbols } : {}),
                ...(hintModules.length > 0 ? { hint_modules: hintModules } : {}),
                confidence: ['CONFIRMED'],
            });
            if (isToolError(res)) {
                log(`[kb-work] kb_session_prime rejected for ${memberLabel(record)} (non-fatal): ${toolErrorText(res)}`);
                return [];
            }
            const parsed = parseResult(res);
            const top = parsed && Array.isArray(parsed.top_entries) ? parsed.top_entries : [];
            return top.filter((e) => typeof e?.id === 'string' && isInjectableKbEntry(e)).slice(0, KB_MAX_KNOWLEDGE_ENTRIES);
        } catch (err) {
            log(`[kb-work] kb_session_prime failed for ${memberLabel(record)} (non-fatal): ${err.message}`);
            return [];
        }
    }

    const zeroCounts = () => ({ captured: 0, promoted: 0, discarded: 0, demoted: 0 });

    const OPS = {
        capture: {
            tool: 'kb_capture',
            args: (p) => ({ ...p }),
            subject: (p) => `"${p.title}"`,
            counter: 'captured',
        },
        promote: {
            tool: 'kb_promote',
            args: (p) => ({ id: p.id, reason: p.reason }),
            subject: (p) => p.id,
            counter: 'promoted',
        },
        discard: {
            tool: 'kb_invalidate',
            args: (p) => ({ ids: [p.id] }),
            subject: (p) => p.id,
            counter: 'discarded',
            // kb_invalidate {ids} answers {discarded, not_found,
            // already_discarded}. Every candidate is maintainer-tagged by
            // construction, so a not-found means the entry is gone: logged,
            // non-fatal, and not counted as a discard.
            accept: (p, res) => {
                const parsed = parseResult(res);
                if (parsed && Array.isArray(parsed.not_found) && parsed.not_found.includes(p.id)) {
                    log(`[kb-work] kb_invalidate: entry ${p.id} not found on the maintainer -- already gone (non-fatal)`);
                    return false;
                }
                if (parsed && Array.isArray(parsed.already_discarded) && parsed.already_discarded.includes(p.id)) {
                    log(`[kb-work] kb_invalidate: entry ${p.id} was already discarded (non-fatal)`);
                    return false;
                }
                return true;
            },
        },
        demote: {
            tool: 'kb_demote',
            args: (p) => ({ id: p.id, reason: p.reason, ...(Array.isArray(p.evidence_files) ? { evidence_files: p.evidence_files } : {}) }),
            subject: (p) => p.id,
            counter: 'demoted',
        },
    };

    /**
     * Apply one repository's queue in the maintainer's session. Never throws.
     * @returns {Promise<{captured: number, promoted: number, discarded: number}>}
     */
    async function flushRepo(repo) {
        const counts = zeroCounts();
        const queue = queues.get(repo);
        if (!queue || queue.length === 0) return counts;
        const sel = selector();
        const target = sel && typeof sel.getKbMaintainer === 'function' ? sel.getKbMaintainer(repo) : null;
        if (!target || !target.record) {
            log(`[kb-work] WARN: repository ${repo} has no kb_maintainer -- ${queue.length} KB write(s) stay queued`);
            return counts;
        }
        const maintainer = target.member;
        if (isBusy(maintainer)) {
            log(`[kb-work] maintainer '${maintainer}' is mid-dispatch -- ${queue.length} KB write(s) for ${repo} stay queued until its dispatch ends`);
            return counts;
        }
        // G-pull BEFORE every batch: the maintainer's checkout must hold the
        // files the queued captures cite before kb_capture's basis check runs.
        if (typeof gPull === 'function') {
            // Same sprint-branch guard as the bible commit path: a pull on any
            // other branch would move that branch, so nothing runs there.
            if (!(await onSprintBranch(maintainer, repo, queue.length, 'KB write'))) return counts;
            // Register the pull in inFlight so dispatchStarted() waits it out
            // instead of running its own G-pull concurrently on the same checkout.
            const pull = Promise.resolve().then(() => gPull(maintainer));
            inFlight.set(maintainer, pull.then(() => {}, () => {}));
            try {
                await pull;
            } catch (err) {
                log(`[kb-work] WARN: G-pull on maintainer '${maintainer}' failed (${err && err.message ? err.message : String(err)}) -- maintainer unreachable; ${queue.length} KB write(s) for ${repo} stay queued`);
                return counts;
            } finally {
                inFlight.delete(maintainer);
            }
        }
        const batch = queue.splice(0, queue.length);
        for (let i = 0; i < batch.length; i++) {
            const op = batch[i];
            if (isBusy(maintainer)) {
                // A dispatch started on the maintainer while this batch ran:
                // no write may land during it.
                queue.unshift(...batch.slice(i));
                log(`[kb-work] maintainer '${maintainer}' started a dispatch -- ${batch.length - i} KB write(s) for ${repo} stay queued until it ends`);
                break;
            }
            const spec = OPS[op.kind];
            const call = memberCall(target.record, spec.tool, spec.args(op.payload));
            inFlight.set(maintainer, call.then(() => {}, () => {}));
            let res;
            try {
                res = await call;
            } catch (err) {
                if (isUnreachableError(err)) {
                    queue.unshift(...batch.slice(i));
                    log(`[kb-work] WARN: maintainer '${maintainer}' unreachable during ${spec.tool} for ${spec.subject(op.payload)} (${err.message}) -- ${batch.length - i} KB write(s) for ${repo} stay queued`);
                    break;
                }
                log(`[kb-work] ${spec.tool} failed for ${spec.subject(op.payload)} (non-fatal): ${err && err.message ? err.message : String(err)}`);
                continue;
            } finally {
                inFlight.delete(maintainer);
            }
            // apra-fleet-23c: an MCP client RESOLVES with {isError:true} on a
            // tool-level failure rather than throwing, so a non-throwing call
            // is not by itself a success.
            if (isToolError(res)) {
                log(`[kb-work] ${spec.tool} rejected for ${spec.subject(op.payload)} (non-fatal): ${toolErrorText(res)}`);
                continue;
            }
            if (typeof spec.accept === 'function' && !spec.accept(op.payload, res)) continue;
            counts[spec.counter]++;
            if (op.kind === 'promote') {
                if (!confirmations.has(repo)) confirmations.set(repo, new Set());
                confirmations.get(repo).add(op.payload.id);
            }
            if (op.kind === 'demote') {
                if (!demotedPending.has(repo)) demotedPending.set(repo, new Set());
                demotedPending.get(repo).add(op.payload.id);
            }
        }
        if (counts.captured || counts.promoted || counts.discarded || counts.demoted) {
            log(`[kb-work] maintainer '${maintainer}' (${repo}): captured ${counts.captured}, promoted ${counts.promoted}, discarded ${counts.discarded}, demoted ${counts.demoted}`);
        }
        return counts;
    }

    /**
     * Serialize every maintainer operation per repository (queue flushes and
     * bible commits) so two never interleave on one checkout.
     */
    function serialize(repo, fn) {
        const prev = flushChains.get(repo) || Promise.resolve();
        const next = prev.then(fn, fn);
        flushChains.set(repo, next.then(() => {}, () => {}));
        return next;
    }

    function flush(repo) {
        return serialize(repo, () => flushRepo(repo));
    }

    const errText = (err) => (err && err.message ? err.message : String(err));

    /**
     * Log-message phrase for a (confirmation count, demotion count) pair,
     * read naturally in every combination and -- critically -- IDENTICAL to
     * the pre-existing "N confirmation(s)" wording when there are no pending
     * demotions, so every pre-existing bible-commit log assertion (written
     * before demotion support existed) keeps matching byte-for-byte.
     */
    const describeCounts = (n, m) => {
        if (m === 0) return `${n} confirmation(s)`;
        if (n === 0) return `${m} demotion(s)`;
        return `${n} confirmation(s) and ${m} demotion(s)`;
    };

    /**
     * One kb_bible_commit attempt on the maintainer: G-pull, resolve the
     * base, kb_bible_commit, then G-push when a commit was made. Returns
     * { ok: true, result } or { ok: false, stage, error } -- never throws.
     * `resetToRemoteTip` is the retry's G-pull: after a rejected push the
     * maintainer holds a local bible commit the remote tip does not, so a
     * fast-forward pull would fail by construction; kb_bible_commit re-merges
     * the same ids at entry level on top of the new tip instead.
     *
     * `demoteIds` (defaulting to none) are this round's successful
     * kb_demote() ids, passed as kb_bible_commit's `demoted_ids` in the SAME
     * call as `ids` -- a round confirming some entries and demoting others
     * produces exactly one kb_bible_commit call, never two.
     */
    async function bibleAttempt(target, repo, ids, demoteIds = [], { resetToRemoteTip = false } = {}) {
        const maintainer = target.member;
        const count = ids.length + demoteIds.length;
        if (!(await onSprintBranch(maintainer, repo, count))) return { ok: false, stage: 'branch check', error: 'the maintainer is not on the sprint branch', branchBlocked: true };
        try {
            await gPull(maintainer, resetToRemoteTip ? { resetToRemoteTip: true } : {});
        } catch (err) {
            return { ok: false, stage: 'G-pull', error: errText(err) };
        }
        let base;
        try {
            base = await bibleBase(maintainer);
        } catch (err) {
            return { ok: false, stage: 'base resolution', error: errText(err) };
        }
        if (!base || typeof base.baseBranch !== 'string' || !base.baseBranch || typeof base.baseCommit !== 'string' || !base.baseCommit) {
            return { ok: false, stage: 'base resolution', error: 'the base branch or base commit could not be resolved on the maintainer' };
        }
        if (!(await onSprintBranch(maintainer, repo, count))) return { ok: false, stage: 'branch check', error: 'the maintainer is not on the sprint branch', branchBlocked: true };
        let res;
        try {
            res = await memberCall(target.record, 'kb_bible_commit', {
                ids,
                ...(demoteIds.length > 0 ? { demoted_ids: demoteIds } : {}),
                baseBranch: base.baseBranch,
                baseCommit: base.baseCommit,
            });
        } catch (err) {
            return { ok: false, stage: 'kb_bible_commit', error: errText(err) };
        }
        if (isToolError(res)) return { ok: false, stage: 'kb_bible_commit', error: toolErrorText(res) };
        const result = parseResult(res) || {};
        // Nothing committed (every id skipped, or the entry set unchanged).
        // That alone does not mean the entries are published: an earlier
        // round's bible commit may still sit unpushed on the maintainer (its
        // G-push was rejected and the reset onto the remote tip was refused to
        // protect unrelated local work). Only origin decides: when it already
        // holds the checkout's bible there is nothing to push; when a local
        // commit holds it, push that commit; otherwise (or when it cannot be
        // established) the ids stay queued.
        if (result.committed === false) {
            const where = await bibleOnOrigin(maintainer);
            if (where.unpushed === false) return { ok: true, result, pushed: false };
            if (where.unpushed !== true) return { ok: false, stage: 'publication check', error: where.reason || 'whether origin holds the bible could not be established' };
            log(`[kb-work] kb_bible_commit made no new commit on maintainer '${maintainer}', but an earlier bible commit is not on origin yet -- pushing it`);
        }
        if (!(await onSprintBranch(maintainer, repo, count))) return { ok: false, stage: 'branch check', error: 'the maintainer is not on the sprint branch', branchBlocked: true };
        // A bible push must publish the bible commit(s) only: never a doer
        // commit that sits unpushed underneath them. Without an injected
        // probe the push is allowed.
        if (typeof unpushedOnlyBible === 'function') {
            let verdict;
            try { verdict = await unpushedOnlyBible(maintainer, BIBLE_FILE); } catch (err) { verdict = { onlyBible: false, reason: errText(err) }; }
            if (!verdict || verdict.onlyBible !== true) {
                log(`[kb-work] WARN: not pushing the bible commit from maintainer '${maintainer}' (${repo}): ${(verdict && verdict.reason) || 'unknown'} -- a bible push must not publish other commits; the ${describeCounts(ids.length, demoteIds.length)} stay queued for the next round`);
                return { ok: false, stage: 'push guard', error: (verdict && verdict.reason) || 'unpushed non-bible commits', branchBlocked: true };
            }
        }
        try {
            await gPush(maintainer);
        } catch (err) {
            return { ok: false, stage: 'G-push', error: errText(err) };
        }
        return { ok: true, result, pushed: true };
    }

    /**
     * Whether origin's sprint branch already holds the maintainer checkout's
     * bible, through the injected bibleUnpushed probe. Resolves
     * { unpushed: false } when it does, { unpushed: true } when a local-only
     * commit holds the bible, or { unpushed: null, reason } when that cannot
     * be established (no probe wired, a git failure, a bible change that is
     * not committed) -- never assumes published. Never throws.
     */
    async function bibleOnOrigin(maintainer) {
        if (typeof bibleUnpushed !== 'function') return { unpushed: null, reason: 'no publication check is wired for the bible commit' };
        let r;
        try { r = await bibleUnpushed(maintainer, BIBLE_FILE); } catch (err) { return { unpushed: null, reason: errText(err) }; }
        if (r && (r.unpushed === true || r.unpushed === false)) return { unpushed: r.unpushed };
        return { unpushed: null, reason: (r && r.reason) || 'the publication check returned no answer' };
    }

    /**
     * True when a hard reset onto the remote tip would drop nothing but the
     * bible commit. When it would drop anything else (or that cannot be
     * established), logs a WARN and returns false -- the caller keeps the ids
     * queued and does not reset. Without an injected guard the reset is allowed.
     */
    async function resetIsSafe(maintainer, repo) {
        if (typeof canResetCheckout !== 'function') return true;
        let verdict;
        try { verdict = await canResetCheckout(maintainer, BIBLE_FILE); } catch (err) { verdict = { safe: false, reason: errText(err) }; }
        if (verdict && verdict.safe) return true;
        log(`[kb-work] WARN: not resetting maintainer '${maintainer}' (${repo}) onto the remote tip: ${(verdict && verdict.reason) || 'unknown'} -- unrelated local work was preserved; the bible confirmations stay queued for the next round`);
        return false;
    }

    /**
     * True when the maintainer's checked-out branch is the sprint branch.
     * Checked before the first G-pull of a bible commit and before every
     * reset onto the remote tip, so no pull, reset --hard, commit or push
     * ever runs on any other branch. When the branch differs (or cannot be
     * read), logs a WARN naming the maintainer and both branches and returns
     * false -- the caller keeps the ids queued. Without an injected guard
     * the check passes.
     */
    async function onSprintBranch(maintainer, repo, count, what = 'confirmation') {
        if (typeof checkedOutBranch !== 'function') return true;
        let found = null;
        let sprintBranch = null;
        let readError = null;
        try {
            const r = await checkedOutBranch(maintainer);
            found = r && typeof r.branch === 'string' && r.branch ? r.branch : null;
            sprintBranch = r && typeof r.sprintBranch === 'string' && r.sprintBranch ? r.sprintBranch : null;
        } catch (err) {
            readError = errText(err);
        }
        if (found && sprintBranch && found === sprintBranch) return true;
        const foundText = found ? `'${found}'` : `an unreadable branch${readError ? ` (${readError})` : ''}`;
        log(`[kb-work] WARN: maintainer '${maintainer}' (${repo}) has ${foundText} checked out, not the sprint branch '${sprintBranch || 'unknown'}' -- no pull, bible commit, push or reset is made there; ${count} ${what}(s) stay queued for the next round`);
        return false;
    }

    /**
     * Commit one repository's pending confirmations AND pending demotions to
     * the bible on its maintainer, in a single kb_bible_commit call (`ids` and
     * `demoted_ids` together -- see bibleAttempt). Never throws; ids that do
     * not reach a pushed commit stay pending for the next round.
     * @returns {Promise<{ committed: number, pending: number }>}
     */
    async function commitRepo(repo) {
        const pending = confirmations.get(repo);
        const pendingDemoted = demotedPending.get(repo);
        const ids = pending ? [...pending] : [];
        const demoteIds = pendingDemoted ? [...pendingDemoted] : [];
        if (ids.length === 0 && demoteIds.length === 0) return { committed: 0, pending: 0 };
        const totalPending = () => ids.length + demoteIds.length;
        if (sealedReason) return { committed: 0, pending: totalPending() };
        const sel = selector();
        const target = sel && typeof sel.getKbMaintainer === 'function' ? sel.getKbMaintainer(repo) : null;
        if (!target || !target.record) {
            log(`[kb-work] WARN: repository ${repo} has no kb_maintainer -- ${describeCounts(ids.length, demoteIds.length)} stay queued for the bible`);
            return { committed: 0, pending: totalPending() };
        }
        const maintainer = target.member;
        if (typeof gPull !== 'function' || typeof gPush !== 'function' || typeof bibleBase !== 'function') {
            log(`[kb-work] WARN: no git sync wired for the bible commit -- ${describeCounts(ids.length, demoteIds.length)} for ${repo} stay queued`);
            return { committed: 0, pending: totalPending() };
        }
        if (isBusy(maintainer)) {
            log(`[kb-work] maintainer '${maintainer}' is mid-dispatch -- ${describeCounts(ids.length, demoteIds.length)} for ${repo} stay queued for the next round's bible commit`);
            return { committed: 0, pending: totalPending() };
        }
        let release;
        inFlight.set(maintainer, new Promise((r) => { release = r; }));
        try {
            let outcome = await bibleAttempt(target, repo, ids, demoteIds);
            if (!outcome.ok && outcome.stage === 'G-push') {
                log(`[kb-work] G-push of the bible commit on maintainer '${maintainer}' (${repo}) was rejected (${outcome.error}) -- retrying once: rebase --abort, G-pull, kb_bible_commit, G-push`);
                if (typeof abortRebase === 'function' && (await onSprintBranch(maintainer, repo, totalPending()))) {
                    try { await abortRebase(maintainer); } catch (err) { log(`[kb-work] rebase --abort on maintainer '${maintainer}' failed (non-fatal): ${errText(err)}`); }
                }
                // The reset throws away the maintainer's local-only commits and
                // uncommitted changes; it is usually also a doer, so only reset
                // when that is the bible commit alone.
                if (!(await onSprintBranch(maintainer, repo, totalPending()))) return { committed: 0, pending: totalPending() };
                if (!(await resetIsSafe(maintainer, repo))) return { committed: 0, pending: totalPending() };
                outcome = await bibleAttempt(target, repo, ids, demoteIds, { resetToRemoteTip: true });
                if (!outcome.ok && (outcome.stage === 'G-push' || outcome.stage === 'kb_bible_commit')) {
                    // Leave the checkout on the remote tip: an unpushed bible
                    // commit would make the maintainer's next fast-forward
                    // G-pull fail. The ids stay queued and are re-merged by
                    // the next round's kb_bible_commit.
                    if (typeof abortRebase === 'function' && !outcome.branchBlocked && (await onSprintBranch(maintainer, repo, totalPending()))) {
                        try { await abortRebase(maintainer); } catch { /* best-effort */ }
                    }
                    try { if ((await onSprintBranch(maintainer, repo, totalPending())) && (await resetIsSafe(maintainer, repo))) await gPull(maintainer, { resetToRemoteTip: true }); } catch (err) {
                        log(`[kb-work] WARN: could not reset maintainer '${maintainer}' onto the remote tip after the failed bible commit: ${errText(err)}`);
                    }
                }
            }
            if (!outcome.ok && outcome.branchBlocked) return { committed: 0, pending: totalPending() };
            if (!outcome.ok) {
                log(`[kb-work] WARN: bible commit for ${repo} on maintainer '${maintainer}' failed at ${outcome.stage} (${outcome.error}) -- ${describeCounts(ids.length, demoteIds.length)} stay queued for the next round`);
                return { committed: 0, pending: totalPending() };
            }
            const skipped = Array.isArray(outcome.result.skipped) ? outcome.result.skipped : [];
            const skippedIds = new Set(skipped.map((s) => s && s.id));
            // Every id leaves the queue, skipped ones included: a skip (an id not
            // CONFIRMED, or whose cited files no longer match its recorded basis) can
            // never succeed on a retry without a new capture, and kb_export refuses the
            // same entries, so re-queuing would only repeat the skip every round. The
            // same reasoning applies to a skipped demotion (not_demoted_or_unknown
            // never resolves itself without a new kb_demote).
            for (const id of ids) pending.delete(id);
            if (pending && pending.size === 0) confirmations.delete(repo);
            for (const id of demoteIds) if (pendingDemoted) pendingDemoted.delete(id);
            if (pendingDemoted && pendingDemoted.size === 0) demotedPending.delete(repo);
            const merged = Array.isArray(outcome.result.merged) ? outcome.result.merged.length
                : ids.length - ids.filter((id) => skippedIds.has(id)).length;
            const demoted = Array.isArray(outcome.result.demoted) ? outcome.result.demoted.length
                : demoteIds.length - demoteIds.filter((id) => skippedIds.has(id)).length;
            if (skipped.length > 0) {
                log(`[kb-work] kb_bible_commit skipped ${skipped.length} id(s) for ${repo} (dropped from the queue, with the reason the tool returned): ${skipped.map((x) => (x && x.id ? (x.reason ? `${x.id} (${x.reason})` : x.id) : String(x))).join(', ')}`);
            }
            log(`[kb-work] bible commit for ${repo} on maintainer '${maintainer}': ${describeCounts(merged, demoted)} ${outcome.pushed ? 'committed and pushed' : 'already in the bible -- nothing to push'}`);
            return { committed: outcome.pushed ? merged + demoted : 0, pending: (pending ? pending.size : 0) + (pendingDemoted ? pendingDemoted.size : 0) };
        } finally {
            inFlight.delete(maintainer);
            release();
        }
    }

    function enqueue(repo, kind, role, payload) {
        if (!queues.has(repo)) queues.set(repo, []);
        queues.get(repo).push({ kind, role, payload });
    }

    /** Repositories whose maintainer is `memberName`. */
    function reposMaintainedBy(memberName) {
        const sel = selector();
        if (!sel || typeof sel.maintainers !== 'function') return [];
        const out = [];
        for (const [repo, m] of sel.maintainers()) if (m && m.member === memberName) out.push(repo);
        return out;
    }

    return {
        /**
         * Dispatch lifecycle: a dispatch is starting on `memberName`. Marks it
         * busy (no queued KB write starts on it from here on) and waits out a
         * write already in flight to it. Never throws.
         */
        async dispatchStarted(memberName) {
            if (!memberName) return;
            busy.set(memberName, (busy.get(memberName) || 0) + 1);
            const pending = inFlight.get(memberName);
            if (pending) await pending;
        },
        /**
         * Dispatch lifecycle: a dispatch on `memberName` ended. When it was the
         * last open one, apply the writes that queued up behind it for every
         * repository it maintains. Never throws.
         */
        async dispatchEnded(memberName) {
            if (!memberName) return;
            const n = (busy.get(memberName) || 0) - 1;
            if (n > 0) { busy.set(memberName, n); return; }
            busy.delete(memberName);
            for (const repo of reposMaintainedBy(memberName)) {
                try { await flush(repo); } catch (err) { log(`[kb-work] flush for ${repo} failed (non-fatal): ${err.message}`); }
            }
        },
        /** Try every repository's queue (e.g. before the final review's bible commit). Never throws. */
        async flushAll() {
            const counts = zeroCounts();
            for (const repo of [...queues.keys()]) {
                const c = await flush(repo);
                for (const k of Object.keys(counts)) counts[k] += c[k];
            }
            return counts;
        },
        /** Number of KB writes still queued (all repositories, or one). */
        pendingCount(repo) {
            if (repo) return (queues.get(repo) || []).length;
            let n = 0;
            for (const q of queues.values()) n += q.length;
            return n;
        },
        /** Log a WARN for every repository that still has queued writes, confirmations or demotions. */
        warnPending() {
            for (const [repo, q] of queues) {
                if (q.length > 0) log(`[kb-work] WARN: ${q.length} KB write(s) for ${repo} are still queued (maintainer busy or unreachable) -- not applied`);
            }
            for (const [repo, ids] of confirmations) {
                if (ids.size > 0) log(`[kb-work] WARN: ${ids.size} confirmation(s) for ${repo} are not in a pushed bible commit${sealedReason ? ` (bible commits sealed: ${sealedReason})` : ''}`);
            }
            for (const [repo, ids] of demotedPending) {
                if (ids.size > 0) log(`[kb-work] WARN: ${ids.size} demotion(s) for ${repo} are not in a pushed bible commit${sealedReason ? ` (bible commits sealed: ${sealedReason})` : ''}`);
            }
        },
        /**
         * The review-round bible commit: apply whatever is still queued, then
         * for every repository with confirmations and/or demotions, on its
         * maintainer: G-pull, kb_bible_commit (ids and demoted_ids together),
         * G-push (see the client header for the retry). A round with neither
         * makes no call at all. A no-op once sealed. Never throws.
         * @param {string} [label] the round, for the log
         * @returns {Promise<{ committed: number, pending: number }>}
         */
        async commitRound(label = 'review round') {
            const out = { committed: 0, pending: 0 };
            if (!active) return out;
            if (sealedReason) {
                let n = 0;
                for (const ids of confirmations.values()) n += ids.size;
                for (const ids of demotedPending.values()) n += ids.size;
                if (n > 0) log(`[kb-work] ${label}: bible commits are sealed (${sealedReason}) -- ${n} confirmation(s)/demotion(s) not committed`);
                return { committed: 0, pending: n };
            }
            for (const repo of [...queues.keys()]) {
                if (queues.get(repo).length > 0) await flush(repo);
            }
            const pendingRepos = new Set([...confirmations.keys(), ...demotedPending.keys()]);
            for (const repo of pendingRepos) {
                const r = await serialize(repo, () => commitRepo(repo));
                out.committed += r.committed;
                out.pending += r.pending;
            }
            return out;
        },
        /**
         * Stop every further bible commit: a FAIL verdict or an aborted
         * sprint commits nothing more, and the confirmation/demotion queues
         * are not flushed. Idempotent; the first reason wins.
         */
        seal(reason) {
            if (sealedReason) return;
            sealedReason = String(reason || 'sealed');
            let n = 0;
            for (const ids of confirmations.values()) n += ids.size;
            for (const ids of demotedPending.values()) n += ids.size;
            log(`[kb-work] bible commits sealed (${sealedReason})${n > 0 ? ` -- ${n} confirmation(s)/demotion(s) will not be committed` : ''}`);
        },
        /** Confirmations not yet in a pushed bible commit (all repositories, or one). */
        pendingConfirmations(repo) {
            if (repo) return [...(confirmations.get(repo) || [])];
            const out = [];
            for (const ids of confirmations.values()) out.push(...ids);
            return out;
        },
        /**
         * Per repository, the confirmations not yet in a pushed bible commit,
         * for the persisted sprint analysis: [{ repo, count }] (repositories
         * with none are left out), plus why bible commits were sealed, if
         * they were.
         * @returns {{ repos: Array<{ repo: string, count: number }>, sealedReason: string|null }}
         */
        unpublishedBible() {
            const repos = [];
            for (const [repo, ids] of confirmations) if (ids.size > 0) repos.push({ repo, count: ids.size });
            return { repos, sealedReason };
        },
        /**
         * The maintainer member record a reviewer's KB reads and judgements
         * go to (its repository's maintainer, or the sprint's only one), or null.
         */
        maintainerRecordFor(member) {
            const m = reviewMaintainerFor(memberNameOf(member));
            return m ? m.record : null;
        },
        /**
         * apra-fleet-0ef: the INFERRED entries this reviewer may promote.
         *
         * The engine's contract is "judgment belongs to the role, execution
         * belongs here" -- the reviewer returns `kb_promotions:[{id, reason}]`
         * and `apply()` calls kb_promote. But an entry id exists only inside
         * the KB, and the reviewer subagent has no apra-fleet MCP tools to
         * look one up, so it could never name an id: `kb_promotions` was
         * structurally always empty and nothing was ever promoted. (kb_captures
         * worked only because a capture needs no pre-existing id.) This is the
         * missing input: the engine reads the candidates and hands them to the
         * reviewer in its prompt.
         *
         * Best-effort by design -- a cold or unreachable KB must degrade to
         * "nothing to promote", never fail the review dispatch.
         *
         * D6 IN-SPRINT PING-PONG GUARD. Without this, an entry the reviewer
         * demoted in round N is offered right back for promotion in round
         * N+1 -- promotionCandidates' own in-window filter admits it (an
         * INFERRED entry created this sprint still matches, whether it got
         * there by a fresh capture or by a demotion of a CONFIRMED one), and
         * nothing has changed about it to re-judge. An entry wasDemotedThisSprint
         * (its demoted_at falls at or after sprintStartMs()) is excluded when
         * demotionBasisUnchanged is true for it -- i.e. unless at least one
         * of its cited files now hashes differently from the
         * demoted_basis_hashes snapshot taken at demote time (currentFileHashes,
         * read ONLY for the files these candidates actually cite, never
         * recomputed from scratch). A changed basis is new evidence, so that
         * entry stays offered. The guard runs HERE, at offering time -- a
         * ping-ponged id is never in the candidate block apply() later checks
         * offeredCandidates against, never merely refused there.
         */
        async promotionCandidates(member) {
            // The candidates live in the reviewer's repository MAINTAINER's KB
            // (every KB write is routed there), tagged member:<maintainer uuid>
            // by its MEMBER session. Without a maintainer there is no session
            // to read them from; refuse rather than read some other KB (the
            // apra-fleet-tm7 repo-blindness class).
            const target = active ? reviewMaintainerFor(memberNameOf(member)) : null;
            if (!target) return [];
            // Replace (never accumulate) this review scope's offered set up
            // front, so a failed read leaves nothing offered from a prior round.
            offeredCandidates.set(target.repo, new Set());
            // Writes still queued for this repository (a capture from this
            // very round) get their chance to land before the read.
            if (queues.has(target.repo)) await flush(target.repo);
            try {
                const res = await memberCall(target.record, 'kb_query', {
                    tag: `member:${target.record.id}`,
                    confidence: ['INFERRED'],
                    limit: KB_MAX_PROMOTION_CANDIDATES,
                });
                if (isToolError(res)) {
                    log(`[kb-work] kb_query for promotion candidates rejected on maintainer '${target.member}' (non-fatal): ${toolErrorText(res)}`);
                    return [];
                }
                const parsed = parseResult(res);
                const results = parsed && Array.isArray(parsed.l1_results) ? parsed.l1_results
                    : (parsed && Array.isArray(parsed.results) ? parsed.results : []);
                // The sprint window: only entries captured during THIS sprint
                // are this sprint's to judge. An entry whose created_at cannot
                // be read cannot be shown to be in the window.
                const since = sprintStartMs();
                const inWindow = (e) => {
                    if (since === null) return true;
                    const t = typeof e.created_at === 'string' ? Date.parse(e.created_at) : NaN;
                    return Number.isFinite(t) && t >= since;
                };
                const eligible = results
                    // promote() refuses type='user-directive' outright (activation
                    // is human-terminal, CLI-only), so offering one as a candidate
                    // can only produce a guaranteed refusal.
                    .filter((e) => e && typeof e.id === 'string' && e.type !== 'user-directive' && inWindow(e));
                // D6 ping-pong guard (see the method comment): only entries
                // demoted THIS sprint are even candidates for exclusion, and
                // only a disk re-hash can tell whether their basis moved on
                // since. Reading is bounded to exactly the files THESE
                // candidates cite -- never every file in the repository --
                // and skipped entirely when there is nothing to check or no
                // callback wired, so the common case (no in-sprint demotion)
                // costs nothing extra.
                const pingPonged = eligible.filter((e) => wasDemotedThisSprint(e, since));
                let unchanged = new Set();
                if (pingPonged.length > 0 && typeof currentFileHashes === 'function') {
                    const files = new Set();
                    for (const e of pingPonged) for (const f of Object.keys(e.demoted_basis_hashes || {})) files.add(f);
                    if (files.size > 0) {
                        try {
                            const current = await currentFileHashes(target.member, [...files]);
                            for (const e of pingPonged) {
                                if (demotionBasisUnchanged(e.demoted_basis_hashes, current)) unchanged.add(e.id);
                            }
                        } catch (err) {
                            log(`[kb-work] could not re-hash the in-sprint ping-pong basis on maintainer '${target.member}' (non-fatal, nothing excluded): ${err.message}`);
                        }
                    }
                }
                const offered = eligible.filter((e) => !unchanged.has(e.id)).slice(0, KB_MAX_PROMOTION_CANDIDATES);
                offeredCandidates.set(target.repo, new Set(offered.map((e) => e.id)));
                return offered;
            } catch (err) {
                log(`[kb-work] could not read promotion candidates from maintainer '${target.member}' (non-fatal): ${err.message}`);
                return [];
            }
        },
        /**
         * The CONFIRMED entries this reviewer may demote back to INFERRED,
         * scoped to the review that is about to run.
         *
         * Mirrors promotionCandidates in every structural respect it shares
         * with it -- reviewMaintainerFor to resolve the reviewer's repository
         * MAINTAINER (refusing rather than reading some other KB when there is
         * none), replacing (never accumulating) the offered set up front so a
         * failed read leaves nothing offered from a prior round, and flushing
         * any writes still queued for that repository before the read -- and
         * reads the SAME owner-tagged rows at the OTHER confidence tier
         * (CONFIRMED rather than INFERRED). Every offered id is therefore one
         * kb_demote can actually apply: reviewMaintainerFor resolves exactly
         * the maintainer whose session kb_demote's ownerTag check requires.
         *
         * THE READ. buildDemotionCandidateQuery (above) is the whole of it,
         * and its `own_scope: true` is why this returns anything at all: a
         * MEMBER-session CONFIRMED read without it is answered from the
         * checkout bible view, whose rows are all untagged, so the owner
         * filter could never match and this offered nothing in every real
         * sprint. The read is also deliberately WIDE -- stale and
         * contradiction-flagged rows included, since kb_demote accepts both
         * and they are the ones most worth re-checking -- and limited to
         * KB_DEMOTION_READ_LIMIT rather than the offer cap.
         *
         * THEN FILTER, THEN CAP, in that order. Eligibility
         * (isDemotableCandidate: drops superseded, user-directive and any
         * non-CONFIRMED row the read let through) and changed-file relevance
         * run over the WHOLE read; only the survivors are capped at
         * KB_MAX_DEMOTION_CANDIDATES. Capping first would make the offer cap
         * a read pre-filter and let a maintainer with many owned CONFIRMED
         * rows have every genuinely relevant one truncated away before
         * anything checked whether it was relevant.
         *
         * SCOPE IS AN ARGUMENT, NOT A GUESS ABOUT THE CALLER. UNLIKE
         * promotionCandidates (windowed by sprint start time), an entry is
         * kept only when it touches a file in the changed-file set of the
         * review being prepared, and WHICH set that is comes from
         * `opts.scope`, never from inspecting who called:
         *
         *   'round'  (default) -- a PER-ROUND review. `roundChangedFiles`
         *     fetches and fast-forward-merges the maintainer's checkout, THEN
         *     diffs from the previous round's merged tip (or, on the first
         *     round, the sprint's base branch) to the new one. Computed AFTER
         *     the merge so it reflects this round's commits rather than a
         *     stale pre-merge snapshot.
         *   'sprint' -- the FINAL review, which judges the whole sprint diff
         *     and therefore has no "this round": `sprintChangedFiles` gives
         *     the CUMULATIVE baseBranch...branch diff.
         *
         * Neither is kbInjection's `diffFiles` (the KB-injection hint
         * context's own cumulative diff), and promotionCandidates is
         * unchanged by all of this.
         *
         * Demoting a CONFIRMED claim this review never re-checked is never
         * this review's to offer, so an empty changed-file set offers
         * nothing.
         *
         * Best-effort like every other KB read here: no maintainer, an
         * unreachable one, no changed-files callback wired for the requested
         * scope, a diff that could not be computed, or an erroring/rejecting
         * kb_query all degrade to [] and must never fail the review dispatch
         * -- per-round or final.
         *
         * @param {object} member
         * @param {{ scope?: 'round'|'sprint' }} [opts]
         * @returns {Promise<object[]>}
         */
        async demotionCandidates(member, { scope = 'round' } = {}) {
            // Explicit, and explicitly validated: an unknown scope is a wiring
            // bug, and silently falling back to the round diff at FINAL review
            // would offer the reviewer a set scoped to a round that does not
            // exist. Degrade to nothing rather than to the wrong scope.
            if (scope !== 'round' && scope !== 'sprint') {
                log(`[kb-work] demotion candidates requested with unknown scope '${scope}' (non-fatal): offering none.`);
                return [];
            }
            const changedFilesFor = scope === 'sprint' ? sprintChangedFiles : roundChangedFiles;
            const scopeLabel = scope === 'sprint' ? "this sprint's cumulative" : "this round's";
            const target = active ? reviewMaintainerFor(memberNameOf(member)) : null;
            if (!target) return [];
            // Replace (never accumulate) this review scope's offered set up
            // front, so a failed read leaves nothing offered from a prior
            // round -- and so the FINAL review's call cannot inherit the last
            // per-round call's offers either.
            offeredDemotions.set(target.repo, new Set());
            // Writes still queued for this repository (a capture or a
            // promotion/discard from this very round) get their chance to
            // land before the read, same as promotionCandidates.
            if (queues.has(target.repo)) await flush(target.repo);
            if (typeof changedFilesFor !== 'function') return [];
            // Same branch guard flushRepo/commitRepo apply before every G-pull
            // on the maintainer: a fast-forward merge does not care what
            // branch HEAD is currently on, only that HEAD is an ancestor of
            // the fetched tip, so pulling on a maintainer not actually on the
            // sprint branch could silently advance the wrong branch.
            if (!(await onSprintBranch(target.member, target.repo, 0, 'demotion candidate read'))) return [];
            let changed;
            try {
                changed = await changedFilesFor(target.member);
            } catch (err) {
                log(`[kb-work] could not compute ${scopeLabel} changed files on maintainer '${target.member}' (non-fatal): ${err.message}`);
                return [];
            }
            const files = Array.isArray(changed) ? changed.filter((f) => typeof f === 'string' && f.trim()) : [];
            if (files.length === 0) return [];
            try {
                const res = await memberCall(target.record, 'kb_query', buildDemotionCandidateQuery(target.record.id));
                if (isToolError(res)) {
                    log(`[kb-work] kb_query for demotion candidates rejected on maintainer '${target.member}' (non-fatal): ${toolErrorText(res)}`);
                    return [];
                }
                const parsed = parseResult(res);
                const results = parsed && Array.isArray(parsed.l1_results) ? parsed.l1_results
                    : (parsed && Array.isArray(parsed.results) ? parsed.results : []);
                const fileSet = new Set(files);
                const touchesChangedFiles = (e) => Array.isArray(e.source_files) && e.source_files.some((f) => fileSet.has(f));
                // Filter the WHOLE read first (eligibility, then relevance),
                // and only cap the survivors -- see the method comment.
                const offered = results
                    .filter((e) => isDemotableCandidate(e) && touchesChangedFiles(e))
                    .slice(0, KB_MAX_DEMOTION_CANDIDATES);
                offeredDemotions.set(target.repo, new Set(offered.map((e) => e.id)));
                return offered;
            } catch (err) {
                log(`[kb-work] could not read demotion candidates from maintainer '${target.member}' (non-fatal): ${err.message}`);
                return [];
            }
        },
        /**
         * KB audit follow-up: the per-dispatch, relevance-ranked read.
         *
         * primeAll() runs ONCE per member at sprint start with no hints, so
         * every role received the same handful of entries no matter what it was
         * about to work on -- and kb_query went unused by this engine entirely.
         * This asks the KB what it knows about THIS dispatch, using the terms
         * the engine already holds (bead ids and their titles).
         *
         * `expand_related` is what finally reads the KB's own graph. The KB has
         * been writing `refines` and `contradiction_of` edges since AUDN
         * shipped and traversing none of them: 554 edges, 0 reads. A role about
         * to act on an entry is precisely who needs to know that entry has a
         * newer framing -- a CONFIRMED refinement arrives as a related claim.
         *
         * Only CONFIRMED, undisputed entries are requested and kept (see
         * isInjectableKbEntry). A contradiction pair is excluded on BOTH sides
         * rather than shown as a dispute: confidence tier does NOT track
         * correctness across a contradiction chain (the warehouse chain-A
         * shape, where the incorrect entry outranks both of its corrections),
         * so neither side is safe to hand a role as knowledge until the pair is
         * resolved.
         *
         * Best-effort, like every other KB read here: no member, no terms, a
         * cold KB or an unreachable one all degrade to "no knowledge", never to
         * a failed dispatch.
         */
        async relevantKnowledge(member, hints) {
            return (await this.knowledgeFor(member, hints)).entries;
        },
        /**
         * The per-dispatch read behind the KNOWLEDGE BANK block: the entries
         * AND the source they really came from.
         *
         * Read from the repository's kb_maintainer through memberCall -- never
         * from the dispatched member (whose own KB may be cold, absent or on
         * a different checkout) and never from the orchestrator session. A
         * client built without a maintainer selector (unit-test seam) reads as
         * the member it is given.
         *
         * `hints` is either a bare term list or {terms, hintSymbols,
         * hintModules} (kb-hints.mjs roleHints). Order: kb_query on the
         * terms; when that finds nothing, kb_session_prime ranked by
         * hint_symbols/hint_modules; when that finds nothing too, NOTHING --
         * there is deliberately no fall-back to an arbitrary set.
         *
         * @returns {Promise<{ entries: object[], source: 'query'|'prime' }>}
         */
        async knowledgeFor(member, hints) {
            const h = Array.isArray(hints)
                ? { terms: hints, hintSymbols: [], hintModules: [] }
                : { terms: [], hintSymbols: [], hintModules: [], ...(hints || {}) };
            const strs = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t.trim()) : []);
            const terms = strs(h.terms);
            const hintSymbols = strs(h.hintSymbols);
            const hintModules = strs(h.hintModules);
            const nothing = { entries: [], source: terms.length > 0 || hintSymbols.length + hintModules.length === 0 ? 'query' : 'prime' };
            if (!active || !member) return nothing;
            if (terms.length === 0 && hintSymbols.length === 0 && hintModules.length === 0) return nothing;
            const target = readTarget(member);
            if (!target) {
                log(`[kb-work] no kb_maintainer to read knowledge from for ${memberLabel(member)} -- no knowledge this dispatch`);
                return nothing;
            }
            if (terms.length > 0) {
                const queried = await queryEntries(target, terms.join(' '));
                if (queried.length > 0) return { entries: queried, source: 'query' };
            }
            if (hintSymbols.length > 0 || hintModules.length > 0) {
                const primed = await primeEntries(target, hintSymbols, hintModules);
                if (primed.length > 0) return { entries: primed, source: 'prime' };
            }
            return nothing;
        },
        /**
         * Vet a role's KB work and route it to the producing member's
         * repository maintainer: queued per repository, then applied in the
         * maintainer's MEMBER session after a G-pull (see the client header).
         * `member` names the member whose dispatch produced `result` (a member
         * record or a bare name); it decides WHICH repository, never which
         * session -- no write is ever sent to it unless it is the maintainer.
         *
         * @returns {Promise<{captured: number, promoted: number, discarded: number, demoted: number, refused: number}>}
         *   counts of the writes applied by this call's flush (writes left
         *   queued for a busy or unreachable maintainer are not counted).
         */
        async apply(role, member, result) {
            const { captures, promotions, discards, demotions, refused } = vetKbWork(role, result);

            for (const r of refused) log(`[kb-work] refused -- ${r}`);
            // Log every promotion with its stated evidence BEFORE attempting it.
            // This log is the audit trail the bible never had.
            for (const p of promotions) log(`[kb-work] promote ${p.id} (${role}): ${p.reason}`);
            for (const d of discards) log(`[kb-work] discard ${d.id} (${role}): ${d.reason}`);
            for (const d of demotions) log(`[kb-work] demote ${d.id} (${role}): ${d.reason}`);

            let extraRefused = 0;
            const done = (counts) => ({ ...counts, refused: refused.length + extraRefused });
            if (captures.length === 0 && promotions.length === 0 && discards.length === 0 && demotions.length === 0) return done(zeroCounts());
            const dropped = `${captures.length} capture(s), ${promotions.length} promotion(s), ${discards.length} discard(s) and ${demotions.length} demotion(s) dropped`;

            const producer = memberNameOf(member);
            // Without a resolved member there is no repository the writes
            // belong to -- the tm7 defect. Refuse rather than guess.
            if (!active || !producer) {
                log(`[kb-work] WARN: no member resolved for ${role} -- ${dropped}`);
                return done(zeroCounts());
            }
            const sel = selector();
            const nonRepo = !!(sel && typeof sel.isNonRepoMember === 'function' && sel.isNonRepoMember(producer));
            // A capture belongs to the PRODUCER's repository: a member whose
            // work folder is not a repository has none, so its captures are
            // dropped. Review judgements (CONFIRM/DISCARD/DEMOTE) act on
            // candidates read from the reviewer's maintainer
            // (reviewMaintainerFor), so they follow the same resolution as
            // the candidate read.
            let target = null;
            if (captures.length > 0) {
                if (nonRepo) {
                    log(`[kb-work] WARN: member '${producer}' (${role}): work folder is not a repository -- ${captures.length} capture(s) dropped`);
                } else {
                    target = maintainerFor(producer);
                    if (target) {
                        for (const c of captures) enqueue(target.repo, 'capture', role, c);
                    } else {
                        log(`[kb-work] WARN: no kb_maintainer for member '${producer}' (${role}) -- ${captures.length} capture(s) dropped`);
                    }
                }
            }
            const repos = new Set(target ? [target.repo] : []);
            if (promotions.length > 0 || discards.length > 0 || demotions.length > 0) {
                const review = reviewMaintainerFor(producer);
                if (review) {
                    // Only ids offered in this dispatch's candidate block may be
                    // judged; anything else is refused before any kb_* call.
                    // Demotions are filtered against their OWN offered set
                    // (offeredDemotions), never the promotion one -- an id
                    // offered for promotion is not thereby offered for demotion.
                    const offered = offeredCandidates.get(review.repo) || new Set();
                    const offeredToDemote = offeredDemotions.get(review.repo) || new Set();
                    const inBlock = (kind, x, offeredSet) => {
                        if (offeredSet.has(x.id)) return true;
                        log(`[kb-work] refused -- ${role}: ${kind} ${x.id} not in this dispatch's candidate block`);
                        extraRefused += 1;
                        return false;
                    };
                    for (const p of promotions) if (inBlock('promotion', p, offered)) enqueue(review.repo, 'promote', role, p);
                    for (const d of discards) if (inBlock('discard', d, offered)) enqueue(review.repo, 'discard', role, d);
                    for (const d of demotions) if (inBlock('demotion', d, offeredToDemote)) enqueue(review.repo, 'demote', role, d);
                    repos.add(review.repo);
                } else {
                    log(`[kb-work] WARN: no kb_maintainer for member '${producer}' (${role}) -- ${promotions.length} promotion(s), ${discards.length} discard(s) and ${demotions.length} demotion(s) dropped`);
                }
            }
            const counts = zeroCounts();
            for (const repo of repos) {
                const c = await flush(repo);
                for (const k of Object.keys(counts)) counts[k] += c[k];
            }
            return done(counts);
        },
    };
}

/**
 * apra-fleet-e28 / KB trust pipeline Phase 2: KB priming for the fleet-sprint
 * engine, which had none -- it lived only in the Claude workflow copy.
 *
 * `callTool` (the orchestrator's own session, used only for member_detail) and
 * `memberCall` (member-call.mjs: a MEMBER-scoped session on that member) are
 * injected, so this stays transport-agnostic and unit-testable without a live
 * fleet server.
 *
 * WHY PER MEMBER, NOT PER SPRINT: this engine has no repo of its own. It
 * coordinates members by name and branch; the repo lives on each member's side,
 * possibly on a different host at a different path. A kb_* call operates on
 * the CALLING SESSION's own KB -- a member session resolves that member's
 * registered work folder -- so each member is primed through its own member
 * session. Priming through the orchestrator's session would read whichever
 * repo the fleet server sits in (the apra-fleet-tm7 / apra-fleet-3zl
 * repo-blindness defect). member_detail supplies the member's id and type
 * (what memberCall needs) and its work folder.
 *
 * Best-effort throughout, matching the reservation client's precedent: a member
 * that cannot be resolved, or whose prime call fails, is logged and skipped. A
 * sprint must not fail because the KB is cold -- priming is an optimisation,
 * and every role contract's Step 0 already degrades gracefully when the KB
 * tools are unavailable.
 *
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, memberCall?: (member: object, name: string, args: object) => Promise<any>, members?: string[], log?: Function }} opts
 * @returns {{ primeAll: () => Promise<{primed: number, skipped: number}> }}
 */

export function createKbPrimingClient(opts = {}) {
    const { callTool, memberCall, members = [], log = () => {} } = opts;
    const maintainerSel = () => {
        const m = typeof opts.maintainers === 'function' ? opts.maintainers() : opts.maintainers;
        return (m && typeof m.maintainerForMember === 'function') ? m : null;
    };
    /** maintainer record id -> entries primed there (a repository is imported and primed once). */
    const primedByTarget = new Map();
    const active = typeof callTool === 'function' && typeof memberCall === 'function' && members.length > 0;

    function parseResult(result) {
        if (result && typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
        if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
            try { return JSON.parse(result.content[0].text); } catch { return null; }
        }
        return (result && typeof result === 'object') ? result : null;
    }

    async function resolveMember(member) {
        // apra-fleet-n78: format:'json' is REQUIRED. member_detail defaults to
        // 'compact', whose renderer emits no folder at all -- `folder` is set only
        // on the json path (src/tools/member-detail.ts). Omitting it made this
        // return null for every member, so the KB was never primed for anyone.
        const detail = parseResult(await callTool('member_detail', { member_name: member, format: 'json' }));
        const d = detail && (detail.member && typeof detail.member === 'object' ? { ...detail.member, ...detail } : detail);
        const folder = d && d.folder;
        const id = d && d.id;
        return {
            folder: (typeof folder === 'string' && folder.length > 0) ? folder : null,
            // The record memberCall needs: the member's id (session identity)
            // and type (local -> in-process session, remote/relay -> the member's
            // own `apra-fleet call`).
            record: (typeof id === 'string' && id.length > 0)
                ? { id, name: member, type: typeof d.type === 'string' ? d.type : undefined }
                : null,
        };
    }

    // member -> work folder, populated by primeAll(). Informational: no kb_*
    // call takes it any more (the member session resolves it server-side).
    const folders = new Map();

    // member name -> the member record memberCall needs ({id, name, type}).
    // createKbWorkClient's calls take this record, so a capture lands in the
    // KB of the member that actually did the work.
    const records = new Map();

    // member -> the entries kb_session_prime returned for that member.
    //
    // KB audit 2026-08-11: primeAll() used to `await callTool(...)` and throw
    // the result away, on the assumption that priming "warms" something the
    // role's own Step 0 would later read. It does not: prime is a pure read,
    // and the role CANNOT repeat it -- a member-dispatched subagent has the
    // fleet MCP server disabled (src/providers/claude.ts
    // composePermissionConfig), so every contract's Step 0 kb_session_prime is
    // unreachable there. Nothing consumed the knowledge and nothing could, which
    // is why six sprints retrieved zero entries. Retaining the result is what
    // lets kbKnowledgeBlock() hand it to the role in its dispatch prompt --
    // the same shape of fix that made kb_promotions reachable.
    const knowledge = new Map();

    return {
        folderOf(member) {
            return folders.get(member) || null;
        },
        /** The member record ({id, name, type}) kb work for `member` runs as, or null. */
        memberOf(member) {
            return records.get(member) || null;
        },
        knowledgeOf(member) {
            return knowledge.get(member) || [];
        },
        async primeAll() {
            if (!active) return { primed: 0, skipped: members.length };
            let primed = 0;
            let skipped = 0;
            for (const member of members) {
                try {
                    const { folder, record } = await resolveMember(member);
                    if (folder) folders.set(member, folder);
                    if (!record) {
                        // No member id means no member session to scope the KB to.
                        // Priming any other way would read the fleet server's own
                        // KB, so skip instead.
                        log(`[kb-prime] could not resolve member '${member}' -- skipping (KB stays cold)`);
                        skipped++;
                        continue;
                    }
                    records.set(member, record);
                    // Knowledge is read from the repository's kb_maintainer, not
                    // the member itself. A sprint without a selector primes the
                    // member's own session (unit-test seam).
                    const sel = maintainerSel();
                    const m = sel ? sel.maintainerForMember(member) : null;
                    const target = sel ? (m && m.record ? m.record : null) : record;
                    if (!target) {
                        log(`[kb-prime] no kb_maintainer for member '${member}' -- no knowledge primed`);
                        primed++;
                        continue;
                    }
                    if (primedByTarget.has(target.id)) {
                        const shared = primedByTarget.get(target.id);
                        if (shared.length > 0) knowledge.set(member, shared);
                        primed++;
                        continue;
                    }
                    // Land the committed bible in the WARM KB before priming.
                    //
                    // Without this the bible is reachable only through
                    // kb_session_prime's cold-seed, which reads it as a FILE
                    // and caps at 5 entries -- apra-fleet's own bible holds 17,
                    // so a sprint could see at most 5 arbitrary ones and FTS
                    // could rank none of them, because they were never rows.
                    // Importing first is what gives the per-dispatch kb_query
                    // (see relevantKnowledge) anything to match against.
                    // Idempotent by id, and best-effort: a repo with no bible,
                    // or an import that rejects every entry, must not stop the
                    // prime it was meant to feed.
                    //
                    // skip_sweep IS LOAD-BEARING (audit 2026-08-12, caught by a
                    // live sprint). kb_import's post-import freshnessSweep
                    // re-judges the ENTIRE KB against this member's worktree. At
                    // sprint start that staled 16 of 17 CONFIRMED entries purely
                    // because the repo had moved on since capture, and the
                    // damage cascaded: retrieval fell to one matchable entry,
                    // the whole-bible publish attempted a 17 -> 9 truncation, and
                    // kb_list (stale=0) returned an EMPTY promotion candidate
                    // list -- reinstating apra-fleet-0ef, "kb_promote can never
                    // fire". This import exists to WARM the KB, never to audit
                    // it; prime()'s own bounded checkFreshness still guards each
                    // entry it actually returns.
                    try {
                        // No `path`: the member session imports its OWN folder's
                        // committed bible (<work folder>/.fleet/kb-canonical.json).
                        const imported = parseResult(await memberCall(target, 'kb_import', { skip_sweep: true }));
                        if (imported && typeof imported.imported === 'number' && imported.imported > 0) {
                            log(`[kb-prime] imported ${imported.imported} bible entr(ies) into the warm KB for '${member}'`);
                        }
                    } catch (err) {
                        log(`[kb-prime] kb_import skipped for '${member}' (non-fatal): ${err.message}`);
                    }

                    const primeResult = parseResult(await memberCall(target, 'kb_session_prime', {}));
                    // Same injection rule as relevantKnowledge, applied BEFORE the
                    // cap so a prime dominated by INFERRED captures does not
                    // crowd out the CONFIRMED entries behind them.
                    const entries = (primeResult && Array.isArray(primeResult.top_entries))
                        ? primeResult.top_entries.filter((e) => typeof e?.id === 'string' && isInjectableKbEntry(e))
                        : [];
                    const capped = entries.slice(0, KB_MAX_KNOWLEDGE_ENTRIES);
                    primedByTarget.set(target.id, capped);
                    if (capped.length > 0) knowledge.set(member, capped);
                    primed++;
                } catch (err) {
                    log(`[kb-prime] failed for member '${member}' (non-fatal): ${err.message}`);
                    skipped++;
                }
            }
            if (primed > 0) log(`[kb-prime] primed ${primed} member repo(s)`);
            return { primed, skipped };
        },
    };
}

/**
 * apra-fleet-0ef / apra-fleet-nx7: the "KNOWLEDGE BANK -- promotion candidates"
 * block, shared verbatim by the per-round reviewer prompt and the Final Review
 * prompt.
 *
 * It lives in one function because the two prompts must state the SAME evidence
 * bar. Duplicating the text invites them to drift, and a drifted bar is
 * invisible: both sides would still "work", just to different standards, and the
 * only symptom would be inconsistent CONFIRMED quality months later.
 *
 * Returns a single-element array (or an empty one) so callers can spread it into
 * their prompt-section list.
 *
 * @param {object[]|undefined} kbCandidates
 * @returns {string[]}
 */
/**
 * KB audit 2026-08-11: the "KNOWLEDGE BANK -- what this repo already knows"
 * block, shared by the doer and reviewer dispatch prompts.
 *
 * WHY THIS EXISTS AT ALL. Every role contract's Step 0 tells the role to call
 * kb_session_prime itself. On a fleet-member dispatch it cannot: the member's
 * composed permission config disables the apra-fleet MCP server outright
 * (src/providers/claude.ts composePermissionConfig), so the tool is not merely
 * unlisted, it is unreachable. That is the same wall kb_promotions hit, and
 * this is the same fix -- the engine performs the read and hands the result
 * over as prompt content. Step 0 stays correct for the OTHER execution path
 * (an apra-pm orchestrator session running these contracts as local subagents,
 * where the MCP server is present), so both paths now get knowledge.
 *
 * Only CONFIRMED, undisputed entries are rendered (isInjectableKbEntry) --
 * every caller's source is already filtered, and this is the last chokepoint
 * before the prompt. CONFIRMED means a reviewer verified the claim when it was
 * captured, not that it is currently true of this branch's tree, which is why
 * the header still tells the role the code wins.
 *
 * Returns a single-element array (or an empty one) so callers can spread it
 * into their prompt-section list, matching kbPromotionBlock.
 *
 * @param {object[]|undefined} entries
 * @returns {string[]}
 */
/**
 * Roles whose prompt BUILDER places the knowledge block itself, at a position
 * that carries meaning. Everything else receives it from the agent() wrapper.
 * Listing them here (rather than inside the wrapper) keeps the two halves of
 * that split visible from the block's own definition -- a role added to one
 * side and forgotten on the other either gets the block twice or never.
 */
export const KB_SELF_INJECTING_ROLES = Object.freeze(new Set([ROLE_DOER, ROLE_REVIEWER]));

/**
 * FTS terms for a dispatch's kb_query, drawn from what the engine already
 * holds: the beads being worked and their ids.
 *
 * Bead TITLES are the useful half -- they are prose about the change ("stop
 * collapsing unknown_zone into unbound_roi"), which is what matches an entry's
 * title/summary/content. Ids are included because a bead id occasionally
 * appears verbatim in a captured entry, and query() OR-joins its terms, so a
 * term that matches nothing costs a little ranking noise rather than filtering
 * the result to empty. Non-string and blank values are dropped so a partially
 * populated bead cannot produce a malformed query.
 *
 * @param {Array<{id?: string, title?: string}>} beads
 * @param {string[]} beadIds
 * @returns {string[]}
 */
export function kbQueryTerms(beads, beadIds) {
    // Bead TITLES only: tracker ids and stopwords are stripped (they match
    // nothing useful and only add ranking noise), so a bead id in `beadIds`
    // never reaches the query -- it is passed solely so a stray id inside a
    // title is recognised and dropped too.
    const titles = [];
    for (const b of Array.isArray(beads) ? beads : []) {
        if (b && typeof b.title === 'string' && b.title.trim()) titles.push(b.title.trim());
    }
    const knownIds = (Array.isArray(beadIds) ? beadIds : []).filter((id) => typeof id === 'string' && id.trim());
    return cleanQueryTerms(titles, { knownIds });
}

// `captureChannel` (default true, the doer/reviewer/final-review prompt
// builders' case) says whether the recipient's returned `kb_captures` field is
// actually applied by the engine (a 'kb-apply' postResult step -- see
// role-policies.mjs agentTypeAppliesKbCaptures). When it is not, the block
// must not promise that the orchestrator records a capture: those roles'
// prompts tell them to note the finding in their own report instead.
export function kbKnowledgeBlock(entries, { captureChannel = true, source = 'prime', reportEmpty = false } = {}) {
    if (!Array.isArray(entries)) return [];
    // CONFIRMED-first, capped at KB_MAX_KNOWLEDGE_ENTRIES. The sources
    // (relevantKnowledge, primeAll) hand entries over in relevance order, so a
    // stable CONFIRMED filter + slice keeps the most relevant ones.
    const injectable = entries.filter(isInjectableKbEntry).slice(0, KB_MAX_KNOWLEDGE_ENTRIES);
    // The label names where the entries really came from: a per-dispatch
    // kb_query or the hint-driven kb_session_prime.
    const label = source === 'query' ? 'kb_query --top_entries' : 'kb_session_prime --top_entries';
    const captureLine = captureChannel
        ? 'If you discover something non-obvious and durable while working, report it in the '
            + '`kb_captures` field of your structured output and the orchestrator will record it.\n'
        : 'If you discover something non-obvious and durable while working, note it in your '
            + 'own report.\n';
    if (injectable.length === 0) {
        if (!reportEmpty) return [];
        // Nothing relevant matched: say so explicitly rather than falling back
        // to an arbitrary set of entries.
        return [
            'KNOWLEDGE BANK -- what this repo already knows. No relevant CONFIRMED knowledge-bank '
            + 'entries were found for this task (source: ' + (source === 'query' ? 'kb_query' : 'kb_session_prime') + '). '
            + 'Nothing relevant was found, so no entries are provided; proceed from the code itself.\n'
            + captureLine,
        ];
    }
    return [
        'KNOWLEDGE BANK -- what this repo already knows. These entries were captured during '
        + 'earlier work on this repository and are provided so you do not rediscover them the '
        + 'hard way. Read them BEFORE you start.\n'
        + 'Only CONFIRMED entries are included: a reviewer promoted each claim on evidence when '
        + 'it was captured. An entry describes the tree it was captured against, so if one '
        + 'contradicts what you actually observe in the code right now, the code wins -- say so '
        + 'in your notes rather than bending your work to fit the entry.\n'
        + 'You do not need a kb_* tool to read these entries; they do not replace any kb_* lookup '
        + 'your role instructions call for. '
        + captureLine
        + wrapUntrustedBlock(label, JSON.stringify(
            injectable.map((e) => ({
                confidence: e.confidence,
                title: e.title,
                summary: e.summary,
                source_files: e.source_files,
            })),
            null,
            2
        )),
    ];
}

/**
 * KNOWLEDGE BANK -- demotion candidates. Same bounded shape as
 * kbPromotionBlock (list the offered ids with enough context to judge, say
 * nothing when the list is empty) -- the two are read side by side in the
 * reviewer prompt and must not drift.
 *
 * Demotion is CONFIRMED -> INFERRED only, and only for an id actually
 * offered here (the engine refuses any other id, same as promotion/discard).
 * The ONE case this is for: the entry's basis is UNCHANGED but a re-check
 * during this review shows the claim no longer holds. A drifted or removed
 * basis is NOT a demote case -- the freshness sweep and the bible basis
 * predicate already handle that without reviewer judgment.
 *
 * @param {object[]|undefined} kbCandidates
 * @returns {string[]}
 */
export function kbDemotionBlock(kbCandidates) {
    if (!Array.isArray(kbCandidates) || kbCandidates.length === 0) return [];
    return [
        'KNOWLEDGE BANK -- demotion candidates. These entries are currently CONFIRMED. You are '
        + 'the only role that can demote one back to INFERRED for a fresh look. Do NOT call any '
        + 'kb_* tool yourself: return your decisions in your structured output and the '
        + 'orchestrator executes them -- `kb_demotions` as [{id, reason, evidence_files?}] for '
        + 'entries to demote back to INFERRED.\n'
        + 'Demote ONLY the one case this is for: the entry\'s basis is UNCHANGED but a re-check '
        + 'during THIS review shows the claim no longer holds -- you checked the same files/tests '
        + 'the entry already cites and the claim does not hold up. This is NOT the route for a '
        + 'drifted or removed basis (the cited code changed or vanished) -- freshness staling and '
        + 'the bible basis predicate already handle that case without you.\n'
        + 'Routing when an entry looks wrong: if you are merely LESS CERTAIN than CONFIRMED '
        + 'demands, demote it here (`kb_demotions`). If you have PROVEN it wrong, that is '
        + 'different work entirely, handled outside this role -- leave it alone and say so in '
        + 'your notes; you have no tool for that. Discarding an unconfirmed (INFERRED) capture '
        + 'you showed to be wrong is `kb_discards` (Step 5), never a demotion -- demotion only '
        + 'ever applies to an already-CONFIRMED entry.\n'
        + 'The `reason` must state what you checked this review that contradicts the claim '
        + '(at least 20 characters, e.g. "re-ran the reopen test cited by this entry and it now '
        + 'fails"). Demoting nothing is a valid outcome; return [] in that case. Never list the '
        + 'same id in more than one of `kb_promotions`, `kb_discards` and `kb_demotions`; the '
        + 'orchestrator refuses it in every list it appears in.\n'
        + wrapUntrustedBlock('kb_query --tag member:<maintainer> --confidence CONFIRMED', JSON.stringify(
            kbCandidates.map((e) => ({
                id: e.id,
                title: e.title,
                summary: e.summary,
                source_files: e.source_files,
            })),
            null,
            2
        )),
    ];
}

export function kbPromotionBlock(kbCandidates) {
    if (!Array.isArray(kbCandidates) || kbCandidates.length === 0) return [];
    return [
        'KNOWLEDGE BANK -- promotion candidates. These entries were captured during this '
        + 'sprint and sit at INFERRED. You are the only role that can promote them to '
        + 'CONFIRMED, or discard them. Do NOT call any kb_* tool yourself: return your '
        + 'decisions in your structured output and the orchestrator executes them -- '
        + '`kb_promotions` as [{id, reason}] for entries to CONFIRM, `kb_discards` as '
        + '[{id, reason}] for entries to DISCARD.\n'
        + 'Promote ONLY entries whose claim you independently verified during THIS review '
        + '-- by reading the diff, running the tests, or checking the cited files yourself. '
        + 'The `reason` must state that evidence (at least 20 characters, e.g. "verified '
        + 'against server/transit.js:88 and the reopen test"). Evidence, not plausibility: '
        + 'if an entry merely looks correct, leave it INFERRED -- that is a perfectly good '
        + 'resting state, and a wrong CONFIRMED entry is worse than no entry. Never '
        + 'blanket-promote, and never promote by module, tag or timestamp. Promoting '
        + 'nothing is a valid outcome; return [] in that case.\n'
        + 'Discard ONLY entries you showed to be WRONG during this review, with the same '
        + 'evidence bar: the `reason` states what you checked that contradicts the claim. '
        + 'A discarded entry drops out of every later read. An entry you cannot confirm '
        + 'is not thereby wrong -- leave it INFERRED. Never list the same id in both '
        + 'fields; the orchestrator refuses both.\n'
        + wrapUntrustedBlock('kb_query --tag member:<maintainer> --confidence INFERRED', JSON.stringify(
            kbCandidates.map((e) => ({
                id: e.id,
                title: e.title,
                summary: e.summary,
                source_files: e.source_files,
            })),
            null,
            2
        )),
    ];
}
