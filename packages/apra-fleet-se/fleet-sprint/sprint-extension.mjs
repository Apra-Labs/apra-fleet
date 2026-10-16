// =============================================================================
// SPRINT EXTENSION: the Finalization barrier and the bounded re-entry into the
// cycle loop.
//
// WHERE IT RUNS. runner.js, inside group('Finalization'), right after Final
// Review returns:
//
//   start CI gate (async, ci_gate only) -> Final Review -> BARRIER (this
//   module: await the CI gate, retry a TIMEOUT once) -> decide -> either
//   create/refresh the extension beads and send the sprint back into the
//   ordinary cycle loop, or let Finalization continue with Regression Test ->
//   Harvest -> Publish PR.
//
// WHAT TRIGGERS AN EXTENSION.
//   - CI FAIL, or a CI TIMEOUT that timed out again on its one retry: one P1
//     "Fix CI" child bead under the first target issue. ONE reopenable bead per
//     sprint: a later failure reopens it and adds a note instead of creating a
//     duplicate (its id lives in the extension state; a bead with the same
//     title already in scope is adopted, so a relaunched sprint does not
//     duplicate it either).
//   - Final Review newTasks at or above the goal ceiling, and the Final Review
//     reopens that survived the goal guard. They already exist as beads; the
//     extension only puts them in front of another cycle.
//   NEVER a trigger: CI FAILED-TO-RUN (a credential, permission or provider
//   problem no code change fixes -- logged loudly and stated in the PR body),
//   below-goal Final Review findings (owed triage, unchanged) and regression
//   failures (Regression Test runs after this barrier and never gates).
//
// BOUNDS. `max_extensions` (sprint arg, default 1; 0 disables) caps how many
// times the sprint re-enters the cycle loop; each extension gets
// EXTENSION_CYCLE_BUDGET cycles (plus the existing deploy-retry allowance),
// independent of max_cycles. No-progress stop: when an extension ends with the
// same CI failure (same failing job set) or the same in-goal findings that
// triggered it, the sprint does not extend again and says why.
//
// RACE SAFETY. The barrier awaits the in-flight CI run before anything is
// decided, so no CI run whose result matters is in flight while an extension
// changes code; each later Finalization starts its own run on its own head.
// Beads are written only by the orchestrator, here, through the existing
// helpers (validateNewTask, persistNewTaskBestEffort, the injected
// createChildBeadWithAllocatedId path) inside a gitSync D-pull/D-push
// bracket -- never by an LLM and never while a dispatch holds the sprint.
//
// CI TEXT. The CI record reaches the Fix-CI bead's DESCRIPTION (bead content a
// doer reads through the normal bead flow, which is the point) and the PR
// body. It never reaches a prompt builder: this module does not import
// prompts.mjs and no prompt builder takes CI input.
//
// GENERIC ENGINE. No target repo's workflow names, job names or commands
// appear here; they arrive as config and as provider responses. ASCII only.
// =============================================================================

import { CI_GATE_OUTCOME } from './ci-gate.mjs';
import { validateNewTask, persistNewTaskBestEffort } from './abort.mjs';
import { stageCommandBodyMemberSide } from './member-provisioning.mjs';

/** Cycles one extension may run (the deploy-retry allowance comes on top). */
export const EXTENSION_CYCLE_BUDGET = 1;

const LOG_PREFIX = '[Sprint Extension]';
const SAFE_BEAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUCCESSFUL_JOB_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/**
 * The per-sprint extension state. Lives on sprintState.extension (one object
 * per sprint, created by createSprintState) so a paused and resumed sprint
 * keeps its count, its trigger history and the Fix-CI bead id.
 * @returns {{ count: number, history: object[], fixCiBeadId: string|null }}
 */
export function createExtensionState() {
    return { count: 0, history: [], fixCiBeadId: null };
}

/** Job names whose conclusion is not a success, sorted. */
export function failingJobNames(record) {
    const jobs = record && Array.isArray(record.jobs) ? record.jobs : [];
    return jobs
        .filter((j) => j && !SUCCESSFUL_JOB_CONCLUSIONS.has(String(j.conclusion || '').toLowerCase()))
        .map((j) => String(j.name))
        .sort();
}

