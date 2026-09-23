#!/usr/bin/env node
// fleet-bridge -- the composition root.
//
// Every module under src/ takes its I/O injected (this package's rule,
// restated in every sibling verb's file header) -- which is why 855+ tests
// run with no cloud and no credentials, and also why NOTHING before this
// file ever constructed a real dependency. This is the one place that
// changes: `parseArgs(argv) -> verb -> build that verb's real deps -> run ->
// process.exit(0)`, with every thrown error mapped through `exitCodeFor`.
//
// DISPATCH DESIGN -- INJECTABLE FOR TESTING
// -----------------------------------------------------------------------------
// The dispatch table is data, not a hardcoded switch: `buildVerbTable(ctx)`
// returns `{ [verb]: { run, needsMcp, longLived, buildOpts, buildDeps,
// exitCodeForResult? } }`. `run` is the verb's own `run<Verb>(opts, deps)`
// function (or, for `daemon`, a thin wrapper around `createDaemon` that also
// calls `.start()` so every table entry has the same "run resolves to a
// result" shape); `buildOpts`/`buildDeps` are THIS file's own translation
// from CLI flags / shared context into that verb's `(opts, deps)` call.
//
// `dispatch({ argv, table, ctx, ... })` is the actual dispatcher: it never
// imports a verb module directly -- it only ever calls through whatever
// `table` it is handed. That is what makes `test/composition-root.test.mjs`
// possible: the test builds `buildVerbTable(fakeCtx)` (so `buildDeps` is
// exercised for REAL against a fake but shape-correct context), then swaps
// out `run` per verb for a spy before calling `dispatch()` -- proving the
// wiring without needing a live supervisor, MCP connection, or `bd` binary.
// See that test file for the exact mechanism ("say what you did" in this
// file's own doc comment is answered there).
//
// LAZY MCP CONNECTION
// -----------------------------------------------------------------------------
// `ctx.mcp()` resolves the fleet MCP connection exactly once per process
// (memoized), and ONLY for verbs whose `needsMcp` is true (preflight, ingest,
// watch, finalize, daemon) -- `launch`, `status`, `viewer`, and `--help` never
// call it. Per fleet-bridge-implementation-plan.md ("cli.mjs no longer
// self-spawns a per-invocation stdio MCP server") and this package's own
// implementation-plan.md ("Build the MCP connection lazily... Treat anything
// other than mode:'http' as a hard failure -- never self-spawn a stdio
// server"), this mirrors packages/apra-fleet-se/bin/cli.mjs's own connection
// step: `resolveFleetServerConnection()` is inspected FIRST, and anything
// other than `{ mode: 'http' }` is a hard, named failure -- this file never
// falls back to `connectFleet()` (server-resolution.mjs), which WOULD
// self-spawn a stdio server on a missing singleton; that fallback is
// correct for other consumers of that helper but wrong here.
//
// THE FACADE, NOT THE RAW ADAPTER
// -----------------------------------------------------------------------------
// `watch` and `finalize` (and daemon's closures over both) are always handed
// `../src/adapters/facade.mjs`'s `createAdapterFacade({...})` as `deps.adapter`
// -- never `getBridgeAdapter(platform)`'s raw registry entry. See that file's
// header for why (the "adapter.comment has three incompatible signatures"
// fix, fleet-bridge-build-log.md).
//
// THE DAEMON'S CALLBACKS ARE NOT THE VERBS
// -----------------------------------------------------------------------------
// `createDaemon`'s `deps.runWatch(handle, signal)` / `deps.runFinalize(handle)`
// are thin, pre-bound closures built HERE, per sprint handle -- never
// `verbs/watch.mjs`'s or `verbs/finalize.mjs`'s own `(opts, deps)` functions
// passed straight through (daemon.mjs's file header: "Passing verbs/watch.mjs's
// own (opts, deps) function will fail at runtime, not at import"). Each
// closure derives that sprint's member/platform from `handle.request`
// (the validated SprintRequest persisted at launch) and builds the SAME
// real deps `watch`/`finalize` build for a direct CLI invocation -- see
// `buildObservabilityDeps`/`buildFinalizeCollaborators` below, shared by
// both the direct verb table entries and the daemon closures so there is
// exactly one place that logic lives.
//
// CONFIG PRECEDENCE
// -----------------------------------------------------------------------------
// Every configuration value (supervisor URL, spool dir, data dir, tracker
// platform/secret name) is resolved via `../src/config.mjs`'s
// `resolveConfigValue`: CLI flag > env var > repo `bridge.config.json` >
// default > fail with CONFIG_MISSING naming both the value and the pipeline
// parameter that supplies it. No machine/user-level config file exists --
// see config.mjs's own header for why.
//
// ASCII only.

import { readFileSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer as httpCreateServer } from 'node:http';

import { VERBS, USAGE_TEXT, parseArgs, requireFlag } from '../src/cli/args.mjs';
import { assertKnownFlags, declaredFlagsView } from '../src/cli/flags.mjs';
import { BridgeError, BRIDGE_ERROR_CODES, exitCodeFor } from '../src/errors.mjs';
import { resolveConfigValue, loadRepoConfig } from '../src/config.mjs';

import { runPreflight } from '../src/verbs/preflight.mjs';
import { runIngest } from '../src/verbs/ingest.mjs';
import { runLaunch } from '../src/verbs/launch.mjs';
import { runWatch } from '../src/verbs/watch.mjs';
import { runFinalize } from '../src/verbs/finalize.mjs';
import { runStatus } from '../src/verbs/status.mjs';
import { createDaemon } from '../src/verbs/daemon.mjs';
import { runViewer } from '../src/verbs/viewer.mjs';

import { createSupervisorClient } from '../src/supervisor-client.mjs';
import { createBeadsClient } from '../src/beads-client.mjs';
import { createSpool } from '../src/spool.mjs';
import { createRestClient } from '../src/rest-client.mjs';
import { getBridgeAdapter } from '../src/adapters/index.mjs';
import { createAdapterFacade } from '../src/adapters/facade.mjs';
import { createJsonlFileSink } from '../src/sinks/jsonl-file.mjs';
import { createAppendBlobSink } from '../src/sinks/append-blob.mjs';
import { createAppendBlobHttp } from '../src/sinks/append-blob-http.mjs';
import { createArchivePublisher } from '../src/spa/archive-publisher.mjs';
import { createRedactor } from '../src/log-safe.mjs';

import {
  readTokenFile as readTokenFileFromDisk,
  createGit,
  isAlive,
  createClock,
  openAppendStream as realOpenAppendStream,
} from './runtime.mjs';

import { execBdSync, execBdAsync } from '@apralabs/apra-fleet-se/src/supervisor/lib/exec-bd.mjs';
import { getSeCommands } from '@apralabs/apra-fleet-se/fleet-sprint/se-os-commands.mjs';
import { beadsExtension } from '@apralabs/apra-fleet-se/fleet-sprint/viewer-extensions.mjs';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet, parseToolJson } from '@apralabs/apra-fleet-client';
import { resolveFleetServerConnection, getFleetDataDir, getServerInfoPath } from '@apralabs/apra-fleet-client/server-resolution';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// usage / version text -- unchanged from the pre-dispatch stub, still driven
// by src/cli/args.mjs's VERBS/USAGE_TEXT so the binary can never advertise a
// verb list that drifts from what actually gets wired below.
// ---------------------------------------------------------------------------

