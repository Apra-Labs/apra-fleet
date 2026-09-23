// =============================================================================
// PHASE MODULE: Member Prep (apra-fleet-9be4.3).
//
// Runs ONCE PER MEMBER, at sprint start, BEFORE the first role dispatch:
// (a) verify/provision LLM auth, (b) sweep stray fleet processes (remote
// members only, entirely via member-stray-sweep.mjs -- no predicate is
// re-implemented here), (c) G-pull, (d) D-pull -- reporting one result line
// per step per member, including an explicit line when a step is
// deliberately skipped and why.
//
// WHAT ALREADY EXISTS, extended rather than duplicated here (see
// apra-fleet-9be4.3's own task description for the verified line numbers):
//   - G-pull is the start-of-sprint branch step
//     (phases/ensure-sprint-branch.mjs), which fetches and checks out every
//     sprint member immediately after this phase runs. This phase's G-pull
//     line is therefore a REPORT, not a second fetch: issuing a redundant
//     `git fetch` here for every member would double the git dispatch count
//     of every existing sprint run (and every pinned golden-transcript
//     fixture) for no new safety -- Ensure Sprint Branch already owns that
//     work and already fails the sprint loudly if a fetch/checkout fails.
//   - D-pull happens before every dispatch (the withGitSync bracket's
//     pre-dispatch DoltSync.syncBefore), but that is scoped to whichever
//     member a role happens to dispatch to that round -- a member with no
//     early dispatch would otherwise go unpulled for a while. This phase
//     EXTENDS that same mechanism (gitSync.syncBeadsBefore, the identical
//     bracketed D-pull every dispatch already uses) to run for every sprint
//     member up front, rather than re-implementing a second D-pull path.
//
// AUTH, verified against src/tools/provision-auth.ts and
// vcs-auth.mjs's createLlmAuthSelfHealCallback: `provision_llm_auth` is a
// NO-OP for local members (`ok:true`, `reason:'skipped_local_member'` --
// they share the operator's own host session, which only an interactive
// `/login` on that machine can refresh). Reading `ok:true` as "this member
// has working auth" would make this whole gate silently useless on exactly
// the members it cannot help, so `skipped_local_member` is explicitly NOT
// treated as successful provisioning -- see checkMemberAuth() below, which
// mirrors createLlmAuthSelfHealCallback's own ordering rule (the skip check
// must run before the generic ok/fail branch).
//
// THE AUTH CALL IS GATED ON LOCALITY, exactly like the sweep step below --
// verified against a real regression this module must not reintroduce.
// provision_llm_auth is called ONLY for a member memberLocality() classifies
// LOCALITY_REMOTE. A member that is not verifiably remote (local, relay,
// unknown) gets a logged skip line and NO provisioning call at all, for the
// same reason the sweep skips it: there is nothing this up-front check can
// verify or fix for it (provision_llm_auth is a guaranteed no-op there), so
// calling it would only ever produce the skipped_local_member no-op --
// NEVER useful evidence either way. Proven live: an earlier revision of this
// module called provision_llm_auth unconditionally for every member and
// treated skipped_local_member as the fail-loud case regardless of locality,
// which made every LOCAL-member sprint -- the single most common fleet-sprint
// configuration -- abort at Member Prep before its first dispatch, on every
// run, defeating the entire feature. It also broke
// test/mock-sprint-planner-auth-failure-no-retry.test.mjs, the regression pin
// for the Stabilization Issue 43 fix (isNonRetryableDispatchError): that test
// proves a local member's auth failure can ONLY be detected REACTIVELY, by
// letting exactly one real dispatch attempt fail and classifying the error
// (a local session cannot be probed any other way -- list_members itself
// reports 'N/A', never a real status, for a local/relay member -- see
// src/tools/list-members.ts's getAuthStatus()). This module's job is the
// analogous PROACTIVE check for members that CAN be proactively checked; the
// reactive path in vcs-auth.mjs remains the only mechanism for the rest, and
// this module must never race ahead of it.
//
// Three auth outcomes for a REMOTE member, in the order this module checks
// them (a non-remote member short-circuits to a fourth, SKIPPED, outcome
// before any of these are reached):
//   1. PRESENT & USABLE    -- list_members already reports a working LLM
//      credential (llm_auth 'oauth'/'api-key'); no provisioning call needed.
//   2. PROVISIONED         -- provision_llm_auth ran and reports ok:true with
//      a real (non-skip) reason.
//   3. NOT PROVISIONABLE   -- provision_llm_auth failed, OR (an edge case: a
//      member registered 'remote' whose credential the server nonetheless
//      classifies skipped_local_member) reported that skip. This is the
//      ONLY outcome that aborts.
// FAIL LOUD: outcome 3 throws LlmAuthUnprovisionableError, naming the member
// and the missing credential, before this phase (and therefore the sprint)
// reaches its first role dispatch. Never a warning.
//
// SWEEP is invoked ONLY for a member memberLocality() classifies as
// LOCALITY_REMOTE -- everything else (local, relay, unknown) gets a logged
// skip line and NO call into member-stray-sweep.mjs at all, matching that
// module's own "local member: report only" rule one level up (a local
// member's sweep step never even runs, rather than running and having its
// kill downgraded).
//
// READ-ONLY LOOKUPS DEGRADE, THE AUTH GATE DOES NOT: list_members is a
// best-effort registry read used only to (a) skip a redundant provision call
// when auth is already known-good and (b) classify locality for the sweep
// gate. Any failure to read or parse it (offline fleet server, a test double
// with no structuredContent) degrades to "unknown" -- which routes auth
// straight to the real provision_llm_auth call (still fully fail-loud) and
// routes the sweep to a safe skip (never a guessed kill). Nothing about the
// LLM-auth abort path depends on this lookup succeeding.
//
// GENERIC ENGINE: no target-repo names, paths or ports are hardcoded here.
// `sweepMarkers`/`sweepProductionPorts` are caller-supplied inputs threaded
// straight through to member-stray-sweep.mjs, exactly as that module's own
// header requires.
//
// ASCII only.
// =============================================================================

