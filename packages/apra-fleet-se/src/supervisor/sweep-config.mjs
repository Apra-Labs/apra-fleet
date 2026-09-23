/**
 * Supervisor-side loader for the TARGET-OWNED stray-sweep config
 * (apra-fleet-i4ku.10).
 *
 * WHAT PROBLEM THIS SOLVES: Member Prep's stray-process sweep only acts when
 * it is given fleet-start markers (fleet-sprint/phases/member-prep.mjs's
 * runSweepStep). The only producer was bin/cli.mjs's resolveSweepConfig()
 * behind `--sweep-config`, and the supervisor's own launch path never passed
 * it -- so every supervisor-launched sprint reported "sweep skipped: no
 * fleet-start markers configured" and a stale sandbox supervisor left on a
 * remote member was never swept. This module is the missing producer for
 * that path.
 *
 * WHO OWNS THE DATA: the TARGET repo, never this engine
 * (docs/generic-engine-boundary.md). fleet-sprint knows no process names,
 * paths or ports of its own; only the target knows which paths and flags it
 * actually puts on a command line, and which ports are its production
 * services. So this module defines only WHERE a target declares that data
 * (`.fleet/sweep-config.json` in the sprint repo, or an explicit
 * `FLEET_SE_SWEEP_CONFIG`), and never WHAT is in it. Nothing here is
 * specific to apra-fleet -- apra-fleet's own marker/port set lives in its own
 * `.fleet/sweep-config.json` exactly like any other target's.
 *
 * EXPLICIT CONFIGURATION, LOUD FAILURE: the two failure shapes are
 * deliberately NOT the same.
 *   - No config file at all -> the target has not opted in. Returns
 *     undefined, logs one line saying the sweep will be dormant, and the
 *     sprint proceeds. This is the pre-existing behaviour, unchanged.
 *   - A config that EXISTS but is unreadable, malformed or the wrong shape
 *     -> THROWS. A target that declared a sweep config and got a silent
 *     no-op would believe its members were being swept when they never were,
 *     which is the "implicit environment decides behaviour and failure is
 *     silent" trap. A declared config that cannot be honoured fails loudly.
 *
 * The shape checks below mirror bin/cli.mjs's resolveSweepConfig(), which
 * re-validates independently when the child CLI parses the flag. That
 * round trip (supervisor serializes -> cli.mjs parses) is pinned by
 * test/spawner.test.mjs against the REAL resolveSweepConfig, so the two
 * validators cannot silently drift apart.
 */

import fsDefault from 'node:fs';
import path from 'node:path';

/** Env var that overrides the conventional location (inline JSON or a path). */
export const SWEEP_CONFIG_ENV_VAR = 'FLEET_SE_SWEEP_CONFIG';

/** Where a target declares its sweep config, relative to the sprint repo root. */
export const SWEEP_CONFIG_RELATIVE_PATH = path.join('.fleet', 'sweep-config.json');

const EVIDENCE_KINDS = new Set(['path', 'flag', 'name']);

/**
 * Shape-checks a parsed sweep config. Mirrors bin/cli.mjs's
 * resolveSweepConfig() so a config this supervisor accepts is always one the
 * spawned child will accept too.
 *
 * @param {unknown} parsed - the parsed JSON value
 * @param {string} source - human-readable origin, used in error text
 * @returns {{ markers: Array<object>, productionPorts: Array<number> }}
 */