function usage() {
  return [
    `${pkg.name} v${pkg.version}`,
    '',
    USAGE_TEXT,
    'Options:',
    '  --help, -h     print this usage and exit 0',
    '  --version      print the package version and exit 0',
  ].join('\n');
}

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// createRealContext() -- the ONLY place this package constructs a real
// dependency. Everything below is memoized per invocation (this process
// runs one verb and exits), never re-derived per verb table entry.
// ---------------------------------------------------------------------------

/**
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 * @returns {object} the shared context every buildOpts/buildDeps closure reads from.
 */
export function createRealContext({ env = process.env } = {}) {
  const clock = createClock();
  const git = createGit();
  // `unlink` is required by spool.claim() to release its cross-process lock
  // file (and used best-effort to clean up a failed temp write).
  const fs = { readFile, writeFile, rename, mkdir, readdir, stat, unlink };
  const log = (msg) => { console.error(msg); };

  const dataDir = env.APRA_FLEET_DATA_DIR || getFleetDataDir(env);
  const tokenPath = path.join(dataDir, 'private', 'token');
  const readTokenFile = () => readTokenFileFromDisk(dataDir);

  let repoConfigPromise;
  function getRepoConfig() {
    if (!repoConfigPromise) repoConfigPromise = loadRepoConfig(fs, process.cwd());
    return repoConfigPromise;
  }

  async function configValue(spec, flags) {
    const repoConfig = await getRepoConfig();
    return resolveConfigValue(spec, { flags, env, repoConfig });
  }

  /** Resolved once per process, through the same CLI-flag > env > repo-config
   *  precedence chain everything else in this file uses -- `flags` is only
   *  ever needed on the FIRST call within one process (every verb dispatch
   *  shares one argv), so memoizing the resolved value (not just the client)
   *  is deliberate, not a shortcut. */
  let spoolDirPromise;
  async function resolvedSpoolDir(flags) {
    if (!spoolDirPromise) {
      spoolDirPromise = configValue(
        { name: 'spoolDir', flagName: 'spool-dir', envVar: 'FLEET_BRIDGE_SPOOL_DIR', default: path.join(dataDir, 'fleet-bridge', 'spool') },
        flags,
      );
    }
    return spoolDirPromise;
  }

  let supervisorClientPromise;
  /** @param {Map} flags */
  function supervisorClient(flags) {
    if (!supervisorClientPromise) {
      supervisorClientPromise = configValue(
        { name: 'supervisorUrl', flagName: 'supervisor-url', envVar: 'FLEET_BRIDGE_SUPERVISOR_URL', default: 'http://127.0.0.1:8787' },
        flags,
      ).then((baseUrl) => createSupervisorClient({ baseUrl, fetch: globalThis.fetch, readTokenFile, tokenPath, log }));
    }
    return supervisorClientPromise;
  }

  let spoolPromise;
  /** @param {Map} flags */
  function spool(flags) {
    if (!spoolPromise) {
      spoolPromise = resolvedSpoolDir(flags).then((spoolDir) => createSpool({
        spoolDir,
        fs,
        now: () => new Date().toISOString(),
        logger: console,
        isAlive,
      }));
    }
    return spoolPromise;
  }

  /** `<spoolDir>/../logs/<sprintId>.jsonl` -- the always-on local mirror (watch/daemon). */
  async function jsonlPathFor(sprintId, flags) {
    const spoolDir = await resolvedSpoolDir(flags);
    return path.join(path.dirname(spoolDir), 'logs', `${sprintId}.jsonl`);
  }

  /** `fs.createWriteStream` needs its parent directory to already exist; the
   *  sink itself never creates one (see jsonl-file.mjs). */
  function openAppendStream(filePath, onError) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    return realOpenAppendStream(filePath, onError);
  }

  /** The Azure Append Blob REST client, built once per process against the
   *  real global fetch. Bound here rather than constructed inside
   *  buildObservabilityDeps so a fake ctx can replace the whole transport
   *  without touching the network -- the same convention `createServer`
   *  below already follows. Never called unless blob storage is actually
   *  configured, so an operator with no storage account pays nothing. */
  let blobHttpInstance;
  function blobHttp() {
    if (!blobHttpInstance) blobHttpInstance = createAppendBlobHttp({ fetch: globalThis.fetch });
    return blobHttpInstance;
  }

  let mcpPromise;
  /**
   * Resolve (once) the fleet MCP connection over streamable HTTP. Hard-fails
   * on anything other than `{ mode: 'http' }` -- see the file header. Never
   * self-spawns a stdio server.
   * @returns {Promise<{ fleetApi: object, callTool: Function, mcpClient: object }>}
   */
  function mcp() {
    if (!mcpPromise) {
      mcpPromise = (async () => {
        const connection = await resolveFleetServerConnection({ env, dirname: __dirname });
        if (connection.mode !== 'http') {
          throw new BridgeError(
            BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE,
            'No reachable apra-fleet HTTP singleton was found. fleet-bridge never self-spawns a '
            + `per-invocation stdio MCP server -- resolution said: "${connection.reason}". Start the `
            + `fleet server ('apra-fleet start' or 'apra-fleet install'), or check ${getServerInfoPath(env)} `
            + '(pid alive + GET /health) and the APRA_FLEET_TRANSPORT / APRA_FLEET_SERVER_CMD / '
            + 'APRA_FLEET_SERVER_BIN env vars for a stray override forcing stdio.',
            { reason: connection.reason, mode: connection.mode },
          );
        }
        const transport = new StreamableHttpTransport(connection.url);
        await transport.start();
        const mcpClient = new McpClient(transport);
        const fleetApi = new ApraFleet(mcpClient);
        const callTool = (name, args) => mcpClient.callTool(name, args);
        return { fleetApi, callTool, mcpClient };
      })();
    }
    return mcpPromise;
  }

  /** Best-effort member OS/shell lookup (member_detail), so beads-client.mjs /
   *  rest-client.mjs's dialect selection is never a silent POSIX guess for a
   *  Windows member -- per this repo's CLAUDE.md convention
   *  (isPosixShell(agentOs, shell) / probeCommandFor(targetOs, shell)).
   *
   *  WHY A FAILED LOOKUP IS FATAL AND A MISSING MEMBER IS NOT. With NO
   *  member name there is no remote shell in the picture at all: the beads
   *  client runs `bd` locally via execBdSync with a cwd, and
   *  { targetOs: null, shell: null } is the honest answer, not a guess. But
   *  once a member IS named, the command we are about to build gets
   *  dispatched at that member's shell, and getSeCommands normalises a null
   *  OS straight into its POSIX branch (se-os-commands.mjs). So a transient
   *  member_detail failure -- or a member record carrying neither `os` nor
   *  `platform` -- used to send POSIX quoting and {{secret.NAME}} placement
   *  at what may be a PowerShell member: a mangled command, or worse a
   *  mangled credential, reported as success. Per this repo's CLAUDE.md,
   *  "an advisory warning that never blocks is a false success", so this
   *  now fails loudly and names the member.
   *  @throws {BridgeError} CONFIG_INVALID when a named member's dialect
   *    cannot be established. */
  async function memberDialectFor(memberName) {
    if (!memberName) return { targetOs: null, shell: null };
    let detail;
    try {
      const { fleetApi } = await mcp();
      const raw = await fleetApi.memberDetail({ member_name: memberName, format: 'json' });
      detail = parseToolJson(raw);
    } catch (err) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `fleet-bridge: could not resolve member "${memberName}"'s os/shell, so the command dialect (POSIX vs PowerShell) cannot be chosen safely: ${safeMessage(err)}`,
        { memberName, cause: safeMessage(err) },
      );
    }
    const targetOs = (detail && (detail.os || detail.platform)) || null;
    if (!targetOs) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `fleet-bridge: member "${memberName}" was found but its record carries neither "os" nor "platform", so the command dialect (POSIX vs PowerShell) cannot be chosen safely`,
        { memberName },
      );
    }
    const shell = (detail && detail.shell) || null;
    return { targetOs, shell };
  }

  /** `repoLocalPath` -- when given -- is threaded straight through to
   *  beads-client.mjs's `createBeadsClient({ cwd })`: the beads DB belongs to
   *  the repo under test, not to wherever this bridge process was launched
   *  from, so every LOCAL `bd` invocation (list/show/create/update/
   *  doltPullProbe) that client makes must run with that repo as its cwd.
   *  Omitted, behavior is unchanged -- `bd` runs in this process's own cwd,
   *  exactly as before this parameter existed.
   *  @param {{ memberName: string|null, callTool: Function|null, repoLocalPath?: string|null }} opts */
  async function beadsClientFor({ memberName, callTool, repoLocalPath }) {
    const { targetOs, shell } = await memberDialectFor(memberName);
    return createBeadsClient({
      execBdSync,
      execBdAsync,
      callTool: callTool || null,
      memberName: memberName || null,
      targetOs,
      shell,
      ...(repoLocalPath ? { cwd: repoLocalPath } : {}),
      log,
    });
  }

  /** @param {{ memberName: string, callTool: Function }} opts */
  async function restClientFor({ memberName, callTool }) {
    const { targetOs, shell } = await memberDialectFor(memberName);
    return createRestClient({ callTool, memberName, targetOs, shell, log });
  }

  function adapterFor(platformName) {
    return getBridgeAdapter(platformName);
  }

  function facadeFor({ adapter, resolved, handle, restClient, beads }) {
    return createAdapterFacade({ adapter, resolved, handle, restClient, beads, log });
  }

  return {
    env,
    clock,
    git,
    fs,
    log,
    dataDir,
    tokenPath,
    readTokenFile,
    getRepoConfig,
    configValue,
    supervisorClient,
    spool,
    jsonlPathFor,
    openAppendStream,
    blobHttp,
    mcp,
    memberDialectFor,
    beadsClientFor,
    restClientFor,
    adapterFor,
    facadeFor,
    isAliveFn: isAlive,
    // `viewer`'s only remaining real-I/O need (an HTTP server factory,
    // per viewer.mjs's own injected-I/O contract). Bound here, not returned
    // as a bare function reference, so a fake ctx in a test can override it
    // without touching node:http at all.
    createServer: (requestListener) => httpCreateServer(requestListener),
  };
}

