// =============================================================================
// Per-dispatch kb_* / code_* tool call accounting from session_stats snapshots.
//
// The member's agent makes its kb_* and code_* calls against the fleet server
// its own MCP config points at -- for a remote member that is the member's OWN
// server, which the engine cannot observe. That server counts those calls per
// member (session_stats). So the engine reads session_stats AS the member
// (memberCall: a local in-process member session, or `apra-fleet call` on a
// remote member -- both are engine-origin sessions, whose own calls the server
// does not count) immediately before and immediately after each dispatch, and
// records the difference as that dispatch's calls.
//
// HONESTY RULE: a count is either a number read from two good snapshots or the
// string 'unknown' -- never a fabricated 0. Any of these yields 'unknown' for
// the dispatch (with a reason): no member session available, no member record
// for the dispatched member name, a failed or unparseable read, a changed
// `since` between the two snapshots (the member's server restarted mid-
// dispatch, so the counters were reset), or a negative difference.
//
// Accounting is best-effort and never fails or delays a dispatch beyond the
// bounded snapshot reads: every error is logged and recorded as 'unknown'.
//
// Records are appended to a caller-supplied array (the sprint state's
// dispatchToolCalls list) and optionally published to the viewer under
// DISPATCH_TOOL_CALLS_STATE_NAMESPACE.
// =============================================================================

/** The value recorded for a count the engine could not establish. */
export const UNKNOWN_COUNT = 'unknown';

/** publishState namespace for the per-dispatch records (viewer tab). */
export const DISPATCH_TOOL_CALLS_STATE_NAMESPACE = 'dispatch-tool-calls';

/** Default bound on one session_stats read. */
export const SNAPSHOT_READ_TIMEOUT_MS = 60_000;

function isCount(n) {
    return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * Extract a session_stats snapshot { since, kb, code } from a tool result
 * (MCP { content: [{ text }] } or an already-parsed object). Returns null for
 * anything that is not a well-formed snapshot.
 */
export function parseSessionStats(result) {
    let obj = result;
    if (obj && Array.isArray(obj.content)) {
        if (obj.isError) return null;
        const text = obj.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
        try { obj = JSON.parse(text); } catch { return null; }
    }
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.since !== 'string' || !isCount(obj.kb) || !isCount(obj.code)) return null;
    return { since: obj.since, kb: obj.kb, code: obj.code };
}

/**
 * The per-dispatch counts from a before/after pair of parsed snapshots (either
 * may be null). Returns { kb, code, reason } where kb/code are numbers or
 * UNKNOWN_COUNT and reason explains an unknown (null otherwise).
 */
export function snapshotDelta(before, after) {
    if (!before || !after) {
        return { kb: UNKNOWN_COUNT, code: UNKNOWN_COUNT, reason: !before ? 'before-snapshot read failed' : 'after-snapshot read failed' };
    }
    if (before.since !== after.since) {
        return { kb: UNKNOWN_COUNT, code: UNKNOWN_COUNT, reason: 'member server restarted during the dispatch (counters reset)' };
    }
    const kb = after.kb - before.kb;
    const code = after.code - before.code;
    if (kb < 0 || code < 0) {
        return { kb: UNKNOWN_COUNT, code: UNKNOWN_COUNT, reason: 'counters went backwards' };
    }
    return { kb, code, reason: null };
}

/**
 * The reason text for a count that is unknown because the member's own tools
 * were unavailable at sprint init: "member tools unavailable: <reason>" plus
 * the short cause the init record carries (problem detail), when known.
 * Returns null when the init record is absent or the member was verified.
 *
 * @param {{verified?: boolean, reason?: string|null, problems?: Array<{reason?: string, detail?: string}>}|null|undefined} init
 * @returns {string|null}
 */
export function memberToolsReason(init) {
    if (!init || typeof init !== 'object' || init.verified === true) return null;
    const reason = init.reason ? String(init.reason) : 'unverified';
    const p = Array.isArray(init.problems) ? init.problems.find((x) => x && x.reason === init.reason && x.detail) : null;
    const cause = p ? String(p.detail).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return `member tools unavailable: ${reason}${cause ? ` -- ${cause}` : ''}`;
}

