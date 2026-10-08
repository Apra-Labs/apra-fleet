# Generic engine boundary (the dogfood safety net)

fleet-sprint is a generic product: the engine drives a sprint against ANY
target repo that adopts it. apra-fleet also uses fleet-sprint to build itself.
That dogfooding is how the product gets built, not what the product is -- and
it creates constant pressure to hardcode apra-fleet's own build, deploy and
runtime details into the engine, because "make the thing building apra-fleet
work" is concrete while "stay generic for the next target" is abstract.

`packages/apra-fleet-se/scripts/check-generic-boundary.mjs` is the mechanical
check for the detectable slice of that leak class. It runs in `npm test` via
`packages/apra-fleet-se/test/generic-boundary-guard.test.mjs`, and can be run
directly:

```bash
cd packages/apra-fleet-se
node scripts/check-generic-boundary.mjs                    # the engine file set; exit 1 on a finding
node scripts/check-generic-boundary.mjs path/to/file.js    # explicit files, no exceptions applied
```

## Why this exists

A real PR hardcoded apra-fleet's own `## Sandbox Deploy` runbook section,
`dist/index.js`, `APRA_FLEET_DATA_DIR`/`APRA_FLEET_PORT`/`FLEET_SE_DATA_DIR`
and `install --force` into the generic Deploy Phase dispatch prompt in
`runner.js` -- text every fleet-sprint target's deployer would have received.
Pointed at that commit, the guard reports exactly those six strings and nothing
else (`test/fixtures/generic-boundary/sandbox-deploy-leak.runner-excerpt.js`
vendors the prompt verbatim as the mutation the test proves it catches).

## What "generic engine" means

The engine file set, relative to `packages/apra-fleet-se/` (`ENGINE_FILE_SET`
in the script):

| Path | Kind | What is scanned |
|------|------|-----------------|
| `fleet-sprint/**/*.{js,mjs,cjs}` | engine code | string literals only, comments stripped (own-line comments inside template literals too) |
| `apra-pm/agents/**/*.md` | role prompts | the whole file minus HTML comments |

Everything there ships to every target. Only LLM-facing text is scanned, on
purpose: `process.env.APRA_FLEET_DATA_DIR` as an identifier is the product
configuring itself; the same name inside a prompt string tells a deployer the
target is apra-fleet. The same split is why the repo's bead-id rule allows ids
in comments and docs but never in prompts or runtime strings. A raw grep for
"apra-fleet" was rejected as the mechanism: the engine has on the order of a
thousand legitimate mentions in comments, imports and design notes, and a
check that fires on all of them is noise nobody respects.

Not in scope: `src/` (the MCP server), `bin/cli.mjs`, the supervisor, tests,
`docs/`, and apra-fleet's own `deploy.md`/playbooks/`CLAUDE.md` -- those are
either the product itself or apra-fleet acting as a target.

## What it catches

Signal patterns (`SIGNAL_PATTERNS`): each is something only
apra-fleet-the-target has, so its presence in LLM-facing engine text means the
engine assumes its target is apra-fleet. Every finding says why and where the
content belongs instead.

