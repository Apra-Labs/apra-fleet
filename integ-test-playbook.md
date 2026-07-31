# Fleet Feature Closure Test Playbook

This playbook is run EVERY CYCLE by the `integ-test-runner` agent, in the
Test group. Its job is to close out this cycle's new feature work: for each
feature the orchestrator hands the runner, verify its acceptance criteria
against the sprint branch working tree and close it, or file a bug.

This playbook does NOT do:
- No sandbox lifecycle (`## Setup` / `## Reset` / `## Teardown`).
- No toy-sprint smoke test.
- No full real-`bd` functional suite.

Those all live in `regression-test-playbook.md`, run ONCE PER SPRINT by
`regression-test-runner` in the Finalization group. If a step here would
need a throwaway install/server/toy-repo sandbox, it belongs there, not
here.

(The `deployer` agent is a different role: it follows `deploy.md` to
deploy the software onto the target; it does not run this file.)

## Permissions

Commands below require these prefixes in `.claude/settings.json` under
`permissions.allow` (verify each is present before running anything):
- `Bash(npm test*)`
- `Bash(npm run *)`
- `Bash(npx vitest *)`
- `Bash(bd *)`

## Inputs

The orchestrator's dispatch prompt supplies an **explicit list of feature
ids** -- the open features in this sprint's subtree, already scoped for
the runner. Test ONLY those, one at a time. Do not derive the list
yourself (e.g. via `bd list --type=feature --status=open`, which is
unscoped and returns every open feature in the whole beads DB).

An explicitly empty feature-id list ("zero open features this cycle") is a
normal, successful outcome -- report zero closed and a summary saying
there was nothing to test. Only treat the input as genuinely missing (not
merely empty) when the dispatch prompt gives no indication a scoped list
was computed at all; in that case stop and report the scoped list is
missing rather than guessing.

## Procedure

For each feature id handed to the runner:

1. `bd show <feature-id>` -- read the feature description and acceptance
   criteria.
2. `bd dep list <feature-id>` -- find its `[test]` task(s): filter the
   output for items with `[test]` in the title. These were written and
   closed by the doer after writing the test code.
3. Run exactly the tests those `[test]` tasks describe, repo-local,
   against the sprint branch working tree -- e.g. `npm test`, a targeted
   vitest file, or a documented script. Do not invent additional checks
   beyond what the `[test]` task specifies.
4. Observe which assertions passed and which failed, with their output.
5. Record the result:
   - **All pass**: `bd close <feature-id>`. No bug needed.
   - **Any fail**: do NOT close the feature. File a bug parented under the
     sprint scope id given in the dispatch prompt (grouping only -- do not
     also `bd dep add` the bug to the feature or the scope root):

     ```bash
     bd create \
       --title="[integ] <short description of failure>" \
       --description="Feature: <feature-id>
     Expected: <what should happen>
     Actual: <what happened>
     Test: <which test failed and its output>
     Repro: <minimal steps to reproduce>" \
       --type=bug \
       --priority=<see priority rules below> \
       --parent=<the scope id named in your dispatch prompt>
     ```

     Priority rules:
     - **P0**: system will not start or core path is completely broken
     - **P1**: requirement from the sprint goal is explicitly not met
     - **P2**: requirement partially met; degraded or inconsistent behaviour
     - **P3**: quality, performance, or UX issue that does not block the core function

     Before creating a new bug, search for duplicates:
     ```bash
     bd search "[integ]"
     ```
     If an existing bug covers the same failure, update its description
     rather than creating a new one.
   - **Inconclusive** (test infrastructure failure, flaky, environment
     error): leave the feature open and note why:
     ```bash
     bd update <feature-id> --notes="integ-test-runner: inconclusive -- <reason>"
     ```

## Waiting on a long-running test run

Feature tests can legitimately take several minutes. Never wait for one
inside a single silent blocking call -- a long silent stretch looks like a
hang to the dispatch layer's inactivity watchdog and can kill the run
mid-work. Instead:
- Send the run to the background, or poll it in short, bounded checks.
- Between checks, say so explicitly before checking again (e.g.
  "still running, checked at HH:MM:SS -- checking again shortly").
- Check at least every ~2 minutes while waiting; do not poll much faster
  than that either.
- Never use a silent `sleep`-based wait loop, and do not route around this
  by chaining several short sleeps.
- Do not end your turn or report final results while a run is still in
  progress.

## Rules

- NEVER close a feature unless ALL its tests pass.
- NEVER write or modify test code.
- NEVER fix application bugs -- report them as beads issues.
- NEVER close type=task issues.
- Tag every new issue title with `[integ]` so they are searchable and
  distinguishable from planned work.

## Adding new features to this test

This playbook covers repo-local, per-feature test execution only. For
anything sandbox- or environment-level -- a new required member role, a
new pre-sprint gate, a new CLI subcommand, a toy-sprint scenario step --
extend `regression-test-playbook.md` instead; that is where install/server/
sandbox lifecycle coverage lives.
