# fleet-bridge QA repair: automated triage and repair of failing automation tests

**Status:** Design only. No code written.
**Date:** 2026-09-21
**Scope:** A workflow that pulls failing automation-test results (Playwright and
similar) off a DevOps platform, decides *why* each one is failing, repairs the ones
that are genuinely test defects, re-runs whatever the change could have affected, and
raises a pull request -- without ever "fixing" a test that was correctly reporting a
product regression.
**Read against:** `fleet-bridge-design.md`, `fleet-bridge-implementation-plan.md`,
`fleet-bridge-build-log.md`, `docs/generic-engine-boundary.md`, and the role prompts
under `apra-pm/agents/`.

---

## 1. Recommendation

**Build a reduced version, and invert the stated ordering: ship triage first, repair
second.** Steps 3, 4 and 5 of the requirement (create beads, fix, re-run, raise a PR)
are almost entirely the sprint engine that already exists -- a QA repair sprint is an
ordinary sprint whose beads happen to be about test code, and it needs no new verb,
no new engine mode and no new role. What is genuinely new is small and sits at the
front: a way to retrieve failing test results with their evidence (step 1), and a
disciplined way to decide what a failure *means* (step 2, of which "re-run to
confirm" is the first third). The value is concentrated there too -- a QA developer's
hours go into diagnosis, not into typing the fix. And so is the danger: a loop
pointed at "make the failing tests pass" has exactly one cheap winning move, which is
to weaken the test, and it will find it. So v1 is: a new ingest source that produces
an evidence-rich triage dossier and one triage bead per failing test; a first sprint
cycle that may classify but may not change anything; repair restricted by a
mechanical path allowlist to test code only; a mechanical test-weakening detector the
reviewer must act on; and product regressions handed back to humans as tracker work
items through the carry-over path that already exists. I would **not** build the
fully autonomous "download, fix, merge" loop -- and not later either. The human
handoff on product regressions is the feature, not a limitation of v1.

Three caveats on readiness, all learned from probing the real suite, all of which
must be settled before any of this is scheduled. First, **no credential available to
us can read the test-results surface** on either project probed -- build read is
granted, Test Management read is not. Nothing here can be built until that is
issued. Second, **the pipeline does not record which product version it tested**,
so the question the safety design turns on cannot currently be answered even
retrospectively; a one-step pipeline change fixes it going forward and is a
prerequisite, not a follow-up. Third, **a suite of this kind can already be
largely red on arrival** -- there is then often no recent green build to compare
against,
most failures probably share a handful of environmental root causes, and the first
useful output will be a triage report rather than a pull request. Sections 6.3 to
6.6 set out what each of these means for scope. The intended topology -- supervisor
and member on the automation box itself -- is good news against all of this and is
discussed in 6.5.

---

## 2. The safety design: test wrong, product wrong, or neither

This is the centre of the design. Everything else is plumbing around it.

### 2.1 The problem, stated precisely

A failing automation test is a disagreement between two artifacts about what the
system should do. The failure tells you there is a disagreement. It does not tell you
which side is wrong. An agent asked to make the test pass is being asked to resolve
that disagreement, and it has been handed an enormous asymmetry: editing the test is
local, cheap, always succeeds, and is immediately verifiable; diagnosing a product
regression is expensive, often inconclusive, and ends with the agent reporting that
it did not achieve its stated goal. Any workflow scored on "tests green" will, over
enough runs, convert real regressions into deleted assertions. The suite looks
healthier every sprint while covering less.

And the naive failure mode is not caught by reading the PR quickly. A
regression-masking diff and a legitimate selector-update diff can be the same three
lines.

### 2.2 The principle

**The workflow may never both diagnose a failure and repair it in the same
uninterrupted step, and it may never treat "the test now passes" as evidence of
anything.** Diagnosis produces a classification with named evidence; repair consumes
a classification it did not produce and may not revise.

Three structural consequences, each enforced by cheap mechanical means rather than by
asking a prompt nicely:

1. **Separate cycles.** Cycle 1 of a QA repair sprint is triage-only: it may run
   tests, read traces, read history, read blame, and write classifications. It may
   not modify a single file. Cycle 2 onward may repair, and only the failures cycle 1
   classified as test defects and a reviewer accepted. The engine's multi-cycle loop
   gives this for free; the constraint is stated in the dossier the planner reads and
   enforced by guard A in 2.6.
2. **The default verdict is "undetermined", not "test defect".** Every discriminator
   below can fail to fire -- no old build available, no history, evidence missing.
   When it does, the outcome is a report, not a repair. The single most likely way
   this feature causes harm is a degradation path that quietly falls back to
   "assume the test is wrong". There must not be one.
3. **Product code is out of scope for this sprint entirely.** Argued in 2.5.

### 2.3 The discriminator: two axes, not one

Re-running the failing test to confirm it fails is the right instinct and is one axis
of a two-axis matrix. On its own it only separates "fails reproducibly" from "did not
fail here", and a test that fails reproducibly both in CI and locally is exactly what
a real product regression looks like.

The two axes are **repetition** (how deterministic the failure is) and **product
version** (whether the same unchanged test behaves differently against a known-good
build).

| Behaviour of the *unchanged* test | Old (last known-green) build | Current build | Verdict |
|---|---|---|---|
| deterministic | passes | fails | **PRODUCT_REGRESSION** (or an intended behaviour change) |
| deterministic | fails | fails | candidate TEST_DEFECT or ENVIRONMENT |
| non-deterministic on either build | -- | -- | FLAKY |
| deterministic | -- | passes | NOT_REPRODUCED |
| old build not runnable | -- | fails | **UNDETERMINED** |

As a procedure, per failing test:

1. **Reproduce.** Run the test unchanged, N times, against the current product build
   in the sprint's environment (the runner's repeat-each lever).
   - Consistent pass: NOT_REPRODUCED. Do not touch it. Report it, with the CI
     environment difference as the open question. A test that only fails in CI is an
     environment or test-isolation problem, and repairing it locally is guaranteed
     masking.
   - Mixed: FLAKY. Go to 2.7; do not proceed to step 2.
   - Consistent fail: continue.
