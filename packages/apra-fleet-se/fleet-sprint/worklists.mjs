// Worklist tier policy, effort-budget packing and the pure streak-assignment
// validation helpers for fleet-sprint's Develop/Review loop
// (apra-fleet-3swo.3.5). Moved verbatim out of runner.js -- runner.js
// re-exports every symbol this region previously exported (selectStreaks was
// module-private and is imported, not re-exported, for its own in-runner call
// sites), so behaviour is unchanged either way. This is a move-only
// extraction: no logic, ordering or tier-homogeneity rule changed.
//
// normalizeTierToken and DEFAULT_CONTEXT_CEILING stay in runner.js (out of
// this bead's scope -- normalizeTierToken is part of the newTask validation
// cluster, DEFAULT_CONTEXT_CEILING is shared with createRoundSessionRegistry's
// round-resume tracking) and are imported back here; the resulting runner.js
// <-> worklists.mjs cycle is safe because every use is inside a function
// body, never at module-evaluation time.
import { normalizeTierToken, DEFAULT_CONTEXT_CEILING } from './runner.js';

/**
 * Validates a streak-assignment agent() result against the set of currently
 * ready bead objects and returns the resolved streaks (arrays of the original
 * bead objects, not just ids). Falls back to one-bead-per-streak -- which is
 * correct by construction -- whenever the candidate does not cover every ready
 * bead id EXACTLY once, so a malformed result can never drop or duplicate a
 * bead's assignment.
 *
 * Pure: no I/O, no agent() calls.
 * @param {{streaks: string[][]}|null|undefined} candidate
 * @param {Array<{id: string}>} currentReady
 * @returns {{ streaks: Array<Array<{id: string}>>, usedFallback: boolean, reason: string|null }}
 */
export function selectStreaks(candidate, currentReady) {
    const fallback = () => ({
        streaks: currentReady.map((b) => [b]),
        usedFallback: true,
    });

    if (!candidate || !Array.isArray(candidate.streaks)) {
        return { ...fallback(), reason: 'no candidate or candidate.streaks was not an array' };
    }

    const byId = new Map(currentReady.map((b) => [b.id, b]));
    const readyIds = currentReady.map((b) => b.id);
    const seen = new Set();
    const resolvedStreaks = [];

    for (const streakIds of candidate.streaks) {
        if (!Array.isArray(streakIds) || streakIds.length === 0) {
            return { ...fallback(), reason: 'a streak entry was not a non-empty array' };
        }
        const resolvedStreak = [];
        for (const id of streakIds) {
            if (!byId.has(id)) {
                return { ...fallback(), reason: `streak referenced unknown/non-ready bead id '${id}'` };
            }
            if (seen.has(id)) {
                return { ...fallback(), reason: `bead id '${id}' appeared in more than one streak` };
            }
            seen.add(id);
            resolvedStreak.push(byId.get(id));
        }
        resolvedStreaks.push(resolvedStreak);
    }

    if (seen.size !== readyIds.length) {
        return { ...fallback(), reason: `candidate covered ${seen.size} of ${readyIds.length} ready bead id(s)` };
    }

    return { streaks: resolvedStreaks, usedFallback: false, reason: null };
}

/**
 * Deterministic streak grouping from planner-emitted lane metadata (`streak` /
 * `streakOrder`, recorded by planner.md through the same beads `--metadata`
 * channel as `model`), intersected with the CURRENT ready set. When every ready
 * bead is laned the grouping is fully determined by the plan and no agent()
 * call is needed.
 *
 * Contract (mirrors selectStreaks' return shape, so the two are interchangeable
 * at the call site):
 * - Returns `null` when ANY ready bead is missing a non-empty
 *   `metadata.streak`. A partly-laned plan counts as "no lane metadata" so the
 *   caller falls back to the LLM assignment path; a plan must never be grouped
 *   by a mix of the two mechanisms.
 * - Otherwise returns `{ streaks, reason: null }`, arrays of the ORIGINAL bead
 *   objects grouped by `streak` id.
 *
 * Ordering is total and stable: within a lane by numeric `streakOrder`
 * ascending (missing/non-numeric last), then `title`, then `id`; lanes by their
 * minimum `streakOrder`, then `streak` id. Members of a ready set are mutually
 * unblocked by definition (a `blocks` edge would keep the blocked side out of
 * the set), so `streakOrder` alone cannot violate a blocks edge and the
 * title/id tiebreak only separates otherwise-equal peers.
 *
 * Pure: no I/O, no agent() calls.
 * @param {Array<{id: string, title?: string, metadata?: {streak?: string, streakOrder?: number|string}}>} currentReady
 * @returns {{ streaks: Array<Array<object>>, reason: null } | null}
 */
