// KB (Knowledge Bank) work for fleet-sprint: the per-dispatch relevance-ranked read (kb_query), the vetting
// and forwarding of a role's kb_captures/kb_promotions payload (kb_capture/
// kb_promote), the canonical-bible publish (kb_export), the once-per-sprint
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

    return { captures, promotions, refused };
}

/** Max promotion candidates offered to one reviewer, so the prompt stays bounded. */
export const KB_MAX_PROMOTION_CANDIDATES = 40;

/** Display label for a member record in log lines. */
function memberLabel(member) {
    return (member && (member.name || member.id)) || 'unknown member';
}

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
 * @param {{
 *   memberCall?: (member: object, name: string, args: object) => Promise<any>,
 *   maintainers?: object|(() => object),
 *   gPull?: (memberName: string) => Promise<any>,
 *   log?: Function,
 * }} opts
 */
export function createKbWorkClient(opts = {}) {
    const { memberCall, gPull, log = () => {} } = opts;
    const active = typeof memberCall === 'function';

    /** The kb_maintainer selector (createKbMaintainerSelector), or null. */
    function selector() {
        const m = typeof opts.maintainers === 'function' ? opts.maintainers() : opts.maintainers;
        return (m && typeof m.maintainerForMember === 'function') ? m : null;
    }

    /** repo -> queued writes, oldest first: { kind, role, payload }. */
    const queues = new Map();
    /** repo -> tail of the serialized flush chain for that repository. */
    const flushChains = new Map();
    /** member name -> open dispatch count (nested brackets count once each). */
    const busy = new Map();
    /** member name -> the write currently in flight to it, if any. */
    const inFlight = new Map();

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
            try {
                await gPull(maintainer);
            } catch (err) {
                log(`[kb-work] WARN: G-pull on maintainer '${maintainer}' failed (${err && err.message ? err.message : String(err)}) -- maintainer unreachable; ${queue.length} KB write(s) for ${repo} stay queued`);
                return counts;
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
        }
        if (counts.captured || counts.promoted || counts.discarded) {
            log(`[kb-work] maintainer '${maintainer}' (${repo}): captured ${counts.captured}, promoted ${counts.promoted}, discarded ${counts.discarded}`);
        }
        return counts;
    }

    /** Serialize flushes per repository so two never interleave on one queue. */
    function flush(repo) {
        const prev = flushChains.get(repo) || Promise.resolve();
        const next = prev.then(() => flushRepo(repo), () => flushRepo(repo));
        flushChains.set(repo, next.then(() => {}, () => {}));
        return next;
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
        /** Try every repository's queue (e.g. before the canonical-bible export). Never throws. */
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
        /** Log a WARN for every repository that still has queued writes. */
        warnPending() {
            for (const [repo, q] of queues) {
                if (q.length > 0) log(`[kb-work] WARN: ${q.length} KB write(s) for ${repo} are still queued (maintainer busy or unreachable) -- not applied`);
            }
        },
        /** The maintainer member record KB writes from `member` go to, or null. */
        maintainerRecordFor(member) {
            const m = maintainerFor(memberNameOf(member));
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
            // Without a resolved member there is no session to scope kb_list
            // to; refuse rather than read some other KB (the apra-fleet-tm7
            // repo-blindness class).
            if (!active || !member) return [];
            try {
                const parsed = parseResult(await memberCall(member, 'kb_list', {
                    confidence: ['INFERRED'],
                    limit: KB_MAX_PROMOTION_CANDIDATES,
                }));
                const results = parsed && Array.isArray(parsed.results) ? parsed.results : [];
                return results
                    // promote() refuses type='user-directive' outright (activation
                    // is human-terminal, CLI-only), so offering one as a candidate
                    // can only produce a guaranteed refusal.
                    .filter((e) => e && typeof e.id === 'string' && e.type !== 'user-directive')
                    .slice(0, KB_MAX_PROMOTION_CANDIDATES);
            } catch (err) {
                log(`[kb-work] could not list promotion candidates for ${memberLabel(member)} (non-fatal): ${err.message}`);
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
        async relevantKnowledge(member, terms) {
            if (!active || !member || !Array.isArray(terms) || terms.length === 0) return [];
            const query = terms.filter((t) => typeof t === 'string' && t.trim()).join(' ');
            if (!query) return [];
            try {
                const res = await memberCall(member, 'kb_query', {
                    query,
                    limit: KB_MAX_KNOWLEDGE_ENTRIES,
                    expand_related: true,
                    confidence: ['CONFIRMED'],
                    exclude_disputed: true,
                });
                // apra-fleet-23c: an MCP tool call can RESOLVE with {isError:true}
                // for a tool-level failure rather than throwing, so this was
                // the one kb_* failure path in this module that stayed
                // silent -- parseResult() returns null for that envelope,
                // taking the `if (!parsed) return [];` branch below and never
                // reaching the catch. Detect it explicitly so a cold or
                // misconfigured KB degrades visibly, like every other kb_*
                // call here.
                if (isToolError(res)) {
                    log(`[kb-work] kb_query rejected for ${memberLabel(member)} (non-fatal): ${toolErrorText(res)}`);
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
                // Related claims sit BELOW every direct hit and carry a marker,
                // so a role can tell "the KB matched this" from "the KB says
                // something about what it matched".
                for (const e of related) {
                    if (typeof e?.id !== 'string' || !isInjectableKbEntry(e) || seen.has(e.id)) continue;
                    seen.add(e.id);
                    out.push({ ...e, via: 'kb-graph' });
                }
                return out.slice(0, KB_MAX_KNOWLEDGE_ENTRIES);
            } catch (err) {
                log(`[kb-work] kb_query failed for ${memberLabel(member)} (non-fatal): ${err.message}`);
                return [];
            }
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
            const { captures, promotions, refused } = vetKbWork(role, result);

            for (const r of refused) log(`[kb-work] refused -- ${r}`);
            // Log every promotion with its stated evidence BEFORE attempting it.
            // This log is the audit trail the bible never had.
            for (const p of promotions) log(`[kb-work] promote ${p.id} (${role}): ${p.reason}`);

            const done = (counts) => ({ ...counts, refused: refused.length });
            if (captures.length === 0 && promotions.length === 0) return done(zeroCounts());

            const producer = memberNameOf(member);
            // Without a resolved member there is no repository the writes
            // belong to -- the tm7 defect. Refuse rather than guess.
            if (!active || !producer) {
                log(`[kb-work] WARN: no member resolved for ${role} -- ${captures.length} capture(s) and ${promotions.length} promotion(s) dropped`);
                return done(zeroCounts());
            }
            const sel = selector();
            if (sel && typeof sel.isNonRepoMember === 'function' && sel.isNonRepoMember(producer)) {
                log(`[kb-work] WARN: member '${producer}' (${role}): work folder is not a repository -- ${captures.length} capture(s) and ${promotions.length} promotion(s) dropped`);
                return done(zeroCounts());
            }
            const target = maintainerFor(producer);
            if (!target) {
                log(`[kb-work] WARN: no kb_maintainer for member '${producer}' (${role}) -- ${captures.length} capture(s) and ${promotions.length} promotion(s) dropped`);
                return done(zeroCounts());
            }
            for (const c of captures) enqueue(target.repo, 'capture', role, c);
            for (const p of promotions) enqueue(target.repo, 'promote', role, p);
            return done(await flush(target.repo));
        },

        /**
         * KB audit 2026-08-11: publish this repo's CONFIRMED set to its
         * canonical bible (<repo>/.fleet/kb-canonical.json).
         *
         * Nothing in the pipeline had ever called kb_export, so a bible existed
         * only where an operator had run the tool by hand -- 1 of 17 repos on
         * the audited machine. Promotion therefore ended at the local sqlite
         * store: a teammate, a fresh clone, or a member on another host saw
         * none of it, and kb_session_prime's cold-seed (which reads exactly
         * this file) had nothing to fall back on. Promotion is the sprint's
         * work; publishing it is the step that makes the work leave the
         * machine.
         *
         * Called once, AFTER the final review's promotions have been applied,
         * so the bible reflects everything this sprint confirmed. Best-effort
         * like every other KB call here: a sprint must never fail over an
         * export, and the tool itself is a no-op when the entry set is
         * unchanged. Committing/pushing the file stays a separate, opt-in
         * decision (kb_export's own autoCommit config) -- this does not widen
         * the engine's git authority.
         */
        async exportBible(member) {
            // Same repo-blindness guard as every other call here: without a
            // member there is no session whose repo the bible belongs to.
            if (!active || !member) return false;
            try {
                const res = await memberCall(member, 'kb_export', {});
                if (isToolError(res)) {
                    log(`[kb-work] kb_export rejected for ${memberLabel(member)} (non-fatal): ${toolErrorText(res)}`);
                    return false;
                }
                log(`[kb-work] exported the canonical bible for ${memberLabel(member)}`);
                return true;
            } catch (err) {
                log(`[kb-work] kb_export failed for ${memberLabel(member)} (non-fatal): ${err.message}`);
                return false;
            }
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
                    // kb_export attempted a 17 -> 9 bible truncation, and
                    // kb_list (stale=0) returned an EMPTY promotion candidate
                    // list -- reinstating apra-fleet-0ef, "kb_promote can never
                    // fire". This import exists to WARM the KB, never to audit
                    // it; prime()'s own bounded checkFreshness still guards each
                    // entry it actually returns.
                    try {
                        // No `path`: the member session imports its OWN folder's
                        // committed bible (<work folder>/.fleet/kb-canonical.json).
                        const imported = parseResult(await memberCall(record, 'kb_import', { skip_sweep: true }));
                        if (imported && typeof imported.imported === 'number' && imported.imported > 0) {
                            log(`[kb-prime] imported ${imported.imported} bible entr(ies) into the warm KB for '${member}'`);
                        }
                    } catch (err) {
                        log(`[kb-prime] kb_import skipped for '${member}' (non-fatal): ${err.message}`);
                    }

                    const primeResult = parseResult(await memberCall(record, 'kb_session_prime', {}));
                    // Same injection rule as relevantKnowledge, applied BEFORE the
                    // cap so a prime dominated by INFERRED captures does not
                    // crowd out the CONFIRMED entries behind them.
                    const entries = (primeResult && Array.isArray(primeResult.top_entries))
                        ? primeResult.top_entries.filter((e) => typeof e?.id === 'string' && isInjectableKbEntry(e))
                        : [];
                    if (entries.length > 0) knowledge.set(member, entries.slice(0, KB_MAX_KNOWLEDGE_ENTRIES));
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
    const terms = [];
    for (const b of Array.isArray(beads) ? beads : []) {
        if (b && typeof b.title === 'string' && b.title.trim()) terms.push(b.title.trim());
    }
    for (const id of Array.isArray(beadIds) ? beadIds : []) {
        if (typeof id === 'string' && id.trim()) terms.push(id.trim());
    }
    return terms;
}

// `captureChannel` (default true, the doer/reviewer/final-review prompt
// builders' case) says whether the recipient's returned `kb_captures` field is
// actually applied by the engine (a 'kb-apply' postResult step -- see
// role-policies.mjs agentTypeAppliesKbCaptures). When it is not, the block
// must not promise that the orchestrator records a capture: those roles'
// prompts tell them to note the finding in their own report instead.
export function kbKnowledgeBlock(entries, { captureChannel = true } = {}) {
    if (!Array.isArray(entries)) return [];
    // Filter only -- the sources (relevantKnowledge, primeAll) own the entry cap,
    // so this block never drops what a caller deliberately handed it.
    const injectable = entries.filter(isInjectableKbEntry);
    if (injectable.length === 0) return [];
    const captureLine = captureChannel
        ? 'If you discover something non-obvious and durable while working, report it in the '
            + '`kb_captures` field of your structured output and the orchestrator will record it.\n'
        : 'If you discover something non-obvious and durable while working, note it in your '
            + 'own report.\n';
    return [
        'KNOWLEDGE BANK -- what this repo already knows. These entries were captured during '
        + 'earlier work on this repository and are provided so you do not rediscover them the '
        + 'hard way. Read them BEFORE you start.\n'
        + 'Only CONFIRMED entries are included: a reviewer promoted each claim on evidence when '
        + 'it was captured. An entry describes the tree it was captured against, so if one '
        + 'contradicts what you actually observe in the code right now, the code wins -- say so '
        + 'in your notes rather than bending your work to fit the entry.\n'
        + 'You do not need to call any kb_* tool to read these. '
        + captureLine
        + wrapUntrustedBlock('kb_session_prime --top_entries', JSON.stringify(
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
        + 'CONFIRMED. Do NOT call any kb_* tool yourself: return your decisions in the '
        + '`kb_promotions` field of your structured output as [{id, reason}] and the '
        + 'orchestrator executes them.\n'
        + 'Promote ONLY entries whose claim you independently verified during THIS review '
        + '-- by reading the diff, running the tests, or checking the cited files yourself. '
        + 'The `reason` must state that evidence (at least 20 characters, e.g. "verified '
        + 'against server/transit.js:88 and the reopen test"). Evidence, not plausibility: '
        + 'if an entry merely looks correct, leave it INFERRED -- that is a perfectly good '
        + 'resting state, and a wrong CONFIRMED entry is worse than no entry. Never '
        + 'blanket-promote, and never promote by module, tag or timestamp. Promoting '
        + 'nothing is a valid outcome; return [] in that case.\n'
        + wrapUntrustedBlock('kb_list --confidence INFERRED', JSON.stringify(
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