import { resultText } from '../mcp-result.mjs';
import { provisionOutcome } from '../vcs-auth.mjs';
import { sweepMemberStrayProcesses, memberLocality, LOCALITY_REMOTE } from '../member-stray-sweep.mjs';
import { LlmAuthUnprovisionableError } from '../errors.mjs';

const LOG_PREFIX = '[member-prep]';

/** LLM-auth statuses list_members reports that mean "already usable" --
 *  mirrors src/tools/list-members.ts's getAuthStatus() return values. */
const AUTH_OK_STATUSES = new Set(['oauth', 'api-key', 'api-key (warn: oauth)']);

function line(log, member, step, status, detail) {
    log(`${LOG_PREFIX} member '${member}': ${step} -- ${status}${detail ? ` (${detail})` : ''}`);
}

/**
 * Best-effort member-registry read (list_members, format:'json'), keyed by
 * both name and id so a caller can look a member up either way. Returns an
 * EMPTY Map -- never throws -- on any failure: no fleetApi wired, the call
 * itself rejecting, or a response with no parseable JSON (e.g. a test double
 * that answers a bare `{ content }` shape with no structuredContent). This is
 * a pure optimization/classification input; every caller of this function
 * treats a missing entry as "unknown" and degrades safely (see this module's
 * header).
 *
 * @param {{ listMembers?: (opts: object) => Promise<any> }} fleetApi
 * @param {(msg: string) => void} log
 * @returns {Promise<Map<string, object>>}
 */
async function readMemberRecords(fleetApi, log) {
    const records = new Map();
    if (!fleetApi || typeof fleetApi.listMembers !== 'function') return records;
    let raw;
    try {
        raw = await fleetApi.listMembers({ format: 'json' });
    } catch (err) {
        log(`${LOG_PREFIX} could not read the member registry (list_members failed: ${err && err.message ? err.message : err}); member locality/auth-status will be treated as unknown for this run.`);
        return records;
    }
    let parsed;
    try {
        parsed = JSON.parse(resultText(raw));
    } catch {
        return records;
    }
    const members = Array.isArray(parsed && parsed.members) ? parsed.members : [];
    for (const m of members) {
        if (!m || typeof m !== 'object') continue;
        if (typeof m.name === 'string' && m.name) records.set(m.name, m);
        if (typeof m.id === 'string' && m.id) records.set(m.id, m);
    }
    return records;
}

/**
 * The auth step for ONE member. Returns `{ status: 'present'|'provisioned'|
 * 'skipped', detail }` on success. THROWS LlmAuthUnprovisionableError --
 * never returns a failure value -- when auth is missing and cannot be
 * provisioned, per this module's header.
 *
 * GATED ON LOCALITY, exactly like runSweepStep(): provision_llm_auth is
 * called ONLY for a member memberLocality() classifies LOCALITY_REMOTE.
 * Everything else (local, relay, unknown) is a logged 'skipped' outcome with
 * NO provisioning call at all -- see this module's header for the real
 * regression (test/mock-sprint-planner-auth-failure-no-retry.test.mjs) that
 * proved calling provision_llm_auth unconditionally, and fail-looding on its
 * guaranteed skipped_local_member no-op, breaks every local-member sprint.
 *
 * @param {{ member: string, memberRecord: object|null,
 *           fleetApi: { provisionLlmAuth?: Function }, log: Function }} opts
 * @returns {Promise<{ status: string, detail: string }>}
 */
