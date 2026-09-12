import path from 'path';
import { fileURLToPath } from 'url';

// =============================================================================
// SHARED GUARDED-MODULE LIST -- the single place a newly extracted fleet-sprint
// module is registered for mechanical guard coverage.
//
// WHY THIS EXISTS: every mechanical guard in this directory
// (dispatch-safety-guard.mjs, dolt-literal-guard.mjs, full-db-fetch-guard.mjs,
// shell-command-guard.mjs, unbracketed-push-guard.mjs) was originally pointed
// at ONE hard-coded file -- runner.js -- by each of its own tests. runner.js
// is being decomposed into smaller modules; under the old wiring, the moment
// a guarded construct moved out of runner.js into a newly extracted module,
// EVERY guard silently stopped covering it while continuing to report a green
// baseline. That is the exact failure mode this list prevents: extract a
// module, add ONE line here, and all five guards pick it up at once.
//
// REGISTERING A NEWLY EXTRACTED MODULE: add its filename to GUARDED_MODULES
// below. Do not add a second list anywhere else, and do not re-point an
// individual guard at its own private array of paths -- a guard that does not
// consume this list is a guard whose coverage silently rots.
//
// STANDING RULE (from apra-fleet-3swo.8): registering a newly extracted module
// is part of the extraction bead itself, not a follow-up bead. guarded-modules.mjs
// and the guard test files that consume it (dispatch-safety-guard.test.mjs,
// dolt-literal-guard.test.mjs, full-db-fetch-tripwire.test.mjs,
// guarded-modules-coverage.test.mjs, pause-guard-push-holes.test.mjs) are a
// single mutex resource; any future bead that adds a line here MUST belong to
// the same streak as, or run after, whatever else is editing them.
//
// NESTED ENTRIES ARE LEGAL (first used by apra-fleet-3swo.6.2's phases/*
// modules): guardedModulePath() path.joins a 'dir/file.mjs' entry, so it
// resolves and scans exactly like a flat one. What differs is REPORTING --
// every guard labels a scanned file by path.basename() -- so a baseline that
// compares a guard's `files` output must use guardedModuleBasenames(), never
// GUARDED_MODULES verbatim. Note the COMPLETENESS check in
// guarded-modules-coverage.test.mjs deliberately compares FULL RELATIVE PATHS
// instead, so a nested module can never ride on an unrelated entry that
// merely shares its bare filename.
//
// WHAT DOES *NOT* BELONG HERE: the per-shell command builders --
// se-posix.mjs, se-windows.mjs, se-windows-gitbash.mjs, se-os-commands.mjs and
// dolt-settle.mjs. They deliberately emit `$HOME`, `$env:USERPROFILE`,
// `$env:TEMP` and `$( )` because they ARE the OS-branched command surface the
// shell-command invariant tells everyone else to route through; scanning them
// would report their entire reason for existing as violations. Likewise
// dolt-sync.mjs, which legitimately builds the `bd dolt pull`/`bd dolt push`
// command strings (see DOLT_LITERAL_EXEMPT below and dolt-literal-guard.mjs's
// own header).
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Filenames (relative to this directory) of every fleet-sprint module the
 * mechanical guards must scan. Add a newly extracted module here -- this is
 * the single registration point.
 */
