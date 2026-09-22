// sprint-doctor SYMPTOM/REMEDY REGISTRY (design:
// fleet-sprint/docs/escalate-to-llm-design.md section 4).
//
// Pure data plus one matcher. This file:
//   - has NO side effects beyond exporting frozen constants (a self-check at
//     load time throws if an entry is malformed, but performs no I/O and
//     nothing outside this module's own data),
//   - performs NO dispatching -- it never runs a remedy, never calls `bd`,
//     never touches git, never talks to a member,
//   - is the SOLE place a new "known" failure signature is added: adding
//     case #9 is a reviewed DATA change, not prompt engineering or a code
//     restructure (design doc section 4.1).
//
// Consumed by doctor-consult.mjs's loadRegistryEntries(), which imports this
// module lazily and optionally -- a missing or empty registry degrades to a
// zero-entries injection, never a consult failure. Wiring matchRegistry()
// into the runner's evidence assembly (deciding what `evidence` looks like
// at each real call site) is a separate, later lane; this module only has to
// be correct and complete on its own terms.
//
// GENERIC BY CONSTRUCTION (docs/generic-engine-boundary.md): every detection
// signature below keys off the engine's OWN structured dispatch reasons
// (errors.mjs) or a target-agnostic message shape -- never a target
// project's log text, repo name, build command or tracker prefix. The
// human-facing referral text below is likewise about THIS engine's own
// recovery surface (credentials, reservations, sessions, branches), never
// about any one target repository.
//
// EXPLICITLY EXCLUDED: stale-dolt-clone / Dolt-beads-sync wedging is NOT a
// registry entry, and adding one would be a design regression, not an
// oversight. `settleDoltConflicts()` resolves every row-level Dolt/beads-sync
// conflict shape deterministically, with zero LLM dispatch, wired at both
// divergence terminals of the sync module. Escalating that failure class to
// an LLM consult would reintroduce the no-guaranteed-rollback recovery class
// that deterministic settle path was built to eliminate. See the dolt-sync
// redesign doc, Parts 2, 7.4 and 8.4, for the full rationale.

import { VCS_FAILURE_KINDS } from './errors.mjs';

// ---------------------------------------------------------------------------
// The remedy verbs an executor can actually run today.
// ---------------------------------------------------------------------------
//
// Mirrors the remedy-verb vocabulary the action executor wires one-for-one
// (repair_environment_then_retry's registry-remedy dependency map). That map
// is private to its own module, and this module's own file scope is
// deliberately just this file plus its test, so the vocabulary is mirrored
// here by hand rather than imported. A registry entry naming a verb NOT in
// this list fails the self-check below at load time -- that is the
// enforcement the acceptance bar asks for ("every remedy verb names an
// executor enum value that actually exists"). Keep this array and the
// executor's dependency map in sync when either changes.
export const KNOWN_REMEDY_VERBS = Object.freeze([
    'reprovision_llm_auth',
    'reprovision_vcs_auth',
    'force_release_reservation',
    'stop_and_kill_session',
    'refetch_branch',
]);

/** The four legal `scope` values a detect block may declare. */
const KNOWN_SCOPES = Object.freeze(['member', 'bead', 'fleet']);

/** The four legal `fallback` values (design doc section 4.1). */
const KNOWN_FALLBACKS = Object.freeze(['retry-once', 'human', 'defer', 'escalate-unclear']);

/** The four legal `classification` values (design doc section 3). */
const KNOWN_CLASSIFICATIONS = Object.freeze(['ENVIRONMENT', 'ENGINE_FLAW', 'TASK_SHAPE', 'UNCLEAR']);

// ---------------------------------------------------------------------------
// Seed entries (design doc section 4.2, plus the two 2026-09-22 incidents).
// ---------------------------------------------------------------------------