export function groupStreaksFromLaneMetadata(currentReady) {
    if (!Array.isArray(currentReady) || currentReady.length === 0) {
        return null;
    }
    // A single un-laned bead disqualifies the whole deterministic path.
    for (const b of currentReady) {
        const streakId = b && b.metadata && b.metadata.streak;
        if (typeof streakId !== 'string' || streakId.trim() === '') {
            return null;
        }
    }

    const orderOf = (b) => {
        const raw = b.metadata.streakOrder;
        const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
        return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
    };
    const withinLane = (a, b) =>
        orderOf(a) - orderOf(b)
        || String(a.title || '').localeCompare(String(b.title || ''))
        || String(a.id).localeCompare(String(b.id));

    const lanes = new Map();
    for (const b of currentReady) {
        const streakId = b.metadata.streak;
        if (!lanes.has(streakId)) lanes.set(streakId, []);
        lanes.get(streakId).push(b);
    }

    const laneEntries = [...lanes.entries()].map(([streakId, beads]) => {
        const sorted = beads.slice().sort(withinLane);
        const minOrder = Math.min(...sorted.map(orderOf));
        return { streakId, sorted, minOrder };
    });
    laneEntries.sort((x, y) =>
        x.minOrder - y.minOrder
        || String(x.streakId).localeCompare(String(y.streakId)));

    return { streaks: laneEntries.map((e) => e.sorted), reason: null };
}

export const SIZE_POINTS = Object.freeze({ S: 1, M: 2, L: 4 });
export const MODEL_WEIGHT = Object.freeze({ cheap: 1, standard: 10, premium: 20 });
export const DEFAULT_EFFORT_THRESHOLD = 200;

/**
 * Effort formula shared with planner.md: `effort = (sum of per-task size
 * points) x (max model weight across the lane)`. planner.md documents the
 * same formula as design-time math the planner applies when authoring lane
 * metadata; this is the executable reference the runtime effort budget and
 * the unit tests use.
 * @param {Array<{size: 'S'|'M'|'L', model: 'cheap'|'standard'|'premium'}>} tasks
 * @returns {number}
 */
export function computeLaneEffort(tasks) {
    const sizeSum = tasks.reduce((acc, t) => acc + (SIZE_POINTS[t.size] || 0), 0);
    const maxWeight = tasks.reduce((acc, t) => Math.max(acc, MODEL_WEIGHT[t.model] || 0), 0);
    return sizeSum * maxWeight;
}

// ---------------------------------------------------------------------------
// Multi-streak assignment per doer (ordered worklists)
// ---------------------------------------------------------------------------
//
// When a develop round has more ready streaks than doers, these functions pack
// them into PER-DOER ORDERED WORKLISTS so one doer can work several streaks
// back to back -- resuming its own session between them (mode ii, default) or
// carrying the whole worklist in a single batched dispatch (mode i,
// config-gated) -- instead of re-paying the fixed dispatch overhead per streak.
//
// The assignment/ordering decision is deterministic and makes no LLM call.

// Tier-grouping key for a streak with no model metadata at all. Such a streak
// gets its own group rather than being folded into a real tier, which would
// either under-run required work or silently upgrade cheap work.
const UNSPECIFIED_TIER_KEY = 'unspecified';

/**
 * A streak's REQUIRED model tier: the maximum (most-capable) tier across its
 * member beads' `metadata.model`, per planner.md's "max model weight in the
 * lane" formula. A streak must never execute on a tier below this. Beads whose
 * model metadata is missing or is not one of the three tier names contribute
 * nothing; a streak where no bead names a tier returns `null`, and the
 * dispatch runs untiered.
 * @param {Array<{metadata?: {model?: unknown}}>} streak
 * @returns {'cheap'|'standard'|'premium'|null}
 */
export function streakRequiredTier(streak) {
    let best = null;
    for (const bead of streak || []) {
        const tier = normalizeTierToken(bead && bead.metadata && bead.metadata.model);
        if (typeof tier === 'string' && MODEL_WEIGHT[tier] && (!best || MODEL_WEIGHT[tier] > MODEL_WEIGHT[best])) {
            best = tier;
        }
    }
    return best;
}

