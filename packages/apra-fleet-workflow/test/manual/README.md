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
  then runs a small in-line workflow script (`command()` + `agent()`)
  against up to two of them through `WorkflowEngine`, and serves a live
  dashboard via `createDashboardViewer` for the duration of the run.
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

## Why these are quarantined here (apra-fleet-unw.1)

These files previously lived at `test/e2e-runner.mjs` and
`test/integration/*.mjs` and had bit-rotted: dead imports (pre-rename
`./lib/fleet-client/*` paths, a nonexistent `startViewer` export) and an
unconditional live-network dependency, which made them fail the moment
anything tried to run them. They were moved here, had their imports
repaired to match the current package layout
(`@apralabs/apra-fleet-client`, `../../src/workflow/*`,
`createDashboardViewer`), and are intentionally excluded from
`package.json`'s `test` script (`node --test test/*.test.mjs`) because
they require infrastructure the automated suite does not provide.

The in-process, mock-fleet-API coverage that replaces what these files
*can* cover without a live server lives in `test/test-runner.test.mjs`
and `test/apra-fleet-workflow.test.mjs`.

**Gap note:** there is currently no beads issue that owns real,
live-fleet-server E2E coverage for `apra-fleet-workflow` (checked
2026-07-11; the closest related issue, `apra-fleet-1az`, is scoped to
OpenCode E2E design in a different area of the repo). If/when that
coverage is prioritized, a new issue should reference this directory as
the starting point.
