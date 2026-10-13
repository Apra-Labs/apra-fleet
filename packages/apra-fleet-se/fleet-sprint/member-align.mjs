// =============================================================================
// LAUNCH-TIME MEMBER ALIGNMENT (apra-fleet-rsd9.1.1)
// =============================================================================
//
// Before this module existed, a multi-member legacy-mode launch compared
// `git rev-parse HEAD` across members (checkMemberTopology, ./git-topology.mjs)
// and refused to start whenever the members simply sat on different commits --
// even though the engine's own Ensure Sprint Branch phase would have put every
// member on the sprint branch a moment later. The operator had to align every
// member by hand and relaunch.
//
// alignMembersToBase() closes that gap: it brings every topology member to the
// sprint branch (origin/<branch> when it exists, else cut from origin/<base>)
// BEFORE the topology check runs, and refuses loudly only for what cannot be
// reconciled automatically.
//
// TWO PASSES, NO PARTIAL START. Pass 1 (preconditions) issues only read-only
// commands -- origin URL, fetches, local-branch/tip probes, working-tree
// status -- on EVERY member, and refuses before any member is moved if any
// precondition fails anywhere: unreachable member, differing origin URLs, base
// missing on origin, fetch auth failure, a diverged sprint branch. Pass 2
// (alignment) then stashes uncommitted work under a named stash and checks out
// the sprint branch per member, logging one line per member.
//
// The checkout decision is the engine's own decideEnsureBranchAction()
// (./branch-ensure.mjs), so a relaunch keeps pushed sprint history and a
// locally ahead/diverged sprint branch is handled exactly the way the Ensure
// Sprint Branch phase handles it. Fetch failures are classified through
// runGitStep()/classifyGitFailure()/isMissingRemoteRefError()
// (./git-topology.mjs) -- the one git-failure classifier.
//
// SHELL NEUTRALITY. Members may run PowerShell. Every command is ONE git
// invocation issued per member: no `&&`, no shell variable expansion, no home
// shorthand. Nothing here does I/O of its own: every command goes through the
// injected runGit(cmd, member), so unit tests drive it with a fake runner and
// bin/cli.mjs wires it to the fleet's execute_command.
// =============================================================================

import { checkMemberTopology, runGitStep, commandResultToSoftGit } from './git-topology.mjs';
import { decideEnsureBranchAction } from './branch-ensure.mjs';

/** Prefix of every line this module logs, and of its refusal messages. */
export const ALIGN_LOG_PREFIX = '[Align]';

/**
 * Named-stash message used to preserve uncommitted work during launch
 * alignment. Same `fleet-sprint[<branch>]` convention as the Ensure Sprint
 * Branch phase's orphaned-WIP stash, so both are found by one search.
 * @param {string} branch
 * @returns {string}
 */
export function launchAlignStashMessage(branch) {
    return `fleet-sprint[${branch}] auto-stash of uncommitted work before launch alignment`;
}

/**
 * Map an execute_command MCP result -- or a thrown transport error -- to the
 * soft result alignMembersToBase() consumes:
 *   { ok, output, error, unreachable }
 * `ok` comes from the command's real exit code (commandResultToSoftGit), never
 * from isError alone. `unreachable` is true when no exit code exists at all
 * (the call threw, or the tool reported an error without running the command):
 * the member itself could not be reached, which is a different cause and fix
 * from a git failure.
 * @param {any} res - the execute_command result (ignored when `thrown` is set)
 * @param {unknown} [thrown] - the error the call threw, if it threw
 * @returns {{ ok: boolean, output: string, error: string|null, unreachable: boolean }}
 */
export function toAlignCommandResult(res, thrown) {
    if (thrown !== undefined) {
        const msg = thrown && thrown.message ? thrown.message : String(thrown);
        return { ok: false, output: '', error: msg || 'command dispatch failed', unreachable: true };
    }
    const soft = commandResultToSoftGit(res);
    const hasExitCode =
        (res && res.structuredContent && typeof res.structuredContent.exitCode === 'number') ||
        /Exit code:\s*-?\d+/.test(soft.stdout || '');
    const stdout = res && res.structuredContent && typeof res.structuredContent.stdout === 'string'
        ? res.structuredContent.stdout
        : soft.stdout;
    return {
        ok: soft.ok,
        output: stdout || '',
        error: soft.ok ? null : (soft.error || 'unknown error'),
        unreachable: !soft.ok && !hasExitCode,
    };
}

