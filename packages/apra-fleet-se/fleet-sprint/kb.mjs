// KB (Knowledge Bank) work for fleet-sprint: the URL-based repo scope
// selector, the per-dispatch relevance-ranked read (kb_query), the vetting
// and forwarding of a role's kb_captures/kb_promotions payload (kb_capture/
// kb_promote), the canonical-bible publish (kb_export), the once-per-sprint
// priming client (kb_session_prime/kb_import) and the prompt-construction
// helpers that hand a role's primed knowledge and promotion candidates to
// its dispatch prompt -- extracted move-only out of runner.js
// (apra-fleet-3swo.4.4 for the original KB work concern; apra-fleet-3swo.6.11
// for createKbPrimingClient, KB_SELF_INJECTING_ROLES, kbQueryTerms,
// kbKnowledgeBlock and kbPromotionBlock). runner.js re-exports every symbol
// it previously exported from this region, so existing importers of
// fleet-sprint/runner.js resolve unchanged.
//
// Every kb_* call here is BEST-EFFORT and NON-FATAL: a KB outage (cold KB,
// unreachable server, a rejected or throwing callTool) must only be logged,
// never fail a dispatch. Every call also spreads repo_path AND the scopeOf()
// URL-scope fields -- omitting either was a real defect (apra-fleet-23c
// zod-validation failures without repo_path/content, apra-fleet-tm7's
// repo-blindness without the URL scope) and both must keep flowing on every
// site this module owns.

import { ROLES, wrapUntrustedBlock } from './contracts.mjs';
import { toolErrorText } from './mcp-result.mjs';

// Local, validated role constant -- mirrors runner.js's own roleConst()
// pattern (kb.mjs does not import runner.js's private helper, to avoid a
// module import cycle) so a rename/typo in contracts.ROLES still throws
// here at module-load time instead of silently narrowing KB_PROMOTER_ROLES
// to nothing.
function kbRoleConst(name) {
    if (!ROLES.includes(name)) {
        throw new Error(`[Role Contract] '${name}' is not a member of contracts.ROLES: ${ROLES.join(', ')}`);
    }
    return name;
}
const ROLE_REVIEWER = kbRoleConst('reviewer');
// Same mirrored-local pattern as ROLE_REVIEWER above, needed by
// KB_SELF_INJECTING_ROLES below (moved verbatim from runner.js, which still
// keeps its own module-private ROLE_DOER for its other call sites).
const ROLE_DOER = kbRoleConst('doer');

/**
 * Cap on primed entries carried into a dispatch prompt. kb_session_prime can
 * return up to ~28 (10 direct FTS hits + 3 global + 5 graph-neighbour + 5
 * project-bible + 5 global-bible); a dispatch prompt is not a place to spend
 * that much budget on context the role may not need, and the entries are
 * already returned in relevance order.
 */
export const KB_MAX_KNOWLEDGE_ENTRIES = 12;

/**
 * The URL-based KB scope selector, spread into a kb_* call's arguments.
 *
 * repo_path alone is only sufficient for a LOCAL member: resolveProjectSlug
 * (src/services/knowledge/project-slug.ts) runs git in that directory to derive
 * the project slug. A remote member's work folder is a path on another host, so
 * both git probes fail and the slug degrades to 'default' -- collapsing every
 * remote member's knowledge into one shared KB. repo_remote_url selects the DB
 * directly (apra-fleet-b4g.1) and is what makes a sprint's kb_* calls land in
 * the member's own project KB.
 *
 * Absent when no URL is known: an omitted scope is the honest pre-existing
 * degradation, while a fabricated one routes writes into a slug that does not
 * match the repo's real local-clone slug. The engine never derives a URL -- it
 * forwards only what member_detail reports (knownRepoRemoteUrl's rule).
 */
export function kbScope(remoteUrl) {
    return (typeof remoteUrl === 'string' && remoteUrl.length > 0) ? { repo_remote_url: remoteUrl } : {};
}

