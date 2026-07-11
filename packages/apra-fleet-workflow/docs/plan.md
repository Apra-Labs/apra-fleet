# Remediation Plan: apra-fleet-workflow + apra-fleet-se/auto-sprint

**Date:** 2026-07-11
**Input:** `docs/feedback.md` (findings F1-F11, A0-A7, testing gaps 1-4) plus new findings V1-V4 (below).
**Tracking:** beads epic `apra-fleet-unw` with 19 child issues. This document is a map onto the
beads DB, not a duplicate of it -- each issue's description is self-contained (finding refs,
file scope, work items, acceptance criteria). Run `bd ready` to get the next unit(s) of work;
`bd show <id>` for the full spec.

**Hard constraint honored throughout:** no changes to the apra-fleet MCP server
(`apra-fleet.exe`, external repo). All work lives in `packages/apra-fleet-workflow`,
`packages/apra-fleet-se`, `packages/apra-fleet-client`, and (via upstream PR) `vendor/apra-pm`.

---

## 1. Bottom-up dependency analysis (why this order)

This is a fresh derivation, not feedback.md's top-5 order. The reasoning:

1. **Nothing is verifiable until the test harness runs.** Both suites are dead at import time
   (gap 1) and the SE mock is nondeterministic and silently skips half the sprint (gap 2). Any
   fix landed before this is unreviewable -- the adversarial reviewer would have no executable
   evidence. So wave W0 is the harness, asserting *current* behavior (even where current
   behavior is wrong), giving every later wave a before/after baseline.
2. **Call-level contracts before call-site fixes.** F4's typed errors and F10's hidden `resume`
   define what `agent()`/`command()` *mean*. A2 ("handle doer failure") cannot be implemented
   correctly while failures arrive as three different signals (null / throw / normal string),
   and A1/A3's "self-contained prompts" are meaningless while every dispatch silently resumes a
   prior session. Likewise F3's `BudgetExceededError` subclasses the F4 base class, and F5's
   repair loop terminates in an `AgentOutputError`. Hence W1 = typed errors + resume (unw.3),
   budget/usage honesty (unw.4), client timeout + AbortSignal (unw.5), and the `sequential()`/
   `pipeline()` arity contract (unw.6) -- the last because it is the flagship primitive whose
   ambiguity contaminates docs, examples, and tests that later waves must update.
3. **Execution model before the workflow that runs on it.** F1's loader decision (real ES
   modules, explicit context parameter) changes the *calling convention* of every workflow
   script, including `runner.js`. Doing the A-series rewrite first and the loader second would
   rewrite runner.js twice. So W2 lands the loader (unw.7), then the pieces that build on W1:
   schema-repair loop (unw.8, needs typed errors), per-run context + UUIDs (unw.9, after the
   loader restructures context passing), viewer lifecycle/cooperative-stop/XSS (unw.10, needs
   the AbortSignal plumbing from unw.5).
4. **Role contracts before the sprint phases that enforce them.** The determinism audit's
   highest-leverage observation is that ajv schemas exist and auto-sprint uses them zero times.
   But schema'd verdicts are only as good as the agent definitions honoring them -- and the
   vendored defs are internally contradictory (V1/V2 below). So W3 defines the canonical role
   enum + verdict schemas in code (unw.12), aligns the vendored agent defs to them upstream
   (unw.13), and lands the journal/resume (unw.11) -- the Claude-CLI pattern feedback.md says
   to borrow first, which needs stable activity events (unw.9) and typed errors (unw.3).
5. **The A-series last, serialized.** All four W4 issues edit `runner.js`; running them in
   parallel guarantees merge conflicts and drift. Order: A0 first (unw.14 -- until the CLI
   executes anything, the "product" cannot even be driven), then plan phase (unw.15), then
   develop/review (unw.16), then deploy/integ/exit/finalization (unw.17), mirroring sprint
   phase order so each issue's mock-test scenario builds on the previous one's.
6. **The wide verification net last.** Failure-path regression tests (unw.18) and the
   golden-transcript test (unw.19) assert *final* prompts and behavior; writing them earlier
   means rewriting them every wave.

### Dependency sketch (blocked-by edges as wired in beads)

