#!/usr/bin/env node
// =============================================================================
// `fleet-se-pr` -- open a pull request for an ARBITRARY head/base branch
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Every pull request this package raises already goes over the hosting
// provider's REST "create pull request" route: the provider descriptor builds
// the request (see fleet-sprint/vcs-providers/*.mjs) and raiseVcsPrForMember()
// (fleet-sprint/vcs-auth.mjs) mints a just-in-time push+pr credential and
// dispatches it through the server-side credential handoff. Until now that
// capability was only reachable from INSIDE sprint finalization, so anyone who
// needed a PR for a branch that was not a sprint branch had no supported entry
// point and reached for `gh pr create` instead.
//
// `gh pr create` issues the GraphQL `createPullRequest` mutation, which is
// commonly refused for a GitHub App installation token even when that same
// token holds pull_requests write over REST. The refusal reads like a missing
// permission, so the caller concludes PR creation is impossible and reports a
// permission block -- costing a full review cycle. See
// docs/vcs-graphql-vs-rest.md.
//
// SURFACE CHOICE (and why -- recorded here per the task that added this file)
// --------------------------------------------------------------------------
// This is a CLI, NOT a new fleet MCP tool. Three reasons:
//   1. The capability it exposes is entirely orchestrator-side composition of
//      things the fleet server ALREADY exposes (provision_vcs_auth +
//      vcs_credential_exec). A new MCP tool would add a second server-side
//      surface for a request the server can already serve, and would drag the
//      client wrapper, its schema and the conformance suite along with it for
//      no new server capability.
//   2. The caller is a human or an agent at a shell, mid-task, who wants one
//      non-interactive command -- the same ergonomic slot `gh pr create`
//      occupies. It has to be at least as easy to reach as the wrong answer.
//   3. Keeping it a CLI means ZERO change to src/tools/* and therefore zero
//      required change to packages/apra-fleet-client.
//
// It reuses raiseVcsPrForMember() rather than re-implementing PR creation, so
// there is exactly ONE create-pull-request code path in this package: the
// REST one, with its idempotent 422 "already exists" handling, its bounded
// one-shot auth self-heal and its provider-agnostic response mapping.
//
// USAGE (copy-pasteable, for a branch that has nothing to do with any sprint)
// --------------------------------------------------------------------------
//   fleet-se-pr --member my-dev-box \
//               --base main \
//               --head fix/some-side-branch \
//               --title "fix: handle key rotation timeout" \
//               --body "Closes the rotation race described in the issue."
//
// Nothing about a sprint is required: no sprint branch, no sprint state file,
// no in-flight run. `--repo owner/name` and `--remote <url>` are optional; when
// omitted, both are derived from the `origin` remote of the git checkout this
// command is run in (override the checkout with `--cwd`).
//
// Exit codes:
//   0 = PR created, or a PR for this head already existed (idempotent success)
//   1 = usage error (missing/invalid arguments, --help on a bad invocation)
//   2 = operational failure (fleet server unreachable, PR creation refused)
// =============================================================================

import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import {
    resolveFleetServerConnection,
    getServerInfoPath,
} from '@apralabs/apra-fleet-client/server-resolution';
import { raiseVcsPrForMember, parseOwnerRepoFromRemoteUrl } from '../fleet-sprint/vcs-auth.mjs';

const execFileAsync = promisify(execFile);

export const USAGE = `fleet-se-pr -- open a pull request for any head/base branch over the hosting
provider's REST create-pull-request route (never the GraphQL mutation that a
GitHub App installation token is commonly refused on).

USAGE
  fleet-se-pr --member <name> --base <branch> --head <branch> --title <text>
              [--body <text>] [--repo <owner/name>] [--remote <url>]
              [--cwd <dir>] [--quiet]

REQUIRED
  --member <name>    Registered fleet member that dispatches the REST call.
  --base <branch>    Branch the pull request merges INTO.
  --head <branch>    Branch carrying the changes. Must already be pushed.
  --title <text>     Pull request title.

OPTIONAL
  --body <text>      Pull request description. Default: empty.
  --repo <owner/name>
                     Repository coordinates. Default: derived from --remote.
  --remote <url>     Remote URL to derive the repository from. Default: the
                     'origin' remote of the checkout named by --cwd.
  --cwd <dir>        Checkout to read the 'origin' remote from. Default: the
                     current working directory.
  --quiet            Suppress progress logging; print only the result.
  --help             Print this text and exit 0.

NOTES
  This does not require a sprint: no sprint branch, no sprint state, no
  in-flight run. It does require a reachable fleet server and a member that is
  registered against the target host, because the credential is read and
  substituted server-side and never transits this process.

  A non-2xx response is reported as a failure with its HTTP status and response
  body; it is never downgraded to an advisory warning. An existing pull request
  for the same head is reported as an idempotent success.

EXAMPLE
  fleet-se-pr --member my-dev-box \\
              --base main \\
              --head fix/some-side-branch \\
              --title "fix: handle key rotation timeout" \\
              --body "Closes the rotation race described in the issue."
`;

