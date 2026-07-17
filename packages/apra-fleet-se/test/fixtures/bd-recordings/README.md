# bd CLI recordings (replay fixtures)

One JSONL file per test scenario. Each line is one real `bd` CLI invocation
captured while the ACTUAL test suite ran against a real `bd` binary:

    { "command": "...", "exitCode": 0, "stdout": "...", "stderr": "...", "errMessage"?: "..." }

These files back the suite's default **replay** mode (see
`test/helpers/bd-replay.mjs`): every `bd ...` command a test issues is
answered from its scenario's recording instead of spawning the real Go/Dolt
`bd` binary, which cuts the suite's wall time from minutes to seconds.
Replay never fabricates output -- if a test issues a bd command with no
matching recorded response, it fails loudly with re-record instructions.

## Mode selection (`APRA_FLEET_BD_MOCK`)

| Value                 | Mode   | npm script            | Behavior |
|-----------------------|--------|-----------------------|----------|
| unset / anything else | replay | `npm test` / `npm run test:unit` | Answer bd calls from these recordings (fast, no bd binary needed) |
| `0` `false` `off` `no` `real` | real | `npm run test:integration` | Run the real `bd` CLI for every call -- byte-for-byte the pre-shim behavior. **This is the unmocked, real-bd suite** (referenced by CI / integ-test-playbook checks) |
| `record`              | record | `npm run test:record` | Run the real `bd` CLI AND rewrite these recordings from what it actually returns |

## Refreshing the recordings

Do NOT edit these files by hand (`test/bd-recordings-fidelity.test.mjs`
rejects hand-edited files). Whenever `bd`'s output format changes (a bd
upgrade), or a test/runner change alters which bd commands a scenario
issues, regenerate by re-running the real suite in record mode and
committing the result:

    npm run test:record --workspace=@apralabs/apra-fleet-se
    git add packages/apra-fleet-se/test/fixtures/bd-recordings
    git commit

Because recording is a side effect of the real integration tests actually
running (there is no separate recording driver), the fixtures can never
drift from what the tests really issue. To record/refresh a single
scenario's fixture, pass its test file through:

    node scripts/run-tests.mjs record test/mock-sprint-happy-path.test.mjs

A new test scenario added via the harness (`setup()` / `setupMinimal()` /
`runDevelopLoopScenario()` with a fresh unique tag) gets its fixture the
same way: run its file once in record mode with `bd` installed.