function firstLine(text) {
    return String(text || '').trim().split(/\r?\n/)[0].trim();
}

function refusal(failures) {
    const detail = failures.map((f) => `member '${f.member}': ${f.cause} -- fix: ${f.fix}`).join('; ');
    return (
        `${ALIGN_LOG_PREFIX} Refusing to start: ${failures.length === 1 ? 'one member' : `${failures.length} members`} ` +
        `cannot be aligned to the sprint base automatically, and no member was moved. ${detail}.`
    );
}

/**
 * Describe a failed fetch of `ref` as a cause + fix pair.
 * @param {{ member: string, ref: string, originUrl: string|null, res: any, unreachable: boolean, isBase: boolean }} p
 */
function describeFetchFailure({ ref, originUrl, res, unreachable, isBase }) {
    const raw = firstLine(res && res.error) || 'unknown error';
    if (unreachable) {
        return {
            cause: `member unreachable while fetching '${ref}' (${raw})`,
            fix: 'bring the member back online (check it with list_members / member status) and relaunch',
        };
    }
    if (res && res.missingRemoteRef && isBase) {
        return {
            cause: `base branch '${ref}' does not exist on origin` + (originUrl ? ' (' + originUrl + ')' : ''),
            fix: `push '${ref}' to origin or pass the correct --base`,
        };
    }
    if (res && res.kind === 'auth') {
        return {
            cause: `fetch of '${ref}' from origin failed authentication (${raw})`,
            fix: "re-provision the member's VCS credential (provision_vcs_auth) and relaunch",
        };
    }
    if (res && res.kind === 'missing-tool') {
        return {
            cause: `'${res.missingTool || 'git'}' was not found on the member`,
            fix: "install git on the member or put it on the member's PATH, then relaunch",
        };
    }
    if (res && res.kind === 'transient') {
        return {
            cause: `fetch of '${ref}' from origin kept failing with a network error (${raw})`,
            fix: "check the member's network access to origin and relaunch",
        };
    }
    return {
        cause: `fetch of '${ref}' from origin failed (${raw})`,
        fix: "run the same fetch on the member to see the full error, resolve it, and relaunch",
    };
}

/**
 * Align every member to the sprint base: check every member's preconditions
 * first (no member is moved unless ALL pass), then preserve uncommitted work in
 * a named stash and check out the sprint branch on each member.
 *
 * @param {{
 *   members: string[],
 *   baseBranch: string,
 *   branch: string,
 *   runGit: (cmd: string, member: string) => Promise<{ ok: boolean, output?: string, error?: string|null, unreachable?: boolean }>,
 *   log?: (msg: string) => void,
 *   maxTransientRetries?: number,
 * }} opts
 * @returns {Promise<{ ok: boolean, message: string, aligned: Array<{ member: string, from: string, to: string, startPoint: string|null, reused: boolean, stash: string|null }>, failures?: Array<{ member: string, cause: string, fix: string }> }>}
 */
