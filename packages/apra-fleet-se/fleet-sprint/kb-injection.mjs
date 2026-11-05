// =============================================================================
// Engine-side KNOWLEDGE BANK injection (parent bug apra-fleet-b4g.18; push to
// every dispatch: apra-fleet-6agk.3.1).
//
// The block is PUSHED into every role's dispatch prompt, for every member --
// whether or not that member's own fleet MCP was verified at sprint init (its
// MEMBER session lists the kb tools; see member-init-probe.mjs). A verified
// member can still query the KB on top of the pushed block; an unverified one
// (install failed, server down, a provider without per-tool deny (opencode) or
// per-project MCP (agy), any failed check, or no init record at all) relies on
// the block alone. The verified lookup is kept only for logging and never
// suppresses the block.
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
 *   deployTargets?: (memberName: string, role: string) => Promise<string[]>,
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
        /**
         * True when the KNOWLEDGE BANK block must be injected for `memberName`:
         * always -- the block is pushed to every member, verified or not.
         */
        shouldInject(_memberName) {
            return true;
        },
        /** Whether `memberName` passed the init probe (logging only; never gates the block). */
        isVerified(memberName) {
            return verified(memberName);
        },
        /**
         * The KNOWLEDGE BANK block (a 0/1-element array) for one dispatch.
         * @param {{ role: string, member: string, context?: object, captureChannel?: boolean }} d
         */
        async blockFor({ role, member, context = {}, captureChannel = true }) {
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
            return kbKnowledgeBlock(entries, { captureChannel, source, reportEmpty: true });
        },
    };
}