/**
 * Classify the barrier's CI record. `trigger` is set for FAIL and for a
 * TIMEOUT that also timed out on its retry; `unfixable` is set for
 * FAILED-TO-RUN (and for a single TIMEOUT that was never retried, which the
 * barrier does not produce). PASS and "not configured" give neither.
 * @param {object|null} record
 * @param {{ doubleTimeout?: boolean }} [opts]
 * @returns {{ trigger: object|null, unfixable: boolean }}
 */
export function classifyCiRecord(record, { doubleTimeout = false } = {}) {
    if (!record) return { trigger: null, unfixable: false };
    const outcome = record.outcome;
    if (outcome === CI_GATE_OUTCOME.PASS) return { trigger: null, unfixable: false };
    if (outcome === CI_GATE_OUTCOME.FAIL || (outcome === CI_GATE_OUTCOME.TIMEOUT && doubleTimeout)) {
        return {
            trigger: {
                outcome,
                doubleTimeout: outcome === CI_GATE_OUTCOME.TIMEOUT,
                workflow: record.workflow || null,
                runUrl: record.runUrl || null,
                runId: record.runId || null,
                headSha: record.headSha || null,
                failingJobs: failingJobNames(record),
                reason: record.reason || null,
            },
            unfixable: false,
        };
    }
    return { trigger: null, unfixable: true };
}

/** The no-progress key of a CI trigger: the outcome kind plus the failing job set. */
export function ciTriggerKey(ciTrigger) {
    if (!ciTrigger) return null;
    return `${ciTrigger.outcome}:${(ciTrigger.failingJobs || []).join(',')}`;
}

/** The no-progress key of the finding triggers: sorted titles plus reopened ids. */
export function findingTriggerKey(findings) {
    const f = findings || {};
    const parts = [
        ...(f.newTasks || []).map((t) => `task:${t.title}`),
        ...(f.reopenedIds || []).map((id) => `reopen:${id}`),
    ].sort();
    return parts.length > 0 ? parts.join('|') : null;
}

/** True when `priority` ('P0'..'P4') is at or above the goal ceiling `goalMax` ('P1'..'P3'). */
export function isInGoalPriority(priority, goalMax) {
    const p = /^P(\d)$/.exec(String(priority || ''));
    const g = /^P(\d)$/.exec(String(goalMax || ''));
    return !!(p && g) && Number(p[1]) <= Number(g[1]);
}

/** Human text for a CI trigger (log lines, PR body, bead notes). */
export function describeCiTrigger(ciTrigger) {
    if (!ciTrigger) return '';
    const what = ciTrigger.doubleTimeout
        ? `CI TIMEOUT twice (the one retry on the same commit timed out too) on workflow '${ciTrigger.workflow}'`
        : `CI FAIL on workflow '${ciTrigger.workflow}'`;
    const jobs = ciTrigger.failingJobs && ciTrigger.failingJobs.length > 0
        ? `failing jobs: ${ciTrigger.failingJobs.join(', ')}`
        : 'no per-job detail';
    return `${what} (${jobs}; run ${ciTrigger.runUrl || '(no url)'}; commit ${ciTrigger.headSha || '(unknown)'})`;
}

function describeFindings(findings) {
    const parts = [];
    for (const t of (findings && findings.newTasks) || []) {
        parts.push(`"${t.title}" (${t.priority}${t.id ? `, ${t.id}` : ''})`);
    }
    const reopened = (findings && findings.reopenedIds) || [];
    if (reopened.length > 0) parts.push(`reopened: ${reopened.join(', ')}`);
    return parts.length > 0 ? `in-goal Final Review finding(s): ${parts.join('; ')}` : '';
}

function describeTrigger(trigger) {
    return [describeCiTrigger(trigger.ci), describeFindings(trigger.findings)].filter(Boolean).join(' + ');
}

/**
 * Pure decision: extend or not, and why. `state` is read, never written.
 * @param {{ state: object, maxExtensions: number, ciTrigger: object|null, findings: object }} o
 * @returns {{ extend: boolean, hasTrigger: boolean, noProgress: boolean, reason: string }}
 */
