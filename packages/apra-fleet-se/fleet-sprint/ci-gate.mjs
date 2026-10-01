// =============================================================================
// ENGINE CI GATE.
//
// WHY THIS EXISTS. A doer dispatch cannot trigger the target repo's CI: its
// credential is refused workflow_dispatch (GitHub answers HTTP 403 "Resource
// not accessible by integration"). A bead whose acceptance criteria say "CI is
// green on every OS" was therefore impossible for a doer to satisfy and looped
// between doer and reviewer. CI verification is an ENGINE step instead: the
// orchestrator -- which holds the sprint's VCS credential -- triggers (or
// locates) the configured workflow run on the sprint branch head, awaits it
// with a bounded timeout, records run id/url/head sha/per-job conclusion, and
// hands that result to the reviewer dispatch as an engine-verified fact.
//
// CONFIG. The optional `ci_gate` sprint arg ({ workflow, timeout_s }, validated
// by sprint-args.mjs validateCiGate()). Absent: the gate makes no CI calls at
// all and logs exactly one 'CI gate not configured' line per sprint.
//
// NEVER A SILENT SKIP. Every way the gate can fail to produce a real verdict
// -- the trigger refused for a missing permission, a provider with no CI
// support, an unreadable remote, a credential that cannot be provisioned, a
// run that never finishes -- is logged loudly and recorded as a NON-pass
// outcome (FAILED-TO-RUN or TIMEOUT). Only a completed run whose conclusion
// the provider calls success is ever PASS.
//
// PROVIDER-AGNOSTIC. Every REST literal lives in the provider's `ciGate`
// descriptor (vcs-providers/github.mjs); this module only sequences the five
// actions (branch-head, find-runs, dispatch, get-run, list-jobs) and reads the
// answers through the provider's parse hooks. The HTTP layer is an injected
// `transport(built) -> { status, body, bodyText }`, so the gate is unit-
// testable with no network (see test/ci-gate*.test.mjs). In production the
// transport is the server-side vcs_credential_exec handoff, the same one
// Publish PR uses -- the orchestrator never sees a plaintext token.
//
// GENERIC ENGINE. No target repo's workflow names, OS matrix or job names
// appear here; they arrive as config and as provider responses.
//
// ASCII only.
// =============================================================================

import { capabilities as vcsCapabilities, resolveVcsProviderForHost } from './vcs-module.mjs';
import { supportsCiGate } from './vcs-providers/index.mjs';
import {
    parseOwnerRepoFromRemoteUrl, vcsCredentialLabelForProvider, provisionPrCapableAuthForMember,
} from './vcs-auth.mjs';
import { resolveMemberTarget } from './member-target.mjs';
import { resultText } from './mcp-result.mjs';

/** Gate outcomes. Only PASS is a pass; everything else is a recorded non-pass. */
export const CI_GATE_OUTCOME = Object.freeze({
    PASS: 'PASS',
    FAIL: 'FAIL',
    FAILED_TO_RUN: 'FAILED-TO-RUN',
    TIMEOUT: 'TIMEOUT',
});

/** The single log line an unconfigured gate emits (once per sprint). */
export const CI_GATE_NOT_CONFIGURED_LOG =
    '[CI Gate] CI gate not configured (no ci_gate sprint arg) -- the engine will not trigger or check CI this sprint.';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const LOG_PREFIX = '[CI Gate]';

/** Split a curl stdout carrying the "-w '\n%{http_code}'" trailer. */
export function parseCurlStatusOutput(output) {
    const text = String(output || '');
    const lines = text.split('\n');
    const statusLine = lines.length ? lines[lines.length - 1].trim() : '';
    const status = /^\d{3}$/.test(statusLine) ? parseInt(statusLine, 10) : null;
    const bodyText = (status !== null ? lines.slice(0, -1) : lines).join('\n').trim();
    let body = null;
    if (bodyText) {
        try { body = JSON.parse(bodyText); } catch { body = null; }
    }
    return { status, body, bodyText };
}

function isOk(res) {
    return !!res && typeof res.status === 'number' && res.status >= 200 && res.status <= 299;
}

