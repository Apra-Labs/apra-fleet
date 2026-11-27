// =============================================================================
// fleet-sprint supervisor -- the stable top-level sprint summary served by
// GET /api/sprints/:id and on every GET /api/sprints row
// =============================================================================
//
// Sources (design choice, documented in docs/supervisor-api.md "GET
// /api/sprints/:id: the summary shape"):
//
//   * The child's own run summary (GET /state?summary=1, run-summary.mjs in
//     apra-fleet-workflow): status, phase title, startedAt, live
//     elapsedMs/durationMs, pause, cost and tokens. It is never lean-encoded,
//     so no ref marker or string table can reach these fields. For a sprint
//     that already ended, the same summary persisted inside its terminal run
//     state is used, falling back to the state's own top-level fields.
//   * The phase KIND, cycle and round are parsed HERE, from the fleet-sprint
//     phase title (for example 'Develop C1 R2', 'Final Review C3',
//     'Ensure Sprint Branch'). The workflow core stays free of fleet-sprint
//     vocabulary: it only ever publishes the title. The supervisor is
//     fleet-sprint's own service, so knowing that title grammar belongs here.
//   * maxCycles and the PR source/target branches come from the ledger
//     reservation (the launch's maxCycles, branch and base). maxCycles is
//     null when the launch did not set it (the engine then applies its own
//     default).
// =============================================================================

/** Every top-level summary field, in documented order. */
export const SPRINT_SUMMARY_FIELDS = Object.freeze([
    'sprintId', 'live', 'status', 'phase', 'phaseKind', 'cycle', 'maxCycles', 'round',
    'startedAt', 'elapsedMs', 'durationMs', 'cost', 'tokens', 'pause',
    'prSourceBranch', 'prTargetBranch',
]);

// '<Name> C<cycle>[ R<round>][ <anything>]': the fleet-sprint phase title
// grammar. Cycle labels may carry a suffix (e.g. a final-cycle label), so only
// the leading digits are read.
const PHASE_TITLE_RE = /^(.*?)\s+C(\d+)\S*(?:\s+R(\d+)\b)?/;

/**
 * Parses a fleet-sprint phase title into its kind, cycle and round.
 * 'Develop C1 R2' -> { phaseKind: 'develop', cycle: 1, round: 2 };
 * 'Final Review C3' -> { phaseKind: 'final-review', cycle: 3, round: null };
 * 'Ensure Sprint Branch' -> { phaseKind: 'ensure-sprint-branch', cycle: null, round: null }.
 * @param {string|null|undefined} title
 * @returns {{ phaseKind: string|null, cycle: number|null, round: number|null }}
 */
export function parsePhaseTitle(title) {
    if (typeof title !== 'string' || title.trim().length === 0) return { phaseKind: null, cycle: null, round: null };
    const kind = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
    const m = PHASE_TITLE_RE.exec(title.trim());
    if (!m) return { phaseKind: kind(title), cycle: null, round: null };
    return {
        phaseKind: kind(m[1]),
        cycle: Number.parseInt(m[2], 10),
        round: m[3] !== undefined ? Number.parseInt(m[3], 10) : null,
    };
}

/**
 * The run summary of a persisted run state: its own `summary` object when it
 * has one, else one derived from the state's top-level fields.
 * @param {object|null|undefined} state
 * @returns {object|null}
 */
export function runSummaryFromState(state) {
    if (!state || typeof state !== 'object') return null;
    if (state.summary && typeof state.summary === 'object' && !Array.isArray(state.summary)) return state.summary;
    const stats = state.stats && typeof state.stats === 'object' ? state.stats : {};
    const duration = typeof stats.durationMs === 'number' ? stats.durationMs : 0;
    return {
        status: typeof state.status === 'string' ? state.status : null,
        startedAt: typeof state.startedAt === 'string' ? state.startedAt : null,
        elapsedMs: duration,
        durationMs: duration,
        phase: null,
        pause: state.pause ?? null,
        stats: { totalCost: stats.totalCost ?? 0, totalTokens: stats.totalTokens ?? 0 },
    };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Builds the stable top-level summary. Every field in SPRINT_SUMMARY_FIELDS is
 * always present (null when unknown).
 * @param {{ sprintId: string, live: boolean, runSummary?: object|null, reservation?: object|null, status?: string|null }} input
 *   `status` overrides the run summary's status (used for a sprint known only
 *   from history).
 * @returns {object}
 */
export function buildSprintSummary({ sprintId, live, runSummary = null, reservation = null, status = null }) {
    const s = runSummary && typeof runSummary === 'object' ? runSummary : {};
    const phase = str(s.phase);
    const { phaseKind, cycle, round } = parsePhaseTitle(phase);
    const stats = s.stats && typeof s.stats === 'object' ? s.stats : {};
    const r = reservation && typeof reservation === 'object' ? reservation : {};
    const pause = s.pause && typeof s.pause === 'object' ? s.pause : null;
    return {
        sprintId,
        live: Boolean(live),
        status: status ?? str(s.status),
        phase,
        phaseKind,
        cycle,
        maxCycles: Number.isInteger(r.maxCycles) ? r.maxCycles : null,
        round,
        startedAt: str(s.startedAt),
        elapsedMs: num(s.elapsedMs),
        durationMs: num(s.durationMs),
        cost: num(stats.totalCost),
        tokens: num(stats.totalTokens),
        pause,
        prSourceBranch: str(r.branch),
        prTargetBranch: str(r.base),
    };
}
