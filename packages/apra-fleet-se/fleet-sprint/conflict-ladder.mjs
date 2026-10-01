// apra-fleet-eft.8.12 (Plan 3.4 git conflict ladder, script-first posture).
//
// Tier 0 prevention (exclusive per-sprint branch ownership + rebase-before-
// push + globally sequential doer streaks, apra-fleet-eft.8.3/8.4) already
// keeps real content conflicts rare. This module is what runs on the rare
// occasions Tier 0 does not prevent one:
//
//   Tier 1 (SCRIPTED, apra-fleet-eft.8.6): confirm from git's OWN
//   `git status --porcelain` output (never inferred from a failing
//   command's exit code/message alone) whether a failed `git pull --rebase`
//   actually left unmerged paths, and if so restore a clean working tree via
//   `git rebase --abort`. Script-only -- no agent is ever dispatched here.
//
//   Tier 2 (agent-with-runbook, apra-fleet-eft.8.12): a git merge/rebase
//   conflict is BY CONSTRUCTION a same-line (or same-hunk) overlap -- git's
//   own three-way merge already auto-resolves every non-overlapping change
//   silently; conflict markers only ever appear for the overlapping
//   remainder a fixed, mechanical ours/theirs policy cannot arbitrate
//   (blindly preferring one side always risks silently discarding the
//   other's real work). So Tier 1 finding `unmergedPaths.length > 0` IS the
//   single, documented Tier 1 -> Tier 2 escalation point: dispatch an
//   agent, armed with an explicit runbook describing exactly which files are
//   conflicted, to re-attempt the rebase and resolve those files with actual
//   judgment. The agent's own claim is never trusted -- see
//   runner.js's syncMemberAfter Tier 2 call site for the mechanical
//   re-verification (clean porcelain + a real successful re-push) that
//   decides whether Tier 2 actually succeeded.

/**
 * Two-letter `git status --porcelain` XY codes git reserves EXCLUSIVELY for
 * an unresolved merge/rebase conflict (see `git status` docs). Used by
 * parseUnmergedPaths() below to prove an ACTUAL conflict from git's own
 * working-tree state, never inferred from a failing command's exit
 * code/message alone.
 */
const UNMERGED_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parses `git status --porcelain` output and returns the paths whose XY
 * status code marks them as unmerged (conflicted). Any other status
 * (staged/modified/untracked/etc.) is deliberately ignored -- only these
 * codes are unambiguous proof of an in-progress conflict.
 *
 * @param {string} porcelainOutput
 * @returns {string[]}
 */
export function parseUnmergedPaths(porcelainOutput) {
    const text = String(porcelainOutput == null ? '' : porcelainOutput);
    const paths = [];
    for (const line of text.split('\n')) {
        if (!line) continue;
        const code = line.slice(0, 2);
        if (UNMERGED_STATUS_CODES.has(code)) {
            paths.push(line.slice(3).trim());
        }
    }
    return paths;
}

/**
 * Tier 1 SCRIPTED conflict detection + clean-state restore. Called only
 * after a `git pull --rebase` command has already failed (its exit code is
 * why we're here at all). Never trusts that failing command's own exit
 * code/message classification alone to decide whether a rebase is actually
 * mid-conflict -- confirms via git's OWN porcelain status first (a rebase
 * that failed for some other, non-conflict reason before ever touching the
 * tree has nothing to abort). If unmerged paths ARE found, runs
 * `git rebase --abort` to restore a clean working tree, then re-checks
 * porcelain to confirm the abort actually worked (a loud log warning, never
 * a second thrown error, if it somehow did not). Script-only: no agent is
 * ever dispatched here -- the caller decides whether to escalate to Tier 2
 * based on the returned unmerged paths.
 *
 * `runGitStep` is dependency-injected (rather than duplicated here) so this
 * module stays git-primitive-only and shares runner.js's single transient-
 * retry/classification implementation.
 *
 * @param {{
 *   command: Function, member: string, log: Function,
 *   maxTransientRetries: number, runGitStep: Function,
 * }} opts
 * @returns {Promise<string[]>} unmerged paths found (empty array if none)
 */