export function decideExtension({ state, maxExtensions, ciTrigger, findings }) {
    const ciKey = ciTriggerKey(ciTrigger);
    const findingKey = findingTriggerKey(findings);
    const hasTrigger = !!(ciKey || findingKey);
    if (!hasTrigger) {
        return { extend: false, hasTrigger, noProgress: false, reason: 'nothing to extend for: CI did not fail and Final Review raised no in-goal finding' };
    }
    const prev = state.history.length > 0 ? state.history[state.history.length - 1] : null;
    if (prev) {
        const sameCi = !!ciKey && ciKey === prev.ciKey;
        const sameFindings = !!findingKey && findingKey === prev.findingKey;
        if (sameCi || sameFindings) {
            const what = sameCi
                ? `CI still failing on the same jobs (${ciTrigger.failingJobs.length > 0 ? ciTrigger.failingJobs.join(', ') : `${ciTrigger.outcome}, no per-job detail`})`
                : `the same in-goal Final Review finding(s) remain (${describeFindings(findings)})`;
            return { extend: false, hasTrigger, noProgress: true, reason: `Extension ${prev.index} did not resolve: ${what}; not extending again (no progress).` };
        }
    }
    if (state.count >= maxExtensions) {
        return {
            extend: false, hasTrigger, noProgress: false,
            reason: maxExtensions === 0
                ? 'sprint extensions are disabled (max_extensions 0)'
                : `the extension budget is spent (max_extensions ${maxExtensions}, ${state.count} used)`,
        };
    }
    return { extend: true, hasTrigger, noProgress: false, reason: `extension ${state.count + 1} of at most ${maxExtensions}` };
}

function asciiOnly(text) {
    return String(text ?? '').replace(/[^\t\n\r\x20-\x7E]/g, '?');
}

