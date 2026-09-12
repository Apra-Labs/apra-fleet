// Typed sprint-abort detection, abort-path PR publish and the newTask
// validation/persistence helpers for fleet-sprint (apra-fleet-3swo.3.6).
// Moved verbatim out of runner.js -- runner.js re-exports isTypedAbortError,
// finalizeAbort and persistNewTaskBestEffort so existing importers keep
// working. This is a move-only extraction: predicate logic, the finalizeAbort
// degrade-on-failed-provider-resolution path, and the persistNewTaskBestEffort
// non-fatal fallback ladder are all unchanged.
//
// Scope note (apra-fleet-3swo.3.6): the bead names only two new files
// (abort.mjs, branch-ensure.mjs) for three conceptual clusters -- abort
// predicates, the pure branch-selection helper, and newTask
// validation/persistence. branch-ensure.mjs's name is unambiguous (the
// branch-selection helper only), so the newTask validation/persistence
// cluster is folded into this file to stay within the bead's three-file
// budget (abort.mjs, branch-ensure.mjs, runner.js) rather than adding a
// fourth file for a small, self-contained cluster.
//
// SAFE_TEXT_RE, runGitStep, sanitizePrText and stageCommandBodyMemberSide stay
// in runner.js (out of this bead's scope -- each has a second, non-moving
// caller: SAFE_TEXT_RE/sanitizePrText also gate the Publish PR step's text,
// runGitStep is the main withGitSync dispatch bracket's own helper, and
// stageCommandBodyMemberSide also backs createChildBeadWithAllocatedId) and
// are imported back here; findDoltDivergedCause similarly stays (used
// elsewhere in runner.js) and is imported back for isTypedAbortError. The
// resulting runner.js <-> abort.mjs cycle is safe because every use is inside
// a function body, never at module-evaluation time.
import { CommandError, BudgetExceededError, CancelledError } from '@apralabs/apra-fleet-workflow';
import { SprintPlanRejectedError, StalledSprintError, ReviewerContractViolationError, GitDivergedError } from './errors.mjs';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { resolveProvider, capabilities as vcsCapabilities } from './vcs-module.mjs';
import { raiseVcsPrForMember, PR_SKIPPED_NO_MCP_CLIENT } from './vcs-auth.mjs';
import {
    findDoltDivergedCause, runGitStep, sanitizePrText, stageCommandBodyMemberSide, SAFE_TEXT_RE,
} from './runner.js';

/**
 * Follow-up-task persistence is bookkeeping -- it must NEVER abort the sprint.
 * Every persistence path degrades instead of throwing: bd create ->
 * parent-bead notes -> this run log, in that order.
 */
export async function persistNewTaskBestEffort({ createFn, command, member, parentId, newTask, cycle, log = () => {}, stage }) {
    try {
        // createFn's return value (when it forwards createChildBeadWithAllocatedId's
        // { childId }) lets callers log exactly which bead id was created, not just
        // a count. Existing callers that ignore the return value are unaffected --
        // this is still truthy either way.
        const result = await createFn();
        return result ?? true;
    } catch (err) {
        log(`[fleet-sprint] newTask bd create FAILED (non-fatal, ${stage}): ${err.message} -- falling back to parent-bead notes.`);
        try {
            await appendRejectedFindingToParentNotes({
                command, member, parentId, newTask,
                reason: `bd create failed (${stage}): ${err.message}`, cycle, log,
            });
        } catch (err2) {
            log(`[fleet-sprint] newTask persistence FAILED at every level (non-fatal, ${stage}); finding preserved VERBATIM in this run log: ${JSON.stringify(newTask)} -- last error: ${err2.message}`);
        }
        return false;
    }
}

const SAFE_DESCRIPTION_RE = /^[\t\n\r\x20-\x7E]+$/;
const SAFE_PRIORITY_RE = /^P[0-4]$/;

/**
 * Rewrites the handful of common non-ASCII punctuation characters LLM
 * reviewers routinely emit in newTask descriptions -- em/en dashes, curly
 * quotes, ellipsis -- to ASCII equivalents before SAFE_DESCRIPTION_RE
 * validation, so a description is not rejected wholesale over characters that
 * lose no meaning when normalized. This is a fixed substitution table, not a
 * general Unicode stripper: anything still outside the allowlist afterwards is
 * still a hard rejection. See sanitizeNewTaskTitle() below for title's own,
 * stricter table.
 * @param {string} description
 * @returns {string}
 */
