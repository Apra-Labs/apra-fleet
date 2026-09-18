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
//   1  usage/parse error, unreadable token file, or an auth (401) failure
//
// A supervisor that is not reachable at all means there is no live sprint to
// collide with: that is exit 0 (same outcome the old empty-curl gate had).
//
// Since the loopback-bearer sprint, every /api/* route requires an
// Authorization: Bearer <token> header (auth.mjs's requiresAuth/isAuthorized).
// This script reads that token from <FLEET_SE_DATA_DIR or ~/.apra-fleet-
// se>/private/token and sends it on every request. A 401 response is a live,
// auth-enforcing supervisor -- NEVER treated as "no live sprints" -- and is a
// fatal (exit 1) condition distinct from "supervisor unreachable" (exit 0).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyActiveSprints } from '../packages/apra-fleet-se/src/supervisor/sprint-identity.mjs';
import { tokenFilePath } from '../packages/apra-fleet-se/src/supervisor/auth.mjs';

const DEFAULT_URL = 'http://localhost:8787/api/sprints';

/**
 * The supervisor's service-token data root: FLEET_SE_DATA_DIR, or
 * ~/.apra-fleet-se. Mirrors spawner.mjs/ledger.mjs/history.mjs's own
 * identically-named helper (each module in this area keeps its own small
 * copy rather than cross-importing one another).
 * @returns {string}
 */
export function defaultSeDataDir() {
    return process.env.FLEET_SE_DATA_DIR
        ? path.resolve(process.env.FLEET_SE_DATA_DIR)
        : path.join(os.homedir(), '.apra-fleet-se');
}

/**
 * Read the supervisor's service token from disk, if present.
 * @param {string} dataDir supervisor data root (see defaultSeDataDir)
 * @returns {string|null} the token, or null when the token file does not exist
 */
export function readServiceToken(dataDir) {
    const file = tokenFilePath(dataDir);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
    const token = raw.trim();
    if (!token) throw new Error(`Service token file is empty: ${file}`);
    return token;
}

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

/**
 * Core logic, factored out of main() so tests can drive it with an injected
 * `fetchImpl` instead of spawning a subprocess against a real socket -- this
 * is a deploy pre-flight, not a network-behavior test, and exercising it
 * against a real listener adds subprocess/socket flakiness for no benefit.
 * @param {string[]} argv raw args (process.argv.slice(2))
 * @param {{ fetchImpl?: typeof fetch, dataDir?: string }} [deps]
 * @returns {Promise<number>} the process exit code
 */
export async function run(argv, deps = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(`[foreign-sprints] ${err.message}`);
        return 1;
    }

    if (!opts.sprintId && opts.childPid === undefined) {
        console.error('[foreign-sprints] no self identity supplied (--self-sprint-id / --self-child-pid);');
        console.error('[foreign-sprints] every live reservation will be treated as FOREIGN.');
    }

    const seDataDir = deps.dataDir ?? defaultSeDataDir();
    let token;
    try {
        token = readServiceToken(seDataDir);
    } catch (err) {
        console.error(`[foreign-sprints] ${err.message}`);
        return 1;
    }

    let payload;
    try {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetchImpl(opts.url, { headers });
        if (res.status === 401) {
            // A 401 means the supervisor IS live and enforcing auth -- this is
            // never "no live sprints". Silently treating it as an empty list
            // (the old !res.ok branch below) would defeat this whole preflight
            // gate, so it gets its own fatal branch instead.
            const hint = token
                ? 'the token this script read may be stale/rotated'
                : `no service token file found at ${tokenFilePath(seDataDir)} -- is the supervisor running, or is FLEET_SE_DATA_DIR set to the wrong data root?`;
            console.error(`[foreign-sprints] ${opts.url} returned HTTP 401 unauthorized -- ${hint}.`);
            console.error('[foreign-sprints] refusing to treat an auth failure as "no live sprints".');
            return 1;
        }
        if (!res.ok) {
            console.log(`[foreign-sprints] ${opts.url} returned HTTP ${res.status} -- treating as no live sprints; proceed.`);
            return 0;
        }
        payload = await res.json();
    } catch (err) {
        console.log(`[foreign-sprints] supervisor not reachable at ${opts.url} (${err.message}) -- no live sprint to collide with; proceed.`);
        return 0;
    }

    const { self, foreign, shouldStop } = classifyActiveSprints(payload && payload.sprints, {
        sprintId: opts.sprintId,
        childPid: opts.childPid,
    });

    for (const r of self) console.log(`[foreign-sprints] own reservation (not foreign): ${r.sprintId} pid=${r.childPid ?? 'n/a'}`);
    for (const r of foreign) console.log(`[foreign-sprints] FOREIGN reservation: ${r.sprintId} pid=${r.childPid ?? 'n/a'} members=${(r.members || []).join(',')}`);

    if (shouldStop) {
        console.error(`[foreign-sprints] STOP: ${foreign.length} foreign sprint(s) live -- do not run install --force.`);
        return 3;
    }
    console.log(`[foreign-sprints] proceed: ${self.length} own reservation(s), 0 foreign.`);
    return 0;
}

async function main() {
    process.exit(await run(process.argv.slice(2)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