export async function detectAndAbortRebaseConflict({ command, member, log, maxTransientRetries, runGitStep }) {
    const statusBefore = await runGitStep({
        command, member, cmd: 'git status --porcelain',
        label: `rebase-conflict status check for '${member}'`, log, maxTransientRetries,
    });
    const unmergedPaths = parseUnmergedPaths(statusBefore.output);
    if (unmergedPaths.length === 0) {
        return unmergedPaths;
    }

    log(`[Sync] G-push pull-rebase for member '${member}' left unmerged path(s) (${unmergedPaths.join(', ')}) -- running 'git rebase --abort' to restore a clean working tree (Tier 1, script-only; no agent dispatched).`);
    // Result captured (previously fully discarded) so a failed abort itself
    // is at least logged. It does NOT gate what happens next -- this
    // function's return value (unmergedPaths) was already decided above,
    // before this abort attempt, and the porcelain re-check below is the
    // one authoritative, mechanical signal for whether the tree actually
    // ended up clean (this module's whole reason to exist: "never inferred
    // from a failing command's exit code/message alone"). Silently
    // discarding an abort failure meant it left no trace at all unless the
    // re-check below also happened to fail -- now it always gets its own
    // line.
    const abortResult = await command('git rebase --abort', { member_name: member, silent: true, failSoft: true, label: `G-push rebase --abort for '${member}'` });
    if (!abortResult || !abortResult.ok) {
        log(`[Sync] WARNING: 'git rebase --abort' for member '${member}' reported failure (${abortResult ? abortResult.error : 'no result'}) -- working tree state is unconfirmed until the post-abort status check below.`);
    }

    const statusAfter = await command('git status --porcelain', { member_name: member, silent: true, failSoft: true, label: `post-abort clean-state check for '${member}'` });
    if (!statusAfter || !statusAfter.ok) {
        // `silent + failSoft` means a transport/exec failure here comes back
        // as `ok: false` with no output -- NOT a thrown error. An empty
        // `output` is ALSO exactly what a genuinely clean tree looks like,
        // so treating a failed probe the same as an empty one (the old
        // `(output || '').trim()` behavior) silently reported "clean" for a
        // state that was never actually observed. This is the one place
        // that mistake gets made real: a member that went unreachable right
        // after 'git rebase --abort' would previously be logged as fully
        // recovered. The conservative response -- this function's return
        // value doesn't depend on this check, only the log line does -- is
        // to warn loudly and treat the state as unknown/dirty, never as a
        // silent, unverified "clean".
        log(`[Sync] WARNING: post-abort clean-state check for member '${member}' itself failed (${statusAfter ? statusAfter.error : 'no result'}) -- cannot confirm 'git rebase --abort' actually restored a clean working tree.`);
    } else {
        const remaining = statusAfter.output ? String(statusAfter.output).trim() : '';
        if (remaining !== '') {
            log(`[Sync] WARNING: 'git rebase --abort' for member '${member}' did not fully restore a clean working tree -- porcelain still shows: ${remaining}`);
        }
    }

    return unmergedPaths;
}

/**
 * Builds the self-contained Tier 2 runbook prompt: exactly which files are
 * conflicted, and a fixed sequence of steps to resolve them with real
 * judgment rather than a blind ours/theirs rule. ASCII-only per project
 * convention.
 *
 * @param {{ member: string, branch: string, unmergedPaths: string[], remote?: string }} opts
 * @returns {string}
 */
