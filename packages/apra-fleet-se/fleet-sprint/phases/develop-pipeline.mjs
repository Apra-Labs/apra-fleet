// =============================================================================
// PHASE MODULE: Build pipeline (docs/lazy-parallel-sprints.md, milestone 1).
//
// Replaces the Develop/Review round loop when the sprint runs with
// `pipeline: true`. Instead of rounds with a barrier and a review after each,
// every ready task is started as soon as a member is free, built on ITS OWN
// branch, and landed onto the sprint branch one at a time by the
// orchestrator. When a landing unblocks more tasks they start immediately.
// Review is not run here: the cycle's existing Re-Review (runner.js, Cycle
// Evaluation) reviews the whole cycle once every task has landed, and the
// existing Deploy/Integ Test phases check the combined result first.
//
// THE TWO INVARIANTS THE ROUND LOOP'S SERIAL DOER GATE PROTECTED, AND WHERE
// THEY LIVE NOW:
//   1. One writer per branch. Each doer's bracket is bound to its own task
//      branch (makeBranchGitSync -> git-sync.mjs branchCodeWriteKey), so two
//      doers never push the same branch. Only the landing queue below writes
//      the sprint branch, and it runs one landing at a time, inside the
//      sprint's own code-write bracket.
//   2. One writer of the task database. Doers are told the orchestrator owns
//      claim/close (doer.md "externally-managed bead state") and run no `bd`.
//      The orchestrator claims when a task starts, closes when it lands, and
//      reopens when it gives up, each inside a sanctioned beads bracket.
//
// SHARED WORKSPACE. When members share one checkout (pipelineParallel false,
// i.e. no --sync), concurrent doers would share one working tree, so the
// pipeline runs one task at a time there -- same flow, no overlap.
//
// GUARD COVERAGE: registered as 'phases/develop-pipeline.mjs' in
// ../guarded-modules.mjs. Every command() names its member, every dispatch
// goes through dispatchRole's 'doer' row, and every push happens inside a
// git-sync bracket.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';
import { buildPipelineDoerPrompt, buildPipelineFixPrompt } from '../prompts.mjs';

/** How many times one task may bounce at landing before it is given back. */
export const MAX_LANDING_BOUNCES = 3;