/**
 * A resolved supervisor "resolved" object (the shape azure-devops.mjs's
 * comment()/setBuildStatus() read: adoOrgUrl/adoProject/adoPatSecretName).
 * Assembled from global config -- see the report's "under-specified" note:
 * a SprintHandle carries `request.platform`/`request.member` but NOT the
 * adapter-specific coordinates (adoOrgUrl/adoProject) or the tracker secret
 * name, so those three are this daemon/CLI invocation's own config, applied
 * uniformly to every sprint it observes/finalizes. A comment/build-status
 * call made without adoOrgUrl/adoProject configured degrades to a logged
 * no-op (facade.mjs's "COMMENT NEVER THROWS"), never a crash.
 * @param {object} ctx
 * @param {Map} flags
 * @returns {Promise<{ adoOrgUrl: string|undefined, adoProject: string|undefined, adoPatSecretName: string, adoWorkItemType: string|undefined }>}
 */
async function resolveAdapterCoordinates(ctx, flags) {
  // Explicit kebab-case flag names. These two used to default their flag to
  // the config name, so the only spelling that worked was `--adoOrgUrl` --
  // while the pipeline template, the example README and every other flag in
  // this CLI said `--ado-org-url`, which was silently ignored.
  const adoOrgUrl = await ctx.configValue({ name: 'adoOrgUrl', flagName: 'ado-org-url', envVar: 'FLEET_BRIDGE_ADO_ORG_URL', required: false }, flags);
  const adoProject = await ctx.configValue({ name: 'adoProject', flagName: 'ado-project', envVar: 'FLEET_BRIDGE_ADO_PROJECT', required: false }, flags);
  const adoPatSecretName = await ctx.configValue(
    { name: 'secretName', flagName: 'secret-name', envVar: 'FLEET_BRIDGE_SECRET_NAME', pipelineParam: 'adoPatSecretName', default: 'fleet_bridge_azdevops_pat' },
    flags,
  );
  // OPTIONAL and NEVER defaulted: the adapter discovers the type from the
  // project when this is absent, and fails loudly naming the project's real
  // types when it cannot (adapters/azure-devops.mjs's resolveWorkItemType).
  // A default here would be exactly the hardcoded-type assumption
  // docs/setup.md forbids.
  const adoWorkItemType = await ctx.configValue(
    { name: 'adoWorkItemType', flagName: 'work-item-type', envVar: 'FLEET_BRIDGE_ADO_WORK_ITEM_TYPE', required: false },
    flags,
  );
  return { adoOrgUrl, adoProject, adoPatSecretName, adoWorkItemType };
}

/**
 * The append-blob destination, resolved through the SAME precedence chain
 * every other adapter coordinate uses (`configValue`: CLI flag > env var >
 * repo bridge.config.json), with ONE deliberate exception described below.
 * Returns `null` when no blob storage is configured at all, which is the
 * supported default -- work-item comments and the local JSONL mirror are a
 * complete observability story without it.
 *
 * WHY THE SAS IS ENV-VAR-ONLY, AND NOT A `configValue` LIKE THE OTHERS.
 * Every other coordinate here is a non-secret name. The SAS is not: it is a
 * bearer credential granting write access to the container for its whole
 * lifetime. Putting it through `configValue` would make three things legal
 * that must never be:
 *   - `--blob-sas <token>`, which puts a live credential in argv, where it
 *     is visible to `ps`, to any crash dump, and to the pipeline's own
 *     command echo (the AzDO template prints the command it runs);
 *   - `"blobSas"` in `bridge.config.json`, a committed file, which
 *     config.mjs's own header forbids ("non-secret values only");
 *   - a repo-config value silently outliving the pipeline run.
 * So the SAS is read from `FLEET_BRIDGE_BLOB_SAS` only, which an AzDO
 * secret variable populates for the life of one job and which the platform
 * masks in its own log output.
 *
 * A HALF-CONFIGURED DESTINATION IS A HARD FAILURE, not a silent downgrade
 * to local-only. An operator who set an account URL and container but no
 * SAS believes remote progress is being published; starting anyway and
 * saying nothing is exactly the "reported success while doing nothing"
 * shape this package keeps paying for. It fails here, at startup, before a
 * sprint is watched.
 *
 * @param {object} ctx
 * @param {Map} flags
 * @returns {Promise<{ accountUrl: string, containerName: string, sas: string }|null>}
 * @throws {BridgeError} CONFIG_MISSING for a partially-configured destination
 */