/** Format one count for text output: a number, or the literal 'unknown'. */
export function formatCount(n) {
    return isCount(n) ? String(n) : UNKNOWN_COUNT;
}

/**
 * Per-member totals over a list of dispatch records. A member's total for a
 * kind is a number only when every one of its dispatches has a number for
 * that kind; otherwise it is UNKNOWN_COUNT (with the unknown dispatch count).
 */
export function memberTotals(records) {
    const out = [];
    const byMember = new Map();
    for (const r of Array.isArray(records) ? records : []) {
        if (!r || typeof r !== 'object') continue;
        const name = String(r.member || '(unknown member)');
        let t = byMember.get(name);
        if (!t) {
            t = { member: name, dispatches: 0, kb: 0, code: 0, unknownDispatches: 0, unknownReason: null };
            byMember.set(name, t);
            out.push(t);
        }
        t.dispatches++;
        if (!isCount(r.kb) || !isCount(r.code)) {
            t.unknownDispatches++;
            if (!t.unknownReason && r.reason) t.unknownReason = String(r.reason);
        }
        t.kb = isCount(t.kb) && isCount(r.kb) ? t.kb + r.kb : UNKNOWN_COUNT;
        t.code = isCount(t.code) && isCount(r.code) ? t.code + r.code : UNKNOWN_COUNT;
    }
    return out;
}

/**
 * Create the accounting helper.
 *
 * @param {object} deps
 * @param {(member: object, tool: string, args: object) => Promise<object>} [deps.memberCall]
 *        the engine's memberCall (MEMBER-scoped, engine-origin); absent means
 *        every dispatch records 'unknown'.
 * @param {(memberName: string) => object|null} [deps.getMemberInit]
 *        the member-init record for a member NAME (verified, reason, problems);
 *        an unknown count caused by a failed snapshot read or a missing member
 *        session then carries the member-tools reason instead of the bare read
 *        failure. Other unknowns (restart, counters backwards) keep their own.
 * @param {(memberName: string) => object|null} [deps.memberOf]
 *        resolves a dispatched member NAME to its member record ({id, name, type}).
 * @param {object[]} [deps.store] array records are appended to (sprint state).
 * @param {(ns: string, payload: object) => void} [deps.publishState]
 * @param {Function} [deps.log]
 * @param {number} [deps.readTimeoutMs]
 * @param {() => string} [deps.now] ISO timestamp source (tests).
 */
