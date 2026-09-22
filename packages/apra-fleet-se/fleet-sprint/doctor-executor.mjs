// sprint-doctor ACTION EXECUTOR -- re-plan lane only (design:
// fleet-sprint/docs/escalate-to-llm-design.md sections 2.1 and 2.5).
//
// THE FOURTH and last of the doctor's modules, and the ONLY one that ever
// changes anything. doctor-ledger.mjs records what happened,
// doctor-triggers.mjs decides something is wrong, doctor-consult.mjs asks the
// question -- and this file turns the answer into engine verbs.
//
// SCOPE, STATED UP FRONT SO IT IS NOT ACCIDENTALLY WIDENED. This module
// implements the five RE-PLAN actions and nothing else: the answer to a doer
// that reported BLOCKED. The general executor covering every doctor verdict
// action (repair_environment_then_retry, retry_same, retry_different_member,
// swap_model_tier, defer_bead, abort_sprint, pause_for_human, the salvage-WIP
// pre-step, the symptom/remedy registry) is a separate, later lane. It is
// shaped as a TABLE from action.kind to an existing verb precisely so that
// later lane extends REPLAN_EXECUTOR_TABLE with more rows instead of
// rewriting this file's control flow.
//
// THE THREE INVARIANTS THIS FILE EXISTS TO HOLD
//
//   1. EXISTING VERBS ONLY. Every mutation below is `bd update` (through the
//      injected command()), the caller's own child-bead creation verb, or the
//      caller's own credential-provisioning verb. This module opens no
//      transport, shells nothing itself, imports no runner module, and knows
//      nothing about members, allocators or providers -- they arrive as
//      injected callbacks. That is what keeps the blast radius of a bad
//      verdict equal to the blast radius of the verbs the engine already
//      trusted before the doctor existed.
//
//   2. THE DOCTOR NEVER EDITS A BEAD. The verdict is data; this file (called
//      by the runner) is the only actor. The doctor is dispatched with zero
//      tools, so that boundary is structural rather than promised -- and
//      keeping the application here, behind a schema-validated payload, is
//      the other half of it.
//
//   3. NO RE-DISPATCH WITHOUT A REAL CHANGE. `changed` is set ONLY when a
//      content-mutating verb actually ran and succeeded, and `redispatch`
//      implies `changed`. A verdict that restates a bead as it already reads
//      therefore cannot hand it back to a doer to fail the same way again --
//      which is the precise failure mode ("re-dispatch the bead unchanged")
//      the BLOCKED lane exists to stop.
//
// NEVER THROWS INTO THE CYCLE LOOP, same posture as doctor-consult.mjs: every
// failure is caught, reported in the returned result's `error`, and logged.
// The worst case is "the bead stays excluded and is not re-dispatched", which
// is exactly the pre-re-plan behaviour.
//
// GENERIC BY CONSTRUCTION (docs/generic-engine-boundary.md): nothing here
// names a target project, its repo layout, its build commands or a tracker
// prefix. The only literal command text is `bd update` and its flags, which
// are the engine's own tracker contract.

import { sanitizePrText } from './sprint-report.mjs';

const LOG_PREFIX = '[sprint-doctor]';

/**
 * Labels this module may add to a bead. Engine-owned and fixed, never
 * doctor-authored: a label is queryable state an operator will filter on, so
 * letting an LLM mint label names would make the vocabulary unusable within
 * one sprint. A doctor-supplied `addLabels` entry is still honoured, but it
 * goes through the same allowlist sanitizer every other free-text field does.
 */
export const DOCTOR_LABELS = Object.freeze({
    /** The doctor re-planned this bead; the original wording failed a doer. */
    replanned: 'doctor-replanned',
    /** The bead is held for an access escalation only a human can make. */
    awaitingGrant: 'doctor-awaiting-grant',
    /** The orchestrator performed the escalation itself; the bead is workable. */
    grantApplied: 'doctor-grant-applied',
});

/** Grant kinds the orchestrator can perform itself through an existing provisioning path. */
export const ORCHESTRATOR_GRANTABLE = Object.freeze(['vcs_auth', 'llm_auth']);

/** Labels are queried and scripted against; keep them to an inert, portable charset. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * THE TABLE. action.kind -> the existing verb it maps to, plus the three
 * booleans the runner needs to decide what happens to the bead next.
 *
 * `verb` is documentation with teeth: it is written into the bead's own
 * comment, so an operator reading the bead sees WHICH engine verb touched it
 * rather than only that "the doctor did something".
 *
 * `redispatchOnChange` is the re-plan half of the BLOCKED contract: true
 * means "if this actually changed the bead, the runner may hand it back to a
 * doer". False means the bead deliberately leaves the doer lane (it is now
 * verify-routed, parked, or waiting on a human) and re-dispatching it would
 * be the bug.
 *
 * `credits` marks the two kinds that must be excluded from the stagnation
 * math rather than counted as an open blocker: a bead waiting on a human
 * grant, and a bead deferred with credit. Both are states the sprint chose on
 * purpose; reading them as "no progress" would wedge a sprint for doing the
 * right thing.
 */
export const REPLAN_EXECUTOR_TABLE = Object.freeze({
    replan_rewrite: Object.freeze({
        verb: 'bd update --title/--body-file/--acceptance',
        summary: 'rewrote the bead into work the doer can complete from its seat',
        redispatchOnChange: true,
        credits: false,
    }),
    replan_rescope: Object.freeze({
        verb: 'bd update (verify part) + child-bead create (doer part)',
        summary: 'split the bead into a doer-doable child and a verify-set remainder',
        redispatchOnChange: false,
        credits: false,
    }),
    replan_route: Object.freeze({
        verb: 'bd update --type/--add-label/--remove-label',
        summary: 'retyped/relabelled the bead onto the role seat that can actually close it',
        redispatchOnChange: true,
        credits: false,
    }),
    replan_grant: Object.freeze({
        verb: 'existing credential provisioning path + bd update --add-label',
        summary: 'answered an access block with a specific escalation',
        redispatchOnChange: true,
        credits: false,
    }),
    replan_defer_with_credit: Object.freeze({
        verb: 'bd update --status=deferred',
        summary: 'parked the bead with stagnation credit -- nothing in this sprint can unblock it',
        redispatchOnChange: false,
        credits: true,
    }),
});

