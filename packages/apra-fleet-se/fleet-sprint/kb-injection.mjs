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

import { kbKnowledgeBlock, kbKnowledgeBlockIds, KB_SELF_INJECTING_ROLES } from './kb.mjs';
import { roleHints } from './kb-hints.mjs';

/** The pushed info of a dispatch that carried no KNOWLEDGE BANK block. */
export function emptyPushed() {
    return { ids: [], bytes: 0 };
}

/**
 * What one KNOWLEDGE BANK block pushes: the ids of the entries it carries and
 * its byte length (UTF-8). An absent block is emptyPushed().
 *
 * @param {object[]} entries the entries the block was built from
 * @param {string|undefined} block the block text
 * @returns {{ids: string[], bytes: number}}
 */
export function pushedInfo(entries, block) {
    if (typeof block !== 'string' || block.length === 0) return emptyPushed();
    return { ids: kbKnowledgeBlockIds(entries), bytes: Buffer.byteLength(block, 'utf8') };
}

/**
 * @param {{
 *   kbWork: { knowledgeFor: Function },
 *   isMemberVerified?: (memberName: string) => boolean,
 *   diffFiles?: (memberName: string) => Promise<string[]>,
 *   diffHunks?: (memberName: string) => Promise<string>,
 *   deployTargets?: (memberName: string, role: string) => Promise<string[]>,
 *   log?: Function,
 * }} opts
 */
export function createKbInjection(opts = {}) {
    const { kbWork, log = () => {} } = opts;
    // member name -> { block, pushed } of the latest block built for it. A
    // prompt-builder role (doer, reviewer) builds its block before the
    // dispatch wrapper runs; the wrapper reads it back through pushedIn().
    const lastBlock = new Map();
    const verified = (name) => {
        const fn = typeof opts.isMemberVerified === 'function' ? opts.isMemberVerified : null;
        try { return !!(fn && fn(name)); } catch { return false; }
    };
    const api = {
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
        async blockFor(d) {
            return (await api.blockWithInfoFor(d)).block;
        },
        /**
         * blockFor plus what the block pushes: { block, pushed: {ids, bytes} }.
         * The block is exactly what blockFor returns; the pushed info is kept
         * per member so pushedIn() can attribute it to the dispatch.
         */
        async blockWithInfoFor({ role, member, context = {}, captureChannel = true }) {
            if (!member || !kbWork || typeof kbWork.knowledgeFor !== 'function') return { block: [], pushed: emptyPushed() };
            // Advisory only: a failure here costs the block, never the dispatch.
            try {
                const ctx = { ...context };
                if (!ctx.diffFiles && typeof opts.diffFiles === 'function' && /^(reviewer|harvester)$/.test(role)) {
                    try { ctx.diffFiles = await opts.diffFiles(member); } catch (err) {
                        log(`[kb-inject] could not list the diff files for ${member} (non-fatal): ${err && err.message ? err.message : err}`);
                    }
                }
                if (!ctx.diffHunks && typeof opts.diffHunks === 'function' && /^(reviewer|harvester)$/.test(role)) {
                    try { ctx.diffHunks = await opts.diffHunks(member); } catch (err) {
                        log(`[kb-inject] could not read the diff hunks for ${member} (non-fatal): ${err && err.message ? err.message : err}`);
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
                const block = kbKnowledgeBlock(entries, { captureChannel, source, reportEmpty: true });
                const pushed = pushedInfo(entries, block[0]);
                if (block[0]) lastBlock.set(member, { block: block[0], pushed });
                else lastBlock.delete(member);
                return { block, pushed };
            } catch (err) {
                lastBlock.delete(member);
                log(`[kb-inject] could not build the KNOWLEDGE BANK block for ${role} on ${member} (non-fatal, dispatching without it): ${err && err.message ? err.message : err}`);
                return { block: [], pushed: emptyPushed() };
            }
        },
        /**
         * The pushed info for a dispatch of `prompt` to `memberName`: the
         * latest block built for that member when the prompt carries it
         * verbatim, else emptyPushed(). Never throws.
         */
        pushedIn(prompt, memberName) {
            const last = memberName ? lastBlock.get(memberName) : null;
            if (!last || typeof prompt !== 'string' || !prompt.includes(last.block)) return emptyPushed();
            return { ids: last.pushed.ids.slice(), bytes: last.pushed.bytes };
        },
    };
    return api;
}

/**
 * The dispatch wrapper's KNOWLEDGE BANK step (runner.js agent()): appends the
 * block to `prompt` for every role outside KB_SELF_INJECTING_ROLES (doer and
 * reviewer place it through their own prompt builders, so skipping them here
 * keeps the block to exactly one copy per dispatched prompt). Every member
 * gets the block, verified at sprint init or not.
 *
 * @param {string} prompt
 * @param {{
 *   kbInjection: { blockFor: Function } | null,
 *   agentType?: string,
 *   member?: string,
 *   context?: object,
 *   captureChannel?: boolean,
 *   fallbackBlock?: () => string[],
 *   onPushed?: (pushed: {ids: string[], bytes: number}) => void,
 *   log?: Function,
 * }} opts  fallbackBlock supplies the block when kbInjection is not bound yet.
 *   onPushed receives what the block this call appended pushes (ids, bytes);
 *   it is not called when this call appends nothing (a self-injecting role,
 *   no member). It never changes the returned prompt. A failure building the
 *   block is logged and the prompt goes out without it.
 * @returns {Promise<string>}
 */
export async function withWrapperKbBlock(prompt, { kbInjection, agentType, member, context = {}, captureChannel = true, fallbackBlock, onPushed, log = () => {} } = {}) {
    if (!agentType || KB_SELF_INJECTING_ROLES.has(agentType) || !member) return prompt;
    let block;
    let pushed = emptyPushed();
    try {
        if (kbInjection && typeof kbInjection.blockWithInfoFor === 'function') {
            const out = await kbInjection.blockWithInfoFor({ role: agentType, member, context, captureChannel });
            block = out.block[0];
            pushed = out.pushed || pushed;
        } else if (kbInjection) {
            [block] = await kbInjection.blockFor({ role: agentType, member, context, captureChannel });
            pushed = pushedInfo([], block);
        } else {
            [block] = typeof fallbackBlock === 'function' ? fallbackBlock() : [];
            pushed = pushedInfo([], block);
        }
    } catch (err) {
        block = undefined;
        pushed = emptyPushed();
        log(`[kb-inject] could not build the KNOWLEDGE BANK block for ${agentType} on ${member} (non-fatal, dispatching without it): ${err && err.message ? err.message : err}`);
    }
    if (typeof onPushed === 'function') {
        try { onPushed(block ? pushed : emptyPushed()); } catch { /* informational only */ }
    }
    return block ? prompt + '\n\n' + block : prompt;
}
