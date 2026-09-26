// =============================================================================
// Custom blocks from a sprint design (fleet-sprint/recipe.mjs).
//
// Three kinds, each run through a path the engine already trusts:
//   command -- a shell command on the orchestrator, inside a read-side sync
//              bracket. A failure can become a task ("onFail": "new-task").
//   check   -- a reviewer with the block's instructions as its focus. Its
//              verdict is applied exactly like a Re-Review verdict (guarded
//              reopens, validated new tasks). "onFail": "ignore" keeps it as a
//              report only.
//   work    -- a doer that does the block's instructions on the sprint branch,
//              inside a code-write sync bracket, with the same workspace and
//              permission rules every doer prompt carries.
// Every git/bd command here goes through the injected command(), and this
// module is registered in guarded-modules.mjs, so every guard scans it.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';
import { applyReviewTransitions } from './re-review.mjs';
import { buildWorkBlockPrompt, buildCheckBlockFocus } from '../prompts.mjs';
import { blocksFor } from '../recipe.mjs';

const OUTPUT_TAIL = 3000;

/** Printable-ASCII tail of command output, safe for a task description. */
export function outputTail(text) {
    const clean = String(text || '').replace(/\r/g, '').replace(/[^\t\n\x20-\x7e]/g, '?');
    return clean.length > OUTPUT_TAIL ? '...' + clean.slice(-OUTPUT_TAIL) : clean;
}

/** The task a failed command block files. */
export function commandFailureTask(block, output) {
    return {
        title: `Fix: ${block.name} failed`,
        description: `The sprint design's "${block.name}" block ran:\n\n    ${block.command}\n\n` +
            `and it failed. Make it pass. Output (last part):\n\n${outputTail(output) || '(no output)'}`,
        priority: 'P1',
    };
}

/**
 * Run the design's blocks for one slot ('after-build' or 'finish'). Returns
 * the updated pendingRejectedNewTasks list and how many blocks ran.
 */
export async function runRecipeBlocks({
    slot, recipe, cycle,
    phase, log, command, dispatchCtx,
    validated, targetIssues, orchestratorMember, doerPool, reviewer,
    gitSync, dispatchReview, bdListScoped, updateDashboard,
    transitions,
    dispatchDoer = (ctx, opts) => dispatchRole(ctx, 'doer', opts),
}) {
    const blocks = blocksFor(recipe, slot);
    let pendingRejectedNewTasks = transitions.pendingRejectedNewTasks;
    const where = slot === 'finish' ? '' : ` C${cycle}`;
    for (const block of blocks) {
        phase(`Block: ${block.name}${where}`);
        if (block.kind === 'command') {
            const res = await gitSync.withGitSync(orchestratorMember, false, () => command(block.command, {
                member_name: orchestratorMember, failSoft: true, label: `Block: ${block.name}`,
            }));
            if (res && res.ok) {
                log(`Block "${block.name}"${where}: passed.`);
            } else if (block.onFail === 'new-task') {
                log(`Block "${block.name}"${where}: failed -- filing a task to fix it.`);
                pendingRejectedNewTasks = await applyVerdict({ reopenIds: [], newTasks: [commandFailureTask(block, res && (res.output || res.error))] }, block);
            } else {
                log(`Block "${block.name}"${where}: failed (ignored by the design).`);
            }
        } else if (block.kind === 'check') {
            const scope = await bdListScoped('--json');
            const verdict = await dispatchReview({
                beadIds: targetIssues,
                acceptanceCriteriaJson: JSON.stringify(scope),
                focus: buildCheckBlockFocus(block),
                label: `Block: ${block.name}`,
                // An explicit member keeps this a fresh review session, never
                // a resume of the round reviewer's.
                member: reviewer || orchestratorMember,
            });
            if (block.onFail === 'ignore' || verdict.verdict === 'APPROVED') {
                log(`Block "${block.name}"${where}: ${verdict.verdict}${block.onFail === 'ignore' && verdict.verdict !== 'APPROVED' ? ' (report only, nothing reopened)' : ''}.`);
            } else {
                log(`Block "${block.name}"${where}: ${verdict.verdict} -- applying its findings.`);
                pendingRejectedNewTasks = await applyVerdict(verdict, block);
            }
        } else if (block.kind === 'work') {
            const member = (doerPool && doerPool[0]) || orchestratorMember;
            // Pipeline builders may still sit on a task branch; the block works
            // on the sprint branch.
            await command(`git checkout ${validated.branch}`, {
                member_name: member, silent: true, failSoft: true, label: `Block: ${block.name} -- '${validated.branch}' on '${member}'`,
            });
            const prompt = buildWorkBlockPrompt({ block, branch: validated.branch });
            const outcome = await gitSync.withGitSync(member, true, () => dispatchDoer(dispatchCtx, {
                roleLabel: `Block: ${block.name}`,
                prompt: null,
                resumePrompt: null,
                bindings: ({ resumeAttempt }) => ({
                    doerMember: member,
                    maxTurns: TURN_BASES.BASE_DOER_MAX_TURNS * (2 ** Math.max(resumeAttempt, 1)),
                }),
                // A design block works on no task: nothing to claim, nothing to close.
                claimBeads: async () => {},
                verifyStreakClosed: async () => [],
                prepare: async ({ dispatch }) => (dispatch.kind === 'max-turns-resume'
                    ? {
                        prompt: `Continue exactly where you left off from this same session -- do not restart. Finish the "${block.name}" work on ${validated.branch} and stop at the VERIFY checkpoint.`,
                        label: `Block: ${block.name} (resume)`,
                    }
                    : { prompt, label: `Block: ${block.name}`, bindings: { doerMember: member, doerModel: block.model } }),
            }));
            const value = outcome && outcome.value;
            if (!outcome || outcome.error || !value || value.status === 'BLOCKED') {
                // A step the design asked for did not happen: stop, loudly,
                // rather than carry on as if it had.
                const why = outcome && outcome.error ? outcome.error.message : value ? `the helper reported ${value.status}: ${String(value.notes || '').slice(0, 300)}` : 'no result';
                throw new Error(`Sprint design block "${block.name}" failed: ${why}`);
            }
            log(`Block "${block.name}"${where}: ${value.status}${value.notes ? ' -- ' + String(value.notes).slice(0, 300) : ''}`);
        }
        await updateDashboard();
    }
    return { pendingRejectedNewTasks, ran: blocks.length };

    async function applyVerdict(verdict, block) {
        await gitSync.syncBeadsBefore(orchestratorMember);
        const next = await applyReviewTransitions(verdict, {
            ...transitions, pendingRejectedNewTasks,
            log, command, cycle, validated, targetIssues, orchestratorMember, bdListScoped,
            source: `Block "${block.name}"`, stage: 'recipe-block',
        });
        await gitSync.syncBeadsAfter(orchestratorMember, { pushBeads: true });
        return next;
    }
}
