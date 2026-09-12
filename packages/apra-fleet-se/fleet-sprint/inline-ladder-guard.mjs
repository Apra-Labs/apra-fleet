import fs from 'fs';
import path from 'path';
import { guardedModulePaths } from './guarded-modules.mjs';
import { findCallSites } from './dispatch-safety-guard.mjs';
import { ROLE_POLICIES, migratedRoleNames } from './role-policies.mjs';

// =============================================================================
// apra-fleet-3swo.5.8 -- inline-ladder guard checker.
//
// WHY THIS EXISTS: the dispatchRole(ctx, roleName, opts) migration
// (apra-fleet-3swo.5.3/.5.6) moves each role's hand-written agent() dispatch
// ladder out of runner.js onto a shared engine driven by
// fleet-sprint/role-policies.mjs's data table. A migration is only real once
// the OLD inline ladder for that role is gone -- a migration that adds the
// dispatchRole call but forgets to delete the original agent() ladder would
// leave the role dispatching TWICE (or dispatching from whichever code path
// happens to run first) while every other guard and pin stays green, because
// none of them assert absence of an inline call once a role is marked done.
// This guard closes that hole: for every role role-policies.mjs marks
// `migrated: true`, it flags any surviving inline agent() call site that
// still routes to that role's member.
//
// STANDING RULE, same as dispatch-safety-guard.mjs/dolt-literal-guard.mjs/
// full-db-fetch-guard.mjs/shell-command-guard.mjs/unbracketed-push-guard.mjs:
// this guard takes its scanned-file list from the SHARED guarded-module list
// (./guarded-modules.mjs) and defines no private path array of its own -- a
// guard that does not consume that list is a guard whose coverage silently
// rots the moment a dispatch ladder moves into a newly extracted module.
//
// TODAY'S BASELINE: no role is marked migrated yet (role-policies.mjs's
// migratedRoleNames() returns []), so checkModules() reports zero violations
// against the current tree by construction -- there is nothing yet to flag.
// That green baseline is the floor the dispatchRole migration beads must
// keep green as they migrate roles one at a time.
//
// HOW A ROLE'S INLINE LADDER IS RECOGNISED: role-policies.mjs's `member`
// field already records, as data, the resolution kind and argument a role's
// dispatch routes to ('role' -> getMemberForRole(role), 'pool-head' -> a
// runner-local binding expression e.g. reviewerPool[0], 'runtime' -> a
// runner-local binding expression e.g. doerMember). memberExprFor() below
// rebuilds the exact source expression runner.js's ladders write for ALL
// THREE kinds: a 'role'-kind member becomes getMemberForRole(role); a
// 'pool-head'/'runtime'-kind member becomes its own recorded `binding`
// string verbatim (runner.js writes `member_name: reviewerPool[0]` /
// `member_name: doerMember` at its real call sites -- see doer and
// reviewer's real policy entries in role-policies.mjs). This matters because
// the two execution-role migration beads in this phase migrate doer
// (runtime member) and reviewer (pool-head member), not just role-kind
// roles -- a guard that only recognised 'role'-kind members would stay
// silently green for exactly those two roles' surviving inline ladders,
// which is the one failure mode this guard exists to prevent.
//
// MEMBER EXPRESSION ALONE IS NOT ROLE-UNIQUE (apra-fleet-3swo.24): three
// policies share roleMember('planner') (planner, scoped-replan-planner,
// streak-assignment) and two share roleMember('plan-reviewer') (plan-reviewer,
// scoped-replan-plan-reviewer). Neither agentType nor schema disambiguates
// them either. So memberExprFor()'s expression is only a coarse PRE-FILTER
// here: a call site is only reported once it ALSO contains that dispatch's
// `ladderAnchor` (role-policies.mjs) -- a literal substring unique to that
// dispatch's own real call site. A call site matching the member expression
// but not the anchor belongs to a sibling ladder and is never reported.
// =============================================================================

/**
 * The source expression a policy's `member` resolves to at its real inline
 * call site (see header): 'role' -> getMemberForRole(role); 'pool-head' and
 * 'runtime' -> the member's own recorded `binding` string verbatim (that is
 * exactly what runner.js's ladders write, e.g. `member_name: doerMember` /
 * `member_name: reviewerPool[0]`). Returns null for a missing/unrecognised
 * member or a 'pool-head'/'runtime' member with no binding recorded, so
 * callers can skip it rather than falsely matching on an unresolvable
 * expression.
 *
 * @param {{kind:string, role?:string, binding?:string}} member
 * @returns {string|null}
 */