2. **Bisect on product version, not on the test.** Deploy or check out the product at
   the last build where this same test was green, leave the test file exactly as it
   was on that run, and run it N times.
   - Green on old, red on current: the product's behaviour changed. PRODUCT_REGRESSION
     unless a human says the change was intended. The test is not the defect. Stop.
   - Red on old too: the test has never agreed with this product, or something
     outside both -- data, environment, an external service, an expired fixture --
     is driving it. This is the **only** branch that may become TEST_DEFECT, and only
     with the intent evidence in 2.4.
   - Cannot be run (no deployable old build, no retention, environment not
     rollbackable): **UNDETERMINED**. Report it. A legitimate, expected outcome.

Step 2 is what the naive specification is missing and is the most valuable idea in
this design. It is also the most operationally expensive, which is why the work
breakdown proves it feasible before anything else is built.

**A convenient gift from the platform:** the Azure DevOps test result carries a
`failingSince` object with the build in which the test started failing (verified,
section 7.1). That is the last-green build handed to you, and it removes the search
that would otherwise make step 2 expensive. It is also platform-specific, so the
neutral contract exposes it as an optional hint with a fallback to walking history.

### 2.4 Intent evidence: before a test may be edited at all

Execution evidence says what happened. It never says what the test was *for*. An
assertion that a total equals 100 is either an arbitrary fixture value or the entire
point of an old bug fix, and the two are indistinguishable in a
stack trace. A repair bead's acceptance criteria therefore require, before any edit:

- **Provenance of the failing assertion.** Log-with-line-range, or blame, on the exact
  asserting line: which commit introduced it, its message, and any work item it
  references. A commit message reading "fix: totals wrong when quantity is zero"
  sitting on the line that is now failing is close to proof of a product regression,
  and it costs one command. Almost nobody does this by hand, which is a genuine
  argument for the feature.
- **The assertion restated in product terms**: "this asserts that a zero-quantity
  line contributes nothing to the order total", not "this asserts the text of the
  third table cell".
- **The specific mechanism of the test defect, named.** Acceptable mechanisms include
  a selector the product legitimately renamed as part of an already-reviewed change;
  a hardcoded date or fixture that expired; a race the test itself introduced; a
  dependency on another test's leftover state. "The product returns 90 now so the
  expectation should be 90" is **not** a mechanism -- it is the regression, restated.
- **Evidence artifacts cited by path**: trace, failure screenshot, error and stack,
  and the outcome history of this test over the last K runs.

A triage record missing any of these does not yield a repairable bead. It stays
UNDETERMINED and is reported.

### 2.5 Position: a product regression must NOT be fixed by this workflow

Arguing this rather than hedging it. **A QA repair sprint may modify test code, test
fixtures, page objects and test configuration, and nothing else.** When it finds a
product regression it stops, files a work item with everything it learned, and that
is a successful outcome.

1. **The incentive gradient.** This workflow is defined by a green signal. The moment
   product code is in the editable set, the cheapest route to green includes changing
   the product to match the test -- the mirror image of the bug we are designing
   against, and worse, because it ships. A path allowlist removes the entire class
   mechanically and costs one script.
2. **The judgement is not the QA loop's to make.** "The product changed behaviour" is
   two findings -- a regression, or an intended change nobody updated the test for --
   and only a product owner separates them. Both are handoffs, and the handoff is
   worth more than a guess.
3. **Blast radius and review context.** A product fix wants planning, acceptance
   criteria, its own tests, and a reviewer reading it as product work. That is what
   an ordinary sprint is, and the bridge already launches ordinary sprints from work
   items. A regression found here becomes a work item; if the team wants it fixed
   autonomously they select it and launch the normal flow. The two features compose;
   merging them buys nothing.
4. **A mixed PR is unreviewable.** A pull request containing both "updated three
   selectors" and "changed the order-total calculation" invites a human to approve
   the whole thing on the strength of the easy half.

The one exception I would entertain, and not in v1: a failing test that *is* the
acceptance criterion of an already-triaged open bug assigned to the sprint. That is
not this workflow; that is the ordinary flow with a test-first bead.

### 2.6 Mechanical guards on the diff

Prompt instructions are necessary and insufficient. The build log's own lesson is
that an unwritten convention gets re-derived, and about half the time re-derived
wrong, by every agent that meets it. So the constraints above get deterministic
checks. All three live in the **target repo** (section 4.3), run as one command, and
their output is an input the reviewer is contractually required to read.

**Guard A -- path allowlist.** The target declares which paths are test-owned (spec
glob, fixtures directory, page-object directory, runner config). Any file in the
sprint diff outside that set fails the guard. This enforces 2.5, and in cycle 1 the
allowlist is empty, which enforces the read-only triage cycle with the same script.
It is close to free and has essentially no false-positive story: if the QA sprint
needs to touch product code, the answer is that it does not.

**Guard B -- the weakening detector.** A scan of the test-file diff for changes whose
effect is to reduce what the suite checks. Signal classes, all cheap to detect:

- assertion count falls in a spec file; a spec or describe block is removed
- a skip, fixme or exclusive-run annotation is added; a test is moved out of the
  default project or given a tag the gating run excludes
- a retry count is raised, a timeout is raised, a fixed wait is inserted
- a strict check is relaxed: visibility to attachment, exact equality to substring or
  pattern, an exact count to "at least one", a screenshot threshold raised
- snapshots regenerated or baseline images updated
- **any change to an expected literal value.** This is the one people forget and the
  highest-signal one in the list. Assertion counts stay identical when an expected
  100 becomes an expected 90, and that edit is the purest possible form of the bug
  this document exists to prevent.

A hit is **not** a block -- several of these are genuinely correct repairs. A hit
requires a justification in the bead's closure note naming the classification and the
mechanism from 2.4, and the reviewer must fail the bead when the justification is
absent or reduces to "the test passes now". Guard B is a heuristic and will produce
false positives; that is acceptable because its output is a question, not a verdict.

**Guard C -- the inverse re-run.** The strongest single check here. After a test is
repaired, run the **modified** test against the **old known-green build**.

- Modified test passes on old and on current: consistent with a genuine test defect.
  The repair did not encode the behaviour change.
- Modified test passes on current but **fails on old**: the test has been rewritten
  to describe the new behaviour. That is what masking a regression looks like. Hard
  fail, back to triage.

There is a legitimate shape that trips guard C -- an intended product behaviour
change, where the test *should* now pass only on the new build. That must be resolved
by a human confirming intent, never by the sprint asserting it, so guard C's failure
mode is escalate, not reject-forever. Guard C depends on the same old-build
capability as 2.3 step 2. Where that capability does not exist, guard C does not run,
repairs on that target carry materially less assurance, and the PR must say so in
those words.