/**
 * Check if this module is being run directly (not imported as a library).
 * Handles Windows realpath / argv[1] edge cases the same way bin/cli.mjs does.
 *
 * @returns {boolean}
 */
function isMainModule() {
    try {
        if (process.env.NODE_TEST_CONTEXT) return false;
        if (process.argv[1] === undefined) return false;
        const invokedUrl = pathToFileURL(process.argv[1]).href;
        const moduleUrl = import.meta.url;
        if (moduleUrl === invokedUrl) return true;
        try {
            const realInvokedUrl = pathToFileURL(realpathSync(process.argv[1])).href;
            const realModuleUrl = pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
            return realInvokedUrl === realModuleUrl;
        } catch {
            return false;
        }
    } catch {
        return false;
    }
}

/**
 * Read the 'origin' remote URL of a git checkout.
 *
 * Runs in THIS process rather than on the member, because the head branch a
 * caller wants a PR for lives in the checkout they are standing in, which is
 * not necessarily any member's workspace. Best-effort: an unreadable remote
 * yields '' and the caller must then supply --repo explicitly.
 *
 * @param {string} cwd
 * @param {(cmd: string, args: string[], opts: object) => Promise<{stdout: string}>} [runner]
 * @returns {Promise<string>}
 */
export async function readOriginRemote(cwd, runner = execFileAsync) {
    try {
        const { stdout } = await runner('git', ['remote', 'get-url', 'origin'], { cwd });
        return String(stdout || '').trim();
    } catch {
        return '';
    }
}

/**
 * Turn parsed CLI flags into the argument set openSideBranchPullRequest()
 * needs, resolving the repository from --repo, then --remote, then the
 * 'origin' remote of --cwd. Pure apart from the injected remote reader, so
 * the resolution order is unit-testable without a fleet server.
 *
 * @param {object} values parsed --flag values
 * @param {{ readRemote?: (cwd: string) => Promise<string> }} [deps]
 * @returns {Promise<{ ok: true, resolved: object } | { ok: false, error: string }>}
 */
export async function resolvePrInputs(values, deps = {}) {
    const readRemote = deps.readRemote || readOriginRemote;
    const required = ['member', 'base', 'head', 'title'];
    const missing = required.filter((name) => !String(values[name] || '').trim());
    if (missing.length > 0) {
        return {
            ok: false,
            error: `missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}`,
        };
    }

    const cwd = String(values.cwd || process.cwd());
    let remoteUrl = String(values.remote || '').trim();
    if (!remoteUrl) remoteUrl = await readRemote(cwd);

    let repo = String(values.repo || '').trim();
    if (!repo) {
        if (!remoteUrl) {
            return {
                ok: false,
                error: 'could not determine the repository: --repo was not given, --remote was not given, '
                    + `and no 'origin' remote could be read from '${cwd}'. Pass --repo owner/name.`,
            };
        }
        repo = parseOwnerRepoFromRemoteUrl(remoteUrl) || '';
        if (!repo) {
            return {
                ok: false,
                error: `could not derive owner/repo from remote URL '${remoteUrl}'. Pass --repo owner/name.`,
            };
        }
    }

    return {
        ok: true,
        resolved: {
            member: String(values.member).trim(),
            base: String(values.base).trim(),
            head: String(values.head).trim(),
            title: String(values.title),
            body: values.body === undefined ? '' : String(values.body),
            repo,
            remoteUrl,
        },
    };
}

/**
 * Open a pull request for an arbitrary head/base pair.
 *
 * Delegates ENTIRELY to raiseVcsPrForMember() -- the same helper sprint
 * finalization uses -- so the REST create-pull-request command is built by the
 * resolved provider's own builder and dispatched through the server-side
 * credential handoff. There is deliberately no second PR-creation path here,
 * and no `gh`/GraphQL call anywhere in this file.
 *
 * `fleetApi` and `command` are injected so this is testable against a stubbed
 * dispatcher with no network call and no live credential.
 *
 * @param {object} opts
 * @param {object} opts.fleetApi ApraFleet client (needs vcsCredentialExec)
 * @param {Function} opts.command member-bound command dispatcher
 * @param {string} opts.member registered fleet member to dispatch from
 * @param {string} opts.base branch the PR merges into
 * @param {string} opts.head branch carrying the changes
 * @param {string} opts.title PR title
 * @param {string} [opts.body] PR description
 * @param {string} [opts.remoteUrl] remote URL the repository was derived from
 * @param {Function} [opts.log]
 * @returns {Promise<{ ok: boolean, alreadyExists: boolean, prUrl: string|null, error: string|null, authFailure: boolean }>}
 */
