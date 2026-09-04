import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildMockFleetApi, setup } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-5co8.16 -- direct coverage for the fail-loud unmocked-network
// guard added to buildMockFleetApi()'s executeCommand (mock-sprint-
// harness.mjs, around the isNetworkShapedCommand() check just above the
// generic runCmd() fallback). The guard itself predates this file; what was
// missing was any automated assertion that (a) an unmocked curl/wget-shaped
// command actually throws instead of silently reaching the real network via
// runCmd(), with a redacted, clearly-labeled message, and (b) the guard
// leaves ordinary bd/git commands completely alone.
// =============================================================================

test('mock-sprint-harness: unmocked network command guard', async (t) => {
    await t.test('an unmocked curl command reaches executeCommand and throws, redacted, no raw token', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-unmocked-network-guard-'));
        try {
            const dispatched = [];
            const commandLog = [];
            const mockFleetApi = buildMockFleetApi(tempDir, { id: 'bd-1' }, dispatched, commandLog);

            const secretToken = 'sekret-pat-value-do-not-leak';
            // A curl shape this harness has no dedicated mock for (not the
            // GitHub /pulls or Azure DevOps /pullrequests create-PR shapes,
            // not the $HOME/.fleet-git-credential-* read) -- exactly the
            // "new endpoint added without a mock" case the guard exists for.
            const unmockedCurl = `curl -sS -X GET -H "Authorization: Bearer ${secretToken}" https://dev.azure.com/some-org/_apis/some/unmocked/endpoint`;

            await assert.rejects(
                () => mockFleetApi.executeCommand({ command: unmockedCurl }),
                (err) => {
                    assert.match(err.message, /unmocked/i, `error message must identify the command as unmocked, got: ${err.message}`);
                    assert.match(err.message, /\*\*\*REDACTED\*\*\*/, `error message must contain the redaction marker, got: ${err.message}`);
                    assert.ok(!err.message.includes(secretToken), `error message must NOT contain the raw token value, got: ${err.message}`);
                    return true;
                },
            );

            // The command must never have reached runCmd() -- it is a
            // network-shaped command, not a bd/git one, so it leaves no
            // trace anywhere runCmd's real exec() would (this tempDir has
            // no bd DB at all, so any attempt to actually run it would have
            // failed loudly in some OTHER way, not via this guard's message).
            assert.equal(commandLog.length, 1, 'the command is still recorded in commandLog before the guard throws');
            assert.equal(commandLog[0], unmockedCurl);
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    await t.test('a bd command still flows through runCmd unchanged', async () => {
        const { tempDir, epicBead } = await setup('unmocked-net-guard-bd');
        try {
            const dispatched = [];
            const commandLog = [];
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog);

            const result = await mockFleetApi.executeCommand({ command: `bd show ${epicBead.id} --json` });
            assert.ok(!result.isError, `expected bd show to succeed via the real runCmd() passthrough, got: ${JSON.stringify(result)}`);
            assert.equal(result.structuredContent.exitCode, 0, `expected bd show to exit 0, got: ${JSON.stringify(result)}`);
            const stdout = result.structuredContent.stdout;
            const parsed = JSON.parse(stdout);
            const bead = Array.isArray(parsed) ? parsed[0] : parsed;
            assert.equal(bead.id, epicBead.id, `expected the real bd DB in tempDir to answer with the epic bead created by setup(), got: ${stdout}`);
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    await t.test('a mocked GitHub /pulls create-PR curl still succeeds unchanged (negative control)', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-unmocked-network-guard-gh-'));
        try {
            const dispatched = [];
            const commandLog = [];
            const mockFleetApi = buildMockFleetApi(tempDir, { id: 'bd-1' }, dispatched, commandLog);

            const githubCreatePr = 'curl -sS -X POST https://api.github.com/repos/mock-org/mock-repo/pulls -H "Authorization: Bearer sekret" -d \'{"head":"feature-branch"}\'';
            const result = await mockFleetApi.executeCommand({ command: githubCreatePr });
            assert.ok(!result.isError, `expected the mocked GitHub /pulls curl to succeed unchanged, got: ${JSON.stringify(result)}`);
            assert.equal(result.structuredContent.exitCode, 0, `expected exit 0 from the GitHub /pulls mock, got: ${JSON.stringify(result)}`);
            assert.match(result.structuredContent.stdout, /html_url/, `expected the canned GitHub PR-created body, got: ${result.structuredContent.stdout}`);
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    await t.test('a mocked Azure DevOps /pullrequests create-PR curl still succeeds unchanged (negative control)', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-unmocked-network-guard-ado-'));
        try {
            const dispatched = [];
            const commandLog = [];
            const mockFleetApi = buildMockFleetApi(tempDir, { id: 'bd-1' }, dispatched, commandLog);

            const azureDevOpsCreatePr = 'curl -sS -X POST "https://dev.azure.com/mock-org/mock-project/_apis/git/repositories/mock-repo/pullrequests?api-version=6.0" -H "Authorization: Basic sekret" -d \'{"sourceRefName":"refs/heads/feature-branch"}\'';
            const result = await mockFleetApi.executeCommand({ command: azureDevOpsCreatePr });
            assert.ok(!result.isError, `expected the mocked Azure DevOps /pullrequests curl to succeed unchanged, got: ${JSON.stringify(result)}`);
            assert.equal(result.structuredContent.exitCode, 0, `expected exit 0 from the Azure DevOps /pullrequests mock, got: ${JSON.stringify(result)}`);
            assert.match(result.structuredContent.stdout, /pullRequestId/, `expected the canned Azure DevOps PR-created body, got: ${result.structuredContent.stdout}`);
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    await t.test('a git command still flows through the existing hardcoded git/gh mock unchanged (not the network guard)', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-unmocked-network-guard-git-'));
        try {
            const dispatched = [];
            const commandLog = [];
            const mockFleetApi = buildMockFleetApi(tempDir, { id: 'bd-1' }, dispatched, commandLog);

            const result = await mockFleetApi.executeCommand({ command: 'git status' });
            assert.ok(!result.isError, `expected git status to succeed via the existing git/gh mock, got: ${JSON.stringify(result)}`);
            assert.equal(result.structuredContent.stdout, 'ok (mocked -- no real git remote in this mock sprint)');
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
