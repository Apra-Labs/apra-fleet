import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRealBitbucketE2eConfig } from './helpers/bitbucket-real-e2e.mjs';

// Low-level MCP client pieces -- see azure-devops-real-e2e.test.mjs's own
// doc comment for why @apralabs/apra-fleet-client's own createWorkflowEngine()
// helper cannot be used here.
import { StdioTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';

// Reused, not re-implemented: the SAME provider-dispatched command builders
// runner.js's real "Publish PR" step calls (buildCreatePrCommand,
// parseProviderRepoRef, getVcsProvider) and the same credential-read command
// builder it uses to learn the just-provisioned app password
// (buildCredentialReadCommand) -- see fleet-sprint/runner.js's
// raiseVcsPrForMember/readMemberVcsCredentialToken for the production call
// site this scenario mirrors at the VCSModule level.
import { buildCreatePrCommand, parseProviderRepoRef, getVcsProvider } from '../fleet-sprint/vcs-module.mjs';
import { buildCredentialReadCommand } from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-qeq1.6.1 -- the opt-in REAL Bitbucket end-to-end scenario,
// mirroring azure-devops-real-e2e.test.mjs.
//
// This is the one scenario gated by bitbucket-real-e2e.mjs's
// resolveRealBitbucketE2eConfig() (see bitbucket-real-e2e-harness.test.mjs
// for the always-on unit coverage of the gate itself). It is the only place
// in this package that actually performs the three steps documented in
// helpers/bitbucket-real-e2e-runbook.md's "Verify" and "E2E pass criterion"
// sections against a REAL Bitbucket workspace:
//
//   1. provision_vcs_auth for bitbucket (email/workspace plain, app password
//      resolved from the fleet credential store via a {{secret.<name>}}
//      placeholder -- this file never reads or logs the app password's
//      plaintext value itself);
//   2. `git ls-remote` against the designated test repo, to prove the
//      provisioned credential actually authenticates;
//   3. the publish path -- create a branch with a real change, push it, then
//      build+dispatch the actual Bitbucket create-pull-request REST call
//      (VCSModule's buildCreatePrCommand, the same builder runner.js's
//      "Publish PR" step calls, carrying BOTH the username and token halves)
//      and assert a pull request URL comes back.
//
// Every step is dispatched over a REAL MCP connection to a REAL apra-fleet
// server (spawned via `apra-fleet run --transport stdio`, i.e. dist/index.js
// --stdio -- the exact production stdio entry point), using a throwaway
// LOCAL fleet member registered and torn down by this scenario itself.
// Nothing here re-derives provision_vcs_auth's or execute_command's
// behavior -- it calls the real tools exactly the way any MCP client
// (including fleet-sprint's own runner.js) would.
//
// DEFAULT BEHAVIOR: with the enable flag unset (the default), this whole
// file does exactly one thing -- report resolveRealBitbucketE2eConfig()'s
// skip message via node:test's `{ skip }` option -- and performs no network
// I/O, no member registration, no server spawn.
//
// OUTSTANDING LIVE CHECK: this scenario has not been run against a real
// Bitbucket workspace in this dispatch. Recorded as outstanding on this
// bead's notes and on the epic apra-fleet-qeq1's notes.
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dist/index.js is built at the repo root -- this scenario spawns that SAME
// production entry point, not a re-implementation of the server, so an
// operator running it exercises the exact binary that ships. Requires
// `npm run build` at the repo root first.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.js');

const BITBUCKET_CREDENTIAL_LABEL = 'bitbucket';

/**
 * Starts a real apra-fleet MCP server over stdio and returns a connected
 * ApraFleet client plus a stop() to tear the server process down. Mirrors
 * azure-devops-real-e2e.test.mjs's startFleetClient() -- see that file's doc
 * comment for why the lower-level StdioTransport/McpClient/ApraFleet
 * exports are used directly instead of a higher-level factory helper.
 */
async function startFleetClient() {
    if (!fs.existsSync(DIST_INDEX)) {
        throw new Error(
            `Real Bitbucket E2E: ${DIST_INDEX} does not exist -- run "npm run build" at the repo root first ` +
            `(this scenario spawns the real apra-fleet stdio server, not a re-implementation of it).`,
        );
    }
    const transport = new StdioTransport(process.execPath, [DIST_INDEX, '--stdio']);
    transport.start();
    const mcpClient = new McpClient(transport);
    await mcpClient.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'apra-fleet-real-bitbucket-e2e', version: '1.0.0' },
    });
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const apraFleet = new ApraFleet(mcpClient);
    return { apraFleet, stop: () => transport.stop() };
}

/** Every fleet tool that returns a plain string (register_member,
 *  provision_vcs_auth, remove_member) is delivered over MCP as
 *  `content[0].text` -- mirrors fleet-sprint/mcp-result.mjs's own resultText(). */
function toolText(result) {
    if (typeof result === 'string') return result;
    if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
        return result.content[0].text;
    }
    return '';
}