async function resolveBlobDestination(ctx, flags) {
  const accountUrl = await ctx.configValue(
    { name: 'blobAccountUrl', flagName: 'blob-account-url', envVar: 'FLEET_BRIDGE_BLOB_ACCOUNT_URL', pipelineParam: 'blobAccountUrl', required: false },
    flags,
  );
  const containerName = await ctx.configValue(
    { name: 'blobContainer', flagName: 'blob-container', envVar: 'FLEET_BRIDGE_BLOB_CONTAINER', pipelineParam: 'blobContainer', required: false },
    flags,
  );

  if (!accountUrl && !containerName) return null;

  if (!accountUrl || !containerName) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      `config: blob storage is half-configured -- ${accountUrl ? 'blobContainer' : 'blobAccountUrl'} is missing. `
      + 'Set BOTH (pipeline parameters blobAccountUrl and blobContainer, flags --blob-account-url / --blob-container, '
      + 'or env FLEET_BRIDGE_BLOB_ACCOUNT_URL / FLEET_BRIDGE_BLOB_CONTAINER), or set neither to run with the local JSONL sink only.',
      { blobAccountUrl: Boolean(accountUrl), blobContainer: Boolean(containerName) },
    );
  }

  const sas = ctx.env && ctx.env.FLEET_BRIDGE_BLOB_SAS;
  if (typeof sas !== 'string' || sas.length === 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'config: blob storage is configured (blobAccountUrl + blobContainer) but no SAS was supplied. '
      + 'Set the FLEET_BRIDGE_BLOB_SAS environment variable to a container SAS with create+write (racw) permission. '
      + 'It is env-only on purpose: a SAS is a live credential and must never be a CLI flag or a bridge.config.json value. '
      + 'Unset blobAccountUrl/blobContainer to run with the local JSONL sink only.',
      { envVar: 'FLEET_BRIDGE_BLOB_SAS' },
    );
  }

  // `details` above deliberately carries booleans and a variable NAME --
  // never the SAS itself. A BridgeError's details are redacted by
  // log-safe.mjs before reaching a sink, but they are ALSO printed raw by
  // this file's own error handler, so the only safe rule is not to put a
  // credential in one.
  return { accountUrl, containerName, sas };
}

/** `handle.request.member`/`.platform`, falling back to this invocation's own config. */
async function memberAndPlatformFor(handle, ctx, flags) {
  const requestedMember = handle && handle.request && handle.request.member;
  const requestedPlatform = handle && handle.request && handle.request.platform;
  const member = requestedMember || await ctx.configValue({ name: 'member', envVar: 'FLEET_BRIDGE_MEMBER' }, flags);
  const platform = requestedPlatform || await ctx.configValue({ name: 'platform', envVar: 'FLEET_BRIDGE_PLATFORM', default: 'azure-devops' }, flags);
  return { member, platform };
}

/**
 * The repo path `beadsClientFor` should thread through as `cwd` (see that
 * function's own doc comment for WHY). `handle.request.repo.localPath` --
 * the validated SprintRequest a launched sprint actually carries (see
 * contracts.mjs's repo validation) -- wins whenever a `handle` is available,
 * because that is the specific repo THIS sprint's beads DB lives in, and a
 * long-lived `daemon` may be watching/finalizing several sprints against
 * different repos in the same process. `--repo-local-path` (the same flag
 * preflight's own buildOpts already reads at line ~469) is the fallback for
 * verbs with no handle yet (`ingest`, or `watch`/`finalize` invoked directly
 * against a sprint the spool has no handle for). Returns `undefined` (never
 * a guessed default) when neither source has it -- see beadsClientFor's own
 * "omitted means unchanged behavior" contract.
 * @param {object|undefined} handle
 * @param {Map} flags
 * @returns {string|undefined}
 */
function repoLocalPathFor(handle, flags) {
  const fromHandle = handle && handle.request && handle.request.repo && handle.request.repo.localPath;
  if (fromHandle) return fromHandle;
  const fromFlags = flags.get('repo-local-path');
  return typeof fromFlags === 'string' && fromFlags.length > 0 ? fromFlags : undefined;
}

/**
 * Shared by `watch`'s table entry and the daemon's `runWatch(handle, signal)`
 * closure -- exactly one place builds a real watch deps object. `handle` may
 * be `undefined` (a direct `fleet-bridge watch --sprint-id` invocation before
 * the spool has a handle for it, e.g. against a sprint launched by another
 * tool) -- every field below degrades gracefully rather than throwing.
 * @param {{ sprintId: string, handle: object|undefined }} target
 * @param {object} ctx
 * @param {Map} flags
 * @param {{ callTool: Function }} mcpConn
 * @returns {Promise<object>} the `watch.mjs` `deps` object
 */
async function buildObservabilityDeps({ sprintId, handle }, ctx, flags, mcpConn) {
  const { member, platform } = await memberAndPlatformFor(handle, ctx, flags);
  const resolved = { sprintRequest: handle && handle.request, ...await resolveAdapterCoordinates(ctx, flags) };

  const [restClient, beads] = await Promise.all([
    ctx.restClientFor({ memberName: member, callTool: mcpConn.callTool }),
    ctx.beadsClientFor({ memberName: member, callTool: mcpConn.callTool, repoLocalPath: repoLocalPathFor(handle, flags) }),
  ]);
  const registryAdapter = ctx.adapterFor(platform);
  const adapter = ctx.facadeFor({ adapter: registryAdapter, resolved, handle, restClient, beads });

  const blob = await resolveBlobDestination(ctx, flags);

  // WHY THE REDACTOR IS BUILT HERE AND SHARED BY BOTH SINKS: with a SAS in
  // this process, `createRedactor()`'s default masking (secret-looking key
  // names, credential URLs, a SAS URL's `sig` parameter) is no longer the
  // whole story -- the literal token could reach a record through a path
  // none of those patterns match, such as an error string that quotes the
  // request URL with the signature already split off. Seeding the redactor
  // with the live value masks it wherever it appears, whatever shape it
  // arrives in. The LOCAL sink gets the same redactor as the remote one:
  // the local mirror is a plain file on a shared build agent, and is if
  // anything the likelier place for a leaked credential to sit unnoticed.
  const redact = blob ? createRedactor({ secrets: [blob.sas] }) : createRedactor();

  const jsonlPath = await ctx.jsonlPathFor(sprintId, flags);
  const jsonlSink = createJsonlFileSink({ path: jsonlPath, openAppendStream: ctx.openAppendStream, clock: ctx.clock, redact });

  // BOTH SINKS, NEVER ONE INSTEAD OF THE OTHER. Enabling blob storage adds
  // a remote copy; it never removes the local one. The local JSONL file is
  // the only record that survives a storage outage, an expired SAS or a
  // network partition, and the design's own acceptance test ("the final
  // blob is byte-identical to the local JSONL mirror") only means anything
  // if the mirror is always written. The remote sink is additionally
  // marked `shared: true`, which makes watch.mjs's single-writer gate
  // disable it -- and ONLY it -- when the live spool claim belongs to
  // SOMEONE ELSE, so a stray terminal `watch` can never corrupt the
  // daemon's appendpos sequence while still giving that operator their
  // local log. The claim HOLDER (normally the daemon, which self-claims
  // just before it watches) keeps the sink: the gate compares the claim's
  // `{pid, host}` against the `pid`/`host` returned below, because "a
  // claim exists" alone was true on every daemon-run sprint and silently
  // killed the remote log everywhere.
  const sinks = [{ name: 'jsonl-file', sink: jsonlSink }];
  if (blob) {
    sinks.push({
      name: 'append-blob',
      shared: true,
      sink: await buildAppendBlobSink({ sprintId, blob, redact }, ctx, flags),
    });
  }

  return {
    supervisorClient: await ctx.supervisorClient(flags),
    sinks,
    spool: await ctx.spool(flags),
    adapter,
    sleep: ctx.clock.sleep,
    now: ctx.clock.now,
    log: ctx.log,
    // THIS process's identity, for watch.mjs's blob-sink gate. Both callers
    // of this builder (the direct `watch` table entry and the daemon's
    // runWatch closure) are the same process, and the daemon claims the
    // sprint with exactly these two values (`daemon`'s buildOpts below), so
    // the gate can finally tell "I am the claim holder" from "someone else
    // is". Without them the gate saw only "a claim exists" and disabled the
    // daemon's own append-blob sink on every sprint.
    pid: process.pid,
    host: os.hostname(),
  };
}