export const GUARDED_MODULES = [
    'runner.js',
    'vcs-auth.mjs',
    'mcp-result.mjs',
    'member-target.mjs',
    'abort.mjs',
    'branch-ensure.mjs',
    'prompts.mjs',
    'worklists.mjs',
    'sprint-args.mjs',
    'git-sync.mjs',
    'coordination.mjs',
    'kb.mjs',
    'beads-scope.mjs',
    'beads-transitions.mjs',
    'role-policies.mjs',
    'inline-ladder-guard.mjs',
    // apra-fleet-3swo.5.3: the dispatchRole engine. It hosts the ONE real
    // agent() dispatch every migrated role ladder now runs through, so it
    // must be scanned by dispatch-safety-guard (member_name at the call
    // site) exactly like the runner.js ladders it replaces.
    'dispatch-role.mjs',
    // apra-fleet-3swo.6.1: the per-sprint resolved state (the sprint-scoped
    // fleet client every settle-shell resolution shares, plus the relocated
    // per-member VCS provider resolver). It builds no member-bound command
    // string today, but it is the module every future phase module asks for
    // the member's resolved shell -- exactly the input the shell-command
    // invariant is about -- so it is registered from the start rather than
    // retrofitted later.
    'sprint-state.mjs',
    // apra-fleet-3swo.6.2: the first two phase modules sliced out of
    // runSprintCycle. These are the first NESTED entries in this list --
    // guardedModulePath() path.joins them, so they resolve and scan
    // correctly, but every guard labels a scanned file by path.basename(),
    // so they are always REPORTED as 'ensure-sprint-branch.mjs' and
    // 'plan.mjs'. Any baseline assertion must therefore compare against
    // guardedModuleBasenames() rather than GUARDED_MODULES verbatim (see
    // that function's doc comment below).
    //
    // ensure-sprint-branch.mjs took EIGHT member_name-bearing command() call
    // sites out of runner.js (now TEN -- see the POST-EXTRACTION FIX note in
    // that file's header for the two diagnostic-only tip-SHA probes added by
    // apra-fleet-3swo's fleet-mac regression investigation) and plan.mjs took
    // THREE, which is exactly why both are registered as part of the
    // extraction rather than afterwards: guarded dispatch sites would
    // otherwise leave runner.js's scanned surface and land in files no guard
    // reads, with every guard still green.
    'phases/ensure-sprint-branch.mjs',
    'phases/plan.mjs',
    // apra-fleet-3swo.6.7: the next two phase modules sliced out of
    // runSprintCycle, both from INSIDE its Develop/Review round loop. Same
    // nested-entry reporting caveat as the pair above (they are always
    // REPORTED as 'replan.mjs' and 'develop.mjs'), so the same rule applies:
    // compare a guard's `files` output against guardedModuleBasenames().
    //
    // Neither took a command() call site out of runner.js -- replan.mjs's only
    // repo-side effect is a shared gitSync bracket, and develop.mjs reaches bd
    // exclusively through runner-exported helpers it is handed -- but each
    // took TWO dispatchRole() call sites (the scoped planner + scoped
    // plan-reviewer, and the streak-assignment + doer ladders). Those are
    // exactly what dispatch-safety-guard and the phase 3 dispatch census read,
    // so registering them as part of the extraction is what keeps the census
    // whole instead of quietly shrinking runner.js's scanned surface.
    'phases/replan.mjs',
    'phases/develop.mjs',
    // apra-fleet-3swo.6.5: the per-round Review and the per-cycle Deploy
    // phases. Same nested-entry reporting caveat as the four above (they are
    // always REPORTED as 'review.mjs' and 'deploy.mjs'), so the same rule
    // applies: compare a guard's `files` output against
    // guardedModuleBasenames().
    //
    // review.mjs took ONE member_name-bearing command() call site out of
    // runner.js (the `bd show <ids> --json` acceptance-criteria read) and NO
    // dispatchRole site -- the reviewer ladder runs through runner.js's
    // dispatchReview() helper, which the Re-Review and Final Review phases
    // share, so it stayed there. deploy.mjs took no command() site but ONE
    // dispatchRole site (the deployer ladder). Registering both as part of the
    // extraction is what keeps the guarded command census and the phase 3
    // dispatch census whole instead of quietly shrinking runner.js's scanned
    // surface.
    'phases/review.mjs',
    'phases/deploy.mjs',
    // apra-fleet-3swo.6.8: the per-cycle Integ Test and the Re-Review that
    // Cycle Evaluation dispatches when the goal-priority count reads 0 but no
    // review ran this cycle. Same nested-entry reporting caveat as the six
    // above (they are always REPORTED as 'integ-test.mjs' and
    // 're-review.mjs'), so the same rule applies: compare a guard's `files`
    // output against guardedModuleBasenames().
    //
    // integ-test.mjs took TWO member_name-bearing command() call sites out of
    // runner.js -- the verify-fail bounce cap's `bd show <bugId> --json` parent
    // lookup and its `bd update <parentId> --status=deferred --append-notes`
    // deferral -- plus ONE dispatchRole site (the integ-test-runner ladder).
    // re-review.mjs took NEITHER: its reopen/newTask writes go through
    // applyGuardedReopens (beads-transitions.mjs) and
    // createChildBeadWithAllocatedId/computeChildFloor, whose command() sites
    // live in the modules that own them, and the reviewer ladder runs through
    // runner.js's shared dispatchReview() helper, which Final Review still
    // calls. Registering both as part of the extraction is what keeps the
    // guarded command census and the phase 3 dispatch census whole instead of
    // quietly shrinking runner.js's scanned surface.
    'phases/integ-test.mjs',
    'phases/re-review.mjs',
    // apra-fleet-3swo.6.6: the sprint's closing Final Review and the
    // once-per-sprint Regression Test. Same nested-entry reporting caveat as
    // the eight above (they are always REPORTED as 'final-review.mjs' and
    // 'regression-test.mjs'), so the same rule applies: compare a guard's
    // `files` output against guardedModuleBasenames().
    //
    // NEITHER took a member_name-bearing command() call site out of runner.js
    // -- final-review.mjs reads beads through the injected bdListScoped and
    // writes them through applyGuardedReopens (beads-transitions.mjs) and
    // computeChildFloor/createChildBeadWithAllocatedId, whose command() sites
    // live in the modules that own them, and regression-test.mjs issues no
    // bd/git command at all (its carry-over beads are filed by the DISPATCHED
    // runner inside its own repo). Each took exactly ONE dispatchRole() site
    // (the final-review and regression-test-runner ladders), which is what
    // dispatch-safety-guard and the phase 3 dispatch census read.
    // final-review.mjs additionally owns a real gitSync bracket at each end,
    // including the findings D-push that apra-fleet-3swo.4.1 brought inside a
    // bracket -- registering it here is what keeps unbracketed-push-guard
    // covering that push instead of silently losing it.
    'phases/final-review.mjs',
    'phases/regression-test.mjs',
    // apra-fleet-3swo.6.9: the LAST two phase modules -- Harvest and Publish
    // PR -- which complete the runSprintCycle slice. Same nested-entry
    // reporting caveat as the ten above (they are always REPORTED as
    // 'harvest.mjs' and 'publish-pr.mjs'), so the same rule applies: compare a
    // guard's `files` output against guardedModuleBasenames().
    //
    // harvest.mjs took NO member_name-bearing command() call site out of
    // runner.js -- the docs/changelog/sprint-analysis commits are made by the
    // DISPATCHED harvester inside its own repo and published by the 'harvester'
    // policy row's pushCode/pushBeads bracket -- but it took ONE dispatchRole()
    // site (the harvester ladder), which is what dispatch-safety-guard and the
    // phase 3 dispatch census read.
    //
    // publish-pr.mjs is the opposite shape and the more urgent of the two to
    // register: it took TWO member_name-bearing command() call sites out of
    // runner.js (the `git remote get-url origin` capability probe on the
    // git-capable publish member, and the per-target-issue `bd close` on the
    // orchestrator for a remote that can never open a PR) and NO dispatchRole
    // site, AND it owns the sprint branch's own push --
    // gitSync.pushGitAfter(), the bracketed entry point apra-fleet-3swo.4.1
    // put that push behind. Registering it here is what keeps
    // unbracketed-push-guard covering that push instead of silently losing the
    // one site the guard exists for.
    'phases/harvest.mjs',
    'phases/publish-pr.mjs',
    // apra-fleet-3swo.6.3: the git-topology layer sliced out of runner.js --
    // the pre-sprint multi-member topology precondition (checkMemberTopology),
    // the ONE git-failure classifier (classifyGitFailure) and the fail-closed
    // provider lookup that feeds it, the retrying git-command primitive every
    // sync bracket issues its commands through (runGitStep), and the
    // exit-code-based soft-git result adapter (commandResultToSoftGit).
    //
    // It took exactly ONE member_name-bearing command() call site out of
    // runner.js -- runGitStep's single `command(cmd, { member_name: member,
    // silent: true, failSoft: true, label })` dispatch, which EVERY bracketed
    // git command in this package funnels through (syncMemberBefore/After/
    // AfterOrdered here, detectAndAbortRebaseConflict in conflict-ladder.mjs,
    // and abort.mjs's three finalize-path git calls). That makes it the single
    // highest-traffic guarded dispatch site in fleet-sprint, so registering it
    // with the extraction is what keeps dispatch-safety-guard covering it
    // instead of silently losing it the moment it left runner.js.
    'git-topology.mjs',
    // apra-fleet-3swo.6.10: the per-member git sync BRACKETS that sit on top of
    // git-topology.mjs -- syncMemberBefore (G-pull), syncMemberAfter (G-push
    // plus its bounded pull-rebase retry and Tier 2 conflict dispatch),
    // syncMemberAfterOrdered (the ordered G-push-then-D-push post-dispatch
    // step) and resyncReacquiredMember (the resume path's re-reconciliation).
    //
    // It took exactly ONE member_name-bearing command() call site out of
    // runner.js -- syncMemberAfter's `command('git status --porcelain', {
    // member_name: member, ... })` clean-state read, the mechanical re-check
    // that decides whether a Tier 2 conflict-resolution dispatch really
    // resolved anything. The other three brackets issue every git command
    // through git-topology.mjs's runGitStep, and resyncReacquiredMember runs
    // entirely on injected runners, so none of them adds a site here.
    //
    // Registering it with the extraction is load-bearing TWICE over, and the
    // second reason is the subtle one: unbracketed-push-guard.mjs resolves its
    // sanctioned-wrapper ranges (syncMemberAfterOrdered, verifyDoerStreakClosed)
    // BY NAME WITHIN EACH SCANNED FILE. syncMemberAfterOrdered's bare
    // syncMemberAfter() and DoltSync.syncAfter() calls are sanctioned only
    // because the wrapper declaring them travelled here with them -- so this
    // file must be scanned for that sanction to mean anything, and a future
    // bare primitive added here outside that wrapper must still go red.
    'member-sync.mjs',
    // apra-fleet-3swo.25: the remaining fleet-sprint modules that scan clean
    // (zero violations) across all five guards. Registered together so the
    // completeness test (guarded-modules-coverage.test.mjs) has nothing left
    // unaccounted for besides GUARD_REGISTRATION_EXEMPT below.
    'conflict-ladder.mjs',
    'contracts.mjs',
    'dispatch-safety-guard.mjs',
    'errors.mjs',
    'full-db-fetch-guard.mjs',
    'shell-command-guard.mjs',
    'sprint-lock.mjs',
    'sprint-progress.mjs',
    'unbracketed-push-guard.mjs',
    'vcs-module.mjs',
    'viewer-extensions.mjs',
    'vcs-providers/azure-devops.mjs',
    'vcs-providers/bitbucket.mjs',
    'vcs-providers/dolt.mjs',
    'vcs-providers/generic-git.mjs',
    'vcs-providers/github.mjs',
    'vcs-providers/index.mjs',
    'vcs-providers/shell-helpers.mjs',
];

