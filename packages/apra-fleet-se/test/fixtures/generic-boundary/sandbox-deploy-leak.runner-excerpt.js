// Verbatim excerpt of the Deploy Phase dispatch prompt from commit 002c0632
// ("docs(deploy): add Sandbox Deploy mode for integration/regression testing",
// branch feat/sandbox-deploy-mode), packages/apra-fleet-se/fleet-sprint/runner.js
// lines 9982-10007. This is the real incident the generic-engine boundary guard
// exists for: apra-fleet's own sandbox-deploy runbook section, build artifact,
// env vars and installer flag were written straight into the GENERIC deployer
// prompt that every fleet-sprint target receives. The guard must report exactly
// the six leaked strings here and nothing else. Never "fix" this file -- it is
// the mutation the test proves the guard catches.
const sprintSelfId = validated.runId || validated.branch;
// A sprint-dispatched deploy is ALWAYS for integration/regression
// testing, never a production rollout -- so it must use deploy.md's
// Sandbox Deploy section (isolated data dirs/ports, no installer, no
// OS auto-start registration) rather than its production Deploy
// section, which replaces the machine's shared singleton. Saying only
// "deploy to test env" left the mode to inference, and the production
// section's `install --force` was picked by default: on a host whose
// fleet server is kept alive by launchd/systemd/schtasks, its
// process-kill stop never converges (the supervisor relaunches the
// process under a new pid) and every deploy in the sprint failed.
const deployerPrompt =
    'You are deploying for INTEGRATION/REGRESSION TESTING, not a production rollout.\n' +
    "Use deploy.md's '## Sandbox Deploy (for integration/regression testing)' section, " +
    "NOT its production '## Deploy' section.\n" +
    'That means: build from source, then run the freshly built dist/index.js directly with ' +
    'an isolated APRA_FLEET_DATA_DIR, APRA_FLEET_PORT and FLEET_SE_DATA_DIR. Do NOT run the ' +
    'installer or `install --force`, do NOT stop/kill/restart any already-running fleet ' +
    'server or supervisor, and do NOT bind the production ports. The sandbox instance must ' +
    'coexist with whatever is already running on this machine.\n' +
    "deploy.md's active-sprints gate does NOT apply in sandbox mode -- it exists to protect a " +
    'shared singleton you would otherwise restart, and a sandbox deploy restarts nothing. A ' +
    'live foreign sprint is therefore not a reason to stop.\n' +
    `Use this id to name your sandbox root so concurrent deploys never collide: ${sprintSelfId}\n` +
    "Run deploy.md's Teardown for the sandbox before you return, pass or fail, and confirm the " +
    'pre-existing production instance is still running and untouched.';
