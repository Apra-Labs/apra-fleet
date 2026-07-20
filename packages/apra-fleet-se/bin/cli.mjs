#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import {
    resolveFleetServerCommand as sharedResolveFleetServerCommand,
    resolveFleetServerConnection as sharedResolveFleetServerConnection,
    getServerInfoPath,
} from '@apralabs/apra-fleet-client/server-resolution';
import { beadsExtension } from '../auto-sprint/viewer-extensions.mjs';
import { validateIssueId, validateBranchName, checkMemberTopology, createMemberReservationClient } from '../auto-sprint/runner.js';
import { normalizeRole } from '../auto-sprint/contracts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_VIEWER_PORT = 8080;

/**
 * Resolves the command used to launch the apra-fleet MCP server over
 * stdio, layout-aware (apra-fleet-3ns.1) so it works whether this CLI is
 * running dev-mode from a monorepo checkout or bundled as
 * dist/auto-sprint.mjs alongside the server's own dist/index.js
 * (apra-fleet-3ns.2). Overridable via env for tests/CI/non-standard installs.
 *
 * THIN RE-EXPORT (docs/adr-workflow-server-resolution.md, Decision 2): the
 * implementation now lives once in
 * @apralabs/apra-fleet-client/server-resolution, shared with the
 * `apra-fleet workflow` launcher (src/cli/workflow.ts) so the two can never
 * drift. Name, signature, resolution tiers and error text are unchanged for
 * existing callers/tests; only the default `dirname` is bound to this file's
 * location (which is what the bundled/dev-monorepo tiers key off).
 *
 * Resolution order:
 *   1. APRA_FLEET_SERVER_CMD -- an explicit full command + args string.
 *   2. APRA_FLEET_SERVER_BIN -- an explicit server executable, resolved via
 *      PATH (not a literal file path, so no existsSync check applies).
 *   3. <__dirname>/index.js -- the bundled layout.
 *   4. <repoRoot>/dist/index.js -- the dev-monorepo layout.
 *
 * @param {{ env?: Record<string, string | undefined>, dirname?: string, exists?: (candidate: string) => boolean }} [deps]
 * @returns {{ command: string, args: string[] }}
 */
export function resolveFleetServerCommand(deps = {}) {
    return sharedResolveFleetServerCommand({ dirname: __dirname, exists: existsSync, ...deps });
}

/**
 * The full ADR resolution order (HTTP-singleton attach first, stdio self-spawn
 * fallback) for callers that want it. This is exported so the resolution
 * order has exactly one home.
 *
 * NOTE (apra-fleet-eft.7.1): auto-sprint's own main() below calls this too,
 * but treats anything other than `{ mode: 'http' }` as a hard failure -- see
 * `FleetServerUnreachableError`. Plan Part 2.1 retired the per-invocation
 * stdio self-spawn for cli.mjs specifically (it is now the supervisor's
 * internal execution vehicle, launched once per sprint by the spawner), so
 * the stdio branches this function can still return remain here only for
 * other consumers (e.g. `apra-fleet workflow`) that intentionally allow them.
 * @param {object} [deps]
 */
export function resolveFleetServerConnection(deps = {}) {
    return sharedResolveFleetServerConnection({ dirname: __dirname, exists: existsSync, ...deps });
}

/**
 * Typed error thrown by main() (apra-fleet-eft.7.1) when no reachable fleet
 * HTTP singleton is configured. cli.mjs deliberately does NOT fall back to
 * self-spawning a stdio MCP server here -- under the service, every sprint
 * child must share the one already-running fleet-server process, so a
 * missing/unreachable singleton is a hard, explicit failure naming exactly
 * what is missing rather than a silent private-server fallback.
 */
export class FleetServerUnreachableError extends Error {
    /**
     * @param {string} message
     * @param {{ code?: string, details?: object }} [opts]
     */
    constructor(message, { code, details } = {}) {
        super(message);
        this.name = 'FleetServerUnreachableError';
        this.code = code || 'FLEET_SERVER_UNREACHABLE';
        this.details = details;
    }
}