export function sanitizeNewTaskDescription(description) {
    return String(description ?? '')
        .replace(/[\u2014\u2013]/g, '--') // em dash (\u2014), en dash (\u2013)
        .replace(/[\u2018\u2019]/g, "'") // curly single quotes (\u2018 \u2019)
        .replace(/[\u201C\u201D]/g, '"') // curly double quotes (\u201C \u201D)
        .replace(/\u2026/g, '...'); // horizontal ellipsis (\u2026)
}

/**
 * Same idea as sanitizeNewTaskDescription() above, for title -- but with a
 * STRICTER substitution table, since title still has to pass the tighter
 * SAFE_TEXT_RE shell-safety allowlist afterwards (it is interpolated inline
 * into a `bd create "..."` command; description is not). Every substitution
 * here maps to a character SAFE_TEXT_RE already admits, so this never
 * reopens the injection surface that allowlist exists to close -- it only
 * rescues titles that would otherwise be needlessly rejected over benign,
 * common LLM punctuation choices. Observed live (apra-fleet-vk0a's sibling
 * finding): a reviewer wrote a title referencing a CLI command in backticks
 * (`` `apra-fleet status` ``, ordinary Markdown inline-code style), which
 * SAFE_TEXT_RE rejects outright (backtick is excluded as a POSIX
 * command-substitution risk) -- the finding was then silently demoted to a
 * freetext note on the parent bead instead of becoming its own actionable
 * task. Backtick has no special meaning in a bd title (bd has no
 * code-formatting concept), so it is rewritten to a single quote here rather
 * than dropped or preserved. A literal `"`/`$`/backslash in a title is NOT
 * rewritten (there is no safe ASCII stand-in that preserves meaning without
 * reopening the injection question) -- those still hard-reject via
 * SAFE_TEXT_RE below, exactly as before this function existed.
 * @param {string} title
 * @returns {string}
 */
