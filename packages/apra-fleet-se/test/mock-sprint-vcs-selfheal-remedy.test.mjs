import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-5co8.4.3 -- mock-sprint (end-to-end, real runner.js code paths)
// coverage for the authRemedy self-heal remedy messaging
// (createVcsAuthSelfHealCallback, apra-fleet-5co8.4.2): a canned Azure DevOps
// auth failure surfaces the two-step ("re-mint the PAT" / "widen its scope")
// remedy hint plus the "cannot be re-minted server-side" statement, while a
// GitHub failure keeps its pre-existing (no extra remedy line) message.
//
// Same family as mock-sprint-member-vcs-provider-threading.test.mjs
// (apra-fleet-417.9) and mock-sprint-azure-devops-vcs-preflight.test.mjs
// (apra-fleet-5co8.2.2): a scripted `args.callTool` plus an ADO-shaped
// `originUrl`, dispatched through the REAL runner.js via
// `runDevelopLoopScenario`. Unit-level coverage of
// createVcsAuthSelfHealCallback's call shape already exists in
// vcs-auth-self-heal.test.mjs; this suite's job is the remedy LOG TEXT,
// reached only through the real onAuthFailure wiring end to end.
// =============================================================================

const AZ_ORIGIN = 'https://dev.azure.com/mock-org/mock-project/_git/mock-repo';
const TF401019_BARE = "remote: TF401019: The Git repository with name or identifier 'core' does not exist, or you do not have permission to perform this operation.";
const G_PUSH_PATTERN = /^git push origin /;

test('mock sprint: a bare Azure DevOps TF401019 G-push failure self-heal surfaces the two-step remedy and the not-re-mintable statement', async () => {
    await withScenarioMarkers('5co8.4.3 azure-devops remedy text', async () => {
        const base = defaultMockCallTool();
        const callTool = async (name, args) => {
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ vcsProvider: 'azure-devops' }) }] };
            }
            return base(name, args);
        };

        const scenario = await runDevelopLoopScenario('5co843_ado_remedy', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the azure-devops self-heal remedy messaging' }],
            maxCycles: 1,
            callTool,
            gitGhFailurePattern: G_PUSH_PATTERN,
            gitGhFailureMessage: TF401019_BARE,
            originUrl: AZ_ORIGIN,
        });

        check(scenario.error, `expected the persistently-failing G-push to surface as a sync error, got no error at all. logs: ${JSON.stringify(scenario.logs.slice(-30))}`);

        // The not-re-mintable statement.
        check(
            scenario.logs.some((l) => /whose credentials cannot be re-minted server-side/.test(l) && /'local'/.test(l) && /'azure-devops'/.test(l)),
            `expected the self-heal remedy log to state Azure DevOps credentials cannot be re-minted server-side for member 'local', got logs: ${JSON.stringify(scenario.logs.filter((l) => /self-heal/.test(l)))}`,
        );

        // The two-step remedy: re-mint (expired/revoked PAT) OR widen scope
        // (insufficient-scope denial), both funneling through
        // credential_store_set + provision_vcs_auth.
        check(
            scenario.logs.some((l) => /create a new PAT at https:\/\/dev\.azure\.com\/ORG\/_settings\/tokens/.test(l)),
            `expected the remedy hint's re-mint step (new PAT at dev.azure.com), got logs: ${JSON.stringify(scenario.logs.filter((l) => /self-heal/.test(l)))}`,
        );
        check(
            scenario.logs.some((l) => /create a PAT with broader.*scopes/.test(l)),
            `expected the remedy hint's widen-scope step, got logs: ${JSON.stringify(scenario.logs.filter((l) => /self-heal/.test(l)))}`,
        );
        check(
            scenario.logs.some((l) => /credential_store_set/.test(l) && /re-run provision_vcs_auth/.test(l)),
            `expected the remedy hint to name credential_store_set followed by re-running provision_vcs_auth, got logs: ${JSON.stringify(scenario.logs.filter((l) => /self-heal/.test(l)))}`,
        );
    });
});

test("mock sprint: a GitHub member's self-heal keeps its existing message -- no Azure DevOps remedy line is ever printed", async () => {
    await withScenarioMarkers('5co8.4.3 github unaffected', async () => {
        const base = defaultMockCallTool();
        const callTool = async (name, args) => base(name, args);

        const scenario = await runDevelopLoopScenario('5co843_gh_remedy', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the github self-heal messaging is unchanged' }],
            maxCycles: 1,
            callTool,
            gitGhFailurePattern: G_PUSH_PATTERN,
            gitGhFailureMessage: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            // defaultMockCallTool()'s member_detail resolves 'github', and the
            // default originUrl is already GitHub-shaped -- no override needed.
        });

        check(scenario.error, `expected the persistently-failing G-push to surface as a sync error, got no error at all. logs: ${JSON.stringify(scenario.logs.slice(-30))}`);

        // The self-heal itself still fires (unchanged behavior)...
        check(
            scenario.logs.some((l) => /self-heal: auth failure detected for member 'local'/.test(l)),
            `expected the self-heal to still fire for the github member, got logs: ${JSON.stringify(scenario.logs.filter((l) => /self-heal/.test(l)))}`,
        );
        // ...but no Azure DevOps-only remedy line is ever printed -- github's
        // provider descriptor declares no `authRemedy`, so the "cannot be
        // re-minted server-side" branch never fires for it.
        check(
            !scenario.logs.some((l) => /cannot be re-minted server-side/.test(l)),
            `must NOT print the Azure DevOps-only remedy line for a github member, got logs: ${JSON.stringify(scenario.logs.filter((l) => /self-heal/.test(l)))}`,
        );
    });
});
