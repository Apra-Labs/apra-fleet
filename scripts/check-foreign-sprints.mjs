#!/usr/bin/env node
// Deploy pre-flight: is a FOREIGN sprint live on this machine's supervisor?
//
// `install --force` restarts the shared singleton fleet server, which can
// collaterally kill other live sprints' dispatches. The deploy runbook must
// therefore stop when another sprint is running -- but NOT when the only live
// reservation is the deploying sprint's OWN one (apra-fleet-5co8.37): a sprint
// that dispatches its own deployer is always in the ledger, so a plain
// "non-empty => stop" gate can never let any sprint deploy its own work.
//
// Usage:
//   node scripts/check-foreign-sprints.mjs --self-sprint-id "<id>" \
//        [--self-child-pid <pid>] [--url http://localhost:8787/api/sprints]
//
// Exit codes:
//   0  proceed  -- no reservations, or only the caller's own reservation(s)
//   3  STOP     -- at least one genuinely foreign reservation is live
//   1  usage/parse error
//
// A supervisor that is not reachable at all means there is no live sprint to
// collide with: that is exit 0 (same outcome the old empty-curl gate had).

import { pathToFileURL } from 'node:url';
import { classifyActiveSprints } from '../packages/apra-fleet-se/src/supervisor/sprint-identity.mjs';

const DEFAULT_URL = 'http://localhost:8787/api/sprints';

/**
 * @param {string[]} argv raw args (process.argv.slice(2))
 * @returns {{ url: string, sprintId: string|undefined, childPid: number|undefined }}
 */
export function parseArgs(argv) {
    let url = DEFAULT_URL;
    let sprintId;
    let childPid;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            const v = argv[i + 1];
            if (v === undefined) throw new Error(`Missing value for ${arg}`);
            i += 1;
            return v;
        };
        if (arg === '--url') url = next();
        else if (arg === '--self-sprint-id') sprintId = next();
        else if (arg === '--self-child-pid') {
            const raw = next();
            const parsed = Number(raw);
            if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid --self-child-pid "${raw}"`);
            childPid = parsed;
        } else throw new Error(`Unknown argument "${arg}"`);
    }
    return { url, sprintId, childPid };
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`[foreign-sprints] ${err.message}`);
        process.exit(1);
        return;
    }

    if (!opts.sprintId && opts.childPid === undefined) {
        console.error('[foreign-sprints] no self identity supplied (--self-sprint-id / --self-child-pid);');
        console.error('[foreign-sprints] every live reservation will be treated as FOREIGN.');
    }

    let payload;
    try {
        const res = await fetch(opts.url);
        if (!res.ok) {
            console.log(`[foreign-sprints] ${opts.url} returned HTTP ${res.status} -- treating as no live sprints; proceed.`);
            process.exit(0);
            return;
        }
        payload = await res.json();
    } catch (err) {
        console.log(`[foreign-sprints] supervisor not reachable at ${opts.url} (${err.message}) -- no live sprint to collide with; proceed.`);
        process.exit(0);
        return;
    }

    const { self, foreign, shouldStop } = classifyActiveSprints(payload && payload.sprints, {
        sprintId: opts.sprintId,
        childPid: opts.childPid,
    });

    for (const r of self) console.log(`[foreign-sprints] own reservation (not foreign): ${r.sprintId} pid=${r.childPid ?? 'n/a'}`);
    for (const r of foreign) console.log(`[foreign-sprints] FOREIGN reservation: ${r.sprintId} pid=${r.childPid ?? 'n/a'} members=${(r.members || []).join(',')}`);

    if (shouldStop) {
        console.error(`[foreign-sprints] STOP: ${foreign.length} foreign sprint(s) live -- do not run install --force.`);
        process.exit(3);
        return;
    }
    console.log(`[foreign-sprints] proceed: ${self.length} own reservation(s), 0 foreign.`);
    process.exit(0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
