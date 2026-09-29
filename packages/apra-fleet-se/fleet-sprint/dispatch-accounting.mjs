// =============================================================================
// PER-DISPATCH KNOWLEDGE AND CODE INTELLIGENCE ACCOUNTING (apra-fleet-b4g.33).
//
// Data-collection half of the Knowledge and Code Intelligence panel
// (apra-fleet-b4g.21 renders it; apra-fleet-b4g.25 asserts on it). ONE
// structured store, read back by both, so neither has to reconstruct a count
// by re-parsing this engine's prose log lines.
//
// Kept in its OWN module rather than folded into sprint-state.mjs (where an
// earlier version of this change lived): sprint-state.test.mjs mechanically
// pins "no `new Map(` anywhere in sprint-state.mjs" as a regression guard for
// an unrelated invariant (member-target.mjs is the SOLE owner of the
// per-member { os, shell } cache; sprint-state.mjs must never grow one of its
// own). This store's per-(role,member) Map would have tripped that guard for
// a reason that has nothing to do with what it is actually protecting, so it
// lives here instead.
//
// WHAT IS COUNTED, AND WHY THE code_* FAMILY IS DIFFERENT. kb.mjs's
// createKbWorkClient makes every engine-side kb_* call over the injected
// callTool (kb_list, kb_query, kb_capture, kb_promote, kb_export) -- those
// calls are observable here and are counted as a side effect of the call
// actually happening, never reconstructed after the fact. The code_* family
// is NOT observable the same way: every code_* call a role makes happens
// inside that role's OWN member-side apra-fleet install over stdio, which
// this engine never sees. The only code_* call site the engine itself owns
// is the Sprint Setup preflight probe (member-preflight.mjs's check (c)),
// which is a per-MEMBER signal, not a per-dispatch one. Recording the
// per-dispatch code_* count as 0 would assert the false claim "the agent
// made no code calls" -- so it is recorded as the explicit
// CODE_CALLS_NOT_OBSERVABLE marker instead, a third state distinct from both
// "zero calls" and "no record at all". See kb.mjs's own header for the two
// repo-wide greps (toolCallCount/recordToolCall/... and
// indexCommit/codeIndexCommit/...) that established neither a member-side
// call log nor a code-index-completion signal exists anywhere in this repo;
// building either is out of scope here (deferred to apra-fleet-hn0i).
//
// KEYED BY (role, member), ACCUMULATING ACROSS THAT PAIR'S DISPATCHES THIS
// SPRINT -- not a fresh record per individual dispatch invocation. Threading
// a genuine per-invocation dispatch id through dispatch-role.mjs's ladder
// (which spans a pre-dispatch kb_query/kb_list read, the dispatch itself, and
// a post-dispatch kb_capture/kb_promote apply -- three separate call sites
// today with no correlating id between them) is a materially larger change
// than this lane's data-collection scope. (role, member) is what AC1
// actually names as the key, a role+member pair is dispatched at most a
// handful of times per sprint, and the panel's job is "did this role/member's
// KB traffic look real", which an accumulated total answers as well as a
// per-invocation breakdown would. A record is created zero-initialized on
// its FIRST touch (never reset afterward), which is what makes "no kb calls
// made" for a role/member pair that never touched the KB an explicit
// zero rather than an absent key.
//
// BEST-EFFORT AND NON-FATAL, matching kb.mjs's own standing rule: every
// mutator here is wrapped so a recording failure is only ever logged, never
// thrown, and never changes the outcome of the kb_* call it was counting.
// =============================================================================

/** The closed set of kb_* tools this store counts, mirroring kb.mjs's own call sites. */
export const KB_ACCOUNTING_TOOLS = Object.freeze(['kb_list', 'kb_query', 'kb_capture', 'kb_promote', 'kb_export']);

/**
 * The named marker recorded for a dispatch record's `code` field. NEVER a
 * number -- see this file's header for why 0 would be a false claim.
 */
export const CODE_CALLS_NOT_OBSERVABLE = 'not-observable';

/**
 * apra-fleet-b4g.21: the publishState namespace this store's per-dispatch
 * snapshot is broadcast under, so the sprint viewer's Knowledge and Code
 * Intelligence panel (viewer-extensions.mjs's kbCodeIntelExtension) can
 * subscribe to `workflow:state:${DISPATCH_ACCOUNTING_STATE_NAMESPACE}`
 * client-side rather than re-deriving counts of its own. The per-member
 * preflight half is already published separately under
 * member-preflight.mjs's own PREFLIGHT_STATE_NAMESPACE -- this module does
 * not republish it, so there stays exactly one publisher per record kind.
 */
export const DISPATCH_ACCOUNTING_STATE_NAMESPACE = 'kb-dispatch-accounting';

/**
 * Builds this store's per-dispatch accounting plus the per-member preflight
 * readback, as ONE object so the panel and the acceptance lane share a
 * single source.
 *
 * @param {{ log?: Function, publishState?: Function }} [opts]
 * @returns {{
 *   forDispatch: (info: { role?: string, member?: string }) => object|null,
 *   recordKbCall: (record: object|null, toolName: string) => void,
 *   recordCaptureOutcome: (record: object|null, outcome: { title?: string, outcome: 'kept'|'rejected', cause?: string, source?: string }) => void,
 *   dispatchRecords: () => object[],
 *   dispatchRecordFor: (role: string, member: string) => object|null,
 *   setPreflightRecords: (records: object[]) => void,
 *   preflightRecords: () => object[],
 *   preflightCodeOutcomeFor: (member: string) => string|null,
 * }}
 */