const RAW_ENTRIES = [
    {
        id: 'stale-llm-credential',
        classification: 'ENVIRONMENT',
        detect: {
            reasons: ['auth', 'preflight_auth_missing', 'preflight_auth_expired'],
            signatureRe: /authentication failed|not logged in/i,
            scope: 'member',
        },
        remedy: { verb: 'reprovision_llm_auth', latch: 'once-per-member-per-sprint' },
        verify: { kind: 'redispatch-original' },
        fallback: 'human',
        humanReferralTemplate:
            'The LLM credential on member \'<member>\' could not be reprovisioned automatically. '
            + 'Local members typically authenticate through a host-level interactive login rather '
            + 'than a re-runnable provisioning step, so only running that login by hand on the '
            + 'member can fix it -- confirm which provisioning path the member uses before retrying.',
    },
    {
        id: 'stale-vcs-credential',
        classification: 'ENVIRONMENT',
        detect: {
            reasons: [VCS_FAILURE_KINDS.AUTH_EXPIRED],
            signatureRe: /authentication failed|not logged in|could not read username|permission denied/i,
            scope: 'member',
        },
        remedy: { verb: 'reprovision_vcs_auth', latch: 'once-per-member-per-sprint' },
        verify: { kind: 'redispatch-original' },
        fallback: 'human',
        humanReferralTemplate:
            'The version-control credential on member \'<member>\' could not be reprovisioned '
            + 'automatically. If the identity is understood but refused rather than merely stale, '
            + 'no amount of re-minting the same credential will fix it -- an operator must grant '
            + 'the missing access directly before this member can push or fetch again.',
    },
    {
        id: 'wedged-reservation',
        classification: 'ENVIRONMENT',
        detect: {
            reasons: ['reserved'],
            signatureRe: /already reserved by/i,
            scope: 'member',
        },
        remedy: { verb: 'force_release_reservation', latch: 'once-per-member-per-sprint' },
        verify: { kind: 'reserve-succeeds' },
        fallback: 'human',
        humanReferralTemplate:
            'Member \'<member>\' is held by a reservation this consult could not confirm as dead. '
            + 'Never force-release a reservation whose owning run is still alive -- check that '
            + 'owning run\'s own liveness/watchdog state directly before clearing the reservation '
            + 'by hand.',
    },
    {
        id: 'hung-remote-session',
        classification: 'ENVIRONMENT',
        detect: {
            reasons: ['stalled', 'orphan_recovery_timeout'],
            signatureRe: /probe timed out|no response|session appears stuck|unresponsive/i,
            scope: 'member',
        },
        remedy: { verb: 'stop_and_kill_session', latch: 'once-per-member-per-sprint' },
        verify: { kind: 'redispatch-original' },
        fallback: 'human',
        humanReferralTemplate:
            'Member \'<member>\' does not respond even to a trivial version probe after an attempt '
            + 'to stop and kill its session. Whatever is wedged sits below the CLI layer this '
            + 'consult can reach (the transport channel or the host itself) -- an operator needs '
            + 'to intervene on the member directly, then confirm a trivial command succeeds before '
            + 'resuming work on it.',
    },
    {
        id: 'branch-not-synced-false-alarm',
        classification: 'ENVIRONMENT',
        detect: {
            reasons: [],
            signatureRe: /couldn't find remote ref/i,
            scope: 'member',
        },
        remedy: { verb: 'refetch_branch', latch: 'once-per-member-per-sprint' },
        verify: { kind: 'ref-present' },
        fallback: 'retry-once',
        humanReferralTemplate:
            'A member repeatedly cannot find the sprint branch on the remote after a bounded wait '
            + 'and refetch. Confirm the branch was actually pushed by whichever member created it, '
            + 'and that this member\'s remote configuration points at the same repository, before '
            + 'assuming anything is broken beyond ordinary push/fetch timing.',
    },
    {
        id: 'member-cli-version-drift',
        classification: 'ENVIRONMENT',
        detect: {
            // Mechanically unmatchable from a dispatch failure's reason or
            // message alone: the signal is a probed version string compared
            // against a fleet baseline, which only exists after a probe
            // round runs. `signatureRe: null` documents that on purpose
            // rather than guessing at a message shape that does not exist.
            reasons: [],
            signatureRe: null,
            scope: 'member',
        },
        remedy: { verb: null, latch: 'none' },
        verify: { kind: 'none' },
        fallback: 'human',
        humanReferralTemplate:
            'Member \'<member>\' is running a CLI version that differs from the fleet baseline. '
            + 'Mid-sprint upgrades are riskier than the drift itself, so no in-sprint remedy is '
            + 'attempted -- update the member\'s CLI between sprints instead.',
    },
    {
        id: 'deferred-in-scope-never-dispatched',
        classification: 'ENGINE_FLAW',
        detect: {
            // Not a single dispatch failure: the signal is an aggregate
            // scope-summary shape (every remaining not-done bead at goal
            // priority is deferred, and nothing has been dispatched since),
            // so `reasons`/`signatureRe` are deliberately empty and matching
            // instead requires `requiresScopeSummary` evidence -- see
            // matchRegistry() below.
            reasons: [],
            signatureRe: null,
            scope: 'fleet',
            requiresScopeSummary: true,
        },
        remedy: { verb: null, latch: 'once-per-scope-per-sprint' },
        verify: { kind: 'progress-score-moves-or-pass' },
        fallback: 'human',
        humanReferralTemplate:
            'This scope has no dispatchable work left: every remaining not-done bead at goal '
            + 'priority is deferred and nothing has been dispatched since. If a deferred bead is '
            + 'still meaningful, restore it to open so it can be picked up again; if its parent is '
            + 'already closed with the acceptance evidence satisfied, no restoration is needed and '
            + 'the next evaluation should finish the sprint rather than report it stalled.',
    },
    {
        id: 'provider-tool-registry-mismatch',
        classification: 'ENGINE_FLAW',
        detect: {
            reasons: [],
            signatureRe: /unknown tool|unrecognized tool|tool[^.]*not (?:found|recognized|registered)|invalid tool name/i,
            scope: 'member',
        },
        remedy: { verb: null, latch: 'none' },
        verify: { kind: 'none' },
        fallback: 'human',
        humanReferralTemplate:
            'Every agent-mode dispatch on member \'<member>\' is failing before the model even '
            + 'runs, because the installed role-agent file lists tools the provider CLI does not '
            + 'recognize. This is a construction-time mismatch, not a flaky dispatch or a task-shape '
            + 'problem, and no in-sprint remedy can fix it -- reinstall this member\'s agent files '
            + 'once the underlying mismatch is corrected, then resume; continuing to dispatch to it '
            + 'meanwhile only degrades role by role.',
    },
];

