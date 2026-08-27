import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-5co8.2.2 -- mock-sprint (end-to-end, real runner.js code paths)
// coverage for the UNATTENDED Azure DevOps VCS-auth PREFLIGHT
// (createVcsAuthPreflightCallback -> provisionVcsAuthForMember ->
// buildProvisionArgsForProvider -> AzureDevOpsVCS.buildProvisionArgs,
// apra-fleet-5co8.2.1) and its typed, non-prompting failure mode.
//
// Same family as mock-sprint-member-vcs-provider-threading.test.mjs
// (apra-fleet-417.9): a scripted `args.callTool` plus an ADO-shaped
// `originUrl`, dispatched through the REAL runner.js via
// `runDevelopLoopScenario` (WorkflowEngine.executeFile -> runSprintCycle's
// withGitSync bracket -> the real `ensureVcsAuthFresh` preflight callback),
// not a hand-built call into `createVcsAuthPreflightCallback` (that unit-level
// coverage already exists in vcs-provision-args-hook.test.mjs and
// vcs-auth-preflight.test.mjs -- neither drives an Azure DevOps member all the
// way through a real sprint cycle).
//
// Three cases per the bead:
//   (a) an Azure DevOps member: provision_vcs_auth is invoked with the
//       derived org_url and a secure PAT placeholder, unattended -- no
//       out-of-band prompt path is ever entered.
//   (b) the named secret is absent from the credential store: the preflight
//       never calls provision_vcs_auth and the run's own logs surface the
//       typed ERROR naming `credential_store_set` (never a prompt).
//   (c) a GitHub member is unaffected: its provision_vcs_auth args keep the
//       GitHub-App shape (git_access/repos), never an Azure DevOps org_url/pat.
// =============================================================================

const AZ_ORIGIN = 'https://dev.azure.com/mock-org/mock-project/_git/mock-repo';

test('mock sprint: an Azure DevOps member is provisioned unattended by the preflight, with a derived org_url and a secure PAT placeholder', async () => {
    await withScenarioMarkers('5co8.2.2 ado preflight provisions', async () => {
        const vcsAuthCalls = [];
        const base = defaultMockCallTool();
        const callTool = async (name, args) => {
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ vcsProvider: 'azure-devops' }) }] };
            }
            if (name === 'credential_store_list') {
                return { content: [{ text: JSON.stringify([{ name: 'azdevops_pat', scope: 'persistent' }]) }] };
            }
            if (name === 'provision_vcs_auth') {
                vcsAuthCalls.push(args);
                return { content: [{ text: 'Provisioned VCS credential (PAT mode, no expiry).' }] };
            }
            return base(name, args);
        };

        const scenario = await runDevelopLoopScenario('5co82_2ado_ok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the unattended Azure DevOps preflight' }],
            maxCycles: 1,
            callTool,
            originUrl: AZ_ORIGIN,
        });

        // The unattended preflight must complete the whole sprint cycle on
        // its own -- no interactive/out-of-band prompt path exists in this
        // wiring, so a run that reaches one would surface as an unexpected
        // top-level dispatch error, never a silent stall.
        check(!scenario.error, `expected no sprint-level error from the unattended preflight path, got: ${scenario.error ? scenario.error.message : ''}`);

        // apra-fleet-5co8.14.2 (revert-proofing for apra-fleet-5co8.14.1):
        // this scenario's single task reaches Publish PR, whose
        // raiseVcsPrForMember -> buildCreatePrCommand path shells VCSModule's
        // Azure DevOps create-pull-request curl
        // (.../pullrequests?api-version=...) via execute_command. Assert
        // BOTH that this exact command was actually issued (proving there
        // was something here to intercept -- a suite that never reaches this
        // call would pass vacuously) AND that the run is HERMETIC: no
        // command/log/error text anywhere in the scenario carries the
        // signature of a real curl escaping this in-process mock and hitting
        // the network for real ('curl: (6)' / 'Could not resolve host', the
        // exact strings a real, offline curl against dev.azure.com prints).
        //
        // Exercised against the regression this guards: narrowing
        // mock-sprint-harness.mjs's PR-curl predicate back to the GitHub
        // '/pulls' shape (reverting apra-fleet-5co8.14.1's
        // `isAzureDevOpsCreatePr` branch) makes the ADO create-PR curl above
        // fall through to the harness's real-exec fallback, which spawns a
        // genuine curl against the unreachable https://dev.azure.com host in
        // this offline test environment and fails with exactly one of the
        // two strings below -- confirmed by temporarily reverting that
        // harness change locally and re-running this file (it failed on the
        // hermeticity assertion, as intended; the revert was not committed).
        const adoCreatePrCommands = scenario.commandLog.filter((c) => /\/pullrequests\?api-version=/.test(c));
        check(
            adoCreatePrCommands.length === 1,
            `expected exactly one Azure DevOps create-pull-request curl to have been issued via VCSModule, got: ${JSON.stringify(scenario.commandLog)}`,
        );
        const haystack = [...scenario.commandLog, ...scenario.logs, scenario.error ? scenario.error.message : ''].join('\n');
        check(!/curl: \(6\)/.test(haystack), `expected no real curl escape (curl: (6)) in the run output, got: ${haystack}`);
        check(!/Could not resolve host/.test(haystack), `expected no real curl escape (Could not resolve host) in the run output, got: ${haystack}`);

        // THE acceptance criterion: provision_vcs_auth was invoked, unattended,
        // with the org_url derived from the member's own git remote and the
        // PAT passed as a secure placeholder -- never a raw value, never
        // GitHub-App vocabulary (git_access/repos).
        check(
            vcsAuthCalls.some((c) => c
                && c.member_name === 'local'
                && c.provider === 'azure-devops'
                && c.org_url === 'https://dev.azure.com/mock-org'
                && c.pat === '{{secure.azdevops_pat}}'
                && !('git_access' in c)
                && !('repos' in c)),
            `expected an unattended provision_vcs_auth call with a derived org_url and a secure PAT placeholder, got: ${JSON.stringify(vcsAuthCalls)}`,
        );
    });
});