/**
 * KB trust pipeline Phase 2, execution half for this engine.
 *
 * The role output schemas are SHARED with apra-pm (contracts.mjs loads them from
 * apra-pm/agents/schemas), so every role dispatched here is now asked for
 * kb_captures, and the reviewer for kb_promotions. Without a consumer those
 * fields would be silently dropped -- the knowledge would be gathered and
 * thrown away. This is that consumer.
 *
 * Unlike apra-pm's auto-sprint.js -- a Claude Workflow script with no tool
 * access, which must hand its vetted payload to an executor subagent -- this
 * engine runs in-process with an injected callTool, so it makes the kb_capture
 * and kb_promote calls DIRECTLY. Judgment still belongs to the role; execution
 * belongs here.
 *
 * Validation mirrors lib/vet-kb-work.mjs in apra-pm and the provider invariants
 * it reflects: a capture must cite at least one source file (SqliteProvider
 * rejects an entry the freshness sweep can never stale), a promotion needs a
 * recorded evidence string, and kb_promotions is refused from any role other
 * than reviewer -- widening capture to four roles must not widen promotion.
 *
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {{ apply: (role: string, repoPath: string, result: any) => Promise<{captured: number, promoted: number, refused: number}> }}
 */
export const KB_PROMOTER_ROLES = Object.freeze(new Set([ROLE_REVIEWER]));
export const KB_MIN_PROMOTE_REASON = 20;
export const KB_CAPTURE_TYPES = Object.freeze(['knowledge', 'learning', 'runbook']);

/**
 * True when an MCP tool result represents a tool-level failure. The MCP client
 * resolves such results instead of throwing (apra-fleet-23c), so callers that
 * only catch exceptions silently treat failures as successes.
 */
function isToolError(res) {
    return !!(res && typeof res === 'object' && res.isError === true);
}

export function vetKbWork(role, result) {
    const captures = [];
    const promotions = [];
    const refused = [];

    const rawCaptures = (result && Array.isArray(result.kb_captures)) ? result.kb_captures : [];
    for (const c of rawCaptures) {
        if (!c || typeof c.title !== 'string' || typeof c.summary !== 'string') {
            refused.push(`${role}: capture missing title/summary`);
            continue;
        }
        if (!Array.isArray(c.source_files) || c.source_files.length === 0) {
            refused.push(`${role}: capture "${c.title}" cites no source files`);
            continue;
        }
        if (!KB_CAPTURE_TYPES.includes(c.type)) {
            refused.push(`${role}: capture "${c.title}" has unsupported type ${String(c.type)}`);
            continue;
        }
        // apra-fleet-23c: kbCaptureSchema requires content (z.string().min(1)).
        // Omitting it here meant every kb_capture the engine sent failed zod
        // validation at the MCP boundary and persisted nothing.
        if (typeof c.content !== 'string' || c.content.trim().length === 0) {
            refused.push(`${role}: capture "${c.title}" has no content`);
            continue;
        }
        captures.push({
            type: c.type,
            title: c.title,
            summary: c.summary,
            content: c.content,
            source_files: c.source_files,
            symbols: Array.isArray(c.symbols) ? c.symbols : [],
        });
    }

    const rawPromotions = (result && Array.isArray(result.kb_promotions)) ? result.kb_promotions : [];
    if (rawPromotions.length > 0 && !KB_PROMOTER_ROLES.has(role)) {
        refused.push(`${role}: kb_promotions refused -- promotion is reviewer-only`);
    } else {
        for (const p of rawPromotions) {
            if (!p || typeof p.id !== 'string' || p.id.length === 0) {
                refused.push(`${role}: promotion missing id`);
                continue;
            }
            if (typeof p.reason !== 'string' || p.reason.trim().length < KB_MIN_PROMOTE_REASON) {
                refused.push(`${role}: promotion ${p.id} has no recorded evidence`);
                continue;
            }
            promotions.push({ id: p.id, reason: p.reason.trim() });
        }
    }

    return { captures, promotions, refused };
}

/** Max promotion candidates offered to one reviewer, so the prompt stays bounded. */
export const KB_MAX_PROMOTION_CANDIDATES = 40;