### 2.7 Flakiness

A test failing one run in five is the most common real case and the one most likely
to be masked -- adding a wait or a retry makes the symptom go away and is almost
never the fix.

**Position: a flaky test is a quarantine-and-report target, not a repair target, in
v1.** Detection is the repeat-run in 2.3 step 1 plus the platform's own outcome
history for that test over the last K runs; either non-determinism source is
sufficient to classify. Action: tag the test into a quarantine set that is excluded
from the gating run but still executed and reported (the runner's tag filtering or a
separate project does this natively), file a work item recording the observed failure
rate and evidence, and move on. It is explicitly **not** counted as fixed, and the
sprint summary reports quarantines separately from repairs.

Two constraints, because quarantine is itself a weakening channel and is the obvious
place for this workflow to leak:

- **A quarantine budget per sprint** (a small integer, target-configured). Exceeding
  it fails the sprint rather than quarantining more. A run that wants to quarantine
  fifteen tests is telling you something about the product or the environment, and
  the right response is a human reading that sentence.
- **Quarantine requires a filed work item carrying the measured failure rate**, so
  the set cannot grow silently. A quarantine with no owner is a deletion on a delay.

Repairing flakiness properly means understanding the product's real timing and state
semantics. That is good work for a normal sprint against a filed bug; it is not
something to do while chasing a green suite.

A platform note that matters here: Azure DevOps has its own flaky-test management,
and when enabled it can *exclude flaky results from the pass percentage* (verified,
section 7.1). That means a suite can be green on the platform while tests are
failing. The ingest step must read the raw outcomes, not the summary, or it will
import an incomplete failure set and believe it is complete.

### 2.8 The verdict set, and what each one permits

| Verdict | Test code may change | Product code may change | Output |
|---|---|---|---|
| TEST_DEFECT | yes, mechanism named | no | repair bead; guards B and C apply |
| PRODUCT_REGRESSION | no | no | tracker work item via carry-over, with evidence and the suspect build/commit range |
| ENVIRONMENT | config only, if the target allows | no | work item for the environment owner |
| FLAKY | tag only | no | budgeted quarantine plus work item |
| NOT_REPRODUCED | no | no | report, with the CI-versus-local difference as the question |
| UNDETERMINED | no | no | report, naming which discriminator could not run |

The PR body carries this table for every failing test the run touched, so a reviewer
who reads only the top of the PR still sees the shape of what happened.

---

## 3. The workflow, phase by phase: reuse versus new

| Phase | What happens | Status |
|---|---|---|
| 0. Preflight | existing checks, **plus**: platform test surfaces reachable *and populated*, target declares its test-path allowlist, old-build capability and quarantine budget | extend existing verb |
| 1. Collect failures | retrieve failing results for a pipeline run or window, the framework's own report, and the evidence | **NEW** (small) |
| 2. Create triage beads | one bead per failing test, evidence paths inline, classification fields as acceptance criteria; synthesise a root and parent them | existing ingest logic, new item source |
| 3. Launch | unchanged; the dossier goes in as the requirements file the planner reads | existing |
| 4. Cycle 1: triage | reproduce, repeat-run, old-build run, blame, classify. No file modified | existing roles, **new target-owned playbook** |
| 5. Review of triage | classification schema satisfied, evidence cited, zero files changed | existing reviewer, **new criteria** |
| 6. Cycle 2+: repair | TEST_DEFECT beads only; guards A and B on every commit | existing doer and reviewer, **new guards** |
| 7. Re-run affected | repaired tests plus the affected set (section 5) | existing integ role, target playbook |
| 8. Guard C | modified tests against the old build | **NEW**, target-owned |
| 9. Final review, PR | unchanged, plus the verdict table in the PR body | existing publish phase |
| 10. Finalize | regression, environment and flaky beads become tracker work items | **existing carry-over, unchanged** |

Two points make this cheap.

**Phase 10 is free, and it is the whole handoff.** Carry-over already exists, already
pushes exactly the set it is given and nothing else, and exists precisely to turn "we
found this but did not fix it" into backlog items. Product regressions are that,
exactly. The regression role already files its findings as standalone, parent-less
beads specifically so they do not gate the current sprint -- the identical shape this
design needs for a regression finding. No new outbound path is required.

**The cycle structure is free.** Multi-cycle is native and the plan phase runs at the
top of every cycle. Making cycle 1 read-only is a statement in the dossier plus guard
A, not an engine change.

**Total genuinely new:** one ingest source with a report parser and an evidence
fetcher; one optional adapter axis; three guard scripts and a classification schema
living in the target repo; one reviewer criteria addendum. No new verb family, no new
sprint mode, no new role, no engine change.

### 3.1 Should there be a new role?

I considered a dedicated triage role alongside the existing test roles. **Not in
v1.** Triage is a bead whose acceptance criteria are "produce this classification
with this evidence"; the existing doer produces it and the existing reviewer checks
it against the schema, and the cycle split already buys the separation of duties a
new role would be bought for. Note also that the existing test roles are
contractually forbidden from writing or modifying test code, so the repair half
belongs to the doer regardless -- a new "test fixer" role would duplicate the doer.
Add a role only if v1 shows doers cannot hold the read-only line in cycle 1 -- and if
they cannot, another prompt probably will not fix it either. Guard A will.

### 3.2 What the sprint is *told*

The dossier handed in as the requirements file is the whole target-specific payload:
the failing set with stable keys, the evidence paths, the history, the last-green
build, the classification schema, the path allowlist, the quarantine budget, and the
cycle contract ("cycle 1 classifies and changes nothing"). This keeps every piece of
Playwright-specific and target-specific knowledge out of the engine and out of the
role prompts, which is exactly where the boundary check wants it.

### 3.3 The generic-engine boundary

The engine file set -- engine code string literals and the role prompts -- must not
learn that its target runs Playwright, where its specs live, or how to roll back a
build. Everything target-specific goes in the target repo, which is where the engine
already puts test knowledge: the per-cycle and per-sprint playbooks are target-owned
files today.