function responseText(res) {
    if (!res) return '(no response)';
    const msg = res.body && typeof res.body.message === 'string' ? res.body.message : '';
    return `HTTP ${res.status ?? '(unknown)'}${msg ? `: ${msg}` : (res.bodyText ? `: ${String(res.bodyText).slice(0, 300)}` : '')}`;
}

/**
 * Run the CI gate once against the current head of `branch`.
 *
 * @param {{
 *   ciGate: { workflow: string, timeoutS: number },
 *   provider: object|null|undefined,   // the resolved VCS provider descriptor
 *   providerLabel?: string,            // name to report when provider is absent
 *   repo: string,                      // provider repo coordinates (owner/name)
 *   branch: string,
 *   transport: (built: object) => Promise<{ status: number|null, body: any, bodyText?: string }>,
 *   credential?: string,               // human description of the credential in use
 *   os?: string, shell?: string,
 *   log?: Function,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   pollIntervalMs?: number,
 *   previous?: object|null,            // the last recorded result, reused for an unchanged head
 * }} opts
 * @returns {Promise<object>} the gate record (see CI_GATE_OUTCOME)
 */
export async function runCiGate({
    ciGate, provider, providerLabel, repo, branch, transport, credential = '(unspecified credential)',
    os, shell, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, previous = null,
}) {
    const providerName = (provider && provider.name) || providerLabel || '(unknown provider)';
    const record = {
        outcome: null,
        workflow: ciGate.workflow,
        provider: providerName,
        repo: repo || null,
        branch,
        headSha: null,
        runId: null,
        runUrl: null,
        conclusion: null,
        jobs: [],
        reason: null,
    };
    const finish = (outcome, reason) => {
        record.outcome = outcome;
        record.reason = reason || null;
        if (outcome === CI_GATE_OUTCOME.PASS) {
            log(`${LOG_PREFIX} PASS: workflow '${record.workflow}' run ${record.runId} (${record.runUrl || 'no url'}) on ${record.branch}@${record.headSha}; jobs: ${formatJobs(record.jobs)}.`);
        } else {
            log(`${LOG_PREFIX} ERROR: ${outcome} for workflow '${record.workflow}' on ${record.branch}${record.headSha ? `@${record.headSha}` : ''}${record.runId ? ` (run ${record.runId}, ${record.runUrl || 'no url'})` : ''}: ${record.reason}`);
        }
        return record;
    };

    if (!supportsCiGate(provider)) {
        return finish(CI_GATE_OUTCOME.FAILED_TO_RUN,
            `VCS provider '${providerName}' has no CI-trigger support, but a ci_gate is configured. Remove ci_gate for this target or use a provider that supports it -- the gate is NOT treated as passed.`);
    }
    if (!repo) {
        return finish(CI_GATE_OUTCOME.FAILED_TO_RUN, 'could not derive the repository from the sprint origin remote.');
    }
    const ci = provider.ciGate;
    const deadline = now() + ciGate.timeoutS * 1000;
    const call = async (action, params) => {
        const built = ci.build(action, { repo, workflow: ciGate.workflow, branch, token: '{{vcs_token_inline}}', os, shell, ...params });
        return transport(built);
    };
    const permissionReason = (what, res) => (
        `${what} was refused (${responseText(res)}). Missing permission: ${ci.requiredPermission}. `
        + `Credential in use: ${credential}. Grant that permission to this credential; CI is NOT verified for this head.`
    );
    // Sleep one poll interval (never past the deadline). false = deadline
    // already reached, so the caller records TIMEOUT instead of polling.
    const waitOrTimeout = async () => {
        const remaining = deadline - now();
        if (remaining <= 0) return false;
        await sleep(Math.min(pollIntervalMs, remaining));
        return true;
    };

    try {
        // 1. Resolve the branch head sha on the remote (what CI actually runs).
        const headRes = await call('branch-head', {});
        if (!isOk(headRes)) {
            return finish(CI_GATE_OUTCOME.FAILED_TO_RUN, ci.isPermissionRefusal(headRes && headRes.status, responseText(headRes))
                ? permissionReason(`Reading branch '${branch}'`, headRes)
                : `could not read the head of branch '${branch}' (${responseText(headRes)}).`);
        }
        const sha = ci.parseBranchHead(headRes.body);
        if (!sha) return finish(CI_GATE_OUTCOME.FAILED_TO_RUN, `the provider returned no head sha for branch '${branch}'.`);
        record.headSha = sha;

        // An unchanged head already has a terminal verdict -- do not re-run CI.
        if (previous && previous.headSha === sha && previous.workflow === ciGate.workflow
            && (previous.outcome === CI_GATE_OUTCOME.PASS || previous.outcome === CI_GATE_OUTCOME.FAIL)) {
            log(`${LOG_PREFIX} head ${sha} unchanged since run ${previous.runId}; reusing its ${previous.outcome} result.`);
            return { ...previous };
        }

        // 2. Locate a run already triggered for this sha, else trigger one.
        const findRun = async () => {
            const res = await call('find-runs', { sha });
            if (!isOk(res)) return { error: res };
            return { run: ci.parseFindRuns(res.body, sha) };
        };
        let found = await findRun();
        if (found.error) {
            return finish(CI_GATE_OUTCOME.FAILED_TO_RUN, ci.isPermissionRefusal(found.error.status, responseText(found.error))
                ? permissionReason(`Listing runs of workflow '${ciGate.workflow}'`, found.error)
                : `could not list runs of workflow '${ciGate.workflow}' (${responseText(found.error)}).`);
        }
        if (!found.run) {
            log(`${LOG_PREFIX} no '${ciGate.workflow}' run found for ${branch}@${sha}; triggering one.`);
            const dispatchRes = await call('dispatch', {});
            if (!isOk(dispatchRes)) {
                return finish(CI_GATE_OUTCOME.FAILED_TO_RUN, ci.isPermissionRefusal(dispatchRes && dispatchRes.status, responseText(dispatchRes))
                    ? permissionReason(`Triggering workflow '${ciGate.workflow}' on '${branch}'`, dispatchRes)
                    : `triggering workflow '${ciGate.workflow}' on '${branch}' failed (${responseText(dispatchRes)}).`);
            }
            // The dispatch API returns no run id: poll until the run appears.
            while (!found.run) {
                if (!(await waitOrTimeout())) {
                    return finish(CI_GATE_OUTCOME.TIMEOUT,
                        `the triggered run for ${sha} did not appear within ${ciGate.timeoutS}s.`);
                }
                found = await findRun();
                if (found.error) {
                    return finish(CI_GATE_OUTCOME.FAILED_TO_RUN, `could not list runs of workflow '${ciGate.workflow}' (${responseText(found.error)}).`);
                }
            }
        }
        let run = found.run;
        record.runId = run.id;
        record.runUrl = run.url;
        log(`${LOG_PREFIX} awaiting '${ciGate.workflow}' run ${run.id} (${run.url || 'no url'}) on ${branch}@${sha} (timeout ${ciGate.timeoutS}s).`);

        // 3. Poll the run to completion, bounded by the timeout.
        while (!ci.isRunComplete(run)) {
            if (!(await waitOrTimeout())) {
                return finish(CI_GATE_OUTCOME.TIMEOUT,
                    `run did not complete within ${ciGate.timeoutS}s (last status: ${run.status || 'unknown'}); see ${run.url || 'the run page'}.`);
            }
            const runRes = await call('get-run', { runId: run.id });
            if (!isOk(runRes)) {
                return finish(CI_GATE_OUTCOME.FAILED_TO_RUN, `could not read run ${run.id} (${responseText(runRes)}).`);
            }
            run = ci.parseRun(runRes.body) || run;
            if (run.url) record.runUrl = run.url;
        }
        record.conclusion = run.conclusion;

        // 4. Per-job conclusions.
        const jobsRes = await call('list-jobs', { runId: run.id });
        if (isOk(jobsRes)) {
            record.jobs = ci.parseJobs(jobsRes.body);
        } else {
            log(`${LOG_PREFIX} could not list jobs of run ${run.id} (${responseText(jobsRes)}); recording the run conclusion only.`);
        }
        return ci.isRunSuccess(run)
            ? finish(CI_GATE_OUTCOME.PASS, null)
            : finish(CI_GATE_OUTCOME.FAIL, `run concluded '${run.conclusion}'; jobs: ${formatJobs(record.jobs)}.`);
    } catch (err) {
        return finish(CI_GATE_OUTCOME.FAILED_TO_RUN, `CI gate error: ${err && err.message ? err.message : err} (credential in use: ${credential}).`);
    }
}