```
W0: unw.1 (WF harness)     unw.2 (SE mock)
      |                       |
W1: unw.3 (F4+F10) ---> unw.4 (F2+F3)     unw.5 (timeout/abort)   unw.6 (F7/F8)   [all <- unw.1]
      |         \                             |                      |
W2:   |          unw.8 (F5)     unw.7 (F1 loader) <- unw.1, unw.2, unw.6
      |                            |         \
      |                         unw.9 (F11)   unw.10 (F9+A7-viewer) <- unw.5
      |                            |
W3: unw.12 (contracts) <- unw.2   unw.11 (journal) <- unw.3, unw.9
      |
    unw.13 (vendored agent defs, upstream PR)
W4: unw.14 (A0+A7-cli) <- unw.2, unw.5, unw.7
    unw.15 (A1) <- unw.8, unw.12, unw.14
    unw.16 (A2+A3) <- unw.6, unw.15
    unw.17 (A4+A5+A6) <- unw.16
W5: unw.18 (failure tests) <- unw.11, unw.17     unw.19 (golden transcript) <- unw.17
```

Note: `unw.13` (vendored defs) deliberately does NOT block the W4 issues. The W4 runner
dispatches embed the verdict schema and required context inline in every prompt (the shim), so
auto-sprint is correct even before the upstream apra-pm PR merges.

---

## 2. New findings from the vendored-agent comparison (V-series)

Discovered in this planning pass by reading `vendor/apra-pm/agents/*.md` and
`vendor/apra-pm/skills/pm/SKILL.md` against runner.js -- feedback.md's A-series inferred the
role contracts from SKILL.md only and missed that the agent defs disagree with it:

| ID | Finding |
|----|---------|
| V1 | `skills/pm/SKILL.md` (reviewer spec) says the reviewer "writes feedback.md ... reopenIds/newTasks ... never touches beads". `agents/reviewer.md` says the opposite twice: reopen directly via `bd update <id> --status=open`, and "NEVER write feedback.md -- return structured output only". feedback.md A3 cited only the SKILL.md half. Resolution: reviewer returns structured output only, orchestrator applies transitions (deterministic-state-machine direction). |
| V2 | `agents/plan-reviewer.md` criterion 10 hard-fails any task without model metadata, but `agents/planner.md` never instructs setting it, and SKILL.md says the tier lives in `--notes` while plan-reviewer.md reads the `METADATA` section. A planner + plan-reviewer pair as-written loops CHANGES NEEDED forever. |
| V3 | Agent defs require dispatch-supplied context that auto-sprint never provides: `<base-branch>`/`<branch>` (reviewer.md, harvester.md), `analysisArtifactFile`/`analysisText`/`costAnalysis` (harvester.md). No defined behavior when inputs are missing -- the defs must degrade loudly (return FAILED/BLOCKED with notes) to be rugged both under auto-sprint and standalone `pm` use, with beads as the state tracker in both modes. |
| V4 | Every def's output contract is prose ("Return your structured output"). None carries an actual JSON schema, so nothing pins the shape runner.js will ajv-validate. (Also: several defs invoke `bd remember`, which current `bd --help` does not list -- verify/replace upstream.) |

**Vendoring process decision:** `vendor/apra-pm` is a **git submodule** of
`Apra-Labs/apra-pm` (see `.gitmodules`; prior art in this repo's history:
`chore(pm): bump apra-pm to acf62b4 and sync installer`). So agent-def fixes follow option (b)
upstream-first: branch inside the submodule, PR to `Apra-Labs/apra-pm`, then bump the submodule
pointer here -- tracked as `unw.13`, with the runner-side inline-schema prompts (`unw.15`-`unw.17`)
serving as the local shim so nothing in this repo blocks on the upstream merge.

---

## 3. The per-iteration ritual (replayed for every issue)

**An iteration = exactly one beads issue** from `bd ready` within the epic (`bd ready` +
priority order picks it; ties broken by wave number in the title).