/**
 * Modules the dolt-literal guard must NEVER scan, by basename. dolt-sync.mjs
 * is the single permitted dolt command surface: it builds the literal
 * `bd dolt pull` / `bd dolt push` strings on purpose (apra-fleet-417.2.1/
 * 417.2.2), so pointing the dolt-literal guard at it would flag the sync
 * module for being the sync module. Documented verbatim in
 * dolt-literal-guard.mjs's header; enforced here so the exemption survives
 * anyone adding dolt-sync.mjs to GUARDED_MODULES (or passing it explicitly).
 */
export const DOLT_LITERAL_EXEMPT = ['dolt-sync.mjs'];

/**
 * Modules the unbracketed-push guard (unbracketed-push-guard.mjs) must NEVER
 * scan, by basename. git-sync.mjs is the single module allowed to call the
 * raw doltPushAfter()/syncMemberAfter()/DoltSync.syncBefore()/
 * DoltSync.syncAfter() primitives directly: that IS the bracketed-entry-point
 * implementation the guard exists to protect (apra-fleet-3swo.4.1/.4.2), so
 * pointing the guard at git-sync.mjs itself would flag the module for being
 * the module. Mirrors DOLT_LITERAL_EXEMPT's precedent for dolt-sync.mjs
 * above.
 */