export function memberExprFor(member) {
    if (!member) return null;
    if (member.kind === 'role') return `getMemberForRole('${member.role}')`;
    if (member.kind === 'pool-head' || member.kind === 'runtime') {
        return typeof member.binding === 'string' && member.binding.length > 0 ? member.binding : null;
    }
    return null;
}

/**
 * Scans `src` for `agent(` call sites whose call text still carries one of
 * `migratedRoles`' member-routing expressions AND that dispatch's
 * `ladderAnchor` -- an inline ladder that has not been removed even though
 * role-policies.mjs says this role's dispatch has moved onto the engine.
 *
 * The member expression alone is a coarse pre-filter, never the sole
 * discriminator (apra-fleet-3swo.24): several policies share the same
 * member-routing expression (see this file's header), so a site is only
 * reported once it ALSO contains the specific dispatch's ladderAnchor.
 *
 * @param {string} src
 * @param {string} fileLabel
 * @param {string[]} migratedRoles
 * @param {Record<string, object>} rolePolicies
 * @returns {string[]}
 */
export function findInlineLadderViolations(src, fileLabel, migratedRoles, rolePolicies) {
    if (migratedRoles.length === 0) return [];
    const agentSites = findCallSites(src).filter((s) => s.fnName === 'agent');
    if (agentSites.length === 0) return [];

    const violations = [];
    for (const role of migratedRoles) {
        const entry = rolePolicies[role];
        if (!entry) continue;
        // A role's main dispatch and its secondary (max-turns-resume /
        // semantic-repair-re-ask) each carry their OWN ladderAnchor (the two
        // are distinct real call sites in runner.js), so pair each dispatch's
        // member expression with its own anchor rather than pooling all
        // exprs together -- pooling would let one dispatch's anchor match
        // against a site that only satisfies a DIFFERENT dispatch's member
        // expression. De-duplicate identical (expr, anchor) pairs so a
        // dispatch variant that happens to repeat both is never matched
        // twice.
        const pairs = new Set();
        for (const dispatch of [entry, entry.secondary]) {
            if (!dispatch) continue;
            const expr = memberExprFor(dispatch.member);
            if (!expr) continue;
            if (typeof dispatch.ladderAnchor !== 'string' || dispatch.ladderAnchor.length === 0) {
                throw new Error(
                    `inline-ladder-guard: role '${role}' has no non-empty ladderAnchor -- every dispatch role-policies.mjs ` +
                    'can mark migrated must carry a unique ladder anchor so this guard can tell sibling ladders apart.'
                );
            }
            pairs.add(JSON.stringify([expr, dispatch.ladderAnchor]));
        }
        // One real call site must never be reported twice for the same role,
        // even if (implausibly) more than one (expr, anchor) pair matched it.
        const reportedSites = new Set();
        for (const pairKey of pairs) {
            const [expr, anchor] = JSON.parse(pairKey);
            for (const site of agentSites) {
                if (reportedSites.has(site)) continue;
                if (site.callText.includes(expr) && site.callText.includes(anchor)) {
                    reportedSites.add(site);
                    // NOTE: deliberately spelled with a space before the
                    // opening paren ("agent (") rather than "agent(" -- the
                    // latter is the literal substring dispatch-safety-guard's
                    // findCallSites() (which this module itself is built on)
                    // treats as a real call site, and this file is itself a
                    // GUARDED_MODULES entry.
                    violations.push(
                        `${fileLabel}:${site.line} (fnName=${site.fnName}) still dispatches role '${role}' ` +
                        `inline via a raw agent () call -- role-policies.mjs marks '${role}' migrated, so ` +
                        'this ladder must route through dispatchRole() instead.'
                    );
                }
            }
        }
    }
    return violations;
}

/**
 * Aggregate entry point, mirroring dispatch-safety-guard.mjs's
 * checkModules(): scans every module in `paths` (default: the shared
 * guarded-module list) for a surviving inline agent() ladder belonging to a
 * role `rolePolicies` marks migrated (default: role-policies.mjs's real
 * table, via migratedRoleNames()).
 *
 * @param {{paths?: string[], migratedRoles?: string[], rolePolicies?: Record<string, object>}} [opts]
 * @returns {{ violations: string[], files: string[] }}
 */
export function checkModules({
    paths = guardedModulePaths(),
    migratedRoles = migratedRoleNames(),
    rolePolicies = ROLE_POLICIES,
} = {}) {
    if (!Array.isArray(paths)) {
        throw new TypeError('checkModules(opts): opts.paths must be an array of file paths');
    }
    const violations = [];
    const files = [];
    for (const p of paths) {
        const file = path.basename(p);
        files.push(file);
        const src = fs.readFileSync(p, 'utf8');
        violations.push(...findInlineLadderViolations(src, file, migratedRoles, rolePolicies));
    }
    return { violations, files };
}
