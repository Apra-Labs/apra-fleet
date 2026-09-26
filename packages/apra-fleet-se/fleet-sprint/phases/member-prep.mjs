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
//      classifies skipped_local_member) reported that skip.
//   4. UNREACHABLE         -- the registry reports llm_auth 'offline', which
//      getAuthStatus() returns for a FAILED CONNECTION TEST, not for a
//      credential verdict. See below.
// FAIL LOUD: outcomes 3 and 4 are the only two that abort, and they abort
// with DIFFERENT, accurate errors before this phase (and therefore the
// sprint) reaches its first role dispatch. Never a warning.
//
// UNREACHABLE IS NOT A MISSING CREDENTIAL (apra-fleet-i4ku.13).
// src/tools/list-members.ts's getAuthStatus() returns 'offline' the instant
// `strategy.testConnection()` fails or throws -- BEFORE it looks for an
// OAuth credential file or an API-key env var -- so 'offline' says the
// machine did not answer and says nothing at all about its credentials.
// Folding it into the generic non-OK path sent it to provision_llm_auth,
// which failed on the same dead transport, and aborted with
// LlmAuthUnprovisionableError's "missing credential: LLM auth" wording:
// the operator was told to go fix credentials on a host that is simply
// switched off. checkMemberAuth() now branches on that status ahead of the
// provision call and throws MemberUnreachableError instead -- equally
// fail-loud (it still aborts the phase; downgrading it to a warning would
// be a false success), but it names the member, says the member could not
// be reached, and makes no claim about credentials. Outcome 3's error, its
// message and its trigger conditions are unchanged.
//
// SWEEP is invoked ONLY for a member memberLocality() classifies as
// LOCALITY_REMOTE -- everything else (local, relay, unknown) gets a logged
// skip line and NO call into member-stray-sweep.mjs at all, matching that
// module's own "local member: report only" rule one level up (a local
// member's sweep step never even runs, rather than running and having its
// kill downgraded).
//
// SWEEP-FAILURE POLICY -- DECIDED (apra-fleet-i4ku.11): a sweep failure
// DOES NOT ABORT THE SPRINT. It records a loud per-member sweep FAILURE
// line and the phase CONTINUES to the next step and the next member.
// This is the single, decided behaviour -- not one of two options a reader
// still has to choose between. Concretely: every StrayProbeError raised out
// of sweepMemberStrayProcesses() -- an unrunnable probe, a member with no
// supported enumeration tool (StrayProbeToolMissingError), or a kill the
// member genuinely refused (permission denied) -- is caught by
// runMemberPrepPhase() below, reported as `sweep -- FAILURE (...)` naming
// the member and the specific cause, recorded on the phase result as
// `{ status: 'failed', reason, error }`, and then execution proceeds.
// Nothing else is caught: a non-StrayProbeError escaping the sweep (a
// programming error such as the TypeError sweepMemberStrayProcesses()
// throws for a missing seam) still propagates and still ends the sprint,
// because that is a defect in the engine, not a condition on the member.
//
// WHY CONTINUE, and why this is NOT the "advisory warning that never
// blocks" this repo otherwise forbids:
//   1. The sweep is HYGIENE, not a dispatch precondition. LLM auth is a
//      precondition -- without it every dispatch to that member fails, so
//      its gate aborts (see above, and that policy is UNCHANGED by this
//      decision). A member whose processes could not be enumerated can
//      still be dispatched to, build, test and commit; the only cost is
//      that a leftover process from a previous run may still be sitting
//      there. Ending a healthy multi-member sprint before its first
//      dispatch over that is a strictly worse outcome than running it.
//   2. It cannot corrupt the other members. The sweep is per-member and
//      read-then-kill-locally; one member's missing `ps` says nothing about
//      any other member's state, so there is no shared invariant an abort
//      would be protecting.
//   3. ABORT WOULD BE UNACTIONABLE. StrayProbeToolMissingError's own text
//      tells the operator to "install the tool or exclude this member from
//      the sweep" -- but there is no per-member sweep exclusion surface.
//      `--sweep-config` (bin/cli.mjs's resolveSweepConfig) configures
//      markers and ports for the WHOLE sprint, not an exempt-member list.
//      An abort would therefore hand the operator an instruction they
//      cannot follow, leaving "unconfigure the sweep for every member" as
//      the only way to start the sprint at all -- which disables the
//      feature far more thoroughly than continuing past one bad member.
//   4. LOUDNESS IS PRESERVED, which is the part the fail-loud rule actually
//      protects. The failure is NEVER reported as 'clean' and NEVER as
//      'skipped': it is its own FAILURE status, carrying the underlying
//      error, both in the sprint log and on the returned phase result. The
//      sweep module's own "I could not look != there is nothing there"
//      guarantee is upheld exactly -- this phase never converts an
//      unsuccessful probe into a clean scan; it converts it into a recorded
//      failure the operator and any caller can see.
//
// LIVENESS PROBE: ARMED BY DEFAULT -- DECIDED (apra-fleet-i4ku.17). This is
// the single, decided behaviour, not two behaviours a reader still has to
// choose between. runSweepStep() arms member-stray-sweep.mjs's liveness
// predicate (that module's header predicate 7) for EVERY sweep it runs.
// Only an explicit `"livenessProbe": false` in the target's sweep config
// disarms it; an option the target never mentioned is ARMED. Note the
// asymmetry with the module itself, which defaults the option OFF: that
// module is a library whose caller decides, and this phase IS the caller.
//
// WHY ARMED, and what the rejected option would have cost:
//   1. The predicate can only ever SPARE. It has no path that selects a
//      process the other predicates had not already selected (see
//      decideStrayProcess(): a liveProbe value only ever appends a blocker).
//      So arming it cannot cause a wrong kill -- it can only prevent one.
//   2. The hole it closes is not hypothetical and not enumerable. The
//      production-port predicate is only as good as a STATIC port list,
//      which by construction cannot contain a supervisor someone started on
//      a non-default port, or a sprint child's allocateFreePort() viewer
//      port. Both are daemonized, so the parent-gone predicate is satisfied
//      instantly, leaving that static list as the only thing between a LIVE
//      process and a kill. No amount of target configuration can enumerate
//      an OS-assigned port up front, so the only way to protect it is to
//      ask the port itself.
//   3. REJECTED: opt-in (arm only when the target asks). That leaves the
//      hole open for every target that does not know to ask -- which is
//      every target by default, and the ones least likely to be reading
//      this file. A safety predicate that is off unless requested protects
//      only the operators who already understood the danger. It also cannot
//      be made loud honestly: warning "this sweep may kill a live process"
//      on every armed-but-unprotected sprint would be exactly the advisory
//      warning that never blocks which this repo forbids as a false
//      success.
//
// WHAT ARMING COSTS, AND WHY THAT COST IS LOUD RATHER THAN SILENT: an
// unevaluable probe spares (the module's fail-safe direction, unchanged
// here), so on a member with no curl / Invoke-WebRequest EVERY candidate is
// spared and the stale sandbox supervisor this feature exists to clean up
// survives. That is the losing case of this decision and it is reported as
// its own `sweep -- LIVENESS UNEVALUABLE` line naming the member, the count
// spared, and BOTH ways out (install an HTTP probe tool on the member, or
// set `"livenessProbe": false` to accept unchecked kills). It is never
// folded into the ordinary summary and never reported as a clean sweep.
// The ordinary summary line likewise distinguishes all three states via
// formatSweepLivenessSummary(): not armed / armed-but-never-dispatched /
// armed-and-dispatched-with-counts, so "armed and nothing was live" can
// never be misread as "the predicate was off".
//
// WHAT ARMING DOES NOT BUY, STATED SO NOBODY OVER-TRUSTS THE WORD "ARMED"
// (apra-fleet-i4ku.17): the predicate can only ask a PORT whether anything
// is answering on it. A candidate holding no listening port therefore gets
// no protection from it and is killed on the other predicates alone --
// unchanged from before the predicate existed. DECIDED, and the alternative
// rejected: routing a portless candidate into the fail-safe `unevaluable`
// spare was considered and rejected, because a portless process is the
// COMMON shape of the stale stray this sweep exists to clear (a supervisor
// that already released its port, an orphaned child), so sparing it would
// make an armed sweep a near-total no-op -- the same "quietly stops cleaning
// up" failure the arming decision above exists to avoid, arrived at from the
// other side. Those kills are counted as `unprobeable` on the result --
// per candidate, never contingent on whether some unrelated sibling in the
// same pass held a port -- and reported on their own `sweep -- LIVENESS
// UNPROBEABLE` line, so "the liveness probe was armed" can never be read as
// "every kill in this pass was checked for life". The only lever a target
// has over them is its sweep markers: a process the markers never match is
// never a candidate in the first place.
//
// READ-ONLY LOOKUPS DEGRADE, THE AUTH GATE DOES NOT: list_members is a
// best-effort registry read used only to (a) skip a redundant provision call
// when auth is already known-good and (b) classify locality for the sweep
// gate. Two failure shapes are deliberately NOT the same:
//   - No fleetApi wired, or a response with no parseable member list (a test
//     double, or any caller that never bothered to configure list_members
//     realistically) -- this is "no real registry data was ever available",
//     and degrades exactly as before: unknown locality, safe skip, no abort.
//   - The list_members call ITSELF rejects -- a genuinely live registry that
//     broke mid-run (offline fleet server, transport error). THIS case must
//     NOT fall back to "unknown == local" for the auth gate -- that earlier
//     shape silently disarmed AC4 and mislabeled remote members as local in
//     the operator log the instant list_members had one transient hiccup
//     (apra-fleet-9be4.3 review blocker 1). Instead readMemberRecords()
//     reports the read failure explicitly (readFailed:true, empty records
//     Map), and checkMemberAuth() ATTEMPTS the real provision_llm_auth call
//     for every member in that state, exactly as this header always
//     promised -- still fully fail-loud on a genuine failure. The one
//     exception: if that real call answers skipped_local_member while
//     locality was unknown, the call itself has just proven the member IS
//     local (a remote member's credential can never legitimately report that
//     reason), so this is read as a confirmed, honest skip rather than an
//     abort -- see checkMemberAuth()'s `registryReadFailed` handling below.
// The sweep gate keeps degrading BOTH unknown-locality shapes to a safe skip
// (never a guessed kill) -- see runSweepStep() -- because unlike auth, there
// is no real check the sweep can run to resolve the ambiguity itself.
// Nothing about the LLM-auth abort path for a KNOWN-remote member depends on
// this lookup succeeding.
//
// GENERIC ENGINE: no target-repo names, paths or ports are hardcoded here.
// `sweepMarkers`/`sweepProductionPorts` are caller-supplied inputs threaded
// straight through to member-stray-sweep.mjs, exactly as that module's own
// header requires. When no markers are configured, runSweepStep() reports a
// deliberate skip and dispatches NO probe at all -- with zero markers,
// member-stray-sweep.mjs's classifyFleetEvidence() can never mark a process
// fleet-started, so a dispatched probe could only ever produce a false "clean,
// N scanned" result the operator would wrongly read as real coverage
// (apra-fleet-9be4.3 review blocker 2). A target that wants real
// stray-process cleanup supplies its own markers/ports through this same
// call site.
//
// ASCII only.
// =============================================================================