| Step | Actor / tier | Action |
|------|--------------|--------|
| 1. Claim | Orchestrator (cheap, mechanical) | `bd update <id> --claim`; read `bd show <id>`; re-read the cited feedback.md/plan.md sections. |
| 2. Implement | **Premium-tier agent** (design judgment) | Implement strictly within the issue's declared "Scope (files)". Write/extend tests named for the finding IDs. |
| 3. Test run | **Cheap/background agent** (mechanical) | Run `npm test` (and the package-scoped suites) and report pass/fail + failure text verbatim. Never the implementer's own claim -- an independent execution. |
| 4. Adversarial review | **Separate premium-tier agent, fresh context** (never the implementer) | Inputs: the issue's acceptance criteria, the cited feedback.md finding(s), the full diff, and the step-3 test report. Checks: (a) every acceptance criterion demonstrably met; (b) diff touches only declared scope; (c) no new failure mode introduced (races, swallowed errors); (d) tests actually assert the fix (would fail on revert). Verdict: APPROVED or CHANGES NEEDED with specific file:line findings. The reviewer CAN and SHOULD reject. |
| 5. Loop or close | Orchestrator | CHANGES NEEDED -> back to step 2 with the findings (max 3 rounds, then escalate to the human -- never proceed unapproved; this plan does not repeat runner.js's A1 bug in its own process). APPROVED -> commit (conventional style, referencing the issue id), `bd close <id>`. |

**Anti-drift guardrails (binding):**

- **Scope fence:** an iteration must not modify files or address findings outside its issue's
  declared scope. The adversarial reviewer rejects out-of-scope hunks even if they are good.
- **Discoveries become issues, not fixes:** anything new found mid-iteration (bug, gap,
  refactor urge) is filed via `bd create --deps discovered-from:<current-id>` under the epic
  and left alone. No inline opportunistic fixes.
- **Gate between iterations:** iteration N+1 must not start until iteration N's issue is
  `closed`, and only the orchestrator closes -- after the adversarial APPROVED verdict, never
  on the implementer's "done".
- **Tier discipline:** test execution, `bd`/`git` state queries, and grep-style verification
  run on cheap/background agents; implementation and adversarial review run on premium-tier.
  Parallel-eligible issues (e.g. unw.4/unw.5/unw.6 after unw.3) may run concurrently only if
  their scope fences do not overlap on any file.

---

## 4. Waves -> beads issues

Epic: **`apra-fleet-unw`** -- `[EPIC] Remediate feedback.md findings` (P1).

| Wave | Issue | P | Title (abbrev.) | Findings |
|------|-------|---|-----------------|----------|
| W0 | `apra-fleet-unw.1` | P1 | Repair WF test harness | gap 1 |
| W0 | `apra-fleet-unw.2` | P1 | Deterministic SE mock sprint test | gap 2 |
| W1 | `apra-fleet-unw.3` | P1 | Typed error contract + surface `resume` (default false) | F4 (client-side scope), F10 |
| W1 | `apra-fleet-unw.4` | P1 | Honest usage, budget enforcement, pricing sanity | F2, F3 |
| W1 | `apra-fleet-unw.5` | P1 | Client-side MCP timeout + AbortSignal | F6 (partial) |
| W1 | `apra-fleet-unw.6` | P1 | `sequential` arity validation + `pipeline()` + doc truth | F7, F8 |
| W2 | `apra-fleet-unw.7` | P2 | Real ES-module loader; vetting demoted to advisory | F1 |
| W2 | `apra-fleet-unw.8` | P2 | Robust JSON extraction + bounded schema-repair loop | F5 |
| W2 | `apra-fleet-unw.9` | P2 | Per-run context, no shared phase/args, UUID ids | F11 |
| W2 | `apra-fleet-unw.10` | P2 | Viewer: emit `end`, cooperative /stop, escape extension HTML | F9, A7 (viewer) |
| W3 | `apra-fleet-unw.11` | P2 | Run journal (JSONL) + resume/replay | F6 (journal) |
| W3 | `apra-fleet-unw.12` | P2 | Canonical role enum + verdict schema contracts module | A1/A3/A4/A6 support, V4 |
| W3 | `apra-fleet-unw.13` | P2 | Ruggedize vendored apra-pm agent defs (upstream PR + bump) | V1, V2, V3, V4 |
| W4 | `apra-fleet-unw.14` | P2 | Wire CLI end-to-end; arg contract; branch/PR; id validation | A0, A7 (cli) |
| W4 | `apra-fleet-unw.15` | P2 | Plan phase: schema verdict, hard-fail unapproved, delta re-plan | A1 |
| W4 | `apra-fleet-unw.16` | P2 | Develop/review: casing fix, streaks, failure isolation, orchestrator-applied transitions | A2, A3 |
| W4 | `apra-fleet-unw.17` | P2 | Deploy/integ probes, goal-priority exit + stall abort, real final verdict | A4, A5, A6 |
| W5 | `apra-fleet-unw.18` | P3 | Failure-path regression tests | gap 3 |
| W5 | `apra-fleet-unw.19` | P3 | Golden-transcript snapshot test | gap 4 |

A7 is deliberately split across unw.10 (dashboard XSS), unw.14 (shell-injectable issue ids),
and unw.15/unw.16 (delimited untrusted inter-agent feedback) -- its three surfaces live in
three different components.

---

## 5. Descoped: requires apra-fleet MCP server changes

Grounded in `docs/structured-errors-proposal.md` and feedback.md. Each item below is deferred
because its real fix is server-side (external repo); the listed workaround is what this plan
implements instead.

| Deferred (server-side) | Why deferred | Client-side substitute in this plan | When constraint lifts |
|---|---|---|---|
| structured-errors-proposal.md **Option 1** (JSON-RPC error responses) and **Option 2** (standardized `{isError, code, message, data}` payloads) -- both require the fleet server to stop embedding error strings in success payloads | Server emission change | `unw.3`: typed-error normalization layer that classifies today's error strings (and already maps JSON-RPC rejections, which `McpClient.handleMessage` surfaces) into `WorkflowError` subclasses with proposal-Option-2-compatible `.code` values | Implement Option 1 server-side; the client classifier then keys off `error.code` instead of string sniffing -- same classes, one function changes |
| Real token usage reporting (F2 root cause: fleet omits `usage`) | Server must report actuals | `unw.4`: `usage: null` reported honestly, "n/a" in viewer, unknown-cost counter | File a fleet issue; delete the null-path once usage is always present |
| Schema enforcement at the member/tool-call harness (F5's "Claude CLI enforces at the harness") | `execute_prompt` behavior is server-side | `unw.8`: orchestrator-side bounded repair loop with ajv error feedback | Move enforcement into `execute_prompt`; keep the repair loop as fallback |
| Idempotency keys on `execute_prompt`/`execute_command`; true remote cancellation (F6, F9) | Dispatch dedup/cancel must be honored by the server | `unw.11`: journal flags started-but-unfinished activities on resume as possible double-dispatches; `unw.10`: client-side abort unwinds the workflow but cannot kill the remote job (documented) | Add idempotency-token and cancel params server-side; thread them through the existing client plumbing |
| First-class `fileExists`/facts primitive (A4) | New fleet API | `unw.17`: `command(..., {failSoft: true})` + portable probe construction | Add the facts API; replace the probes |

When the constraint lifts, file these as new beads issues under a fresh epic; the interfaces
built here (error classes, signal plumbing, journal keys) are the intended landing pads.

---

## 6. Definition of done (whole epic)

1. All 19 child issues closed, each via the ritual's adversarial APPROVED (no self-approved closes).
2. `npm test` green and deterministic on Windows: both packages' suites run, the mock sprint
   exercises every runner phase, two consecutive runs produce identical transcripts (unw.19).
3. Zero LLM-judgment gates in runner.js: every verdict is schema-validated and state
   transitions are applied by the orchestrator (grep: no `.includes('APPROVED')`, no
   unconditional `{status:'success'}`).
4. `agent()`/`command()` have one failure contract (typed throws, never null), a finite timeout,
   and honest cost accounting with an enforced budget.
5. The CLI runs a sprint end-to-end against a mock fleet with branch + PR semantics, and every
   advertised argument is consumed or rejected.
6. Upstream apra-pm PR for V1-V4 opened and linked in `apra-fleet-unw.13`; submodule pointer
   bumped once merged (or the issue re-scoped with the user if upstream stalls).
7. Docs (`apra-fleet-workflow-architecture.md`, `workflow-guide.md`) match code behavior --
   no claimed resilience or security boundary that the code does not provide.
8. The server-side deferrals in section 5 are on file and referenced -- nothing silently dropped.