| id | Matches | Belongs in |
|----|---------|------------|
| `apra-fleet-build-artifact` | `dist/index.js`, `build:binary`, `install --force`, `apra-fleet install`, `~/bin/apra-fleet` | the target's `deploy.md` `## Deploy` section |
| `apra-fleet-env-var` | `APRA_FLEET_*`, `FLEET_SE_*` | the target's `deploy.md` (runtime configuration) |
| `apra-fleet-service-endpoint` | `localhost:8787`, `127.0.0.1:8787`, `port 8787` | the target's `deploy.md` / `integ-test-playbook.md` |
| `apra-fleet-repo-internals` | `packages/apra-fleet-se`, `packages/apra-fleet-client`, `apra-pm/agents`, `apra-pm/skills`, `src/tools/`, `feat/pm-reorg` | the target's `CLAUDE.md` / `AGENTS.md` |
| `apra-fleet-regression-structure` | `real-bd`, `real functional suite`, `sandbox smoke`, `smoke sprint`, `toy-sprint` (apra-fleet's own two-part regression pass) | the target's `regression-test-playbook.md` |
| `bead-id-in-llm-text` | a `bd` issue id of this repo (`apra-fleet-417.5`, `apra-fleet-eft.37.5`, `apra-fleet-5co8`) | a code comment beside the logic, or `docs/` |

Heading rule (`undocumented-target-section`): the engine may name the
target-owned files `deploy.md`, `integ-test-playbook.md` and
`regression-test-playbook.md`, but may rely only on the sections the target
contract documents (`TARGET_FILE_CONTRACT` in the script, which the test pins
to `docs/fleet-sprint-getting-started.md` sections 2.2/2.3):

| File | Required | Optional (conditional phrasing only) |
|------|----------|--------------------------------------|
| `deploy.md` | `## Deploy`, `## Smoke test` | `## Permissions` |
| `integ-test-playbook.md` | (none) | `## Permissions`, `## Setup`, `## Reset`, `## Teardown` |
| `regression-test-playbook.md` | (none) | `## Permissions`, `## Setup`, `## Teardown` |

Any other `## Heading` mentioned in LLM-facing text near a target-file name is
a finding. The reference minimal target is the public repo
`Apra-Labs/fleet-e2e-toy`; its real `deploy.md` and `integ-test-playbook.md`
are vendored verbatim under `test/fixtures/generic-boundary/`, and the test
checks every required heading exists there -- the engine may rely on what that
target guarantees and nothing more. Mentioning a non-contract section
conditionally without the `##` (for example "if deploy.md offers a sandbox
section, use it") is fine; requiring it by heading is not. To make a section
universal, add it to `TARGET_FILE_CONTRACT` and the getting-started doc, and
prove the reference target satisfies it.

### Per-target harvest writes (`harvest_mode`)

How much the harvest phase may write into the target repo is a per-target,
per-launch decision, not something the engine may assume. It is an explicit
launch option (`--harvest-mode` on the CLI, `harvestMode` on the supervisor,
`harvest_mode` in the engine args), validated in one place
(`validateHarvestOptions` in `fleet-sprint/sprint-args.mjs`):

| Mode | Target-repo writes |
|------|--------------------|
| `full` (default when unset) | sprint-analysis document under `docs/`, durable docs, README |
| `docs-dir` | analysis document and durable docs only under `harvest_docs_dir`; no README edits |
| `pr-body-only` | none -- the analysis is rendered into the PR body |
| `off` | none |

`harvest_docs_dir` is required with `docs-dir` and rejected otherwise; it must
be repo-relative (no absolute path, drive letter, backslash, `..` or `.git`,
no segment starting with `-` or ending with `.`, and no Windows reserved
device name such as `con` or `nul.md`). The engine enforces the no-write
modes itself rather than trusting the prompt: in `pr-body-only` and `off` the
harvester dispatch uses a policy row that never pushes code, the engine reads
the member's HEAD and working tree before and after the dispatch, and any
change is logged as a violation, undone on the member before Publish PR pushes
the branch (with `git reset --keep` and per-path restores, never discarding
edits that were already on the member; whatever cannot be restored safely is
left and reported as not restored), and stated in the PR body.
The sprint cost block is never written to a committed file in any mode -- it
goes to the PR body and the run log only. Knowledge-bank capture and the
low-priority backlog confirmation run in every mode because neither writes to
the target repo. The role prompt (`apra-pm/agents/harvester.md`) carries the
mode contract generically and is held by `test/generic-boundary-guard.test.mjs`
to contain no POSIX-only shell constructs, since it runs on members of any OS.

## Adding a legitimate exception

An exception takes two visible edits, never a one-line silence, so it is
reviewed in the diff:

1. A `// GENERIC-BOUNDARY-EXCEPTION: <reason>` comment in the source within a
   few lines of the text.
2. A matching entry in `ALLOWED_EXCEPTIONS` in
   `scripts/check-generic-boundary.mjs`: `file`, the pattern `ids` it may
   absorb, an `anchorRe` that must match the comment, the line `window`, and
   the `reason`.

A finding with no entry fails; an entry with no anchor throws; an entry that no
longer covers a finding fails as stale, so the allowlist cannot rot. The one
current exception is `fleet-sprint/contracts.mjs`'s version-pin Error: a
module-load message read by an apra-fleet developer, never dispatched to a
sprint agent, that has to name the package whose vendored schema drifted.

The bar for an exception is "this text describes the product, and no sprint
agent ever reads it". A dispatch prompt or role prompt never qualifies: move
the content to the target's own runbook instead.

## Limits

The guard is a tripwire, not a proof. Softer target-specific assumptions --
a prompt that presumes a deploy runbook has a particular gate or workflow step
without naming a `## Heading` -- pass it and are caught only by review. The
question to ask of any engine prompt text is: would this sentence still be
true, and useful, for `fleet-e2e-toy`?