import { resultText } from '../mcp-result.mjs';
import { provisionOutcome } from '../vcs-auth.mjs';
import {
    sweepMemberStrayProcesses, memberLocality, LOCALITY_REMOTE, StrayProbeError,
    EXEC_KIND_KILL,
} from '../member-stray-sweep.mjs';
import { LlmAuthUnprovisionableError, MemberUnreachableError } from '../errors.mjs';

const LOG_PREFIX = '[member-prep]';

/** LLM-auth statuses list_members reports that mean "already usable" --
 *  mirrors src/tools/list-members.ts's getAuthStatus() return values. */
const AUTH_OK_STATUSES = new Set(['oauth', 'api-key', 'api-key (warn: oauth)']);

/** The one llm_auth status src/tools/list-members.ts's getAuthStatus()
 *  returns for a CONNECTIVITY failure rather than a credential verdict: it
 *  answers 'offline' the instant `strategy.testConnection()` fails or
 *  throws, before it ever probes for an OAuth credential file or an API-key
 *  env var. So this status is evidence about the MACHINE and carries no
 *  information about the member's credentials -- see checkMemberAuth()
 *  (apra-fleet-i4ku.13). */
const AUTH_UNREACHABLE_STATUS = 'offline';

/**
 * The label a Member Prep sweep dispatch is recorded under in the sprint log
 * and ledger (apra-fleet-i4ku.12).
 *
 * Lives here, beside the phase that owns the dispatch, rather than inline in
 * fleet-sprint/runner.js's adapter, so the production adapter and the
 * verification in test/member-prep.test.mjs render the SAME strings from one
 * definition instead of two copies that can drift.
 *
 * `kind` comes straight off the execCommand seam member-stray-sweep.mjs now
 * tags (EXEC_KIND_PROBE / EXEC_KIND_KILL). It is DEFAULTED to the probe
 * wording, so an unlabelled dispatch -- any caller predating the seam's
 * `kind` field -- renders exactly the label it rendered before. Only a
 * dispatch that explicitly says it is a kill gets the kill wording, which is
 * the conservative direction to be wrong in: an unlabelled dispatch is never
 * described as destructive.
 *
 * GENERIC: names no target process, path or port -- only the member and what
 * the engine itself is doing (docs/generic-engine-boundary.md).
 *
 * @param {string} member
 * @param {'probe'|'kill'} [kind]
 * @returns {string}
 */
