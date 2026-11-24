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
 * Inherited edges: a `blocks` edge on an ANCESTOR holds every descendant off
 * the ready list too (a child of a blocked parent is never ready), so the
 * unmet set is the union of the bead's own edges and the edges of every
 * ancestor, walking `.parent` up the FULL chain known to `allBeads` (not
 * stopped at the sprint target roots: an edge above the target holds the
 * descendants just the same). The walk stops at an ancestor the snapshot
 * does not know (its edges cannot be read) and is cycle-guarded. A
 * non-verify unmet blocker anywhere on the chain disqualifies the bead.
 * This is what catches a feature -> feature edge (`bd dep add B A`, A
 * verify-routed): B's child tasks carry no edge of their own.
 *
 * @param {object[]} candidateBeads the beads to check (the sprint scope)
 * @param {object[]} allBeads a full any-status snapshot: status lookup, and
 *   the parent links and dependencies of every ancestor
 * @param {string[]} verifyIds verify-routed bead ids
 * @param {{ closedIds?: Set<string>|string[] }} [opts] when given, the
 *   authoritative closed set (a fresher read than the snapshot's statuses);
 *   a blocker counts as met exactly when it is in this set
 * @returns {{ id: string, title: string, priority: number|null, blockerIds: string[], edges: { from: string, to: string }[] }[]}
 *   `edges` names each verify-routed unmet edge with the bead that actually
 *   carries it (`from`: the bead itself or an ancestor)
 */
export function findVerifyBlockedBeads(candidateBeads, allBeads, verifyIds, { closedIds = null } = {}) {
    const verify = new Set(verifyIds || []);
    if (verify.size === 0) return [];
    const byId = new Map((allBeads || []).filter((b) => b && b.id !== undefined).map((b) => [b.id, b]));
    const closedSet = closedIds ? new Set(closedIds) : null;
    const isClosed = (id) => (closedSet ? closedSet.has(id) : (byId.get(id) || {}).status === 'closed');
    const parentOf = (b) => {
        const p = b && (b.parent !== undefined && b.parent !== null && b.parent !== ''
            ? b.parent
            : (byId.get(b.id) || {}).parent);
        return p === undefined || p === null || p === '' ? null : p;
    };
    const out = [];
    for (const bead of candidateBeads || []) {
        if (!bead || verify.has(bead.id) || !NOT_DONE.has(bead.status)) continue;
        // The bead itself, then each ancestor the snapshot knows.
        const chain = [bead];
        const seen = new Set([bead.id]);
        let parentId = parentOf(bead);
        while (parentId !== null && !seen.has(parentId) && byId.has(parentId)) {
            seen.add(parentId);
            const ancestor = byId.get(parentId);
            chain.push(ancestor);
            parentId = parentOf(ancestor);
        }
        const edges = [];
        for (const carrier of chain) {
            for (const d of carrier.dependencies || []) {
                if (!d || d.type !== 'blocks' || isClosed(d.depends_on_id)) continue;
                edges.push({ from: carrier.id, to: d.depends_on_id });
            }
        }
        if (edges.length === 0 || !edges.every((e) => verify.has(e.to))) continue;
        const uniqueEdges = [...new Map(edges.map((e) => [`${e.from}\u0000${e.to}`, e])).values()]
            .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
        out.push({
            id: bead.id,
            title: bead.title || '',
            priority: Number.isInteger(bead.priority) ? bead.priority : null,
            blockerIds: [...new Set(edges.map((e) => e.to))].sort(),
            edges: uniqueEdges,
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
    // An edge inherited from an ancestor is named on the ancestor that carries
    // it: that is the edge `bd dep remove` has to delete. A blocked entry with
    // no `edges` (an older caller's shape) carries its own edges.
    const edgesOf = (b) => (Array.isArray(b.edges) && b.edges.length > 0
        ? b.edges
        : b.blockerIds.map((to) => ({ from: b.id, to })));
    const viaText = (b) => {
        const carriers = [...new Set(edgesOf(b).map((e) => e.from).filter((from) => from !== b.id))];
        return carriers.length > 0 ? ` (inherited from ancestor ${carriers.join(', ')})` : '';
    };
    const list = blocked
        .map((b) => `${b.id}${b.title ? ` (${b.title})` : ''} is blocked only by verify-routed bead(s) ${b.blockerIds.join(', ')}${viaText(b)}`)
        .join('; ');
    const depRemovals = [...new Set(blocked
        .flatMap((b) => edgesOf(b).map((e) => `bd dep remove ${e.from} ${e.to}`)))]
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