/**
 * Construct the append-blob sink for one sprint, resuming from whatever
 * cursor the spool already holds and persisting the cursor back after every
 * flush.
 *
 * WHY THE CURSOR ROUND-TRIP LIVES HERE AND NOT IN THE SINK: the sink is
 * pure of I/O by this package's rule, so it can expose a cursor but cannot
 * store one. The composition root can, and must -- `createAppendBlobSink`
 * with a null cursor CREATES the blob, and creating an append blob in Azure
 * OVERWRITES it. Without this round-trip, restarting a daemon mid-sprint
 * would silently destroy every record written so far, which is a far worse
 * failure than the one the restart was fixing. With it, the sink resumes at
 * the tracked byte offset and the appendpos protocol absorbs any replayed
 * flush as a 412.
 *
 * Persistence is best-effort and after the fact: a spool write that fails
 * must not fail a flush that succeeded. The worst case of a lost cursor
 * write is a duplicated-or-refused block on the next restart, which the
 * appendpos precondition already handles.
 *
 * @param {{ sprintId: string, blob: {accountUrl: string, containerName: string, sas: string}, redact: Function }} args
 * @param {object} ctx
 * @param {Map} flags
 * @returns {Promise<object>} a sink honouring the fan's { start, emit, flushNow, stop } contract, plus health()
 */
async function buildAppendBlobSink({ sprintId, blob, redact }, ctx, flags) {
  const spool = await ctx.spool(flags);

  let cursor = null;
  try {
    const doc = await spool.read(sprintId);
    const saved = doc && doc.sinkCursors && doc.sinkCursors.appendBlob;
    if (saved && typeof saved === 'object') cursor = saved;
  } catch (err) {
    ctx.log(`[fleet-bridge] could not read a persisted append-blob cursor for "${sprintId}" (starting a new blob): ${safeMessage(err)}`);
  }

  const sink = createAppendBlobSink({
    accountUrl: blob.accountUrl,
    containerName: blob.containerName,
    sas: blob.sas,
    sprintId,
    cursor,
    http: ctx.blobHttp(),
    clock: ctx.clock,
    redact,
    // The sink's own logger is normalised and redacted inside the sink
    // (see its normalizeLogger), so ctx.log can be passed straight in.
    logger: { info: ctx.log, warn: ctx.log, error: ctx.log },
  });

  async function persistCursor() {
    try {
      await spool.patch(sprintId, (draft) => {
        const next = { ...(draft.sinkCursors || {}) };
        next.appendBlob = sink.cursor;
        draft.sinkCursors = next;
      });
    } catch (err) {
      ctx.log(`[fleet-bridge] could not persist the append-blob cursor for "${sprintId}" (a restart may re-send the last block, which appendpos absorbs): ${safeMessage(err)}`);
    }
  }

  // An explicit facade rather than a spread: `cursor` is a getter, and
  // spreading would freeze its value at construction time -- a bug that
  // would only show up as a corrupted blob after a restart.
  return {
    name: 'append-blob',
    start() { sink.start(); },
    emit(record) { return sink.emit(record); },
    async flushNow() {
      await sink.flushNow();
      await persistCursor();
    },
    async stop() {
      await sink.stop();
      await persistCursor();
    },
    health() { return sink.health(); },
    get cursor() { return sink.cursor; },
  };
}

/**
 * Shared by `finalize`'s table entry and the daemon's `runFinalize(handle)`
 * closure. Returns both the deps object AND the resolved `secretName`
 * (finalize.mjs's own `opts.secretName`, forwarded to `adapter.publishCarryOver`).
 * @param {object} handle
 * @param {object} ctx
 * @param {Map} flags
 * @param {{ callTool: Function }} mcpConn
 * @returns {Promise<{ deps: object, secretName: string }>}
 */
async function buildFinalizeCollaborators(handle, ctx, flags, mcpConn) {
  const { member, platform } = await memberAndPlatformFor(handle, ctx, flags);
  const coords = await resolveAdapterCoordinates(ctx, flags);
  const resolved = { sprintRequest: handle && handle.request, ...coords };

  const [restClient, beads] = await Promise.all([
    ctx.restClientFor({ memberName: member, callTool: mcpConn.callTool }),
    ctx.beadsClientFor({ memberName: member, callTool: mcpConn.callTool, repoLocalPath: repoLocalPathFor(handle, flags) }),
  ]);
  const registryAdapter = ctx.adapterFor(platform);
  const adapter = ctx.facadeFor({ adapter: registryAdapter, resolved, handle, restClient, beads });

  // The D1 archive SPA's destination is the same blob container the
  // progress sink writes to -- one storage coordinate, one SAS, one thing
  // for an operator to set up. `null` when no storage is configured, which
  // finalize.mjs treats as "no archive was asked for" (as distinct from
  // "the archive failed", which it reports loudly).
  //
  // `beadsExtension` is supplied HERE, in the composition root, and never
  // inside src/: spa/archive.mjs is deliberately domain-neutral and takes
  // extensions as data, exactly as apra-fleet-se's own bin/cli.mjs passes
  // `dashboardExtensions: [beadsExtension]` into its history view. Without
  // it, the archived page's bead-description lazy-loads would 404 -- the
  // very bug the archive SPA exists to fix.
  const blob = await resolveBlobDestination(ctx, flags);
  const archive = blob
    ? createArchivePublisher({
      accountUrl: blob.accountUrl,
      containerName: blob.containerName,
      sas: blob.sas,
      http: ctx.blobHttp(),
      extensions: [beadsExtension],
      logger: { info: ctx.log, warn: ctx.log, error: ctx.log },
    })
    : null;

  return {
    deps: {
      supervisorClient: await ctx.supervisorClient(flags),
      beads,
      adapter,
      spool: await ctx.spool(flags),
      archive,
      log: ctx.log,
    },
    secretName: coords.adoPatSecretName,
  };
}