export function createKbWorkClient(opts = {}) {
    const { callTool, log = () => {}, remoteUrlFor } = opts;
    const active = typeof callTool === 'function';

    /**
     * The URL-based KB scope for a repo path, resolved through the injected
     * lookup (createKbPrimingClient's remoteUrlForPath). Deliberately NOT an
     * extra parameter on the methods below: they are called from nine places
     * across runSprintCycle/finalReview/harvest, and an omitted argument is
     * indistinguishable from "no URL known" -- it would silently reinstate the
     * repo-blindness this exists to fix. With no lookup injected (every
     * construction site predating this, and direct unit calls) the scope is
     * absent and behaviour is exactly as before.
     */
    function scopeOf(repoPath) {
        return kbScope(typeof remoteUrlFor === 'function' ? remoteUrlFor(repoPath) : null);
    }

    /** Best-effort JSON out of an MCP result (string, content-block, or plain object). */
    function parseResult(result) {
        if (typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
        if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
            try { return JSON.parse(result.content[0].text); } catch { return null; }
        }
        return (result && typeof result === 'object') ? result : null;
    }

    return {
        /**
         * apra-fleet-0ef: the INFERRED entries this reviewer may promote.
         *
         * The engine's contract is "judgment belongs to the role, execution
         * belongs here" -- the reviewer returns `kb_promotions:[{id, reason}]`
         * and `apply()` calls kb_promote. But an entry id exists only inside
         * the KB, and the reviewer subagent has no apra-fleet MCP tools to
         * look one up, so it could never name an id: `kb_promotions` was
         * structurally always empty and nothing was ever promoted. (kb_captures
         * worked only because a capture needs no pre-existing id.) This is the
         * missing input: the engine reads the candidates and hands them to the
         * reviewer in its prompt.
         *
         * Best-effort by design -- a cold or unreachable KB must degrade to
         * "nothing to promote", never fail the review dispatch.
         */
        async promotionCandidates(repoPath) {
            // Without a repo path kb_list would resolve against the fleet
            // server's cwd and offer entries from an unrelated project's KB
            // (the apra-fleet-tm7 repo-blindness class). Refuse rather than guess.
            if (!active || !repoPath) return [];
            try {
                const parsed = parseResult(await callTool('kb_list', {
                    repo_path: repoPath,
                    ...scopeOf(repoPath),
                    confidence: 'INFERRED',
                    limit: KB_MAX_PROMOTION_CANDIDATES,
                }));
                const results = parsed && Array.isArray(parsed.results) ? parsed.results : [];
                return results
                    // promote() refuses type='user-directive' outright (activation
                    // is human-terminal, CLI-only), so offering one as a candidate
                    // can only produce a guaranteed refusal.
                    .filter((e) => e && typeof e.id === 'string' && e.type !== 'user-directive')
                    .slice(0, KB_MAX_PROMOTION_CANDIDATES);
            } catch (err) {
                log(`[kb-work] could not list promotion candidates for ${repoPath} (non-fatal): ${err.message}`);
                return [];
            }
        },
        /**
         * KB audit follow-up: the per-dispatch, relevance-ranked read.
         *
         * primeAll() runs ONCE per member at sprint start with no hints, so
         * every role received the same handful of entries no matter what it was
         * about to work on -- and kb_query went unused by this engine entirely.
         * This asks the KB what it knows about THIS dispatch, using the terms
         * the engine already holds (bead ids and their titles).
         *
         * `expand_related` is what finally reads the KB's own graph. The KB has
         * been writing `refines` and `contradiction_of` edges since AUDN
         * shipped and traversing none of them: 554 edges, 0 reads. A role about
         * to act on an entry is precisely who needs to know that entry has a
         * newer framing or a standing dispute -- especially since confidence
         * tier does NOT track correctness across a contradiction chain (the
         * warehouse chain-A shape, where the incorrect entry outranks both of
         * its corrections).
         *
         * Best-effort, like every other KB read here: no repo path, no terms, a
         * cold KB or an unreachable one all degrade to "no knowledge", never to
         * a failed dispatch.
         */
        async relevantKnowledge(repoPath, terms) {
            if (!active || !repoPath || !Array.isArray(terms) || terms.length === 0) return [];
            const query = terms.filter((t) => typeof t === 'string' && t.trim()).join(' ');
            if (!query) return [];
            try {
                const res = await callTool('kb_query', {
                    repo_path: repoPath,
                    ...scopeOf(repoPath),
                    query,
                    limit: KB_MAX_KNOWLEDGE_ENTRIES,
                    expand_related: true,
                });
                // apra-fleet-23c: an MCP callTool RESOLVES with {isError:true}
                // for a tool-level failure rather than throwing, so this was
                // the one kb_* failure path in this module that stayed
                // silent -- parseResult() returns null for that envelope,
                // taking the `if (!parsed) return [];` branch below and never
                // reaching the catch. Detect it explicitly so a cold or
                // misconfigured KB degrades visibly, like every other kb_*
                // call here.
                if (isToolError(res)) {
                    log(`[kb-work] kb_query rejected for ${repoPath} (non-fatal): ${toolErrorText(res)}`);
                    return [];
                }
                const parsed = parseResult(res);
                if (!parsed) return [];
                const hits = Array.isArray(parsed.l1_results) ? parsed.l1_results : [];
                const related = Array.isArray(parsed.related_claims) ? parsed.related_claims : [];
                const seen = new Set();
                const out = [];
                for (const e of hits) {
                    if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
                    seen.add(e.id);
                    out.push(e);
                }
                // Related claims sit BELOW every direct hit and carry a marker,
                // so a role can tell "the KB matched this" from "the KB says
                // something about what it matched".
                for (const e of related) {
                    if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
                    seen.add(e.id);
                    out.push({ ...e, via: 'kb-graph' });
                }
                return out.slice(0, KB_MAX_KNOWLEDGE_ENTRIES);
            } catch (err) {
                log(`[kb-work] kb_query failed for ${repoPath} (non-fatal): ${err.message}`);
                return [];
            }
        },
        async apply(role, repoPath, result) {
            const { captures, promotions, refused } = vetKbWork(role, result);

            for (const r of refused) log(`[kb-work] refused -- ${r}`);
            // Log every promotion with its stated evidence BEFORE attempting it.
            // This log is the audit trail the bible never had.
            for (const p of promotions) log(`[kb-work] promote ${p.id} (${role}): ${p.reason}`);

            // Without a repo path a capture would land in whichever KB the fleet
            // server's cwd resolves to -- the tm7 defect. Refuse rather than guess.
            if (!active || !repoPath) {
                if ((captures.length || promotions.length) && !repoPath) {
                    log(`[kb-work] no repo path for ${role} -- ${captures.length} capture(s) and ${promotions.length} promotion(s) dropped`);
                }
                return { captured: 0, promoted: 0, refused: refused.length };
            }

            let captured = 0;
            let promoted = 0;
            for (const c of captures) {
                try {
                    const res = await callTool('kb_capture', { ...c, repo_path: repoPath, ...scopeOf(repoPath) });
                    // apra-fleet-23c: an MCP client RESOLVES with {isError:true} on a
                    // tool-level failure rather than throwing, so counting every
                    // non-throwing call as a success reported captures that never
                    // persisted ("captured 3" against a KB that stayed empty).
                    if (isToolError(res)) {
                        log(`[kb-work] kb_capture rejected for "${c.title}" (non-fatal): ${toolErrorText(res)}`);
                        continue;
                    }
                    captured++;
                } catch (err) {
                    log(`[kb-work] kb_capture failed for "${c.title}" (non-fatal): ${err.message}`);
                }
            }
            for (const p of promotions) {
                try {
                    // apra-fleet-0ef: repo_path is REQUIRED here, exactly as on
                    // the kb_capture call above. Omitting it resolved the
                    // promotion against the fleet server's cwd -- a different
                    // project's KB, where the id does not exist -- so every
                    // promotion would have failed "Entry not found" (the
                    // apra-fleet-tm7 repo-blindness class, fixed for capture
                    // but missed here).
                    const res = await callTool('kb_promote', { id: p.id, reason: p.reason, repo_path: repoPath, ...scopeOf(repoPath) });
                    if (isToolError(res)) {
                        log(`[kb-work] kb_promote rejected for ${p.id} (non-fatal): ${toolErrorText(res)}`);
                        continue;
                    }
                    promoted++;
                } catch (err) {
                    log(`[kb-work] kb_promote failed for ${p.id} (non-fatal): ${err.message}`);
                }
            }
            if (captured || promoted) log(`[kb-work] ${role}: captured ${captured}, promoted ${promoted}`);
            return { captured, promoted, refused: refused.length };
        },

        /**
         * KB audit 2026-08-11: publish this repo's CONFIRMED set to its
         * canonical bible (<repo>/.fleet/kb-canonical.json).
         *
         * Nothing in the pipeline had ever called kb_export, so a bible existed
         * only where an operator had run the tool by hand -- 1 of 17 repos on
         * the audited machine. Promotion therefore ended at the local sqlite
         * store: a teammate, a fresh clone, or a member on another host saw
         * none of it, and kb_session_prime's cold-seed (which reads exactly
         * this file) had nothing to fall back on. Promotion is the sprint's
         * work; publishing it is the step that makes the work leave the
         * machine.
         *
         * Called once, AFTER the final review's promotions have been applied,
         * so the bible reflects everything this sprint confirmed. Best-effort
         * like every other KB call here: a sprint must never fail over an
         * export, and the tool itself is a no-op when the entry set is
         * unchanged. Committing/pushing the file stays a separate, opt-in
         * decision (kb_export's own autoCommit config) -- this does not widen
         * the engine's git authority.
         */
        async exportBible(repoPath) {
            // Same repo-blindness guard as every other call here: without a
            // path kb_export would resolve against the fleet server's cwd and
            // write an unrelated project's bible.
            if (!active || !repoPath) return false;
            try {
                const res = await callTool('kb_export', { repo_path: repoPath, ...scopeOf(repoPath) });
                if (isToolError(res)) {
                    log(`[kb-work] kb_export rejected for ${repoPath} (non-fatal): ${toolErrorText(res)}`);
                    return false;
                }
                log(`[kb-work] exported the canonical bible for ${repoPath}`);
                return true;
            } catch (err) {
                log(`[kb-work] kb_export failed for ${repoPath} (non-fatal): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * apra-fleet-e28 / KB trust pipeline Phase 2: KB priming for the fleet-sprint
 * engine, which had none -- it lived only in the Claude workflow copy.
 *
 * `callTool` is injected exactly like `createMemberReservationClient`'s, so this
 * stays transport-agnostic and unit-testable without a live fleet server.
 *
 * WHY PER MEMBER, NOT PER SPRINT: this engine has no repo path of its own. It
 * coordinates members by name and branch; the repo lives on each member's side,
 * possibly on a different host at a different path. `kb_session_prime` selects
 * WHICH project KB is read from its `repo_path`, and omitting that argument
 * falls back to the fleet server's own cwd -- collapsing every member's
 * knowledge into whichever repo the server happens to sit in, which is exactly
 * the apra-fleet-tm7 / apra-fleet-3zl repo-blindness defect. So the work folder
 * is resolved per member via `member_detail` (which reports it as `folder`) and
 * each member is primed against its own repo.
 *
 * Best-effort throughout, matching the reservation client's precedent: a member
 * whose folder cannot be resolved, or whose prime call fails, is logged and
 * skipped. A sprint must not fail because the KB is cold -- priming is an
 * optimisation, and every role contract's Step 0 already degrades gracefully
 * when the KB tools are unavailable.
 *
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, members?: string[], log?: Function }} opts
 * @returns {{ primeAll: () => Promise<{primed: number, skipped: number}> }}
 */

export function createKbPrimingClient(opts = {}) {
    const { callTool, members = [], log = () => {} } = opts;
    const active = typeof callTool === 'function' && members.length > 0;

    function parseResult(result) {
        if (result && typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
        if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
            try { return JSON.parse(result.content[0].text); } catch { return null; }
        }
        return (result && typeof result === 'object') ? result : null;
    }

    async function scopeFor(member) {
        // apra-fleet-n78: format:'json' is REQUIRED. member_detail defaults to
        // 'compact', whose renderer emits no folder at all -- `folder` is set only
        // on the json path (src/tools/member-detail.ts). Omitting it made this
        // return null for every member, so the KB was never primed for anyone.
        const detail = parseResult(await callTool('member_detail', { member_name: member, format: 'json' }));
        // member_detail reports the work folder as `folder` and the repo origin
        // URL as `repo_remote_url` (src/tools/member-detail.ts). The URL is
        // reported only when the member's registration record proves it, so an
        // absent one is normal and must stay absent rather than be derived here.
        const folder = detail && (detail.folder || (detail.member && detail.member.folder));
        const url = detail && (detail.repo_remote_url || (detail.member && detail.member.repo_remote_url));
        return {
            folder: (typeof folder === 'string' && folder.length > 0) ? folder : null,
            remoteUrl: (typeof url === 'string' && url.length > 0) ? url : null,
        };
    }

    // member -> work folder, populated by primeAll(). createKbWorkClient reads
    // it so a capture lands in the repo the member actually worked in, rather
    // than being resolved against the fleet server's cwd.
    const folders = new Map();

    // member -> the repo origin URL member_detail reported for it, when it
    // reported one. This is what scopes a REMOTE member's kb_* calls to its own
    // project KB instead of the shared 'default' one (see kbScope).
    const remoteUrls = new Map();

    // work folder -> that folder's origin URL, or CONFLICTING_URL when two
    // members claim the same path string for DIFFERENT repos. The work client
    // resolves its scope through this map rather than taking the URL as an
    // extra argument at each of its nine call sites: threading the repo path is
    // then the same act as threading the scope, so a site cannot forget one
    // while remembering the other.
    const urlByFolder = new Map();
    const CONFLICTING_URL = Symbol('conflicting-remote-url');

    // member -> the entries kb_session_prime returned for that member.
    //
    // KB audit 2026-08-11: primeAll() used to `await callTool(...)` and throw
    // the result away, on the assumption that priming "warms" something the
    // role's own Step 0 would later read. It does not: prime is a pure read,
    // and the role CANNOT repeat it -- a member-dispatched subagent has the
    // fleet MCP server disabled (src/providers/claude.ts
    // composePermissionConfig), so every contract's Step 0 kb_session_prime is
    // unreachable there. Nothing consumed the knowledge and nothing could, which
    // is why six sprints retrieved zero entries. Retaining the result is what
    // lets kbKnowledgeBlock() hand it to the role in its dispatch prompt --
    // the same shape of fix that made kb_promotions reachable.
    const knowledge = new Map();

    return {
        folderOf(member) {
            return folders.get(member) || null;
        },
        remoteUrlOf(member) {
            return remoteUrls.get(member) || null;
        },
        /**
         * The URL scoping kb_* calls made against `repoPath`, or null.
         *
         * Null for an unknown path, for a local member (no URL was reported),
         * and for a path two members claim with different URLs. Members on
         * different hosts can share a work-folder path string while being
         * clones of different repos; picking either URL there would route one
         * member's captures into the other's KB, which is strictly worse than
         * the 'default' degradation this scoping exists to remove. Refusing
         * leaves that case exactly as it was before.
         */
        remoteUrlForPath(repoPath) {
            if (typeof repoPath !== 'string' || repoPath.length === 0) return null;
            const url = urlByFolder.get(repoPath);
            return (typeof url === 'string') ? url : null;
        },
        knowledgeOf(member) {
            return knowledge.get(member) || [];
        },
        async primeAll() {
            if (!active) return { primed: 0, skipped: members.length };
            let primed = 0;
            let skipped = 0;
            for (const member of members) {
                try {
                    const { folder: repoPath, remoteUrl } = await scopeFor(member);
                    if (repoPath) folders.set(member, repoPath);
                    if (remoteUrl) remoteUrls.set(member, remoteUrl);
                    if (repoPath && remoteUrl) {
                        const known = urlByFolder.get(repoPath);
                        if (known !== undefined && known !== remoteUrl) {
                            urlByFolder.set(repoPath, CONFLICTING_URL);
                            log(`[kb-prime] work folder ${repoPath} is claimed by two different repos -- KB calls for it stay unscoped`);
                        } else {
                            urlByFolder.set(repoPath, remoteUrl);
                        }
                    }
                    if (!repoPath) {
                        // No folder means no repo to scope the KB to. Priming without
                        // one would read the fleet server's own KB, so skip instead.
                        log(`[kb-prime] no work folder for member '${member}' -- skipping (KB stays cold)`);
                        skipped++;
                        continue;
                    }
                    // Land the committed bible in the WARM KB before priming.
                    //
                    // Without this the bible is reachable only through
                    // kb_session_prime's cold-seed, which reads it as a FILE
                    // and caps at 5 entries -- apra-fleet's own bible holds 17,
                    // so a sprint could see at most 5 arbitrary ones and FTS
                    // could rank none of them, because they were never rows.
                    // Importing first is what gives the per-dispatch kb_query
                    // (see relevantKnowledge) anything to match against.
                    // Idempotent by id, and best-effort: a repo with no bible,
                    // or an import that rejects every entry, must not stop the
                    // prime it was meant to feed.
                    //
                    // skip_sweep IS LOAD-BEARING (audit 2026-08-12, caught by a
                    // live sprint). kb_import's post-import freshnessSweep
                    // re-judges the ENTIRE KB against this member's worktree. At
                    // sprint start that staled 16 of 17 CONFIRMED entries purely
                    // because the repo had moved on since capture, and the
                    // damage cascaded: retrieval fell to one matchable entry,
                    // kb_export attempted a 17 -> 9 bible truncation, and
                    // kb_list (stale=0) returned an EMPTY promotion candidate
                    // list -- reinstating apra-fleet-0ef, "kb_promote can never
                    // fire". This import exists to WARM the KB, never to audit
                    // it; prime()'s own bounded checkFreshness still guards each
                    // entry it actually returns.
                    try {
                        const imported = parseResult(await callTool('kb_import', { repo_path: repoPath, ...kbScope(remoteUrl), skip_sweep: true }));
                        if (imported && typeof imported.imported === 'number' && imported.imported > 0) {
                            log(`[kb-prime] imported ${imported.imported} bible entr(ies) into the warm KB for ${repoPath}`);
                        }
                    } catch (err) {
                        log(`[kb-prime] kb_import skipped for ${repoPath} (non-fatal): ${err.message}`);
                    }

                    const primeResult = parseResult(await callTool('kb_session_prime', { repo_path: repoPath, ...kbScope(remoteUrl) }));
                    const entries = (primeResult && Array.isArray(primeResult.top_entries))
                        ? primeResult.top_entries.filter((e) => e && typeof e.id === 'string')
                        : [];
                    if (entries.length > 0) knowledge.set(member, entries.slice(0, KB_MAX_KNOWLEDGE_ENTRIES));
                    primed++;
                } catch (err) {
                    log(`[kb-prime] failed for member '${member}' (non-fatal): ${err.message}`);
                    skipped++;
                }
            }
            if (primed > 0) log(`[kb-prime] primed ${primed} member repo(s)`);
            return { primed, skipped };
        },
    };
}

/**
 * apra-fleet-0ef / apra-fleet-nx7: the "KNOWLEDGE BANK -- promotion candidates"
 * block, shared verbatim by the per-round reviewer prompt and the Final Review
 * prompt.
 *
 * It lives in one function because the two prompts must state the SAME evidence
 * bar. Duplicating the text invites them to drift, and a drifted bar is
 * invisible: both sides would still "work", just to different standards, and the
 * only symptom would be inconsistent CONFIRMED quality months later.
 *
 * Returns a single-element array (or an empty one) so callers can spread it into
 * their prompt-section list.
 *
 * @param {object[]|undefined} kbCandidates
 * @returns {string[]}
 */
/**
 * KB audit 2026-08-11: the "KNOWLEDGE BANK -- what this repo already knows"
 * block, shared by the doer and reviewer dispatch prompts.
 *
 * WHY THIS EXISTS AT ALL. Every role contract's Step 0 tells the role to call
 * kb_session_prime itself. On a fleet-member dispatch it cannot: the member's
 * composed permission config disables the apra-fleet MCP server outright
 * (src/providers/claude.ts composePermissionConfig), so the tool is not merely
 * unlisted, it is unreachable. That is the same wall kb_promotions hit, and
 * this is the same fix -- the engine performs the read and hands the result
 * over as prompt content. Step 0 stays correct for the OTHER execution path
 * (an apra-pm orchestrator session running these contracts as local subagents,
 * where the MCP server is present), so both paths now get knowledge.
 *
 * The trust ladder is restated here rather than assumed: these entries are
 * agent-authored claims from earlier sprints, and CONFIRMED means a reviewer
 * verified the claim, not that it is currently true of this branch's tree.
 *
 * Returns a single-element array (or an empty one) so callers can spread it
 * into their prompt-section list, matching kbPromotionBlock.
 *
 * @param {object[]|undefined} entries
 * @returns {string[]}
 */
/**
 * Roles whose prompt BUILDER places the knowledge block itself, at a position
 * that carries meaning. Everything else receives it from the agent() wrapper.
 * Listing them here (rather than inside the wrapper) keeps the two halves of
 * that split visible from the block's own definition -- a role added to one
 * side and forgotten on the other either gets the block twice or never.
 */
export const KB_SELF_INJECTING_ROLES = Object.freeze(new Set([ROLE_DOER, ROLE_REVIEWER]));

/**
 * FTS terms for a dispatch's kb_query, drawn from what the engine already
 * holds: the beads being worked and their ids.
 *
 * Bead TITLES are the useful half -- they are prose about the change ("stop
 * collapsing unknown_zone into unbound_roi"), which is what matches an entry's
 * title/summary/content. Ids are included because a bead id occasionally
 * appears verbatim in a captured entry, and query() OR-joins its terms, so a
 * term that matches nothing costs a little ranking noise rather than filtering
 * the result to empty. Non-string and blank values are dropped so a partially
 * populated bead cannot produce a malformed query.
 *
 * @param {Array<{id?: string, title?: string}>} beads
 * @param {string[]} beadIds
 * @returns {string[]}
 */
export function kbQueryTerms(beads, beadIds) {
    const terms = [];
    for (const b of Array.isArray(beads) ? beads : []) {
        if (b && typeof b.title === 'string' && b.title.trim()) terms.push(b.title.trim());
    }
    for (const id of Array.isArray(beadIds) ? beadIds : []) {
        if (typeof id === 'string' && id.trim()) terms.push(id.trim());
    }
    return terms;
}

export function kbKnowledgeBlock(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    return [
        'KNOWLEDGE BANK -- what this repo already knows. These entries were captured and '
        + 'verified during earlier work on this repository, and are provided so you do not '
        + 'rediscover them the hard way. Read them BEFORE you start.\n'
        + 'CONFIRMED entries were independently verified by a reviewer: trust them. INFERRED '
        + 'entries are unverified hints: treat them as leads to check, not as facts. An entry '
        + 'describes the tree it was captured against, so if one contradicts what you actually '
        + 'observe in the code right now, the code wins -- say so in your notes rather than '
        + 'bending your work to fit the entry.\n'
        + 'You do not need to call any kb_* tool to read these. If you discover something '
        + 'non-obvious and durable while working, report it in the `kb_captures` field of your '
        + 'structured output and the orchestrator will record it.\n'
        + wrapUntrustedBlock('kb_session_prime --top_entries', JSON.stringify(
            entries.map((e) => ({
                confidence: e.confidence,
                title: e.title,
                summary: e.summary,
                source_files: e.source_files,
            })),
            null,
            2
        )),
    ];
}

export function kbPromotionBlock(kbCandidates) {
    if (!Array.isArray(kbCandidates) || kbCandidates.length === 0) return [];
    return [
        'KNOWLEDGE BANK -- promotion candidates. These entries were captured during this '
        + 'sprint and sit at INFERRED. You are the only role that can promote them to '
        + 'CONFIRMED. Do NOT call any kb_* tool yourself: return your decisions in the '
        + '`kb_promotions` field of your structured output as [{id, reason}] and the '
        + 'orchestrator executes them.\n'
        + 'Promote ONLY entries whose claim you independently verified during THIS review '
        + '-- by reading the diff, running the tests, or checking the cited files yourself. '
        + 'The `reason` must state that evidence (at least 20 characters, e.g. "verified '
        + 'against server/transit.js:88 and the reopen test"). Evidence, not plausibility: '
        + 'if an entry merely looks correct, leave it INFERRED -- that is a perfectly good '
        + 'resting state, and a wrong CONFIRMED entry is worse than no entry. Never '
        + 'blanket-promote, and never promote by module, tag or timestamp. Promoting '
        + 'nothing is a valid outcome; return [] in that case.\n'
        + wrapUntrustedBlock('kb_list --confidence INFERRED', JSON.stringify(
            kbCandidates.map((e) => ({
                id: e.id,
                title: e.title,
                summary: e.summary,
                source_files: e.source_files,
            })),
            null,
            2
        )),
    ];
}