/**
 * Resolves the path to auto-sprint's runner script, loaded at runtime via
 * `engine.executeFile()` (NOT importable/bundlable -- it is read from disk
 * and fed to the workflow engine as text). Layout-aware the same way as
 * `resolveFleetServerCommand()` (apra-fleet-3ns.1): a bundled dist/auto-
 * sprint.mjs ships this as a sibling dist asset (apra-fleet-3ns.2); a dev
 * monorepo checkout resolves it relative to this file's own package tree.
 * @param {{ dirname?: string, exists?: (candidate: string) => boolean }} [deps]
 * @returns {string}
 */
export function resolveRunnerScriptPath(deps = {}) {
    const dirname = deps.dirname || __dirname;
    const exists = deps.exists || existsSync;

    const bundledRunnerAsset = path.join(dirname, 'auto-sprint-runner.mjs');
    const devRunnerPath = path.join(dirname, '../auto-sprint/runner.js');

    for (const candidate of [bundledRunnerAsset, devRunnerPath]) {
        if (exists(candidate)) return candidate;
    }

    throw new Error(
        '[apra-fleet-se] Could not locate the auto-sprint runner script. Tried:\n' +
            `  - ${bundledRunnerAsset} (bundled layout)\n` +
            `  - ${devRunnerPath} (dev-monorepo layout)`,
    );
}

/**
 * The `node:util parseArgs` options spec for this CLI. Pulled out into its
 * own function (rather than inlined in main()) so it is the single source of
 * truth for both the real `parseArgs()` call and any test that needs to
 * enumerate/exercise the supported flags.
 * @returns {object}
 */
export function buildOptionsSpec() {
    return {
        issue: { type: 'string', short: 'i' },
        members: { type: 'string', short: 'm' },
        branch: { type: 'string', short: 'b' },
        base: { type: 'string', short: 'B' },
        goal: { type: 'string', short: 'g', default: 'P1/P2' },
        'max-cycles': { type: 'string', short: 'c' },
        'allow-missing-members': { type: 'boolean' },
        'requirements-file': { type: 'string' },
        'role-map': { type: 'string' },
        'viewer-port': { type: 'string', default: String(DEFAULT_VIEWER_PORT) },
        budget: { type: 'string' },
        // apra-fleet-eft.8.5: explicitly opt a multi-member run into synced
        // topology mode (orchestrator-bracketed git sync -- same-origin +
        // dolt-probe precondition, differing HEADs allowed). Omitted => legacy
        // shared-workspace mode (same-HEAD). Mode is never inferred silently.
        sync: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
    };
}

const USAGE_TEXT = `
Usage: fleet-se sprint [options]

Options:
  -i, --issue <ids>            (REQUIRED) Target issue ID(s). Comma separated (e.g., epic-1,epic-2).
  -m, --members <ids>          (REQUIRED) Member IDs/names to use. Comma separated. Members act as repo targets for parallelism.
  -b, --branch <name>          (REQUIRED) Sprint branch to develop on (created from --base if it doesn't exist).
  -B, --base <name>            (REQUIRED) Base branch the sprint branch is created from and the eventual PR targets.
  -g, --goal <goal>            Sprint goal constraint. Options: P1, P1/P2, P1/P2/P3. Default: P1/P2.
  -c, --max-cycles <n>         Max plan/develop/review cycles. Default: 5.
      --allow-missing-members  Proceed (warn-and-continue) if some --members are not registered with the fleet.
                                Without this flag, any missing member aborts the sprint.
      --requirements-file <p>  Path to a requirements file threaded into the planner's prompt.
      --role-map <json|@file>  JSON object mapping role -> member[] (e.g. '{"doer":["m1","m2"]}'),
                                either inline JSON or '@path/to/file.json'.
      --viewer-port <port>     Port for the local dashboard viewer. Default: 8080.
      --budget <usd>            USD ceiling for this run's total estimated spend. Optional;
                                omitted (the default) means unlimited, identical to prior behavior.
      --sync                   Use synced topology mode (orchestrator-bracketed git sync):
                                members may sit on differing HEADs but must share the same
                                origin URL and pass a 'bd dolt pull' probe. Omitted (default)
                                uses legacy shared-workspace mode (all members on the same HEAD).
  -h, --help                   Show this help message.
`.trim();