/**
 * A streak's priority: the MINIMUM (i.e. most urgent) numeric priority among
 * its member beads (bd's `priority` field, where 0 = P0). Beads without a
 * numeric priority contribute nothing; a streak with none at all returns
 * POSITIVE_INFINITY so it sorts after every priority-carrying streak and falls
 * through to the deterministic tie-break.
 * @param {Array<{priority?: unknown}>} streak
 * @returns {number}
 */
export function streakMinPriority(streak) {
    let min = Number.POSITIVE_INFINITY;
    for (const bead of streak || []) {
        const p = bead ? bead.priority : undefined;
        if (typeof p === 'number' && Number.isFinite(p) && p < min) {
            min = p;
        }
    }
    return min;
}

/**
 * A streak's effort-point total, computed with the shared planner.md formula
 * (computeLaneEffort: sum of size points x max model weight). planner.md only
 * mandates `model`/`streak`/`streakOrder` metadata, so a bead usually carries
 * no size: a bead without a usable `metadata.size` (S/M/L) defaults to 'M',
 * the middle of the scale, and a bead without a tier-shaped model defaults to
 * 'standard' for the WEIGHT term only. The defaults feed budget arithmetic and
 * never affect which model a dispatch runs on -- streakRequiredTier decides
 * that.
 * @param {Array<{metadata?: {size?: unknown, model?: unknown}}>} streak
 * @returns {number}
 */
export function streakEffortPoints(streak) {
    const tasks = (streak || []).map((bead) => {
        const rawSize = bead && bead.metadata ? bead.metadata.size : undefined;
        const size = typeof rawSize === 'string' && SIZE_POINTS[rawSize.trim().toUpperCase()]
            ? rawSize.trim().toUpperCase()
            : 'M';
        const tier = normalizeTierToken(bead && bead.metadata && bead.metadata.model);
        const model = typeof tier === 'string' && MODEL_WEIGHT[tier] ? tier : 'standard';
        return { size, model };
    });
    return computeLaneEffort(tasks);
}

/**
 * The ids a bead declares a `blocks`-type dependency on, i.e. beads that must
 * finish BEFORE it. Accepts either shape a dependency entry can take: a full
 * object carrying `dependency_type` (as `bd show --json` emits) or a plain id
 * string. Entries of any other dependency type are not ordering constraints
 * and are ignored.
 * @param {{dependencies?: Array<string|{id?: string, depends_on_id?: string, dependency_type?: string}>}} bead
 * @returns {string[]}
 */
export function beadBlocksDependencyIds(bead) {
    const out = [];
    const deps = bead && Array.isArray(bead.dependencies) ? bead.dependencies : [];
    for (const dep of deps) {
        if (typeof dep === 'string' && dep) {
            out.push(dep);
        } else if (dep && typeof dep === 'object') {
            if (dep.dependency_type && dep.dependency_type !== 'blocks') continue;
            const id = dep.depends_on_id || dep.id;
            if (typeof id === 'string' && id) out.push(id);
        }
    }
    return out;
}

/**
 * The tier policy for this round's worklist assignment, and the single place
 * the "provider supports model-switch-on-resume" capability check is made.
 * Mode (i) BATCH is one dispatch and therefore one model, so it ALWAYS
 * requires a tier-homogeneous worklist; a mixed batch is rejected at
 * assignment time rather than resolved by running everything at max tier. Mode
 * (ii) RESUMED SEQUENCE may carry mixed tiers only when the provider can
 * change model on a resumed session, signalled by `resumeModelSwitch`, whose
 * default of false is the safe fallback to tier-homogeneous grouping.
 *
 * PRODUCTIZE-OR-PRUNE AUDIT (apra-fleet-3swo.7.13): `doer_worklist_mode`
 * 'batch' and `resume_model_switch` (the two sprint-args.mjs keys this
 * function consumes) have no CLI flag and no caller in this repo, but both
 * were audited and PRODUCTIZED -- see sprint-args.mjs's KNOWN_ARG_KEYS
 * comments and docs/fleet-sprint-cli-contract.md's "Dormant argument audit"
 * for the caller-search evidence and the tests that exercise each end-to-end.
 * @param {{ mode: 'resume'|'batch', resumeModelSwitch?: boolean }} opts
 * @returns {{ tierHomogeneous: boolean }}
 */
