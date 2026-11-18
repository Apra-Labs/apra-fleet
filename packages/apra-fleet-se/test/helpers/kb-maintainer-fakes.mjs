// Fakes for KB write-routing tests: a kb_maintainer selector with the same
// surface createKbMaintainerSelector (fleet-sprint/kb-maintainer.mjs) exposes
// to createKbWorkClient, built from plain maps instead of member probes.

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
 * A tools/list answer from a CURRENT apra-fleet server: its kb_bible_commit
 * advertises the withdrawal route and its kb_import `ref`. The engine
 * feature-detects every maintainer, a local one included, through this.
 */
export const currentServerListTools = async () => ({
    tools: [
        { name: 'kb_bible_commit', inputSchema: { properties: { ids: {}, withdrawals: {}, restore_ids: {} } } },
        { name: 'kb_import', inputSchema: { properties: { path: {}, ref: {}, skip_sweep: {} } } },
    ],
});
