import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { finalizeAbort, buildCredentialReadCommand, clearMemberOsCache } from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import {
    setup,
    teardown,
    buildMockFleetApi,
    defaultMockCallTool,
    mockCmdResult,
    withScenarioMarkers,
    legacyCommandExecuteCommandAdapter,
} from './helpers/mock-sprint-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-ot2z.2 -- guards apra-fleet-ot2z.1 (runner.js:1712 credential
// read + all runner.js POSIX-only command strings) for the UPDATED acceptance
// criterion 5 in that fix: a Windows member's VCS credential read must build
// a valid PowerShell command (no bare $HOME/~ expansion) on BOTH the
// everyday Publish-PR path (raiseVcsPrForMember, inside runSprintCycle) and
// finalizeAbort's [ABORTED]-PR path -- both share the SAME (private,
// unexported) raiseVcsPrForMember()/readMemberVcsCredentialToken() call
// chain, driven here from the two public entry points that actually reach
// it: finalizeAbort() (exported directly) for the abort path, and a full
// mock-sprint run (raiseVcsPrForMember is otherwise unreachable -- it is not
// exported) for the Publish-PR path.
//
// Assertions stay local to this file (no shared cross-suite helper is
// added); the shared mock-sprint-harness.mjs is only ever REUSED (setup/
// teardown/buildMockFleetApi/defaultMockCallTool/mockCmdResult), never
// modified -- Windows member-OS injection and the Windows-shaped credential-
// read response are layered on top locally via a wrapped callTool/
// executeCommand, exactly the pattern buildMockCommand(...)/
// buildMockCommandForPrRetry(...) already use in mock-sprint-abort-pr.test.mjs
// for the POSIX shape.
// =============================================================================

// -----------------------------------------------------------------------
// Items 1/2/6: buildCredentialReadCommand() itself -- the pure builder both
// call sites funnel through (readMemberVcsCredentialToken, runner.js:1861).
// -----------------------------------------------------------------------

// Item 6: the defect-class assertion used throughout this file. Must reject
// expansion-pasted POSIX-style paths ($HOME/x, ~/x) -- a PowerShell
// ParserError on a Windows member (apra-fleet-ot2z) -- while ACCEPTING
// legitimate PowerShell forms that merely contain "$HOME"/"~" as part of a
// proper PowerShell expression ($env:USERPROFILE, `Join-Path $HOME 'x'`).
function hasBareHomeExpansion(cmd) {
    return /\$HOME\//.test(cmd) || /(^|[\s"'])~\//.test(cmd);
}

test('defect-class assertion: hasBareHomeExpansion rejects expansion-pasted paths, accepts legitimate PowerShell forms', () => {
    // Failing example (must be rejected):
    check(hasBareHomeExpansion('cat $HOME/.fleet-git-credential-github') === true, 'expected a bare $HOME/... path to be flagged');
    check(hasBareHomeExpansion('cat ~/.fleet-git-credential-github') === true, 'expected a bare ~/... path to be flagged');
    // Passing example (must be accepted -- proves the assertion is not vacuous):
    check(hasBareHomeExpansion('& "$env:USERPROFILE\\.fleet-git-credential-github.bat"') === false, 'expected $env:USERPROFILE to be accepted');
    check(hasBareHomeExpansion("Get-ChildItem -LiteralPath (Join-Path $HOME 'x')") === false, "expected Join-Path \$HOME 'x' to be accepted (not a bare slash expansion)");
});

