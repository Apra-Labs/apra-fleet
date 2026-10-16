// =============================================================================
// ENGINE CI GATE.
//
// WHERE IT RUNS. Once per sprint, at Finalization, and only when the optional
// `ci_gate` sprint arg is set (sprint-args.mjs validateCiGate). runner.js
// starts the gate (startFinalizationCiGate below) right after
// group('Finalization') on the sprint branch's remote head and does NOT await
// it: Final Review, Regression Test and Harvest run while CI runs. Publish PR
// (phases/publish-pr.mjs) awaits the in-flight result after its own branch
// push, before raising/updating the PR, and renders it into the PR body
// (formatCiGateReport below). CI never changes the sprint verdict, never
// blocks PR creation and never reaches a doer or reviewer prompt. Without
// `ci_gate` the gate is never constructed: no CI request, no log line.
//
// WHAT IT DOES. Triggers (or locates) a workflow run on a branch head with the
// caller's VCS credential, awaits it with a bounded timeout and records run
// id/url/head sha/per-job conclusion.
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
    '[CI Gate] CI gate not configured -- the engine does not trigger or check CI.';

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
    log(`${LOG_PREFIX} configured: workflow '${ciGate.workflow}', timeout ${ciGate.timeoutS}s -- run once at Finalization on the ${branch} head (parallel with Final Review/Regression/Harvest; Publish PR awaits it).`);
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
 * @param {{ fleetApi: object|null, command: Function, backlogMember: string, gitMember: string, log?: Function }} opts
 * @returns {() => Promise<object>}
 */