function formatJobs(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) return '(no job detail)';
    return jobs.map((j) => `${j.name}=${j.conclusion}`).join(', ');
}

/**
 * Reviewer-prompt lines for a CI gate record. Empty for no record (gate not
 * configured), so an unconfigured sprint's reviewer prompt is unchanged.
 * Non-pass wording never says CI is green.
 * @param {object|null|undefined} result
 * @returns {string[]}
 */
export function buildCiGatePromptLines(result) {
    if (!result || !result.outcome) return [];
    const head = `CI GATE (engine-verified -- the orchestrator ran this CI check itself): `
        + `workflow '${result.workflow}' on ${result.branch}${result.headSha ? `@${result.headSha}` : ''}`;
    const run = result.runId ? `run id ${result.runId}${result.runUrl ? ` (${result.runUrl})` : ''}` : 'no run';
    const jobs = Array.isArray(result.jobs) && result.jobs.length > 0
        ? `Per-job result: ${result.jobs.map((j) => `${j.name}: ${j.conclusion}`).join('; ')}.`
        : 'Per-job result: (no job detail).';
    const rule = 'CI status is verified by the engine, not by the doer: never ask the doer to trigger, re-run or prove CI, '
        + 'and never reopen a bead only because its doer did not run CI -- doer dispatches cannot trigger CI.';
    if (result.outcome === CI_GATE_OUTCOME.PASS) {
        return [`${head}: ${run} -- result PASS (CI green). ${jobs}`, rule];
    }
    if (result.outcome === CI_GATE_OUTCOME.FAIL) {
        return [
            `${head}: ${run} -- result FAIL. ${jobs}`,
            'The failing jobs are real evidence against this head: judge whether the reviewed change caused them, and if so reopen the responsible bead naming the failing job(s).',
            rule,
        ];
    }
    return [
        `${head}: ${run} -- result ${result.outcome}: ${result.reason || '(no reason recorded)'}`,
        'CI is NOT verified for this head: do not treat any CI criterion as met. Record that in notes; it is an engine/operator issue, not doer work.',
        rule,
    ];
}

