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
