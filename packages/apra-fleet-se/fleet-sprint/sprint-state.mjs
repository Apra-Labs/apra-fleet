import { ApraFleet } from '@apralabs/apra-fleet-client';
import { resolveMemberTarget } from './member-target.mjs';
import { createMemberVcsProviderResolver } from './vcs-auth.mjs';

// =============================================================================
// PER-SPRINT RESOLVED STATE (apra-fleet-3swo.6.1).
//
// One explicit object, created ONCE at sprint start (runSprintCycle) and
// threaded into every site that used to re-derive the same two things per
// call:
//
//   1. the fleet MCP client used to resolve a member's registered shell for
//      the dolt-settle call sites. runner.js's `resolveSettleShell` built a
//      brand new `ApraFleet({ callTool })` on EVERY invocation, at seven call
//      sites, several of them per dispatch -- a fresh wrapper object per
//      settle-shell resolution for the whole sprint. The wrapper is pure
//      transport plumbing over the injected `callTool`, so exactly one is
//      needed per sprint.
//   2. the per-member VCS provider resolver
//      (`createMemberVcsProviderResolver`). This one was ALREADY constructed
//      once per sprint inside runSprintCycle and already carries its own
//      per-member Map cache; this module RELOCATES that single construction
//      so the phase modules Phase 4 slices out of runSprintCycle receive it
//      through sprint state instead of closing over a runSprintCycle local.
//      It is deliberately NOT first-time caching, and no phase module may
//      construct a second resolver of its own -- there must stay exactly one
//      construction site in this directory (pinned by
//      test/sprint-state.test.mjs).
//
// WHAT THIS MODULE DELIBERATELY DOES *NOT* CACHE -- READ BEFORE ADDING A MAP.
//
// The resolved { os, shell } pair is NOT memoized here, per member or
// otherwise. member-target.mjs owns that cache and deliberately caches ONLY a
// genuine member_detail-derived result: a member that was asleep, flaky over
// SSH or hit an MCP hiccup degrades to { os: 'linux', shell: '' } UNCACHED, so
// the next call re-resolves it instead of pinning it to POSIX command
// construction for the rest of the runner process (the auth-retry credential
// read at raiseVcsPrForMember depends on exactly that recovery --
// apra-fleet-ot2z.13).
//
// A sprint-state object that resolved every member once at sprint start and
// froze whatever it got would cache that fallback BY CONSTRUCTION and silently
// undo it. So this module holds the CLIENT (sprint-lifetime, cheap, stateless)
// and re-asks member-target.mjs on every resolution (which is a no-op for any
// member already resolved successfully). Do not "optimize" that into a shell
// cache here.
//
// CONTRACT: the resolved shell value set is unchanged for its three downstream
// consumers (dolt-settle.mjs, vcs-providers/azure-devops.mjs,
// vcs-providers/shell-helpers.mjs) -- 'gitbash', 'pwsh7', 'powershell5' or the
// empty string. Sites with no `callTool` wired (mock-sprint scenarios with no
// MCP client) keep the pre-shell-aware default of the empty string, exactly as
// runner.js's guarded `resolveSettleShell` did.
// =============================================================================

/**
 * Logged once per constructed sprint-scoped fleet client. Exported so a test
 * can count constructions over a whole simulated sprint cycle from the run's
 * logs without reaching into this module's internals.
 */
export const SPRINT_STATE_CLIENT_CONSTRUCTED_LOG =
    '[sprint-state] constructed the sprint-scoped fleet client (one per sprint; every settle-shell resolution shares it).';

/**
 * Prefix logged on every settle-shell resolution served through the
 * sprint-scoped client. Exported for the same reason as the constant above:
 * it is the observable that distinguishes "resolved through sprint state" from
 * "re-derived at the call site".
 */
export const SPRINT_STATE_SETTLE_SHELL_LOG_PREFIX = '[sprint-state] settle shell for member';

// callTool -> the single ApraFleet wrapper built over it. Keyed by the
// injected callTool function identity (which a sprint has exactly one of, from
// bin/cli.mjs's connected MCP client), so the call sites that receive only
// `args` -- syncMemberAfterOrdered, reached from git-sync.mjs's withGitSync
// teardown, which has no sprint-state to thread -- share the SAME client as
// the sprint-state object rather than reintroducing a per-call construction.
// A WeakMap so a finished sprint's callTool (and its client) stay collectable.
let fleetApiByCallTool = new WeakMap();