export function memberPrepExecLabel(member, kind) {
    const action = kind === EXEC_KIND_KILL
        ? 'stray-process kill'
        : 'stray-process probe';
    return `Member Prep: ${action} on '${member}'`;
}

function line(log, member, step, status, detail) {
    log(`${LOG_PREFIX} member '${member}': ${step} -- ${status}${detail ? ` (${detail})` : ''}`);
}

/**
 * Best-effort member-registry read (list_members, format:'json'), keyed by
 * both name and id so a caller can look a member up either way.
 *
 * Returns `{ records, readFailed }`. `records` is an EMPTY Map -- never
 * throws -- on any failure. `readFailed` distinguishes WHY it is empty:
 *   - no fleetApi wired at all, OR the list_members response had no
 *     parseable member list (e.g. a test double, or any caller that simply
 *     never bothered to configure a realistic list_members response,
 *     answering a bare `{ content }` shape with no structuredContent) --
 *     readFailed:false. Both are "no real registry data was ever available",
 *     which is this module's long-standing safe-degrade case (present/no-op
 *     elsewhere in checkMemberAuth() too) -- NOT the same thing as a live
 *     registry that broke mid-run, so it must not switch the auth gate into
 *     active-check mode (that regressed test/mock-sprint-planner-auth-
 *     failure-no-retry.test.mjs, whose scenario deliberately leaves
 *     list_members unconfigured to isolate the LOCAL-member no-retry path).
 *   - the list_members call itself rejected -- readFailed:true. This is a
 *     genuinely live registry that could not be read THIS run (offline fleet
 *     server, transport error), so callers must NOT treat every member as
 *     "known local" (see this module's header -- that conflation was review
 *     blocker 1).
 *
 * @param {{ listMembers?: (opts: object) => Promise<any> }} fleetApi
 * @param {(msg: string) => void} log
 * @returns {Promise<{ records: Map<string, object>, readFailed: boolean }>}
 */