/** Task branch name for `taskId` on `sprintBranch`. */
export function taskBranchName(sprintBranch, taskId) {
    return `${sprintBranch}--task-${String(taskId).replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

/** Files a task is expected to touch (planner metadata `files`), for overlap avoidance. */
export function predictedFiles(task) {
    const raw = task && task.metadata ? task.metadata.files : undefined;
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
}

/** True when two predicted-file lists share a file (unknown lists never overlap). */
export function filesOverlap(a, b) {
    if (a.length === 0 || b.length === 0) return false;
    const set = new Set(a);
    return b.some((f) => set.has(f));
}

/**
 * Pick the tasks to start now. Pure, so the scheduling rules are testable on
 * their own: respects the concurrency limit, never starts a task already in
 * flight or given up on, and defers a task whose predicted files overlap one
 * in flight (it starts once that one lands).
 */
export function selectTasksToStart({ ready, inFlight, givenUp, freeMembers, limit }) {
    const picks = [];
    const busyFiles = [...inFlight.values()].map((f) => f.files);
    let slots = Math.min(freeMembers, limit - inFlight.size);
    for (const task of ready) {
        if (slots <= 0) break;
        if (inFlight.has(task.id) || givenUp.has(task.id)) continue;
        const files = predictedFiles(task);
        if (busyFiles.some((b) => filesOverlap(b, files))) continue;
        picks.push(task);
        busyFiles.push(files);
        slots -= 1;
    }
    return picks;
}

/**
 * Runs the build pipeline for one cycle.
 *
 * @param {object} state Explicit phase state (same discipline as develop.mjs).
 * @returns {Promise<{ streakOutcomes: object[], landedIds: string[], givenUpIds: string[] }>}
 */
export async function runBuildPipelinePhase({
    phase,
    log,
    command,
    dispatchCtx,
    cycle,
    validated,
    orchestratorMember,
    gitSync,
    makeBranchGitSync,
    updateDashboard,
    kbPriming,
    kbWork,
    kbQueryTerms,
    normalizeTierToken,
    doerPool,
    listReady,
    onLanded = async () => {},
    // Test seam: how one doer dispatch is issued. Production uses the
    // role table's 'doer' row; tests substitute a doer that edits real files.
    dispatchDoer = (ctx, opts) => dispatchRole(ctx, 'doer', opts),
}) {
    phase(`Build C${cycle}`);
    const sprintBranch = validated.branch;
    const parallel = validated.pipelineParallel === true;

    // Members that build tasks. With separate checkouts the orchestrator's
    // checkout is kept on the sprint branch for landings, so it builds only
    // when it is the sole member.
    const builders = parallel && doerPool.length > 1
        ? doerPool.filter((m) => m !== orchestratorMember)
        : [...new Set(doerPool)];
    const limit = parallel ? (validated.maxDoers || Infinity) : 1;
    const free = [...(builders.length ? builders : [orchestratorMember])];

    const inFlight = new Map();   // taskId -> { member, files, promise }
    const givenUp = new Set();
    const streakOutcomes = [];
    const landedIds = [];
    // Every orchestrator-side step (claims, give-backs, landings) runs through
    // ONE queue: they all touch the orchestrator's checkout or its task
    // database, and neither tolerates two writers at once.
    let orchestratorQueue = Promise.resolve();
    const onOrchestrator = (fn) => {
        const result = orchestratorQueue.then(fn, fn);
        orchestratorQueue = result.catch(() => {});
        return result;
    };
    // Wake-up for the scheduler. `pending` covers a task finishing between
    // the scheduler's last look and its wait, so no wake-up is ever lost.
    let wake = null;
    let pending = false;
    const signal = () => {
        pending = true;
        if (wake) { const w = wake; wake = null; w(); }
    };

    const widthText = !parallel
        ? 'one task at a time (shared workspace)'
        : (limit === Infinity ? 'every ready task at once' : 'up to ' + limit + ' at once');
    const gateText = validated.gateCommand ? " gated by '" + validated.gateCommand + "'" : ' (no gate command)';
    log(
        `Build C${cycle}: pipeline mode -- ${widthText} across ${free.length} builder member(s): ` +
        `${free.join(', ')}; landings on '${orchestratorMember}'${gateText}.`
    );

    // --- orchestrator-owned task-database writes ---------------------------
    const beadsWrite = (cmd, label) => onOrchestrator(async () => {
        await gitSync.syncBeadsBefore(orchestratorMember);
        const res = await command(cmd, { member_name: orchestratorMember, failSoft: true, silent: true, label });
        await gitSync.syncBeadsAfter(orchestratorMember);
        return res;
    });

    // --- one landing, run strictly one at a time ---------------------------
    const land = (task, member, taskBranch) => {
        const run = async () => {
            const sameCheckout = member === orchestratorMember;
            // The orchestrator's checkout must be ON the sprint branch before
            // its bracket fast-forwards it; in a shared workspace the doer
            // left it on the task branch.
            await command(`git checkout ${sprintBranch}`, {
                member_name: orchestratorMember, silent: true, label: `Pipeline: back to '${sprintBranch}' for landing`,
            });
            return gitSync.withGitSync(orchestratorMember, true, async () => {
                if (!sameCheckout) {
                    await command(`git fetch origin ${taskBranch} --quiet`, {
                        member_name: orchestratorMember, silent: true, label: `Pipeline: fetch '${taskBranch}'`,
                    });
                }
                const ref = sameCheckout ? taskBranch : `origin/${taskBranch}`;
                const ahead = await command(`git rev-list --count ${sprintBranch}..${ref}`, {
                    member_name: orchestratorMember, silent: true, failSoft: true, label: `Pipeline: count commits on '${taskBranch}'`,
                });
                // Only a clean "0" means nothing to land. An unreadable count is
                // not evidence of an empty branch, so the merge decides instead.
                if (ahead.ok && /^\s*0\s*$/.test(String(ahead.output))) {
                    return { landed: false, reason: 'no-commits' };
                }
                const merge = await command(`git merge --no-ff --no-edit ${ref}`, {
                    member_name: orchestratorMember, silent: true, failSoft: true, label: `Pipeline: merge '${taskBranch}'`,
                });
                if (!merge.ok) {
                    const unmerged = await command('git diff --name-only --diff-filter=U', {
                        member_name: orchestratorMember, silent: true, failSoft: true, label: 'Pipeline: list conflicting files',
                    });
                    await command('git merge --abort', {
                        member_name: orchestratorMember, silent: true, failSoft: true, label: 'Pipeline: abort conflicting merge',
                    });
                    const files = unmerged.ok ? String(unmerged.output).split('\n').map((s) => s.trim()).filter(Boolean) : [];
                    return { landed: false, reason: 'conflict', files, ref };
                }
                if (validated.gateCommand) {
                    const gate = await command(validated.gateCommand, {
                        member_name: orchestratorMember, failSoft: true, label: `Pipeline: gate after merging '${taskBranch}'`,
                    });
                    if (!gate.ok) {
                        await command('git reset --hard ORIG_HEAD', {
                            member_name: orchestratorMember, silent: true, label: 'Pipeline: undo merge after failed gate',
                        });
                        const out = String(gate.error || gate.output || '').slice(-4000);
                        return { landed: false, reason: 'gate', output: out, ref };
                    }
                }
                const close = await command(`bd close ${task.id} --reason landed`, {
                    member_name: orchestratorMember, silent: true, failSoft: true, label: `Pipeline: close '${task.id}'`,
                });
                if (!close.ok && !/already closed/i.test(String(close.error))) {
                    log(`Build C${cycle}: '${task.id}' landed on '${sprintBranch}' but closing it failed (${close.error}); it will read as open until fixed.`);
                }
                return { landed: true };
            }, { pushBeads: true });
        };
        return onOrchestrator(run);
    };

    // --- one task, start to landed (or given back) -------------------------
    const runTask = async (task, member) => {
        const taskBranch = taskBranchName(sprintBranch, task.id);
        const sameCheckout = member === orchestratorMember;
        const branchSync = makeBranchGitSync(taskBranch);
        const ctx = { ...dispatchCtx, withGitSync: (m, pushCode, fn, opts) => branchSync.withGitSync(m, pushCode, fn, opts) };
        const model = normalizeTierToken(task.metadata && task.metadata.model);

        // Cut the task branch from the latest sprint branch.
        if (!sameCheckout) {
            await command(`git fetch origin ${sprintBranch} --quiet`, {
                member_name: member, silent: true, failSoft: true, label: `Pipeline: fetch '${sprintBranch}' on '${member}'`,
            });
        }
        const base = sameCheckout ? sprintBranch : `origin/${sprintBranch}`;
        await command(`git checkout -B ${taskBranch} ${base}`, {
            member_name: member, silent: true, label: `Pipeline: start '${taskBranch}' on '${member}'`,
        });

        const repoPath = kbPriming.folderOf(member);
        const knowledge = await kbWork.relevantKnowledge(repoPath, kbQueryTerms([task], [task.id]));
        let prompt = buildPipelineDoerPrompt({
            task, taskBranch, sprintBranch,
            kbKnowledge: knowledge.length > 0 ? knowledge : kbPriming.knowledgeOf(member),
        });

        for (let bounce = 0; ; bounce++) {
            const outcome = await dispatchDoer(ctx, {
                roleLabel: `Pipeline doer [${task.id}]`,
                prompt: null,
                resumePrompt: null,
                // Same escalating turn budget the round loop's doer uses.
                bindings: ({ resumeAttempt }) => ({
                    doerMember: member,
                    maxTurns: TURN_BASES.BASE_DOER_MAX_TURNS * (2 ** Math.max(resumeAttempt, 1)),
                }),
                // The orchestrator already claimed this task.
                claimBeads: async () => {},
                // The doer closes nothing, so "closed" is decided at landing.
                // Before a resume, report the task unfinished so a
                // turn-exhausted doer is resumed rather than assumed done.
                verifyStreakClosed: async (when) => (when === 'preDispatch' ? [task.id] : []),
                prepare: async ({ dispatch }) => (dispatch.kind === 'max-turns-resume'
                    ? {
                        prompt: 'Continue exactly where you left off from this same session -- do not restart. ' +
                            `Your scope, restated: bead ${task.id} on task branch ${taskBranch}. Finish it and stop at the VERIFY checkpoint.`,
                        label: `Pipeline doer [${task.id}] (resume)`,
                    }
                    : { prompt, label: `Streak [${task.id}]`, bindings: { doerMember: member, doerModel: model } }),
            });

            if (outcome.error || !outcome.value || outcome.value.status === 'BLOCKED') {
                const why = outcome.error ? outcome.error.message : `doer reported ${outcome.value ? outcome.value.status : 'nothing'}`;
                return { task, member, landed: false, reason: 'doer-failed', detail: why };
            }

            const result = await land(task, member, taskBranch);
            if (result.landed) return { task, member, landed: true, bounces: bounce };
            if (result.reason === 'no-commits') {
                return { task, member, landed: false, reason: 'no-commits', detail: 'the doer finished without committing anything' };
            }
            if (bounce + 1 >= MAX_LANDING_BOUNCES) {
                return { task, member, landed: false, reason: result.reason, detail: `bounced ${MAX_LANDING_BOUNCES} times` };
            }
            log(
                `Build C${cycle}: '${task.id}' could not land (${result.reason}` +
                `${result.files && result.files.length ? `: ${result.files.join(', ')}` : ''}) -- handing it back to '${member}' to merge the latest '${sprintBranch}' and fix.`
            );
            if (!sameCheckout) {
                await command(`git fetch origin ${sprintBranch} --quiet`, {
                    member_name: member, silent: true, failSoft: true, label: `Pipeline: refresh '${sprintBranch}' on '${member}'`,
                });
            }
            // A shared workspace was switched to the sprint branch for the landing.
            await command(`git checkout ${taskBranch}`, {
                member_name: member, silent: true, label: `Pipeline: back to '${taskBranch}' on '${member}'`,
            });
            prompt = buildPipelineFixPrompt({
                task, taskBranch, sprintBranch,
                mergeRef: sameCheckout ? sprintBranch : `origin/${sprintBranch}`,
                reason: result.reason, conflictFiles: result.files || [], gateOutput: result.output || '',
            });
        }
    };

    const start = async (task) => {
        const member = free.shift();
        const claim = await beadsWrite(`bd update ${task.id} --status in_progress`, `Pipeline: claim '${task.id}'`);
        if (!claim.ok) {
            free.push(member);
            givenUp.add(task.id);
            log(`Build C${cycle}: could not claim '${task.id}' (${claim.error}); skipping it this cycle.`);
            return;
        }
        log(`Build C${cycle}: '${task.id}' (${task.title}) -> '${member}'.`);
        const entry = { member, files: predictedFiles(task), promise: null };
        inFlight.set(task.id, entry);
        entry.promise = (async () => {
            let r;
            try {
                r = await runTask(task, member);
            } catch (err) {
                r = { task, member, landed: false, reason: 'error', detail: err && err.message ? err.message : String(err) };
            }
            if (r.landed) {
                landedIds.push(task.id);
                streakOutcomes.push({ beadIds: [task.id], doerMember: member, outcome: r.bounces ? 'retried' : 'success', closedIds: [task.id], unclosedIds: [] });
                log(`Build C${cycle}: landed '${task.id}' on '${sprintBranch}'${r.bounces ? ` after ${r.bounces} fix round(s)` : ''}.`);
                try {
                    await onLanded({ task, member, cycle });
                } catch (err) {
                    log(`Build C${cycle}: landing hook failed for '${task.id}' (non-fatal): ${err.message}`);
                }
            } else {
                givenUp.add(task.id);
                await beadsWrite(`bd update ${task.id} --status open`, `Pipeline: give back '${task.id}'`);
                streakOutcomes.push({ beadIds: [task.id], doerMember: member, outcome: 'failed', closedIds: [], unclosedIds: [task.id], error: `${r.reason}: ${r.detail}` });
                log(`Build C${cycle}: gave '${task.id}' back (${r.reason}: ${r.detail}); the next cycle can pick it up again.`);
            }
            inFlight.delete(task.id);
            free.push(member);
            await updateDashboard();
            signal();
        })();
    };

    // Task branches are cut from origin/<sprint>, so the sprint branch must be
    // on the remote before the first one starts. A sanctioned bracketed push;
    // a no-op when it is already there.
    await onOrchestrator(async () => {
        await command(`git checkout ${sprintBranch}`, {
            member_name: orchestratorMember, silent: true, label: `Pipeline: '${sprintBranch}' on '${orchestratorMember}'`,
        });
        await gitSync.pushGitAfter(orchestratorMember);
    });

    // --- scheduler ----------------------------------------------------------
    for (;;) {
        pending = false;
        const ready = await listReady();
        const picks = selectTasksToStart({ ready, inFlight, givenUp, freeMembers: free.length, limit });
        for (const task of picks) await start(task);
        if (inFlight.size === 0) break;
        if (!pending) await new Promise((resolve) => { wake = resolve; });
    }
    await orchestratorQueue;

    log(
        `Build C${cycle} done: landed ${landedIds.length} task(s)` +
        `${givenUp.size ? `, gave back ${givenUp.size} (${[...givenUp].join(', ')})` : ''}.`
    );
    return { streakOutcomes, landedIds, givenUpIds: [...givenUp] };
}