/** The five kinds, derived from the table so the two can never disagree. */
export const REPLAN_ACTION_KINDS = Object.freeze(Object.keys(REPLAN_EXECUTOR_TABLE));

/**
 * True when `kind` is one of the re-plan actions this executor implements.
 * Callers use it to tell a re-plan verdict from an incident verdict WITHOUT
 * re-listing the kinds at the call site.
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isReplanAction(kind) {
    return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(REPLAN_EXECUTOR_TABLE, kind);
}

/**
 * The bead id a re-plan verdict is about: `action.replan.beadId` first, then
 * `action.beadIds[0]`, then the caller's own scope. Returns null when the
 * verdict names none and the caller supplied none, which the executor treats
 * as a refusal rather than guessing.
 * @param {object} verdict
 * @param {string[]} [fallbackBeadIds]
 * @returns {string|null}
 */
export function replanBeadId(verdict, fallbackBeadIds = []) {
    const action = (verdict && verdict.action) || {};
    const replan = action.replan || {};
    const candidates = [replan.beadId, ...(action.beadIds || []), ...(fallbackBeadIds || [])];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
    }
    return null;
}

/** Keeps only labels that are inert in a shell command and usable as a query filter. */
function sanitizeLabels(labels) {
    return [...new Set((Array.isArray(labels) ? labels : []).map((l) => String(l).trim()))]
        .filter((l) => LABEL_RE.test(l));
}

/**
 * The comment written onto the bead for every applied (or refused) re-plan.
 *
 * WHY EVERY VERDICT GETS ONE, EVEN A FAILED APPLICATION: the bead is the only
 * artifact that outlives the run. A bead that silently changed shape mid-
 * sprint, or that silently stopped being dispatched, is indistinguishable
 * from an engine bug when a human reads it a week later. The comment carries
 * the classification, the mapped verb, the doctor's evidence verbatim (design
 * doc section 2.3) and the outcome, so the bead explains itself.
 *
 * Single-line and sanitized: it is interpolated into `bd update
 * --append-notes "<text>"`, and a literal newline inside a double-quoted
 * command-string argument is not reliably safe across mixed POSIX/PowerShell
 * member shells (the same constraint sanitizePrText exists for).
 *
 * @param {object} verdict the schema-valid re-plan verdict
 * @param {{ kind: string, applied: boolean, cycle?: number|string, detail?: string }} outcome
 * @returns {string}
 */
export function buildReplanComment(verdict, outcome) {
    const entry = REPLAN_EXECUTOR_TABLE[outcome.kind];
    const parts = [
        `[sprint-doctor${outcome.cycle === undefined ? '' : ` C${outcome.cycle}`}]`,
        `${outcome.applied ? 'Applied' : 'REFUSED'} re-plan ${outcome.kind}`,
        `via ${entry ? entry.verb : 'no mapped verb'}.`,
        `Classification ${verdict.classification} (confidence ${verdict.confidence}).`,
    ];
    const evidence = Array.isArray(verdict.evidence) ? verdict.evidence : [];
    if (evidence.length > 0) parts.push(`Evidence: ${evidence.join(' | ')}.`);
    const reason = (verdict.action && verdict.action.replan && verdict.action.replan.reason)
        || (verdict.action && verdict.action.reason);
    if (reason) parts.push(`Reason: ${reason}.`);
    if (outcome.detail) parts.push(outcome.detail);
    return sanitizePrText(parts.join(' '));
}

/**
 * Applies ONE re-plan verdict to ONE bead, through existing verbs, and writes
 * the verdict plus its evidence onto the bead as a comment.
 *
 * Ordering is deliberate: the content mutations run FIRST and the comment
 * LAST, so the comment can report what actually happened rather than what was
 * intended -- and so a failed mutation still leaves a bead that says why.
 *
 * @param {object} verdict a schema-valid verdict whose action.kind is a re-plan kind
 * @param {{
 *   command: Function,
 *   member: string,
 *   log?: Function,
 *   cycle?: number|string,
 *   beadIds?: string[],
 *   stageBody?: (content: string, label: string) => Promise<string>,
 *   createChild?: (part: { title: string, description: string, acceptance: string, parentId: string }) => Promise<{ childId: string|null }>,
 *   provisionGrant?: (grant: object) => Promise<boolean>,
 * }} deps
 * @returns {Promise<{
 *   applied: boolean, kind: string|null, beadId: string|null,
 *   changed: boolean, redispatch: boolean, credit: boolean,
 *   grantAwaiting: boolean, verifyRouted: boolean,
 *   createdChildId: string|null, verb: string|null, error: string|null,
 * }>}
 */