The target repo gains a QA triage playbook, the three guard scripts and a small
config. The one thing that touches a role prompt is the reviewer criteria addendum,
and it must be phrased so it is true and useful for a target with no Playwright at
all -- the reference minimal target is the test the boundary doc tells you to apply.
Two sentences pass that test: the reviewer must read the target's guard report if the
target produced one, and the reviewer must reject a test change whose only
justification is that the test now passes. Anything I could not phrase that way, I
moved into the target repo.

One mechanical caution: the boundary check's heading rule lets the engine name the
contract-documented target files and only their documented sections. Requiring a new
playbook heading by name means amending the target-file contract and proving the
reference target satisfies it. Cheaper for v1: pass the playbook path in the dossier
rather than naming a new heading in a prompt.

---

## 4. The adapter seam for test results

The three platforms' test surfaces are not comparable, and designing against Azure
DevOps' shape would produce an Azure DevOps feature with two stub files. The way out
is to notice what they genuinely share.

### 4.1 Report-first, platform-API-second

**All three store, somewhere, a machine-readable report produced by the test
framework itself** -- the runner's own JSON report, or the JUnit XML that every
platform's publish step consumes. That report is richer and more trustworthy than any
platform's normalised view of it: true spec path, full title path, per-attempt
results, attachment filenames, and the untruncated error.

The Azure DevOps research makes this concrete rather than theoretical. Verified: the
platform truncates `stackTrace` at 1000 characters; and for JUnit input the publish
task attaches the results file to the *run* and attaches **nothing** to the
individual result, so a Playwright job publishing plain JUnit XML lands traces,
screenshots and videos nowhere in the test-result surface at all. The platform's own
view of a Playwright failure is, by default, a truncated stack and no evidence. The
report and the pipeline artifacts are where the real information is.

So the canonical path is: use the platform API to *find* the run, *download* the
report and artifacts, and get *history*; parse everything else from the report.

```
testResults: {                        // optional axis; absent = feature unavailable
  locateReports({ pipelineRunRef?, branch?, since }, ctx)
      -> [{ reportRef, format: 'playwright-json' | 'junit-xml' | 'trx' | ..., runRef }]
  download(ref, destDir, ctx)        -> local file paths
  listFailures({ ... }, ctx)         -> TestFailure[]      // platform projection; optional
  history(testKey, { limit }, ctx)   -> [{ runRef, outcome, when, buildRef }]
  lastGreenBuild(testKey, ctx)       -> buildRef | null    // optional fast path
  evidence(failureRef, destDir, ctx) -> [{ kind, path }]
  linkTriage(workItemRef, failureRef, ctx)                 // optional
}
capabilities.testResults: 'native' | 'report-only' | 'none'
```

The parser from report to neutral `TestFailure` is **shared**, not per-platform. Only
locating, downloading, history and linking are per-platform. That is the seam that
keeps this from becoming an Azure DevOps feature.

### 4.2 Stable test identity

Worth its own paragraph, because getting it wrong makes history and quarantine
silently useless. A platform's numeric result id is per-run and worthless as a key.
The only identity surviving across runs and platforms is the framework's own: spec
file path relative to the repo root, plus the full title path, plus the project or
browser name. That is the neutral key; platform ids ride alongside as back-references
for attachment fetches and work-item linking. Two corollaries: renaming a test breaks
its history, which is correct and should be visible rather than papered over; and a
parameterised test's parameters must be part of the title path, or two cases collapse
into one and the flakiness signal becomes noise.

### 4.3 Tiers

- **Azure DevOps -- "native".** First-class test run and result services, attachments,
  per-test history, a `failingSince` build, work-item association, and an opt-in
  flaky marker. It can also serve the raw report, as a run attachment or a build
  artifact.
- **GitHub Actions -- "report-only".** There is no test-result service. What exists is
  workflow-run artifacts (a zip you download and unpack) and check-run annotations.
  Locate the run's artifact, download, parse. History means walking the last K
  workflow runs and parsing each report, which is slower and bounded by artifact
  retention. This tier is the reason the report-first design is right.
- **Bitbucket Pipelines -- "none" in v1.** It consumes JUnit XML from a conventional
  directory and renders it, with a thin API around it, so "report-only" is reachable
  later. Bitbucket is already the acknowledged gap in the existing bridge design and
  should stay one gap rather than become two.

### 4.4 The vocabulary trap, applied to test surfaces

The build log's defect 5 generalises exactly. The dangerous assumption is not a
hardcoded type name -- it is a *field or enum whose existence is contingent on the
project's configuration*, read through layers, whose absence looks like ordinary bad
data rather than an impossible field. Test surfaces are dense with these, and the
research found live examples:

- The Azure DevOps outcome enumeration has fifteen values, and JUnit input can only
  ever produce three of them. A classifier written against "failed or passed" is
  wrong about `NotExecuted`, `Warning`, `Error`, `Aborted`, `Timeout`, `Inconclusive`
  and `NotImpacted` -- several of which are neither a pass nor a test failure.
- There is a `failureType` field whose documented values include "Regression". It is
  a manually-set triage field, not a computed one. It must be read as a hint and
  never as the classification; treating it as authoritative would be the exact
  mistake this document exists to prevent, wearing an official-looking label.
- Flakiness is **not** a field on the result. It is a key inside a generic
  custom-fields collection, present only if flaky management is switched on for the
  project, and the platform's own detection is coupled to a specific test task. Code
  reading a `isFlaky` property would find undefined on every project and quietly
  conclude nothing is flaky.

Rules that follow:

- Never hardcode an outcome enumeration. Treat the value set as data and configure
  which values count as a pass. A value outside the configured map is a **surfaced
  error**, not a silent pass and not a silent failure.
- Probe in preflight. If the project has no test runs, or the pipeline does not
  publish results, or the credential cannot read the surface, fail loudly with the
  remedy rather than ingesting zero failures and reporting a successful no-op. This
  matters more than usual here because "zero failing tests" is a *plausible* result
  that is indistinguishable from a broken integration.
- Never assume attachments exist. Whether traces reach the platform is a property of
  the target's pipeline configuration, not of the platform. Degrade explicitly to
  "evidence unavailable, weaker classification", never to "assume the test is wrong".
- Do not trust an exit code, and do not trust a green summary. A platform summary can
  exclude flaky results by configuration; read the raw outcomes.
- Anything posted back inherits the existing rules: the bridge holds a secret NAME,
  never a value; structured bodies must survive the dispatch layer's backslash
  mangling; and the member's shell is not assumed (the live member turned out to run
  bash, not PowerShell).

---