export function createDispatchAccounting({ log = () => {}, publishState } = {}) {
    /** @type {Map<string, object>} "role|member" -> record */
    const recordsByKey = new Map();
    const keyOrder = [];
    let preflightRecordsStore = [];

    function zeroKbCounts() {
        const counts = {};
        for (const tool of KB_ACCOUNTING_TOOLS) counts[tool] = 0;
        return counts;
    }

    function keyOf(role, member) {
        return `${role || '(unknown role)'}|${member || '(unknown member)'}`;
    }

    /**
     * Best-effort broadcast of the current per-dispatch snapshot, so the
     * viewer panel (a browser page, which cannot reach into this in-process
     * object directly) sees the SAME data the acceptance lane reads via
     * dispatchRecords() -- never a second, re-derived copy. A caller that
     * wires no `publishState` (every existing construction site before
     * apra-fleet-b4g.21, and any unit test) gets exactly the pre-existing
     * behavior: this is a silent no-op.
     */
    function publish() {
        if (typeof publishState !== 'function') return;
        try {
            publishState(DISPATCH_ACCOUNTING_STATE_NAMESPACE, {
                dispatches: keyOrder.map((k) => recordsByKey.get(k)),
            });
        } catch (err) {
            log(`[dispatch-accounting] could not publish the dispatch snapshot (non-fatal): ${err.message}`);
        }
    }

    /**
     * Returns the (role, member) pair's record, creating it zero-initialized
     * on first touch. Never throws -- a malformed role/member degrades to an
     * '(unknown ...)' bucket rather than losing the count, and any other
     * failure returns null so callers can no-op.
     */
    function forDispatch({ role, member } = {}) {
        try {
            const key = keyOf(role, member);
            let rec = recordsByKey.get(key);
            if (!rec) {
                rec = {
                    role: role || null,
                    member: member || null,
                    kbCounts: zeroKbCounts(),
                    // AC4: kept vs rejected, cause retained -- see
                    // recordCaptureOutcome. Never inferred from kbCounts.kb_capture
                    // alone, which only ever counts ATTEMPTS.
                    captureOutcomes: [],
                    // AC2/AC7: a distinct third state, set once here and never
                    // reassigned to a number by anything in this module.
                    code: { status: CODE_CALLS_NOT_OBSERVABLE },
                };
                recordsByKey.set(key, rec);
                keyOrder.push(key);
                publish();
            }
            return rec;
        } catch (err) {
            log(`[dispatch-accounting] could not resolve a record for role='${role}' member='${member}' (non-fatal): ${err.message}`);
            return null;
        }
    }

    /** Counts one kb_* call attempt. A record of `null` (accounting unavailable/broken) is a silent no-op. */
    function recordKbCall(record, toolName) {
        try {
            if (!record) return;
            if (!(toolName in record.kbCounts)) record.kbCounts[toolName] = 0;
            record.kbCounts[toolName] += 1;
            publish();
        } catch (err) {
            log(`[dispatch-accounting] could not record a ${toolName} call (non-fatal): ${err.message}`);
        }
    }

    /** Records one kb_capture outcome. `outcome` is 'kept' or 'rejected'; `cause` should be set for 'rejected'. */
    function recordCaptureOutcome(record, { title, outcome, cause = null, source = null } = {}) {
        try {
            if (!record) return;
            record.captureOutcomes.push({ title: title || null, outcome, cause, source });
            publish();
        } catch (err) {
            log(`[dispatch-accounting] could not record a capture outcome (non-fatal): ${err.message}`);
        }
    }

    /**
     * Publishes THIS run's per-member preflight records -- the exact objects
     * createMemberPreflight().runAll() returns ({member, repoPath, remoteUrl,
     * mcpScope, kbEntryCount, checks, warnings}). No field is renamed, dropped
     * or invented (AC5): this store is a readback, not a second source.
     */
    function setPreflightRecords(records) {
        try {
            preflightRecordsStore = Array.isArray(records) ? records : [];
        } catch (err) {
            log(`[dispatch-accounting] could not record preflight records (non-fatal): ${err.message}`);
        }
    }

    return {
        forDispatch,
        recordKbCall,
        recordCaptureOutcome,
        /** All per-(role,member) records, in first-touched order. */
        dispatchRecords() {
            return keyOrder.map((k) => recordsByKey.get(k));
        },
        dispatchRecordFor(role, member) {
            return recordsByKey.get(keyOf(role, member)) || null;
        },
        setPreflightRecords,
        preflightRecords() {
            return preflightRecordsStore;
        },
        /**
         * AC3: the one engine-visible code signal, carried through per member --
         * this member's preflight `code` check outcome (ok, index-not-ready,
         * tool-unavailable or unscoped), or null when no preflight record exists
         * for it.
         */
        preflightCodeOutcomeFor(member) {
            const rec = preflightRecordsStore.find((r) => r && r.member === member);
            return (rec && rec.checks && rec.checks.code) ? rec.checks.code.outcome : null;
        },
    };
}