/**
 * Test seam: the client memo is process-lifetime state keyed by function
 * identity, so a test that counts constructions must be able to drop it.
 */
export function clearSprintStateClientCache() {
    fleetApiByCallTool = new WeakMap();
}

/**
 * The one fleet client per `callTool`. Returns null when no callTool is wired
 * (no MCP client -- nothing to build a client over), which every caller treats
 * as "keep the pre-shell-aware default".
 *
 * @param {{ callTool?: Function, log?: Function, createFleetApi?: (opts: object) => object }} opts
 *   `createFleetApi` is an injectable construction seam (defaults to
 *   `new ApraFleet(...)`) so a test can COUNT constructions -- the property
 *   this hoist creates is unobservable through callTool alone, since building
 *   the wrapper makes no MCP call.
 * @returns {object|null}
 */
export function sprintScopedFleetApi({ callTool, log = () => {}, createFleetApi } = {}) {
    if (typeof callTool !== 'function') return null;
    const cached = fleetApiByCallTool.get(callTool);
    if (cached) return cached;
    const construct = typeof createFleetApi === 'function' ? createFleetApi : (opts) => new ApraFleet(opts);
    const fleetApi = construct({ callTool });
    fleetApiByCallTool.set(callTool, fleetApi);
    log(SPRINT_STATE_CLIENT_CONSTRUCTED_LOG);
    return fleetApi;
}

/**
 * Resolves `member`'s registered shell through an already-built client. No
 * memoization here on purpose (see this file's header): member-target.mjs is
 * the single owner of the { os, shell } cache and of the deliberately
 * UNCACHED degrade, so a transiently-unreachable member is re-resolved on the
 * next call.
 *
 * @param {{ fleetApi?: object|null, member: string, log?: Function }} opts
 * @returns {Promise<string>} 'gitbash' | 'pwsh7' | 'powershell5' | ''
 */
export async function resolveSettleShellWith({ fleetApi, member, log = () => {} }) {
    if (!fleetApi) return '';
    const target = await resolveMemberTarget({ fleetApi, member, log });
    log(`${SPRINT_STATE_SETTLE_SHELL_LOG_PREFIX} '${member}' resolved to '${target.shell}' through the sprint-scoped fleet client.`);
    return target.shell;
}

/**
 * Builds the sprint's resolved state. Called exactly ONCE per sprint, at the
 * top of runSprintCycle, and threaded from there -- never rebuilt per phase or
 * per call site.
 *
 * @param {{ callTool?: Function, log?: Function, createFleetApi?: (opts: object) => object }} opts
 * @returns {{
 *   callTool: Function|undefined,
 *   fleetApi: object|null,
 *   resolveMemberProvider: ((member: string) => Promise<string|undefined>)|undefined,
 *   resolveSettleShell: (opts: { member: string, log?: Function }) => Promise<string>,
 * }}
 */
export function createSprintState({ callTool, log = () => {}, createFleetApi } = {}) {
    const active = typeof callTool === 'function';
    const fleetApi = active ? sprintScopedFleetApi({ callTool, log, createFleetApi }) : null;
    // The RELOCATED single construction (see this file's header, point 2).
    // Undefined when no callTool is wired, which is the pre-existing tier-3
    // behavior at runSprintCycle's old construction site: every runGitStep
    // falls back to the default provider chain. A provider that fails to
    // resolve still degrades to that same default chain with a logged
    // non-fatal message and no throw, and an unresolvable member is still
    // cached as undefined exactly once -- all of that lives in
    // createMemberVcsProviderResolver and is unchanged by the relocation.
    const resolveMemberProvider = active ? createMemberVcsProviderResolver({ callTool, log }) : undefined;

    return {
        callTool: active ? callTool : undefined,
        fleetApi,
        resolveMemberProvider,
        resolveSettleShell({ member, log: callLog = log } = {}) {
            return resolveSettleShellWith({ fleetApi, member, log: callLog });
        },
    };
}