## 5. Step 4: "other test cases which may be affected"

The requirement names the code-intelligence tooling for this. My conclusion is that
it is the wrong instrument here, and a much cheaper signal is strictly better.

**What an index would give.** The code-intelligence surface answers structural
questions over a static call graph: callers, callees, and the relevant one -- which
test functions transitively call a symbol. That is a good answer for in-process unit
and integration tests.

**Why it does not answer this question for Playwright.** An end-to-end spec does not
call the product's symbols. It drives a browser, which speaks HTTP to a server, which
runs the product. No static edge exists from the spec to the product function, so a
call-graph query from changed product code to affected specs returns nothing. The
tool is not weak here; the edge genuinely is not in the artifact it indexes.

**And in this workflow the direction is reversed anyway.** Under 2.5 the sprint does
not change product code at all. The only changes are in test code, so the real
question is about the *test tree*: which other specs import the page object, fixture
or helper that was just edited. That is an ordinary in-process import graph, and the
test runner already owns it -- Playwright can select specs affected by a diff against
a base ref using its own dependency graph, which is precisely this computation, done
by the tool that knows the truth.

**Recommended affected set for v1**, the union of:

1. the tests that were failing and were repaired;
2. every test in every test file the diff touched -- not just the edited test;
   in-file state leakage between tests is real;
3. the test framework's own changed-file selection against the sprint's base branch,
   where the framework offers one, covering shared page objects, fixtures and
   helpers;
4. the target's declared always-run set, if it has one (login, smoke).

**A correction from the live probe.** I had written item 3 assuming Playwright for
Node, which can select specs affected by a diff using its own dependency graph. The
real suite is Playwright for .NET, and that selector does not exist there. For a
compiled test project the equivalent signals are the project and namespace structure
and the compiler's own reference graph -- and the pragmatic answer is coarser and
probably better: **when a shared helper or page object changes, run the whole test
project or the affected test class, and do not try to be clever.** A compiled suite
makes this cheap to reason about and the cost of over-running is one of time, while
the cost of under-running is a missed regression. This also removes the only
remaining argument for a code-intelligence index, since the decision no longer needs
per-test precision. The seam stays the same: the affected-set computation is a
command the target declares, not knowledge in the engine.

**Do not build a code-intelligence index for this.** Verified: no index exists in
this repository or the main checkout, despite project instructions describing one as
present with a symbol count. Building one is a real cost, it must be rebuilt as code
changes, and for the question actually being asked it would return an empty set.
Revisit only if a target adopts this workflow for in-process tests, where the
transitive-test-callers query genuinely is the right instrument.

---

## 6. Azure DevOps test surfaces: the concrete facts

Collected for the adapter's benefit. Everything in 6.1 was read from the vendor's
documentation; 6.2 is what a live call actually returned; 6.3 to 6.6 report what live probes returned, and 6.7 is explicitly not
verified.

### 6.1 Verified from documentation

Two API areas, on two different hosts, with two different api-version strings.

| Purpose | Call |
|---|---|
| list test runs in a project | `GET https://dev.azure.com/{org}/{project}/_apis/test/runs?api-version=7.1` (optional `buildUri`, `automated`, `planId`, `$top`, `$skip`) |
| query runs by time window | `GET .../_apis/test/runs?minLastUpdatedDate=&maxLastUpdatedDate=&api-version=7.1` -- the window is capped at **7 days**, `$top` is capped at **100**, and id-list filters take at most 10 ids each; paging via an opaque continuation token |
| results in a run | `GET .../_apis/test/Runs/{runId}/results?api-version=7.1` -- paging is `$top`/`$skip` (not a continuation token); `$top` max 1000 with no details, 200 otherwise; `detailsToInclude` in {none, iterations, workItems, subResults, point} |
| one result | `GET .../_apis/test/Runs/{runId}/results/{resultId}?api-version=7.1` |
| cheapest "what failed in build N" | `GET https://vstmr.dev.azure.com/{org}/{project}/_apis/testresults/resultsbybuild?buildId={id}&api-version=7.1-preview.1` -- shallow results with outcome, automated test name and a re-run flag, with a continuation token; yields the (runId, resultId) pairs to hydrate |
| grouped detail / trend | `GET https://vstmr.dev.azure.com/{org}/{project}/_apis/testresults/resultdetailsbybuild?buildId={id}&api-version=7.1-preview.1` |
| attachments on a result | `GET .../_apis/test/Runs/{runId}/Results/{resultId}/attachments?api-version=7.1` |

Enumerations and fields that the adapter must treat as data:

- Run state: unspecified, notStarted, inProgress, completed, aborted, waiting,
  needsInvestigation (the last two documented as legacy). Returned Pascal-cased.
- Outcome: unspecified, none, passed, failed, inconclusive, timeout, aborted,
  blocked, notExecuted, warning, error, notApplicable, paused, inProgress,
  notImpacted. Returned Pascal-cased. **Fifteen values, of which JUnit input can only
  ever produce Passed, Failed and NotExecuted.**
- `failureType`: literal strings with spaces -- "Known Issue", "New Issue",
  "Regression", "Unknown", "None"; defaults to "None". Manually set; a hint only.
- `stackTrace` and `comment` are **capped at 1000 characters server-side.** Full
  traces must come from an attachment or artifact.
- `failingSince` carries the date and the **build** in which the failure started --
  the last-green anchor section 2.3 needs.
- `subResults` carries per-attempt detail, which is the in-run re-run evidence.
- `associatedBugs` is a shallow reference list, populated when `detailsToInclude` is
  set to work items.
- Attachment types are limited to general attachment, code coverage and console log.

On flakiness, three verified facts that shape 2.7:

- There is no first-class flaky property. It is a key named `IsTestResultFlaky`
  inside the generic custom-fields collection, and a a result-metadata enum with
  values rerun and flaky appears in the run statistics.
- Platform flaky detection is Services-only, project-settings-gated, tied closely to
  a specific test task or to re-running failed jobs, and is branch-scoped. Switching
  detection mode erases flakiness history.
- Flaky results **can be excluded from the pass percentage and moved out of the
  reported set**, which suppresses the failure in the summary. Read raw outcomes.