export async function applyReplanVerdict(verdict, deps = {}) {
    const log = deps.log || (() => {});
    const action = (verdict && verdict.action) || {};
    const kind = action.kind;
    const result = {
        applied: false,
        kind: isReplanAction(kind) ? kind : null,
        beadId: null,
        changed: false,
        redispatch: false,
        credit: false,
        grantAwaiting: false,
        verifyRouted: false,
        createdChildId: null,
        verb: isReplanAction(kind) ? REPLAN_EXECUTOR_TABLE[kind].verb : null,
        error: null,
    };

    if (!isReplanAction(kind)) {
        result.error = `action.kind "${kind}" is not a re-plan action; this executor implements only [${REPLAN_ACTION_KINDS.join(', ')}]`;
        log(`${LOG_PREFIX} re-plan not applied: ${result.error}.`);
        return result;
    }
    if (typeof deps.command !== 'function' || !deps.member) {
        result.error = 'no command verb or orchestrator member was provided, so nothing can be applied';
        log(`${LOG_PREFIX} re-plan not applied: ${result.error}.`);
        return result;
    }

    const beadId = replanBeadId(verdict, deps.beadIds);
    if (!beadId) {
        result.error = 'the verdict named no bead and none was in scope';
        log(`${LOG_PREFIX} re-plan not applied: ${result.error}.`);
        return result;
    }
    result.beadId = beadId;

    const replan = action.replan || {};
    const run = (cmd, label) => deps.command(cmd, { member_name: deps.member, silent: true, label });

    try {
        switch (kind) {
            case 'replan_rewrite':
                result.changed = await applyContentUpdate(beadId, replan, deps, run);
                break;
            case 'replan_rescope':
                await applyRescope(beadId, replan, deps, run, result);
                break;
            case 'replan_route':
                await applyRoute(beadId, replan, deps, run, result);
                break;
            case 'replan_grant':
                await applyGrant(beadId, replan, deps, run, result);
                break;
            case 'replan_defer_with_credit':
                await run(`bd update ${beadId} --status=deferred`, `Sprint Doctor: defer ${beadId} with credit`);
                result.changed = true;
                break;
            default:
                break;
        }
        result.applied = true;
    } catch (err) {
        // Never throws into the cycle loop: the bead simply stays excluded and
        // un-re-dispatched, which is the pre-re-plan behaviour.
        result.error = (err && err.message) || String(err);
        result.applied = false;
        result.changed = false;
        log(`${LOG_PREFIX} re-plan ${kind} for ${beadId} FAILED to apply: ${result.error}. `
            + 'The bead is left as it was and is not re-dispatched.');
    }

    const entry = REPLAN_EXECUTOR_TABLE[kind];
    // `redispatch` IMPLIES `changed` -- this single expression is invariant 3.
    // A grant the orchestrator satisfied itself, and only that, may re-enter
    // the doer lane on a label-only change: the bead's blocking condition is
    // genuinely gone. A grant still awaiting a human may not.
    result.redispatch = Boolean(result.applied && result.changed && entry.redispatchOnChange && !result.grantAwaiting && !result.verifyRouted);
    result.credit = Boolean(entry.credits || result.grantAwaiting);

    // ALWAYS last, ALWAYS best-effort: the bead must carry the verdict and its
    // evidence even when the application failed, and a notes-append failure
    // must not turn a successful re-plan into a reported failure.
    const detail = [
        result.createdChildId ? `Created child ${result.createdChildId} for the doer-doable part.` : '',
        result.grantAwaiting ? 'Awaiting a human grant; excluded from the stagnation math until it lands.' : '',
        result.verifyRouted ? 'Routed to the verify set -- a test-runner role closes it on evidence.' : '',
        result.redispatch ? 'Bead content changed, so it is eligible for dispatch again.' : 'Not re-dispatched by this re-plan.',
        result.error ? `Executor error: ${result.error}` : '',
    ].filter(Boolean).join(' ');
    const comment = buildReplanComment(verdict, { kind, applied: result.applied, cycle: deps.cycle, detail });
    try {
        await run(
            `bd update ${beadId} --append-notes "${comment}"`,
            `Sprint Doctor: record re-plan verdict on ${beadId}`,
        );
    } catch (err) {
        log(`${LOG_PREFIX} re-plan verdict comment could not be written to ${beadId} (non-fatal): `
            + `${(err && err.message) || err}. Verdict preserved VERBATIM in this run log: ${comment}`);
    }

    log(`${LOG_PREFIX} re-plan ${kind} on ${beadId}: ${result.applied ? 'applied' : 'REFUSED'} via ${entry.verb} `
        + `-- ${entry.summary}. changed=${result.changed}, redispatch=${result.redispatch}, credit=${result.credit}.`);
    return result;
}

/**
 * The shared content mutation behind rewrite/rescope/route: title, body,
 * acceptance, type and labels, in ONE `bd update`.
 *
 * The description goes through the caller's `stageBody` verb (a member-local
 * temp file handed to `--body-file`) rather than being interpolated into the
 * command string -- the same treatment reviewer-authored newTask descriptions
 * already get, and the only way a multi-paragraph body survives a shell at
 * all. When no stageBody verb is available the body is sanitized to a single
 * safe line instead of being dropped: a shorter honest description still
 * unblocks a doer, whereas silently keeping the old one re-dispatches the
 * bead unchanged.
 *
 * @returns {Promise<boolean>} whether anything was actually written
 */
async function applyContentUpdate(beadId, replan, deps, run) {
    const flags = [];
    const title = sanitizePrText(replan.title || '');
    if (title) flags.push(`--title "${title}"`);

    const description = typeof replan.description === 'string' ? replan.description.trim() : '';
    if (description) {
        if (typeof deps.stageBody === 'function') {
            const bodyFile = await deps.stageBody(description, `Stage sprint-doctor re-plan body for ${beadId}`);
            flags.push(`--body-file "${bodyFile}"`);
        } else {
            flags.push(`--description "${sanitizePrText(description)}"`);
        }
    }

    const acceptance = sanitizePrText(replan.acceptance || '');
    if (acceptance) flags.push(`--acceptance "${acceptance}"`);
    if (replan.issueType) flags.push(`--type ${sanitizePrText(replan.issueType).replace(/[^a-z]/gi, '')}`);
    for (const label of sanitizeLabels(replan.addLabels)) flags.push(`--add-label ${label}`);
    for (const label of sanitizeLabels(replan.removeLabels)) flags.push(`--remove-label ${label}`);

    if (flags.length === 0) return false;
    flags.push(`--add-label ${DOCTOR_LABELS.replanned}`);
    await run(`bd update ${beadId} ${flags.join(' ')}`, `Sprint Doctor: re-plan ${beadId}`);
    return true;
}