/**
 * Parses argv with `strict: true` so an unrecognized/typo'd flag (e.g.
 * `--max-cycle` instead of `--max-cycles`) fails loudly instead of being
 * silently ignored with defaults applying (apra-fleet-unw2.16, N14 (a)).
 * @param {string[]} argv - argv slice (no node/script entries), e.g. `process.argv.slice(2)`
 * @returns {{ values: object, positionals: string[] }}
 */
export function parseCliArgs(argv) {
    try {
        return parseArgs({ args: argv, options: buildOptionsSpec(), strict: true, allowPositionals: false });
    } catch (err) {
        throw new Error(
            `Invalid command-line arguments: ${err.message}\n\n${USAGE_TEXT}`
        );
    }
}

/**
 * Resolves `--role-map` into a plain object, supporting both inline JSON
 * (`--role-map '{"doer":["m1"]}'`) and an `@path/to/file.json` indirection
 * (`--role-map @role-map.json`), matching the read-and-parse pattern already
 * used for `requirementsFile` content elsewhere in this package
 * (auto-sprint/runner.js reads requirementsFile content at sprint-start).
 * @param {string|undefined} rawValue - the raw `--role-map` flag value
 * @param {{ readFile?: (path: string, encoding: string) => Promise<string> }} [deps] - injectable for tests
 * @returns {Promise<object|undefined>}
 */