test("mock sprint: a member whose Azure DevOps PAT secret is absent from the credential store never provisions, and the run's own logs name credential_store_set instead of prompting", async () => {
    await withScenarioMarkers('5co8.2.2 ado preflight missing secret', async () => {
        const vcsAuthCalls = [];
        const base = defaultMockCallTool();
        const callTool = async (name, args) => {
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ vcsProvider: 'azure-devops' }) }] };
            }
            if (name === 'credential_store_list') {
                // The store is reachable but simply has no azdevops_pat entry.
                return { content: [{ text: JSON.stringify([]) }] };
            }
            if (name === 'provision_vcs_auth') {
                vcsAuthCalls.push(args);
                return { content: [{ text: 'Provisioned VCS credential (PAT mode, no expiry).' }] };
            }
            return base(name, args);
        };

        const scenario = await runDevelopLoopScenario('5co82_2ado_nosec', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the missing-secret Azure DevOps preflight' }],
            maxCycles: 1,
            callTool,
            originUrl: AZ_ORIGIN,
        });

        // A missing secret degrades the PREFLIGHT specifically (it never
        // throws out of withGitSync -- see createVcsAuthPreflightCallback's
        // own doc comment); the run must never stall waiting on an
        // interactive credential prompt because of the preflight.
        //
        // apra-fleet-5co8.14.1: with dev.azure.com's canOpenPullRequest now
        // true, this scenario's single task also reaches the Publish PR
        // phase, which calls provisionPrCapableAuthForMember ->
        // provisionVcsAuthForMember directly (not through the preflight
        // callback). That wrapper is a thin, provider-agnostic pass-through
        // over the SAME buildProvisionArgsForProvider used by the preflight
        // (runner.js:2470) with no failSoft of its own, so it re-throws the
        // identical missing-secret error at sprint level -- this is
        // pre-existing provider-agnostic publish behavior, not a preflight
        // regression, and runner.js is out of scope for this task. So this
        // case only asserts the PREFLIGHT's own behavior (no
        // provision_vcs_auth call, credential_store_set named in the logs);
        // if a sprint-level error surfaces, it must be exactly this same
        // missing-secret error and not some other regression.
        if (scenario.error) {
            check(
                /cannot provision Azure DevOps auth for member 'local': the credential store has no entry named 'azdevops_pat'/.test(scenario.error.message),
                `expected any sprint-level error to be the known missing-secret error from the (non-preflight) Publish PR phase, got: ${scenario.error.message}`,
            );
        }

        check(
            vcsAuthCalls.length === 0,
            `provision_vcs_auth must never be called when the named secret is absent, got: ${JSON.stringify(vcsAuthCalls)}`,
        );

        // THE acceptance criterion: the typed ERROR names credential_store_set
        // (and the secret name) as the remedy -- never a prompt.
        check(
            scenario.logs.some((l) => /ERROR:.*credential_store_set name=azdevops_pat/.test(l)),
            `expected the preflight's swallowed failure log to name 'credential_store_set name=azdevops_pat', got logs: ${JSON.stringify(scenario.logs.filter((l) => /preflight/i.test(l)))}`,
        );
    });
});

test('mock sprint: a GitHub member is unaffected by the Azure DevOps preflight hook -- its provision_vcs_auth args keep the GitHub-App shape', async () => {
    await withScenarioMarkers('5co8.2.2 github unaffected', async () => {
        const vcsAuthCalls = [];
        const base = defaultMockCallTool();
        const callTool = async (name, args) => {
            if (name === 'provision_vcs_auth') {
                vcsAuthCalls.push(args);
            }
            return base(name, args);
        };

        const scenario = await runDevelopLoopScenario('5co82_2gh_ok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the GitHub preflight path unchanged' }],
            maxCycles: 1,
            callTool,
            // defaultMockCallTool()'s member_detail resolves 'github', and the
            // default originUrl is already GitHub-shaped -- no override needed.
        });

        check(!scenario.error, `expected no sprint-level error, got: ${scenario.error ? scenario.error.message : ''}`);
        check(vcsAuthCalls.length > 0, 'expected at least one provision_vcs_auth call for the code-writing GitHub member');
        check(
            vcsAuthCalls.every((c) => c
                && c.provider === 'github'
                && !('org_url' in c)
                && !('pat' in c)
                && 'git_access' in c),
            `a GitHub member must never pick up the Azure DevOps org_url/pat shape, got: ${JSON.stringify(vcsAuthCalls)}`,
        );
    });
});
