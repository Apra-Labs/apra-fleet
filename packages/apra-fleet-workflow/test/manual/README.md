# Manual / live E2E fixtures

The scripts in this directory are **not** part of `npm test`. They are
manual E2E harnesses that connect to a real apra-fleet MCP server on
`http://127.0.0.1:7523/mcp` and drive real fleet members (agent prompts,
shell commands, file transfer). They cannot run in CI or in the automated
test suite because they depend on:

- a live `apra-fleet` MCP server process listening on `127.0.0.1:7523`
- at least one online local fleet member (e.g. `apra-pm`, `fleet-dev`,
  `alpha`, depending on the script)

## Files

- `e2e-runner.mjs` -- discovers online local members via `fleetStatus`,
  then runs `e2e-harness-script.mjs` against up to two of them through
  `WorkflowEngine`, and serves a live dashboard via `createDashboardViewer`
  for the duration of the run.
- `e2e-harness-script.mjs` -- the workflow script `e2e-runner.mjs` loads
  via `executeFile()`: a Discovery phase followed by a non-destructive
  `command()` + `agent()` pass over each discovered target.
- `test-engine-run.mjs` -- runs `test-workflow.js` (a fixture workflow
  exercising `agent()`, `parallel()`, and `sequential()`) against member
  `alpha` through `WorkflowEngine.executeFile()`.
- `test-real-member.mjs` -- exercises `ApraFleet.sendFiles()` /
  `receiveFiles()` against member `apra-pm` with a real file round-trip.
- `test-workflow.js` -- the workflow fixture used by `test-engine-run.mjs`.

## How to run

```bash
# 1. Start a live apra-fleet MCP server with the relevant member(s) online.
# 2. From packages/apra-fleet-workflow:
node test/manual/e2e-runner.mjs
node test/manual/test-engine-run.mjs
node test/manual/test-real-member.mjs
```

## Why these live in `test/manual/` rather than `test/`

`package.json`'s `test` script is `node --test test/*.test.mjs`, which
picks up only files directly under `test/`. Keeping these one level down,
without a `.test.mjs` suffix, is what excludes them from the automated
suite -- they need infrastructure it does not provide. Anything added
here must keep both properties, or it will start failing CI the moment a
live server is unavailable (which is always).

The in-process, mock-fleet-API coverage of what these files *can* cover
without a live server lives in `test/test-runner.test.mjs` and
`test/apra-fleet-workflow.test.mjs`.

**Gap note:** nothing owns real, live-fleet-server E2E coverage for
`apra-fleet-workflow`. If that coverage is prioritized, this directory is
the starting point.
