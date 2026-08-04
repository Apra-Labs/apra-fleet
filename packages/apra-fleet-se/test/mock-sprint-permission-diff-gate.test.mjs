import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import {
    setupMinimal,
    buildMockFleetApi,
    mockCmdResult,
    teardown,
    withScenarioMarkers,
} from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');

// =============================================================================
// apra-fleet-fahx: fleet-sprint's own pre-sprint permission-diff gate.
//
// Today a live sprint can burn real Plan/Develop dispatch cost before its
// Deploy phase discovers a dispatched member's PROJECT-level
// .claude/settings.json is missing a Bash(...) permission deploy.md declares
// under a `## Permissions` heading -- deployer.md's Step 0 correctly refuses
// to self-grant it, but that report only surfaces deep into the sprint.
// runner.js now checks this BEFORE any Plan/Develop dispatch: every
// dispatchable member (members + roleMap union) must already have every
// declared Bash(...) prefix in permissions.allow, or the launch refuses to
// even reach Planning.
//
// The read of each member's `.claude/settings.json` is intercepted here
// (rather than relying on tempDir's real filesystem, which is shared across
// every "member" in this single-workspace mock) via the exact `node -e`
// command string runner.js's readFileOrEmpty() issues, keyed on
// opts.member_name -- mirroring the interception pattern
// mock-sprint-beads-health-gate-empty-remote.test.mjs uses for `bd dolt
// pull`.
// =============================================================================

const SETTINGS_READ_RE = /existsSync\('\.claude\/settings\.json'\).*readFileSync\('\.claude\/settings\.json'/;

function buildPermissionGateFleetApi(tempDir, epicBead, dispatched, commandLog, memberSettings, options = {}) {
    const baseApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options);
    const settingsReadsByMember = [];

    const executeCommand = async (opts) => {
        const cmd = opts.command;
        if (SETTINGS_READ_RE.test(cmd)) {
            commandLog.push(cmd);
            settingsReadsByMember.push(opts.member_name);
            const content = Object.prototype.hasOwnProperty.call(memberSettings, opts.member_name)
                ? memberSettings[opts.member_name]
                : '';
            return mockCmdResult(0, content, '');
        }
        return baseApi.executeCommand(opts);
    };

    return {
        executeCommand,
        executePrompt: baseApi.executePrompt,
        _settingsReadsByMember: () => settingsReadsByMember,
    };
}

const DEPLOY_MD_WITH_PERMISSIONS =
    '## Permissions\n\n' +
    'Commands below require these prefixes in `.claude/settings.json` under `permissions.allow`:\n' +
    '- `Bash(npm ci)`\n' +
    '- `Bash(npm run build)`\n\n' +
    '## Deploy\n\n' +
    '```bash\nnpm ci\nnpm run build\n```\n';