// ---------------------------------------------------------------------------
// Freeze + self-check.
// ---------------------------------------------------------------------------

function freezeEntry(raw) {
    const detect = Object.freeze({ ...raw.detect, reasons: Object.freeze([...raw.detect.reasons]) });
    const remedy = Object.freeze({ ...raw.remedy });
    const verify = Object.freeze({ ...raw.verify });
    return Object.freeze({ ...raw, detect, remedy, verify });
}

export const REGISTRY_ENTRIES = Object.freeze(RAW_ENTRIES.map(freezeEntry));

/**
 * Self-check run once at module load: every entry carries the four
 * mandatory field groups (detect/remedy/verify/fallback) plus id and
 * classification, every scope/classification/fallback value is one of the
 * closed enums, and every non-null remedy verb is one the executor actually
 * knows how to run (KNOWN_REMEDY_VERBS above). Throwing here -- rather than
 * only in a test -- makes a malformed entry impossible to ship silently,
 * since anything that imports this module (loadRegistryEntries() included)
 * would fail immediately.
 */
(function selfCheck(entries) {
    const seenIds = new Set();
    for (const entry of entries) {
        if (!entry.id || typeof entry.id !== 'string') {
            throw new Error('doctor-registry: an entry is missing its id');
        }
        if (seenIds.has(entry.id)) {
            throw new Error(`doctor-registry: duplicate entry id '${entry.id}'`);
        }
        seenIds.add(entry.id);

        if (!KNOWN_CLASSIFICATIONS.includes(entry.classification)) {
            throw new Error(`doctor-registry: entry '${entry.id}' has an unknown classification '${entry.classification}'`);
        }
        if (!entry.detect || !Array.isArray(entry.detect.reasons) || !KNOWN_SCOPES.includes(entry.detect.scope)) {
            throw new Error(`doctor-registry: entry '${entry.id}' has a malformed detect block`);
        }
        if (entry.detect.signatureRe !== null && !(entry.detect.signatureRe instanceof RegExp)) {
            throw new Error(`doctor-registry: entry '${entry.id}' has a non-RegExp, non-null signatureRe`);
        }
        if (!entry.remedy || typeof entry.remedy.latch !== 'string') {
            throw new Error(`doctor-registry: entry '${entry.id}' has a malformed remedy block`);
        }
        if (entry.remedy.verb !== null && !KNOWN_REMEDY_VERBS.includes(entry.remedy.verb)) {
            throw new Error(
                `doctor-registry: entry '${entry.id}' names remedy verb '${entry.remedy.verb}', `
                + 'which is not a known executor verb',
            );
        }
        if (!entry.verify || typeof entry.verify.kind !== 'string' || !entry.verify.kind) {
            throw new Error(`doctor-registry: entry '${entry.id}' has a malformed verify block`);
        }
        if (!KNOWN_FALLBACKS.includes(entry.fallback)) {
            throw new Error(`doctor-registry: entry '${entry.id}' has an unknown fallback '${entry.fallback}'`);
        }
        if (typeof entry.humanReferralTemplate !== 'string' || !entry.humanReferralTemplate.trim()) {
            throw new Error(`doctor-registry: entry '${entry.id}' is missing a humanReferralTemplate`);
        }
    }
})(REGISTRY_ENTRIES);