On evidence, the single most consequential verified fact for this design: the publish
task's JUnit mapping attaches the results file to the **run** and attaches nothing to
the individual **result**. Per-result attachments exist for TRX and NUnit3 input, and
for JUnit only through an attachment marker embedded in the standard-output element,
available on recent Services and servers. **A conventional Playwright plus JUnit XML
pipeline therefore publishes no traces, screenshots or videos into the test-result
surface.** Getting evidence means either a pipeline change on the target, or reading
the pipeline artifacts. Plan for the artifact route.

### 6.2 Verified against the bridge's own test project

Read-only calls as the member, credential referenced by name only:

| Call | Result |
|---|---|
| list projects in the org | 200 |
| list work item types in the project | 200 |
| list test runs | **401** |
| list test results by build | **401** |
| list build definitions / builds | **401** |

The project exists and the credential is valid -- the same token returns 200 with a
resolved identity on the work-item surfaces. The 401 is confined to the test and
build scopes, with a bare Basic-realm challenge and no service-error body. The
credential for that project lacks Test Management (read) and Build (read). Reported
as a block, not worked around; we still do not know whether that project has test
runs, and the honest statement is "the API refused the read", not "there are none".

### 6.3 Verified against the real QA suite

A second, and far more informative, probe against the organisation's actual
Playwright estate -- a different host, a different project, a different credential.
All calls read-only, credential referenced by name only.

- **Several Playwright pipelines** exist under a single pipeline folder in that
  project, alongside a substantial history of builds and definitions.
- **The build surface reads fine with that credential; the test surface returns 401.**
  Same split as 6.2: build read is granted, Test Management read is not. Two
  independent credentials in this organisation have the same gap, which suggests the
  scope is simply not part of how tokens are issued here. This is a prerequisite,
  and it is a policy question, not a technical one.
- **The suite is Playwright for .NET, not Playwright for Node.** The repository is a
  C# solution built on the .NET 8 SDK with restored packages, and the results are
  published by a task publishing TRX files. This invalidates two assumptions I would
  otherwise have carried into the build, and they are corrected in sections 4 and 5.
- **Test results are published.** The publish task ran and succeeded on a recent
  failing build, so the test surface in that project is genuinely populated; only our
  read access is missing.
- **The build agent is macOS.** Any local reproduction step inherits that.
- **Build result and test result are different things.** The build examined was red
  because a script step failed; the publish-results step succeeded. Deriving "which
  tests failed" from the build outcome would be wrong.
- **Evidence exists as a pipeline artifact.** Recent failing builds carry a container
  artifact of a size consistent with traces and
  screenshots -- but it is **not present on every build**, including some failing
  ones. Evidence availability is per-build, not guaranteed, exactly as 4.4 requires
  the design to assume.
- **TRX is the good case for evidence.** Unlike JUnit, TRX carries per-result
  attachment paths, so on this target traces can reach the test-result surface
  itself rather than only the artifact drop. Worth confirming once the scope is
  granted.
- **The suite is routinely red.** Across the six pipelines sampled, nearly every
  recent build failed, and in some pipelines the failures are long-standing. This is
  the single
  most important operational fact learned today and is discussed in 6.6.

Also learned live: one member executes under bash and another under PowerShell, and
the credential needed its surrounding quoting stripped before an explicit Basic
header worked -- the quote-wrapping gotcha recorded elsewhere for this platform is
real on both.

### 6.4 One nominated build, examined in detail

A build with a mix of passing and failing tests was nominated as the worked example.
Read-only inspection of it produced the two most consequential findings in this
document.

**The pipeline does not record what product version it tested.** The build checks out
the automation repository at a specific commit and records that commit. It checks out
nothing else. The Playwright suite drives a deployed environment, and **nowhere in
the run is there a record of which product build that environment was running.**

This is not a small gap. The discriminator in 2.3 asks "did this same test pass
against an earlier product build" -- and on this target there is no data from which
to answer it, even retrospectively, because no run ever recorded the answer. The
platform's `failingSince` field points at the *pipeline* build, which tells you when
the failure started but not what changed underneath it. Correlating a failure onset
with a product deployment by timestamp is possible and is far weaker than it sounds
on a suite that also changes under itself.

**The fix is cheap and must be a prerequisite, not a follow-up.** One step added to
the pipeline that queries the product's version or build identifier at test time and
records it with the run (a run tag, a custom field, or a line in the published
results) makes every future run discriminable. It costs an afternoon, it unblocks
the entire safety design, and until it exists, every verdict on this target is
UNDETERMINED by construction. I would not start building the discriminator before
this step is in place and has produced a few weeks of runs.

One friction to note: the pipeline is a classic designer definition, not YAML. That
step is an edit in the portal rather than a reviewable pull request, and it will not
appear in anyone's git history.

**Evidence publication is inconsistent between the definition and its history.** The
definition as it stands today copies and publishes the artifact staging directory
with a run-on-success-or-failure condition, so on paper evidence is always published.
The nominated build published **no artifacts at all** -- both the copy and the
publish step are recorded as skipped -- while its results publish step succeeded.
Whatever the cause (a later definition edit, a cancelled job), the lesson holds:
**you cannot infer a past run's evidence from the current pipeline definition.** The
adapter must probe per build and degrade explicitly when the drop is absent, and for
this build the only evidence that exists is the published results themselves.

Also confirmed here: the build's own result is red because a script step failed while
the results publish succeeded, so a mixed pass/fail test outcome sits inside a build
marked simply failed. Deriving the failing set from the build outcome would be wrong.

### 6.5 Deployment topology: the supervisor sits on the automation box

The intended arrangement is that the fleet supervisor runs on the same self-hosted
device the QA automation runs on, with model access, and a member is registered
against the local automation working folder. That is the right shape, and it
resolves or reshapes several things in this design.

**What it resolves.** The reproduction step (2.3 step 1) stops being a question about
whether a foreign machine can stand up the test environment: the sprint runs where
the suite already runs, with the same browsers, the same credentials, the same
network position and the same operating system. That was my largest doubt about
feasibility and it largely goes away. The same is true of evidence -- the sprint can
generate its own traces locally at will, which matters a great deal given 6.4's
finding that the published evidence is unreliable.

**What it reinforces.** The member's working folder is the *automation* repository.
The product source is not checked out, is not present, and is not something the
sprint can edit even if it wanted to. The no-product-code position in 2.5 is
therefore enforced by the topology before any guard runs, and the path allowlist
becomes a second line of defence rather than the only one. The pull request the
sprint raises targets the automation repository, which is exactly right.

