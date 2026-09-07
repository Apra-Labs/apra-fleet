// =============================================================================
// Unified member OS/shell registry (apra-fleet-3swo.2.5).
//
// Extracted move-only from fleet-sprint/runner.js, which owned
// `resolveMemberTarget`, its per-member cache and the `resolveMemberOs`
// back-compat wrapper as private/local state. This module is now the single
// owner; runner.js imports and re-exports all three so its existing facade
// (dolt-settle.mjs's doc comments, vcs-providers/azure-devops.mjs's doc
// comments, vcs-providers/shell-helpers.mjs's doc comments, and the two test
// files that import resolveMemberOs/clearMemberOsCache by name from
// runner.js) stays intact.
//
// CONTRACT (do not change without checking every reference above): the
// resolved shape is { os, shell }, where os is a lowercase string like
// 'windows' | 'linux' | 'darwin' and shell is one of '' | 'gitbash' |
// 'pwsh7' | 'powershell5'.
// =============================================================================

// memberName -> resolved { os, shell } ('windows' | 'linux' | 'darwin' | ...
// and '' | 'gitbash' | ... respectively), cached for the lifetime of the
// runner process: a member's OS/shell never changes mid-sprint, and
// member_detail performs a live connectivity check, so this must not be
// re-dispatched per credential read (raiseVcsPrForMember can call it twice
// on the auth-retry path alone).
const memberOsCache = new Map();

// Test seam: the OS cache is process-lifetime state, so a test exercising two
// different member OSes for the same member name must be able to clear it.
export function clearMemberOsCache() {
    memberOsCache.clear();
}

// Resolves `member`'s { os, shell } from the fleet member registry via
// fleetApi.memberDetail() ('member_detail' is the only MCP surface exposing
// Agent.os/Agent's registered shell -- src/tools/member-detail.ts; it does
// NOT expose a homeDir). Mirrors VCSModule.resolveProvider()'s member_detail
// JSON-parsing shape.
//
// Unlike resolveProvider, an unresolvable OS is NOT a hard error here: the
// ONLY behavioral difference it drives is which shell string the credential
// read is built as, and the historical (POSIX) string must stay byte-identical
// for every non-Windows member and for any caller that has no memberDetail
// wired. So a missing/unparseable/absent-`os` response degrades to 'linux'
// (the pre-existing behavior) and is logged, never thrown. A windows member
// whose record carries no `shell` (or an unrecognized one) resolves to '' --
// getSeCommands() treats that as the PowerShell implementation, matching what
// every Windows member was assumed to be before shells were recorded.
// @param {{ fleetApi?: object, member: string, log?: Function }} opts
// @returns {Promise<{ os: string, shell: string }>}
export async function resolveMemberTarget({ fleetApi, member, log = () => {} }) {
    if (memberOsCache.has(member)) return memberOsCache.get(member);
    try {
        if (!fleetApi || typeof fleetApi.memberDetail !== 'function') {
            throw new Error('no fleetApi.memberDetail() injected');
        }
        const res = await fleetApi.memberDetail({ member_name: member, format: 'json' });
        const text = typeof res === 'string'
            ? res
            : (res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === 'string')
                ? res.content[0].text
                : '';
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.os === 'string' && parsed.os.trim()) {
            const os = parsed.os.trim().toLowerCase();
            const shell = (parsed && typeof parsed.shell === 'string') ? parsed.shell.trim().toLowerCase() : '';
            const target = { os, shell };
            // Only a genuine member_detail-derived OS/shell is cached. Caching
            // the 'linux' fallback below would permanently pin a member that
            // hit a transient failure (asleep, flaky SSH, MCP hiccup) to
            // POSIX command construction for the rest of the runner process
            // -- including the auth-retry credential read at
            // raiseVcsPrForMember, whose entire purpose is to recover from
            // exactly this kind of transient failure. See apra-fleet-ot2z.13.
            memberOsCache.set(member, target);
            return target;
        }
        throw new Error('member_detail response carried no "os" field');
    } catch (err) {
        log(`Could not resolve OS for member '${member}' from member_detail (${err && err.message ? err.message : err}); assuming POSIX ('linux') for member-bound command construction.`);
        return { os: 'linux', shell: '' };
    }
}

// Back-compat wrapper: existing callers (and tests) that only need the OS
// string keep working unchanged. Resolves and caches both os and shell (see
// resolveMemberTarget above); callers that also need the shell (e.g. the VCS
// credential-read path) should call resolveMemberTarget directly.
// @param {{ fleetApi?: object, member: string, log?: Function }} opts
// @returns {Promise<string>}
export async function resolveMemberOs(opts) {
    const { os } = await resolveMemberTarget(opts);
    return os;
}