/**
 * rescope: the original bead KEEPS the part only a test-runner can close and
 * becomes the verify-set parent; the doer-doable part becomes a child bead.
 *
 * This is not a new routing mechanism -- it is the engine's existing one.
 * classifyVerifySet() already treats a bead whose every child is closed as
 * implementation-complete and routes it to the integration-test runner to be
 * closed on evidence. So creating the doer part AS A CHILD is exactly what
 * turns the original bead into a verify-set bead: when the doer closes the
 * child, the parent becomes eligible by the rule that already exists.
 *
 * Refuses (rather than half-applies) when no child-create verb was injected:
 * rewriting the parent into an evidence-only bead with no doer part would
 * leave work nobody is assigned to do.
 */
async function applyRescope(beadId, replan, deps, run, result) {
    const split = Array.isArray(replan.split) ? replan.split : [];
    const doerPart = split.find((p) => p && p.role === 'doer');
    const verifyParts = split.filter((p) => p && p !== doerPart);

    if (!doerPart || verifyParts.length === 0) {
        throw new Error('replan_rescope needs both a doer part and at least one non-doer verify part in `split`');
    }
    if (typeof deps.createChild !== 'function') {
        throw new Error('replan_rescope needs a child-bead creation verb, and none was injected for this run');
    }

    // The parent first: it must already describe the verify part before the
    // child exists, so a crash between the two leaves a coherent bead rather
    // than a parent still claiming to be the doer work its child now is.
    const verifyPart = verifyParts[0];
    result.changed = await applyContentUpdate(beadId, {
        title: verifyPart.title,
        description: verifyPart.description,
        acceptance: verifyPart.acceptance,
    }, deps, run);

    const created = await deps.createChild({
        parentId: beadId,
        title: sanitizePrText(doerPart.title || '').slice(0, 120),
        description: `${doerPart.description}\n\nACCEPTANCE CRITERIA\n\n${doerPart.acceptance}`,
        acceptance: doerPart.acceptance,
    });
    result.createdChildId = (created && created.childId) || null;
    result.verifyRouted = true;
}

/**
 * route: retype/relabel the bead onto the seat that can actually close it.
 *
 * A route BACK to `doer` is an ordinary content change and the bead re-enters
 * the doer lane. Any other route means the bead is evidence-only: it leaves
 * the doer lane for good (re-dispatching it would burn a dispatch on a
 * contract-bound refusal) and is marked verify-routed, which is the state the
 * runner already credits as progress and already refuses to exit the sprint
 * on while it is open.
 */
async function applyRoute(beadId, replan, deps, run, result) {
    const route = replan.route;
    result.changed = await applyContentUpdate(beadId, replan, deps, run);
    if (route && route !== 'doer') result.verifyRouted = true;
}

/**
 * grant: the doer was blocked on ACCESS, not on understanding.
 *
 * Two outcomes, and the difference matters more than the grant itself:
 *   - a kind the orchestrator can provision through its EXISTING credential
 *     path (vcs_auth / llm_auth) is provisioned here, labelled on the bead,
 *     and the bead goes back into the doer lane;
 *   - anything else needs a human. The bead is labelled and held, and
 *     `grantAwaiting` tells the runner to exclude it from the stagnation math
 *     rather than count it as an open blocker -- a sprint must not abort for
 *     "no progress" while it is correctly waiting on a person.
 */
async function applyGrant(beadId, replan, deps, run, result) {
    const grant = replan.grant || {};
    const grantable = ORCHESTRATOR_GRANTABLE.includes(grant.kind) && typeof deps.provisionGrant === 'function';

    let provisioned = false;
    if (grantable) {
        provisioned = Boolean(await deps.provisionGrant(grant));
    }

    const label = provisioned ? DOCTOR_LABELS.grantApplied : DOCTOR_LABELS.awaitingGrant;
    await run(
        `bd update ${beadId} --add-label ${label} --add-label ${DOCTOR_LABELS.replanned}`,
        `Sprint Doctor: record grant outcome on ${beadId}`,
    );
    result.changed = true;
    result.grantAwaiting = !provisioned;
}

// ===========================================================================
// THE GENERAL ACTION EXECUTOR (design doc section 2.5)
// ===========================================================================
//
// Everything above this line answers ONE question -- "a doer said BLOCKED,
// what should the bead become?". Everything below answers the other one: "an
// incident fired, what should the RUNNER do about it?". Same three invariants
// (existing verbs only, the doctor never acts, no re-dispatch without a real
// change), same never-throws posture, one more table.
//
// WHY A SECOND TABLE RATHER THAN MORE ROWS IN THE FIRST: the re-plan rows all
// mutate ONE bead through `bd update` and are done. The incident rows mutate
// the RUNNER's own dispatch decisions -- which member, which model tier, how
// long a timeout, whether the bead is dispatched at all -- and half of them
// touch no bead at all. Keeping them apart is what lets the re-plan lane's
// `redispatchOnChange`/`credits` booleans stay meaningful instead of being
// nulled out on eight rows that do not mutate bead content.
//
// THE EXECUTOR OWNS NO TRANSPORT. Every remedy is an INJECTED callback named
// after the verb the engine already had (the credential self-heal callbacks,
// the member session guard's kill, the reservation force-release tool, a
// `git fetch` through command()). This module decides WHETHER a verb may run
// (latches, caps), calls it, insists on a verification, and reports what
// happened. It never builds a git command, never force-pushes, never deletes
// a branch or a file, never mutates a reviewer or doer verdict, and never
// edits code content.
//
// THE CAPS ARE THE POINT. A self-healing runner with no ceiling is a runner
// that spends a whole sprint healing. Four independent bounds, all enforced
// here in code rather than asked for in a prompt:
//   1. a (beadId, action.kind) pair executes AT MOST ONCE per sprint;
//   2. a (member, remedy verb) pair runs AT MOST ONCE per sprint;
//   3. one error class may be remedied at most `maxPerClass` times
//      ("healing is a bridge, never a home");
//   4. at most `maxDefers` beads are deferred per sprint.
// A remedy whose mandatory verification does not pass counts as FAILED and
// STILL CONSUMES ITS LATCH -- otherwise a remedy that cannot work would be
// retried on every future incident of the same shape.