export async function alignMembersToBase({ members, baseBranch, branch, runGit, log = () => {}, maxTransientRetries = 1 }) {
    if (!Array.isArray(members) || members.length === 0) {
        return { ok: true, message: `${ALIGN_LOG_PREFIX} No members to align.`, aligned: [] };
    }
    if (typeof runGit !== 'function') {
        throw new TypeError('alignMembersToBase: runGit must be a function');
    }

    // Track unreachability per member: runGitStep returns its own result
    // object, so the adapter records the flag here as it passes through.
    const unreachableSeen = new Set();
    const run = async (cmd, member) => {
        let res;
        try {
            res = await runGit(cmd, member);
        } catch (err) {
            res = toAlignCommandResult(undefined, err);
        }
        const out = {
            ok: Boolean(res && res.ok),
            output: res && typeof res.output === 'string' ? res.output : '',
            error: res && res.ok ? null : ((res && res.error) || 'unknown command failure'),
        };
        if (res && !res.ok && res.unreachable) unreachableSeen.add(member);
        return out;
    };
    const stepCommand = (cmd, opts) => run(cmd, opts.member_name);
    const step = (member, cmd, label) => runGitStep({
        command: stepCommand, member, cmd, label, log, maxTransientRetries,
    });

    // -----------------------------------------------------------------------
    // Pass 1: preconditions on EVERY member. Read-only commands only.
    // -----------------------------------------------------------------------
    const failures = [];
    const plans = [];
    for (const member of members) {
        const originRes = await run('git remote get-url origin', member);
        if (!originRes.ok) {
            if (unreachableSeen.has(member)) {
                failures.push({
                    member,
                    cause: `member unreachable (${firstLine(originRes.error)})`,
                    fix: 'bring the member back online (check it with list_members / member status) and relaunch',
                });
            } else if (/not a git repository/i.test(originRes.error || '')) {
                failures.push({
                    member,
                    cause: "the member's work folder is not a git repository",
                    fix: "register the member with a work folder that is a clone of the sprint's origin",
                });
            } else {
                failures.push({
                    member,
                    cause: `no 'origin' remote could be read (${firstLine(originRes.error)})`,
                    fix: "add an 'origin' remote pointing at the sprint's repository on the member",
                });
            }
            continue;
        }
        const originUrl = firstLine(originRes.output);
        plans.push({ member, originUrl });
    }

    // Differing origins cannot be reconciled: the members would be pushing and
    // pulling different repositories.
    const distinctOrigins = [...new Set(plans.map((p) => p.originUrl))];
    if (distinctOrigins.length > 1) {
        const perMember = plans.map((p) => `${p.member}=${p.originUrl}`).join(', ');
        for (const p of plans) {
            failures.push({
                member: p.member,
                cause: `origin URL '${p.originUrl}' differs from the other members (${perMember})`,
                fix: "point every member's 'origin' remote at the same repository, then relaunch",
            });
        }
    }
    if (failures.length > 0) {
        return { ok: false, message: refusal(failures), aligned: [], failures };
    }

    for (const plan of plans) {
        const { member, originUrl } = plan;

        const baseFetch = await step(member, `git fetch origin ${baseBranch} --quiet`, `Launch alignment: fetch '${baseBranch}' on member '${member}'`);
        if (!baseFetch.ok) {
            failures.push({ member, ...describeFetchFailure({ ref: baseBranch, originUrl, res: baseFetch, unreachable: unreachableSeen.has(member), isBase: true }) });
            continue;
        }

        const branchFetch = await step(member, `git fetch origin ${branch} --quiet`, `Launch alignment: fetch existing '${branch}' (if any) on member '${member}'`);
        if (!branchFetch.ok && !branchFetch.missingRemoteRef) {
            failures.push({ member, ...describeFetchFailure({ ref: branch, originUrl, res: branchFetch, unreachable: unreachableSeen.has(member), isBase: false }) });
            continue;
        }

        const localProbe = await run(`git rev-parse --verify --quiet refs/heads/${branch}`, member);
        const localBranchExists = localProbe.ok;

        let localTipStatus;
        let localSha;
        let remoteSha;
        if (branchFetch.ok && localBranchExists) {
            const localIsAncestor = await run(`git merge-base --is-ancestor ${branch} origin/${branch}`, member);
            const remoteIsAncestor = await run(`git merge-base --is-ancestor origin/${branch} ${branch}`, member);
            if (localIsAncestor.ok) localTipStatus = 'behind-or-equal';
            else if (remoteIsAncestor.ok) localTipStatus = 'ahead';
            else localTipStatus = 'diverged';
            if (localTipStatus === 'diverged') {
                const l = await run(`git rev-parse --short ${branch}`, member);
                const r = await run(`git rev-parse --short origin/${branch}`, member);
                localSha = l.ok ? firstLine(l.output) : undefined;
                remoteSha = r.ok ? firstLine(r.output) : undefined;
            }
        }

        const decision = decideEnsureBranchAction({
            branch,
            baseBranch,
            branchFetchOk: branchFetch.ok,
            branchFetchError: branchFetch.error,
            localBranchExists,
            localTipStatus,
            localSha,
            remoteSha,
        });
        if (decision.action === 'abort') {
            failures.push({
                member,
                cause: decision.message,
                fix: `reconcile the member's local '${branch}' with 'origin/${branch}' (or delete the stale local branch), then relaunch`,
            });
            continue;
        }

        const status = await run('git status --porcelain', member);
        if (!status.ok) {
            failures.push({
                member,
                cause: `could not read the working-tree status (${firstLine(status.error)}), so uncommitted work cannot be preserved safely`,
                fix: "run 'git status' on the member, resolve the error, and relaunch",
            });
            continue;
        }
        const dirty = status.output.trim().length > 0;

        const fromBranch = await run('git rev-parse --abbrev-ref HEAD', member);
        const fromSha = await run('git rev-parse --short HEAD', member);
        const from = `${fromBranch.ok ? firstLine(fromBranch.output) : 'unknown'}@${fromSha.ok ? firstLine(fromSha.output) : 'unknown'}`;

        Object.assign(plan, { decision, dirty, from });
    }
    if (failures.length > 0) {
        return { ok: false, message: refusal(failures), aligned: [], failures };
    }

    // -----------------------------------------------------------------------
    // Pass 2: every precondition passed on every member -- align them.
    // -----------------------------------------------------------------------
    const aligned = [];
    for (const { member, decision, dirty, from } of plans) {
        let stash = null;
        if (dirty) {
            stash = launchAlignStashMessage(branch);
            const stashRes = await run(`git stash push -u -m "${stash}"`, member);
            if (!stashRes.ok) {
                const message =
                    `${ALIGN_LOG_PREFIX} Alignment failed on member '${member}': could not preserve its uncommitted work in a ` +
                    `named stash (${firstLine(stashRes.error)}); its working tree was left untouched -- fix: commit or stash the ` +
                    `work on the member by hand and relaunch. Members already aligned: ${aligned.map((a) => a.member).join(', ') || 'none'}.`;
                return { ok: false, message, aligned };
            }
        }
        const checkout = await run(decision.command, member);
        if (!checkout.ok) {
            const stashNote = stash ? '; its uncommitted work is preserved in stash "' + stash + '"' : '';
            const message =
                `${ALIGN_LOG_PREFIX} Alignment failed on member '${member}': '${decision.command}' failed (${firstLine(checkout.error)})` +
                stashNote + ' -- fix: run the same checkout on the member to see ' +
                `the full error, resolve it, and relaunch. Members already aligned: ${aligned.map((a) => a.member).join(', ') || 'none'}.`;
            return { ok: false, message, aligned };
        }
        const toSha = await run('git rev-parse --short HEAD', member);
        const to = `${branch}@${toSha.ok ? firstLine(toSha.output) : 'unknown'}`;
        const via = decision.reused ? 'reused local branch' : `from ${decision.startPoint}`;
        log(
            `${ALIGN_LOG_PREFIX} member '${member}': ${from} -> ${to} (${via})` +
            (stash ? '; uncommitted work preserved in stash "' + stash + '"' : '')
        );
        aligned.push({ member, from, to, startPoint: decision.startPoint || null, reused: Boolean(decision.reused), stash });
    }

    return {
        ok: true,
        message: `${ALIGN_LOG_PREFIX} All ${aligned.length} members aligned to '${branch}' (base '${baseBranch}').`,
        aligned,
    };
}

