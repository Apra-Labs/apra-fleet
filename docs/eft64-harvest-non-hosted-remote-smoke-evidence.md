<!-- llm-context: Live-smoke evidence record for apra-fleet-eft.64.7, corroborating
     apra-fleet-eft.64.1 (Harvest skips PR creation and closes the target issue
     directly for a non-hosted file:// remote) and apra-fleet-eft.64.4's mock-sprint
     unit coverage, on branch feat/sprint-service-1. -->
<!-- keywords: eft.64, Harvest, gh auth, non-hosted remote, PR skip, canary closed, smoke test -->

# eft.64 live smoke retest evidence (apra-fleet-eft.64.7)

## Context

apra-fleet-eft.64's impl (`.64.1`) and unit tests (`.64.2`/`.64.4`) were already closed
against mock-sprint fixtures, plus an earlier live-smoke pass (`.64.3`, 2026-07-22).
This bead is a fresh live-smoke retest mandated after two prior cycles could not
gather evidence (a 2026-07-27 cycle blocked by apra-fleet-eft.84's install EISDIR,
and this cycle's own first attempt blocked by apra-fleet-eft.86: dev-mode `install`
never provisioned the workflow subsystem). apra-fleet-eft.86 has since landed on this
branch (`575d99d0` impl, `54091825` test) -- confirmed present by the absence of the
"`[!] This build has no workflow-subsystem assets`" warning during this retest's
Setup, and `workflow --list` showing `fleet-sprint`/`hello-world` installed. Rebuilt
`dist/` from current source (`npm run build`) before Setup to rule out a stale-dist
explanation.

Ran integ-test-playbook.md's `## Setup` (fresh sandbox HOME
`~/temp/.apra-fleet-tests-eft647`, scratch port `18708`), member registration +
credential provisioning (same bare-token workaround as the eft.63.3/eft.74/eft.65
evidence docs: `INTEG-TOY-DOER-TOKEN-RAW` from `$CLAUDE_CODE_OAUTH_TOKEN`, verified
via `check-toy-doer-credentials.mjs`), then the full toy sprint end to end:

```
node dist/index.js workflow fleet-sprint --issue gh-toy-4ef --members toy-doer \
  --branch smoke-test-canary --base main --max-cycles 1 --dispatch-timeout-s 900
```

(`fleet-sprint` is this branch's current name for the bead's `auto-sprint` command,
same rename noted in eft.63.3/eft.65.8's evidence docs.)

## Live evidence (this run)

The run proceeded through every phase without any gh-auth failure: Sprint Setup ->
Plan C1 R1 -> Develop C1 R1 (gh-toy-4ef.1 closed) -> Review C1 R1 (looped back) ->
Develop C1 R2 (gh-toy-4ef.2 closed) -> Review C1 R2 (cycle organically complete,
APPROVED) -> Deploy C1 -> Integ Test C1 -> Final Review C1 -> **Harvest C1**.

Harvest's Publish PR phase log, verbatim:

```
--- Phase: Publish PR C1 ---
[Workflow Log] Publish PR: origin remote 'file:///.../.apra-fleet-toy-origin.git' is
not a gh-hostable GitHub remote -- skipping PR creation entirely (no dependency on
gh auth / GH_TOKEN for this path).
[Workflow Log] Publish PR: closed target issue 'gh-toy-4ef' directly (non-hosted
remote, PASS verdict).
```

No `gh auth login` / exit-4 error anywhere in the run -- the exact failure mode the
original eft.64 bug reported. The sprint's own terminal summary:

```
Sprint finished: {
  status: 'success',
  verdict: 'PASS',
  ...
  branch: 'smoke-test-canary',
  baseBranch: 'main',
  goal: 'P1/P2',
  maxCycles: 1
}
```

## State verification

- `bd show gh-toy-4ef` after the run: **CLOSED** (was OPEN at Setup/Reset).
- `git log --oneline smoke-test-canary`: real commits from the sprint --
  `feat: add CLI entry point supporting --version/-v flag`, `test: add e2e test for
  CLI --version/-v flag`, plus Harvest's own `docs:` commits (CHANGELOG, README,
  design doc).
- Functional verification (playbook step 5, since the canary is the `--version`-flag
  issue): built the sprint branch's `dist/cli.js` and ran it directly:

  ```
  $ node dist/cli.js --version
  fleet-e2e-toy v1.0.0
  exit=0
  ```

  Prints a version string and exits 0, confirming the deliverable is not just
  closed on paper but functionally correct.

Sandbox torn down after (`node dist/index.js stop`, confirmed no leftover process on
port 3001 from the Deploy phase's `npm run start:test`, then `rm -rf` the sandbox
HOME) per `## Teardown`.

## Result

**PASS.** On `feat/sprint-service-1` at `896ef8ff` (workflow subsystem fix
apra-fleet-eft.86 confirmed present), a full live `workflow fleet-sprint` run against
the toy canary with a sandbox-local non-hosted (`file://`) git remote:

- reached Harvest without any `gh auth login required` failure;
- the Publish PR phase detected the non-hosted remote and skipped PR creation
  entirely, with an explicit log notice (no gh-auth/GH_TOKEN dependency);
- closed the target/canary issue (`gh-toy-4ef`) directly;
- the sprint ended with a terminal `status: 'success'`, `verdict: 'PASS'`;
- the delivered `--version` flag is functionally correct (`fleet-e2e-toy v1.0.0`,
  exit 0).

This corroborates apra-fleet-eft.64.1's fix and apra-fleet-eft.64.4's mock-sprint
unit coverage with real, unmocked, end-to-end live-smoke evidence, unblocking the
parent apra-fleet-eft.64 bug for closure.