export function buildConflictResolutionRunbookPrompt({ member, branch, unmergedPaths, remote = 'origin' }) {
    const fileList = unmergedPaths.map((p) => `  - ${p}`).join('\n');
    return [
        'GIT CONFLICT RESOLUTION RUNBOOK (Tier 2 of the git conflict ladder).',
        '',
        `A scripted 'git pull --rebase ${remote} ${branch}' on member '${member}' left the ` +
        'following file(s) with real, same-line/same-hunk merge conflicts that a fixed ' +
        'mechanical ours/theirs policy cannot arbitrate (git already auto-merges every ' +
        'non-overlapping change -- these are what is left over):',
        fileList,
        '',
        'Follow these steps exactly, in order:',
        `1. Run 'git status' to confirm you are mid-rebase with the conflicted file(s) above.`,
        '   If the working tree is already clean (no conflict markers), the conflict was',
        '   already resolved by a prior attempt -- skip to step 5.',
        '2. Open each conflicted file and resolve the <<<<<<< / ======= / >>>>>>> markers by',
        '   understanding BOTH sides of the change and combining them correctly -- never',
        '   blindly delete one side. Preserve the intent of both changes wherever they are',
        '   not truly mutually exclusive; when they are mutually exclusive, prefer the',
        '   version that keeps the codebase buildable and consistent with its surrounding',
        '   code, and note your reasoning.',
        `3. Stage the resolved file(s) with 'git add' and run 'git rebase --continue' ` +
        '(repeat if the rebase has more than one commit to replay).',
        '4. Run the project build/lint/unit tests for the affected area and fix any breakage',
        '   your resolution introduced before proceeding.',
        `5. Run 'git push ${remote} ${branch}' to publish the resolved, clean tree.`,
        '',
        'Do not run any `bd` command and do not touch beads in any way -- this is a pure git',
        'conflict-resolution dispatch, not a development streak.',
    ].join('\n');
}

/**
 * Tier 2: dispatches an agent, armed with the runbook above, to resolve a
 * real (same-line/same-hunk) merge conflict Tier 1 could not mechanically
 * arbitrate. This function only DISPATCHES -- it deliberately does not
 * itself decide whether the attempt succeeded; the caller (runner.js's
 * syncMemberAfter) re-verifies success mechanically afterwards (clean
 * porcelain + an actual successful re-push), exactly like Tier 1 never
 * trusts a failing command's own message alone. Bounded: exactly one Tier 2
 * attempt per conflict -- a genuinely unresolvable conflict still fails
 * after this, rather than looping indefinitely (script-first posture: no
 * unbounded agent escalation).
 *
 * @param {{
 *   agent: Function, member: string, branch: string, unmergedPaths: string[],
 *   log?: Function, model?: string, remote?: string,
 * }} opts
 * @returns {Promise<unknown>} whatever the injected agent() call resolves to
 */
export async function dispatchConflictResolutionAgent({ agent, member, branch, unmergedPaths, log = () => {}, model, remote = 'origin' }) {
    if (typeof agent !== 'function') {
        throw new Error('dispatchConflictResolutionAgent requires an injected agent() in opts');
    }
    log(`[Sync] Tier 2: dispatching a conflict-resolution runbook to member '${member}' for unmerged path(s) [${unmergedPaths.join(', ')}] -- the one documented ladder step above scripted ours/theirs.`);
    const prompt = buildConflictResolutionRunbookPrompt({ member, branch, unmergedPaths, remote });
    return agent(prompt, {
        member_name: member,
        label: `Tier 2 conflict resolution [${unmergedPaths.join(', ')}]`,
        model,
        // EXPLICITLY a fresh session. The runbook above is entirely
        // self-contained (it names the member, the branch and every
        // conflicted path), and the member's stored last session is whatever
        // role dispatch happened to run there -- resuming it would drop a git
        // conflict-resolution instruction into an unrelated conversation.
        // Never rely on an omitted `resume`: execute_prompt defaults it to
        // true, i.e. best-effort reattachment to exactly that stale session.
        resume: false,
        timeout_s: 1800,
        max_total_s: 1800,
    });
}