test('buildCredentialReadCommand: windows -- no bare $HOME/~, references the .bat, rooted at $env:USERPROFILE', () => {
    const { command, descriptor } = buildCredentialReadCommand('windows', 'github');
    check(hasBareHomeExpansion(command) === false, `windows credential-read command must not carry a bare $HOME/~ expansion, got: ${command}`);
    check(descriptor.includes('.fleet-git-credential-github.bat'), `expected the descriptor to reference the deployed .bat, got: ${descriptor}`);
    check(command.startsWith('powershell -EncodedCommand '), `expected the command to be explicitly wrapped via powershell -EncodedCommand, got: ${command}`);

    // The actual PowerShell script is base64 (UTF-16LE)-encoded after
    // -EncodedCommand -- decode it to assert on the real script content
    // (wrapPowerShellEncodedForMember, runner.js), not the opaque blob.
    const b64 = command.slice('powershell -EncodedCommand '.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf16le');
    check(decoded.includes('.fleet-git-credential-github.bat'), `expected the decoded script to reference the deployed .bat, got: ${decoded}`);
    check(decoded.includes('$env:USERPROFILE'), `expected the decoded script to be rooted at $env:USERPROFILE (matching the write side, src/os/windows.ts), got: ${decoded}`);
    check(hasBareHomeExpansion(decoded) === false, `decoded script must not carry a bare $HOME/~ expansion either, got: ${decoded}`);
});

test('buildCredentialReadCommand: linux -- the double-quoted $HOME/... string (apra-fleet-j918.12)', () => {
    const { command, descriptor } = buildCredentialReadCommand('linux', 'github');
    // apra-fleet-j918.12: the POSIX/gitbash shapes now double-quote the path
    // so a HOME containing whitespace still resolves; the descriptor (used
    // only for human-readable error messages) stays the bare, unquoted path.
    check(command === '"$HOME/.fleet-git-credential-github"', `expected the quoted POSIX string, got: ${command}`);
    check(descriptor === '$HOME/.fleet-git-credential-github', `expected the bare descriptor, got: ${descriptor}`);
});

// -----------------------------------------------------------------------
// Item 4: ABORT PATH -- finalizeAbort() is exported and directly callable,
// so this drives the SAME code path the existing mock-sprint-abort-pr.test.mjs
// scenarios use, but with a Windows member (member_detail: os:'windows') and
// a command() mock that answers the Windows-shaped
// `powershell -EncodedCommand ...` credential-read command instead of the
// POSIX `$HOME/.fleet-git-credential-...` one.
// -----------------------------------------------------------------------

function buildMockWindowsCommand({ commitCount, pushShouldFail = false, prOutcome = 'created', prUrl, credentialShouldFail = false, token = 'mock-windows-vcs-token' } = {}) {
    const log = [];
    const command = async (cmd, opts = {}) => {
        log.push(cmd);
        const failSoft = !!opts.failSoft;
        const ok = (output) => (failSoft ? { ok: true, output, error: null } : output);
        const fail = (error) => {
            if (failSoft) return { ok: false, output: '', error };
            throw new Error(error);
        };
        if (/^git fetch origin\b/.test(cmd)) return ok('');
        if (/^git rev-list --count\b/.test(cmd)) return ok(String(commitCount));
        if (/^git push\b/.test(cmd)) {
            if (pushShouldFail) return fail('mock git push failure: fatal: unable to access remote');
            return ok('To mock-remote\n * [new branch] (mocked)');
        }
        if (/^git remote get-url origin\b/.test(cmd)) return ok('https://github.com/mock-org/mock-repo.git');
        // The Windows-shaped credential-read command (buildCredentialReadCommand's
        // windows branch): `powershell -EncodedCommand <base64>` -- the POSIX
        // regex the sibling abort-PR test file uses (`^\$HOME\/...`) never
        // matches this, proving the two branches are genuinely distinct strings.
        if (/^powershell -EncodedCommand\b/.test(cmd)) {
            if (credentialShouldFail) {
                return fail(`mock Windows credential-read failure: .bat exited nonzero for '${cmd}'`);
            }
            return ok(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n`);
        }
        if (/^curl.exe -sS -X POST\b/.test(cmd) && /\/pulls\b/.test(cmd)) {
            if (prOutcome === 'already-exists') {
                const body = JSON.stringify({
                    message: 'Validation Failed',
                    errors: [{ message: `A pull request already exists for this branch. ${prUrl}` }],
                });
                return ok(`${body}\n422`);
            }
            const body = JSON.stringify({ number: 201, html_url: prUrl });
            return ok(`${body}\n201`);
        }
        throw new Error(`buildMockWindowsCommand: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

// apra-fleet-3swo.7.19: `command` threads into legacyCommandExecuteCommandAdapter
// so vcs_credential_exec delegates to the SHARED defaultMockCallTool()
// simulator (reusing its placeholder substitution and redaction) instead of
// re-implementing it here -- mirrors mock-sprint-abort-pr.test.mjs's
// mockAbortCallTool().
// apra-fleet-3swo.7.6: `credentialShouldFail` drives the credential-read
// FAILURE scenario below. Its old lever -- buildMockWindowsCommand failing the
// `powershell -EncodedCommand` command -- can no longer fire, because the
// orchestrator dispatches no such command: the read happens inside
// vcs_credential_exec. The lever therefore moves to this wrapper, which
// intercepts the tool call and returns the SAME failure shape the real tool
// (and the shared simulator) emits for an unreadable credential -- a [FAIL]
// text plus structuredContent.reason 'credential_read_failed'. The shared
// harness is not touched.
function mockWindowsAbortCallTool(command, { credentialShouldFail = false } = {}) {
    const base = defaultMockCallTool({ executeCommand: legacyCommandExecuteCommandAdapter(command) });
    return async (name, toolArgs) => {
        if (name === 'vcs_credential_exec' && credentialShouldFail) {
            const label = toolArgs && toolArgs.label;
            return {
                content: [{ text: `[FAIL] Cannot read a VCS credential for label "${label}" on "${toolArgs && toolArgs.member_name}" (mock Windows credential-read failure: .bat exited nonzero).` }],
                structuredContent: {
                    ok: false,
                    reason: 'credential_read_failed',
                    exitCode: null,
                    stdout: '',
                    stderr: '',
                    tokenRedactions: 0,
                    credentialLabel: label ?? null,
                    memberId: (toolArgs && toolArgs.member_id) ?? null,
                    memberName: (toolArgs && toolArgs.member_name) ?? null,
                },
            };
        }
        if (name === 'member_detail') {
            // Both resolveMemberOs() (runner.js) and VCSModule.resolveProvider()
            // parse this same member_detail response -- os:'windows' drives the
            // credential-command OS branch, vcsProvider:'github' satisfies the
            // provider resolution both call sites also need.
            return { content: [{ text: JSON.stringify({ os: 'windows', vcsProvider: 'github' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `[OK] Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        return base(name, toolArgs);
    };
}

test('finalizeAbort (Windows member): builds a valid PowerShell credential-read command, reads the token, and raises the [ABORTED] PR', async () => {
    clearMemberOsCache();
    const branch = 'auto-sprint/abort-windows-commits-exist';
    const prUrl = 'https://github.com/mock-org/mock-repo/pull/401';
    const { command, log } = buildMockWindowsCommand({ commitCount: 1, prOutcome: 'created', prUrl });
    const logs = [];
    const error = new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null });

    const result = await finalizeAbort({
        error,
        branch,
        baseBranch: 'main',
        member: 'windows-member',
        command,
        log: (m) => logs.push(m),
        callTool: mockWindowsAbortCallTool(command),
    });

    check(result.reason === 'aborted-pr-created', `Expected the [ABORTED] PR to be created for a Windows member, got: ${JSON.stringify(result)}`);
    check(result.prUrl === prUrl, `Expected the created PR's URL to be surfaced, got: ${JSON.stringify(result)}`);

    // apra-fleet-3swo.7.6: the orchestrator dispatches NO discrete
    // credential-read command any more -- the create-PR command is routed
    // through vcs_credential_exec, which reads the credential server-side. The
    // retired assertion here was "a powershell -EncodedCommand credential read
    // was dispatched"; its property (this Windows member's credential is read,
    // and the PR is raised with it) is carried by the positive create-PR
    // dispatch + substituted-token assertions below. Both NEGATIVE assertions
    // are kept byte-for-byte: they are the point of this file and still hold.
    check(!log.some((c) => /^\$HOME\/\.fleet-git-credential-/.test(c)), 'Expected NO POSIX-shaped credential-read command for a Windows member');
    check(!log.some((c) => hasBareHomeExpansion(c)), `Expected no dispatched command to carry a bare $HOME/~ expansion, command log: ${JSON.stringify(log)}`);

    const prCmd = log.find((c) => c.startsWith('curl.exe -sS -X POST') && c.includes('/pulls'));
    check(!!prCmd, `Expected a create-pull-request command to be dispatched (i.e. routed through the handoff and substituted), command log: ${JSON.stringify(log)}`);
    // The shared simulator's github token (MOCK_VCS_CREDENTIAL_TOKENS in
    // test/helpers/mock-sprint-harness.mjs), not this file's own fixture
    // token: the handoff resolves the credential by LABEL, server-side.
    check(prCmd.includes('Authorization: Bearer mock-vcs-module-token'), `Expected the PR-creation command to carry the token the handoff substituted server-side, got: ${prCmd}`);
});

test('finalizeAbort (Windows member): a failing credential read still throws the existing descriptive error -- no silent degradation', async () => {
    clearMemberOsCache();
    const branch = 'auto-sprint/abort-windows-credential-fails';
    const { command, log } = buildMockWindowsCommand({ commitCount: 1, credentialShouldFail: true });
    const error = new SprintPlanRejectedError('Plan rejected', { notes: null });

    let thrown = null;
    try {
        await finalizeAbort({
            error,
            branch,
            baseBranch: 'main',
            member: 'windows-member-cred-fail',
            command,
            callTool: mockWindowsAbortCallTool(command, { credentialShouldFail: true }),
        });
    } catch (e) {
        thrown = e;
    }

    check(thrown !== null, 'Expected finalizeAbort() to throw when the Windows credential read fails');
    check(
        /Failed to read VCS credential token/.test(thrown.message),
        `Expected the existing descriptive credential-read-failure message, got: ${thrown.message}`
    );
    // apra-fleet-3swo.7.6: the failure is now reported BY the handoff rather
    // than by a failed member-side powershell dispatch, so the retired
    // assertion ("the powershell credential-read command was still attempted")
    // is re-expressed as: the thrown error still names the member and the
    // credential it could not read, and it is a HARD failure -- never an
    // advisory warning that lets the sprint continue.
    check(
        thrown.message.includes("windows-member-cred-fail") && thrown.message.includes('github'),
        `Expected the error to name the member and the credential label it could not read, got: ${thrown.message}`
    );
    check(
        !log.some((c) => /^powershell -EncodedCommand\b/.test(c)),
        `The orchestrator must dispatch no credential-read command of its own; the handoff owns that read. Command log: ${JSON.stringify(log)}`
    );
    // No PR was ever raised -- the failure happened before the create-pull-request dispatch.
    check(!log.some((c) => c.startsWith('curl.exe -sS -X POST') && c.includes('/pulls')), 'Expected NO create-pull-request dispatch when the credential read failed');
});

// -----------------------------------------------------------------------
// Shell-vs-OS quoting (windows + gitbash): raiseVcsPrForMember must resolve
// the member's SHELL alongside its OS (resolveMemberTarget, not just
// resolveMemberOs) and thread it into VCSModule's builders, so a Windows
// member whose registered shell is Git-for-Windows bash gets POSIX-quoted
// curl commands ('\'') instead of PowerShell doubled quotes ('') -- the
// doubling corrupts the -d JSON payload under bash (confirmed live: GitHub
// 400 "Problems parsing JSON"). Driven through finalizeAbort(), the exported
// entry point that shares raiseVcsPrForMember's call chain.
// -----------------------------------------------------------------------

function buildMockGitbashCommand({ commitCount, prUrl, token = 'mock-gitbash-vcs-token' } = {}) {
    const log = [];
    const command = async (cmd, opts = {}) => {
        log.push(cmd);
        const failSoft = !!opts.failSoft;
        const ok = (output) => (failSoft ? { ok: true, output, error: null } : output);
        if (/^git fetch origin\b/.test(cmd)) return ok('');
        if (/^git rev-list --count\b/.test(cmd)) return ok(String(commitCount));
        if (/^git push\b/.test(cmd)) return ok('To mock-remote\n * [new branch] (mocked)');
        if (/^git remote get-url origin\b/.test(cmd)) return ok('https://github.com/mock-org/mock-repo.git');
        // The gitbash-shaped credential read (se-os-commands.mjs
        // SeWindowsGitbashCommands#readCredentialHelper): a bare bash
        // invocation of the deployed .bat rooted at $HOME -- NOT a
        // powershell -EncodedCommand envelope.
        if (/^\$HOME\/\.fleet-git-credential-github\.bat$/.test(cmd)) {
            return ok(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n`);
        }
        if (/^curl.exe -sS -X POST\b/.test(cmd) && /\/pulls\b/.test(cmd)) {
            const body = JSON.stringify({ number: 202, html_url: prUrl });
            return ok(`${body}\n201`);
        }
        throw new Error(`buildMockGitbashCommand: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

// apra-fleet-3swo.7.19: see mockWindowsAbortCallTool above.
function mockGitbashAbortCallTool(command) {
    const base = defaultMockCallTool({ executeCommand: legacyCommandExecuteCommandAdapter(command) });
    return async (name, toolArgs) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ os: 'windows', shell: 'gitbash', vcsProvider: 'github' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        return base(name, toolArgs);
    };
}

test('finalizeAbort (Windows gitbash member): PR curl uses POSIX quoting, not PowerShell doubling', async () => {
    clearMemberOsCache();
    const branch = 'auto-sprint/abort-gitbash-quoting';
    const prUrl = 'https://github.com/mock-org/mock-repo/pull/402';
    const { command, log } = buildMockGitbashCommand({ commitCount: 1, prUrl });
    // The apostrophe is the real-world trigger: it survives sanitizePrText
    // into the PR body, where the quoting dialect decides whether the -d
    // JSON payload survives the member's shell intact.
    const error = new SprintPlanRejectedError("Plan rejected -- the doer's plan failed", { notes: null });

    const result = await finalizeAbort({
        error,
        branch,
        baseBranch: 'main',
        member: 'gitbash-member',
        command,
        callTool: mockGitbashAbortCallTool(command),
    });

    check(result.reason === 'aborted-pr-created', `Expected the [ABORTED] PR to be created for a gitbash member, got: ${JSON.stringify(result)}`);

    // apra-fleet-3swo.7.6: the retired assertion here was the positive
    // presence of the gitbash-shaped '$HOME/.fleet-git-credential-github.bat'
    // read. The orchestrator dispatches no credential read at all now -- the
    // handoff performs it server-side -- so that assertion is unsatisfiable by
    // construction. Its property (this member's credential is handled in the
    // bash dialect, never wrapped in a PowerShell envelope) is carried by the
    // surviving negative assertion plus the fact that the create-PR curl was
    // dispatched and POSIX-quoted at all: the command's SHAPE is decided by
    // the provider builder BEFORE the handoff, and the simulator dispatches
    // that already-built command through the same executeCommand path.
    check(!log.some((c) => /^powershell -EncodedCommand\b/.test(c)), `Expected NO PowerShell-enveloped dispatch for a gitbash member, command log: ${JSON.stringify(log)}`);

    const prCmd = log.find((c) => c.startsWith('curl.exe -sS -X POST') && c.includes('/pulls'));
    check(!!prCmd, `Expected a create-pull-request command to be dispatched (routed through the handoff and substituted), command log: ${JSON.stringify(log)}`);
    // POSIX close-escape-reopen around the apostrophe; the PowerShell
    // doubled form (doer''s) must NOT appear -- bash would collapse it and
    // corrupt the JSON payload.
    check(prCmd.includes(`doer'\\''s`), `Expected POSIX '\\'' quoting of the apostrophe in the PR command, got: ${prCmd}`);
    check(!prCmd.includes(`doer''s`), `Expected NO PowerShell doubled-quote escaping for a gitbash member, got: ${prCmd}`);
    check(prCmd.startsWith('curl.exe '), `curl binary token stays OS-keyed (curl.exe on Windows), got: ${prCmd}`);
});

// -----------------------------------------------------------------------
// Item 3: PUBLISH-PR PATH (the everyday path). raiseVcsPrForMember() is not
// exported, so this is only reachable by driving a full mock sprint through
// to runSprintCycle's Publish PR step. The shared buildMockFleetApi() is
// REUSED as-is (not modified) for every command it already understands
// (bd/git/gh/the deploy-integ probes); only the two VCS-module-specific
// commands (the credential-read and the create-pull-request curl) are
// answered locally by wrapping its returned executeCommand, so this test can
// control both the Windows credential shape AND (for the auth-retry case) a
// queued sequence of create-pull-request responses.
// -----------------------------------------------------------------------

function wrapExecuteCommandForWindowsVcs(baseApi, commandLog, { credQueue, pullsQueue } = {}) {
    let credIdx = 0;
    let pullsIdx = 0;
    return {
        ...baseApi,
        executeCommand: async (opts) => {
            // buildMockFleetApi's OWN executeCommand pushes to commandLog --
            // intercepting here (BEFORE delegating) means these two commands
            // must be logged explicitly too, or they would silently vanish
            // from commandLog even though they were genuinely dispatched.
            if (/^powershell -EncodedCommand\b/.test(opts.command)) {
                commandLog.push(opts.command);
                const queue = credQueue || ['protocol=https\nhost=github.com\nusername=x-access-token\npassword=mock-windows-vcs-token\n'];
                const idx = Math.min(credIdx, queue.length - 1);
                credIdx += 1;
                return mockCmdResult(0, queue[idx], '');
            }
            if (pullsQueue && /^curl.exe -sS -X POST\b/.test(opts.command) && /\/pulls\b/.test(opts.command)) {
                commandLog.push(opts.command);
                const idx = Math.min(pullsIdx, pullsQueue.length - 1);
                pullsIdx += 1;
                return mockCmdResult(0, pullsQueue[idx], '');
            }
            return baseApi.executeCommand(opts);
        },
    };
}

// apra-fleet-3swo.7.19: threads the SAME (wrapped) executeCommand this
// scenario's own mockFleetApi uses, so the shared simulator's
// vcs_credential_exec branch can delegate its substituted command through
// that same curl-interception/commandLog machinery.
function mockWindowsMemberDetailCallTool(executeCommand) {
    const base = defaultMockCallTool({ executeCommand });
    return async (name, toolArgs) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ os: 'windows', vcsProvider: 'github' }) }] };
        }
        return base(name, toolArgs);
    };
}

async function runWindowsPublishPrScenario(tag, { pullsQueue } = {}) {
    const { tempDir, epicBead } = await setup(tag);
    const dispatched = [];
    const commandLog = [];
    const logs = [];
    // apra-fleet-eft.60.3 (mirrors runDevelopLoopScenario): skip the real
    // ~110s Planner-dispatch retry backoff and the reactive-auth-heal retry
    // delay in this hermetic in-process mock -- there is no real busy-lock to
    // model here, and the 401-heal scenario below would otherwise burn real
    // wall-clock waiting on production timing. Restored in the finally so it
    // never leaks past this scenario.
    const priorInstantRetryBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
    process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';
    try {
        const baseApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
            planReviewerMode: 'approve-immediately',
            addExtraTaskDuringPlan: false,
        });
        const mockFleetApi = wrapExecuteCommandForWindowsVcs(baseApi, commandLog, { pullsQueue });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        workflow.on('log', (e) => logs.push(e.msg));
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');
        const branch = `auto-sprint/mock-${tag}`;

        let error = null;
        let result = null;
        try {
            result = await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members: ['local'],
                branch,
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 1,
                callTool: mockWindowsMemberDetailCallTool(mockFleetApi.executeCommand),
            }, true);
        } catch (err) {
            error = err;
        }

        return { dispatched, commandLog, logs, error, result, branch };
    } finally {
        if (priorInstantRetryBackoff === undefined) {
            delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        } else {
            process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorInstantRetryBackoff;
        }
        await teardown(tempDir);
    }
}

test('mock sprint (Windows member): Publish PR step reads the Windows credential and successfully raises the PR (sprint not blocked)', async () => {
    clearMemberOsCache();
    await withScenarioMarkers('publish-pr-windows-happy', async () => {
        console.log('Running mock sprint scenario (Publish PR, Windows member, happy path)...');
        const scenario = await runWindowsPublishPrScenario('winpub-happy');

        check(!scenario.error, `Expected the sprint to complete without throwing, got: ${scenario.error ? `${scenario.error.constructor.name}: ${scenario.error.message}` : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected the sprint to succeed (not blocked at Publish PR), got: ${JSON.stringify(scenario.result)}`);

        // apra-fleet-3swo.7.6: same re-anchor as the finalizeAbort happy path
        // above -- the retired "a powershell -EncodedCommand credential read
        // was dispatched" presence assertion is replaced by the positive
        // create-PR dispatch + substituted-token pair below, which is what
        // proves the credential was obtained and used. Both negative
        // assertions (no POSIX-shaped read, no bare $HOME/~ expansion) stay.
        check(!scenario.commandLog.some((c) => /^\$HOME\/\.fleet-git-credential-/.test(c)), `Expected NO POSIX-shaped credential-read command for a Windows member, commandLog: ${JSON.stringify(scenario.commandLog)}`);
        check(!scenario.commandLog.some((c) => hasBareHomeExpansion(c)), `Expected no dispatched command to carry a bare $HOME/~ expansion, commandLog: ${JSON.stringify(scenario.commandLog)}`);

        const prCmd = scenario.commandLog.find((c) => c.startsWith('curl.exe -sS -X POST') && c.includes('/pulls'));
        check(!!prCmd, `Expected the Publish PR step to actually dispatch a create-pull-request command, commandLog: ${JSON.stringify(scenario.commandLog)}`);
        check(prCmd.includes('Authorization: Bearer mock-vcs-module-token'), `Expected the create-pull-request dispatch to carry the token the handoff substituted server-side, got: ${prCmd}`);
    });
});

const PR_401_BODY = `${JSON.stringify({ message: 'Bad credentials' })}\n401`;
const PR_SUCCESS_BODY = (prUrl) => `${JSON.stringify({ number: 501, html_url: prUrl })}\n201`;

test('mock sprint (Windows member): Publish PR auth-retry loop re-reads the Windows credential after a 401 and the retry succeeds', async () => {
    clearMemberOsCache();
    await withScenarioMarkers('publish-pr-windows-401-heal', async () => {
        console.log('Running mock sprint scenario (Publish PR, Windows member, 401 auth-retry)...');
        const prUrl = 'https://github.com/mock-org/mock-repo/pull/501';
        const scenario = await runWindowsPublishPrScenario('winpub-401heal', { pullsQueue: [PR_401_BODY, PR_SUCCESS_BODY(prUrl)] });

        check(!scenario.error, `Expected the sprint to complete without throwing after the reactive auth-heal retry, got: ${scenario.error ? `${scenario.error.constructor.name}: ${scenario.error.message}` : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected the sprint to succeed after the retry, got: ${JSON.stringify(scenario.result)}`);

        // apra-fleet-3swo.7.6: the auth-retry loop still re-provisions and
        // retries the SAME create-pull-request command once, but the
        // credential re-read now happens INSIDE the handoff -- once per
        // vcs_credential_exec call, server-side -- so it is no longer
        // observable in the commandLog. The retired assertion was "at least 2
        // powershell -EncodedCommand credential reads"; its property (each
        // attempt, including the post-401 retry, goes out carrying a freshly
        // resolved credential rather than an empty/stale one) is re-expressed
        // below as: BOTH create-pull-request attempts carry the substituted
        // token.
        const prCalls = scenario.commandLog.filter((c) => c.startsWith('curl.exe -sS -X POST') && c.includes('/pulls'));
        check(
            prCalls.length >= 2 && prCalls.every((c) => c.includes('Authorization: Bearer mock-vcs-module-token')),
            `Expected BOTH create-pull-request attempts to carry the handoff-substituted token (proving the credential was resolved for the retry too), got: ${JSON.stringify(prCalls)}`
        );

        check(prCalls.length === 2, `Expected exactly one bounded retry (2 total create-pull-request attempts), commandLog: ${JSON.stringify(scenario.commandLog)}`);
        check(
            scenario.logs.some((m) => m.includes('auth-classified failure') && m.includes('HTTP 401')),
            `Expected a logged auth-classified-failure message naming HTTP 401, logs: ${JSON.stringify(scenario.logs)}`
        );
    });
});