/**
 * The launch-time topology step bin/cli.mjs runs: in legacy mode with two or
 * more members, align every member to the sprint base first, then run
 * checkMemberTopology against the aligned state. Synced mode and a single
 * member go straight to checkMemberTopology, unchanged.
 *
 * @param {{
 *   members: string[],
 *   mode: 'legacy'|'synced',
 *   baseBranch: string,
 *   branch: string,
 *   runGit: Function,
 *   log?: (msg: string) => void,
 *   getIdentity?: (member: string) => Promise<string>,
 *   getOriginUrl?: (member: string) => Promise<string>,
 *   doltProbe?: (member: string) => Promise<unknown>,
 * }} opts
 * @returns {Promise<{ ok: boolean, message: string, singleMember?: boolean, alignment?: object }>}
 */
export async function prepareLaunchTopology({ members, mode, baseBranch, branch, runGit, log = () => {}, getIdentity, getOriginUrl, doltProbe }) {
    let alignment;
    if (mode === 'legacy' && Array.isArray(members) && members.length > 1) {
        alignment = await alignMembersToBase({ members, baseBranch, branch, runGit, log });
        if (!alignment.ok) {
            return { ok: false, singleMember: false, mode, message: alignment.message, alignment };
        }
    }
    const identity = getIdentity || (async (member) => {
        const res = await runGit('git rev-parse HEAD', member);
        if (!res || !res.ok) throw new Error((res && res.error) || 'git rev-parse HEAD failed');
        return res.output;
    });
    const topology = await checkMemberTopology({ members, mode, getIdentity: identity, getOriginUrl, doltProbe });
    return alignment ? { ...topology, alignment } : topology;
}