async function readMemberRecords(fleetApi, log) {
    const records = new Map();
    if (!fleetApi || typeof fleetApi.listMembers !== 'function') return { records, readFailed: false };
    let raw;
    try {
        raw = await fleetApi.listMembers({ format: 'json' });
    } catch (err) {
        log(`${LOG_PREFIX} could not read the member registry (list_members failed: ${err && err.message ? err.message : err}); member locality is UNKNOWN for this run -- the LLM-auth gate will attempt a real provision_llm_auth check for every member rather than silently skipping it, and the sweep will stay skipped (fail-safe).`);
        return { records, readFailed: true };
    }
    let parsed;
    try {
        parsed = JSON.parse(resultText(raw));
    } catch {
        return { records, readFailed: false };
    }
    const members = Array.isArray(parsed && parsed.members) ? parsed.members : [];
    for (const m of members) {
        if (!m || typeof m !== 'object') continue;
        if (typeof m.name === 'string' && m.name) records.set(m.name, m);
        if (typeof m.id === 'string' && m.id) records.set(m.id, m);
    }
    return { records, readFailed: false };
}

/**
 * The auth step for ONE member. Returns `{ status: 'present'|'provisioned'|
 * 'skipped', detail }` on success. THROWS -- never returns a failure value
 * -- on either abort outcome, per this module's header:
 *   - MemberUnreachableError, when the registry reports the member 'offline'
 *     (a failed connection test, i.e. the machine did not answer). Checked
 *     BEFORE the provision call, so the operator is pointed at the machine
 *     and NOT told a credential is missing (apra-fleet-i4ku.13).
 *   - LlmAuthUnprovisionableError, when the member IS reachable but its auth
 *     is missing and cannot be provisioned. Unchanged.
 *
 * GATED ON LOCALITY, exactly like runSweepStep(): provision_llm_auth is
 * called ONLY for a member memberLocality() classifies LOCALITY_REMOTE, OR
 * for a member whose locality is UNKNOWN because the registry could not be
 * read this run (`registryReadFailed`). A member the registry POSITIVELY
 * identifies as local/relay is a logged 'skipped' outcome with NO
 * provisioning call at all -- see this module's header for the real
 * regression (test/mock-sprint-planner-auth-failure-no-retry.test.mjs) that
 * proved calling provision_llm_auth unconditionally, and fail-looding on its
 * guaranteed skipped_local_member no-op, breaks every local-member sprint.
 * `registryReadFailed` must NOT collapse into that same silent skip (review
 * blocker 1): an unreadable registry tells us nothing about this member's
 * real locality, so the gate actively checks rather than guessing "local".
 *
 * @param {{ member: string, memberRecord: object|null,
 *           fleetApi: { provisionLlmAuth?: Function }, registryReadFailed?: boolean,
 *           log: Function }} opts
 * @returns {Promise<{ status: string, detail: string }>}
 */