/**
 * The repair verbs `repair_environment_then_retry` may name, and the ONLY
 * definition of that vocabulary in the codebase. The symptom/remedy registry
 * validates its `remedy.verb` entries against THIS array rather than against
 * a copied literal list, so a registry entry naming a verb no executor
 * implements is a test failure rather than a silent no-op at 3am.
 *
 * Order matches the verdict schema's `action.repairs` enum exactly.
 */
export const REMEDY_VERBS = Object.freeze([
    'reprovision_llm_auth',
    'reprovision_vcs_auth',
    'force_release_reservation',
    'stop_and_kill_session',
    'refetch_branch',
]);

/**
 * remedy verb -> the name of the injected dependency that performs it. The
 * indirection is what keeps this module free of provider, allocator and
 * transport wiring: the runner passes the callbacks it already built for its
 * own recovery paths, and a test passes fakes.
 */
const REMEDY_DEPENDENCY = Object.freeze({
    reprovision_llm_auth: 'provisionLlmAuth',
    reprovision_vcs_auth: 'provisionVcsAuth',
    force_release_reservation: 'forceReleaseReservation',
    stop_and_kill_session: 'stopAndKillSession',
    refetch_branch: 'refetchBranch',
});

/**
 * THE INCIDENT TABLE. action.kind -> the existing verb it maps to, the scope
 * its once-per-sprint latch is keyed on, and whether it spends the per-class
 * remedy budget.
 *
 * `scope` is the latch key, and it is a correctness statement rather than a
 * label: 'bead' latches (beadId, kind), 'member' latches the remedy verbs per
 * member, and 'sprint' actions (abort, pause) are terminal or human-bound and
 * are never latched at all -- refusing a second abort request would be a bug,
 * not a safety measure.
 *
 * `countsAgainstClassCap` is false for exactly the two delegated actions:
 * asking a human for help is not "healing the same class again", and a sprint
 * that has spent its per-class budget must still be ABLE to stop.
 */
export const INCIDENT_EXECUTOR_TABLE = Object.freeze({
    repair_environment_then_retry: Object.freeze({
        verb: 'registry remedy verbs, then exactly one retry of the failed operation',
        summary: 'repaired the member environment through an existing recovery verb and retried once',
        scope: 'member',
        countsAgainstClassCap: true,
        delegated: false,
    }),
    retry_same: Object.freeze({
        verb: 'one redispatch with the dispatch timeout scaled by timeoutMultiplier',
        summary: 'retried the same bead on the same member with a longer clock',
        scope: 'bead',
        countsAgainstClassCap: true,
        delegated: false,
    }),
    retry_different_member: Object.freeze({
        verb: 'existing streak re-lane plus a doctor-set member exclusion',
        summary: 're-laned the bead away from the implicated member (also the environment-vs-task-shape probe)',
        scope: 'bead',
        countsAgainstClassCap: true,
        delegated: false,
    }),
    swap_model_tier: Object.freeze({
        verb: 'runner-side per-bead tier override (never a stored-metadata write)',
        summary: 'moved the bead to a different model tier for its next dispatch only',
        scope: 'bead',
        countsAgainstClassCap: true,
        delegated: false,
    }),
    defer_bead: Object.freeze({
        verb: 'bd defer <id> --reason "<evidence + reason>"',
        summary: 'parked the bead with the doctor evidence as its written reason',
        scope: 'bead',
        countsAgainstClassCap: true,
        delegated: false,
    }),
    reduce_scope_and_continue: Object.freeze({
        verb: 'bd defer <id> --reason "<evidence + reason>"',
        summary: 'dropped the bead from this sprint scope and continued with the rest',
        scope: 'bead',
        countsAgainstClassCap: true,
        delegated: false,
    }),
    abort_sprint: Object.freeze({
        verb: 'the abort handler injected by the lane that owns sprint termination',
        summary: 'routed an abort request to its owning lane',
        scope: 'sprint',
        countsAgainstClassCap: false,
        delegated: true,
    }),
    pause_for_human: Object.freeze({
        verb: 'the pause handler injected by the lane that owns the engine pause primitive',
        summary: 'routed a pause-for-human request to its owning lane',
        scope: 'sprint',
        countsAgainstClassCap: false,
        delegated: true,
    }),
});

/** The eight incident kinds, derived from the table so the two cannot disagree. */
export const INCIDENT_ACTION_KINDS = Object.freeze(Object.keys(INCIDENT_EXECUTOR_TABLE));

/**
 * EVERY action kind the verdict schema may carry, in the schema's own order:
 * the eight incident kinds followed by the five re-plan kinds. This is the
 * single definition of that vocabulary in the codebase -- the schema
 * literals (the vendored role schema and its in-repo mirror) are pinned
 * against it by test rather than being re-typed anywhere else, and the
 * symptom/remedy registry validates against these exports.
 */
export const ACTION_KINDS = Object.freeze([...INCIDENT_ACTION_KINDS, ...REPLAN_ACTION_KINDS]);

/**
 * The hard ceiling on `retry_same`'s timeout scaling. A doctor asking for
 * "just a bit longer" is plausible; a doctor asking for ten times longer is
 * asking the sprint to spend its whole clock on one bead.
 */
export const MAX_TIMEOUT_MULTIPLIER = 2;

/** The model tiers a swap may name. Anything else is refused, not coerced. */
const SWAPPABLE_TIERS = Object.freeze(['cheap', 'standard', 'premium']);

/** Defaults matching the engine's own doctor cap arguments. */
export const DEFAULT_ACTION_CAPS = Object.freeze({ maxDefers: 2, maxPerClass: 2 });