// ---------------------------------------------------------------------------
// matchRegistry(evidence) -- the pure matcher.
// ---------------------------------------------------------------------------

/**
 * True when a scope-summary object matches the aggregate shape
 * `deferred-in-scope-never-dispatched` detects: nothing left open at goal
 * priority, at least one bead deferred at goal priority, and nothing
 * dispatched since the last defer.
 * @param {{openAtGoalCount?: number, deferredAtGoalCount?: number, dispatchedSinceDeferCount?: number}|null|undefined} summary
 * @returns {boolean}
 */
function scopeSummaryMatches(summary) {
    if (!summary || typeof summary !== 'object') return false;
    const openAtGoal = Number(summary.openAtGoalCount ?? 0);
    const deferredAtGoal = Number(summary.deferredAtGoalCount ?? 0);
    const dispatchedSinceDefer = Number(summary.dispatchedSinceDeferCount ?? 0);
    return openAtGoal === 0 && deferredAtGoal > 0 && dispatchedSinceDefer === 0;
}

/**
 * Returns the best-matching registry entry for the given evidence, or null
 * when nothing matches. Pure: no I/O, no dispatch, no mutation of `evidence`
 * or of the registry.
 *
 * Matching rules per entry:
 *   - `detect.scope` must equal `evidence.scope` whenever both are set
 *     (an entry with no scope opinion, or evidence with none, always passes
 *     this check).
 *   - An entry whose `detect.requiresScopeSummary` is true matches only via
 *     `scopeSummaryMatches(evidence.scopeSummary)` -- its `reasons`/
 *     `signatureRe` are deliberately unused for this aggregate shape.
 *   - Otherwise: `detect.reasons` (if non-empty) must include the evidence's
 *     reason token (`evidence.reason`, falling back to `evidence.vcsKind`),
 *     and `detect.signatureRe` (if set) must test true against the
 *     evidence's text (`evidence.message`, falling back to
 *     `evidence.errorSignature`). When both are present on the entry, BOTH
 *     must match (AND). When only one is present, that one alone decides.
 *     An entry with neither (e.g. member-cli-version-drift) can never
 *     mechanically match here -- it exists for its documentation and its
 *     humanReferralTemplate, not to be auto-selected from ledger evidence.
 *   - Entries are checked in registry order; the first match wins.
 *
 * @param {{
 *   reason?: string|null,
 *   vcsKind?: string|null,
 *   message?: string|null,
 *   errorSignature?: string|null,
 *   scope?: 'member'|'bead'|'fleet'|null,
 *   scopeSummary?: {openAtGoalCount?: number, deferredAtGoalCount?: number, dispatchedSinceDeferCount?: number}|null,
 * }} [evidence]
 * @returns {object|null}
 */
export function matchRegistry(evidence = {}) {
    if (!evidence || typeof evidence !== 'object') return null;

    const reasonToken = evidence.reason ?? evidence.vcsKind ?? null;
    const text = String(evidence.message ?? evidence.errorSignature ?? '');

    for (const entry of REGISTRY_ENTRIES) {
        const { detect } = entry;

        if (detect.scope && evidence.scope && detect.scope !== evidence.scope) continue;

        if (detect.requiresScopeSummary) {
            if (scopeSummaryMatches(evidence.scopeSummary)) return entry;
            continue;
        }

        const reasonListed = detect.reasons.length > 0;
        const hasSignature = detect.signatureRe instanceof RegExp;
        if (!reasonListed && !hasSignature) continue;

        const reasonOk = !reasonListed || (reasonToken != null && detect.reasons.includes(reasonToken));
        const sigOk = !hasSignature || detect.signatureRe.test(text);

        if (reasonListed && hasSignature) {
            if (reasonOk && sigOk) return entry;
        } else if (reasonListed) {
            if (reasonOk) return entry;
        } else if (sigOk) {
            return entry;
        }
    }
    return null;
}