test(
    'apra-fleet-fahx: a dispatchable member missing a deploy.md-declared Bash permission blocks the launch ' +
    'BEFORE any Plan/Develop dispatch, with a structured per-member/per-permission/per-source message, and never ' +
    'writes to any member\'s settings.json',
    async () => {
        await withScenarioMarkers('permgateblock', async () => {
            const { tempDir, epicBead } = await setupMinimal('permgateblock', [
                { title: 'Task: never reached -- permission gate aborts before Planning' },
            ]);
            await fs.writeFile(path.join(tempDir, 'deploy.md'), DEPLOY_MD_WITH_PERMISSIONS);

            const memberSettings = {
                memberA: JSON.stringify({ permissions: { allow: ['Bash(npm ci)', 'Bash(npm run build)'] } }),
                // memberB is missing 'Bash(npm run build)'.
                memberB: JSON.stringify({ permissions: { allow: ['Bash(npm ci)'] } }),
            };
            // Snapshot for the "never writes" assertion below.
            const memberSettingsBefore = JSON.parse(JSON.stringify(memberSettings));

            const dispatched = [];
            const commandLog = [];
            try {
                const mockFleetApi = buildPermissionGateFleetApi(
                    tempDir, epicBead, dispatched, commandLog, memberSettings,
                    { planReviewerMode: 'approve-immediately' },
                );
                const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
                const engine = new WorkflowEngine(workflow);

                let error = null;
                let result = null;
                try {
                    result = await engine.executeFile(scriptPath, {
                        target_issue: epicBead.id,
                        members: ['memberA', 'memberB'],
                        branch: 'auto-sprint/mock-permgateblock',
                        base_branch: 'main',
                        goal: 'P1/P2',
                        max_cycles: 1,
                    }, true);
                } catch (err) {
                    error = err;
                }

                // ---- 1. The sprint aborts (never reaches a success result) ----
                assert.ok(error, `expected the missing-permission gate to abort the sprint, got a result instead: ${JSON.stringify(result)}`);
                assert.ok(
                    typeof error.message === 'string' && error.message.startsWith('Pre-sprint validation failed:'),
                    `expected a 'Pre-sprint validation failed:'-prefixed error (the established pre-sprint-gate error class), got: ${error && error.message}`,
                );

                // ---- 2. The message is structured: names the member, the exact ----
                //         missing permission string, and the declaring source file.
                assert.ok(
                    error.message.includes('memberB'),
                    `expected the error to name the offending member 'memberB', got: ${error.message}`,
                );
                assert.ok(
                    error.message.includes('Bash(npm run build)'),
                    `expected the error to name the exact missing permission 'Bash(npm run build)', got: ${error.message}`,
                );
                assert.ok(
                    error.message.includes('deploy.md'),
                    `expected the error to name deploy.md as the declaring source, got: ${error.message}`,
                );
                // memberA satisfies every declared permission and must not be
                // reported as missing anything.
                assert.ok(
                    !new RegExp(`member 'memberA':\\n\\s*- Bash`).test(error.message),
                    `expected memberA (fully compliant) to not appear in the missing-permission detail, got: ${error.message}`,
                );

                // ---- 3. Planning was never reached -- this fails BEFORE any ----
                //         Plan/Develop dispatch.
                assert.strictEqual(
                    dispatched.length, 0,
                    `expected zero agent dispatches (Planner never reached), got: ${JSON.stringify(dispatched.map((d) => d.agent))}`,
                );

                // ---- 4. The Git Setup branch-ensure mutation (`git checkout -B`, ----
                //         which actually creates/resets the sprint branch) never
                //         ran -- the gate aborts before Sprint Setup mutates
                //         anything. (finalizeAbort's own post-error cleanup may
                //         still issue read-only git commands like `git fetch`/
                //         `git rev-list --count` while deciding how to report the
                //         abort -- that is unrelated bookkeeping AFTER the gate
                //         already threw, not evidence the gate ran late.)
                assert.ok(
                    !commandLog.some((c) => c.startsWith('git checkout -B')),
                    `expected no branch-creating 'git checkout -B' command to have run, got commandLog: ${JSON.stringify(commandLog)}`,
                );

                // ---- 5. Both dispatchable members' settings.json were read ----
                //         (report-only requires actually checking every member).
                const mockFleetApiTyped = mockFleetApi;
                const reads = mockFleetApiTyped._settingsReadsByMember();
                assert.ok(reads.includes('memberA') && reads.includes('memberB'),
                    `expected both memberA and memberB's settings.json to have been read, got: ${JSON.stringify(reads)}`);

                // ---- 6. The check never WROTE to any member's settings.json: ----
                //         the mocked content is byte-identical before/after the
                //         blocked launch attempt.
                assert.deepStrictEqual(
                    memberSettings, memberSettingsBefore,
                    'expected every mocked member settings.json content to be byte-identical before and after the blocked launch attempt (report-only, never self-heal)',
                );
            } finally {
                await teardown(tempDir);
            }
        });
    },
);

