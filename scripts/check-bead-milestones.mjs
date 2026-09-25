#!/usr/bin/env node
// STANDALONE, OPT-IN OPERATOR TOOL. Milestones are not a fleet-sprint concept
// yet: the milestone:* bead labels are an ad-hoc local convention until a
// formal milestone model exists. Do not wire this script into any sprint
// phase, git hook, agent prompt or CI job.
//
// Convention it checks: every non-closed bead carries EXACTLY ONE label
//   milestone:v0.4.3 | milestone:v0.4.4 | milestone:v0.5 | milestone:v0.5.1 | milestone:backlog
// (backlog = deliberately unscheduled). Children created with
// `bd create --parent` inherit the epic's labels; override by swapping the
// label on the child. Legacy informal labels (`v0.4.3`, `v05`) do not count.
// It reads the beads DB via `bd export` (or a JSONL file) and lists violations.
//
// Usage:
//   node scripts/check-bead-milestones.mjs [--file <export.jsonl>]
//        [--assignee <name>]... [--known <m1,m2,...>] [--json]
//
//   --file      read a `bd export` JSONL file instead of running `bd export`
//   --assignee  restrict to unassigned beads plus beads assigned to <name>
//               (repeatable). Default: every non-closed bead.
//   --known     comma-separated milestone names that count as valid
//               (default: KNOWN_MILESTONES below; override when a release is added)
//   --json      print violations as JSON
//
// Exit codes:
//   0  every in-scope non-closed bead has exactly one milestone label
//   2  at least one bead has zero or multiple milestone labels
//   1  usage error or bd not runnable

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MILESTONE_PREFIX = 'milestone:';
export const KNOWN_MILESTONES = ['v0.4.3', 'v0.4.4', 'v0.5', 'v0.5.1', 'backlog'];

/** @param {string} text JSONL from `bd export` */
export function parseExport(text) {
    return text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
        .filter((o) => (o._type ?? 'issue') === 'issue');
}

/**
 * @param {Array<{id:string,status?:string,assignee?:string,labels?:string[],title?:string}>} issues
 * @param {{ assignees?: string[], known?: string[] }} [opts]
 * @returns {Array<{id:string,title:string,problem:'missing'|'multiple'|'unknown',labels:string[]}>}
 */
export function findMilestoneViolations(issues, opts = {}) {
    const assignees = opts.assignees ?? [];
    const known = opts.known?.length ? opts.known : KNOWN_MILESTONES;
    const out = [];
    for (const issue of issues) {
        if (issue.status === 'closed') continue;
        if (assignees.length && issue.assignee && !assignees.includes(issue.assignee)) continue;
        const ms = (issue.labels ?? []).filter((l) => l.startsWith(MILESTONE_PREFIX));
        let problem = null;
        if (ms.length === 0) problem = 'missing';
        else if (ms.length > 1) problem = 'multiple';
        else if (!known.includes(ms[0].slice(MILESTONE_PREFIX.length))) problem = 'unknown';
        if (problem) out.push({ id: issue.id, title: issue.title ?? '', problem, labels: ms });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseArgs(argv) {
    const args = { file: undefined, assignees: [], known: [], json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            const v = argv[i + 1];
            if (v === undefined) throw new Error(`Missing value for ${a}`);
            i += 1;
            return v;
        };
        if (a === '--file') args.file = next();
        else if (a === '--assignee') args.assignees.push(next());
        else if (a === '--known') args.known.push(...next().split(',').map((m) => m.trim()).filter(Boolean));
        else if (a === '--json') args.json = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

function runBdExport() {
    const opts = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
    let r = spawnSync('bd', ['export'], opts);
    // bd may be a .cmd/.ps1 shim on Windows, which needs a shell to resolve.
    if (r.error && process.platform === 'win32') r = spawnSync('bd', ['export'], { ...opts, shell: true });
    if (r.error) throw new Error(`cannot run bd: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`bd export failed (exit ${r.status}): ${r.stderr}`);
    return r.stdout;
}

export function main(argv = process.argv.slice(2)) {
    let args;
    let issues;
    try {
        args = parseArgs(argv);
        issues = parseExport(args.file ? readFileSync(args.file, 'utf8') : runBdExport());
    } catch (e) {
        console.error(`check-bead-milestones: ${e.message}`);
        return 1;
    }
    const v = findMilestoneViolations(issues, { assignees: args.assignees, known: args.known });
    const known = args.known.length ? args.known : KNOWN_MILESTONES;
    if (args.json) {
        console.log(JSON.stringify(v, null, 2));
    } else if (v.length === 0) {
        console.log('[OK] every in-scope non-closed bead has exactly one milestone label');
    } else {
        console.log(`${v.length} bead(s) violate the one-milestone-label rule (${known.map((m) => MILESTONE_PREFIX + m).join(' | ')}):`);
        for (const x of v) console.log(`  ${x.id}  ${x.problem}${x.labels.length ? ' [' + x.labels.join(', ') + ']' : ''}  ${x.title.slice(0, 80)}`);
    }
    return v.length ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    process.exitCode = main();
}