export function createDispatchAccounting(deps = {}) {
    const {
        memberCall,
        memberOf,
        getMemberInit,
        publishState,
        log = () => {},
        readTimeoutMs = SNAPSHOT_READ_TIMEOUT_MS,
        now = () => new Date().toISOString(),
    } = deps;
    const store = Array.isArray(deps.store) ? deps.store : [];
    let seq = 0;

    function publish() {
        if (typeof publishState !== 'function') return;
        try {
            publishState(DISPATCH_TOOL_CALLS_STATE_NAMESPACE, { dispatches: store.slice() });
        } catch (err) {
            log(`[dispatch-accounting] could not publish dispatch tool-call records (non-fatal): ${err && err.message || err}`);
        }
    }

    function withTimeout(promise) {
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`session_stats read timed out after ${readTimeoutMs}ms`)), readTimeoutMs);
            }),
        ]).finally(() => clearTimeout(timer));
    }

    /** One snapshot read; null on any failure (logged). */
    async function readSnapshot(record, memberName, which) {
        try {
            const res = await withTimeout(Promise.resolve().then(() => memberCall(record, 'session_stats', {})));
            const snap = parseSessionStats(res);
            if (!snap) log(`[dispatch-accounting] ${which} session_stats for member '${memberName}' was unparseable; counts for this dispatch are unknown.`);
            return snap;
        } catch (err) {
            log(`[dispatch-accounting] ${which} session_stats read for member '${memberName}' failed (counts for this dispatch are unknown): ${err && err.message || err}`);
            return null;
        }
    }

    /**
     * The per-dispatch tier fields, and the one log line every dispatch emits.
     * A WARN follows when the resolved tier differs from the requested one, or
     * a tier was requested and the result carries none -- never silent.
     */
    function tierRecord({ index, memberName, role, requestedTier, tierContext, resolved, failed = false }) {
        const ctx = tierContext && typeof tierContext === 'object' ? tierContext : {};
        const requested = typeof requestedTier === 'string' && requestedTier ? requestedTier : null;
        const resolvedTier = resolved && typeof resolved.resolved_tier === 'string' ? resolved.resolved_tier : null;
        const resolvedModel = resolved && typeof resolved.resolved_model === 'string' ? resolved.resolved_model : null;
        const beadIds = Array.isArray(ctx.beadIds) ? ctx.beadIds.map(String) : [];
        const tierReasons = ctx.tierReasons && typeof ctx.tierReasons === 'object' ? { ...ctx.tierReasons } : {};
        const escalations = Array.isArray(ctx.escalations)
            ? ctx.escalations.filter((e) => e && e.from && e.to).map((e) => ({ id: e.id ? String(e.id) : null, from: String(e.from), to: String(e.to) }))
            : [];
        // A tier name is only comparable to a tier name; a literal model id as
        // the request is not a tier request.
        const tierRequested = requested === 'cheap' || requested === 'standard' || requested === 'premium';
        let mismatch = null;
        // A dispatch that threw never produced a result, so a missing
        // resolved_tier is expected there and is not a mismatch.
        const dispatchFailed = failed === true && resolvedTier === null;
        if (dispatchFailed) mismatch = null;
        else if (tierRequested && resolvedTier === null) mismatch = 'no-resolved-tier';
        else if (tierRequested && resolvedTier !== requested) mismatch = 'tier-differs';
        const who = memberName ? String(memberName) : '(unknown member)';
        const parts = [
            `role=${role || '(none)'}`,
            `member=${who}`,
            `beads=${beadIds.length ? beadIds.join(',') : '-'}`,
            `requested_tier=${requested || '-'}`,
            `resolved_tier=${resolvedTier || '-'}`,
            `resolved_model=${resolvedModel || '-'}`,
        ];
        if (dispatchFailed) parts.push('dispatch failed, no result');
        const reasonEntries = Object.entries(tierReasons).filter(([, v]) => v);
        if (reasonEntries.length) parts.push(`tierReason=${reasonEntries.map(([k, v]) => `${k}:${String(v).replace(/\s+/g, ' ').trim()}`).join('; ')}`);
        if (escalations.length) parts.push(`escalation=${escalations.map((e) => `${e.id ? `${e.id} ` : ''}${e.from}->${e.to}`).join(', ')}`);
        log(`[tier] dispatch ${index}: ${parts.join(' ')}`);
        if (mismatch) {
            const got = resolvedTier === null ? 'the result carries no resolved_tier' : "it resolved to '" + resolvedTier + "'";
            log(`[tier] WARN: dispatch ${index} to member '${who}' requested tier '${requested}' but ${got} (requested=${requested}, resolved=${resolvedTier || 'none'}).`);
        }
        return { requested, resolved: resolvedTier, resolvedModel, beadIds, tierReasons, escalations, mismatch };
    }

    function resolveRecord(memberName) {
        try {
            return typeof memberOf === 'function' ? memberOf(memberName) : null;
        } catch {
            return null;
        }
    }

    return {
        /** The records so far (a copy). */
        records() {
            return store.slice();
        },
        /**
         * Run `fn` (one dispatch to `memberName`) between two session_stats
         * snapshots and record the per-dispatch counts. `fn`'s result or
         * error passes through unchanged.
         */
        async around({ memberName, role, label, requestedTier, tierContext, resolved } = {}, fn) {
            const index = ++seq;
            const startedAt = now();
            const record = memberName ? resolveRecord(memberName) : null;
            let skipReason = null;
            if (!memberName) skipReason = 'dispatch named no member';
            else if (typeof memberCall !== 'function') skipReason = 'no member session available to read session_stats';
            else if (!record || !(record.id || record.member_id)) skipReason = `no member record for '${memberName}'`;
            const before = skipReason ? null : await readSnapshot(record, memberName, 'before');
            let threw = false;
            try {
                return await fn();
            } catch (err) {
                threw = true;
                throw err;
            } finally {
                const after = skipReason ? null : await readSnapshot(record, memberName, 'after');
                const delta = skipReason
                    ? { kb: UNKNOWN_COUNT, code: UNKNOWN_COUNT, reason: skipReason }
                    : snapshotDelta(before, after);
                if (delta.reason && (skipReason || /snapshot read failed$/.test(delta.reason)) && memberName && typeof getMemberInit === 'function') {
                    let toolsReason = null;
                    try { toolsReason = memberToolsReason(getMemberInit(memberName)); } catch { /* informational only */ }
                    if (toolsReason) delta.reason = toolsReason;
                }
                const tier = tierRecord({
                    index, memberName, role, requestedTier, tierContext,
                    resolved: typeof resolved === 'function' ? resolved() : null,
                    failed: threw,
                });
                store.push({
                    index,
                    member: memberName ? String(memberName) : '(unknown member)',
                    role: role ? String(role) : null,
                    label: label ? String(label) : null,
                    startedAt,
                    endedAt: now(),
                    kb: delta.kb,
                    code: delta.code,
                    reason: delta.reason,
                    tier,
                });
                publish();
            }
        },
    };
}