/** A workflow name rendered with title-safe characters only. */
function titleSafe(text) {
    return String(text ?? '').replace(/[^A-Za-z0-9 .,:;!?()'_/+[\]-]/g, '-');
}

/** The stable Fix-CI bead title for a workflow (one reopenable bead per sprint). */
export function fixCiBeadTitle(workflow) {
    return `Fix CI: workflow '${titleSafe(workflow || 'unknown')}' does not pass on the sprint branch`;
}

/** The Fix-CI evidence block (bead description and later reopen notes). */
export function fixCiEvidenceText(ciTrigger, { cycleLabel = null } = {}) {
    const lines = [
        `Workflow: ${ciTrigger.workflow}`,
        `Outcome: ${ciTrigger.doubleTimeout ? 'TIMEOUT, twice (the one retry on the same commit also timed out)' : ciTrigger.outcome}`,
        `Run: ${ciTrigger.runUrl || (ciTrigger.runId ? `run ${ciTrigger.runId} (no url)` : '(no run url)')}`,
        `Commit CI ran on: ${ciTrigger.headSha || '(unknown)'}`,
        `Failing jobs: ${ciTrigger.failingJobs.length > 0 ? ciTrigger.failingJobs.join(', ') : '(no per-job detail; see the run)'}`,
        `Reason: ${ciTrigger.reason || '(none recorded)'}`,
    ];
    if (cycleLabel !== null) lines.unshift(`Finalization after cycle ${cycleLabel}:`);
    return asciiOnly(lines.join('\n'));
}

/**
 * The Fix-CI bead as a newTask, so it goes through the same validation
 * (validateNewTask) and creation path as every orchestrator-applied finding.
 */
export function buildFixCiNewTask(ciTrigger, { cycleLabel = null } = {}) {
    const description = [
        'CI did not pass on the sprint branch at Finalization, so the sprint engine opened a sprint extension to fix it before publishing.',
        '',
        fixCiEvidenceText(ciTrigger, { cycleLabel }),
        '',
        ciTrigger.doubleTimeout
            ? 'Find out why the workflow does not finish within its timeout (a hung or much slower job, a deadlock, a test waiting on something that never comes) using the run page and its job logs, and fix the cause in the code on the sprint branch.'
            : 'Make the failing jobs pass: read the job logs on the run page, reproduce the failure with the repository\'s own build and test commands, and fix the cause in the code on the sprint branch.',
        'Do not disable, skip or weaken the failing checks. Close this bead with a short note of what you changed.',
    ].join('\n');
    return {
        title: fixCiBeadTitle(ciTrigger.workflow),
        description,
        priority: 'P1',
        dedupCheck: { query: 'Fix CI on the sprint branch', candidateIds: [], verdict: 'no-overlap' },
    };
}

/**
 * Create the sprint's ONE Fix-CI bead, or reopen and refresh it when it
 * already exists (its id recorded in `state.fixCiBeadId`, or a bead with the
 * same title already in the sprint scope -- adopted so a relaunched sprint
 * does not duplicate it). Every write is a member_name-bearing command() on
 * the backlog member; the caller owns the surrounding sync bracket.
 *
 * @returns {Promise<{ id: string|null, action: 'created'|'reopened'|'failed' }>}
 */
export async function ensureFixCiBead({
    command, member, state, ciTrigger, parentId, cycleLabel, bdListScoped, createChild, log = () => {},
}) {
    const newTask = buildFixCiNewTask(ciTrigger, { cycleLabel });
    const validation = validateNewTask(newTask);
    if (!validation.ok) {
        log(`${LOG_PREFIX} ERROR: the Fix-CI bead text failed validation (${validation.reason}); no bead written.`);
        return { id: null, action: 'failed' };
    }
    let id = state.fixCiBeadId;
    if (!id && typeof bdListScoped === 'function') {
        try {
            const scope = await bdListScoped('');
            const existing = (Array.isArray(scope) ? scope : []).find((b) => b && b.title === validation.title);
            if (existing && existing.id) {
                id = existing.id;
                log(`${LOG_PREFIX} adopting the existing Fix-CI bead ${id} (same title already in this sprint's scope) instead of creating a duplicate.`);
            }
        } catch (err) {
            log(`${LOG_PREFIX} WARN: could not read the sprint scope to look for an existing Fix-CI bead (${err && err.message ? err.message : String(err)}); creating one.`);
        }
    }
    if (id) {
        if (!SAFE_BEAD_ID_RE.test(id)) {
            log(`${LOG_PREFIX} ERROR: the recorded Fix-CI bead id ${JSON.stringify(id)} is not a safe bead id; not reopening it.`);
            return { id: null, action: 'failed' };
        }
        state.fixCiBeadId = id;
        try {
            await command(`bd update ${id} --status=open`, {
                member_name: member, silent: true, label: `Reopen the Fix-CI bead ${id}`,
            });
            const noteFile = await stageCommandBodyMemberSide({
                command, member,
                content: `[sprint extension] CI still does not pass.\n${fixCiEvidenceText(ciTrigger, { cycleLabel })}`,
                label: `Stage the Fix-CI note for ${id}`,
            });
            await command(`bd note ${id} --file "${noteFile}"`, {
                member_name: member, silent: true, label: `Append the new CI result to the Fix-CI bead ${id}`,
            });
        } catch (err) {
            log(`${LOG_PREFIX} ERROR: could not reopen/refresh the Fix-CI bead ${id}: ${err && err.message ? err.message : String(err)}`);
            return { id, action: 'failed' };
        }
        log(`${LOG_PREFIX} reopened the Fix-CI bead ${id} with the new CI result (one Fix-CI bead per sprint).`);
        return { id, action: 'reopened' };
    }
    const created = await persistNewTaskBestEffort({
        command, member, parentId, newTask, cycle: cycleLabel, log, stage: 'sprint-extension',
        createFn: () => createChild({ title: validation.title, description: validation.description, priority: validation.priority }),
    });
    if (!created) {
        log(`${LOG_PREFIX} ERROR: the Fix-CI bead could not be created under ${parentId} (the finding was preserved in its notes).`);
        return { id: null, action: 'failed' };
    }
    const childId = created && typeof created === 'object' && created.childId ? created.childId : null;
    if (childId) state.fixCiBeadId = childId;
    log(`${LOG_PREFIX} created the Fix-CI bead ${childId || '(bd-derived id)'} ("${validation.title}", P1) under ${parentId}.`);
    return { id: childId, action: 'created' };
}

/**
 * Await one Finalization CI run at the barrier, retrying a TIMEOUT once on
 * the same commit (`restartCiGate` starts a fresh gate run on the unchanged
 * head; nothing has pushed in between). Returns every record awaited.
 *
 * @param {{ ciGateRun: object|null, restartCiGate: () => Promise<object>, log?: Function }} o
 * @returns {Promise<{ record: object|null, records: object[], doubleTimeout: boolean }>}
 */
export async function awaitCiAtBarrier({ ciGateRun, restartCiGate, log = () => {} }) {
    if (!ciGateRun) return { record: null, records: [], doubleTimeout: false };
    const awaitRun = async (run) => {
        try {
            return await run.promise;
        } catch (err) {
            // Unreachable by construction (the promise never rejects).
            log(`[CI Gate] ERROR: the Finalization CI gate run rejected unexpectedly: ${err && err.message ? err.message : String(err)}`);
            return null;
        }
    };
    log(`${LOG_PREFIX} Finalization barrier: Final Review is done; awaiting the CI gate run (workflow '${ciGateRun.workflow}') before deciding whether to extend the sprint.`);
    const records = [];
    let record = await awaitRun(ciGateRun);
    records.push(record);
    let doubleTimeout = false;
    if (record && record.outcome === CI_GATE_OUTCOME.TIMEOUT) {
        log(`${LOG_PREFIX} CI TIMEOUT on workflow '${ciGateRun.workflow}'${record.headSha ? ` at ${record.headSha}` : ''}; retrying the CI gate once on the same commit.`);
        const retryRun = await restartCiGate();
        record = retryRun ? await awaitRun(retryRun) : null;
        records.push(record);
        if (record && record.outcome === CI_GATE_OUTCOME.TIMEOUT) {
            doubleTimeout = true;
            log(`${LOG_PREFIX} ERROR: CI TIMEOUT again on the retry; treating it like a CI FAIL.`);
        }
    }
    return { record, records, doubleTimeout };
}

/**
 * The Finalization barrier and the extension decision. Awaits the CI gate
 * (retrying a TIMEOUT once), classifies every trigger, closes the previous
 * extension's outcome, decides, and -- only when extending -- writes the
 * extension beads inside one gitSync D-pull/D-push bracket and records the
 * new extension in `state`.
 *
 * @returns {Promise<{ extend: boolean, decision: object, ciRecord: object|null, ciUnfixable: boolean, entry: object|null }>}
 */
export async function runFinalizationBarrier({
    log = () => {},
    state,
    maxExtensions,
    cycleLabel,
    goalMax,
    ciGateRun = null,
    restartCiGate = async () => null,
    finalReview = {},
    // Bead writes (only reached when extending on a CI trigger).
    command, backlogMember, parentId, bdListScoped, createChild, gitSync, settle,
}) {
    const { record: ciRecord, doubleTimeout } = await awaitCiAtBarrier({ ciGateRun, restartCiGate, log });
    const { trigger: ciTrigger, unfixable: ciUnfixable } = classifyCiRecord(ciRecord, { doubleTimeout });
    if (ciUnfixable) {
        log(`${LOG_PREFIX} ERROR: CI ${ciRecord ? ciRecord.outcome : 'produced no result'}${ciRecord && ciRecord.reason ? ` (${ciRecord.reason})` : ''} -- not something a code change can fix, so it does NOT trigger a sprint extension. The PR body states it.`);
    }
    const findings = {
        newTasks: ((finalReview && finalReview.newTasks) || []).filter((t) => t && isInGoalPriority(t.priority, goalMax)),
        reopenedIds: ((finalReview && finalReview.reopenedIds) || []).slice(),
    };

    // Close the previous extension's outcome against what this pass found.
    const prev = state.history.length > 0 ? state.history[state.history.length - 1] : null;
    const decision = decideExtension({ state, maxExtensions, ciTrigger, findings });
    if (prev && prev.outcome === null) {
        prev.outcome = decision.hasTrigger
            ? (decision.noProgress ? `not resolved -- ${decision.reason}` : `not resolved -- the next Finalization found: ${describeTrigger({ ci: ciTrigger, findings })}`)
            : `resolved -- the next Finalization found ${ciRecord ? `CI ${ciRecord.outcome}` : 'no CI failure'} and no in-goal Final Review finding`;
        log(`${LOG_PREFIX} Extension ${prev.index}: ${prev.outcome}`);
    }
    if (!decision.hasTrigger) {
        if (ciGateRun || state.history.length > 0) log(`${LOG_PREFIX} no extension: ${decision.reason}.`);
        return { extend: false, decision, ciRecord, ciUnfixable, entry: null };
    }
    const triggerText = describeTrigger({ ci: ciTrigger, findings });
    if (!decision.extend) {
        log(`${LOG_PREFIX} ERROR: NOT extending the sprint (${decision.reason}). Trigger left open: ${triggerText}. The sprint finishes with its own verdict; the PR body says why.`);
        return { extend: false, decision, ciRecord, ciUnfixable, entry: null };
    }

    // Extending: write the CI bead (the findings are already beads) inside
    // one bracket. Final Review already D-pushed its own findings.
    const beads = [];
    let fixCi = null;
    if (ciTrigger) {
        await gitSync.syncBeadsBefore(backlogMember, { fatal: true, settle });
        fixCi = await ensureFixCiBead({
            command, member: backlogMember, state, ciTrigger, parentId, cycleLabel, bdListScoped, createChild, log,
        });
        // Pushed even on a failed write: the create path's fallback may
        // have appended the finding to the parent's notes.
        await gitSync.pushBeadsAfter(backlogMember, { pushBeads: true });
        if (fixCi.id) beads.push(fixCi.id);
    }
    beads.push(...findings.newTasks.map((t) => t.id).filter(Boolean), ...findings.reopenedIds);
    if (ciTrigger && fixCi && fixCi.action === 'failed' && !findingTriggerKey(findings)) {
        const reason = 'the Fix-CI bead could not be written, so an extension cycle would have nothing to work on';
        log(`${LOG_PREFIX} ERROR: NOT extending the sprint (${reason}). Trigger left open: ${triggerText}.`);
        return { extend: false, decision: { ...decision, extend: false, reason }, ciRecord, ciUnfixable, entry: null };
    }
    state.count += 1;
    const entry = {
        index: state.count,
        afterCycle: cycleLabel,
        trigger: { ci: ciTrigger, findings },
        triggerText,
        ciKey: ciTriggerKey(ciTrigger),
        findingKey: findingTriggerKey(findings),
        beads,
        outcome: null,
    };
    state.history.push(entry);
    log(`${LOG_PREFIX} Extension ${entry.index} of at most ${maxExtensions}: re-entering the cycle loop after cycle ${cycleLabel} for ${EXTENSION_CYCLE_BUDGET} cycle(s) (plus the deploy-retry allowance). Trigger: ${triggerText}. Beads in scope: ${beads.length > 0 ? beads.join(', ') : '(created with bd-derived ids; see above)'}.`);
    return { extend: true, decision, ciRecord, ciUnfixable, entry };
}

/**
 * PR-body lines for the extension section. Empty (no section) when the sprint
 * never extended, had no trigger and CI was not FAILED-TO-RUN -- so a sprint
 * without ci_gate and without in-goal Final Review findings renders the same
 * body as before.
 * @param {{ state: object, finalDecision?: object|null, ciUnfixable?: boolean, ciRecord?: object|null, maxExtensions: number }} o
 * @returns {string[]}
 */
export function formatExtensionReport({ state, finalDecision = null, ciUnfixable = false, ciRecord = null, maxExtensions }) {
    const lines = [];
    for (const e of state.history) {
        lines.push(`Extension ${e.index} (after cycle ${e.afterCycle}): trigger: ${e.triggerText}; beads: ${e.beads.length > 0 ? e.beads.join(', ') : '(bd-derived ids)'}; outcome: ${e.outcome || 'not re-checked'}.`);
    }
    if (finalDecision && finalDecision.hasTrigger && !finalDecision.extend) {
        lines.push(`No further extension: ${finalDecision.reason}`);
    }
    if (ciUnfixable) {
        lines.push(`CI ${ciRecord ? ciRecord.outcome : 'FAILED-TO-RUN'} cannot be fixed by a code change, so it did not trigger a sprint extension.`);
    }
    if (lines.length > 0) lines.push(`Extensions used: ${state.count} of at most ${maxExtensions}.`);
    return lines;
}