export function sanitizeNewTaskTitle(title) {
    return String(title ?? '')
        .replace(/[\u2014\u2013]/g, '--') // em dash (\u2014), en dash (\u2013)
        .replace(/[\u2018\u2019]/g, "'") // curly single quotes (\u2018 \u2019)
        .replace(/[\u201C\u201D]/g, "'") // curly double quotes -> single quote (a literal `"` stays disallowed in title, unlike description)
        .replace(/\u2026/g, '...') // horizontal ellipsis (\u2026)
        .replace(/`/g, "'"); // backtick (Markdown inline-code marker) -> single quote
}

/**
 * Validates one reviewer-authored newTask entry. `title` is checked against
 * SAFE_TEXT_RE because it is interpolated inline into a `bd create` command
 * string; `description` is checked against the more permissive
 * SAFE_DESCRIPTION_RE because it travels via `bd create --body-file` and is
 * never shell-interpolated (see createChildBeadWithAllocatedId). Returns
 * either `{ ok: true, title, description, priority }` (safe to use) or
 * `{ ok: false, reason }`. A rejected entry must never reach `command()` as a
 * `bd create` interpolation; rejection is non-fatal and the sprint continues.
 * @param {{ title: unknown, description: unknown, priority: unknown }} newTask
 * @returns {{ ok: true, title: string, description: string, priority: string } | { ok: false, reason: string }}
 */
export function validateNewTask(newTask) {
    const priority = String(newTask && newTask.priority);
    if (!SAFE_PRIORITY_RE.test(priority)) {
        return { ok: false, reason: `priority '${priority}' does not match required pattern ${SAFE_PRIORITY_RE}` };
    }
    const title = sanitizeNewTaskTitle(newTask && newTask.title);
    if (!title || !SAFE_TEXT_RE.test(title)) {
        return { ok: false, reason: `title fails safe-character allowlist ${SAFE_TEXT_RE} (or is empty): ${JSON.stringify(title)}` };
    }
    const description = sanitizeNewTaskDescription(newTask && newTask.description);
    if (!description || !SAFE_DESCRIPTION_RE.test(description)) {
        return { ok: false, reason: `description fails ASCII-printable validation ${SAFE_DESCRIPTION_RE} (or is empty): ${JSON.stringify(description)}` };
    }
    return { ok: true, title, description, priority };
}

/**
 * Persists a newTask that failed validateNewTask() into the parent bead's
 * notes, raw and unmodified (title/description/priority plus the rejection
 * reason), so a rejected finding is still recoverable by a human or the next
 * planner even though it was not filed as its own child bead. The note body
 * goes through the same member-side staging seam as the description path
 * (stageCommandBodyMemberSide) and is never interpolated into a shell string.
 *
 * A failure to append is logged AND re-thrown. Every call site wraps this in
 * its own try/catch whose purpose is to log the raw finding verbatim as the
 * last fallback rung; swallowing the failure here would make that rung
 * unreachable on exactly the path it exists to cover. Re-throwing is still
 * non-fatal to the sprint -- the caller's catch is what contains it.
 * @param {{ command: Function, member: string, parentId: string, newTask: unknown, reason: string, cycle?: string|number, log?: Function }} opts
 */
export async function appendRejectedFindingToParentNotes({ command, member, parentId, newTask, reason, cycle, log = () => {} }) {
    const raw = {
        cycle,
        rejectionReason: reason,
        title: newTask && newTask.title,
        description: newTask && newTask.description,
        priority: newTask && newTask.priority,
    };
    const noteBody = `[fleet-sprint newTask REJECTED -- residual validation failure, appended verbatim]\n${JSON.stringify(raw, null, 2)}`;
    try {
        const noteFile = await stageCommandBodyMemberSide({
            command, member, content: noteBody,
            label: `Stage rejected newTask finding for ${parentId} notes`,
        });
        await command(
            `bd note ${parentId} --file "${noteFile}"`,
            { member_name: member, silent: true, label: `Append rejected newTask finding to ${parentId} notes` }
        );
        log(`Rejected newTask finding appended verbatim to '${parentId}' notes (residual validation failure: ${reason}).`);
    } catch (err) {
        log(`[newTask notes-fallback] FAILED to append rejected finding to '${parentId}' notes: ${err.message}`);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Typed sprint-abort detection
// ---------------------------------------------------------------------------
//
// The single predicate deciding whether an error thrown out of
// runSprintCycle() is a "sprint-abort" the caller routes through
// finalizeAbort() plus a terminal history record, as opposed to an unexpected
// failure that keeps the plain grace-window/exit-1 path with no PR and no
// history record. The intended set is:
//   - StalledSprintError, SprintPlanRejectedError and
//     ReviewerContractViolationError (errors.mjs), which this runner throws
//     itself, plus BudgetExceededError, which the workflow package throws on
//     its behalf;
//   - GitDivergedError and DoltDivergedError, the state-integrity divergences.
//     A divergence means the single-writer invariant this engine relies on is
//     already violated (or the shared beads DB genuinely cannot be
//     fast-forwarded), so no retry or later phase can recover the run -- it
//     must terminate with an operator-visible record. A DoltDivergedError also
//     arrives WRAPPED one level down inside a PostDispatchSyncError (the D-push
//     bracket's shape), so membership is decided by findDoltDivergedCause()
//     walking the cause chain rather than by the outermost class. That the
//     divergences belong in this set is not an inference: main()'s typed-abort
//     catch below already calls resolveTerminalReason()/captureDoltConflictDump()
//     precisely to report them as the distinct BEADS_SYNC_CONFLICT terminal
//     state, which is dead code unless they reach it;
//   - the plain `Error` pre-sprint validation failures, which are not
//     WorkflowError subclasses and are identified by the stable
//     'Pre-sprint validation failed:' message prefix every such throw site
//     uses.
//
// Everything else is deliberately EXCLUDED, and the check is an explicit class
// list rather than the blanket `instanceof WorkflowError` it used to be --
// which swept in every routine, non-terminal failure and turned it into a
// spurious `verdict: 'ABORTED'`:
//   - CancelledError: a cooperative cancellation is a requested shutdown, not
//     an aborted sprint, and must keep flowing through its own 'cancelled'
//     status path;
//   - AgentOutputError, AgentDispatchError, FleetTransportError, CommandError:
//     dispatch-level failures each phase's own retry/soft-fail policy owns;
//   - GitSyncError, DoltSyncError, and a PostDispatchSyncError whose cause
//     chain carries NO divergence: transient sync failures that are retried in
//     place and, if they still surface, are ordinary run failures rather than
//     sprint aborts;
//   - SprintLockHeldError: structurally unreachable here. acquireSprintLock()
//     runs in main() BEFORE its try block, so a held lock never reaches this
//     predicate; there is also no sprint of our own to finalize when another
//     engine already owns the branch.
export function isTypedAbortError(err) {
    if (!err || err instanceof CancelledError) return false;
    if (err instanceof StalledSprintError) return true;
    if (err instanceof SprintPlanRejectedError) return true;
    if (err instanceof ReviewerContractViolationError) return true;
    if (err instanceof BudgetExceededError) return true;
    if (err instanceof GitDivergedError) return true;
    // Bare DoltDivergedError, or one wrapped inside a PostDispatchSyncError.
    if (findDoltDivergedCause(err)) return true;
    return typeof err.message === 'string' && err.message.startsWith('Pre-sprint validation failed:');
}

// ---------------------------------------------------------------------------
// Abort-path PR publish
// ---------------------------------------------------------------------------
//
// The ordinary Publish PR step only runs when the sprint reaches a final
// PASS/FAIL verdict. A sprint that instead aborts by throwing a typed error
// would otherwise propagate straight to the CLI's top-level catch with no
// branch push and no PR, leaving any work a doer already committed visible
// only to someone willing to dig through git history. Called from the
// typed-abort catch site with the causing error, finalizeAbort():
//   1. counts commits on the sprint branch beyond base, which decides whether
//      there is anything for a human to look at;
//   2. with >=1 commit, pushes the branch and raises an idempotent
//      'Auto-sprint [ABORTED]: <branch>' PR whose body carries the error's
//      code/message/details, sanitized by sanitizePrText for the same reason
//      the PASS/FAIL step sanitizes reviewer notes;
//   3. with 0 commits, raises no PR -- there is no diff, so the PR would be
//      noise -- and reports that in its return value, so the caller can still
//      write a terminal history record.
// `command` and `log` are dependency-injected rather than closed over
// `context`, so this is callable both from the catch site and directly from
// unit tests with a mock `command`.
/**
 * @param {{
 *   error: { code?: string, message?: string, details?: unknown },
 *   branch: string,
 *   baseBranch: string,
 *   member: string,
 *   command: (cmd: string, opts: object) => Promise<any>,
 *   log?: (msg: string) => void,
 *   onAuthFailure?: (info: { member: string, label: string, cmd?: string, error: string, kind: 'git'|'dolt' }) => Promise<void>,
 *   callTool?: (name: string, args: object) => Promise<any>,
 * }} opts
 * @returns {Promise<{ prUrl: string|null, reason: string, pushed: boolean, commitCount: number }>}
 */
export async function finalizeAbort({ error, branch, baseBranch, member, command, log = () => {}, onAuthFailure, callTool }) {
    // Built up-front (not just at the PR-creation step further down) so the
    // SAME ApraFleet client can also resolve `member`'s VCS provider
    // (apra-fleet-417.7) for the runGitStep calls below -- avoids
    // constructing a second client just for that lookup. `null` when no
    // callTool is wired (e.g. a mock-sprint scenario with no MCP client);
    // every downstream use already guards on this being non-null.
    const fleetApi = typeof callTool === 'function' ? new ApraFleet({ callTool }) : null;

    // apra-fleet-417.7: resolve `member`'s VCS provider ONCE up-front so the
    // git failures below (fetch/rev-list/push) classify via that member's own
    // provider chain, not just the default 'github' one. Fails closed to
    // `undefined` (today's default chain) on any error -- a provider-
    // resolution hiccup here must never abort an otherwise-recoverable abort
    // finalization.
    let provider;
    if (fleetApi) {
        try {
            ({ provider } = await resolveProvider(member, { fleetApi }));
        } catch (err) {
            log(`finalizeAbort: could not resolve member '${member}'s VCS provider for git-failure classification (falling back to the default provider chain, no verdict change for GitHub members): ${err.message}`);
        }
    }

    // 1. How many commits (if any) does the sprint branch carry beyond base?
    // Every command() call below passes an explicit `member_name` -- this
    // runner never lets a git/gh dispatch fall back to an ambient member.
    //
    // `member` need not be a member that ever checked out a LOCAL branch named
    // `baseBranch`; it may only have the sprint branch. A bare
    // `git rev-list base..branch` would then fail with "unknown revision", so
    // fetch first and diff against the remote-tracking ref, which is always
    // resolvable: baseBranch is the ref the sprint branch was created from.
    //
    // apra-fleet-5d5.1: these three git calls now go through runGitStep()
    // (the same helper the main withGitSync dispatch bracket uses) instead of
    // calling `command()` directly, so a git-auth failure here gets the SAME
    // provision_vcs_auth self-heal-and-retry-once treatment instead of being
    // silently swallowed (live: apra-fleet-l7n Cycle 3 abort hit exactly this
    // -- "Authentication failed ... Password authentication is not
    // supported" while writing the terminal history record, with no self-heal
    // available). runGitStep never throws; a non-ok result here is re-thrown
    // as a CommandError so finalizeAbort()'s own external throw-on-failure
    // contract (see main()'s catch site, which falls back to "no PR lookup"
    // on any thrown error) is unchanged for callers.
    const fetchRes = await runGitStep({
        command, member, cmd: `git fetch origin ${baseBranch}`,
        label: `Fetch base branch '${baseBranch}' for abort-path diff`,
        log, maxTransientRetries: 1, onAuthFailure, provider,
    });
    if (!fetchRes.ok) {
        throw new CommandError(
            `[Abort Finalize Failed] git fetch origin ${baseBranch} failed: ${fetchRes.error}`,
            { details: { branch, baseBranch, error: fetchRes.error, kind: fetchRes.kind } }
        );
    }
    const revListRes = await runGitStep({
        command, member, cmd: `git rev-list --count origin/${baseBranch}..${branch}`,
        label: `Count commits beyond base for abort-path branch '${branch}'`,
        log, maxTransientRetries: 1, onAuthFailure, provider,
    });
    if (!revListRes.ok) {
        throw new CommandError(
            `[Abort Finalize Failed] git rev-list --count origin/${baseBranch}..${branch} failed: ${revListRes.error}`,
            { details: { branch, baseBranch, error: revListRes.error, kind: revListRes.kind } }
        );
    }
    const commitCount = parseInt(String(revListRes.output).trim(), 10) || 0;

    if (commitCount < 1) {
        log(`finalizeAbort: branch '${branch}' has 0 commits beyond '${baseBranch}' -- no [ABORTED] PR raised (zero-commit-abort policy).`);
        return { prUrl: null, reason: 'zero-commit-abort', pushed: false, commitCount };
    }

    // 2. There is real work on the branch -- publish it and raise the PR.
    const pushRes = await runGitStep({
        command, member, cmd: `git push -u origin ${branch}`,
        label: `Push abort-path sprint branch '${branch}'`,
        log, maxTransientRetries: 1, onAuthFailure, provider,
    });
    if (!pushRes.ok) {
        throw new CommandError(
            `[Abort Finalize Failed] git push -u origin ${branch} failed: ${pushRes.error}`,
            { details: { branch, baseBranch, error: pushRes.error, kind: pushRes.kind } }
        );
    }

    // Same origin-remote gate as the Publish PR step, via
    // VCSModule.capabilities(): a remote whose provider cannot open a PR (a
    // file:// bare mirror, or any other host with no hosting API support)
    // must never hit raiseVcsPrForMember()'s doomed REST call, which would
    // surface as a hard-to-diagnose failure while the sprint is already
    // aborting. Resolving the remote is itself failSoft -- an unresolvable
    // remote fails closed to canOpenPullRequest:false -- so a probe hiccup
    // here degrades to "PR skipped", never a thrown error. The branch above
    // is already pushed either way.
    const originUrlRes = await command('git remote get-url origin', {
        member_name: member,
        silent: true,
        failSoft: true,
        label: 'Resolve origin remote URL for abort-path PR gate',
    });
    const originUrl = originUrlRes.ok ? originUrlRes.output.trim() : '';
    const abortPathCapabilities = vcsCapabilities(originUrl);
    if (!abortPathCapabilities.canOpenPullRequest) {
        log(`finalizeAbort: origin remote '${originUrl || '(unresolved)'}' cannot open a pull request (host: ${abortPathCapabilities.host || 'unknown'}) -- skipping [ABORTED] PR creation; branch '${branch}' is still pushed.`);
        return { prUrl: null, reason: 'non-hosted-remote', pushed: true, commitCount };
    }

    const prTitle = `Auto-sprint [ABORTED]: ${branch}`;
    // The error's code/message/details can originate from agent output, and
    // this text is embedded in a VCSModule-built PR body -- same sanitization
    // rationale as the PASS/FAIL Publish PR step.
    const safeCode = sanitizePrText(error && error.code);
    const safeMessage = sanitizePrText(error && error.message);
    const safeDetails = sanitizePrText(
        error && error.details !== undefined ? JSON.stringify(error.details) : ''
    );
    const prBody = [
        `Automated apra-fleet-se sprint ABORTED before reaching a final PASS/FAIL verdict.`,
        '',
        safeCode ? `Error code: ${safeCode}` : null,
        safeMessage ? `Error message: ${safeMessage}` : null,
        safeDetails ? `Error details: ${safeDetails}` : null,
        '',
        'Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.',
    ].filter((line) => line !== null).join('\n');

    // The reverted gh-based PR creation is gone (apra-fleet-tfx.8): raise the [ABORTED] PR via
    // VCSModule's orchestrator-built curl command, dispatched to `member`
    // through execute_command, using a push+pr credential minted
    // just-in-time immediately before this one call (never at sprint setup).
    // (fleetApi is built at the top of this function, above.)
    if (!fleetApi) {
        // Graceful degradation (apra-fleet-tfx.8.1): raising the [ABORTED] PR
        // needs an MCP client to mint a just-in-time push+pr credential on
        // `member`. When no callTool is wired (e.g. a mock-sprint scenario
        // that never opted into an MCP client), the abort-path branch is
        // ALREADY pushed above -- so instead of an unconditional hard-throw
        // that would break every such pre-existing scenario, this degrades to
        // a typed 'pr-skipped-no-mcp-client' outcome: a clear log line, the
        // pushed branch still returned to the caller, only the auto-raised PR
        // skipped. In production callTool is always wired (bin/cli.mjs), so
        // this branch never runs there; it exists purely so PR creation is not
        // a hard MCP dependency for callers that legitimately have none.
        log(`[Publish Abort PR Skipped] no MCP callTool available to mint a push+pr credential for member '${member}' -- branch '${branch}' is pushed but the [ABORTED] PR was not raised.`);
        return { prUrl: null, reason: PR_SKIPPED_NO_MCP_CLIENT, pushed: true, commitCount };
    }
    const prResult = await raiseVcsPrForMember({
        fleetApi,
        command,
        member,
        base: baseBranch,
        head: branch,
        title: prTitle,
        body: prBody,
        log,
        logPrefix: '[Publish Abort PR]',
        // Already resolved just above (the origin-remote PR-capability gate)
        // via a real git-capable member -- skip re-deriving it a second time
        // by shelling out to `member`, which may be orchestratorMember and
        // have no git checkout of its own to read a remote from.
        remoteUrlOverride: originUrl,
    });

    if (!prResult.ok) {
        if (prResult.authFailure) {
            // apra-fleet-647.1.1.1: a PR auth failure survives the reactive
            // one-shot self-heal+retry inside raiseVcsPrForMember (i.e. the
            // credential is still no good after re-provisioning) -- degrade
            // to a logged, non-throwing outcome instead of a CommandError, so
            // finalizeAbort() -- whose whole job is to record a sprint abort
            // -- can never itself be killed by the very auth failure it is
            // trying to report. The branch is still pushed (`pushed: true`)
            // even though the [ABORTED] PR could not be raised.
            log(`finalizeAbort: [Publish Abort PR] failed with an auth failure that survived the reactive self-heal retry for branch '${branch}' -> '${baseBranch}': ${prResult.error} -- degrading (not throwing) so the abort can still be recorded.`);
            return { prUrl: null, reason: 'pr-auth-failed', pushed: true, commitCount };
        }
        throw new CommandError(
            `[Publish Abort PR Failed] VCSModule create-pull-request failed for branch '${branch}' -> '${baseBranch}': ${prResult.error}`,
            { details: { branch, baseBranch, error: prResult.error } }
        );
    }
    if (prResult.alreadyExists) {
        // Idempotent: the desired end state -- a PR open for this branch --
        // already holds, so this is swallowed rather than thrown.
        log(`finalizeAbort: an [ABORTED] PR for branch '${branch}' already exists -- treating as idempotent success.`);
        return { prUrl: prResult.prUrl, reason: 'already-exists', pushed: true, commitCount };
    }

    return { prUrl: prResult.prUrl, reason: 'aborted-pr-created', pushed: true, commitCount };
}