/**
 * Text lines for the sprint summary: calls per member per dispatch, then
 * per-member totals. Pure. 'unknown' is printed as unknown, never 0.
 */
export function formatDispatchToolCalls(records) {
    const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object');
    if (list.length === 0) return ['No member dispatch was recorded this sprint.'];
    const lines = [];
    for (const r of list) {
        const who = r.role ? `${r.role} on member '${r.member}'` : `member '${r.member}'`;
        const label = r.label ? ` [${r.label}]` : '';
        const why = (!isCount(r.kb) || !isCount(r.code)) && r.reason ? ` (unknown: ${r.reason})` : '';
        lines.push(`- Dispatch ${r.index}: ${who}${label} -- kb_* calls: ${formatCount(r.kb)}, code_* calls: ${formatCount(r.code)}${why}.`);
    }
    lines.push('');
    lines.push('Per-member totals:');
    for (const t of memberTotals(list)) {
        const unknown = t.unknownDispatches > 0 ? ` (${t.unknownDispatches} dispatch(es) with unknown counts)${t.unknownReason ? ` (unknown: ${t.unknownReason})` : ''}` : '';
        lines.push(`- member '${t.member}': ${t.dispatches} dispatch(es), kb_* calls: ${formatCount(t.kb)}, code_* calls: ${formatCount(t.code)}${unknown}.`);
    }
    return lines;
}

const TIER_ORDER = ['cheap', 'standard', 'premium'];

/**
 * Sprint-summary counts from the per-dispatch tier fields: dispatches per
 * requested tier, escalations and mismatches. Pure.
 */
export function tierCounts(records) {
    const perTier = { cheap: 0, standard: 0, premium: 0, other: 0, none: 0 };
    let escalations = 0;
    let mismatches = 0;
    for (const r of Array.isArray(records) ? records : []) {
        const t = r && r.tier;
        if (!t) continue;
        if (t.requested && TIER_ORDER.includes(t.requested)) perTier[t.requested]++;
        else if (t.requested) perTier.other++;
        else perTier.none++;
        if (Array.isArray(t.escalations)) escalations += t.escalations.length;
        if (t.mismatch) mismatches++;
    }
    return { perTier, escalations, mismatches };
}

/** Text lines for the sprint summary's tier section. Pure. */
export function formatTierSummary(records) {
    const c = tierCounts(records);
    return [
        `- Dispatches by requested tier: cheap ${c.perTier.cheap}, standard ${c.perTier.standard}, premium ${c.perTier.premium}` +
            `${c.perTier.other ? `, literal model ${c.perTier.other}` : ''}${c.perTier.none ? `, no tier ${c.perTier.none}` : ''}.`,
        `- Escalations: ${c.escalations}.`,
        `- Tier mismatches (resolved tier differs from the request, or none reported): ${c.mismatches}.`,
    ];
}
