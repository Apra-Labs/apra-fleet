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

## Recording a fixture when you author a new bd-touching test

If you write a NEW test that shells out to `bd` (directly or via a scenario
helper), you must record its fixture at authoring time, in the same commit
as the test -- do not defer this to the sprint's once-per-sprint
integration pass. An unrecorded scenario either fails loudly in replay mode
(see the `[bd-replay] No bd recording found for scenario ...` error above)
or, if it happens to share a scenario key with an existing fixture, is
silently served someone else's recorded output.

1. Make sure a real `bd` binary is installed and on PATH (record mode
   spawns the real CLI).
2. Record just your new test file (fastest, and avoids touching every other
   fixture):

       node scripts/run-tests.mjs record test/<your-new-test-file>.test.mjs

   Or record the whole suite (equivalent, but slower, and will refresh
   every fixture, not just yours):

       npm run test:record --workspace=@apralabs/apra-fleet-se

   Both ultimately set `APRA_FLEET_BD_MOCK=record` (see `scripts/run-tests.mjs`)
   and run the real test file, capturing every `bd` invocation it issues.
3. Where it lands: one file per scenario at
   `test/fixtures/bd-recordings/<scenario-key>.jsonl`, where `<scenario-key>`
   is derived from the scenario's temp-directory basename with its trailing
   `-<millis>-<pid>` suffix stripped (see `scenarioKeyFromCwd` in
   `test/helpers/bd-replay.mjs`). In practice this means whatever unique tag
   you pass to `setup()` / `setupMinimal()` / `runDevelopLoopScenario()`
   becomes (prefixed by the harness) the fixture's filename -- follow the
   existing naming pattern in this directory, e.g.
   `apra-fleet-mock-sprint-<your-tag>.jsonl` or
   `apra-fleet-golden-<your-tag>.jsonl`.
4. Commit the new `.jsonl` fixture alongside the test that produced it, in
   the same commit -- a test that shells out to `bd` with no committed
   fixture will fail for every other developer/CI running the default
   replay-mode suite (`npm test` / `npm run test:unit`), not just for you.
5. Re-recording when bd's output shape changes: fixtures are tied to the
   exact `bd` CLI version they were recorded against. If the installed
   `bd` version differs from the one a fixture was recorded with (a bd
   upgrade, a changed flag/output format), re-record rather than
   hand-editing the JSONL (hand-edits are rejected by
   `test/bd-recordings-fidelity.test.mjs` and will drift from what `bd`
   actually returns). Re-record with the same `record` mode command as
   above, then commit the refreshed fixture.