export async function openSideBranchPullRequest({
    fleetApi,
    command,
    member,
    base,
    head,
    title,
    body = '',
    remoteUrl,
    log = () => {},
}) {
    if (!fleetApi || typeof fleetApi.vcsCredentialExec !== 'function') {
        return {
            ok: false,
            alreadyExists: false,
            prUrl: null,
            error: 'no fleet client with a vcs_credential_exec tool is available -- cannot dispatch a '
                + 'create-pull-request request without the server-side credential handoff.',
            authFailure: false,
        };
    }
    return raiseVcsPrForMember({
        fleetApi,
        command,
        member,
        base,
        head,
        title,
        body,
        log,
        logPrefix: '[Open PR]',
        // Supplying the remote we already resolved keeps this workspace-
        // independent: raiseVcsPrForMember never shells a 'git remote get-url
        // origin' at `member`, which may have no checkout of this repo at all.
        remoteUrlOverride: remoteUrl || undefined,
    });
}

/**
 * Build the member-bound `command` dispatcher raiseVcsPrForMember expects,
 * backed by the fleet's execute_command tool. Only reached on the fallback
 * path where no remote URL was resolved locally; the normal path passes
 * `remoteUrlOverride` and never dispatches a command at all.
 *
 * @param {object} fleetApi
 * @returns {(cmd: string, opts: object) => Promise<{ ok: boolean, output: string, error: string }>}
 */
export function createCommandDispatcher(fleetApi) {
    return async function command(cmd, opts = {}) {
        try {
            const res = await fleetApi.executeCommand({
                member_name: opts.member_name,
                command: cmd,
            });
            const blocks = Array.isArray(res && res.content) ? res.content : [];
            const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
            return { ok: true, output: text, error: '' };
        } catch (err) {
            if (opts.failSoft) return { ok: false, output: '', error: err.message };
            throw err;
        }
    };
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @param {object} [deps] injectable for tests: { connect, log, error }
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, deps = {}) {
    const out = deps.log || ((line) => process.stdout.write(`${line}\n`));
    const fail = deps.error || ((line) => process.stderr.write(`${line}\n`));

    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                member: { type: 'string' },
                base: { type: 'string' },
                head: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
                repo: { type: 'string' },
                remote: { type: 'string' },
                cwd: { type: 'string' },
                quiet: { type: 'boolean', default: false },
                help: { type: 'boolean', default: false },
            },
            allowPositionals: false,
        }));
    } catch (parseErr) {
        fail(`Error: ${parseErr.message}`);
        fail(USAGE);
        return 1;
    }

    if (values.help) {
        out(USAGE);
        return 0;
    }

    const inputs = await resolvePrInputs(values, deps);
    if (!inputs.ok) {
        fail(`Error: ${inputs.error}`);
        fail(USAGE);
        return 1;
    }
    const resolved = inputs.resolved;
    const log = values.quiet ? () => {} : (line) => out(line);

    let fleetApi = deps.fleetApi || null;
    if (!fleetApi) {
        const connection = await resolveFleetServerConnection();
        if (connection.mode !== 'http') {
            fail(
                'Error: no reachable apra-fleet HTTP server was found, so the server-side credential '
                + `handoff this command depends on cannot run -- resolution said: "${connection.reason}". `
                + `Start the fleet server ('apra-fleet start' or 'apra-fleet install'), or check `
                + `${getServerInfoPath()} (pid alive + GET /health).`,
            );
            return 2;
        }
        const transport = new StreamableHttpTransport(connection.url);
        await transport.start();
        fleetApi = new ApraFleet(new McpClient(transport));
    }

    const command = deps.command || createCommandDispatcher(fleetApi);

    log(`Opening a pull request on ${resolved.repo}: ${resolved.head} -> ${resolved.base} (member: ${resolved.member}).`);
    const result = await openSideBranchPullRequest({
        fleetApi,
        command,
        member: resolved.member,
        base: resolved.base,
        head: resolved.head,
        title: resolved.title,
        body: resolved.body,
        remoteUrl: resolved.remoteUrl,
        log,
    });

    if (!result.ok) {
        // Loud and explicit: the HTTP status and response body raiseVcsPrForMember
        // captured are surfaced verbatim, and the exit code reports failure. This
        // is never downgraded to an advisory warning.
        fail(`Error: could not open a pull request for '${resolved.head}' -> '${resolved.base}' on ${resolved.repo}: ${result.error}`);
        if (result.authFailure) {
            fail(
                'This was classified as a credential/permission failure. Note that the REST route used here '
                + 'is NOT the GraphQL createPullRequest mutation -- see docs/vcs-graphql-vs-rest.md.',
            );
        }
        return 2;
    }

    if (result.alreadyExists) {
        out(`[OK] a pull request for '${resolved.head}' already exists${result.prUrl ? `: ${result.prUrl}` : ''} -- treating as success.`);
        return 0;
    }
    out(`[OK] pull request opened${result.prUrl ? `: ${result.prUrl}` : ''}`);
    return 0;
}

if (isMainModule()) {
    main(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code;
        })
        .catch((err) => {
            process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`);
            process.exitCode = 2;
        });
}