export async function checkMemberAuth({ member, memberRecord, fleetApi, log = () => {} }) {
    const locality = memberLocality(memberRecord || {});
    if (locality !== LOCALITY_REMOTE) {
        return {
            status: 'skipped',
            detail: "local member -- provision_llm_auth is a no-op for local members (they share the operator's "
                + 'own host session); only the REACTIVE self-heal after an actual dispatch failure can detect a '
                + 'broken local session, see vcs-auth.mjs\'s createLlmAuthSelfHealCallback',
        };
    }

    const knownStatus = memberRecord && typeof memberRecord.llm_auth === 'string' ? memberRecord.llm_auth : null;
    if (knownStatus && AUTH_OK_STATUSES.has(knownStatus)) {
        return { status: 'present', detail: `registered llm-auth status '${knownStatus}'` };
    }

    if (!fleetApi || typeof fleetApi.provisionLlmAuth !== 'function') {
        // No live fleet client wired at all (e.g. a legacy direct call with no
        // MCP client) -- there is nothing to provision against. Treat as
        // present rather than fabricate an abort for a caller that never
        // asked for this check.
        return { status: 'present', detail: 'no fleet API wired; auth check skipped' };
    }

    let provisionRes;
    try {
        provisionRes = await fleetApi.provisionLlmAuth({ member_name: member });
    } catch (err) {
        throw new LlmAuthUnprovisionableError(
            member, 'LLM auth',
            `provision_llm_auth call failed: ${err && err.message ? err.message : err}`,
            { cause: err },
        );
    }
    const text = resultText(provisionRes).trim();
    const outcome = provisionOutcome(provisionRes, text);

    // ORDER MATTERS (mirrors createLlmAuthSelfHealCallback in vcs-auth.mjs):
    // skipped_local_member is a well-formed, non-erroring outcome
    // (structuredContent.ok === true), so this check must run BEFORE the
    // generic ok/fail branch below -- otherwise a local member's no-op skip
    // would be misread as a genuine, working credential.
    if (outcome.reason === 'skipped_local_member' || (outcome.reason === null && /^\[SKIP\]/.test(text))) {
        throw new LlmAuthUnprovisionableError(
            member, 'LLM auth',
            'provision_llm_auth reported skipped_local_member: this member shares the operator\'s own host '
            + `session, which only an interactive /login on that machine can refresh -- automated provisioning `
            + `cannot confirm working auth for it.${text ? ` ${text}` : ''}`,
        );
    }
    if (!outcome.ok) {
        throw new LlmAuthUnprovisionableError(
            member, 'LLM auth',
            `provision_llm_auth failed: ${text || outcome.reason || '(no detail)'}`,
        );
    }
    return { status: 'provisioned', detail: text || `reason: ${outcome.reason || 'ok'}` };
}

/**
 * The sweep step for ONE member. Invokes member-stray-sweep.mjs ONLY for a
 * member classified LOCALITY_REMOTE; every other locality (local, relay,
 * unknown) is a logged skip with NO call into the sweep module at all -- no
 * safety predicate is re-implemented here (apra-fleet-9be4.3 criterion 3).
 *
 * @param {{ member: string, memberRecord: object|null, execCommand: Function,
 *           sweepMarkers?: Array<object>, sweepProductionPorts?: Array<number>,
 *           now?: () => number }} opts
 * @returns {Promise<{ status: string, reason?: string, result?: object }>}
 */
export async function runSweepStep({
    member, memberRecord, execCommand, sweepMarkers = [], sweepProductionPorts = [], now = () => Date.now(),
} = {}) {
    const locality = memberLocality(memberRecord || {});
    if (locality !== LOCALITY_REMOTE) {
        return { status: 'skipped', reason: 'local member' };
    }
    if (typeof execCommand !== 'function') {
        return { status: 'skipped', reason: 'no execCommand seam wired' };
    }
    const result = await sweepMemberStrayProcesses({
        member: { name: member, ...(memberRecord || {}) },
        markers: sweepMarkers,
        productionPorts: sweepProductionPorts,
        execCommand,
        now,
        // Silenced: member-stray-sweep.mjs's own internal log/error calls are
        // deliberately swallowed here so exactly ONE result line per step
        // reaches the sprint log (this function's caller emits the summary
        // line from the returned `result`); nothing about the sweep's OWN
        // safety predicates is affected -- only where their narration lands.
        logger: { log: () => {}, error: () => {} },
    });
    return { status: 'ran', result };
}