export function resolveWorklistTierPolicy({ mode, resumeModelSwitch = false }) {
    if (mode === 'batch') return { tierHomogeneous: true };
    return { tierHomogeneous: !resumeModelSwitch };
}

/**
 * Whether the last dispatch's reported usage leaves enough context headroom to
 * RESUME that session for the next streak. Mirrors createRoundSessionRegistry's
 * near-ceiling rule: admission fails when the reported total_tokens is at or
 * above `ceilingFraction` of `contextCeiling`. Unknown usage admits, the same
 * stance the registry takes. On refusal the caller must fall back to a FRESH
 * session carrying the FULL prompt -- never a delta prompt into a fresh
 * session, since a delta only makes sense against a resumed session id.
 * @param {{total_tokens?: number}|null|undefined} usage
 * @param {{ contextCeiling?: number, ceilingFraction?: number }} [opts]
 * @returns {boolean}
 */
export function hasContextHeadroomForResume(usage, opts = {}) {
    const contextCeiling = typeof opts.contextCeiling === 'number' && opts.contextCeiling > 0
        ? opts.contextCeiling
        : DEFAULT_CONTEXT_CEILING;
    const ceilingFraction = typeof opts.ceilingFraction === 'number' && opts.ceilingFraction > 0
        ? opts.ceilingFraction
        : 0.9;
    const totalTokens = usage && typeof usage.total_tokens === 'number' ? usage.total_tokens : null;
    if (totalTokens === null) return true;
    return totalTokens < contextCeiling * ceilingFraction;
}

/**
 * Packs this round's streaks (as produced by groupStreaksFromLaneMetadata or
 * selectStreaks) into per-doer ORDERED worklists.
 *
 * Pass-through: when `streaks.length <= doerCount` there is nothing to pack --
 * every doer gets exactly one streak in the exact input order, with no
 * re-sorting, no budget, and no tier logic.
 *
 * Packing path (`streaks.length > doerCount`) orders streaks by, in strict
 * precedence:
 *  1. `blocks`-edge constraints between streaks, which are HARD: a streak
 *     depending on beads in another streak of this round is placed in the SAME
 *     worklist AFTER that streak, co-location being the only arrangement that
 *     guarantees order under the global FIFO dispatch gate, or overflows if
 *     that is impossible. A streak whose in-round dependency overflowed
 *     overflows too. Lane formation normally prevents such edges between ready
 *     streaks, but one that exists is never violated.
 *  2. Priority: among streaks with no dependency relationship,
 *     streakMinPriority ascending, so a P3 streak never occupies a doer ahead
 *     of an equally-ready P0 streak.
 *  3. Input index, which is itself already a deterministic order (lane
 *     minOrder, then streakId/title/id on the lane-metadata path), so the
 *     tie-break adds no nondeterminism.
 *
 * Grouping rules:
 *  - TIER-OUTLIER ISOLATION: streaks are PARTITIONED BY TIER FIRST, before any
 *    priority/effort-budget packing, and each partition packs independently
 *    into its own slot(s). A minority-tier outlier is never folded into a
 *    majority-tier worklist just because effort-budget headroom allows it,
 *    which is what keeps tier homogeneity from silently escalating cheaper
 *    work to a costlier tier. Slots round-robin over the doer pool at the
 *    dispatch site, so under a homogeneous tier policy more partitions than
 *    doers still dispatch this round, each as its own tier-pure worklist on a
 *    shared doer; a mixed worklist is never built. When mixed tiers are
 *    allowed, whole partitions merge into at most doerCount worklists, each
 *    appended as its own CONTIGUOUS run, never interleaved with another tier's
 *    streaks.
 *  - Effort budget (opts.effortBudget, default DEFAULT_EFFORT_THRESHOLD, in
 *    the planner.md effort points): a streak joins a non-empty worklist only
 *    if the running total stays within budget, otherwise it queues to the next
 *    round via `overflow`. An EMPTY worklist always accepts, so a single
 *    over-budget streak still dispatches rather than starving forever.
 *
 * @param {Array<Array<object>>} streaks - arrays of ORIGINAL bead objects
 * @param {number} doerCount
 * @param {{ effortBudget?: number, tierHomogeneous?: boolean }} [opts]
 * @returns {{
 *   worklists: Array<Array<Array<object>>>,  // worklists[doerIndex] = ordered streak list
 *   overflow: Array<Array<object>>,          // streaks queued to the next round
 *   packed: boolean,                          // false = pass-through (no packing needed)
 * }}
 */