**What it does not resolve, and one thing it makes worse.** The product version
problem in 6.4 is untouched by topology: running on the automation box tells you what
the suite does today against whatever is deployed today, and still not what was
deployed when the test was last green. If the product environment the suite points at
is shared and live, then "roll it back to last Tuesday's build to check" is not a
thing anyone will agree to. That makes the discriminator's second axis a question
about whether a *private* product environment can be stood up at a chosen version --
a much bigger ask than a runner, and the thing I would establish before committing to
the full design. If the answer is no, v1 is report-only triage plus clustering, which
is still worth building.

Two operational notes on the topology. The device running the automation is the
macOS agent in the observed runs, so the member is a macOS member and the engine's
shell-neutrality rules apply with the polarity reversed from the fleet's usual
Windows members. And the supervisor being co-located with the automation means a
long-running sprint and a scheduled automation run can contend for the same browsers,
ports and test accounts; the member reservation covers the sprint against other
sprints but knows nothing about the pipeline's own schedule. That contention needs a
decision, not a hope -- see the open questions.

### 6.6 The suite is already red, and that changes the shape of v1

Worth separating out, because it is the fact most likely to derail a naive rollout.
A workflow designed for "the nightly run went red, find out why" assumes a green
baseline that a regression interrupts. The estate this feature would be pointed at
does not have one: in the sample taken, most recent builds across most of the
Playwright pipelines failed, some persistently.

Three consequences.

1. **"The last build where this test was green" may be far in the past, or may not
   exist at all.** The discriminator in 2.3 depends on finding one. Where the last
   green build predates artifact and result retention, the verdict is UNDETERMINED,
   and on a long-red suite that bucket may be the majority. v1 must report that
   honestly rather than degrading to guesswork -- and the size of that bucket on
   first contact is a real risk to the feature's perceived value.
2. **A long-red suite is usually red for environment and infrastructure reasons, not
   for a hundred independent test defects.** A handful of root causes -- an expired
   account, a moved environment, a changed login flow -- typically account for most
   of the failures. That argues for clustering failures by shared error signature
   before triaging them individually, and for treating "one cause, many failing
   tests" as the expected case rather than the exception. It also means the first
   real run's most valuable output may be a short list of environment findings, not
   a PR.
3. **The quarantine budget question becomes urgent rather than theoretical.** Pointed
   at a suite where fifty tests fail, a budgeted workflow stops and asks. That is the
   correct behaviour and it must be understood as such before the first run, or it
   will read as the feature failing.

I would add a clustering step to v1 on the strength of this -- group the failing set
by normalised error signature and triage one representative per cluster -- and I
would set expectations that the first several runs produce triage reports rather
than merge-ready PRs.

### 6.7 Not verified

The build URI form for the run filter; the exact URL templates for run-level
attachments and zip downloads; the allowed grouping values on the grouped-detail
endpoint; whether a first-class test-history endpoint exists; the request shape for
writing an associated bug, and for the flaky metadata update; the reference-name
spellings of the test-case-management work item fields (display names confirmed, the
dotted reference names not); the parameters of the result-summary-by-build endpoint;
and whether the Playwright JUnit reporter emits the attachment markers that would put
traces into per-result attachments (I assume it does not).

---

## 7. Verified versus assumed, overall

### 7.1 Verified by reading this repository

- The sprint engine is multi-cycle and the plan phase runs unconditionally at the top
  of every cycle, so a "cycle 1 classifies, cycle 2 repairs" structure is expressible
  with no engine change.
- A requirements file is read once up front and threaded into the per-cycle dispatch,
  so a dossier is a supported way to hand structured input to a sprint.
- The regression role files failures as standalone, parent-less carry-over beads
  precisely so they do not gate the current sprint, and finalize pushes exactly the
  named set of beads to the tracker. The product-regression handoff needs no new
  machinery.
- The existing test roles are contractually forbidden from writing or modifying test
  code and from fixing product bugs, so the repair half belongs to the doer.
- The reviewer already builds and runs the suite, returns a binary verdict, holds
  reopen authority, and is already told to fall back to reading the diff when the
  repo is not indexed.
- The generic-engine boundary is mechanically enforced over engine code strings and
  role prompts, with a documented target-file contract, a heading rule, and a
  two-edit exception mechanism.
- No code-intelligence index exists in this repository or the main checkout, despite
  project instructions describing one as present.
- The bridge's adapter pattern is a validated descriptor with optional axes and
  explicit platform selection -- the right shape to extend with a test-results axis.
- The toy target used for the bridge integration runs is a unit-test project, so the
  real QA suite (section 6.3) is a different repository, host, project and
  credential from everything the bridge has been exercised against so far.

### 7.2 Verified about the platform and the real target

Everything in 6.1, 6.2 and 6.3.

### 7.3 Assumed, and needing confirmation before build

- **That a credential with Test Management read can be issued at all.** Two separate
  credentials in this organisation lack it. Everything in this design that reads
  results, history or attachments is blocked behind it. Not a technical unknown; a
  policy one.
- **That a known-green older product build can be deployed and exercised. This is
  the load-bearing assumption of the entire safety design** and is the subject of
  the first work item. On a long-red suite (6.6), the last green
  build may be outside retention or may not exist.
- That the product under test is deployable at an arbitrary past version at all,
  and that a QA automation repo pinned to a product environment can be pointed at a
  different one. Nothing observed says either way.
- That traces and screenshots are retrievable per failure. The artifact drop exists
  on some failing builds and not others, and whether TRX per-result attachments are
  populated cannot be checked until the scope is granted.
- That the test environment -- data, accounts, external services -- is reproducible
  enough off the CI agent that a local re-run means anything. On this suite in
  particular, with a macOS agent and a product environment behind it, this is the
  assumption I would bet against.
- The GitHub and Bitbucket characterisations in 4.3 come from general knowledge of
  those platforms, not from a probe.
- The unverified items listed in 6.7.

---

## 8. Work breakdown

Ordered by uncertainty, not by pipeline order. The first item can invalidate the
rest, so it runs first and alone.

