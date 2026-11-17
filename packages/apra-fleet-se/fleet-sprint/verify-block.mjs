// =============================================================================
// VERIFY-BLOCK DEADLOCK DIAGNOSIS (GitHub #717).
//
// A verify-routed bead (classifyVerifySet in beads-scope.mjs: childful, every
// child closed, no unmet blocker) closes ONLY in the Integration Test phase,
// and that phase runs only when integ-test-playbook.md exists AND deploy.md
// exists AND the deploy succeeded this cycle. A bead whose only unmet `blocks`
// dependencies are verify-routed beads can therefore never become ready while
// the Integration Test phase cannot run -- the sprint used to loop, paying for
// cycles, until the stall net ended it FAIL with no diagnosis.
//
// This module is the pure half of the fix: the one integCanRun predicate, the
// shape detector and the diagnosis text (which names every blocked bead, its
// verify-routed blockers and the exact fix). runner.js owns the runbook
// probes, the pre-sprint stop and the mid-run exit; phases/final-review.mjs
// applies the verdict gate. Diagnose only: nothing here rewrites the DAG.
//
// GUARD COVERAGE: registered in guarded-modules.mjs. It carries no command()
// or agent() call site.
// =============================================================================

const NOT_DONE = new Set(['open', 'in_progress', 'blocked']);

/**
 * Whether the Integration Test phase can run (and so close verify-routed
 * beads): integ-test-playbook.md present AND deploy.md present AND the deploy
 * either succeeded this cycle or has not been attempted yet.
 * @param {{ hasPlaybook: boolean, hasDeploy: boolean, deployAttempted?: boolean, deployedThisCycle?: boolean }} s
 */
export function integCanRun({ hasPlaybook, hasDeploy, deployAttempted = false, deployedThisCycle = false }) {
    return Boolean(hasPlaybook) && Boolean(hasDeploy) && (!deployAttempted || Boolean(deployedThisCycle));
}

/**
 * Why the Integration Test phase cannot run, in the precedence an operator
 * has to fix it in; null when it can run.
 * @returns {'no-playbook'|'no-deploy'|'deploy-failed'|null}
 */
export function integBlockCause({ hasPlaybook, hasDeploy, deployAttempted = false, deployedThisCycle = false }) {
    if (!hasPlaybook) return 'no-playbook';
    if (!hasDeploy) return 'no-deploy';
    if (deployAttempted && !deployedThisCycle) return 'deploy-failed';
    return null;
}

/**
 * Not-done beads whose unmet `blocks` dependencies are ALL verify-routed
 * beads (and at least one exists). A dependency on a bead the snapshot does
 * not know counts as unmet and NOT verify-routed, so it never produces a
 * false diagnosis.
 *
 * @param {object[]} candidateBeads the beads to check (the sprint scope)
 * @param {object[]} allBeads a full any-status snapshot for status lookup
 * @param {string[]} verifyIds verify-routed bead ids
 * @returns {{ id: string, title: string, priority: number|null, blockerIds: string[] }[]}
 */