/**
 * Sprint-scoped CI gate. Logs CI_GATE_NOT_CONFIGURED_LOG exactly once when
 * `ciGate` is absent and then never touches a provider. When configured,
 * `check()` resolves the run context (provider, repo, credential transport)
 * and runs the gate, reusing the previous terminal result for an unchanged
 * head, and records every result in `results`.
 *
 * @param {{
 *   ciGate: { workflow: string, timeoutS: number }|undefined,
 *   branch: string,
 *   log?: Function,
 *   resolveContext: () => Promise<object>,  // -> { provider, providerLabel, repo, transport, credential, os, shell } | { error }
 *   gateOptions?: object,                    // test seam: sleep/now/pollIntervalMs
 * }} opts
 */
export function createCiGate({ ciGate, branch, log = () => {}, resolveContext, gateOptions = {} }) {
    const results = [];
    if (!ciGate) {
        log(CI_GATE_NOT_CONFIGURED_LOG);
        return { configured: false, results, async check() { return null; } };
    }
    log(`${LOG_PREFIX} configured: workflow '${ciGate.workflow}', timeout ${ciGate.timeoutS}s -- run before each reviewer dispatch on the ${branch} head.`);
    return {
        configured: true,
        results,
        async check({ label } = {}) {
            const previous = results.length > 0 ? results[results.length - 1] : null;
            let ctx;
            try {
                ctx = await resolveContext();
            } catch (err) {
                ctx = { error: err && err.message ? err.message : String(err) };
            }
            let result;
            if (ctx && ctx.error) {
                result = {
                    outcome: CI_GATE_OUTCOME.FAILED_TO_RUN, workflow: ciGate.workflow, provider: ctx.providerLabel || null,
                    repo: null, branch, headSha: null, runId: null, runUrl: null, conclusion: null, jobs: [],
                    reason: ctx.error,
                };
                log(`${LOG_PREFIX} ERROR: ${CI_GATE_OUTCOME.FAILED_TO_RUN} for workflow '${ciGate.workflow}' on ${branch}: ${ctx.error}`);
            } else {
                result = await runCiGate({ ciGate, branch, log, previous, ...ctx, ...gateOptions });
            }
            result.label = label || null;
            results.push(result);
            return result;
        },
    };
}