test(
    'apra-fleet-fahx NO-OP CASE: when every dispatchable member already satisfies every deploy.md-declared ' +
    'Bash permission, the sprint launches exactly as before with no added friction and reaches Planning',
    async () => {
        await withScenarioMarkers('permgatenoop', async () => {
            const { tempDir, epicBead } = await setupMinimal('permgatenoop', [
                { title: 'Task: reached normally -- both members satisfy every declared permission' },
            ]);
            await fs.writeFile(path.join(tempDir, 'deploy.md'), DEPLOY_MD_WITH_PERMISSIONS);

            const memberSettings = {
                memberA: JSON.stringify({ permissions: { allow: ['Bash(npm ci)', 'Bash(npm run build)'] } }),
                memberB: JSON.stringify({ permissions: { allow: ['Bash(npm ci)', 'Bash(npm run build)', 'Bash(git status)'] } }),
            };

            const dispatched = [];
            const commandLog = [];
            try {
                const mockFleetApi = buildPermissionGateFleetApi(
                    tempDir, epicBead, dispatched, commandLog, memberSettings,
                    { planReviewerMode: 'approve-immediately' },
                );
                const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
                const engine = new WorkflowEngine(workflow);

                const result = await engine.executeFile(scriptPath, {
                    target_issue: epicBead.id,
                    members: ['memberA', 'memberB'],
                    branch: 'auto-sprint/mock-permgatenoop',
                    base_branch: 'main',
                    goal: 'P1/P2',
                    max_cycles: 5,
                }, true);

                // ---- 1. The sprint completes successfully, unaffected by the gate ----
                assert.ok(
                    result && result.status === 'success',
                    `expected the sprint to complete successfully when every member satisfies every declared permission, got: ${JSON.stringify(result)}`,
                );

                // ---- 2. Planning was reached ----
                assert.ok(
                    dispatched.some((d) => d.agent === 'planner'),
                    `expected at least one 'planner' dispatch (Planning was reached), got: ${JSON.stringify(dispatched.map((d) => d.agent))}`,
                );

                // ---- 3. The gate genuinely ran (both members' settings.json read) ----
                const reads = mockFleetApi._settingsReadsByMember();
                assert.ok(reads.includes('memberA') && reads.includes('memberB'),
                    `expected both memberA and memberB's settings.json to have been read by the gate, got: ${JSON.stringify(reads)}`);
            } finally {
                await teardown(tempDir);
            }
        });
    },
);

test(
    'apra-fleet-fahx NO-OP CASE: deploy.md with no `## Permissions` section skips member reads entirely ' +
    '(zero added dispatch calls in the common case)',
    async () => {
        await withScenarioMarkers('permgatenosection', async () => {
            const { tempDir, epicBead } = await setupMinimal('permgatenosection', [
                { title: 'Task: reached normally -- deploy.md declares no permissions' },
            ]);
            // Deliberately no `## Permissions` heading -- the overwhelmingly
            // common case for a target repo's deploy.md.
            await fs.writeFile(path.join(tempDir, 'deploy.md'), '## Deploy\n\n```bash\nnpm ci\n```\n');

            const dispatched = [];
            const commandLog = [];
            try {
                const mockFleetApi = buildPermissionGateFleetApi(
                    tempDir, epicBead, dispatched, commandLog, {},
                    { planReviewerMode: 'approve-immediately' },
                );
                const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
                const engine = new WorkflowEngine(workflow);

                const result = await engine.executeFile(scriptPath, {
                    target_issue: epicBead.id,
                    members: ['memberA', 'memberB'],
                    branch: 'auto-sprint/mock-permgatenosection',
                    base_branch: 'main',
                    goal: 'P1/P2',
                    max_cycles: 5,
                }, true);

                assert.ok(
                    result && result.status === 'success',
                    `expected the sprint to complete successfully, got: ${JSON.stringify(result)}`,
                );
                assert.strictEqual(
                    mockFleetApi._settingsReadsByMember().length, 0,
                    'expected zero member settings.json reads when deploy.md has no `## Permissions` section',
                );
            } finally {
                await teardown(tempDir);
            }
        });
    },
);