| # | Item | Size | Why here |
|---|---|---|---|
| W0a | **Unblock the credential**: a token with Test Management read for the QA project, deposited in the secret store under its own name. Then re-probe: list runs for a recent failing Playwright build, hydrate one failing result, and check whether the TRX publish produced per-result attachments. | hours, plus whatever the approval takes | A hard block on everything else. Nothing that reads results can be written or even prototyped until this exists, and the answer on attachments decides whether evidence comes from the result surface or the artifact drop. |
| W0a2 | **Record the product version under test** in each pipeline run (one step querying the product's version or build identifier, written to a run tag or into the published results). | half a day, plus a few weeks of runs before it is useful | Per 6.4 this is the missing input the whole discriminator needs, it can never be backfilled, and every week it is not in place is a week of runs that stay UNDETERMINED. Start it the same day as the credential. |
| W0b | **Baseline survey of the real suite**: how many distinct failures, how many distinct error signatures, when each pipeline was last green, and what retention covers. One read-only pass, no code. | 1 d | This decides whether the feature's first output is PRs or a triage report, and sizes the UNDETERMINED bucket before we commit to building the discriminator. Cheap, and it can be done the day the credential lands. |
| W0c | **Discrimination spike.** On one real failing test: retrieve it and its evidence; reproduce the failure locally against the current environment; then get the product at the last build where that test was green and re-run the unchanged test against it. Record what each step actually cost. | 2-3 d | If the old-build re-run is not achievable, 2.3 step 2 and guard C both disappear, v1 becomes report-only, and the rest is re-scoped. Nothing else should be built before this is known. For this target it also has to answer whether the product environment, not just the test repo, can be moved backwards -- which is the part I expect to be hard. |
| W0d | **Failure clustering** by normalised error signature, so a suite with fifty failures triages as a handful of causes. | 1 d | Promoted into v1 by 6.6. Independent of the platform and useful even if the discriminator is unavailable. |
| W1 | Neutral contracts plus the shared report parser -- TRX first (that is what the real target publishes), then JUnit XML, then the Node runner's JSON -- to `TestFailure`, including the stable test key. Fixtures built from reports emitted by a real run, **never hand-written from our expectations**. | 2 d | Everything downstream depends on the shape, and a fake built from the calling code's assumptions is the documented way this project goes wrong. |
| W2 | Guards A, B and C as target-repo scripts, plus the classification schema. Platform-independent; testable against a synthetic diff. | 2-3 d | Cheap, independent, and it *is* the safety design. Build it before the thing it guards. |
| W3 | Azure DevOps test-results adapter axis: locate runs and reports for a build or window, download evidence (artifact route included), history and last-green build. Enum values read from live data; unknown values surfaced as errors. | 3-4 d | First real platform surface; the vocabulary trap lives here. |
| W4 | The collect step: an ingest source producing the dossier and the triage beads, reusing the existing root synthesis, criteria audit and reference normalisation. | 2 d | |
| W5 | The triage playbook and dossier template in the target repo, plus the reviewer criteria addendum phrased to pass the boundary check. | 2 d | |
| W6 | Affected-set selection and the re-run step (section 5). | 1 d | Small once the rest exists. |
| W7 | Finalize mapping: regression, environment and flaky beads to tracker work items carrying evidence links and the suspect build range. | 1-2 d | Mostly the existing path plus field mapping. |
| W8 | End-to-end run on the real target **with a deliberately planted product regression among the failures**, to prove the workflow refuses to "fix" it. | 2 d | The only test that validates the safety design. Nothing here is believable without it. |

### 8.1 Deliberately NOT in v1

- Any product code change in this workflow. Not a flag, not a toggle.
- Automatic merge of the resulting PR. The existing never-auto-merge rule applies with
  more force here.
- Automatic repair of flaky tests. Quarantine and report only, with a budget.
- Bitbucket support.
- Building a code-intelligence index.
- A new sprint mode, a new verb family, a new role prompt, or any engine change.
- Writing back to test plans or test case work items, or curating the platform's test
  assets. v1 reads results; it does not manage test cases.
- Marking results flaky through the platform's own flaky-metadata API. Our
  quarantine is in the repo, where it is reviewable in a diff; the platform's is a
  side-channel that suppresses failures.
- Model interpretation of video or screenshots. Traces and text evidence only; the
  trace already carries the DOM and network log, and images are expensive.
- Unattended or scheduled operation. v1 is operator-triggered against a named
  pipeline run, so a human is present for the first several runs.

---

## 9. Open questions for the user

1. **Can a product environment be stood up at a chosen older version?** Not the test
   repository -- the environment the suite drives. Everything in 2.3 and guard C
   rests on it. If the suite points at a shared live environment, nobody will agree
   to roll it back, so the real question is whether a private instance at a pinned
   version is possible. If it is not, do you want v1 as report-only triage plus
   clustering, or a weaker discriminator and the risk that comes with it? I would
   take the report-only version; it is still worth building.
1a. **Will someone add the product-version step to the pipelines?** Without it,
   question 1 cannot even be attempted for any failure that starts today. It is an
   afternoon's work in the pipeline designer and it is the highest-leverage item on
   this entire list.
2. **Given a suite that is already largely red, what does success look like for the
   first run?** My proposal: a clustered triage report naming the handful of root
   causes and separating environment from test from product, with no PR at all. If
   you are expecting green pipelines out of run one, we should talk before building.
3. **Who issues a token with Test Management read for the QA project?** Two
   credentials already fail this. It blocks everything, it is a policy decision, and
   it should be started today regardless of what else is decided here.
4. **How do a running sprint and the pipeline's own scheduled runs avoid each other
   on the shared automation box?** With the supervisor co-located (6.5), a two-day
   sprint and a nightly automation run will contend for browsers, ports and test
   accounts. The member reservation protects the sprint from other sprints and knows
   nothing about the pipeline's schedule. Options are a quiet window, a dedicated
   second checkout and account set, or pausing the schedule during a sprint -- but
   it needs deciding rather than discovering.
5. **Do you accept the hard position in 2.5** that this workflow never changes product
   code? If you want product fixes, I want them as a separately planned sprint
   launched from the filed regression item, not as a mode of this one.
6. **Who owns a filed product regression** -- which area, which assignee, which work
   item type? The vocabulary trap means this is configured per target, never guessed.
7. **What is the quarantine budget**, and who signs off when a run wants to exceed it?
8. **How much history and artifact retention** does the target's pipeline have? That
   sets how well flakiness can be detected and how far back a last-green build can be
   found.
9. **Does a QA repair PR need a different reviewer set** from a normal sprint PR? My
   instinct is yes -- a weakening-detector hit should route to someone who knows what
   the test was for.