export function assignDoerWorklists(streaks, doerCount, opts = {}) {
    if (!Array.isArray(streaks) || streaks.length === 0
        || !Number.isInteger(doerCount) || doerCount < 1) {
        return { worklists: [], overflow: [], packed: false };
    }
    if (streaks.length <= doerCount) {
        return { worklists: streaks.map((s) => [s]), overflow: [], packed: false };
    }

    const effortBudget = typeof opts.effortBudget === 'number' && opts.effortBudget > 0
        ? opts.effortBudget
        : DEFAULT_EFFORT_THRESHOLD;
    const tierHomogeneous = opts.tierHomogeneous === true;

    // --- Descriptors -------------------------------------------------------
    const descs = streaks.map((streak, index) => ({
        streak,
        index,
        priority: streakMinPriority(streak),
        tierKey: streakRequiredTier(streak) || UNSPECIFIED_TIER_KEY,
        effort: streakEffortPoints(streak),
        beadIds: new Set(streak.map((b) => String(b && b.id))),
        depIndexes: new Set(),
    }));
    const descByBeadId = new Map();
    for (const d of descs) {
        for (const id of d.beadIds) descByBeadId.set(id, d);
    }
    for (const d of descs) {
        for (const bead of d.streak) {
            for (const depId of beadBlocksDependencyIds(bead)) {
                const other = descByBeadId.get(String(depId));
                if (other && other !== d) d.depIndexes.add(other.index);
            }
        }
    }

    // --- Global order: dependency (hard) -> priority -> input index --------
    // Kahn-style topological pass that, among the currently-unblocked streaks,
    // always picks the (priority, index)-minimal one, so dependency order wins
    // over priority and priority only orders mutually-independent streaks.
    const order = [];
    const remaining = new Set(descs.map((d) => d.index));
    while (remaining.size > 0) {
        let ready = [...remaining]
            .map((i) => descs[i])
            .filter((d) => [...d.depIndexes].every((di) => !remaining.has(di)));
        if (ready.length === 0) {
            // Dependency cycle between streaks (cannot happen for genuinely
            // ready beads; defensive) -- fall back to (priority, index) order
            // for the remainder rather than looping forever.
            ready = [...remaining].map((i) => descs[i]);
        }
        ready.sort((a, b) => a.priority - b.priority || a.index - b.index);
        const next = ready[0];
        order.push(next);
        remaining.delete(next.index);
    }

    // --- Packing: TIER-OUTLIER ISOLATION (partition-first) ------------------
    // Streaks are partitioned by tier before any priority/effort-budget
    // packing, and each partition's slot(s) pack independently, so a
    // minority-tier outlier is never folded into a majority-tier worklist and
    // silently escalated to that tier's cost. The global topo+priority order
    // applies WITHIN a partition; partitions are claimed in order of their
    // first appearance in that order, so the highest-priority work claims
    // slots first.
    //
    // A SLOT is not a doer: the returned worklists round-robin over the doer
    // pool at the dispatch site (worklists[i] -> doerPool[i % N]), so more
    // partitions than doers still all dispatch this round, sequentially on a
    // shared doer via the global FIFO gate. Sessions never carry across
    // worklists, so a shared doer's second worklist is tier-pure by
    // construction.
    const overflow = [];
    const overflowed = new Set();
    const slots = []; // { items: desc[], effort: number }
    const slotOfDesc = new Map(); // desc.index -> slot object

    const newSlot = () => {
        const slot = { items: [], effort: 0 };
        slots.push(slot);
        return slot;
    };
    const fits = (slot, d) => slot.items.length === 0 || slot.effort + d.effort <= effortBudget;
    const place = (slot, d) => {
        slot.items.push(d);
        slot.effort += d.effort;
        slotOfDesc.set(d.index, slot);
    };
    const spill = (d) => {
        overflow.push(d.streak);
        overflowed.add(d.index);
    };

    // Tier partitions, in order of each tier's first appearance in the global
    // order; members stay in global (topo -> priority -> tie-break) order.
    const partitions = [];
    const partitionByTier = new Map();
    for (const d of order) {
        if (!partitionByTier.has(d.tierKey)) {
            const p = { tierKey: d.tierKey, members: [], slots: [] };
            partitionByTier.set(d.tierKey, p);
            partitions.push(p);
        }
        partitionByTier.get(d.tierKey).members.push(d);
    }

    // Slot allocation. Every partition gets AT LEAST one dedicated slot
    // (outlier isolation: a 1-streak minority partition gets a whole slot of
    // its own before any majority partition gets a second one) -- EXCEPT in
    // the mixed-tiers-allowed case below when partitions outnumber doers.
    // When there are FEWER partitions than doers, the spare doer capacity is
    // handed out one slot at a time to the partition with the highest
    // per-slot load (ties: earliest partition), so e.g. 4 same-tier streaks
    // over 2 doers still split 2/2. Deterministic throughout.
    if (!tierHomogeneous && partitions.length > doerCount) {
        // Mixed tiers allowed and more partitions than doers: merge WHOLE
        // partitions into doerCount slots, each appended as its own contiguous
        // run so no tier's streaks interleave with another's. Each partition
        // joins the slot with the fewest streaks claimed so far, ties broken by
        // creation order. Claims are whole partitions, so balance on claimed
        // member counts rather than on items already placed.
        for (let i = 0; i < doerCount; i++) newSlot();
        const claimedCount = new Map(slots.map((s) => [s, 0]));
        for (const p of partitions) {
            const host = slots
                .map((slot, si) => ({ slot, si }))
                .sort((a, b) => claimedCount.get(a.slot) - claimedCount.get(b.slot) || a.si - b.si)[0].slot;
            p.slots = [host];
            claimedCount.set(host, claimedCount.get(host) + p.members.length);
        }
    } else {
        for (const p of partitions) {
            p.slots = [newSlot()];
        }
        let spare = doerCount - partitions.length;
        while (spare > 0) {
            let target = null;
            for (const p of partitions) {
                const load = p.members.length / p.slots.length;
                if (!target || load > target.members.length / target.slots.length) target = p;
            }
            if (!target) break;
            target.slots.push(newSlot());
            spare--;
        }
    }

    // Dependency gate: a streak whose in-round `blocks` dependency
    // overflowed, is not placed yet (cross-partition edges are placed in
    // partition order, and slots interleave at dispatch time, so order across
    // slots is never guaranteed), or whose placed dependencies span slots the
    // candidate set cannot honor, overflows to the next round (its dependency
    // closes first). Returns the single slot all placed deps share, `null`
    // for "no in-round dependency constraint", or `false` for "cannot place".
    const depSlotFor = (d) => {
        if (d.depIndexes.size === 0) return null;
        const depSlots = new Set();
        for (const di of d.depIndexes) {
            if (overflowed.has(di)) return false;
            if (!slotOfDesc.has(di)) return false; // not placed (yet) -> no order guarantee
            depSlots.add(slotOfDesc.get(di));
        }
        return depSlots.size === 1 ? [...depSlots][0] : false;
    };

    for (const p of partitions) {
        for (const d of p.members) {
            const depSlot = depSlotFor(d);
            if (depSlot === false) { spill(d); continue; }
            // Dependency co-location: the dependent must land in the SAME
            // slot AFTER its dependency -- but only if that slot is one this
            // partition may use (tier purity is never sacrificed for a
            // dependency; a cross-tier in-round edge overflows instead).
            const candidates = (depSlot !== null ? [depSlot] : p.slots)
                .filter((slot) => (depSlot === null || p.slots.includes(slot)) && fits(slot, d))
                .sort((a, b) => a.items.length - b.items.length || slots.indexOf(a) - slots.indexOf(b));
            if (candidates.length === 0) spill(d);
            else place(candidates[0], d);
        }
    }

    // Drop slots that ended up empty (a mixed-merge pre-created slot no
    // partition landed on, or a partition slot whose members all spilled).
    const worklists = slots
        .filter((slot) => slot.items.length > 0)
        // Worklist order within each slot = insertion order: contiguous tier
        // blocks (partition-by-partition placement), and inside each block
        // the global topo -> priority -> tie-break order (partition members
        // were placed in that order).
        .map((slot) => slot.items.map((d) => d.streak));

    return { worklists, overflow, packed: true };
}