/**
 * True when `kind` is one of the eight incident actions this executor
 * implements (as opposed to a re-plan action, which `isReplanAction` owns).
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isIncidentAction(kind) {
    return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(INCIDENT_EXECUTOR_TABLE, kind);
}

/**
 * The rescue branch a salvage pre-step commits WIP to. Never the sprint
 * branch, never an existing branch: the timestamp makes the name unique per
 * attempt, so a salvage can only ever ADD a branch.
 * @param {string} sprintBranch
 * @param {string} beadId
 * @param {string|number} [stamp]
 * @returns {string}
 */
export function rescueBranchName(sprintBranch, beadId, stamp = Date.now()) {
    const safe = (s) => String(s || '').trim().replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '');
    const iso = new Date(Number(stamp) || Date.now()).toISOString().replace(/[:.]/g, '-');
    return `rescue/${safe(sprintBranch) || 'sprint'}/${safe(beadId) || 'bead'}-${iso}`;
}

/**
 * The per-sprint incident executor: ONE object per run, holding every latch
 * and cap in one place, exposing (a) `apply()` for the runner's consult point
 * and (b) `dispatchPolicy`, the read side the dispatch path consults for the
 * three decisions a verdict can change (tier, member, timeout).
 *
 * Deliberately a factory, matching createConsultLimiter/createSprintHealthLedger.
 *
 * @param {{
 *   log?: Function,
 *   caps?: { maxDefers?: number, maxPerClass?: number },
 *   command?: Function,
 *   member?: string,
 *   branch?: string,
 *   provisionLlmAuth?: (ctx: object) => Promise<boolean>,
 *   provisionVcsAuth?: (ctx: object) => Promise<boolean>,
 *   forceReleaseReservation?: (ctx: object) => Promise<boolean>,
 *   stopAndKillSession?: (ctx: object) => Promise<boolean>,
 *   refetchBranch?: (ctx: object) => Promise<boolean>,
 *   verifyRemedy?: (ctx: object) => Promise<boolean>,
 *   retryFailedOperation?: (ctx: object) => Promise<boolean>,
 *   salvageWip?: (ctx: object) => Promise<boolean>,
 *   onAbort?: (ctx: object) => Promise<any>,
 *   onPause?: (ctx: object) => Promise<any>,
 * }} deps
 */