export function validateSweepConfig(parsed, source) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`[supervisor] sweep config ${source} must be a JSON object ({ markers: [...], productionPorts: [...] }).`);
    }

    const markers = parsed.markers === undefined ? [] : parsed.markers;
    if (!Array.isArray(markers)) {
        throw new Error(`[supervisor] sweep config ${source}: "markers" must be an array of { kind, token, evidence } objects.`);
    }
    markers.forEach((m, i) => {
        if (!m || typeof m !== 'object' || Array.isArray(m)
            || typeof m.kind !== 'string' || m.kind.length === 0
            || typeof m.token !== 'string' || m.token.length === 0
            || typeof m.evidence !== 'string' || !EVIDENCE_KINDS.has(m.evidence)) {
            throw new Error(`[supervisor] sweep config ${source}: "markers[${i}]" must be { kind: string, token: string, evidence: 'path'|'flag'|'name' }.`);
        }
    });

    const productionPorts = parsed.productionPorts === undefined ? [] : parsed.productionPorts;
    if (!Array.isArray(productionPorts)) {
        throw new Error(`[supervisor] sweep config ${source}: "productionPorts" must be an array of port numbers.`);
    }
    productionPorts.forEach((p, i) => {
        if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
            throw new Error(`[supervisor] sweep config ${source}: "productionPorts[${i}]" ("${p}") must be an integer in 1..65535.`);
        }
    });

    return { markers, productionPorts };
}

/**
 * Loads the sweep config this supervisor should forward to every sprint it
 * launches.
 *
 * Resolution order:
 *   1. `FLEET_SE_SWEEP_CONFIG` -- inline JSON (starts with '{') or a path
 *      (absolute, or relative to `repoRoot`). Set-but-broken always throws:
 *      an operator who set it explicitly gets told, never silently ignored.
 *   2. `<repoRoot>/.fleet/sweep-config.json` -- the conventional
 *      target-owned location. Absent -> undefined (opt-in, sweep dormant);
 *      present-but-broken -> throws.
 *
 * @param {{
 *   repoRoot: string,
 *   env?: NodeJS.ProcessEnv,
 *   fs?: { existsSync: Function, readFileSync: Function },
 *   logger?: { log?: Function, warn?: Function },
 * }} opts
 * @returns {{ markers: Array<object>, productionPorts: Array<number> }|undefined}
 */
export function loadSweepConfig(opts = {}) {
    const { repoRoot } = opts;
    const env = opts.env ?? process.env;
    const fs = opts.fs ?? fsDefault;
    const logger = opts.logger ?? console;
    const log = (...a) => logger.log?.(...a);

    const raw = env[SWEEP_CONFIG_ENV_VAR];
    const explicit = typeof raw === 'string' && raw.trim().length > 0;

    let jsonText;
    let source;

    if (explicit) {
        const value = raw.trim();
        if (value.startsWith('{')) {
            jsonText = value;
            source = `from ${SWEEP_CONFIG_ENV_VAR} (inline JSON)`;
        } else {
            const file = path.isAbsolute(value) ? value : path.resolve(repoRoot ?? '.', value);
            source = `'${file}' (${SWEEP_CONFIG_ENV_VAR})`;
            try {
                jsonText = fs.readFileSync(file, 'utf-8');
            } catch (err) {
                throw new Error(`[supervisor] ${SWEEP_CONFIG_ENV_VAR} points at '${file}', which could not be read: ${err.message}`);
            }
        }
    } else {
        if (!repoRoot) return undefined;
        const file = path.resolve(repoRoot, SWEEP_CONFIG_RELATIVE_PATH);
        if (!fs.existsSync(file)) {
            log(`[supervisor] no ${SWEEP_CONFIG_RELATIVE_PATH} in '${repoRoot}' and no ${SWEEP_CONFIG_ENV_VAR} set -- the Member Prep stray-process sweep will stay dormant for sprints launched here (no fleet-start markers, no production ports, so nothing is ever matched or killed).`);
            return undefined;
        }
        source = `'${file}'`;
        try {
            jsonText = fs.readFileSync(file, 'utf-8');
        } catch (err) {
            throw new Error(`[supervisor] sweep config '${file}' exists but could not be read: ${err.message}`);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        throw new Error(`[supervisor] sweep config ${source} is not valid JSON: ${err.message}`);
    }

    const config = validateSweepConfig(parsed, source);
    log(`[supervisor] sweep config loaded ${source}: ${config.markers.length} fleet-start marker(s), ${config.productionPorts.length} production port(s) never killed.`);
    return config;
}