export const UNBRACKETED_PUSH_EXEMPT = ['git-sync.mjs'];

/**
 * apra-fleet-3swo.25: modules deliberately excluded from GUARDED_MODULES
 * ENTIRELY -- never registered, never scanned by any of the five guards --
 * keyed by filename (relative to this directory, same convention as
 * GUARDED_MODULES) with a non-empty written reason as the value.
 *
 * This is a DIFFERENT kind of exemption than DOLT_LITERAL_EXEMPT/
 * UNBRACKETED_PUSH_EXEMPT above: those two keep a module registered and
 * scanned by the other four guards, filtering it out of ONE guard only. An
 * entry here is not registered at all, because scanning it with ANY guard
 * would report the module's entire reason for existing (or the guard's own
 * detection logic) as a violation of itself.
 * guarded-modules-coverage.test.mjs asserts every *.mjs/*.js file found by a
 * RECURSIVE walk of this directory is present in either GUARDED_MODULES or
 * this map -- so a module can no longer silently fall through both lists.
 */
export const GUARD_REGISTRATION_EXEMPT = {
    // The five shell builders -- reasons reused verbatim from this file's own
    // "WHAT DOES NOT BELONG HERE" header above (do not re-derive them).
    'se-posix.mjs':
        'deliberately emits `$HOME`, `$env:USERPROFILE`, `$env:TEMP` and `$( )` because it IS the ' +
        'OS-branched command surface the shell-command invariant tells everyone else to route ' +
        'through; scanning it would report its entire reason for existing as violations.',
    'se-windows.mjs':
        'deliberately emits `$HOME`, `$env:USERPROFILE`, `$env:TEMP` and `$( )` because it IS the ' +
        'OS-branched command surface the shell-command invariant tells everyone else to route ' +
        'through; scanning it would report its entire reason for existing as violations.',
    'se-windows-gitbash.mjs':
        'deliberately emits `$HOME`, `$env:USERPROFILE`, `$env:TEMP` and `$( )` because it IS the ' +
        'OS-branched command surface the shell-command invariant tells everyone else to route ' +
        'through; scanning it would report its entire reason for existing as violations.',
    'se-os-commands.mjs':
        'deliberately emits `$HOME`, `$env:USERPROFILE`, `$env:TEMP` and `$( )` because it IS the ' +
        'OS-branched command surface the shell-command invariant tells everyone else to route ' +
        'through; scanning it would report its entire reason for existing as violations.',
    'dolt-settle.mjs':
        'deliberately emits `$HOME`, `$env:USERPROFILE`, `$env:TEMP` and `$( )` because it IS the ' +
        'OS-branched command surface the shell-command invariant tells everyone else to route ' +
        'through; scanning it would report its entire reason for existing as violations.',
    // dolt-sync.mjs -- reason reused verbatim from the same header (do not
    // re-derive it).
    'dolt-sync.mjs':
        'legitimately builds the `bd dolt pull`/`bd dolt push` command strings (see ' +
        'DOLT_LITERAL_EXEMPT above and dolt-literal-guard.mjs\'s own header).',

    // apra-fleet-3swo.25: dolt-literal-guard.mjs -- confirmed guard-detection
    // false positive. dolt-literal-guard.mjs has no per-line suppression
    // mechanism (unlike shell-command-guard.mjs's shell-guard-allow
    // directive, used instead for the other siblings this bead registers --
    // see contracts.mjs, vcs-module.mjs and vcs-providers/{index,shell-
    // helpers}.mjs, all now registered above with per-line allow comments),
    // so this one file is exempted here rather than registered.
    'dolt-literal-guard.mjs':
        'dolt-literal-guard\'s own violation-message text builds the literal phrase \'bd dolt pull\'/' +
        '\'bd dolt push\' to describe what it detects, which the guard then flags as a ' +
        'self-referential violation of its own implementation, and the guard has no per-line ' +
        'suppression mechanism (unlike shell-command-guard.mjs) to carve out just that one line.',
    // guarded-modules.mjs itself: this map's own reason strings (and the
    // shell-builder header above) necessarily QUOTE the shell-syntax
    // substrings ($HOME, $(, ~/, 'bd dolt pull'/'bd dolt push', etc.) they
    // describe, in real JS string literals -- which the dolt-literal and
    // shell-command guards' naive text-matching then flags as this file
    // issuing/emitting those constructs itself. Same self-referential class
    // of false positive as dolt-literal-guard.mjs and shell-command-guard.mjs
    // above (confirmed by scanning this file with GUARD_REGISTRATION_EXEMPT
    // populated), not a real dispatched command or shell expansion.
    'guarded-modules.mjs':
        'this map\'s own reason strings (and the header above) necessarily quote the shell-syntax ' +
        'and dolt-command substrings they describe, in real JS string literals, which the ' +
        'dolt-literal and shell-command guards then flag as this file issuing/emitting those ' +
        'constructs itself -- the same self-referential false positive as dolt-literal-guard.mjs ' +
        'and shell-command-guard.mjs above.',
};

