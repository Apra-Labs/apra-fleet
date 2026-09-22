#!/usr/bin/env node
// =============================================================================
// integration-gate-status.mjs -- read-only status feed for the fleet-integrator
// merge gate (fleet-sprint/skills/fleet-integrator/SKILL.md). Lists candidate
// PRs into a configured integration branch, one JSON object per line, each
// carrying a computed `decision` (merge/repair/wait/skip) and `reason`.
//
// This script NEVER merges, NEVER mutates anything, and NEVER pushes -- it is
// read-only by design (the skill's loop reads its output and performs the
// actual `gh pr merge` / repair-prompt actions itself). See design ref:
// pipeline 2.4 (merge gate conflict policy).
//
// USAGE:
//   node scripts/integration-gate-status.mjs \
//     --repo <owner>/<repo> \
//     --base <integration-branch> \
//     --title-prefix "<prefix>" \
//     --required-checks <check-1>,<check-2>,... \
//     [--gh <path-to-gh-binary>] \
//     [--input <file>]   # offline mode: read the same JSON `gh pr list` would
//                         # produce from a file instead of shelling out to gh
//
// Exit codes: 0 on success (including zero open PRs -- empty output is not an
// error); 1 on invalid arguments or a gh failure.
//
// ASCII only.
// =============================================================================

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const GH_JSON_FIELDS =
    'number,title,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,statusCheckRollup';

// Check-run/status-context states that mean "still running" -- a PR with any
// required check in one of these states is not ready to merge or fail yet.
const PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED']);

// Check-run conclusions / status-context states that mean "this check failed
// outright" -- distinct from PENDING_STATES (still running) and SUCCESS.
const FAILED_STATES = new Set([
    'FAILURE',
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
]);

/**
 * Read a single required check's terminal state out of gh's
 * statusCheckRollup entry shape. A CheckRun reports `conclusion` (only set
 * once terminal; null/undefined while running) and a StatusContext reports
 * `state` directly. Returns one of: 'SUCCESS', a FAILED_STATES member, a
 * PENDING_STATES member, or null if genuinely unrecognized (treated as
 * pending -- never assume success on an unknown shape).
 */
function checkState(entry) {
    if (entry.conclusion) return entry.conclusion;
    if (entry.state) return entry.state;
    // A CheckRun with no conclusion yet is still running.
    return 'IN_PROGRESS';
}

/**
 * Pure decision function -- no gh, no I/O. Exported so tests exercise the
 * policy directly against fixture PR objects.
 *
 * @param {object} pr matches one element of `gh pr list --json <GH_JSON_FIELDS>`
 * @param {{titlePrefix: string, requiredChecks: string[]}} opts
 * @returns {{decision: 'merge'|'repair'|'wait'|'skip', reason: string}}
 */
export function decideForPr(pr, { titlePrefix, requiredChecks }) {
    const title = pr.title || '';

    if (pr.isDraft) {
        return { decision: 'skip', reason: 'draft-pr' };
    }
    // [FAIL]/[ABORTED] are checked ahead of the prefix test: a FAIL- or
    // ABORTED-verdict PR title never carries the PASS prefix in the first
    // place (they are distinct engine verdict prefixes), so checking prefix
    // first would report the less useful 'missing-title-prefix' reason for
    // exactly the PRs this gate most needs to explain clearly to the owner.
    if (title.includes('[FAIL]')) {
        return { decision: 'skip', reason: 'title-fail' };
    }
    if (title.includes('[ABORTED]')) {
        return { decision: 'skip', reason: 'title-aborted' };
    }
    if (!title.startsWith(titlePrefix)) {
        return { decision: 'skip', reason: 'missing-title-prefix' };
    }

    // DIRTY takes priority over check state: a PR that cannot merge at all
    // needs the repair prompt regardless of what its checks say.
    if (pr.mergeStateStatus === 'DIRTY') {
        return { decision: 'repair', reason: 'merge-state-dirty' };
    }

    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    const byName = new Map(rollup.map((entry) => [entry.name || entry.context, entry]));

    const missing = [];
    const pending = [];
    const failed = [];
    for (const name of requiredChecks) {
        const entry = byName.get(name);
        if (!entry) {
            missing.push(name);
            continue;
        }
        const state = checkState(entry);
        if (state === 'SUCCESS') continue;
        if (FAILED_STATES.has(state)) failed.push(name);
        else pending.push(name); // PENDING_STATES member, or an unrecognized state -- treated as pending
    }

    if (failed.length > 0) {
        return { decision: 'skip', reason: `checks-failed: ${failed.join(',')}` };
    }
    if (missing.length > 0) {
        return { decision: 'wait', reason: `checks-missing: ${missing.join(',')}` };
    }
    if (pending.length > 0) {
        return { decision: 'wait', reason: `checks-pending: ${pending.join(',')}` };
    }

    // BEHIND is mergeable under squash with the ruleset (assumption stated
    // per this lane's design ref: the ruleset does not require the head to
    // be up to date before a squash merge) -- treat it the same as CLEAN.
    if (pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'BEHIND') {
        return { decision: 'merge', reason: `merge-state-${pr.mergeStateStatus.toLowerCase()}` };
    }

    // UNKNOWN, BLOCKED, UNSTABLE, or anything else undocumented -- wait, and
    // say exactly what raw status drove that so an operator can look it up.
    return { decision: 'wait', reason: `merge-state-${String(pr.mergeStateStatus).toLowerCase()}` };
}