export async function resolveRoleMap(rawValue, deps = {}) {
    if (rawValue === undefined) return undefined;
    const readFile = deps.readFile || fs.readFile;

    let jsonText = rawValue;
    if (rawValue.startsWith('@')) {
        const filePath = rawValue.slice(1);
        try {
            jsonText = await readFile(filePath, 'utf-8');
        } catch (err) {
            throw new Error(`Error: could not read --role-map file '${filePath}': ${err.message}`);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        throw new Error(`Error: --role-map must be valid JSON (inline or @path/to/file.json): ${err.message}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Error: --role-map JSON must be an object mapping role -> member[] (e.g. {"doer":["m1","m2"]}).');
    }
    for (const [role, members] of Object.entries(parsed)) {
        if (!Array.isArray(members) || members.some((m) => typeof m !== 'string' || m.length === 0)) {
            throw new Error(`Error: --role-map entry for role "${role}" must be a non-empty array of member-name strings.`);
        }
    }

    // N15 (apra-fleet-unw2.11): normalize every key via
    // contracts.normalizeRole() (trim + lowercase) HERE -- this is where
    // roleMap keys first enter the system from a user-supplied
    // `--role-map`/`@file.json` value, so callers of `resolveRoleMap()`
    // (including this CLI's own pre-transport `orchestratorMember` lookup
    // below, and runner.js's `validateArgs()`, which normalizes again
    // defensively for callers that bypass the CLI and pass a raw roleMap
    // straight to `engine.executeFile()`) can rely on keys already being in
    // canonical lowercase form. This also covers the 'orchestrator'
    // application-level pseudo-role key (see runner.js's ROLE_ORCHESTRATOR
    // doc comment) -- it is not a vendored contracts.ROLES member but is
    // still just a plain string key here, so the same normalization applies.
    const normalized = {};
    for (const [rawKey, members] of Object.entries(parsed)) {
        const key = normalizeRole(rawKey);
        if (Object.prototype.hasOwnProperty.call(normalized, key)) {
            throw new Error(
                `Error: --role-map key "${rawKey}" normalizes to "${key}", which collides with another key ` +
                `already present in --role-map. Use a single casing/whitespace variant per role.`
            );
        }
        normalized[key] = members;
    }

    return normalized;
}

/**
 * Builds the exact args object handed to `engine.executeFile()`, i.e. the
 * object `auto-sprint/runner.js`'s `validateArgs()` consumes. Pulled into its
 * own pure function so a test can assert `--requirements-file`/`--role-map`
 * reach the runner's validated args correctly without standing up the fleet
 * transport/workflow engine (apra-fleet-unw2.16, N14 (c)).
 * @param {{
 *   targetIssues: string[], members: string[], branch: string, baseBranch: string,
 *   goal: string, maxCycles: number, requirementsFile: string|undefined, roleMap: object|undefined,
 *   budget: number|undefined,
 * }} opts
 * @returns {object}
 */
export function buildRunnerArgs({ targetIssues, members, branch, baseBranch, goal, maxCycles, requirementsFile, roleMap, budget }) {
    const args = {
        target_issues: targetIssues,
        members,
        branch,
        base_branch: baseBranch,
        goal,
        max_cycles: maxCycles,
    };
    if (requirementsFile !== undefined) args.requirementsFile = requirementsFile;
    if (roleMap !== undefined) args.roleMap = roleMap;
    if (budget !== undefined) args.budget = budget;
    return args;
}

/**
 * Splits `--members` against the fleet's registered member names and decides
 * whether the sprint may proceed.
 *
 * Before this issue, a missing configured member was only warned about and
 * silently dropped -- shrinking the doer/reviewer pool without the user
 * necessarily noticing. Now: any missing member ABORTS unless
 * `--allow-missing-members` is explicitly passed, in which case the previous
 * warn-and-continue behavior is preserved (apra-fleet-unw2.16, N14 (b)).
 * @param {{ rawMembers: string[], registeredNames: Set<string>, allowMissingMembers: boolean }} opts
 * @returns {{ ok: boolean, validMembers: string[], missingMembers: string[], message: string|null }}
 */
export function resolveMemberValidation({ rawMembers, registeredNames, allowMissingMembers }) {
    const validMembers = [];
    const missingMembers = [];
    for (const m of rawMembers) {
        if (registeredNames.has(m)) validMembers.push(m);
        else missingMembers.push(m);
    }

    if (validMembers.length === 0) {
        return {
            ok: false,
            validMembers,
            missingMembers,
            message: `Error: All specified members are missing or invalid: ${rawMembers.join(', ')}`,
        };
    }

    if (missingMembers.length > 0 && !allowMissingMembers) {
        return {
            ok: false,
            validMembers,
            missingMembers,
            message:
                `Error: The following configured members are missing from the fleet: ${missingMembers.join(', ')}. ` +
                `Refusing to silently shrink the doer/reviewer pool. Pass --allow-missing-members to proceed with ` +
                `only the remaining member(s) (${validMembers.join(', ')}).`,
        };
    }

    const message = missingMembers.length > 0
        ? `Warning: The following members are missing and will be ignored: ${missingMembers.join(', ')}`
        : null;

    return { ok: true, validMembers, missingMembers, message };
}

/**
 * Verifies every target issue exists, run on the ORCHESTRATOR MEMBER via the
 * fleet transport (`runBdShow`) -- NOT on the local machine. The sprint's own
 * `bd` commands run against the orchestrator member's beads DB (see
 * auto-sprint/runner.js's SUPPORTED-TOPOLOGY NOTE), which can be a different
 * database than whatever is local to wherever this CLI process happens to
 * run. Checking locally could pass (or worse, resolve a same-named-but-
 * different issue) while the actual sprint dispatch on the member fails
 * (apra-fleet-unw2.16, N14 (d)). This runs AFTER the fleet transport/
 * `initialize` handshake is established and BEFORE any sprint phase begins.
 * @param {{ targetIssues: string[], member: string, runBdShow: (id: string, member: string) => Promise<{ isError?: boolean, content?: Array<{text: string}> }> }} opts
 * @returns {Promise<{ ok: boolean, missing: string[], message: string }>}
 */
export async function checkIssuesExistOnMember({ targetIssues, member, runBdShow }) {
    const missing = [];
    for (const id of targetIssues) {
        try {
            const res = await runBdShow(id, member);
            if (res && res.isError) {
                missing.push(id);
            }
        } catch (err) {
            missing.push(id);
        }
    }
    if (missing.length > 0) {
        return {
            ok: false,
            missing,
            message: `Error: The following target issues are missing from the database on member '${member}': ${missing.join(', ')}`,
        };
    }
    return {
        ok: true,
        missing: [],
        message: `[Precondition] All ${targetIssues.length} target issue(s) verified present on member '${member}'.`,
    };
}

/**
 * Formats a clean, actionable message for a viewer `server.listen()`
 * failure -- in particular a port collision (EADDRINUSE) -- instead of
 * letting it surface as an unhandled 'error' event / uncaught crash before
 * the sprint even starts (apra-fleet-unw2.16, N14 (e)).
 * @param {number} port
 * @param {NodeJS.ErrnoException} err
 * @returns {string}
 */
export function formatViewerListenError(port, err) {
    if (err && err.code === 'EADDRINUSE') {
        return `viewer port ${port} is already in use, try --viewer-port <other port>.`;
    }
    return `viewer server error: ${err && err.message ? err.message : String(err)}`;
}

/**
 * Attaches an `error` listener to the dashboard viewer's http.Server so a
 * `server.listen()` failure (most commonly a port collision) reports a
 * clean, actionable message via `onError` instead of an unhandled 'error'
 * event crashing the process.
 * @param {import('http').Server} server
 * @param {number} port
 * @param {{ onError?: (message: string, err: NodeJS.ErrnoException) => void }} [opts]
 * @returns {import('http').Server}
 */
export function attachViewerErrorHandler(server, port, opts = {}) {
    server.on('error', (err) => {
        const message = formatViewerListenError(port, err);
        if (typeof opts.onError === 'function') opts.onError(message, err);
    });
    return server;
}

async function main() {
    const { values } = parseCliArgs(process.argv.slice(2));

    if (values.help) {
        console.log(USAGE_TEXT);
        process.exit(0);
    }

    const missing = [];
    if (!values.issue) missing.push('--issue');
    if (!values.members) missing.push('--members');
    if (!values.branch) missing.push('--branch');
    if (!values.base) missing.push('--base');

    if (missing.length > 0) {
        console.error(`Error: Missing required flags: ${missing.join(', ')}`);
        process.exit(1);
    }

    // Split and clean comma-separated lists
    const targetIssues = values.issue.split(',').map(s => s.trim()).filter(Boolean);
    const rawMembers = values.members.split(',').map(s => s.trim()).filter(Boolean);
    const branchName = values.branch;
    const baseBranch = values.base;
    const goal = values.goal;
    const maxCycles = values['max-cycles'] !== undefined ? Number(values['max-cycles']) : 5;
    const allowMissingMembers = Boolean(values['allow-missing-members']);
    const requirementsFile = values['requirements-file'];
    const viewerPort = values['viewer-port'] !== undefined ? Number(values['viewer-port']) : DEFAULT_VIEWER_PORT;
    const budget = values.budget !== undefined ? Number(values.budget) : undefined;

    // --- A7 defense-in-depth: reject shell-unsafe issue ids / branch names
    // BEFORE any bd/fleet dispatch happens. runner.js re-validates these
    // independently (see auto-sprint/runner.js validateArgs()) so a
    // malformed id can never reach a shell command even if this CLI layer
    // is somehow bypassed -- both layers share the exact same validators
    // (imported from runner.js) so there is a single source of truth.
    let roleMap;
    try {
        targetIssues.forEach(validateIssueId);
        validateBranchName(branchName, 'branch');
        validateBranchName(baseBranch, 'base');
        roleMap = await resolveRoleMap(values['role-map']);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }

    if (!Number.isInteger(maxCycles) || maxCycles < 1) {
        console.error(`Error: --max-cycles must be a positive integer, got "${values['max-cycles']}".`);
        process.exit(1);
    }

    if (!Number.isInteger(viewerPort) || viewerPort < 1 || viewerPort > 65535) {
        console.error(`Error: --viewer-port must be a valid TCP port number, got "${values['viewer-port']}".`);
        process.exit(1);
    }

    // --budget is optional; omitted means unlimited (runner.js's validateArgs
    // leaves context.budget.total as null in that case). When passed, reject
    // non-numeric/negative values here at the CLI layer with a clear error,
    // consistent with the strict-parsing conventions established for
    // --max-cycles/--viewer-port above (apra-fleet-unw2.16, N14 (a)) -- this
    // mirrors, but does not duplicate/conflict with, runner.js validateArgs's
    // own budget check (non-negative finite number; see N10, apra-fleet-unw2.8).
    if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) {
        console.error(`Error: --budget must be a non-negative finite number (USD ceiling), got "${values.budget}".`);
        process.exit(1);
    }

    // --- Precondition Validations ---

    // 1. Attach to the fleet MCP transport FIRST, so member validation, the
    // "bd show" issue precondition (below), and the sprint itself all run
    // against the same live client/connection -- and so the issue
    // precondition can target the orchestrator MEMBER rather than the local
    // machine (apra-fleet-unw2.16, N14 (d): the sprint's own `bd` commands
    // run on the member via the fleet transport, which can be a different
    // database than whatever is local to this CLI process).
    //
    // apra-fleet-eft.7.1 (Plan Part 2.1 TRANSPORT decision): no per-sprint
    // stdio MCP transport. cli.mjs is now the supervisor's internal execution
    // vehicle -- every child it runs as (one per concurrent sprint) must
    // attach to the EXISTING fleet singleton over streamable HTTP via
    // resolveFleetServerConnection() rather than each spawning its own
    // fleet-server process. If no reachable HTTP singleton is configured,
    // fail fast with a typed error naming the missing connection config --
    // silently self-spawning a private stdio server here would defeat the
    // whole point of sharing one fleet-server connection across N children.
    const connection = await resolveFleetServerConnection();
    if (connection.mode !== 'http') {
        const err = new FleetServerUnreachableError(
            'No reachable apra-fleet HTTP singleton was found. cli.mjs no longer ' +
                'self-spawns a per-invocation stdio MCP server (Plan Part 2.1) -- ' +
                `resolution said: "${connection.reason}". Start the fleet server ` +
                "('apra-fleet start' or 'apra-fleet install'), or check " +
                `${getServerInfoPath()} (pid alive + GET /health) and the ` +
                'APRA_FLEET_TRANSPORT / APRA_FLEET_SERVER_CMD / APRA_FLEET_SERVER_BIN ' +
                'env vars for a stray override forcing stdio.',
            { code: 'FLEET_SERVER_UNREACHABLE', details: { reason: connection.reason, mode: connection.mode } },
        );
        console.error(`Error: ${err.message}`);
        process.exit(1);
        return;
    }
    const transport = new StreamableHttpTransport(connection.url);
    await transport.start();
    const mcpClient = new McpClient(transport);

    const fleetApi = new ApraFleet(mcpClient);

    // 2. Validate members exist via the fleet's list_members tool.
    let validMembers = [];
    try {
        const listRes = await fleetApi.listMembers({ format: 'json' });
        const text = listRes && listRes.content && listRes.content[0] ? listRes.content[0].text : JSON.stringify(listRes);
        const parsed = JSON.parse(text);
        const registeredNames = new Set((parsed.members || []).map(m => m.name));
        const result = resolveMemberValidation({ rawMembers, registeredNames, allowMissingMembers });
        if (!result.ok) {
            console.error(result.message);
            transport.stop();
            process.exit(1);
        }
        if (result.message) console.warn(result.message);
        validMembers = result.validMembers;
    } catch (err) {
        console.error(`Error: Failed to list fleet members: ${err.message}`);
        transport.stop();
        process.exit(1);
    }

    // 3. bd show issue precondition -- run on the orchestrator MEMBER via the
    // fleet transport (apra-fleet-unw2.16, N14 (d)), immediately after the
    // transport/initialize handshake above and before any sprint phase
    // begins. The orchestrator member mirrors auto-sprint/runner.js's
    // `getMemberForRole(ROLE_ORCHESTRATOR)` resolution: roleMap.orchestrator[0]
    // if configured, else the first valid member. `roleMap` here is already
    // key-normalized by `resolveRoleMap()` above (N15, apra-fleet-unw2.11),
    // so the canonical lowercase 'orchestrator' key is the only one that can
    // be present -- this must NOT read a capitalized 'Orchestrator' key (the
    // N15 finding: that stray casing silently never matched a roleMap
    // author's natural lowercase key).
    const orchestratorMember = (roleMap && roleMap.orchestrator && roleMap.orchestrator[0]) || validMembers[0];
    const issueCheck = await checkIssuesExistOnMember({
        targetIssues,
        member: orchestratorMember,
        runBdShow: async (id, member) => fleetApi.executeCommand({ command: `bd show ${id}`, member_name: member }),
    });
    if (!issueCheck.ok) {
        console.error(issueCheck.message);
        transport.stop();
        process.exit(1);
    }

    // 4. N4 (apra-fleet-unw2.4) multi-member topology precondition.
    //
    // LEGACY mode (default): the runner's cross-member coherence relies on
    // every member sharing one workspace/DB -- every orchestrator-side `bd`
    // command runs against the orchestrator member's beads DB, and the sprint
    // git branch is only coherent if every member operates on the same working
    // state. Enforce that by comparing `git rev-parse HEAD` across members and
    // refusing to start on a mismatch.
    //
    // SYNCED mode (apra-fleet-eft.8.5, `--sync`): with the orchestrator-
    // bracketed git sync layer, members are reconciled per-dispatch by
    // fast-forward pull/push, so differing HEADs are expected and allowed. The
    // precondition instead requires every member to share the same `git remote
    // get-url origin` AND pass a `bd dolt pull` probe. Mode is chosen
    // EXPLICITLY here (never inferred). Single-member trivially passes in
    // either mode.
    const syncedMode = Boolean(values.sync);
    const runCommand = async (cmd, member) => {
        const res = await fleetApi.executeCommand({ command: cmd, member_name: member });
        if (res && res.isError) {
            const errText = res.content && res.content[0] ? res.content[0].text : 'unknown error';
            throw new Error(errText);
        }
        return res && res.content && res.content[0] ? res.content[0].text : '';
    };
    const topology = await checkMemberTopology({
        members: validMembers,
        mode: syncedMode ? 'synced' : 'legacy',
        getIdentity: (member) => runCommand('git rev-parse HEAD', member),
        getOriginUrl: (member) => runCommand('git remote get-url origin', member),
        doltProbe: (member) => runCommand('bd dolt pull', member),
    });
    if (!topology.ok) {
        console.error(`Error: ${topology.message}`);
        transport.stop();
        process.exit(1);
    }
    if (!topology.singleMember) {
        console.log(topology.message);
    }

    console.log('Starting Auto-Sprint');
    console.log(`Target Issues: ${targetIssues.join(', ')}`);
    console.log(`Sprint Branch: ${branchName} (Base: ${baseBranch})`);
    console.log(`Goal Constraint: ${goal}`);
    console.log(`Max Cycles: ${maxCycles}`);
    console.log(`Active Members (${validMembers.length}): ${validMembers.join(', ')}`);

    const workflow = new FleetWorkflow(fleetApi);
    const engine = new WorkflowEngine(workflow);

    const server = createDashboardViewer(workflow, {
        port: viewerPort,
        name: 'Auto-Sprint',
        dashboardExtensions: [beadsExtension]
    });

    // apra-fleet-unw2.16, N14 (e): the viewer port was hardcoded with no
    // `error` handler on `server.listen()`, so a port collision crashed the
    // process uncleanly before the sprint even started. Report a clean,
    // actionable message and exit instead.
    let viewerFailed = false;
    attachViewerErrorHandler(server, viewerPort, {
        onError: (message) => {
            viewerFailed = true;
            console.error(`Error: ${message}`);
            transport.stop();
            process.exit(1);
        },
    });

    console.log(`Dashboard live at http://localhost:${viewerPort}`);

    if (viewerFailed) return; // process.exit already called synchronously above

    // apra-fleet-eft.26.1 (Reservation interop gap, Hole 1): a sprint
    // launched directly through this CLI (never routed through the
    // supervisor's POST /api/sprints) never reserved its members
    // server-side, so it was invisible to any interop -- neither the
    // supervisor's overlap guard (eft.26.2) nor execute_prompt's
    // dispatch-time reservedBy check (eft.10.3) had anything to consult.
    // Reserve every member now, on the SAME opaque sprint id runner.js uses
    // for the dolt-mutex/allocator (the sprint branch name), and release on
    // EVERY exit path below: normal success, a caught failure/stall-abort,
    // or SIGINT.
    const sprintReservation = createMemberReservationClient({
        callTool: (name, args) => mcpClient.callTool(name, args),
        members: validMembers,
        sprintId: branchName,
        log: (msg) => console.log(msg),
    });
    await sprintReservation.reserveAll();

    let reservationReleased = false;
    const releaseReservationOnce = async () => {
        if (reservationReleased) return;
        reservationReleased = true;
        await sprintReservation.releaseAll();
    };
    // Ctrl-C during an in-flight sprint previously had no handler at all (Node's
    // default: immediate termination, no cleanup). Registering one here is what
    // makes a released-on-SIGINT reservation possible; it is removed again
    // (below) the instant the sprint settles so it can never fire during --
    // or short-circuit -- the unrelated post-failure grace-window SIGINT
    // listener registered further down in the catch branch.
    const onSigint = () => {
        releaseReservationOnce()
            .catch((err) => console.error('[member-reservation] release-on-SIGINT failed:', err))
            .finally(() => process.exit(130));
    };
    process.once('SIGINT', onSigint);

    try {
        const scriptPath = resolveRunnerScriptPath();
        const res = await engine.executeFile(scriptPath, buildRunnerArgs({
            targetIssues,
            members: validMembers,
            branch: branchName,
            baseBranch,
            goal,
            maxCycles,
            requirementsFile,
            roleMap,
            budget,
        }));
        process.removeListener('SIGINT', onSigint);
        await releaseReservationOnce();
        console.log('Sprint finished:', res);
        server.close();
        transport.stop();
        process.exit(0);
    } catch (err) {
        process.removeListener('SIGINT', onSigint);
        await releaseReservationOnce();
        // apra-fleet-xbu.4: a caught sprint-level failure (Planner retries
        // exhausted, a StalledSprintError, pre-sprint validation, etc.) used
        // to tear the dashboard server down in the same tick as the error --
        // the one moment an operator most needs to see the FAILED state and
        // read why, the dashboard became unreachable. This is a legitimate,
        // fully-handled outcome, not a crash: the dashboard has no reason to
        // die with it. Keep the server up for a bounded grace window so
        // `http://localhost:<port>` stays inspectable, then exit -- SIGINT
        // (Ctrl-C) or the grace window elapsing both end it; this is not an
        // indefinite hang.
        console.error('Sprint failed:', err);
        process.exitCode = 1;
        const graceMs = Number(process.env.AUTO_SPRINT_FAILURE_GRACE_MS ?? 5 * 60 * 1000);
        if (graceMs > 0) {
            console.log(
                `Sprint FAILED. Dashboard remains live at http://localhost:${viewerPort} for ` +
                `${Math.round(graceMs / 1000)}s so you can inspect the final state -- press Ctrl-C to exit sooner.`
            );
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, graceMs);
                timer.unref?.();
                process.once('SIGINT', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        server.close();
        transport.stop();
        process.exit(process.exitCode || 1);
    }
}

function isMainModule() {
    try {
        return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
}

if (isMainModule()) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
