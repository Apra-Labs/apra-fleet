// Fixture for apra-fleet-eft.37.6 boundary e2e test (acceptance 2, POSITIVE
// case): shaped like the real auto-sprint/runner.js workflow script -- it
// dispatches one agent() call and returns a { verdict, prUrl } result, the
// same shape core used to mint by name (docs/workflow-core-boundary-
// refactoring.md M2) and now only stores wholesale/opaquely as `state.result`
// for the auto-sprint dashboard extension (packages/apra-fleet-se/
// auto-sprint/viewer-extensions.mjs's renderResultExtrasHtml) to render.
export const meta = {
    name: 'auto-sprint',
    description: 'auto-sprint-shaped workflow returning { verdict, prUrl }'
};

export async function main(context) {
    const { agent, log, phase } = context;

    phase('Develop');
    const agentResult = await agent('do the work', { member_name: 'fleet-dev' });
    log(`agent said: ${agentResult}`);

    return { verdict: 'MERGED', prUrl: 'https://github.com/example/repo/pull/42' };
}