// ---------------------------------------------------------------------------
// buildVerbTable(ctx) -- the injectable dispatch table. See the file header.
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx - see `createRealContext()`; a test passes a fake with
 *   the same shape instead.
 * @returns {Record<string, {
 *   run: Function,
 *   needsMcp: boolean,
 *   longLived: boolean,
 *   buildOpts: (flags: Map, positionals: string[], ctx: object) => Promise<object>,
 *   buildDeps: (opts: object, ctx: object, flags: Map) => Promise<object>,
 *   exitCodeForResult?: (result: any) => number,
 * }>}
 */
export function buildVerbTable(ctx) {
  return {
    // -----------------------------------------------------------------
    preflight: {
      run: runPreflight,
      needsMcp: true,
      longLived: false,
      async buildOpts(flags, _positionals, c) {
        const repoLocalPath = flags.get('repo-local-path');
        const repoRemoteUrl = flags.get('repo-remote-url');
        const requiredCredentialsRaw = flags.get('required-credentials');
        const explicitRequiredCredentials = typeof requiredCredentialsRaw === 'string'
          ? requiredCredentialsRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
        // The PAT secret name THIS launch will actually use, resolved through
        // the exact same --secret-name / FLEET_BRIDGE_SECRET_NAME / repo-config
        // / default chain `resolveAdapterCoordinates`/`ingest` use. Folded into
        // the credentials check BY DEFAULT -- not only when an operator
        // remembers `--required-credentials` -- because a real sprint launched
        // through this bridge died on its first git operation after preflight
        // reported "credentials: ok -- No credential names were required for
        // this launch", a vacuous pass caused by exactly that omission. An
        // explicit `--required-credentials` list is ADDITIVE to this, never a
        // replacement for it.
        const secretName = await c.configValue(
          { name: 'secretName', flagName: 'secret-name', envVar: 'FLEET_BRIDGE_SECRET_NAME', default: 'fleet_bridge_azdevops_pat' },
          flags,
        );
        const requiredCredentials = [...new Set([secretName, ...explicitRequiredCredentials].filter(Boolean))];
        return {
          member: flags.get('member'),
          repo: (repoLocalPath || repoRemoteUrl) ? { localPath: repoLocalPath, remoteUrl: repoRemoteUrl } : undefined,
          baseBranch: flags.get('base-branch'),
          requiredCredentials,
          playbooksDir: flags.get('playbooks-dir'),
          spawn: flags.get('spawn'),
        };
      },
      // A failed check is DATA inside runPreflight (preflight.mjs, "THROW vs.
      // REPORT"), which is right for the report -- but with no mapping here the
      // PROCESS still exited 0, so a pipeline step running preflight went green
      // on `"ok": false` and the next step launched anyway. The report is still
      // printed in full; only the exit status now tells the truth.
      exitCodeForResult(result) {
        return result && result.ok === false ? exitCodeFor(BRIDGE_ERROR_CODES.PREFLIGHT_FAILED) : 0;
      },
      async buildDeps(opts, c, flags) {
        const { fleetApi, callTool } = await c.mcp();
        const beads = await c.beadsClientFor({
          memberName: opts.member,
          callTool,
          repoLocalPath: opts.repo && opts.repo.localPath,
        });
        return {
          supervisorClient: await c.supervisorClient(flags),
          beads,
          fleetApi,
          git: c.git,
          fs: c.fs,
          log: c.log,
        };
      },
    },

    // -----------------------------------------------------------------
    ingest: {
      run: runIngest,
      needsMcp: true,
      longLived: false,
      async buildOpts(flags, _positionals, c) {
        const refsRaw = requireFlag(flags, 'refs', { pipelineParam: 'workItems' });
        const refs = refsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const secretName = await c.configValue(
          { name: 'secretName', flagName: 'secret-name', envVar: 'FLEET_BRIDGE_SECRET_NAME', default: 'fleet_bridge_azdevops_pat' },
          flags,
        );
        return {
          refs,
          secretName,
          allowMissingCriteria: flags.get('allow-missing-criteria') === true,
          requireCriteria: flags.has('require-criteria') ? flags.get('require-criteria') !== false : undefined,
          epicTitle: flags.get('epic-title'),
        };
      },
      async buildDeps(_opts, c, flags) {
        const platform = await c.configValue({ name: 'platform', envVar: 'FLEET_BRIDGE_PLATFORM', default: 'azure-devops' }, flags);
        const member = await c.configValue({ name: 'member', envVar: 'FLEET_BRIDGE_MEMBER' }, flags);
        const { callTool } = await c.mcp();
        // `ingest` has no SprintRequest/handle yet (that's what launch, the
        // NEXT verb, creates) -- its only source for the repo the beads DB
        // lives in is the same `--repo-local-path` flag preflight reads.
        const beads = await c.beadsClientFor({ memberName: member, callTool, repoLocalPath: repoLocalPathFor(undefined, flags) });
        // The supervisor is wired in so `resolveRoot`'s reparent guard can
        // ask which issue roots are currently RESERVED. Without it ingest
        // still runs, but it can only warn -- and a re-ingest with a changed
        // ref list reparents beads onto a new root, which silently shrinks
        // the scope of a sprint that is already running (the supervisor
        // re-expands scope by live BFS from its issue roots, so beads moving
        // out from under it are simply gone). Injected here rather than
        // constructed inside the verb because `bin/` is the only place that
        // builds real I/O.
        return {
          beads,
          adapter: c.adapterFor(platform),
          supervisorClient: await c.supervisorClient(flags),
          log: c.log,
        };
      },
    },

    // -----------------------------------------------------------------
    launch: {
      run: runLaunch,
      needsMcp: false,
      longLived: false,
      async buildOpts(flags, _positionals, c) {
        const requestFile = flags.get('request-file');
        const requestJson = flags.get('request-json');
        let request;
        // Read/parse failures are BridgeErrors naming the flag: a raw ENOENT or
        // SyntaxError used to escape to the exit-1 catch-all with no hint of
        // which input was wrong.
        const parseRequest = (raw, source) => {
          try {
            return JSON.parse(raw);
          } catch (err) {
            throw new BridgeError(
              BRIDGE_ERROR_CODES.CONFIG_INVALID,
              `launch: ${source} is not valid JSON: ${safeMessage(err)}`,
              { flag: requestFile ? 'request-file' : 'request-json' },
            );
          }
        };
        if (requestFile) {
          let raw;
          try {
            raw = await c.fs.readFile(requestFile, 'utf-8');
          } catch (err) {
            throw new BridgeError(
              BRIDGE_ERROR_CODES.CONFIG_INVALID,
              `launch: could not read --request-file "${requestFile}": ${safeMessage(err)}`,
              { flag: 'request-file' },
            );
          }
          request = parseRequest(raw, `--request-file "${requestFile}"`);
        } else if (typeof requestJson === 'string') {
          request = parseRequest(requestJson, '--request-json');
        } else {
          throw new BridgeError(
            BRIDGE_ERROR_CODES.CONFIG_MISSING,
            'launch: one of --request-file <path.json> or --request-json <json> is required (the SprintRequest fields to validate and post)',
            { flag: 'request-file' },
          );
        }
        return {
          request,
          syntheticRootId: flags.get('synthetic-root-id'),
          awaitUntil: flags.get('await-until'),
          overrideRelaunchGate: flags.get('override-relaunch-gate') === true,
          timeoutMs: flags.has('timeout-ms') ? Number(flags.get('timeout-ms')) : undefined,
          pollMs: flags.has('poll-ms') ? Number(flags.get('poll-ms')) : undefined,
          // Left undefined when absent so launch.mjs owns the default
          // ('daemon') in exactly one place.
          watcher: flags.get('watcher'),
          watcherTimeoutMs: flags.has('watcher-timeout-ms') ? Number(flags.get('watcher-timeout-ms')) : undefined,
        };
      },
      async buildDeps(_opts, c, flags) {
        return {
          supervisorClient: await c.supervisorClient(flags),
          spool: await c.spool(flags),
          sleep: c.clock.sleep,
          now: c.clock.now,
          // The watcher check (launch.mjs, "WHY LAUNCH CONFIRMS A WATCHER")
          // uses the same liveness probe the daemon uses on its own claims.
          isAlive: c.isAliveFn,
          log: c.log,
        };
      },
      // The await outcome's `color` decides the exit colour
      // (implementation-plan.md's "--await-until": reached/timeout are green,
      // terminal-before-milestone is red) -- launch itself never throws for a
      // 'red' outcome (module header, "never a stop"), so this is the one
      // place that turns it into a process exit code: LAUNCH_FAILED's bucket
      // (5), the closest existing code for "the sprint went terminal before
      // the requested milestone". UNDER-SPECIFIED: no doc pins an exact exit
      // code for this case; see this task's final report.
      //
      // A launch no watcher claimed (`result.watcher.ok === false`) exits in the
      // same bucket: the sprint is running, but in a state where its carry-over
      // would silently never be published -- see launch.mjs's header. The JSON
      // result (with the handle) is printed first either way.
      exitCodeForResult(result) {
        if (result && result.color === 'red') return exitCodeFor(BRIDGE_ERROR_CODES.LAUNCH_FAILED);
        if (result && result.watcher && result.watcher.ok === false) return exitCodeFor(BRIDGE_ERROR_CODES.LAUNCH_FAILED);
        return 0;
      },
    },

    // -----------------------------------------------------------------
    watch: {
      run: runWatch,
      needsMcp: true,
      longLived: false,
      async buildOpts(flags) {
        const sprintId = requireFlag(flags, 'sprint-id', { pipelineParam: 'sprintId' });
        return {
          sprintId,
          giveUpMs: flags.has('give-up-ms') ? Number(flags.get('give-up-ms')) : undefined,
          logTailLines: flags.has('log-tail-lines') ? Number(flags.get('log-tail-lines')) : undefined,
        };
      },
      async buildDeps(opts, c, flags) {
        const spool = await c.spool(flags);
        const doc = await spool.read(opts.sprintId);
        const handle = doc && doc.handle;
        const mcpConn = await c.mcp();
        return buildObservabilityDeps({ sprintId: opts.sprintId, handle }, c, flags, mcpConn);
      },
    },

    // -----------------------------------------------------------------
    finalize: {
      run: runFinalize,
      needsMcp: true,
      longLived: false,
      async buildOpts(flags, _positionals, c) {
        const sprintId = requireFlag(flags, 'sprint-id', { pipelineParam: 'sprintId' });
        const spool = await c.spool(flags);
        const doc = await spool.read(sprintId);
        if (!doc || !doc.handle) {
          throw new BridgeError(
            BRIDGE_ERROR_CODES.CONFIG_INVALID,
            `finalize: no spool handle found for sprint "${sprintId}" -- launch must run (and persist its handle) before finalize`,
            { sprintId },
          );
        }
        const secretName = await c.configValue(
          { name: 'secretName', flagName: 'secret-name', envVar: 'FLEET_BRIDGE_SECRET_NAME', pipelineParam: 'adoPatSecretName', default: 'fleet_bridge_azdevops_pat' },
          flags,
        );
        return {
          handle: doc.handle,
          secretName,
          dryRun: flags.get('dry-run') === true,
          maxCarryOver: flags.has('max-carry-over') ? Number(flags.get('max-carry-over')) : undefined,
        };
      },
      async buildDeps(opts, c, flags) {
        const mcpConn = await c.mcp();
        const { deps } = await buildFinalizeCollaborators(opts.handle, c, flags, mcpConn);
        return deps;
      },
    },

    // -----------------------------------------------------------------
    status: {
      run: runStatus,
      needsMcp: false,
      longLived: false,
      async buildOpts(flags) {
        const sprintId = requireFlag(flags, 'sprint-id', { pipelineParam: 'sprintId' });
        return {
          sprintId,
          logTailLines: flags.has('log-tail-lines') ? Number(flags.get('log-tail-lines')) : undefined,
        };
      },
      async buildDeps(_opts, c, flags) {
        // spool/fs are OPTIONAL collaborators for status.mjs (its own
        // validateStatusDeps() degrades cleanly without either) -- wired in
        // here so the real CLI gets the fix for the "supervisor forgot the
        // sprint" incident (status.mjs's file header): the spooled handle,
        // and its logPath read straight off disk, are what let a detached
        // sprint's true outcome (failed/completed) survive the supervisor's
        // own bookkeeping forgetting the process.
        return {
          supervisorClient: await c.supervisorClient(flags),
          now: c.clock.now,
          log: c.log,
          spool: await c.spool(flags),
          fs: c.fs,
        };
      },
    },

    // -----------------------------------------------------------------
    daemon: {
      needsMcp: true,
      longLived: true,
      async buildOpts(flags) {
        return {
          scanIntervalMs: flags.has('scan-interval-ms') ? Number(flags.get('scan-interval-ms')) : undefined,
          pid: process.pid,
          host: os.hostname(),
        };
      },
      async buildDeps(_opts, c, flags) {
        const mcpConn = await c.mcp();

        // Thin, pre-bound closures per daemon.mjs's contract -- NOT the real
        // verbs' own (opts, deps) signatures (see file header). Each closure
        // rebuilds that sprint's own real deps from its handle, and shares
        // the exact same collaborator-building logic the direct `watch`/
        // `finalize` table entries use (buildObservabilityDeps /
        // buildFinalizeCollaborators), so there is exactly one place that
        // logic lives.
        const runWatchBound = (handle, signal) => buildObservabilityDeps(
          { sprintId: handle.sprintId, handle }, c, flags, mcpConn,
        ).then((deps) => runWatch({ sprintId: handle.sprintId }, { ...deps, signal }));

        const runFinalizeBound = (handle) => buildFinalizeCollaborators(handle, c, flags, mcpConn)
          .then(({ deps, secretName }) => runFinalize({ handle, secretName }, deps));

        return {
          spool: await c.spool(flags),
          runWatch: runWatchBound,
          runFinalize: runFinalizeBound,
          sleep: c.clock.sleep,
          now: c.clock.now,
          isAlive: c.isAliveFn,
          log: c.log,
        };
      },
      /** Not `runDaemon(opts, deps)` -- `createDaemon` returns `{start, stop,
       *  tracked}`; this wraps it so every table entry has the uniform
       *  "run resolves to a result the dispatcher can act on" shape, and so
       *  `longLived` handling (below) can call `.stop()` on whatever `run`
       *  resolves to for ANY long-lived verb, daemon or viewer alike. */
      async run(opts, deps) {
        const daemon = createDaemon(opts, deps);
        await daemon.start();
        return { stop: daemon.stop, get tracked() { return daemon.tracked; } };
      },
    },

    // -----------------------------------------------------------------
    viewer: {
      run: runViewer,
      needsMcp: false,
      longLived: true,
      async buildOpts(flags) {
        return {
          listenHost: flags.get('listen-host'),
          listenPort: flags.has('listen-port') ? Number(flags.get('listen-port')) : undefined,
          upstreamHost: flags.get('upstream-host'),
          upstreamPort: flags.has('upstream-port') ? Number(flags.get('upstream-port')) : undefined,
        };
      },
      async buildDeps(_opts, c) {
        return {
          readTokenFile: c.readTokenFile,
          createServer: c.createServer,
          logger: console,
          log: c.log,
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// dispatch() -- the actual dispatcher. Never imports a verb module directly;
// only ever calls through `table`. See the file header for why this shape is
// what makes the composition-root smoke test possible.
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   argv: string[],                    - full process.argv-shaped array (argv[0]/[1] ignored, verb starts at [2]).
 *   table: ReturnType<typeof buildVerbTable>,
 *   ctx: object,
 *   exit?: (code: number) => any,      - injectable; defaults to process.exit.
 *   out?: (msg: string) => void,
 *   err?: (msg: string) => void,
 *   waitForLongLived?: boolean,        - default true; a test sets this false so
 *                                        `daemon`/`viewer` don't block forever
 *                                        waiting for a SIGINT that will never come.
 *   signalTarget?: { once?: Function },- default `process`; a test injects a fake
 *                                        emitter so SIGINT/SIGTERM handlers never
 *                                        attach to the real test-runner process.
 * }} params
 * @returns {Promise<number>} the exit code (also passed to `exit`).
 */
export async function dispatch({
  argv,
  table,
  ctx,
  exit = (code) => process.exit(code),
  out = (msg) => console.log(msg),
  err = (msg) => console.error(msg),
  waitForLongLived = true,
  signalTarget = process,
} = {}) {
  const rawArgs = argv.slice(2);
  const { verb, flags, positionals } = parseArgs(rawArgs);

  // --version and --help/-h/no-verb are checked before anything else looks
  // at `table` -- neither one may ever require a live fleet server (or even
  // a valid verb) to answer. --version is checked FIRST: with no verb given,
  // `--version` is parsed as a flag (verb stays undefined), so testing
  // "no verb" before "--version" would silently swallow it into the usage
  // branch below.
  if (flags.get('version') === true) {
    out(pkg.version);
    exit(0);
    return 0;
  }
  if (verb === undefined || verb === '-h' || flags.get('help') === true) {
    out(usage());
    exit(0);
    return 0;
  }

  const entry = table[verb];
  if (!entry) {
    err(`fleet-bridge: unknown verb '${verb}'\n`);
    err(usage());
    exit(2);
    return 2;
  }

  try {
    // Strict flags, from the one per-verb declaration in src/cli/flags.mjs:
    // an unknown flag, a stray positional, or a mistyped boolean is a USAGE
    // error here, before anything runs; and the verb only ever sees a view of
    // the flags that refuses to answer for a name it did not declare. See
    // that file's header for why a silently ignored flag is a defect.
    const checkedFlags = declaredFlagsView(verb, assertKnownFlags(verb, flags, positionals));
    const opts = await entry.buildOpts(checkedFlags, positionals, ctx);
    const deps = await entry.buildDeps(opts, ctx, checkedFlags);
    const result = await entry.run(opts, deps);

    if (entry.longLived) {
      let stopped = false;
      const shutdown = async () => {
        if (stopped) return;
        stopped = true;
        try {
          if (result && typeof result.stop === 'function') await result.stop();
        } catch (stopErr) {
          err(`fleet-bridge: error while stopping: ${safeMessage(stopErr)}`);
        }
        exit(0);
      };
      if (signalTarget && typeof signalTarget.once === 'function') {
        signalTarget.once('SIGINT', shutdown);
        signalTarget.once('SIGTERM', shutdown);
      }
      if (!waitForLongLived) {
        // Test seam only (see this param's doc comment): the verb started
        // successfully and SIGINT/SIGTERM are wired above exactly as in
        // production -- this only skips the "block forever" wait so a test
        // process doesn't hang. The exit code is still reported.
        exit(0);
        return 0;
      }
      await new Promise(() => {}); // blocks until shutdown() above calls exit()
      return 0;
    }

    const exitCode = typeof entry.exitCodeForResult === 'function' ? entry.exitCodeForResult(result) : 0;
    if (result !== undefined) {
      try {
        out(JSON.stringify(result, null, 2));
      } catch {
        out(String(result));
      }
    }
    exit(exitCode);
    return exitCode;
  } catch (thrown) {
    if (thrown instanceof BridgeError) {
      err(`fleet-bridge: ${thrown.message}`);
      if (thrown.details && thrown.details.remedy) err(`remedy: ${thrown.details.remedy}`);
      const code = exitCodeFor(thrown);
      exit(code);
      return code;
    }
    err(`fleet-bridge: ${safeMessage(thrown)}`);
    exit(1);
    return 1;
  }
}

export async function main(argv = process.argv) {
  const ctx = createRealContext({ env: process.env });
  const table = buildVerbTable(ctx);
  return dispatch({ argv, table, ctx });
}

// ---------------------------------------------------------------------------
// Self-execution guard -- mirrors packages/apra-fleet-se/bin/cli.mjs's own
// isMainModule(), including the NODE_TEST_CONTEXT check: `node --test`
// (test/composition-root.test.mjs imports this module directly to reach
// `buildVerbTable`/`dispatch`/`createRealContext`) sets NODE_TEST_CONTEXT in
// the process evaluating this file and leaves process.argv[1] pointing at
// it, so WITHOUT this guard importing this module for its exports would also
// run the real CLI against the test runner's own argv and call
// `process.exit()` mid-suite.
// ---------------------------------------------------------------------------

function isMainModule() {
  try {
    if (process.env.NODE_TEST_CONTEXT) return false;
    if (process.argv[1] === undefined) return false;
    const invokedUrl = pathToFileURL(process.argv[1]).href;
    if (import.meta.url === invokedUrl) return true;
    try {
      const realInvokedUrl = pathToFileURL(realpathSync(process.argv[1])).href;
      const realModuleUrl = pathToFileURL(realpathSync(__filename)).href;
      return realInvokedUrl === realModuleUrl;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
