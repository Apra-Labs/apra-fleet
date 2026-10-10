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
import { E_MEMBER_FLEET_TOO_OLD } from './member-call.mjs';

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

    // One output may not both CONFIRM and DISCARD the same entry: the two
    // judgements contradict each other, so neither is executed and both sides
    // are logged.
    const discardIds = new Set(discards.map((d) => d.id));
    const conflicted = new Set(promotions.filter((p) => discardIds.has(p.id)).map((p) => p.id));
    for (const p of promotions) {
        if (conflicted.has(p.id)) refused.push(`${role}: promotion ${p.id} refused -- the same output also discards it (promote reason: ${p.reason})`);
    }
    for (const d of discards) {
        if (conflicted.has(d.id)) refused.push(`${role}: discard ${d.id} refused -- the same output also promotes it (discard reason: ${d.reason})`);
    }

    return {
        captures,
        promotions: promotions.filter((p) => !conflicted.has(p.id)),
        discards: discards.filter((d) => !conflicted.has(d.id)),
        refused,
    };
}

/** Max promotion candidates offered to one reviewer, so the prompt stays bounded. */
export const KB_MAX_PROMOTION_CANDIDATES = 40;

/** Display label for a member record in log lines. */
function memberLabel(member) {
    return (member && (member.name || member.id)) || 'unknown member';
}

/** The committed bible, relative to the maintainer's checkout root. */
const BIBLE_FILE = '.fleet/kb-canonical.json';

/**
 * kb_bible_commit skip reasons the engine keeps queued: the cause can clear on
 * its own (uncommitted edits, entries captured against commits the maintainer
 * has not pulled yet), so the id is offered again at the next round. Every
 * other reason (not_confirmed_or_unknown, no_source_files, or one this engine
 * does not know) cannot change by retrying and drops the id.
 */
const KB_RETRYABLE_SKIP_REASONS = Object.freeze(new Set(['basis_mismatch']));

/**
 * How many bible-commit rounds in a row an id may be skipped with a retryable
 * reason before it is dropped with a WARN, so a permanently drifted entry
 * cannot sit in the queue forever.
 */
export const KB_BIBLE_SKIP_RETRY_ROUNDS = 3;

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
 *   - apply() vets a role's kb_captures / kb_promotions, then QUEUES them per
 *     repository and flushes that repository's queue.
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
 * remembered per repository as a CONFIRMATION awaiting the bible. After each
 * review round (reviewer, final reviewer, harvester) the engine calls
 * commitRound(), which per repository with confirmations runs, on the
 * maintainer: G-pull, kb_bible_commit {ids, baseBranch, baseCommit}, G-push.
 * baseBranch is the sprint's TARGET BASE branch and baseCommit the base
 * commit the entries were verified against (opts.bibleBase resolves both on
 * the maintainer). A rejected G-push is retried exactly once: abort any
 * in-progress rebase, G-pull onto the new remote tip, kb_bible_commit again
 * with the same ids (it merges at entry level, so the concurrent change's
 * entries survive with no manual merge) and G-push again. A second failure
 * keeps the ids queued for the next round with a WARN. When kb_bible_commit
 * commits nothing (committed:false) the ids leave the queue only once origin
 * is shown to hold the bible (opts.bibleUnpushed): an earlier round's bible
 * commit still unpushed on the maintainer is G-pushed (same retry and reset
 * guards), and an undecidable check keeps the ids queued with a WARN. After
 * seal() (a FAIL verdict or an aborted sprint) nothing further is committed.
 * An id kb_bible_commit skips with basis_mismatch stays queued and is offered
 * again next round (the mismatch can be transient), for at most
 * opts.bibleSkipRetryRounds (default KB_BIBLE_SKIP_RETRY_ROUNDS) skipped
 * rounds in a row, then is dropped with a WARN naming it and the reason; any
 * other skip reason drops the id at once.
 *
 * @param {{
 *   memberCall?: (member: object, name: string, args: object, opts?: { kbMaintainer?: boolean }) => Promise<any>,
 *   maintainers?: object|(() => object),
 *   gPull?: (memberName: string, options?: { resetToRemoteTip?: boolean }) => Promise<any>,
 *   gPush?: (memberName: string) => Promise<any>,
 *   abortRebase?: (memberName: string) => Promise<any>,
 *   bibleBase?: (memberName: string) => Promise<{ baseBranch: string, baseCommit: string }|null>,
 *   canResetCheckout?: (memberName: string, bibleFile: string) => Promise<{ safe: boolean, reason?: string }>,
 *   checkedOutBranch?: (memberName: string) => Promise<{ branch: string|null, sprintBranch: string|null }>,
 *   bibleUnpushed?: (memberName: string, bibleFile: string) => Promise<{ unpushed: boolean|null, reason?: string }>,
 *   unpushedOnlyBible?: (memberName: string, bibleFile: string) => Promise<{ onlyBible: boolean, reason?: string }>,
 *   sprintStartMs?: number|(() => number),
 *   bibleSkipRetryRounds?: number,
 *   log?: Function,
 * }} opts
 */
