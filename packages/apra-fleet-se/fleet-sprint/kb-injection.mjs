// =============================================================================
// Engine-side KNOWLEDGE BANK injection (parent bug apra-fleet-b4g.18).
//
// The block is injected into a role's dispatch prompt UNLESS that member's own
// fleet MCP was verified at sprint init (its MEMBER session lists the kb tools;
// see member-init-probe.mjs): a verified member reads the KB itself. Every
// other member -- install failed, server down, a provider without per-tool deny
// (opencode) or per-project MCP (agy), any failed check, or a member with no
// init record at all -- always gets the block.
//
// The block's content is fetched from the repository's kb_maintainer through
// memberCall (kbWork.knowledgeFor), CONFIRMED and undisputed only, ranked by the
// role's own hints (kb-hints.mjs roleHints). The verified lookup is read from
// the sprint context (context.isMemberVerified); this module never re-probes.
// =============================================================================

import { kbKnowledgeBlock } from './kb.mjs';
import { roleHints } from './kb-hints.mjs';

/**
 * @param {{
 *   kbWork: { knowledgeFor: Function },
 *   isMemberVerified?: (memberName: string) => boolean,
 *   diffFiles?: (memberName: string) => Promise<string[]>,
 *   log?: Function,
 * }} opts
 */
export function createKbInjection(opts = {}) {
    const { kbWork, log = () => {} } = opts;
    const verified = (name) => {
        const fn = typeof opts.isMemberVerified === 'function' ? opts.isMemberVerified : null;
        try { return !!(fn && fn(name)); } catch { return false; }
    };
    return {
        /** True when the KNOWLEDGE BANK block must be injected for `memberName`. */
        shouldInject(memberName) {
            return !verified(memberName);
        },
        /**
         * The KNOWLEDGE BANK block (a 0/1-element array) for one dispatch.
         * @param {{ role: string, member: string, context?: object, captureChannel?: boolean }} d
         */
        async blockFor({ role, member, context = {}, captureChannel = true }) {
            if (!member || !kbWork || typeof kbWork.knowledgeFor !== 'function') return [];
            if (verified(member)) return [];
            const ctx = { ...context };
            if (!ctx.diffFiles && typeof opts.diffFiles === 'function' && /^(reviewer|harvester)$/.test(role)) {
                try { ctx.diffFiles = await opts.diffFiles(member); } catch (err) {
                    log(`[kb-inject] could not list the diff files for ${member} (non-fatal): ${err && err.message ? err.message : err}`);
                }
            }
            const hints = roleHints(role, ctx);
            const { entries, source } = await kbWork.knowledgeFor(member, hints);
            return kbKnowledgeBlock(entries, { captureChannel, source, reportEmpty: true });
        },
    };
}