export async function checkMemberAuth({
    member, memberRecord, fleetApi, registryReadFailed = false, log = () => {},
} = {}) {
    const locality = memberLocality(memberRecord || {});
    // Locality is only genuinely "known local" when the registry read
    // actually succeeded and simply classified this member that way. If the
    // registry read failed, memberRecord is always null/absent here (see
    // readMemberRecords()), so `locality !== LOCALITY_REMOTE` is an artifact
    // of the default-to-local fallback, not real registry evidence -- treat
    // it as unknown and fall through to a real check instead of skipping.
    const localityUnknown = registryReadFailed && !memberRecord;
    if (locality !== LOCALITY_REMOTE && !localityUnknown) {
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

    // UNREACHABLE != MISSING CREDENTIAL (apra-fleet-i4ku.13). Checked BEFORE
    // the provision call below, because there is nothing useful to provision
    // against a host that never answered: provision_llm_auth would just fail
    // on the same dead transport and the phase would then abort claiming a
    // MISSING CREDENTIAL, pointing the operator at credentials when the real
    // fault is that the machine is down. Still fail-loud -- this aborts the
    // phase exactly as the credential path does -- just accurately diagnosed.
    if (knownStatus === AUTH_UNREACHABLE_STATUS) {
        throw new MemberUnreachableError(member, knownStatus);
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
        if (localityUnknown) {
            // The registry could not tell us this member's locality up
            // front, so this gate attempted the real call rather than
            // guessing -- and the call itself just answered definitively:
            // provision_llm_auth only ever reports skipped_local_member for
            // an actually-local member. That is real, honest evidence this
            // member is local, not a silent skip based on a guess -- so it
            // is reported as a confirmed skip, not an abort.
            return {
                status: 'skipped',
                detail: 'registry could not be read this run, so locality was unknown; provision_llm_auth was '
                    + 'attempted anyway and reported skipped_local_member, confirming this member is in fact '
                    + `local -- only the REACTIVE self-heal after an actual dispatch failure can detect a broken `
                    + `local session.${text ? ` ${text}` : ''}`,
            };
        }
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
 * Unlike checkMemberAuth(), an UNKNOWN locality (registry unreadable) stays a
 * safe skip here too (this module's header) -- there is no real check the
 * sweep itself can run to resolve the ambiguity, so it never guesses a kill.
 * The reported reason still names the real cause instead of claiming "local
 * member" for a member the registry simply could not confirm either way
 * (review blocker 1's log-accuracy requirement).
 *
 * Also skips (no probe dispatched at all) when `sweepMarkers` is empty: with
 * no fleet-start evidence to match against, member-stray-sweep.mjs's
 * classifyFleetEvidence() can never mark a process fleet-started, so a
 * dispatched probe could only ever produce a "clean, N scanned" result the
 * operator would wrongly read as real coverage (review blocker 2).
 *
 * THROWS, deliberately: a StrayProbeError / StrayProbeToolMissingError out
 * of sweepMemberStrayProcesses() is NOT caught here, so a direct caller of
 * this helper still gets the sweep module's own "I could not look" signal
 * unmodified. The decision about what a sprint should DO about it lives one
 * level up, in runMemberPrepPhase() (apra-fleet-i4ku.11: record a loud
 * per-member FAILURE and continue -- see this module's header).
 *
 * THE LIVENESS PREDICATE IS ARMED HERE, and this is the only place that
 * turns an unstated option into a decision -- see this module's header
 * section "LIVENESS PROBE: ARMED BY DEFAULT -- DECIDED" for the reasoning
 * and the rejected alternative. `sweepLivenessProbe === false` (and only
 * that) disarms it; `undefined` means the target said nothing and the
 * predicate is armed with member-stray-sweep.mjs's own defaults.
 *
 * @param {{ member: string, memberRecord: object|null, execCommand: Function,
 *           sweepMarkers?: Array<object>, sweepProductionPorts?: Array<number>,
 *           sweepLivenessProbe?: true|false|{ path?: string, timeoutMs?: number },
 *           registryReadFailed?: boolean, now?: () => number }} opts
 * @returns {Promise<{ status: string, reason?: string, result?: object }>}
 */
export async function runSweepStep({
    member, memberRecord, execCommand, sweepMarkers = [], sweepProductionPorts = [],
    sweepLivenessProbe, registryReadFailed = false, now = () => Date.now(),
} = {}) {
    const locality = memberLocality(memberRecord || {});
    if (locality !== LOCALITY_REMOTE) {
        if (registryReadFailed && !memberRecord) {
            return {
                status: 'skipped',
                reason: 'registry could not be read this run so locality is unknown; the sweep only ever acts on '
                    + 'a member confirmed remote, so it stays skipped (fail-safe, never a guessed kill)',
            };
        }
        return { status: 'skipped', reason: 'local member' };
    }
    if (typeof execCommand !== 'function') {
        return { status: 'skipped', reason: 'no execCommand seam wired' };
    }
    if (!Array.isArray(sweepMarkers) || sweepMarkers.length === 0) {
        return {
            status: 'skipped',
            reason: 'no fleet-start markers configured; a probe cannot identify or act on any candidate without '
                + 'evidence, so none is dispatched',
        };
    }
    // ARMED unless the target explicitly said `false` (this module's header
    // records the decision). member-stray-sweep.mjs itself defaults the
    // option OFF -- it is a library whose caller decides -- so the shipped
    // sweep path arms it right here, which is also why an engine-level
    // default change can never silently reach a target that opted out.
    const livenessProbe = sweepLivenessProbe === false ? null : (sweepLivenessProbe ?? true);
    const result = await sweepMemberStrayProcesses({
        member: { name: member, ...(memberRecord || {}) },
        markers: sweepMarkers,
        productionPorts: sweepProductionPorts,
        livenessProbe,
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
 * Renders the liveness half of a sweep summary line.
 *
 * THE POINT OF THIS FUNCTION (apra-fleet-i4ku.17): the three outcomes below
 * must never read alike. "Armed and nothing was live" and "the predicate was
 * off" describe opposite amounts of safety applied to the same kills, and an
 * operator reading the sprint log has no other place to learn which one they
 * got. `undefined` is reported as unknown rather than guessed in either
 * direction, so a sweep result that carries no liveness accounting can never
 * be narrated as if it had been checked.
 *
 * @param {{ armed?: boolean, dispatched?: boolean, checked?: number, spared?: number,
 *           unevaluable?: number, tcpAliveNoHttp?: number, unprobeable?: number }|undefined} liveness
 * @returns {string}
 */
export function formatSweepLivenessSummary(liveness) {
    if (!liveness || typeof liveness !== 'object') {
        return 'liveness probe state NOT REPORTED by this sweep result';
    }
    if (liveness.armed !== true) {
        return 'liveness probe NOT ARMED -- no candidate was checked for life before it was selected '
            + '(the sweep config set "livenessProbe": false)';
    }
    // apra-fleet-i4ku.17: an `unprobeable` candidate is a KILL THAT WAS NEVER
    // CHECKED (it held no listening port, so this predicate had no question
    // to ask it -- see member-stray-sweep.mjs's header predicate 7). It is
    // stated in BOTH armed branches below, never only in the dispatched one:
    // the previous wording said "no candidate survived the other predicates,
    // so there was nothing to check" whenever no dispatch went out, which was
    // flatly false in the pass where a portless candidate survived everything
    // and was killed. A summary that reassures while a kill went unchecked is
    // worse than no summary.
    const unprobeable = liveness.unprobeable || 0;
    // apra-fleet-i4ku.21, the SAME defect class one bucket over. `unevaluable`
    // used to be reachable only from inside the dispatch block, so
    // armed && !dispatched && unevaluable > 0 could not happen. It can now: a
    // candidate whose only listening sockets carry a bound address this module
    // cannot turn into a URL (a hostname, a zone-scoped link-local) is
    // classified unevaluable and SPARED before any dispatch is built -- see
    // member-stray-sweep.mjs's `unaskable` bucket, which sits outside that
    // block precisely so one candidate's fate never depends on whether some
    // other candidate happened to be askable. In that pass the old wording
    // ("no candidate survived the other predicates, so there was nothing to
    // check") was false in BOTH clauses: a candidate survived, and it held a
    // port worth checking. So this branch states the unevaluable spares too,
    // for the same reason the unprobeable kills are stated above.
    const unevaluable = liveness.unevaluable || 0;
    // apra-fleet-i4ku.24.2.1: a candidate whose only answering socket ACCEPTED
    // the TCP connection but spoke no HTTP is SPARED -- the same fail-safe
    // direction as `unevaluable` -- but member-stray-sweep.mjs counts it in
    // its OWN `tcpAliveNoHttp` bucket instead (never both, see that module's
    // header). It is ALSO already folded into `checked` there, because a
    // probe genuinely reached it and got an answer. Left unstated, the
    // dispatched line below would read "N checked" with no hint that some of
    // those N were a live non-HTTP listener (a database, for example) this
    // predicate can never confirm alive because it only speaks HTTP -- the
    // single most misleading place that outcome could land, since it reads
    // exactly like "checked and found dead". `|| 0` matches every other
    // bucket here: a sweep result from a code path that predates this field
    // is narrated as 0, never guessed in either direction.
    const tcpAliveNoHttp = liveness.tcpAliveNoHttp || 0;
    const tcpAliveNoHttpClause = tcpAliveNoHttp > 0
        ? `; a further ${tcpAliveNoHttp} candidate(s) held a live TCP connection that answered no HTTP and were `
            + 'SPARED rather than confirmed dead -- this predicate speaks HTTP only and cannot tell whether a '
            + 'non-HTTP listener is alive'
        : '';
    if (!liveness.dispatched) {
        if (unevaluable > 0) {
            const alsoUnchecked = unprobeable > 0
                ? `; a further ${unprobeable} candidate(s) held no listening port at all and were selected UNCHECKED`
                : '';
            return 'liveness probe armed but not dispatched -- no surviving candidate held a listening port whose '
                + `bound address could be resolved to a probeable host, so ${unevaluable} candidate(s) were SPARED `
                + `unevaluable rather than checked${alsoUnchecked}${tcpAliveNoHttpClause}`;
        }
        if (unprobeable > 0) {
            return 'liveness probe armed but not dispatched -- no surviving candidate held a listening port '
                + `to probe, so ${unprobeable} candidate(s) were selected UNCHECKED by this predicate`
                + `${tcpAliveNoHttpClause}`;
        }
        if (tcpAliveNoHttp > 0) {
            return 'liveness probe armed but not dispatched -- no surviving candidate held a listening port that '
                + `answered HTTP, so ${tcpAliveNoHttp} candidate(s) were SPARED rather than confirmed dead -- this `
                + 'predicate speaks HTTP only and cannot tell whether a non-HTTP listener is alive';
        }
        return 'liveness probe armed but not dispatched -- no candidate survived the other predicates, '
            + 'so there was nothing to check';
    }
    const uncheckedClause = unprobeable > 0
        ? `; a further ${unprobeable} candidate(s) held no listening port to probe and were selected UNCHECKED`
        : '';
    return `liveness probe armed and dispatched: ${liveness.checked || 0} candidate(s) checked, `
        + `${liveness.spared || 0} spared as live, ${unevaluable} unevaluable${uncheckedClause}${tcpAliveNoHttpClause}`;
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
 * A SWEEP failure does the OPPOSITE, by decided policy (apra-fleet-i4ku.11,
 * rationale in this module's header): every StrayProbeError /
 * StrayProbeToolMissingError out of the sweep is caught here, reported as a
 * loud per-member `sweep -- FAILURE` line, recorded as
 * `{ status: 'failed', reason, error }` on the returned result, and the
 * phase CONTINUES. Only the auth gate aborts.
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
 *   sweepLivenessProbe?: true|false|{ path?: string, timeoutMs?: number },
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
    // NO DEFAULT VALUE ON PURPOSE (apra-fleet-i4ku.17): `undefined` means
    // "the target said nothing", which runSweepStep() reads as ARMED. Giving
    // it a default here would put the arming decision in two places.
    sweepLivenessProbe,
    now = () => Date.now(),
} = {}) {
    const list = Array.isArray(members)
        ? [...new Set(members.filter((m) => typeof m === 'string' && m))]
        : [];
    const results = {};
    if (list.length === 0) return { members: results };

    group('Sprint Setup');
    phase('Member Prep');

    const { records: memberRecords, readFailed: registryReadFailed } = await readMemberRecords(fleetApi, log);

    for (const member of list) {
        const memberRecord = memberRecords.get(member) || null;

        const auth = await checkMemberAuth({
            member, memberRecord, fleetApi, registryReadFailed, log,
        });
        // The "auth" step covers BOTH credentials named in this phase's own
        // task description ("provision/verify LLM auth and VCS auth"). VCS
        // auth needs no new work here -- like G-pull below, it is already
        // handled, per-dispatch, by the existing Sync preflight
        // (createVcsAuthPreflightCallback in vcs-auth.mjs, wired into every
        // withGitSync bracket) -- so this line reports that delegation
        // alongside the LLM-auth outcome this module actually adds, rather
        // than silently saying nothing about VCS auth at all.
        line(log, member, 'auth', auth.status, `LLM auth: ${auth.detail}; VCS auth refreshed per-dispatch by the existing Sync preflight, not re-checked here`);

        // SWEEP-FAILURE POLICY (apra-fleet-i4ku.11) -- see this module's
        // header for the decision and its rationale. A StrayProbeError (and
        // its StrayProbeToolMissingError subclass) raised out of
        // sweepMemberStrayProcesses() is CONTAINED here: it becomes a loud
        // per-member FAILURE line plus a `{ status: 'failed' }` phase result
        // and the phase CONTINUES -- to this member's remaining steps and to
        // every later member. It never aborts the sprint, and it is never
        // downgraded to 'skipped' or to a clean scan. Deliberately scoped to
        // StrayProbeError alone: anything else escaping the sweep is an
        // engine defect, not a member condition, and still propagates.
        let sweep;
        try {
            sweep = await runSweepStep({
                member, memberRecord, execCommand, sweepMarkers, sweepProductionPorts,
                sweepLivenessProbe, registryReadFailed, now,
            });
        } catch (err) {
            if (!(err instanceof StrayProbeError)) throw err;
            sweep = {
                status: 'failed',
                reason: err.message,
                error: err,
            };
        }
        if (sweep.status === 'failed') {
            // FAILURE, never 'skipped' and never a clean scan: this member's
            // processes could not be established, so nothing is claimed
            // about them. The sprint continues by decided policy.
            line(
                log, member, 'sweep', 'FAILURE',
                `${sweep.reason} -- the sprint CONTINUES by policy: the sweep is hygiene, not a dispatch `
                + 'precondition, and this member was NOT scanned, so treat it as unswept rather than clean',
            );
        } else if (sweep.status === 'skipped') {
            line(log, member, 'sweep', 'skipped', sweep.reason);
        } else {
            const { result } = sweep;
            // apra-fleet-i4ku.9: `result.killed` no longer includes a pid
            // that had already exited before the kill dispatch ran (that
            // benign race -- apra-fleet-i4ku.3 -- is its own
            // `result.alreadyGone` bucket now); surfaced as its own count
            // here rather than silently dropped, so this summary line still
            // accounts for every selected candidate.
            const alreadyGoneCount = Array.isArray(result.alreadyGone) ? result.alreadyGone.length : 0;
            // apra-fleet-i4ku.17: the liveness state is part of the SAME
            // line, not a separate optional one, so "armed and found nothing
            // live" can never be read off the log as "not armed" (or the
            // reverse) by an operator who happened to see only one line.
            line(
                log, member, 'sweep', 'ran',
                `${result.killed.length} killed, ${alreadyGoneCount} already exited, ${result.reported.length} reported, ${result.scanned} scanned; `
                + formatSweepLivenessSummary(result.liveness),
            );
            // THE LOSING CASE OF THE ARMED-BY-DEFAULT DECISION, MADE LOUD
            // (see this module's header). An unevaluable probe SPARES, so on
            // a member with no curl / Invoke-WebRequest the armed predicate
            // turns real stray processes into survivors -- exactly the stale
            // sandbox this sweep exists to clear. That is the right
            // fail-safe direction, but it must never be silent, or the
            // operator sees a "clean" sprint start while junk accumulates.
            // It names both fixes, so the line is actionable rather than an
            // advisory the reader can do nothing about.
            if (result.liveness && result.liveness.armed && result.liveness.unevaluable > 0) {
                line(
                    log, member, 'sweep', 'LIVENESS UNEVALUABLE',
                    `${result.liveness.unevaluable} candidate(s) were SPARED rather than killed because the liveness `
                    + 'probe could not be evaluated on this member (no curl/Invoke-WebRequest there, the probe '
                    + 'dispatch itself failed, or the candidate\'s only listening sockets carry a bound address that '
                    + 'could not be resolved to a probeable host). Stray processes will KEEP ACCUMULATING on this '
                    + 'member until either an HTTP probe tool is installed on it and every such socket is reachable, '
                    + 'or the sweep config sets "livenessProbe": false to accept kills that were never checked for '
                    + 'life',
                );
            }
            // THE OTHER HALF OF THE SAME HONESTY (apra-fleet-i4ku.17): a
            // candidate holding no listening port cannot be probed at all, so
            // it is killed on the other predicates alone. That is not a
            // regression -- it is exactly the pre-predicate behaviour, and it
            // is deliberately NOT routed into the fail-safe spare, or the
            // armed sweep would stop cleaning the portless strays it exists
            // for. But it must never hide behind a reassuring "liveness probe
            // armed" line, so the unchecked kills get their own count, named
            // as unchecked.
            if (result.liveness && result.liveness.armed && result.liveness.unprobeable > 0) {
                line(
                    log, member, 'sweep', 'LIVENESS UNPROBEABLE',
                    `${result.liveness.unprobeable} candidate(s) were selected WITHOUT a liveness check because `
                    + 'they held no listening port -- "is anything still answering here" has no answer for a '
                    + 'portless process. Those kills rest entirely on the other predicates (markers, evidence, '
                    + 'production ports, parent-gone, minimum age), exactly as they did before the liveness '
                    + 'predicate existed. Nothing here can be fixed on the member; if such a kill is unsafe on '
                    + 'this target, tighten the sweep markers so the process is never a candidate',
                );
            }
            // A THIRD, DISTINCT SPARE (apra-fleet-i4ku.24.5) -- NOT the same
            // gap as LIVENESS UNEVALUABLE above. There, the probe could not
            // be evaluated at all (no tool, a failed dispatch, or an
            // unresolvable bound address); here the probe DID reach the
            // candidate and DID get a definite transport-level answer: the
            // port ACCEPTED the TCP connection, it just never spoke HTTP
            // back. This predicate only ever asks HTTP, so it cannot confirm
            // such a listener alive -- but "I could not check" and "I
            // checked and something is genuinely there, just not over HTTP"
            // are different findings and need different next steps, so they
            // get their own line rather than being folded into the
            // unevaluable one.
            if (result.liveness && result.liveness.armed && result.liveness.tcpAliveNoHttp > 0) {
                line(
                    log, member, 'sweep', 'LIVENESS TCP-ALIVE-NO-HTTP',
                    `${result.liveness.tcpAliveNoHttp} candidate(s) were SPARED rather than killed because their `
                    + 'listening port ACCEPTED the TCP connection but returned no HTTP response -- this predicate '
                    + 'speaks HTTP only and cannot confirm whether a non-HTTP listener (for example a database '
                    + 'server) is alive. Something IS still holding the port; if this member intentionally runs a '
                    + 'non-HTTP process this sweep marks killable, point its sweep config at an HTTP health '
                    + 'endpoint that process exposes, or accept that this predicate will keep sparing it rather '
                    + 'than ever confirming it dead',
                );
            }
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