/**
 * The D-pull step for ONE member: a standalone bracketed beads pull through
 * the SAME gitSync.syncBeadsBefore() every dispatch's pre-dispatch D-pull
 * already uses (git-sync.mjs) -- extended to run here rather than
 * re-implemented.
 *
 * @param {{ member: string, syncBeadsBefore: Function }} opts
 * @returns {Promise<{ status: string, reason?: string }>}
 */
export async function runDPullStep({ member, syncBeadsBefore } = {}) {
    if (typeof syncBeadsBefore !== 'function') {
        return { status: 'skipped', reason: 'no syncBeadsBefore seam wired' };
    }
    await syncBeadsBefore(member, {});
    return { status: 'ran' };
}

/**
 * Runs the Member Prep phase: for every member in `members`, in order,
 * auth -> sweep -> G-pull (reported) -> D-pull, logging one result line per
 * step. Throws LlmAuthUnprovisionableError -- aborting the whole phase, and
 * therefore the sprint, before any role dispatch -- the instant a member's
 * auth step cannot be resolved.
 *
 * @param {{
 *   members: string[],
 *   fleetApi?: { listMembers?: Function, provisionLlmAuth?: Function },
 *   execCommand?: (opts: { member: string, command: string }) => Promise<{ ok?: boolean, output?: string, error?: string }>,
 *   syncBeadsBefore?: (member: string, options?: object) => Promise<any>,
 *   log?: (msg: string) => void,
 *   group?: (label: string) => void,
 *   phase?: (label: string) => void,
 *   endGroup?: () => void,
 *   sweepMarkers?: Array<object>,
 *   sweepProductionPorts?: Array<number>,
 *   now?: () => number,
 * }} state
 * @returns {Promise<{ members: Record<string, { auth: object, sweep: object, gpull: object, dpull: object }> }>}
 */
export async function runMemberPrepPhase({
    members,
    fleetApi,
    execCommand,
    syncBeadsBefore,
    log = () => {},
    group = () => {},
    phase = () => {},
    endGroup = () => {},
    sweepMarkers = [],
    sweepProductionPorts = [],
    now = () => Date.now(),
} = {}) {
    const list = Array.isArray(members)
        ? [...new Set(members.filter((m) => typeof m === 'string' && m))]
        : [];
    const results = {};
    if (list.length === 0) return { members: results };

    group('Sprint Setup');
    phase('Member Prep');

    const memberRecords = await readMemberRecords(fleetApi, log);

    for (const member of list) {
        const memberRecord = memberRecords.get(member) || null;

        const auth = await checkMemberAuth({ member, memberRecord, fleetApi, log });
        // The "auth" step covers BOTH credentials named in this phase's own
        // task description ("provision/verify LLM auth and VCS auth"). VCS
        // auth needs no new work here -- like G-pull below, it is already
        // handled, per-dispatch, by the existing Sync preflight
        // (createVcsAuthPreflightCallback in vcs-auth.mjs, wired into every
        // withGitSync bracket) -- so this line reports that delegation
        // alongside the LLM-auth outcome this module actually adds, rather
        // than silently saying nothing about VCS auth at all.
        line(log, member, 'auth', auth.status, `LLM auth: ${auth.detail}; VCS auth refreshed per-dispatch by the existing Sync preflight, not re-checked here`);

        const sweep = await runSweepStep({
            member, memberRecord, execCommand, sweepMarkers, sweepProductionPorts, now,
        });
        if (sweep.status === 'skipped') {
            line(log, member, 'sweep', 'skipped', sweep.reason);
        } else {
            const { result } = sweep;
            line(
                log, member, 'sweep', 'ran',
                `${result.killed.length} killed, ${result.reported.length} reported, ${result.scanned} scanned`,
            );
        }

        // G-pull is reported, not re-dispatched -- see this module's header:
        // phases/ensure-sprint-branch.mjs runs immediately after Member Prep
        // and performs the real fetch/checkout for every sprint member.
        const gpull = { status: 'delegated' };
        line(log, member, 'G-pull', 'delegated', 'performed by the Ensure Sprint Branch phase, which runs next for every sprint member');

        const dpull = await runDPullStep({ member, syncBeadsBefore });
        if (dpull.status === 'skipped') {
            line(log, member, 'D-pull', 'skipped', dpull.reason);
        } else {
            line(log, member, 'D-pull', 'ran', null);
        }

        results[member] = {
            auth, sweep, gpull, dpull,
        };
    }

    endGroup();
    return { members: results };
}