export function findVerifyBlockedBeads(candidateBeads, allBeads, verifyIds) {
    const verify = new Set(verifyIds || []);
    if (verify.size === 0) return [];
    const statusById = new Map((allBeads || []).map((b) => [b.id, b.status]));
    const out = [];
    for (const bead of candidateBeads || []) {
        if (!bead || verify.has(bead.id) || !NOT_DONE.has(bead.status)) continue;
        const unmet = (bead.dependencies || [])
            .filter((d) => d && d.type === 'blocks')
            .map((d) => d.depends_on_id)
            .filter((depId) => statusById.get(depId) !== 'closed');
        if (unmet.length === 0 || !unmet.every((depId) => verify.has(depId))) continue;
        out.push({
            id: bead.id,
            title: bead.title || '',
            priority: Number.isInteger(bead.priority) ? bead.priority : null,
            blockerIds: [...new Set(unmet)].sort(),
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Split blocked beads into goal-priority (stop) and below-goal (warn only).
 * `goalMax` is goalPriorityMax()'s 'Pn' token (a bare number is accepted
 * too); a bead with no recorded priority counts as at-goal.
 */
export function partitionByGoal(blocked, goalMax) {
    const max = typeof goalMax === 'number' ? goalMax : Number(String(goalMax).replace(/^P/i, ''));
    if (!Number.isFinite(max)) {
        throw new TypeError(`partitionByGoal: goalMax must be a 'Pn' priority token or a number; got ${JSON.stringify(goalMax)}`);
    }
    const atGoal = [];
    const belowGoal = [];
    for (const b of blocked || []) {
        if (b.priority === null || b.priority <= max) atGoal.push(b);
        else belowGoal.push(b);
    }
    return { atGoal, belowGoal };
}

const CAUSE_TEXT = {
    'no-playbook': {
        why: 'integ-test-playbook.md is missing, so the Integration Test phase never runs',
        fix: 'add integ-test-playbook.md so the Integration Test phase can verify and close the verify-routed blocker(s)',
    },
    'no-deploy': {
        why: 'deploy.md is missing, so there is no deployed build and the Integration Test phase never runs',
        fix: 'add deploy.md so the build can be deployed and the Integration Test phase can verify and close the verify-routed blocker(s)',
    },
    'deploy-failed': {
        why: 'the deploy failed this cycle, so the Integration Test phase did not run',
        fix: 'fix the failing deploy (see the deploy notes) and re-run the sprint, so the Integration Test phase can verify and close the verify-routed blocker(s)',
    },
};

/**
 * The named diagnosis: every blocked bead, its verify-routed blockers, why the
 * Integration Test phase cannot run, and the exact fix -- either make it able
 * to run, or (when the ordering is not real) remove the dependency with the
 * exact `bd dep remove <blocked> <blocker>` command.
 * @param {{ blocked: object[], cause: string, deployNotes?: string|null }} opts
 */
export function buildVerifyBlockDiagnosis({ blocked, cause, deployNotes = null }) {
    const text = CAUSE_TEXT[cause] || CAUSE_TEXT['no-playbook'];
    const list = blocked
        .map((b) => `${b.id}${b.title ? ` (${b.title})` : ''} is blocked only by verify-routed bead(s) ${b.blockerIds.join(', ')}`)
        .join('; ');
    const depRemovals = blocked
        .flatMap((b) => b.blockerIds.map((blocker) => `bd dep remove ${b.id} ${blocker}`))
        .join('; ');
    return (
        `Verify-block deadlock: ${blocked.length} bead(s) can never become ready -- every unmet blocker is a ` +
        'verify-routed bead (all of its children closed), which only the Integration Test phase can close, and ' +
        `${text.why}${cause === 'deploy-failed' && deployNotes ? ` (${deployNotes})` : ''}. ${list}. ` +
        `Fix: ${text.fix}; or, if the ordering is not a real need, remove the dependency: ${depRemovals}.`
    );
}

/**
 * The verdict gate for a sprint that ended on a verify-block deadlock: never
 * PASS. Mirrors the deploy-failure gate in phases/deploy.mjs -- the verdict
 * becomes FAIL and the diagnosis leads the notes.
 */
export function applyVerifyBlockVerdictGate(verdictResult, diagnosis) {
    if (!diagnosis) return verdictResult;
    const prior = verdictResult && typeof verdictResult.notes === 'string' ? verdictResult.notes : '';
    const overridden = !verdictResult || verdictResult.verdict === 'PASS';
    return {
        ...(verdictResult || {}),
        verdict: 'FAIL',
        notes: diagnosis +
            (overridden ? ' (Final Review returned PASS; the engine overrode it to FAIL.)' : '') +
            (prior ? `\n\n${prior}` : ''),
    };
}