/**
 * Production context resolver: origin remote -> provider + repo; just-in-time
 * push+pr credential on the orchestrator (the level that carries the CI
 * trigger permission); a vcs_credential_exec transport. Every failure becomes
 * `{ error }` so the gate records FAILED-TO-RUN loudly instead of throwing.
 *
 * @param {{ fleetApi: object|null, command: Function, orchestratorMember: string, gitMember: string, log?: Function }} opts
 * @returns {() => Promise<object>}
 */
export function createCiGateContextResolver({ fleetApi, command, orchestratorMember, gitMember, log = () => {} }) {
    return async function resolveCiGateContext() {
        const originRes = await command('git remote get-url origin', {
            member_name: gitMember, silent: true, failSoft: true, label: 'CI gate: resolve origin remote URL',
        });
        const originUrl = originRes && originRes.ok ? String(originRes.output || '').trim() : '';
        if (!originUrl) {
            return { error: `could not read the origin remote on member '${gitMember}' (${(originRes && originRes.error) || 'empty'}).` };
        }
        const caps = vcsCapabilities(originUrl);
        const provider = caps.host ? resolveVcsProviderForHost(caps.host) : null;
        const providerLabel = provider ? provider.name : `none (origin '${originUrl}' has no hosting provider)`;
        if (!supportsCiGate(provider)) {
            // runCiGate reports the unsupported provider loudly by name.
            return { provider, providerLabel, repo: null, transport: async () => ({ status: null, body: null }) };
        }
        if (!fleetApi || typeof fleetApi.vcsCredentialExec !== 'function') {
            return { providerLabel, error: `no fleet MCP client with vcs_credential_exec is available to run the CI gate for provider '${provider.name}'.` };
        }
        const label = vcsCredentialLabelForProvider(provider.name);
        const credential = `the '${label}' push+pr VCS credential on member '${orchestratorMember}'`;
        let repo;
        try {
            ({ repo } = await provisionPrCapableAuthForMember({
                fleetApi, command, member: orchestratorMember, log, logPrefix: LOG_PREFIX, remoteUrlOverride: originUrl,
            }));
        } catch (err) {
            return { providerLabel, error: `could not provision ${credential}: ${err && err.message ? err.message : err}` };
        }
        repo = repo || parseOwnerRepoFromRemoteUrl(originUrl);
        const { os, shell } = await resolveMemberTarget({ fleetApi, member: orchestratorMember, log });
        const transport = async (built) => {
            const execRes = await fleetApi.vcsCredentialExec({ member_name: orchestratorMember, label, command: built.command });
            const handoff = (execRes && execRes.structuredContent) || {};
            if (!handoff.ok && handoff.reason !== 'dispatch_failed') {
                throw new Error(`vcs_credential_exec could not use ${credential} (reason: ${handoff.reason || '(none)'}): ${resultText(execRes) || '(no detail)'}`);
            }
            if (!handoff.ok || (typeof handoff.exitCode === 'number' && handoff.exitCode !== 0)) {
                throw new Error(`CI request failed to run (${built.logSafeCommand}): ${handoff.stderr || resultText(execRes) || '(no detail)'}`);
            }
            return parseCurlStatusOutput(handoff.stdout);
        };
        return { provider, providerLabel, repo, transport, credential, os, shell };
    };
}