/**
 * memberCall options for a call made AS a repository's kb_maintainer: the
 * session carries the kb_maintainer grant, so the server also serves it
 * kb_promote, kb_resolve_contradiction and kb_reconcile_prefilter (see
 * member-call.mjs).
 */
export const KB_MAINTAINER_CALL = Object.freeze({ kbMaintainer: true });

export function createKbWorkClient(opts = {}) {
    const { memberCall, gPull, gPush, abortRebase, bibleBase, canResetCheckout, checkedOutBranch, bibleUnpushed, unpushedOnlyBible, log = () => {} } = opts;
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
    /** repo -> tail of the serialized flush chain for that repository. */
    const flushChains = new Map();
    /** member name -> open dispatch count (nested brackets count once each). */
    const busy = new Map();
    /** member name -> the write currently in flight to it, if any. */
    const inFlight = new Map();
    /** repo -> ids the maintainer CONFIRMED that are not yet in a pushed bible commit (insertion order). */
    const confirmations = new Map();
    /** repo -> (id -> rounds in a row kb_bible_commit skipped it with a retryable reason). */
    const skipRounds = new Map();
    const skipRetryRounds = Number.isInteger(opts.bibleSkipRetryRounds) && opts.bibleSkipRetryRounds > 0
        ? opts.bibleSkipRetryRounds
        : KB_BIBLE_SKIP_RETRY_ROUNDS;
    /**
     * Repositories whose maintainer may hold bible retirements not yet in a
     * bible commit: a kb_invalidate discard was applied there since the last
     * successful kb_bible_commit. kb_bible_commit removes superseded and
     * invalidated entries at every call, so such a repository gets a call
     * (with ids [] when nothing is confirmed) even in a round that promoted
     * nothing.
     */
    const retirements = new Set();
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

    const zeroCounts = () => ({ captured: 0, promoted: 0, discarded: 0 });

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
            // AS the kb_maintainer: the grant is what lets the session see
            // kb_promote (no other member session is served it).
            const call = memberCall(target.record, spec.tool, spec.args(op.payload), KB_MAINTAINER_CALL);
            inFlight.set(maintainer, call.then(() => {}, () => {}));
            let res;
            try {
                res = await call;
            } catch (err) {
                if (err && err.code === E_MEMBER_FLEET_TOO_OLD) {
                    // The maintainer's install cannot open the kb_maintainer
                    // grant: nothing in this batch can land until it is
                    // upgraded, so all of it stays queued.
                    queue.unshift(...batch.slice(i));
                    log(`[kb-work] WARNING: maintainer '${maintainer}' cannot run ${spec.tool}: ${err.message} -- ${batch.length - i} KB write(s) for ${repo} stay queued`);
                    break;
                }
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
            if (op.kind === 'discard') retirements.add(repo);
            if (op.kind === 'promote') {
                if (!confirmations.has(repo)) confirmations.set(repo, new Set());
                confirmations.get(repo).add(op.payload.id);
            }
        }
        if (counts.captured || counts.promoted || counts.discarded) {
            log(`[kb-work] maintainer '${maintainer}' (${repo}): captured ${counts.captured}, promoted ${counts.promoted}, discarded ${counts.discarded}`);
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
     * What a bible commit carries, for its log lines: the confirmations, or
     * -- for a removal-only call (ids []) -- the pending bible removals.
     */
    const bibleLoad = (ids) => (ids.length > 0 ? `${ids.length} confirmation(s)` : 'the pending bible removal(s)');
    /** onSprintBranch for a bible commit carrying `ids` (see bibleLoad). */
    const bibleOnSprintBranch = (maintainer, repo, ids) => (ids.length > 0
        ? onSprintBranch(maintainer, repo, ids.length)
        : onSprintBranch(maintainer, repo, 'the', 'pending bible removal'));

    /**
     * One kb_bible_commit attempt on the maintainer: G-pull, resolve the
     * base, kb_bible_commit, then G-push when a commit was made. Returns
     * { ok: true, result } or { ok: false, stage, error } -- never throws.
     * `resetToRemoteTip` is the retry's G-pull: after a rejected push the
     * maintainer holds a local bible commit the remote tip does not, so a
     * fast-forward pull would fail by construction; kb_bible_commit re-merges
     * the same ids at entry level on top of the new tip instead.
     */
    async function bibleAttempt(target, repo, ids, { resetToRemoteTip = false } = {}) {
        const maintainer = target.member;
        if (!(await bibleOnSprintBranch(maintainer, repo, ids))) return { ok: false, stage: 'branch check', error: 'the maintainer is not on the sprint branch', branchBlocked: true };
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
        if (!(await bibleOnSprintBranch(maintainer, repo, ids))) return { ok: false, stage: 'branch check', error: 'the maintainer is not on the sprint branch', branchBlocked: true };
        let res;
        try {
            res = await memberCall(target.record, 'kb_bible_commit', { ids, baseBranch: base.baseBranch, baseCommit: base.baseCommit }, KB_MAINTAINER_CALL);
        } catch (err) {
            return { ok: false, stage: 'kb_bible_commit', error: errText(err), fleetTooOld: !!(err && err.code === E_MEMBER_FLEET_TOO_OLD) };
        }
        if (isToolError(res)) return { ok: false, stage: 'kb_bible_commit', error: toolErrorText(res) };
        const result = parseResult(res) || {};
        // The tool skipped the whole call (e.g. the project KB is remote and has
        // no bible to commit to): nothing was committed, so there is nothing to
        // check or push. Return before the publication check and the G-push.
        if (result.bible_skipped === true) return { ok: true, result, pushed: false, bibleSkipped: true };
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
        if (!(await bibleOnSprintBranch(maintainer, repo, ids))) return { ok: false, stage: 'branch check', error: 'the maintainer is not on the sprint branch', branchBlocked: true };
        // A bible push must publish the bible commit(s) only: never a doer
        // commit that sits unpushed underneath them. Without an injected
        // probe the push is allowed.
        if (typeof unpushedOnlyBible === 'function') {
            let verdict;
            try { verdict = await unpushedOnlyBible(maintainer, BIBLE_FILE); } catch (err) { verdict = { onlyBible: false, reason: errText(err) }; }
            if (!verdict || verdict.onlyBible !== true) {
                log(`[kb-work] WARN: not pushing the bible commit from maintainer '${maintainer}' (${repo}): ${(verdict && verdict.reason) || 'unknown'} -- a bible push must not publish other commits; ${bibleLoad(ids)} stay queued for the next round`);
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
     * Commit one repository's pending confirmations to the bible on its
     * maintainer. Never throws; ids that do not reach a pushed commit stay
     * pending for the next round.
     * @returns {Promise<{ committed: number, pending: number }>}
     */
    async function commitRepo(repo) {
        const pending = confirmations.get(repo) || new Set();
        // No confirmations and no retirements: no call at all (no member
        // traffic). Retirements alone make a removal-only call with ids [].
        if (pending.size === 0 && !retirements.has(repo)) return { committed: 0, pending: 0 };
        const ids = [...pending];
        const load = bibleLoad(ids);
        if (sealedReason) return { committed: 0, pending: ids.length };
        const sel = selector();
        const target = sel && typeof sel.getKbMaintainer === 'function' ? sel.getKbMaintainer(repo) : null;
        if (!target || !target.record) {
            log(`[kb-work] WARN: repository ${repo} has no kb_maintainer -- ${load} stay queued for the bible`);
            return { committed: 0, pending: ids.length };
        }
        const maintainer = target.member;
        if (typeof gPull !== 'function' || typeof gPush !== 'function' || typeof bibleBase !== 'function') {
            log(`[kb-work] WARN: no git sync wired for the bible commit -- ${load} for ${repo} stay queued`);
            return { committed: 0, pending: ids.length };
        }
        if (isBusy(maintainer)) {
            log(`[kb-work] WARN: maintainer '${maintainer}' is mid-dispatch -- ${load} for ${repo} stay queued for the next round's bible commit`);
            return { committed: 0, pending: ids.length };
        }
        let release;
        inFlight.set(maintainer, new Promise((r) => { release = r; }));
        try {
            let outcome = await bibleAttempt(target, repo, ids);
            if (!outcome.ok && outcome.stage === 'G-push') {
                log(`[kb-work] G-push of the bible commit on maintainer '${maintainer}' (${repo}) was rejected (${outcome.error}) -- retrying once: rebase --abort, G-pull, kb_bible_commit, G-push`);
                if (typeof abortRebase === 'function' && (await bibleOnSprintBranch(maintainer, repo, ids))) {
                    try { await abortRebase(maintainer); } catch (err) { log(`[kb-work] rebase --abort on maintainer '${maintainer}' failed (non-fatal): ${errText(err)}`); }
                }
                // The reset throws away the maintainer's local-only commits and
                // uncommitted changes; it is usually also a doer, so only reset
                // when that is the bible commit alone.
                if (!(await bibleOnSprintBranch(maintainer, repo, ids))) return { committed: 0, pending: ids.length };
                if (!(await resetIsSafe(maintainer, repo))) return { committed: 0, pending: ids.length };
                outcome = await bibleAttempt(target, repo, ids, { resetToRemoteTip: true });
                if (!outcome.ok && (outcome.stage === 'G-push' || outcome.stage === 'kb_bible_commit')) {
                    // Leave the checkout on the remote tip: an unpushed bible
                    // commit would make the maintainer's next fast-forward
                    // G-pull fail. The ids stay queued and are re-merged by
                    // the next round's kb_bible_commit.
                    if (typeof abortRebase === 'function' && !outcome.branchBlocked && (await bibleOnSprintBranch(maintainer, repo, ids))) {
                        try { await abortRebase(maintainer); } catch { /* best-effort */ }
                    }
                    try { if ((await bibleOnSprintBranch(maintainer, repo, ids)) && (await resetIsSafe(maintainer, repo))) await gPull(maintainer, { resetToRemoteTip: true }); } catch (err) {
                        log(`[kb-work] WARN: could not reset maintainer '${maintainer}' onto the remote tip after the failed bible commit: ${errText(err)}`);
                    }
                }
            }
            if (!outcome.ok && outcome.branchBlocked) return { committed: 0, pending: ids.length };
            if (!outcome.ok && outcome.fleetTooOld) {
                log(`[kb-work] WARNING: bible commit for ${repo} cannot run on maintainer '${maintainer}': ${outcome.error} -- ${load} stay queued for the next round`);
                return { committed: 0, pending: ids.length };
            }
            if (!outcome.ok) {
                log(`[kb-work] WARN: bible commit for ${repo} on maintainer '${maintainer}' failed at ${outcome.stage} (${outcome.error}) -- ${load} stay queued for the next round`);
                return { committed: 0, pending: ids.length };
            }
            if (outcome.bibleSkipped) {
                // The skip is provider-wide, so a retry cannot succeed: drop the
                // repo's queue state (as for any non-retryable skip) so later
                // rounds do not repeat the call or warn about pending ids.
                const reason = typeof outcome.result.reason === 'string' && outcome.result.reason ? outcome.result.reason : 'no reason given';
                confirmations.delete(repo);
                skipRounds.delete(repo);
                retirements.delete(repo);
                log(`[kb-work] kb_bible_commit skipped for ${repo} on maintainer '${maintainer}': ${reason} -- ${ids.length} confirmation(s) dropped from the bible queue.`);
                return { committed: 0, pending: 0 };
            }
            // The call succeeded: whatever retirements the maintainer held were
            // removed by it (kb_bible_commit drops them at every call).
            retirements.delete(repo);
            const skipped = Array.isArray(outcome.result.skipped) ? outcome.result.skipped : [];
            // A skip whose cause can clear on its own (basis_mismatch: the cited
            // files at the maintainer's HEAD differ from the recorded basis, e.g.
            // the entry was captured against commits not pulled yet) stays queued
            // and is offered again next round, for a bounded number of rounds.
            // Any other skip (not CONFIRMED or unknown, no source files) cannot
            // change by retrying and leaves the queue. Merged ids leave it too.
            if (!skipRounds.has(repo)) skipRounds.set(repo, new Map());
            const rounds = skipRounds.get(repo);
            const retained = [];
            const dropped = [];
            const exhausted = [];
            for (const x of skipped) {
                if (!x || typeof x.id !== 'string') continue;
                if (!KB_RETRYABLE_SKIP_REASONS.has(x.reason)) { dropped.push(x); continue; }
                const n = (rounds.get(x.id) || 0) + 1;
                if (n >= skipRetryRounds) { exhausted.push({ ...x, rounds: n }); continue; }
                rounds.set(x.id, n);
                retained.push(x);
            }
            const keep = new Set(retained.map((x) => x.id));
            for (const id of ids) {
                if (keep.has(id)) continue;
                pending.delete(id);
                rounds.delete(id);
            }
            if (pending.size === 0) confirmations.delete(repo);
            if (rounds.size === 0) skipRounds.delete(repo);
            const merged = Array.isArray(outcome.result.merged) ? outcome.result.merged.length : ids.length - skipped.length;
            const describe = (list) => list.map((x) => (x.reason ? `${x.id} (${x.reason})` : x.id)).join(', ');
            if (dropped.length > 0) {
                log(`[kb-work] kb_bible_commit skipped ${dropped.length} id(s) for ${repo} that cannot succeed on a retry (dropped from the queue, with the reason the tool returned): ${describe(dropped)}`);
            }
            if (retained.length > 0) {
                log(`[kb-work] kb_bible_commit skipped ${retained.length} id(s) for ${repo} for a reason that can clear (kept queued for the next round, at most ${skipRetryRounds} skipped rounds in a row): ${describe(retained)}`);
            }
            for (const x of exhausted) {
                log(`[kb-work] WARN: dropping ${x.id} from the bible queue for ${repo}: kb_bible_commit skipped it with reason ${x.reason || 'unknown'} for ${x.rounds} round(s) in a row`);
            }
            // Bible entries the maintainer KB holds as superseded or invalidated
            // are removed by the tool at every call; name each one here so the
            // removal is visible in the run log, not only in the commit message.
            const removed = Array.isArray(outcome.result.removed) ? outcome.result.removed.filter((x) => x && typeof x.id === 'string') : [];
            if (removed.length > 0) {
                log(`[kb-work] kb_bible_commit removed ${removed.length} superseded/invalidated entry(ies) from the bible for ${repo}: ${describe(removed)}`);
            }
            if (ids.length === 0) {
                log(`[kb-work] removal-only bible commit for ${repo} on maintainer '${maintainer}': ${outcome.pushed ? `${removed.length} removal(s) committed and pushed` : 'nothing to remove -- nothing to push'}`);
            } else {
                log(`[kb-work] bible commit for ${repo} on maintainer '${maintainer}': ${merged} confirmation(s) ${outcome.pushed ? 'committed and pushed' : 'already in the bible -- nothing to push'}`);
            }
            return { committed: outcome.pushed ? merged : 0, pending: pending.size };
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
        /** Log a WARN for every repository that still has queued writes or confirmations. */
        warnPending() {
            for (const [repo, q] of queues) {
                if (q.length > 0) log(`[kb-work] WARN: ${q.length} KB write(s) for ${repo} are still queued (maintainer busy or unreachable) -- not applied`);
            }
            for (const [repo, ids] of confirmations) {
                if (ids.size > 0) log(`[kb-work] WARN: ${ids.size} confirmation(s) for ${repo} are not in a pushed bible commit${sealedReason ? ` (bible commits sealed: ${sealedReason})` : ''}`);
            }
            for (const repo of retirements) {
                if (!confirmations.has(repo)) log(`[kb-work] WARN: the pending bible removal(s) for ${repo} are not in a pushed bible commit${sealedReason ? ` (bible commits sealed: ${sealedReason})` : ''}`);
            }
        },
        /**
         * The review-round bible commit: apply whatever is still queued, then
         * for every repository with confirmations, on its maintainer: G-pull,
         * kb_bible_commit, G-push (see the client header for the retry). A
         * repository with no confirmations but a discard applied since its
         * last bible commit gets a removal-only call (ids []). A round with
         * neither makes no call at all. A no-op once
         * sealed. Never throws.
         * @param {string} [label] the round, for the log
         * @returns {Promise<{ committed: number, pending: number }>}
         */
        async commitRound(label = 'review round') {
            const out = { committed: 0, pending: 0 };
            if (!active) return out;
            if (sealedReason) {
                let n = 0;
                for (const ids of confirmations.values()) n += ids.size;
                if (n > 0) log(`[kb-work] ${label}: bible commits are sealed (${sealedReason}) -- ${n} confirmation(s) not committed`);
                return { committed: 0, pending: n };
            }
            for (const repo of [...queues.keys()]) {
                if (queues.get(repo).length > 0) await flush(repo);
            }
            for (const repo of new Set([...confirmations.keys(), ...retirements])) {
                const r = await serialize(repo, () => commitRepo(repo));
                out.committed += r.committed;
                out.pending += r.pending;
            }
            return out;
        },
        /**
         * Stop every further bible commit: a FAIL verdict or an aborted
         * sprint commits nothing more, and the confirmation queue is not
         * flushed. Idempotent; the first reason wins.
         */
        seal(reason) {
            if (sealedReason) return;
            sealedReason = String(reason || 'sealed');
            let n = 0;
            for (const ids of confirmations.values()) n += ids.size;
            log(`[kb-work] bible commits sealed (${sealedReason})${n > 0 ? ` -- ${n} confirmation(s) will not be committed` : ''}`);
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
                const offered = results
                    // promote() refuses type='user-directive' outright (activation
                    // is human-terminal, CLI-only), so offering one as a candidate
                    // can only produce a guaranteed refusal.
                    .filter((e) => e && typeof e.id === 'string' && e.type !== 'user-directive' && inWindow(e))
                    .slice(0, KB_MAX_PROMOTION_CANDIDATES);
                offeredCandidates.set(target.repo, new Set(offered.map((e) => e.id)));
                return offered;
            } catch (err) {
                log(`[kb-work] could not read promotion candidates from maintainer '${target.member}' (non-fatal): ${err.message}`);
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
         * @returns {Promise<{captured: number, promoted: number, discarded: number, refused: number}>}
         *   counts of the writes applied by this call's flush (writes left
         *   queued for a busy or unreachable maintainer are not counted).
         */
        async apply(role, member, result) {
            const { captures, promotions, discards, refused } = vetKbWork(role, result);

            for (const r of refused) log(`[kb-work] refused -- ${r}`);
            // Log every promotion with its stated evidence BEFORE attempting it.
            // This log is the audit trail the bible never had.
            for (const p of promotions) log(`[kb-work] promote ${p.id} (${role}): ${p.reason}`);
            for (const d of discards) log(`[kb-work] discard ${d.id} (${role}): ${d.reason}`);

            let extraRefused = 0;
            const done = (counts) => ({ ...counts, refused: refused.length + extraRefused });
            if (captures.length === 0 && promotions.length === 0 && discards.length === 0) return done(zeroCounts());
            const dropped = `${captures.length} capture(s), ${promotions.length} promotion(s) and ${discards.length} discard(s) dropped`;

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
            // dropped. Review judgements (CONFIRM/DISCARD) act on candidates
            // read from the reviewer's maintainer (reviewMaintainerFor), so
            // they follow the same resolution as the candidate read.
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
            if (promotions.length > 0 || discards.length > 0) {
                const review = reviewMaintainerFor(producer);
                if (review) {
                    // Only ids offered in this dispatch's candidate block may be
                    // judged; anything else is refused before any kb_* call.
                    const offered = offeredCandidates.get(review.repo) || new Set();
                    const inBlock = (kind, x) => {
                        if (offered.has(x.id)) return true;
                        log(`[kb-work] refused -- ${role}: ${kind} ${x.id} not in this dispatch's candidate block`);
                        extraRefused += 1;
                        return false;
                    };
                    for (const p of promotions) if (inBlock('promotion', p)) enqueue(review.repo, 'promote', role, p);
                    for (const d of discards) if (inBlock('discard', d)) enqueue(review.repo, 'discard', role, d);
                    repos.add(review.repo);
                } else {
                    log(`[kb-work] WARN: no kb_maintainer for member '${producer}' (${role}) -- ${promotions.length} promotion(s) and ${discards.length} discard(s) dropped`);
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
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, memberCall?: (member: object, name: string, args: object) => Promise<any>, members?: string[], maintainers?: object|Function, baseBranch?: string, log?: Function }} opts
 * @returns {{ primeAll: () => Promise<{primed: number, skipped: number}> }}
 */

export function createKbPrimingClient(opts = {}) {
    const { callTool, memberCall, members = [], log = () => {} } = opts;
    // A plain branch name only (it becomes refs/remotes/origin/<base>).
    const baseBranch = (typeof opts.baseBranch === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(opts.baseBranch) && !opts.baseBranch.includes('..'))
        ? opts.baseBranch : null;
    const maintainerSel = () => {
        const m = typeof opts.maintainers === 'function' ? opts.maintainers() : opts.maintainers;
        return (m && typeof m.maintainerForMember === 'function') ? m : null;
    };
    /**
     * True when `target`'s kb_import accepts `ref`: always for a local member
     * (served by this process); for a remote member only when its tools/list
     * advertises the property. Any doubt (no listTools, an unreadable answer)
     * is false.
     */
    async function supportsImportRef(target) {
        if (String(target && (target.type || target.agentType) || '').toLowerCase() === 'local') return true;
        if (typeof opts.listTools !== 'function') return false;
        try {
            const list = parseResult(await opts.listTools(target));
            const tools = Array.isArray(list) ? list : (list && Array.isArray(list.tools) ? list.tools : []);
            const imp = tools.find((t) => t && t.name === 'kb_import');
            const props = imp && imp.inputSchema && imp.inputSchema.properties;
            return !!(props && typeof props === 'object' && Object.prototype.hasOwnProperty.call(props, 'ref'));
        } catch {
            return false;
        }
    }
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
                    //
                    // The import on a repository's kb_maintainer runs WITH the
                    // kb_maintainer grant. A session without the grant imports
                    // a committed bible only when the maintainer side already
                    // recorded it as trusted in the hub-side KB, so a bible
                    // this hub never saw (a fresh hub, or a bible merged in
                    // from elsewhere) would never land. The grant import is
                    // the trusted seeding path, and the bible it imports is
                    // marked trusted for every member of the repository -- so
                    // it must not come from the maintainer's work tree or
                    // HEAD. Nothing has cleaned that checkout yet: launch
                    // alignment runs only for some launch modes, branch-ensure
                    // runs after priming, and a reused local branch keeps
                    // local-only commits. The grant import therefore reads the
                    // bible committed on the base branch's remote-tracking ref
                    // (full ref name, so a local branch named origin/<base>
                    // cannot shadow it), which the server verifies against its
                    // blob id. No base branch: no grant import. A sprint
                    // without a maintainer selector (unit-test seam) imports
                    // without the grant, which never records trust.
                    try {
                        // No `path`: the session imports its OWN folder's
                        // bible (.fleet/kb-canonical.json), here at `ref`.
                        let imported = null;
                        if (!sel) {
                            imported = parseResult(await memberCall(target, 'kb_import', { skip_sweep: true }));
                        } else if (baseBranch) {
                            const ref = 'refs/remotes/origin/' + baseBranch;
                            // A REMOTE maintainer runs its own apra-fleet: an
                            // older one drops the unknown `ref` key and would
                            // grant-import (and trust) its WORK-TREE bible. Fail
                            // closed: import only when its kb_import advertises
                            // `ref`. A local member runs in this server.
                            if (await supportsImportRef(target)) {
                                imported = parseResult(await memberCall(target, 'kb_import', { skip_sweep: true, ref }, KB_MAINTAINER_CALL));
                                if (imported && imported.bible_source !== ref) {
                                    log(`[kb-prime] WARN kb_import on '${target.name || member}' did not report reading ${ref} (bible_source ${JSON.stringify(imported.bible_source)}) -- upgrade apra-fleet on that member`);
                                }
                            } else {
                                log(`[kb-prime] WARN the apra-fleet on '${target.name || member}' has no kb_import 'ref' (older version) -- bible import skipped; upgrade apra-fleet on that member`);
                            }
                        } else {
                            log(`[kb-prime] no base branch -- bible import skipped for '${member}' (the kb_maintainer imports only the base branch's committed bible)`);
                        }
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