/** Absolute path to a fleet-sprint module by filename. */
export function guardedModulePath(fileName) {
    return path.join(__dirname, fileName);
}

/**
 * Absolute paths of every registered guarded module, plus any `extraPaths`
 * the caller appends (tests pass a throwaway fixture module this way, proving
 * the list is what the guards actually read rather than a hard-coded name).
 */
export function guardedModulePaths(extraPaths = []) {
    if (!Array.isArray(extraPaths)) {
        throw new TypeError('guardedModulePaths(extraPaths): extraPaths must be an array of file paths');
    }
    return [...GUARDED_MODULES.map(guardedModulePath), ...extraPaths];
}

/**
 * Basenames of every registered guarded module, plus any `extraPaths`'
 * basenames appended -- same `extraPaths` contract as guardedModulePaths().
 *
 * apra-fleet-3swo.14: every guard's aggregate entry point (checkModules(),
 * checkDoltLiteralModules(), checkFullDbFetchModules(), checkShellCommandPaths())
 * labels each scanned file by `path.basename(p)`, both in its `files` return
 * value and in every violation string it emits -- so a nested GUARDED_MODULES
 * entry (e.g. 'phases/plan.mjs', legal per guardedModulePath()'s path.join)
 * resolves and scans correctly but is always reported as just 'plan.mjs'.
 * Comparing a guard's `files` output against GUARDED_MODULES verbatim only
 * holds while every entry is a bare filename with no directory component.
 * Baseline tests must compare against THIS function's output instead of
 * GUARDED_MODULES directly.
 */
export function guardedModuleBasenames(extraPaths = []) {
    return guardedModulePaths(extraPaths).map((p) => path.basename(p));
}

/**
 * The guarded-module list as the dolt-literal guard must see it: the shared
 * list with DOLT_LITERAL_EXEMPT basenames filtered out. Takes the same
 * `extraPaths` as guardedModulePaths so the exemption applies to caller-
 * supplied paths too -- a fixture literally named dolt-sync.mjs is exempt,
 * while byte-identical content under any other name is not.
 */
export function doltLiteralModulePaths(extraPaths = []) {
    return guardedModulePaths(extraPaths).filter((p) => !DOLT_LITERAL_EXEMPT.includes(path.basename(p)));
}

/**
 * The guarded-module list as the unbracketed-push guard must see it: the
 * shared list with UNBRACKETED_PUSH_EXEMPT basenames filtered out. Same
 * `extraPaths` contract as guardedModulePaths/doltLiteralModulePaths.
 */
export function unbracketedPushModulePaths(extraPaths = []) {
    return guardedModulePaths(extraPaths).filter((p) => !UNBRACKETED_PUSH_EXEMPT.includes(path.basename(p)));
}
