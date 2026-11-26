// Fakes for KB write-routing tests: a kb_maintainer selector with the same
// surface createKbMaintainerSelector (fleet-sprint/kb-maintainer.mjs) exposes
// to createKbWorkClient, built from plain maps instead of member probes.

import { REQUIRED_MAINTAINER_BIBLE_RULES } from '../../fleet-sprint/kb.mjs';

/**
 * @param {{
 *   repoOf: Record<string, string>,          member name -> repository
 *   maintainerOf: Record<string, object>,    repository -> maintainer record {id, name, type}
 *   nonRepo?: string[],                      members whose work folder is not a repository
 * }} spec
 */
export function fakeMaintainerSelector({ repoOf = {}, maintainerOf = {}, nonRepo = [] } = {}) {
    const sel = (repo) => {
        const record = maintainerOf[repo];
        return record ? { repo, member: record.name, record, rule: 'role-less', replaced: [] } : null;
    };
    return {
        getKbMaintainer: (repo) => sel(repo),
        maintainerForMember: (member) => (repoOf[member] ? sel(repoOf[member]) : null),
        repoOf: (member) => repoOf[member] || null,
        isNonRepoMember: (member) => nonRepo.includes(member),
        maintainers: () => new Map(Object.entries(maintainerOf).map(([repo, r]) => [repo, { member: r.name, rule: 'role-less', replaced: [] }])),
        nonRepoMembers: () => nonRepo.slice(),
    };
}

/** A selector where `record` is the maintainer of the one repository every listed member belongs to. */
export function selfMaintainer(record, members = [record.name]) {
    const repoOf = {};
    for (const m of members) repoOf[m] = 'example.com/org/repo';
    return fakeMaintainerSelector({ repoOf, maintainerOf: { 'example.com/org/repo': record } });
}

/**
 * A tools/list answer from a CURRENT apra-fleet server: it offers
 * kb_capabilities (the engine's version gate for merge-carried withdrawals)
 * and its kb_import advertises `ref`. The engine feature-detects every
 * maintainer, a local one included, through this.
 */
export const currentServerListTools = async () => ({
    tools: [
        { name: 'kb_capabilities', inputSchema: { properties: {} } },
        { name: 'kb_bible_commit', inputSchema: { properties: { ids: {}, withdrawals: {}, restore_ids: {} } } },
        { name: 'kb_import', inputSchema: { properties: { path: {}, ref: {}, skip_sweep: {} } } },
    ],
});

/** Every contract route: what kb_capabilities answers for a local SQLite KB. */
export const ALL_KB_ROUTES = Object.freeze(['capture', 'query', 'promote', 'context', 'prime', 'invalidate', 'feedback', 'list', 'demote', 'withdraw']);

/**
 * The fleet_build a CURRENT apra-fleet server reports in kb_capabilities: its
 * bible rules revision meets the engine's bible-commit build gate.
 */
export const CURRENT_FLEET_BUILD = Object.freeze({ version: 'v0.0.0-test', bible_rules: REQUIRED_MAINTAINER_BIBLE_RULES });

/** A kb_capabilities answer (a tool result) listing `routes`, from a server reporting `fleetBuild` (null: none). */
export function kbCapabilitiesResult(routes = ALL_KB_ROUTES, fleetBuild = CURRENT_FLEET_BUILD) {
    return { content: [{ type: 'text', text: JSON.stringify({ contract: 'v1', routes: [...routes], branch_aware: false, ...(fleetBuild ? { fleet_build: { ...fleetBuild } } : {}) }) }] };
}

/**
 * Wraps a fake memberCall so a kb_capabilities call answers `routes` (default:
 * every route, as a local SQLite KB does) and every other call goes to
 * `memberCall` unchanged -- the capabilities read is not recorded by it.
 */
export function withKbCapabilities(memberCall, routes = ALL_KB_ROUTES) {
    return async (member, name, ...rest) => (name === 'kb_capabilities' ? kbCapabilitiesResult(routes) : memberCall(member, name, ...rest));
}

/**
 * `create(opts)` (createKbWorkClient) with every maintainer on a CURRENT
 * apra-fleet server whose KB serves every route: listTools defaults to
 * currentServerListTools (an explicit opts.listTools wins) and memberCall
 * answers kb_capabilities (withKbCapabilities).
 */
export function currentServerKbWork(create, opts = {}) {
    const memberCall = typeof opts.memberCall === 'function' ? withKbCapabilities(opts.memberCall) : opts.memberCall;
    return create({ listTools: currentServerListTools, ...opts, memberCall });
}
