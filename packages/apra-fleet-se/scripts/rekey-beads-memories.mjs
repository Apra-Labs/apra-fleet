#!/usr/bin/env node
// =============================================================================
// rekey-beads-memories.mjs -- re-key beads operational memories to the
// role-delimited key scheme.
//
// Scheme (the role-scoped key contract in docs/role-contracts.md of this
// package; mapping logic in scripts/lib/beads-memory-keys.mjs):
//   universal rule      +all+:<slug>
//   role-scoped rule    +<role>+:<slug>            e.g. +doer+:<slug>
//   multi-role rule     +<role1>+<role2>+:<slug>   e.g. +doer+reviewer+:<slug>
// A role queries `bd memories +all+` and `bd memories +<role>+`. `bd memories`
// is a case-insensitive plain substring search over keys AND values, so each
// role token is delimited by '+' on both sides: `+reviewer+` never matches
// `+plan-reviewer+`. '+' has no meaning in bash, PowerShell or cmd, so the
// query needs no quoting.
//
// Old forms this script maps:
//   role:all:<slug>                 -> +all+:<slug>
//   <r1>:<r2>:...:<slug>            -> +r1+r2+...+:<slug>   (every rN a known role)
//   groomer-heuristic-<slug>        -> +groomer+:<slug>     (pre-scoping groomer form)
// Keys already in the new form are left alone. Any other key is reported as
// unparsed and left alone -- never guessed. Unparsed keys are invisible to every
// role query: the dry run lists them as a WARNING, and --apply exits 1 while any
// remain (after re-keying everything else); fix or forget them by hand, re-run.
//
// Usage (cwd = the repo whose beads DB you want to re-key; <se> is this
// package's directory):
//   node <se>/scripts/rekey-beads-memories.mjs            # dry run: print old -> new
//   node <se>/scripts/rekey-beads-memories.mjs --apply    # remember new, verify, forget old
//
// Idempotent: a re-run after success finds nothing to do. If the new key
// already holds the same value, only the old key is forgotten; if it holds a
// different value, the pair is reported as a conflict and both are kept.
// Values are passed to bd as argv (no shell), so quotes, $, && and {{...}}
// in a value survive byte-for-byte. Take a backup first:
//   bd export --all --include-memories -o <file>.jsonl
// Push afterwards with `bd dolt push` (this script never pushes).
// Set BD_BIN to the bd executable if `bd` is not directly spawnable (on
// Windows the npm `bd.cmd` shim is resolved to its bd.exe automatically).
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, mapKey } from './lib/beads-memory-keys.mjs';

export { ROLES, mapKey };

function resolveBd() {
    if (process.env.BD_BIN) return process.env.BD_BIN;
    const probe = spawnSync('bd', ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return 'bd';
    if (process.platform === 'win32') {
        const where = spawnSync('where', ['bd'], { encoding: 'utf8' });
        for (const line of String(where.stdout || '').split(/\r?\n/).filter(Boolean)) {
            const dir = path.dirname(line.trim());
            for (const cand of [path.join(dir, 'bd.exe'), path.join(dir, 'node_modules', '@beads', 'bd', 'bin', 'bd.exe')]) {
                if (existsSync(cand)) return cand;
            }
        }
    }
    throw new Error('cannot spawn bd; set BD_BIN to the bd executable');
}

function makeBd(bin) {
    return (args) => {
        const r = spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, GOMAXPROCS: process.env.GOMAXPROCS || '1' } });
        if (r.error) throw r.error;
        if (r.status !== 0) throw new Error(`bd ${args[0]} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
        return r.stdout;
    };
}

function listMemories(bd) {
    const parsed = JSON.parse(bd(['memories', '--json']) || '{}');
    const out = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v; // drop schema_version etc.
    return out;
}

function main() {
    const apply = process.argv.includes('--apply');
    const bd = makeBd(resolveBd());
    const before = listMemories(bd);
    const plan = [];
    const unparsed = [];
    let already = 0;
    for (const key of Object.keys(before).sort()) {
        const m = mapKey(key);
        if (m.kind === 'new') already++;
        else if (m.kind === 'unparsed') unparsed.push(key);
        else plan.push({ from: key, to: m.to });
    }
    const conflicts = [];
    const dupTargets = new Set();
    const seen = new Set();
    for (const p of plan) { if (seen.has(p.to)) dupTargets.add(p.to); seen.add(p.to); }

    console.log(`${Object.keys(before).length} memories: ${already} already re-keyed, ${plan.length} to re-key, ${unparsed.length} unparsed.`);
    for (const p of plan) console.log(`  ${p.from} -> ${p.to}`);
    for (const k of unparsed) console.log(`  [unparsed, left alone] ${k}`);
    if (dupTargets.size) {
        console.error(`ERROR: several old keys map to the same new key: ${[...dupTargets].join(', ')}. Resolve by hand.`);
        process.exit(1);
    }
    if (!apply) {
        console.log(plan.length ? 'Dry run. Re-run with --apply to re-key.' : 'Nothing to re-key.');
        reportUnparsed(unparsed, 'WARNING');
        return;
    }

    let done = 0;
    for (const { from, to } of plan) {
        const value = before[from];
        let current = listMemories(bd);
        if (Object.prototype.hasOwnProperty.call(current, to) && current[to] !== value) {
            conflicts.push(`${from} -> ${to}`);
            continue;
        }
        if (current[to] !== value) {
            bd(['remember', '--key', to, '--', value]);
            current = listMemories(bd);
            if (current[to] !== value) throw new Error(`value mismatch after writing ${to}; old key ${from} kept`);
        }
        bd(['forget', from]);
        done++;
    }
    const after = listMemories(bd);
    console.log(`Re-keyed ${done}/${plan.length}. Memories before: ${Object.keys(before).length}, after: ${Object.keys(after).length}.`);
    if (done > 0) {
        console.log('Now sync the change to the remote:');
        console.log('  bd dolt pull');
        console.log('  bd dolt push');
    }
    if (conflicts.length) {
        console.error(`CONFLICT (new key exists with a different value; both kept): ${conflicts.join(', ')}`);
    }
    reportUnparsed(unparsed, 'ERROR');
    if (conflicts.length || unparsed.length) process.exit(1);
}

function reportUnparsed(unparsed, level) {
    if (!unparsed.length) return;
    console.error(`${level}: ${unparsed.length} key(s) could not be mapped and were left unmigrated; no role query (bd memories +all+ / +<role>+) will ever return them:`);
    for (const k of unparsed) console.error(`  ${k}`);
    console.error('Re-key each by hand (bd remember --key "+<role>+:<slug>" ..., then bd forget <old-key>) or forget it, then re-run.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); } catch (err) { console.error(`ERROR: ${err.message}`); process.exit(1); }
}