/** execute_command's structured stdout -- mirrors mock-sprint-harness.mjs's
 *  mockCmdResult()/production src/tools/execute-command.ts's
 *  ExecuteCommandResult shape (`{ content, structuredContent }`). */
function commandStdout(result) {
    if (result && result.structuredContent && typeof result.structuredContent.stdout === 'string') {
        return result.structuredContent.stdout;
    }
    return toolText(result);
}

function assertToolSucceeded(result, label) {
    assert.ok(!(result && result.isError), `${label} failed: ${toolText(result)}`);
}

// provision_vcs_auth/register_member/remove_member never throw on failure --
// they return plain text starting with the failure emoji.
function assertNotFailureText(text, label) {
    assert.ok(!/^\u274c/.test(text.trim()), `${label} reported failure: ${text}`);
}

test(
    'real Bitbucket E2E: provision -> ls-remote verify -> publish a real pull request',
    { skip: realBitbucketE2eSkipMessage(), timeout: 10 * 60 * 1000 },
    async () => {
        const cfg = resolveRealBitbucketE2eConfig();
        assert.equal(cfg.skip, false, 'test body must only run when resolveRealBitbucketE2eConfig() reports skip:false');

        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-bb-e2e-'));
        const memberName = `bb-e2e-${Date.now()}`;
        const headBranch = `apra-fleet-e2e/${Date.now()}`;
        const checkoutDir = path.join(workDir, 'repo-checkout');

        const providerRef = parseProviderRepoRef(cfg.remoteUrl);
        assert.ok(providerRef && !providerRef.error, `expected parseProviderRepoRef(${cfg.remoteUrl}) to resolve Bitbucket coordinates, got: ${providerRef && providerRef.error}`);

        const { apraFleet, stop } = await startFleetClient();
        let memberRegistered = false;
        try {
            // --- register a throwaway LOCAL member: a plain command
            // executor (llm_provider: 'none'), never shared with any real
            // sprint, torn down in the finally block below. ---
            const registerText = toolText(await apraFleet.registerMember({
                friendly_name: memberName,
                member_type: 'local',
                work_folder: workDir,
                llm_provider: 'none',
                unattended: 'dangerous',
                unreservable: true,
                tags: ['real-bitbucket-e2e'],
                ...(process.platform === 'win32' ? { shell: 'gitbash' } : {}),
            }));
            assertNotFailureText(registerText, 'register_member');
            memberRegistered = true;

            // --- 1. provision_vcs_auth for bitbucket, app password resolved
            // from the fleet credential store via the secret placeholder --
            // the plaintext never appears in this file. ---
            const provisionText = toolText(await apraFleet.provisionVcsAuth({
                member_name: memberName,
                provider: 'bitbucket',
                email: cfg.email,
                workspace: providerRef.ref.workspace,
                api_token: `{{secret.${cfg.secretName}}}`,
                git_access: 'push+pr',
            }));
            assertNotFailureText(provisionText, 'provision_vcs_auth');

            // --- 2. verify with git ls-remote against the designated test
            // repo -- proves the provisioned credential authenticates. ---
            const lsRemoteRes = await apraFleet.executeCommand({
                member_name: memberName,
                command: `git ls-remote ${cfg.remoteUrl} HEAD`,
                timeout_s: 60,
            });
            assertToolSucceeded(lsRemoteRes, 'git ls-remote (verify step)');
            const lsRemoteOut = commandStdout(lsRemoteRes).trim();
            assert.match(
                lsRemoteOut,
                /^[0-9a-f]{40}\s+HEAD/m,
                `expected "git ls-remote HEAD" to return a 40-hex-char SHA line, got: ${lsRemoteOut}`,
            );

            // --- 3. the publish path: a real branch with a real change,
            // pushed, then a real Bitbucket create-pull-request REST call
            // via VCSModule's buildCreatePrCommand -- the same builder
            // runner.js's "Publish PR" step dispatches, carrying BOTH the
            // username and token halves. ---
            const cloneRes = await apraFleet.executeCommand({
                member_name: memberName,
                command: `git clone --branch ${cfg.baseBranch} --single-branch ${cfg.remoteUrl} repo-checkout`,
                run_from: workDir,
                timeout_s: 120,
            });
            assertToolSucceeded(cloneRes, `git clone ${cfg.remoteUrl}`);

            const checkoutRes = await apraFleet.executeCommand({
                member_name: memberName,
                command: `git checkout -b ${headBranch}`,
                run_from: checkoutDir,
                timeout_s: 30,
            });
            assertToolSucceeded(checkoutRes, `git checkout -b ${headBranch}`);

            const markerRes = await apraFleet.executeCommand({
                member_name: memberName,
                command: `echo apra-fleet real Bitbucket E2E marker ${new Date().toISOString()} >> APRA_FLEET_E2E_MARKER.md`,
                run_from: checkoutDir,
                timeout_s: 30,
            });
            assertToolSucceeded(markerRes, 'write E2E marker file');

            const commitRes = await apraFleet.executeCommand({
                member_name: memberName,
                command: 'git add APRA_FLEET_E2E_MARKER.md && '
                    + 'git -c user.email=apra-fleet-e2e@example.com -c user.name=apra-fleet-e2e '
                    + 'commit -m "apra-fleet real Bitbucket E2E marker commit"',
                run_from: checkoutDir,
                timeout_s: 30,
            });
            assertToolSucceeded(commitRes, 'git commit');

            const pushRes = await apraFleet.executeCommand({
                member_name: memberName,
                command: `git push origin ${headBranch}`,
                run_from: checkoutDir,
                timeout_s: 60,
            });
            assertToolSucceeded(pushRes, `git push origin ${headBranch}`);

            // Learn { os, shell } the same way runner.js's
            // resolveMemberTarget() does -- member_detail is the only MCP
            // surface exposing Agent.os/shell.
            const detailRes = await apraFleet.memberDetail({ member_name: memberName, format: 'json' });
            const detail = JSON.parse(toolText(detailRes));
            const target = { os: detail.os, shell: detail.shell };

            // Read the raw app password AND username back out of the
            // git-credential-helper script provision_vcs_auth just deployed
            // -- the ONLY way an orchestrator-side caller ever learns either
            // value (see buildCredentialReadCommand's doc comment in
            // runner.js). Never logged: this scenario keeps both in-process
            // only, to build the one curl command below.
            const { command: credReadCommand, descriptor: credFile } = buildCredentialReadCommand(target, BITBUCKET_CREDENTIAL_LABEL);
            const credRes = await apraFleet.executeCommand({
                member_name: memberName,
                command: credReadCommand,
                timeout_s: 30,
            });
            assertToolSucceeded(credRes, `read git-credential-helper (${credFile})`);
            const credOutput = commandStdout(credRes);
            const tokenMatch = /^password=(.*)$/m.exec(credOutput);
            const token = tokenMatch ? tokenMatch[1].trim() : '';
            assert.ok(token, `expected a non-empty app password read back from ${credFile}`);
            const usernameMatch = /^username=(.*)$/m.exec(credOutput);
            const username = usernameMatch ? usernameMatch[1].trim() : '';
            assert.ok(username, `expected a non-empty username read back from ${credFile} (Bitbucket REST needs 'username:token' Basic auth)`);

            const built = buildCreatePrCommand({
                provider: 'bitbucket',
                repoRef: providerRef.ref,
                base: cfg.baseBranch,
                head: headBranch,
                title: `apra-fleet real Bitbucket E2E (${headBranch})`,
                body: 'Opened by the opt-in real Bitbucket end-to-end test scenario. Safe to close/decline.',
                token,
                username,
                os: target.os,
                shell: target.shell,
            });

            const prRes = await apraFleet.executeCommand({
                member_name: memberName,
                command: built.command,
                timeout_s: 60,
            });
            assertToolSucceeded(prRes, 'create-pull-request (publish step)');

            const prOutput = commandStdout(prRes);
            const prLines = prOutput.split('\n');
            const statusLine = prLines.length ? prLines[prLines.length - 1].trim() : '';
            const status = /^\d+$/.test(statusLine) ? parseInt(statusLine, 10) : null;
            const bodyText = (status !== null ? prLines.slice(0, -1) : prLines).join('\n').trim();
            let respBody = null;
            try {
                respBody = bodyText ? JSON.parse(bodyText) : null;
            } catch {
                respBody = null;
            }

            const [lo, hi] = built.interpret.successStatusRange;
            assert.ok(
                status !== null && status >= lo && status <= hi,
                `expected the create-pull-request call to return a status in [${lo}, ${hi}], got status=${status} body=${bodyText}`,
            );

            const impl = getVcsProvider('bitbucket');
            const mapped = impl.pullRequestResponse.map(respBody, { repoRef: providerRef.ref });
            assert.ok(mapped.url, `expected a pull request URL to be returned; response body was: ${bodyText}`);
            assert.match(mapped.url, /^https:\/\/bitbucket\.org\/.+\/pull-requests\/\d+$/, `unexpected pull request URL shape: ${mapped.url}`);

            // Record the resulting PR URL for this bead's notes -- see the
            // module doc comment's OUTSTANDING LIVE CHECK section.
            // eslint-disable-next-line no-console
            console.log(`[real Bitbucket E2E] pull request opened: ${mapped.url}`);
        } finally {
            if (memberRegistered) {
                await apraFleet.removeMember({ member_name: memberName, force: true }).catch(() => {});
            }
            // StdioTransport.stop() is SYNCHRONOUS (see
            // azure-devops-real-e2e.test.mjs's own note on this) -- call it
            // synchronously and guard with try/catch, with workDir cleanup
            // in its own try/catch so a failure in one never skips the other.
            try {
                stop();
            } catch {
                // best-effort teardown of the spawned server process
            }
            try {
                fs.rmSync(workDir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup of the throwaway checkout directory
            }
        }
    },
);

// Resolved once at module scope: node:test's `{ skip }` option is read at
// test-registration time, so this must not depend on anything only known
// inside the test body.
function realBitbucketE2eSkipMessage() {
    return resolveRealBitbucketE2eConfig().skip;
}