export function createDoctorActionExecutor(deps = {}) {
    const log = deps.log || (() => {});
    const caps = Object.freeze({
        maxDefers: (deps.caps && deps.caps.maxDefers) ?? DEFAULT_ACTION_CAPS.maxDefers,
        maxPerClass: (deps.caps && deps.caps.maxPerClass) ?? DEFAULT_ACTION_CAPS.maxPerClass,
    });

    /** `${beadId}::${kind}` pairs already executed -- cap 1. */
    const pairLatch = new Set();
    /** `${member}::${verb}` remedies already attempted (verified or not) -- cap 2. */
    const remedyLatch = new Set();
    /** errorSignature -> remedies spent on it -- cap 3. */
    const classCounts = new Map();
    /** How many beads have been deferred this sprint -- cap 4. */
    let deferCount = 0;

    /** The three dispatch decisions a verdict may change, and the two id sets the runner reads. */
    const tierOverrides = new Map();
    const memberExclusions = new Map();
    const timeoutMultipliers = new Map();
    const deferredIds = new Set();
    const creditIds = new Set();

    const pairKey = (beadId, kind) => `${beadId}::${kind}`;
    const remedyKey = (member, verb) => `${member || '(fleet)'}::${verb}`;

    /**
     * The READ side of everything this executor decided, consumed by the
     * dispatch path. Every accessor is total: an unknown bead returns the
     * caller's own default, so a call site reads the same value it read
     * before the doctor existed until a verdict actually changes it.
     */
    const dispatchPolicy = Object.freeze({
        /** The tier a bead must dispatch on: the doctor's override, else the declared one. */
        tierFor(beadId, declaredTier = null) {
            const override = tierOverrides.get(beadId);
            return override === undefined ? declaredTier : override;
        },
        /** True when the doctor excluded `member` from `beadId` for the rest of the sprint. */
        isMemberExcluded(beadId, member) {
            const excluded = memberExclusions.get(beadId);
            return Boolean(excluded && member && excluded.has(member));
        },
        /** Every member excluded from `beadId`, for logging and for member selection. */
        excludedMembersFor(beadId) {
            return [...(memberExclusions.get(beadId) || [])];
        },
        /**
         * The timeout multiplier for a dispatch covering `beadIds`: the
         * largest one the doctor set for any bead in it, always in (0, 2].
         * 1 when the doctor set none, i.e. the unchanged timeout.
         */
        timeoutMultiplierFor(beadIds = []) {
            let best = 1;
            for (const id of Array.isArray(beadIds) ? beadIds : [beadIds]) {
                const m = timeoutMultipliers.get(id);
                if (typeof m === 'number' && m > best) best = m;
            }
            return Math.min(best, MAX_TIMEOUT_MULTIPLIER);
        },
        /** True when the doctor deferred this bead (the runner excludes it from open-at-goal). */
        isDeferred(beadId) {
            return deferredIds.has(beadId);
        },
        /** Every bead the doctor deferred this sprint. */
        deferredIds() {
            return [...deferredIds];
        },
        /** Every bead that earned stagnation credit through a doctor action. */
        creditIds() {
            return [...creditIds];
        },
    });

    /** Snapshot of every latch and counter -- for logs, the run record and tests. */
    function state() {
        return {
            caps,
            pairs: [...pairLatch],
            remedies: [...remedyLatch],
            classCounts: Object.fromEntries(classCounts),
            deferCount,
            tierOverrides: Object.fromEntries(tierOverrides),
            memberExclusions: Object.fromEntries([...memberExclusions].map(([k, v]) => [k, [...v]])),
            timeoutMultipliers: Object.fromEntries(timeoutMultipliers),
            deferredIds: [...deferredIds],
            creditIds: [...creditIds],
        };
    }

    /** A fresh, fully-populated result so every caller reads the same shape. */
    function blankResult(kind) {
        return {
            applied: false,
            kind: isIncidentAction(kind) ? kind : null,
            verb: isIncidentAction(kind) ? INCIDENT_EXECUTOR_TABLE[kind].verb : null,
            beadIds: [],
            remedies: [],
            redispatch: false,
            credit: false,
            deferredIds: [],
            tierOverrides: [],
            excludedMembers: [],
            timeoutMultiplier: null,
            salvageBranch: null,
            aborted: false,
            paused: false,
            refused: false,
            reason: null,
            error: null,
        };
    }

    /** Refuse, loudly and without throwing: the sprint continues exactly as it was. */
    function refuse(result, reason) {
        result.refused = true;
        result.reason = reason;
        log(`${LOG_PREFIX} action ${result.kind || '(unknown)'} NOT executed: ${reason}.`);
        return result;
    }

    /**
     * Runs ONE remedy verb through its injected verb, then its MANDATORY
     * verification. Consumes the (member, verb) latch either way -- a remedy
     * that did not verify is a remedy that does not work here, and retrying
     * it on the next incident would only spend the sprint's clock again.
     */
    async function runRemedy(verb, ctx) {
        const key = remedyKey(ctx.member, verb);
        if (remedyLatch.has(key)) {
            return { verb, ran: false, verified: false, reason: 'already attempted once for this member this sprint' };
        }
        const depName = REMEDY_DEPENDENCY[verb];
        const fn = deps[depName];
        if (typeof fn !== 'function') {
            return { verb, ran: false, verified: false, reason: `no ${depName} verb is wired for this run` };
        }
        remedyLatch.add(key);
        try {
            const ok = Boolean(await fn({ verb, member: ctx.member, beadIds: ctx.beadIds, branch: deps.branch, reason: ctx.reason }));
            if (!ok) return { verb, ran: true, verified: false, reason: 'the remedy verb reported failure' };
            if (typeof deps.verifyRemedy !== 'function') {
                return { verb, ran: true, verified: false, reason: 'no verification verb is wired, so the remedy cannot be confirmed' };
            }
            const verified = Boolean(await deps.verifyRemedy({ verb, member: ctx.member, beadIds: ctx.beadIds }));
            return { verb, ran: true, verified, reason: verified ? null : 'the remedy ran but did not verify' };
        } catch (err) {
            return { verb, ran: true, verified: false, reason: (err && err.message) || String(err) };
        }
    }

    /**
     * Applies ONE incident verdict. Never throws into the cycle loop: a
     * failure is reported in `error` and the sprint proceeds exactly as it
     * would have without the doctor.
     *
     * @param {object} verdict a schema-valid verdict whose action.kind is an incident kind
     * @param {{ beadIds?: string[], member?: string, errorSignature?: string|null, cycle?: number|string }} [ctx]
     */
    async function apply(verdict, ctx = {}) {
        const action = (verdict && verdict.action) || {};
        const kind = action.kind;
        const result = blankResult(kind);

        if (!isIncidentAction(kind)) {
            return refuse(result, `action.kind "${kind}" is not an incident action; this executor implements [${INCIDENT_ACTION_KINDS.join(', ')}]`);
        }
        const entry = INCIDENT_EXECUTOR_TABLE[kind];
        const member = action.member || ctx.member || null;
        const beadIds = [...new Set([
            ...(Array.isArray(action.beadIds) ? action.beadIds : []),
            ...(Array.isArray(ctx.beadIds) ? ctx.beadIds : []),
        ].map((id) => String(id || '').trim()).filter(Boolean))];
        result.beadIds = beadIds;

        // Cap 3, checked BEFORE anything runs: a class that has already been
        // healed its allowance must fail loudly and be fixed in the engine.
        const signature = ctx.errorSignature || null;
        if (entry.countsAgainstClassCap && signature && (classCounts.get(signature) || 0) >= caps.maxPerClass) {
            return refuse(result, `error class "${signature}" has already been remedied ${caps.maxPerClass} time(s) this sprint (per-class cap)`);
        }

        // Cap 1: a (bead, kind) pair executes at most once per sprint. Bead-
        // scoped kinds drop the beads that already spent their latch; if none
        // are left the whole action is refused rather than half-run.
        let targets = beadIds;
        if (entry.scope === 'bead') {
            if (targets.length === 0) return refuse(result, 'the verdict named no bead and none was in scope');
            targets = targets.filter((id) => !pairLatch.has(pairKey(id, kind)));
            if (targets.length === 0) {
                return refuse(result, `every bead in scope has already had ${kind} executed once this sprint (per-bead, per-kind cap)`);
            }
            result.beadIds = targets;
        }

        try {
            // Optional salvage PRE-step: rescue whatever the stuck attempt
            // left behind before the sprint walks away from it. Only for the
            // three walk-away actions, only when the verdict asks, only ever
            // onto a brand-new rescue branch.
            if (action.salvageWip === true
                && ['defer_bead', 'reduce_scope_and_continue', 'abort_sprint'].includes(kind)
                && typeof deps.salvageWip === 'function') {
                const branch = rescueBranchName(deps.branch, targets[0] || 'sprint');
                const salvaged = Boolean(await deps.salvageWip({ member, beadIds: targets, rescueBranch: branch, sprintBranch: deps.branch }));
                result.salvageBranch = salvaged ? branch : null;
                log(`${LOG_PREFIX} salvage pre-step for ${kind}: ${salvaged ? `WIP committed to ${branch}` : 'nothing to salvage (clean tree or no salvage verb)'}.`);
            }

            switch (kind) {
                case 'repair_environment_then_retry': {
                    const requested = (Array.isArray(action.repairs) ? action.repairs : [])
                        .filter((v) => REMEDY_VERBS.includes(v));
                    if (requested.length === 0) {
                        return refuse(result, 'repair_environment_then_retry named no known remedy verb');
                    }
                    for (const verb of requested) {
                        const outcome = await runRemedy(verb, { member, beadIds: targets, reason: action.reason });
                        result.remedies.push(outcome);
                        log(`${LOG_PREFIX} remedy ${verb} on '${member || '(fleet)'}': `
                            + `${outcome.verified ? 'VERIFIED' : 'FAILED'}${outcome.reason ? ` (${outcome.reason})` : ''}.`);
                    }
                    const anyVerified = result.remedies.some((r) => r.verified);
                    if (anyVerified && typeof deps.retryFailedOperation === 'function') {
                        // EXACTLY ONE retry of the failed operation, and only
                        // after something actually verified: retrying after a
                        // failed repair is just the original failure again.
                        result.redispatch = Boolean(await deps.retryFailedOperation({ member, beadIds: targets, verdict }));
                    } else if (anyVerified) {
                        result.redispatch = true;
                    }
                    result.applied = anyVerified;
                    if (!anyVerified) result.reason = 'no remedy verified, so the failed operation was not retried';
                    break;
                }
                case 'retry_same': {
                    const raw = typeof action.timeoutMultiplier === 'number' && action.timeoutMultiplier > 0
                        ? action.timeoutMultiplier
                        : 1;
                    const multiplier = Math.min(raw, MAX_TIMEOUT_MULTIPLIER);
                    for (const id of targets) timeoutMultipliers.set(id, multiplier);
                    result.timeoutMultiplier = multiplier;
                    result.redispatch = true;
                    result.applied = true;
                    break;
                }
                case 'retry_different_member': {
                    const excluded = member;
                    if (!excluded) return refuse(result, 'retry_different_member named no member to exclude');
                    for (const id of targets) {
                        if (!memberExclusions.has(id)) memberExclusions.set(id, new Set());
                        memberExclusions.get(id).add(excluded);
                    }
                    result.excludedMembers = [excluded];
                    result.redispatch = true;
                    result.applied = true;
                    break;
                }
                case 'swap_model_tier': {
                    const tier = typeof action.tier === 'string' ? action.tier.trim() : '';
                    if (!SWAPPABLE_TIERS.includes(tier)) {
                        return refuse(result, `swap_model_tier named tier "${action.tier}", which is not one of [${SWAPPABLE_TIERS.join(', ')}]`);
                    }
                    // A RUNNER-SIDE override only: the bead's stored metadata
                    // is never written, so the tracker keeps reading exactly
                    // what the planner recorded.
                    for (const id of targets) tierOverrides.set(id, tier);
                    result.tierOverrides = targets.map((id) => ({ beadId: id, tier }));
                    result.redispatch = true;
                    result.applied = true;
                    break;
                }
                case 'defer_bead':
                case 'reduce_scope_and_continue': {
                    if (typeof deps.command !== 'function' || !deps.member) {
                        return refuse(result, 'no command verb or orchestrator member was provided, so nothing can be deferred');
                    }
                    const reason = sanitizePrText([
                        `[sprint-doctor${ctx.cycle === undefined ? '' : ` C${ctx.cycle}`}] ${kind}:`,
                        (Array.isArray(verdict.evidence) ? verdict.evidence : []).join(' | '),
                        action.reason ? `Reason: ${action.reason}` : '',
                    ].filter(Boolean).join(' '));
                    for (const id of targets) {
                        if (deferCount >= caps.maxDefers) {
                            result.reason = `per-sprint defer cap (${caps.maxDefers}) reached -- ${id} was left as it was`;
                            log(`${LOG_PREFIX} ${result.reason}.`);
                            break;
                        }
                        await deps.command(`bd defer ${id} --reason "${reason}"`, {
                            member_name: deps.member,
                            silent: true,
                            label: `Sprint Doctor: defer ${id}`,
                        });
                        deferCount += 1;
                        deferredIds.add(id);
                        creditIds.add(id);
                        result.deferredIds.push(id);
                        pairLatch.add(pairKey(id, kind));
                    }
                    result.credit = result.deferredIds.length > 0;
                    result.applied = result.deferredIds.length > 0;
                    // The per-bead latches were taken inline above, so the
                    // shared latch pass below must not take them twice.
                    result.beadIds = result.deferredIds;
                    break;
                }
                case 'abort_sprint':
                case 'pause_for_human': {
                    const handler = kind === 'abort_sprint' ? deps.onAbort : deps.onPause;
                    if (typeof handler !== 'function') {
                        return refuse(result, `${kind} is delegated to its owning lane, and no handler was injected for this run`);
                    }
                    await handler({ verdict, beadIds: targets, member, cycle: ctx.cycle });
                    if (kind === 'abort_sprint') result.aborted = true;
                    else result.paused = true;
                    result.applied = true;
                    break;
                }
                default:
                    return refuse(result, `no executor row for action.kind "${kind}"`);
            }
        } catch (err) {
            result.error = (err && err.message) || String(err);
            result.applied = false;
            result.redispatch = false;
            log(`${LOG_PREFIX} action ${kind} FAILED to execute: ${result.error}. `
                + 'Nothing was changed and the sprint proceeds as it would have without the doctor.');
        }

        // Latches and the class counter are consumed for ATTEMPTS, not for
        // successes: a verdict whose action ran and did not work must not be
        // handed the same budget again on the next incident.
        if (entry.scope === 'bead' && kind !== 'defer_bead' && kind !== 'reduce_scope_and_continue') {
            for (const id of result.beadIds) pairLatch.add(pairKey(id, kind));
        }
        if (entry.countsAgainstClassCap && signature) {
            classCounts.set(signature, (classCounts.get(signature) || 0) + 1);
        }

        log(`${LOG_PREFIX} action ${kind}${result.beadIds.length > 0 ? ` on [${result.beadIds.join(', ')}]` : ''}: `
            + `${result.applied ? 'applied' : 'not applied'} via ${entry.verb} -- ${entry.summary}. `
            + `redispatch=${result.redispatch}, credit=${result.credit}`
            + `${result.reason ? `, reason: ${result.reason}` : ''}.`);
        return result;
    }

    return { caps, apply, dispatchPolicy, state };
}