export function createCiGateContextResolver({ fleetApi, command, backlogMember, gitMember, log = () => {} }) {
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
        const credential = `the '${label}' push+pr VCS credential on member '${backlogMember}'`;
        let repo;
        try {
            ({ repo } = await provisionPrCapableAuthForMember({
                fleetApi, command, member: backlogMember, log, logPrefix: LOG_PREFIX, remoteUrlOverride: originUrl,
            }));
        } catch (err) {
            return { providerLabel, error: `could not provision ${credential}: ${err && err.message ? err.message : err}` };
        }
        repo = repo || parseOwnerRepoFromRemoteUrl(originUrl);
        const { os, shell } = await resolveMemberTarget({ fleetApi, member: backlogMember, log });
        const transport = async (built) => {
            const execRes = await fleetApi.vcsCredentialExec({ member_name: backlogMember, label, command: built.command });
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

/** The label the Finalization gate run is recorded under. */
export const CI_GATE_FINALIZATION_LABEL = 'finalization';

/**
 * A sleep whose pending waits can all be cancelled at once. A cancelled wait
 * (and every later one) REJECTS, which runCiGate's own try/catch turns into a
 * FAILED-TO-RUN record -- so a sprint that ends early never leaves a gate
 * polling (and a ref'd timer holding the process open) for up to timeout_s.
 * `injected` is the test seam (a virtual clock); default is a real timer.
 */
function createCancellableSleep(injected) {
    let reason = null;
    const pending = new Set();
    const sleep = (ms) => new Promise((resolve, reject) => {
        if (reason !== null) { reject(new Error(reason)); return; }
        let timer = null;
        const entry = {};
        entry.settle = (err) => {
            if (!pending.delete(entry)) return;
            if (timer !== null) clearTimeout(timer);
            if (err) reject(err); else resolve();
        };
        pending.add(entry);
        if (typeof injected === 'function') {
            Promise.resolve().then(() => injected(ms)).then(
                () => entry.settle(null),
                (e) => entry.settle(e instanceof Error ? e : new Error(String(e))),
            );
        } else {
            timer = setTimeout(() => entry.settle(null), ms);
        }
    });
    const cancel = (why) => {
        if (reason === null) reason = why || 'cancelled';
        for (const entry of [...pending]) entry.settle(new Error(reason));
    };
    return { sleep, cancel };
}

function failedToRunRecord({ ciGate, branch, reason, label }) {
    return {
        outcome: CI_GATE_OUTCOME.FAILED_TO_RUN, workflow: ciGate ? ciGate.workflow : null, provider: null,
        repo: null, branch, headSha: null, runId: null, runUrl: null, conclusion: null, jobs: [],
        reason, label: label || null,
    };
}

/**
 * Start the sprint's ONE CI gate run at Finalization, in the background.
 *
 * Returns immediately with a handle whose `promise` NEVER rejects: it is
 * guarded from the moment it is created, so a gate that throws (or a context
 * resolver that throws) becomes a loud FAILED-TO-RUN record and can never
 * surface as an unhandled rejection, even if nothing awaits it (a sprint that
 * aborts before Publish PR). `cancel(reason)` stops any pending poll wait so
 * the run settles promptly as FAILED-TO-RUN; it is a no-op once settled.
 *
 * Only call this when `ciGate` is configured -- the unconfigured sprint never
 * constructs a gate (see this file's header).
 *
 * @param {{
 *   ciGate: { workflow: string, timeoutS: number },
 *   branch: string,
 *   log?: Function,
 *   resolveContext: () => Promise<object>,
 *   gateOptions?: object,                    // test seam: sleep/now/pollIntervalMs
 *   createGate?: Function,                   // test seam: defaults to createCiGate
 * }} opts
 * @returns {{ workflow: string, branch: string, promise: Promise<object>, cancel: (reason?: string) => void, settled: () => boolean }}
 */
export function startFinalizationCiGate({ ciGate, branch, log = () => {}, resolveContext, gateOptions = {}, createGate = createCiGate }) {
    const label = CI_GATE_FINALIZATION_LABEL;
    const cancellable = createCancellableSleep(gateOptions.sleep);
    let isSettled = false;
    const toFailed = (err) => {
        const reason = `CI gate error: ${err && err.message ? err.message : String(err)}`;
        log(`${LOG_PREFIX} ERROR: ${CI_GATE_OUTCOME.FAILED_TO_RUN} for workflow '${ciGate.workflow}' on ${branch}: ${reason}`);
        return failedToRunRecord({ ciGate, branch, reason, label });
    };
    let promise;
    try {
        const gate = createGate({ ciGate, branch, log, resolveContext, gateOptions: { ...gateOptions, sleep: cancellable.sleep } });
        log(`${LOG_PREFIX} started at Finalization on the ${branch} head; Final Review, Regression Test and Harvest continue while it runs. Publish PR awaits the result; CI never changes the sprint verdict.`);
        promise = Promise.resolve()
            .then(() => gate.check({ label }))
            .then(
                (record) => record || toFailed(new Error('the gate returned no result')),
                toFailed,
            );
    } catch (err) {
        promise = Promise.resolve(toFailed(err));
    }
    promise = promise.then((record) => { isSettled = true; return record; });
    return {
        workflow: ciGate.workflow,
        branch,
        promise,
        cancel(reason) {
            if (isSettled) return;
            cancellable.cancel(reason || 'the sprint ended before the CI gate finished');
        },
        settled: () => isSettled,
    };
}

/**
 * Turn the awaited gate record into the PR-body lines and the loud log lines
 * Publish PR emits. Pure. `branchHeadSha` is the head Publish PR just pushed
 * (null when it could not be read); when it differs from the sha CI ran on,
 * both say so explicitly -- the later commits were not covered by CI.
 *
 * @param {object|null} record the gate record (see runCiGate)
 * @param {{ branchHeadSha?: string|null }} [opts]
 * @returns {{ pass: boolean, lines: string[], logLines: string[], shaMismatch: string|null }}
 */
export function formatCiGateReport(record, { branchHeadSha = null } = {}) {
    const r = record || failedToRunRecord({ ciGate: null, branch: null, reason: 'no CI gate result was recorded.' });
    const outcome = r.outcome || CI_GATE_OUTCOME.FAILED_TO_RUN;
    const pass = outcome === CI_GATE_OUTCOME.PASS;
    const workflow = r.workflow || '(unknown workflow)';
    const ranOn = r.headSha || null;
    const head = branchHeadSha ? String(branchHeadSha).trim() : null;
    let shaMismatch = null;
    if (ranOn && head && ranOn.toLowerCase() !== head.toLowerCase()) {
        shaMismatch = `CI ran on ${ranOn}; branch head is now ${head} (commits after CI started: not covered).`;
    }
    const lines = [
        pass
            ? `CI gate: PASS -- workflow '${workflow}'.`
            : `CI gate: ${outcome} -- workflow '${workflow}' did NOT pass; CI has not verified this branch. (CI never changes the sprint verdict; review the run before merging.)`,
        `CI run: ${r.runUrl || (r.runId ? `run ${r.runId} (no url)` : '(no run -- the gate did not reach a workflow run)')}`,
        `CI ran on commit: ${ranOn || '(unknown -- the branch head could not be read)'}`,
        `CI jobs: ${formatJobs(r.jobs)}`,
    ];
    if (!pass && r.reason) lines.push(`CI reason: ${r.reason}`);
    if (shaMismatch) lines.push(shaMismatch);
    const logLines = [];
    if (pass) {
        logLines.push(`${LOG_PREFIX} Finalization result: PASS for workflow '${workflow}' (${r.runUrl || 'no url'}) on ${ranOn}; jobs: ${formatJobs(r.jobs)}.`);
    } else {
        logLines.push(`${LOG_PREFIX} ERROR: Finalization result: ${outcome} for workflow '${workflow}'${ranOn ? ` on ${ranOn}` : ''}${r.runUrl ? ` (${r.runUrl})` : ''} -- CI did NOT pass. The PR is still raised and the sprint verdict is unchanged; the PR body states this result. Reason: ${r.reason || '(none recorded)'}`);
    }
    if (shaMismatch) logLines.push(`${LOG_PREFIX} WARNING: ${shaMismatch}`);
    return { pass, lines, logLines, shaMismatch };
}