function summarizeChecks(pr, requiredChecks) {
    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    const byName = new Map(rollup.map((entry) => [entry.name || entry.context, entry]));
    const success = [];
    const pendingList = [];
    const failedList = [];
    for (const name of requiredChecks) {
        const entry = byName.get(name);
        if (!entry) continue;
        const state = checkState(entry);
        if (state === 'SUCCESS') success.push(name);
        else if (FAILED_STATES.has(state)) failedList.push(name);
        else pendingList.push(name);
    }
    return { required: requiredChecks, success, pending: pendingList, failed: failedList };
}

// The CLI's accepted --flags. Exported so a consumer (the fleet-integrator
// SKILL.md genericness test) can assert every flag the skill shows for this
// script is actually accepted here, instead of hand-duplicating the list.
export const CLI_OPTION_SPECS = {
    repo: { type: 'string' },
    base: { type: 'string' },
    'title-prefix': { type: 'string' },
    'required-checks': { type: 'string' },
    gh: { type: 'string', default: 'gh' },
    input: { type: 'string' },
};

function parseCliArgs(argv) {
    const { values } = parseArgs({ args: argv, options: CLI_OPTION_SPECS });
    return values;
}

function fetchPrList({ repo, base, gh, input }) {
    if (input) {
        return JSON.parse(readFileSync(input, 'utf8'));
    }
    const result = spawnSync(
        gh,
        ['pr', 'list', '--repo', repo, '--base', base, '--state', 'open', '--limit', '100', '--json', GH_JSON_FIELDS],
        { encoding: 'utf8' },
    );
    if (result.status !== 0) {
        throw new Error(`gh pr list failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout);
}

export async function main(argv) {
    const args = parseCliArgs(argv);
    if (!args.repo || !args.base || !args['title-prefix'] || !args['required-checks']) {
        console.error(
            'Usage: integration-gate-status.mjs --repo <owner>/<repo> --base <branch> --title-prefix <prefix> --required-checks <c1,c2,...> [--gh <path>] [--input <file>]',
        );
        return 1;
    }
    const requiredChecks = args['required-checks'].split(',').map((s) => s.trim()).filter(Boolean);
    const titlePrefix = args['title-prefix'];

    let prs;
    try {
        prs = fetchPrList({ repo: args.repo, base: args.base, gh: args.gh, input: args.input });
    } catch (err) {
        console.error(String(err.message || err));
        return 1;
    }

    for (const pr of prs) {
        const { decision, reason } = decideForPr(pr, { titlePrefix, requiredChecks });
        const line = {
            number: pr.number,
            title: pr.title,
            headRefName: pr.headRefName,
            headRefOid: pr.headRefOid,
            decision,
            reason,
            checks: summarizeChecks(pr, requiredChecks),
        };
        console.log(JSON.stringify(line));
    }
    return 0;
}

// Main-module guard. On win32 process.argv[1] is a backslash drive path
// (D:\a\...\integration-gate-status.mjs) while import.meta.url is
// file:///D:/a/..., so a template-literal `file://` + argv[1] comparison never
// matches there and main() silently never runs (exit 0, no output). Normalise
// through pathToFileURL -- the same form bin/serve.mjs and bin/cli.mjs use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).then((code) => process.exit(code));
}
