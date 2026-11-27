// =============================================================================
// Engine-side KNOWLEDGE BANK injection (parent bug apra-fleet-b4g.18).
//
// The block is injected into every dispatched member's prompt -- local or
// remote, the repository's kb_maintainer or not, fleet-MCP-verified or not --
// for the roles in kb.mjs KB_BLOCK_ROLES only (planner, plan-reviewer, doer,
// reviewer); no other role's dispatch calls blockFor.
// Priming (kb.mjs primeAll) imports the bible and reads only on each
// repository's kb_maintainer, so a member's own KB is not primed and a
// non-maintainer member (notably a remote one on another host) would otherwise
// get no knowledge at all. The maintainer is the knowledge source.
//
// The block's content is fetched from the repository's kb_maintainer through
// memberCall (kbWork.knowledgeFor), CONFIRMED and undisputed only, ranked by the
// role's own hints (kb-hints.mjs roleHints).
// =============================================================================

import { kbKnowledgeBlock } from './kb.mjs';
import { roleHints } from './kb-hints.mjs';

/**
 * @param {{
 *   kbWork: { knowledgeFor: Function },
 *   diffFiles?: (memberName: string) => Promise<string[]>,
 *   deployTargets?: (memberName: string, role: string) => Promise<string[]>,
 *   log?: Function,
 * }} opts
 */
export function createKbInjection(opts = {}) {
    const { kbWork, log = () => {} } = opts;
    return {
        /** True when the KNOWLEDGE BANK block is injected for `memberName`: every dispatched member. */
        shouldInject(memberName) {
            return !!memberName && !!kbWork && typeof kbWork.knowledgeFor === 'function';
        },
        /**
         * The KNOWLEDGE BANK block (a 0/1-element array) for one dispatch.
         * @param {{ role: string, member: string, context?: object, captureChannel?: boolean }} d
         */
        async blockFor({ role, member, context = {}, captureChannel = true, excludeIds }) {
            if (!member || !kbWork || typeof kbWork.knowledgeFor !== 'function') return [];
            const ctx = { ...context };
            if (!ctx.diffFiles && typeof opts.diffFiles === 'function' && /^(reviewer|harvester)$/.test(role)) {
                try { ctx.diffFiles = await opts.diffFiles(member); } catch (err) {
                    log(`[kb-inject] could not list the diff files for ${member} (non-fatal): ${err && err.message ? err.message : err}`);
                }
            }
            if (!ctx.deployTargets && typeof opts.deployTargets === 'function'
                && /^(deployer|integ-test-runner|regression-test-runner)$/.test(role)) {
                try { ctx.deployTargets = await opts.deployTargets(member, role); } catch (err) {
                    log(`[kb-inject] could not read the deploy targets for ${member} (non-fatal): ${err && err.message ? err.message : err}`);
                }
            }
            const hints = roleHints(role, ctx);
            const { entries, source } = await kbWork.knowledgeFor(member, hints);
            return kbKnowledgeBlock(entries, { captureChannel, source, reportEmpty: true, excludeIds });
        },
    };
}
