# Remediation Plan: auto-sprint Graph/Glossary/Architecture Consistency

Status: **planning artifact only**. No file edits, bead mutations, or git operations
have been made as part of producing this plan (the disposable `fake-*` beads used to
sharpen a few findings were created and deleted in the same session -- see "Experimental
confirmations" below; the real sprint data is unaffected, verified).

This plan sequences remediation for the 22 findings in the prior audit report. It is
organized by **remediation surface** (own prose/code vs. live bead data vs. upstream `bd`),
then by **dependency phase** within the surfaces that need one. Every item states: what
changes, why it is sequenced there, and how to verify it worked. Nothing here should be
read as "fix all 22" -- Section 5 explicitly triages what NOT to touch right now.

---

## 0. Experimental confirmations (upgrades from the original audit)

Per the user's request, three findings that were previously inferred (from binary strings
or a single live data point) were re-verified this session with isolated, throwaway
`fake-*` beads that never touched the real xbu/p4f/j6i/etc. subtrees. All were created and
deleted in the same session; final state confirms deletion succeeded and real data is
untouched (`apra-fleet-xbu` scope still shows 15 ready beads, unchanged).

- **Finding #2/#3 (planner cycle + bd's internal disagreement): now directly reproduced,
  isolated.** `bd create fake-task-B --type=task` + `fake-task-B1 --parent fake-task-B`,
  then `bd dep add fake-task-B fake-task-B1` (the literal `bd dep add <parent> <child>`
  shape planner.md Step 2/3 instructs) **succeeded** with no rejection, immediately
  deadlocking both beads (`bd list --parent fake-task-B --ready` → `[]`, `bd blocked`
  correctly shows both mutually blocked) while `bd dep cycles` reported "No dependency
  cycles detected" throughout. Confidence: was medium (real-data inference), now **high**
  (clean isolated repro).
- **New sub-finding, not in the original 22:** bd's cycle protection is direction-sensitive
  in a way no prose contract mentions. `bd dep add <child> <epic-parent>` (child depends on
  its own parent) is rejected by a *different* guard ("already a child of ... would create
  a deadlock") that fires for **any** parent type, epic or not. But `bd dep add <parent>
  <child>` (parent depends on its own child -- the direction planner.md actually uses) is
  **not** covered by that guard for non-epic parents -- only the epic-only type gate can
  catch it, and it doesn't apply to task/bug/feature parents. So bd has half of a general
  fix already built (the child->parent guard) but does not apply the same logic to the
  parent->child direction for non-epics. This directly informs the workaround design in
  Phase P-lib below.
- **Finding #9 (`bd epic status <non-epic-id>`): confirmed, isolated.** Ran against a
  disposable epic (`fake-epic-A`) mixed in with the real epics -- confirms the silent
  ignore-and-list-everything behavior is general, not an artifact of `apra-fleet-xbu`
  specifically. Confidence: medium -> high.
- **Finding #4 (`--parent a,b` comma bug): confirmed, isolated.** Two disposable single-bead
  roots each returned 1 row alone, 0 rows combined via comma. Confidence: was already high
  (reproduced on real data); now doubly confirmed on data with no legacy history.

## 0.2 Upstream source confirmation (via DeepWiki against gastownhall/beads)

Per the user's pointer, queried DeepWiki against the actual `bd` source
(`github.com/gastownhall/beads`) to move Finding #3 from "observed behavior, cause
unknown" to "root-caused against the actual implementation." This upgrades several items
above from medium to high confidence and materially changes Phase C4/Phase D below.

- **Confirmed root cause of the ready/cycle-detector split (Finding #3):** two genuinely
  separate code paths, by design, not a bug in the sense of "someone forgot":
  `GetReadyWork` (`internal/storage/issueops/ready_work.go`) treats `parent-child` as one
  of four dependency types affecting readiness (`DepBlocks`, `DepParentChild`,
  `DepConditionalBlocks`, `DepWaitsFor`, via `DependencyType.AffectsReadyWork()`) --
  correctly making a bead with a blocked parent show as blocked. `DetectCycles`
  (`internal/storage/issueops/...`, via `cycleRelevantDepType`) is **deliberately** narrower
  and excludes `DepParentChild` on purpose, specifically so that `bd dep add` doesn't reject
  a legitimate `blocks` edge just because a `parent-child` path happens to close a loop back
  to it. In other words: bd's authors intentionally chose "don't cycle-check through
  parent-child" as a feature (to avoid over-rejecting valid graphs), with the side effect
  that a `blocks`-based deadlock routed *through* a `parent-child` edge is invisible to both
  `bd dep add`'s pre-check and `bd dep cycles`, while still being fully enforced (correctly,
  silently) by `GetReadyWork`. This is a real, load-bearing design tradeoff upstream, not an
  oversight -- worth stating exactly this way in the Phase D issue report so it reads as
  "here's a gap in your intentional design," not "you have a bug."
- **`bd doctor` already ships a detector/fixer for a closely related anti-pattern -- but it
  only covers the OTHER direction.** `checkChildParentDependenciesDB`
  (`cmd/bd/doctor/validation.go`) and its `--fix-child-parent` remediation
  (`cmd/bd/doctor/fix/validation.go`, `ChildParentDependencies`) detect exactly this SQL
  shape: `d.issue_id LIKE CONCAT(d.depends_on_id, '.%') AND d.type IN ('blocks',
  'conditional-blocks', 'waits-for')` -- i.e. **child depends on parent** (`fromID=child,
  toID=parent`). This is the SAME direction the live `bd dep add <child> <parent>` guard
  (Section 0's Exp A, "already a child of ... would create a deadlock") already rejects at
  write time. Confirmed via DeepWiki: `bd doctor` does **not** detect the reverse shape
  (**parent depends on child**, `fromID=parent, toID=child`) -- which is the exact shape
  planner.md's Step 2/3 produces and the exact shape reproduced live in Section 0
  (`bd dep add fake-task-B fake-task-B1`). So bd has *half* of a general fix for this class
  of bug already built and shipped, just pointed the wrong way for this project's actual
  failure mode. This is the single most actionable fact for the Phase D issue report: ask
  upstream to extend `checkChildParentDependenciesDB`/`ChildParentDependencies` to also
  catch `d.depends_on_id LIKE CONCAT(d.issue_id, '.%')` (parent depends on child), which
  would fix this for every `bd`-using project, not just this one.
- **`bd doctor` is not usable in this repo's current mode at all -- verified live.** Running
  bare `bd doctor` here returns: `"Note: 'bd doctor' is not yet supported in embedded
  mode."` -- this repo's `.beads/` runs `embeddeddolt`, not server mode. This directly
  affects Phase A/C planning: **do not propose "run `bd doctor --fix-child-parent`" as a
  repair mechanism for this repo** (it would be the right tool if it worked, and IS the
  right recommendation for the upstream issue report to reference as prior art bd could
  extend) -- it simply isn't available here. `bd dep remove` (Phase A1, already the plan)
  and the JS-level guard (Phase C4, already the plan) are confirmed as the only viable
  workarounds for this repo, not just the preferred ones.
- **Type-compatibility validation confirmed narrow as originally read from binary strings**
  (`internal/storage/issueops/dependencies.go`, `AddDependencyInTx`): `blocks` dependencies
  require same-type endpoints (the epic-only-blocks-epic rule is one instance of a general
  "blocks requires same type" rule, not epic-specific special-casing -- worth noting in the
  Phase D report and in the Phase B glossary, since it reframes the rule slightly: it's not
  "epics are protected," it's "blocks requires matching types, and epic happens to be the
  type this project's contracts use as the parent role"). `parent-child` is explicitly
  exempt from this type check (cross-type parent-child is fine, e.g. an epic parenting a
  task, which is exactly this project's normal shape).
- **Additional dependency types exist in bd that this project's contracts and the Phase B
  glossary draft do not mention:** `conditional-blocks`, `waits-for`, `discovered-from`,
  `related`/`relates_to`. `DepWaitsFor` and `DepConditionalBlocks` both affect ready-work
  computation the same way `blocks` does. None of this project's agent contracts or
  runner.js reference these types, so they're out of scope for the immediate fix, but the
  Phase B glossary section (3.2) should get one line noting they exist, so a future
  contract author doesn't assume `blocks`/`parent-child` are the only two edge types bd
  supports.

## 0.1 Confidence flags carried over from the original audit (unchanged by this session)

These are called out per requirement #6 -- read before acting on them:

- **Finding #3, the *upstream* framing (bd's `dep cycles`/`dep add`/ready-engine mutual
  disagreement as a general defect, not just this one shape):** confidence **medium**. What
  is now directly confirmed is the *specific* shape (parent-type task, `blocks` in the
  parent->child direction). Whether `bd dep cycles` fails to detect *all* mixed
  parent-child+blocks cycles, or only this specific 2-node shape, was not exhaustively
  tested (e.g. 3+ node mixed cycles, cycles spanning multiple parent levels). Treat the
  upstream bug report (Phase P-bd below) as scoped to the confirmed shape unless further
  testing broadens it.
- **Epic type-gate error message internals ("epics can only block other epics, not tasks"
  / "tasks can only block other tasks, not epics"):** confidence **high** for the message
  text (read directly from `bd.exe` and reproduced live via `bd dep add`), but the exact
  *scope* of the gate (does it also block feature<->epic, chore<->epic, etc., or only
  epic<->task specifically) was inferred from two strings plus one live repro against a
  `feature`-typed child, not exhaustively matrixed against every `issue_type` pair. Treat
  "epic-only, and only vs. task" as the safe assumption; do not assume a feature-typed or
  chore-typed parent gets any protection.
- **Viewer findings (5.1-5.3):** confidence high (read directly from
  `viewer-extensions.mjs` source, not inferred) but **not runtime-verified in a browser** --
  no live dashboard was rendered against real or fake data this session. The described
  behavior follows directly from the code as written; if the dashboard has since changed
  in ways not visible in this file (e.g. a wrapper that post-processes `sprintTasks` before
  calling `renderBeadsHtml`), that would change the finding. Treat as high-confidence on
  "what this function does with the data it's given," lower confidence on "what data it's
  actually given at runtime."
- **cli.mjs `finally` block (finding #13):** confidence high on the code read; the actual
  effect (dashboard user losing visibility into a fatal error) was not observed by
  triggering a real fatal and watching the dashboard die, only inferred from the
  `process.exit()` call placement.

---

## 1. Remediation surfaces (per requirement #2)

| Surface | Owner | Mechanism | Urgency driver |
|---|---|---|---|
| **A. Live bead data** (this repo's `.beads` DB, right now) | whoever runs the next sprint | `bd dep remove` / `bd update --status` etc. -- no code change | Blocks the next sprint launch; cheap; do first |
| **B. This repo's prose contracts** (`packages/apra-fleet-se/apra-pm/agents/*.md` -> `dist/agents/*.md` -> `~/.claude/agents/*.md`) | this project | edit `packages/apra-fleet-se/apra-pm/agents/*.md` (source of truth), rebuild/reinstall | Root-causes the *next* incident, not just today's |
| **C. This repo's code** (`runner.js`, `bin/cli.mjs`, `viewer-extensions.mjs`, `contracts.mjs`) | this project | PR against `packages/apra-fleet-se/**` | Fixes systemic bugs the prose can't fix alone |
| **D. Upstream `beads` tool** (`@beads/bd`) | beads maintainer, not this project | file an issue; do **not** block on a fix landing | Per the user's explicit direction: report it, but design our own workaround now -- do not wait |

Per the user's direction on surface D: for every finding whose root cause lives inside
`bd` itself, this plan proposes (a) an upstream issue to file, and (b) a same-repo
workaround in surface B or C that does not depend on the upstream fix landing. No item in
this plan is blocked on beads-maintainer action.

---

## 2. Phase A -- Live data repair (surface A, do first, no code/prose change)

These are `bd` command sequences against the real DB. They are the only items in this plan
that touch real (non-fake) sprint data. Nothing here is executed by this plan -- it
specifies exactly what a human or a follow-up authorized action would run.

### A1. Break the 0pu cycle (Finding #1) -- CRITICAL, do immediately, unblocks Phase A2
- **What changes:** `bd dep remove apra-fleet-0pu apra-fleet-0pu.1` and
  `bd dep remove apra-fleet-0pu apra-fleet-0pu.2` (removes the two `blocks` edges from the
  parent bug down to its own subtasks -- the same edges that were removed for its four
  sibling trees p4f/j6i/02s/6fr during the original incident fix). Leaves the
  `parent-child` edges (0pu.1/0pu.2 -> 0pu) intact.
- **Why sequenced here:** Independent of everything else; it is a live deadlock right now.
  Doing it first means the next sprint launch (whenever it happens) doesn't inherit a
  known-broken subtree. It does *not* need to wait for the prose/code fixes in Phases B/C
  -- those prevent *future* recurrences; this un-deadlocks the *current* one.
- **Verification:** `bd list --parent apra-fleet-0pu --ready --json` returns >= 1 bead
  (currently returns `[]`); `bd blocked` no longer lists 0pu/0pu.1/0pu.2; `bd dep cycles`
  is not a useful check here (per 0.1, it already falsely reports clean).

### A2. Decide the fate of the five already-repaired parent bugs (part of Finding #8) -- do after A1, HIGH -- REVISED after live testing (see addendum below)
- **The problem:** p4f, j6i, 02s, 6fr (and, after A1, 0pu) are `ready` **simultaneously
  with their own subtasks**, because removing the `blocks` edge left nothing gating the
  parent bead itself. A doer can be dispatched the parent bead as if it were leaf work,
  racing/duplicating the subtask work.
- **Retyping to `issue_type=epic` was tried live and rejected -- do not do this.** The
  coordinator retyped all five to `epic` and re-checked `bd list --parent apra-fleet-xbu
  --ready --json`: they still appeared in the ready list. Confirmed against this project's
  own audit (Part 8, G7: "Epics appear in `bd ready` like anything else") and against
  DeepWiki's read of `GetReadyWork` (Section 0.2): bd's ready-work engine has no
  `issue_type`-based exclusion at all -- `epic` is not a "container, don't dispatch" marker
  to bd. So retyping (a) doesn't solve the problem it was proposed for, and (b) is
  semantically wrong regardless -- a `[bug]`-titled decomposed task did not become "a large
  multi-feature initiative" by growing children; it's still a bug. Retyping trades semantic
  accuracy (bug reports permanently mislabeled as epics in the historical record, and
  mis-triggering `bd epic status`/plan-reviewer's epic-specific logic later) for a benefit
  it doesn't even deliver. **If this retype has already been applied, revert it**: `bd
  update <id> --type=task` for each of the five (their original stored type was `task` with
  a `[bug]` title prefix, not stored `type=bug` -- reverting to `task` restores the
  pre-experiment state exactly).
- **What changes instead (the actual fix, moved here from what was originally proposed as
  Phase C5):** the correct exclusion signal is structural, not type-based -- "is this
  bead's id referenced as another bead's `.parent` field" (i.e. does it have children),
  which is true regardless of `issue_type` and requires no retyping. See the rewritten
  Phase C5 below; this IS the fix for Finding #8's double-dispatch, and it lives entirely
  in runner.js, not in the bead data. Phase A2 is therefore reduced to just: confirm/revert
  any retype already applied, and otherwise leave `issue_type` as `task` on all five. No
  other live-data change is needed for this finding.
- **Why sequenced after A1:** A1 fixes deadlock; A2 (now just a type-revert-if-needed) is
  independent of A1 but bundled here since both touch the same five beads.
- **Verification:** `bd show <id> --json` for each of the five reports `issue_type: task`
  (not `epic`); the actual double-dispatch fix is verified under Phase C5 below (structural
  exclusion in the ready-dispatch query), not by anything in Phase A.

### A3. Refresh the stale xbu manifest description (part of Finding #22) -- LOW, do whenever convenient
- **What changes:** `bd update apra-fleet-xbu --description="..."` correcting the claim
  "This bead is intentionally blocked by every bead selected for that sprint" (no longer
  true post-fix; `dependency_count: 0` now) to reflect that completion tracking is via
  `dependent_count`/`bd epic status`-style child inspection, not a `blocks`-based gate.
- **Why sequenced last in Phase A:** Purely descriptive; no functional effect on dispatch.
  Bundle it with A2 if a human is already touching xbu's children.
- **Verification:** `bd show apra-fleet-xbu` description no longer claims a blocking gate
  that doesn't exist.

---

## 3. Phase B -- Prose contracts: the glossary-first fix (surface B)

### 3.1 Feasibility assessment (requirement #3)

Traced pipeline: `packages/apra-fleet-se/apra-pm/agents/*.md` (submodule, source of truth) ->
`scripts/vendor-pm.mjs` copies to `dist/agents/*.md` at `prepublishOnly` ->
`src/cli/install.ts` installs from `packages/apra-fleet-se/apra-pm/agents` (fallback `dist/agents`) into
`~/.claude/agents/*.md` (or the equivalent path for Gemini/AGY per `src/cli/config.ts`).

**Each `*.md` file is a self-contained prompt handed whole to a subagent dispatch** (per
`src/tools/execute-prompt.ts`'s resolution: `<workFolder>/.claude/agents/<name>.md`). There
is no include/import mechanism in this pipeline -- no templating step that assembles a
contract from fragments before install. This means a literal "one canonical section
`import`ed into 8 files" is **not directly supported** by the current build.

Two feasible approaches, in order of preference:

- **Recommended: build-time concatenation.** Add a `GRAPH-SEMANTICS.md` (or similarly named)
  canonical fragment under `packages/apra-fleet-se/apra-pm/agents/_shared/`, and extend
  `scripts/vendor-pm.mjs` (the same script that already does the `packages/apra-fleet-se/apra-pm/agents` ->
  `dist/agents` copy) to prepend/inject that fragment's content into each of the 8 role
  files during the copy step -- e.g. replace a marker line
  (`<!-- GRAPH-SEMANTICS -->`) in each role file with the shared fragment's content. This
  keeps a single source of truth (the fragment) while still producing 8 fully
  self-contained installed files (required, since there's no runtime include mechanism and
  `execute-prompt.ts` hands the file over whole). This is a moderate change: one new file
  plus a ~15-20 line edit to `vendor-pm.mjs`'s copy loop, verified against the existing
  `gen-sea-config.mjs` glob pattern (`collectFiles(... 'packages/apra-fleet-se/apra-pm/agents' ...)`) to
  confirm the new `_shared/` subfolder doesn't get accidentally shipped as its own
  "agent" (it should be excluded from whatever list drives agent-name resolution, e.g. if
  `install.ts` enumerates `*.md` in that directory as agent names, `_shared/*.md` must be
  filtered out).
- **Fallback if the build-time approach is rejected (e.g. team prefers not to touch the
  vendoring script):** treat the canonical section as a **checklist to copy-paste
  identically into all 8 files by hand**, plus a CI/lint check (a small script, could live
  in `scripts/`) that diffs the "graph semantics" section of each of the 8 files against a
  single reference copy and fails the build if they've drifted. This is strictly worse
  (manual sync discipline, drift is possible again) but requires zero changes to the
  install/build pipeline. Use this only if the recommended approach is infeasible for
  reasons not visible from this audit (e.g. `packages/apra-fleet-se/apra-pm` being a genuinely
  externally-owned submodule this project cannot modify -- **this needs a human answer**;
  the audit did not determine whether `packages/apra-fleet-se/apra-pm` is this org's own submodule or a
  third-party one. If third-party, the shared-fragment approach still works exactly the
  same way, just authored by whoever owns that submodule, with this project's contribution
  submitted upstream to it.)

### 3.2 Canonical section content (drafted here, to be placed in the shared fragment)

This is the actual content proposed for the new `GRAPH-SEMANTICS.md` fragment (or
equivalent), derived from the audit's Part 8 glossary, corrected per finding #2/#3's
confirmed behavior and the user's instruction to drop "enhancement":

```markdown
## How the beads dependency graph works (canonical -- do not restate elsewhere)

Two edge types exist. They are NOT independent axes -- a `parent-child` edge and a
`blocks` edge between the same two beads, in opposite directions, form a cycle that
deadlocks BOTH beads. bd's ready/blocked engine does not reliably self-report such
cycles (`bd dep cycles` can say "no cycles detected" while `bd blocked` correctly shows
both beads mutually blocked) -- do not trust `bd dep cycles` as your sole cycle check.

- **`parent-child`** (via `--parent <id>` at creation or `bd update <id> --parent <id>`):
  grouping/scope only. A bead's parent-child ancestry does NOT by itself block it from
  being ready. It DOES make the bead visible to `bd list --parent <ancestor-id>
  --ready/--status=...` queries (transitively, but the ancestor itself is excluded from
  its own `--parent` query results).
- **`blocks`** (via `bd dep add <A> <B>`, meaning A depends on B / A is blocked until B is
  done): ordering. This is the only edge type agents should add by hand for sequencing.
  - bd's real rule is "`blocks` requires both endpoints to be the SAME issue_type" --
    epic-vs-epic is just the instance of that rule this project's contracts happen to hit
    (since sprint roots are usually epics). `bd dep add <epic> <task-or-feature-or-bug>` is
    rejected outright with "epics can only block other epics, not tasks". This rule does
    NOT extend to protecting a `task`/`bug`/`feature`/`chore` parent from its own child --
    bd allows a non-epic parent to be wired `blocks`-dependent on its own same-type child
    with zero rejection, and this WILL deadlock both beads the moment that parent also has
    a `parent-child` edge from the child (which it will, if the child was created with
    `--parent <this-bead>`). `parent-child` edges themselves are exempt from the
    same-type rule entirely (an epic parenting a task is normal and fine).
  - Separately, bd DOES reject the reverse direction for any parent type: `bd dep add
    <child> <its-own-parent>` fails with "already a child of ... would create a
    deadlock". This guard only covers that one direction -- it does NOT protect the
    `bd dep add <parent> <child>` direction, which is the one that actually causes
    incidents in this project's history.

**The rule that follows, for every role that creates or wires dependencies:**
NEVER add a `blocks` edge in either direction between a bead and its own `--parent`
ancestor/descendant, regardless of issue_type. Grouping is `parent-child`. Ordering
between UNRELATED (non-ancestor/descendant) beads is `blocks`. If a parent bead needs to
track "all children done," use `bd epic status <id>` / `dependent_count` / manual
inspection -- never a `blocks` edge back onto its own children.

**Issue types** (`bd create -t`, aliases in parens): `epic`, `feature` (aliases: `feat`),
`task` (default), `bug`, `chore`, `decision` (aliases: `dec`, `adr`). There is no
`enhancement` type -- `enhancement` is only a creation-time alias that resolves to
`feature`. If you write "bug or enhancement," you mean "bug or feature"; write it that way.
`test` is not a type either -- it's a `[test]` title-prefix convention on ordinary `task`
beads, recognized only by string-matching the title (planner, integ-test-runner, and the
dashboard all do this independently; there is no structural `test` marker in bd).

**Other edge types exist in bd** (`conditional-blocks`, `waits-for`, `discovered-from`,
`related`/`relates_to`) -- `conditional-blocks` and `waits-for` affect ready-work
computation the same way `blocks` does; the others don't. None of this project's agent
contracts or the auto-sprint code currently use them. Don't assume `blocks`/`parent-child`
are the only two edge types bd has if you're extending this workflow later.

**Scoping convention for THIS workflow specifically:** every query that means "what's
ready/open/closed for the CURRENT sprint" must use `--parent <sprint-root-id>`, never bare
`bd ready`/`bd list --status=...` (bare forms return project-wide results, including other
sprints/tracks running concurrently). `--parent` accepts exactly ONE id per invocation --
it does NOT accept a comma-separated list (a known bd limitation; if your dispatch context
gives you multiple sprint-root ids, query each separately and union the results yourself,
do not pass them comma-joined).
```

### 3.3 Per-file changes once the shared section exists

Findings resolved directly by adopting the shared section (no further per-file prose needed
beyond inserting the marker + role-specific query examples):

- **planner.md** (Finding #2, root cause): Step 2/3's wiring instructions
  (`bd dep add <sprint-id> <feature-id>`, `bd dep add <feature-id> <impl-task>`) must be
  corrected to never wire a `blocks` edge between a bead and its own `--parent`
  ancestor/descendant -- i.e. Step 2's "Wire: `bd dep add <sprint-id> <feature-id>`" is
  ITSELF the bug if `<feature-id>` was also created via `--parent <sprint-id>` (Step 2's own
  instruction two lines earlier). This is not a wording tweak; it's removing a broken
  instruction pattern. Replacement: features/tasks get their ordering relative to *other*
  features/tasks (e.g. "test task blocked by impl task" -- fine, they're siblings, not
  ancestor/descendant), never relative to their own parent -- the parent's "blocked until
  done" semantics come for free from parent-child + `bd epic status`, not from `blocks`.
  Step 4's acyclicity self-check must switch from bare `bd ready`/`bd blocked`/`bd graph`
  to the scoped forms (`bd list --parent <sprint-id> --ready`, `bd blocked --parent
  <sprint-id>`), and must stop treating criterion 2's "correct" example
  (`bd dep add <sprint-id> <feature>`) as safe -- per the shared section, it's exactly the
  forbidden pattern when `<feature>` is also a `--parent` child of `<sprint-id>`.
- **plan-reviewer.md** (Finding #9): criterion 9's false "epics can only... beads rejects
  that edge outright" claim gets corrected in place to point at the shared section instead
  of re-deriving (possibly incorrectly) its own understanding of the epic rule. Also fix
  the `bd epic status <scope>` instruction -- confirmed this session that it silently
  ignores a non-epic scope id and dumps unrelated epics; criterion 9 needs an explicit
  type-check (`bd show <scope> --json`, read `issue_type`) before deciding whether
  `bd epic status` is even meaningful for this scope, falling back to
  `dependent_count`/manual child inspection for non-epic scopes.
- **doer.md** (Finding #5): Step 1/Step 3's bare `bd ready` must become
  `bd list --parent <scope> --ready` using the scope from Inputs (doer.md currently has no
  `scope` input at all -- this requires ALSO adding one, matching what
  `buildDoerPrompt`/runner.js already knows and could pass, see Phase C item C2).
- **reviewer.md** (Finding #12): Step 2's `bd list --status=closed --closed-after=$(date
  +%Y-%m-%d)` needs the same scope parameter; either add `--parent <scope>` or (cleaner,
  since the orchestrator already hands the reviewer explicit bead IDs in the dispatch
  prompt per `buildReviewerPrompt`) drop the `bd list` re-derivation entirely and rely
  purely on the IDs already supplied -- this is arguably a bigger fix than a one-line
  scope addition; flag for a design decision, not a mechanical prose edit.
- **integ-test-runner.md**: no change needed to its OWN text (it already correctly demands
  an explicit feature-id list and forbids self-derivation) -- the mismatch is entirely on
  the runner.js side (Phase C, C3).
- **harvester.md, deployer.md, ci-watcher.md**: reference the shared section for
  terminology consistency (glossary drift prevention) but have no scoping bugs of their own
  per this audit; low-priority inclusion, bundle with whichever other file's PR lands first.

### Sequencing within Phase B (dependency-driven, per requirement #1)

```
B0. Write GRAPH-SEMANTICS.md shared fragment + vendor-pm.mjs injection mechanism
     |
     +--> B1. planner.md fix (Step 2/3 wiring + Step 4 self-check)      [MUST land before B2]
     |         |
     |         +--> B2. plan-reviewer.md fix (criterion 9)              [depends on B1: no
     |                                                                    point correcting
     |                                                                    plan-reviewer's
     |                                                                    epic claim while
     |                                                                    planner can still
     |                                                                    HAND it a cycle to
     |                                                                    approve]
     |
     +--> B3. doer.md fix (scoped ready + new `scope` input)             [independent of B1/B2,
     |                                                                     can land in parallel]
     +--> B4. reviewer.md fix (scoped closed-list or ID-only)            [independent, can land
     |                                                                     in parallel]
     +--> B5. harvester/deployer/ci-watcher glossary-only inclusion      [no dependency, do last/
                                                                           opportunistically]
```

**Why B1 blocks B2 explicitly (answering requirement #1's example):** plan-reviewer's job
is to catch a bad DAG the planner produced. If planner.md still emits the cycle (B1 not
yet landed), then correcting plan-reviewer's prose claim about epics (B2) doesn't help --
the reviewer's corrected understanding has nothing to *check against* that would still be
wrong, because the underlying generator is still broken. Landing B2 before B1 gives a false
sense of safety: a "fixed" reviewer approving DAGs from a still-broken planner.

**Verification for B1+B2 together:** dispatch planner against a fresh task-typed sprint
scope (or reuse the fake-bead technique from Section 0 with a throwaway task-typed parent +
children), confirm the produced DAG has zero `blocks` edges between any bead and its own
`--parent` ancestor/descendant, then dispatch plan-reviewer against that scope and confirm
its criterion 9 check runs the scoped `bd list --parent <scope> --ready --json` and reports
correctly (non-empty) rather than invoking the now-corrected `bd epic status` guidance on a
non-epic scope.

**Verification for B3/B4:** dispatch doer/reviewer against a scope shared with an unrelated
concurrent throwaway sprint scope (two independent `--parent` roots with their own ready
work); confirm doer only claims/closes beads under its assigned scope, and reviewer only
reads closes under its assigned scope, even though bare `bd ready`/`bd list --status=closed`
would show both.

---

## 4. Phase C -- Code fixes (surface C)

Unlike Phase B, most Phase C items are independent of each other and of Phase B (no shared
dependency chain), except where noted. Ordered here roughly by severity, with explicit
dependency notes only where they exist.

### C1. runner.js: multi-issue `--parent a,b` comma bug (Finding #4) -- HIGH, independent
- **What changes:** `runner.js:1099`'s `sprintFilter` construction changes from a single
  `--parent ${targetIssues.join(',')}` to per-target-issue queries unioned in JS -- e.g. a
  helper `async function listAcrossScopes(flags)` that runs `bd list --parent <id> ${flags}`
  once per `targetIssues` entry and concatenates+dedupes the JSON results, replacing every
  call site currently built on `sprintFilter` (runner.js:1392, 1407, 1658, 1714, 1982, 2093,
  2104, 1333, 1355-region backlog exclusion). The `bd create ... --parent
  ${targetIssues.join(',')}` calls (1975, 2183) need the same treatment -- likely just
  picking `targetIssues[0]` as the created bead's single parent, or (better) prompting the
  reviewer's `newTasks` to name which scope they belong to if there's more than one root,
  since a bead can only have one `--parent`.
- **Why independent:** Self-contained to runner.js's query construction; does not depend on
  any Phase B prose fix (the prose contracts don't reference `sprintFilter` directly).
- **Verification (per requirement #4's example):** relaunch (or dry-run against a disposable
  two-root fake scope, per Section 0's technique) a sprint with a multi-issue `--issue`
  list; confirm `bd list --parent <id> --ready --json` unioned across each id returns the
  expected non-zero, non-duplicated ready count, where the old single comma-joined query
  returned `[]`.

### C2. runner.js/doer.md: give the doer an explicit scope input (Finding #5) -- HIGH, depends on B3
- **What changes:** `buildDoerPrompt` (runner.js:673) already knows `sprintFilter`/the
  target scope at the call site (it's in the same closure as `sprintFilter`) -- add a
  `scope: targetIssues` line to the prompt text alongside the existing `beadIds`/`branch`
  lines, matching whatever doer.md's Inputs section is updated (B3) to expect.
- **Why it depends on B3:** The code change is trivial (one more line in the prompt
  builder) but is only meaningful once doer.md's prose actually tells the doer what to DO
  with a scope value (i.e., use `bd list --parent <scope> --ready` instead of bare
  `bd ready`). Landing C2 before B3 produces a prompt with unused scope information; landing
  B3 before C2 produces a doer contract that expects an input the dispatch never supplies.
  They should land in the same PR/commit if at all practical.
- **Verification:** same as Phase B3's verification (two concurrent scopes, confirm no
  cross-scope claim).

### C3. runner.js: supply integ-test-runner its required feature-id list (Finding #6/#7) -- HIGH, independent
- **What changes:** Around runner.js:2047-2048, the dispatch prompt currently reads
  `'Run tests using integ-test-playbook.md. Add bug beads if needed.'` -- this needs an
  explicit feature-id list computed the same way `sprintFilter`-scoped queries elsewhere in
  the file already work: `bd list --parent <scope> --type=feature --status=open --json`,
  and that list's IDs interpolated into the prompt per integ-test-runner.md's Inputs
  contract ("An explicit list of feature ids"). This also fixes the unlinked-bug half of
  Finding #6 for free once the runner is explicitly scoping the dispatch: while at it, add
  `--parent ${targetIssues[0]}` (or the C1 multi-scope equivalent) to the `bd create
  --type=bug` instruction the integ-test-runner is told to use in its own contract, so
  filed bugs are visible to the goal-priority exit check.
- **Why independent:** Self-contained to the integ-test dispatch call site; doesn't touch
  planner/doer/reviewer prose.
- **Verification:** dispatch integ-test-runner against a scope with 2+ open features + 1
  feature belonging to a different, unrelated scope; confirm only the in-scope features are
  tested/closed, and confirm a filed bug (from a deliberately-failing test) appears in a
  subsequent `bd list --parent <scope> --status=open --priority-max=<goal>` query (i.e. it
  now counts toward the exit condition).

### C4. runner.js: workaround for bd's cycle-detection blind spot (Finding #3, workaround per user direction) -- HIGH, independent of Phase B, but should land ALONGSIDE B1
- **What changes:** Since `bd dep cycles` cannot be trusted (Section 0 confirms this
  cleanly, and Section 0.2's upstream research confirms it's a deliberate design tradeoff,
  not a bug that will get silently fixed) and `bd doctor`'s built-in
  `checkChildParentDependenciesDB`/`--fix-child-parent` detects only the opposite direction
  (child depends on parent, not parent depends on child) AND is unavailable in this repo's
  embedded-Dolt mode regardless -- so there is no existing bd feature, current or
  soon-to-exist, this project can lean on -- add an application-level cycle guard in
  runner.js's pre-sprint validation (near the existing block at runner.js:1392-1440) that
  does NOT rely on `bd dep cycles`, `bd doctor`, or the planner self-check (B1) alone: after
  any planner/plan-reviewer pass, before proceeding to Develop,
  fetch `bd list --parent <scope> --json` (full records including `dependencies`), and in
  JS walk each bead's `dependencies` array checking for the specific forbidden shape: any
  bead with a `blocks`-type dependency on an id that is ALSO its `parent-child` ancestor or
  descendant (this is a direct, local, O(n) check per bead using the parent chain already
  present in each record's `parent` field plus one `depends_on_id` scan -- it does not need
  general graph-cycle detection, just this one specific known-bad shape). If found: do not
  silently proceed -- surface it the same way the existing "no ready beads" diagnostic does
  (list the offending bead ids and the exact edge), and either (a) hard-fail with actionable
  output naming the `bd dep remove` command needed, mirroring Phase A1's shape, or (b, more
  ambitious, second iteration) auto-repair by removing the offending `blocks` edge and
  logging what was done. Start with (a); only build (b) once (a) has been observed to fire
  correctly a few times in practice.
- **Why this is a genuine workaround, not a duplicate of B1:** B1 stops the planner from
  *producing* the cycle. C4 is a safety net that catches it if B1's prose fix is
  incomplete, if a human manually wires a bad edge, or if a future prose regression
  reintroduces the pattern -- exactly the kind of defense-in-depth the project's own
  comments elsewhere (A7 in contracts.mjs) already practice. It is also the right place to
  put the workaround because runner.js is the one place that has JS (not just LLM
  discipline) available to enforce it deterministically.
- **Why sequenced to land alongside B1, not strictly before/after:** They address the same
  failure from two different enforcement layers (prose discipline vs. deterministic code
  check) and are independent to build, but shipping C4 without B1 means every sprint still
  routinely trips the guard (annoying, not wrong); shipping B1 without C4 means the fix is
  only as strong as one prompt's discipline. Recommend landing together in one PR/review
  pass, but they do not block each other technically.
- **Verification:** reproduce the exact fake-task-B/B1 scenario from Section 0 as an
  automated regression test (throwaway beads created and deleted within the test, per the
  pattern already demonstrated this session) and confirm pre-sprint validation now surfaces
  the specific-shape diagnostic instead of either silently proceeding or falling through to
  the generic "no ready beads, nothing to do" message.

### C5. runner.js: structurally exclude beads-with-children AND close-protected types from the ready dispatch list (Finding #8/#16, REVISED -- type-filter alone is insufficient, see below) -- HIGH, independent, now does double duty (double-dispatch fix moved here from Phase A2)

**This item changed shape after live testing during Phase A2 (see that section's
addendum).** The original proposal was a pure `--exclude-type=epic,feature,bug` filter.
That is necessary but not sufficient: it only ever catches a parent-with-children if that
parent happens to be typed `epic`/`feature`/`bug`. The five beads that actually caused
Finding #8's double-dispatch (p4f, j6i, 02s, 6fr, 0pu) are `issue_type=task` -- the SAME
type as every ordinary leaf work item -- so no type-exclude list can distinguish "task with
children, don't dispatch as leaf work" from "task, dispatch normally" without either (a)
excluding `task` entirely, which breaks all real leaf-task dispatch, or (b) retyping the
parent away from `task` first, which Phase A2 tried, is semantically wrong (a bug bead
mislabeled as an epic), and was empirically proven not to even help (`epic`-typed beads
still show up in `bd ready` -- confirmed live, matches audit finding G7 and DeepWiki's read
of `GetReadyWork` having no `issue_type`-based exclusion at all). This item is corrected to
a **structural** check instead:

- **What changes:** at the two ready-fetch call sites feeding doer dispatch
  (runner.js:1677-1678 and :1720-1721), after parsing the `--ready --json` result, cross-
  reference it against the full-scope fetch `updateDashboard()` already makes
  (`bd list ${sprintFilter} --json`, runner.js:1330-ish -- reuse or re-fetch, whichever is
  already in scope at that point in the cycle) to build a `Set` of every `.parent` value
  present across all in-scope beads (every bead record already carries its own `.parent`
  field -- confirmed live: e.g. `apra-fleet-6fr`'s record has `"parent":
  "apra-fleet-xbu"`). Filter `currentReady`/`readyBeads` to drop any bead whose `id` is a
  member of that parent-id set (i.e. it has at least one child in scope) -- these are
  organizational/decomposed beads, not leaf work, regardless of their stored `issue_type`.
  Separately, ALSO keep a narrower `--exclude-type=epic` (or equivalent post-filter) for
  the case of a genuine, correctly-typed epic that happens to have zero children fetched
  in a partial scope (defense in depth, cheap to keep, does not replace the structural
  check). Drop the `feature`/`bug` type-exclude entries from the original proposal --
  they're subsumed by the structural check (a feature/bug bead with children is now
  correctly excluded by the parent-id-set check; a feature/bug bead with NO children was
  never actually a double-dispatch risk in the first place -- doer.md just needs to not
  close it, which is a separate contract-compliance question, not a dispatch-eligibility
  one; see the note on doer.md's task-only-close rule, unaffected by this fix either way).
- **Why independent, and why it now absorbs what was Phase A2's motivation:** Purely a
  query/post-filter change in runner.js; unaffected by Phase A/B state, and requires no
  bead-data change at all (no retyping, no A2 "Option 1"). This makes the live `.beads` DB
  state irrelevant to the fix -- p4f/j6i/02s/6fr/0pu are excluded from doer dispatch by
  this check whether they're currently typed `task`, `epic` (if the retype from A2 hasn't
  been reverted yet), or anything else, because the check never looks at `issue_type` for
  the primary exclusion.
- **Verification:** re-run the develop loop against the real xbu scope (or a disposable
  fake-bead scope built with the Section 0 technique: a task-typed parent with one
  task-typed child, both open) and confirm the parent id never appears in
  `currentReady`/is never assigned to a doer streak, while the child IS assigned normally --
  do this once with the parent stored as `task` and once as `epic` to confirm the fix is
  genuinely type-independent, not accidentally still relying on the now-reverted retype.

### C6. viewer-extensions.mjs: readiness-aware status badge (Finding #14) -- LOW/MEDIUM, independent
- **What changes:** `statusBadge` (viewer-extensions.mjs:98-104) currently keys purely off
  the stored `status` string. To show blocked-but-status-open beads distinctly, the caller
  (wherever `sprintTasks`/`backlogTasks` are assembled server-side before `publishState`)
  would need to additionally compute and pass a `ready`/`blocked` boolean per bead (e.g.
  from the same `bd list --parent <scope> --ready --json` result already fetched for
  dispatch, intersected against `updateDashboard`'s `bd list ${sprintFilter} --json` full
  set) so `renderBeadsHtml` can render a distinct "BLOCKED (deadlocked)" badge instead of
  conflating it with plain OPEN. This is a data-plumbing change (one more field) plus a
  small render-function branch, not a rewrite.
- **Why independent, and why lower priority than C1-C5:** Purely cosmetic today (per the
  original audit); does not affect dispatch correctness, only operator visibility. Still
  worth doing because a human staring at the dashboard during the NEXT incident is the
  exact scenario where "why does this say OPEN but nothing is happening" costs real
  debugging time -- see Section 5 for why this is kept IN the plan rather than deferred.
- **Verification:** render the panel (or the underlying pure function, already unit-testable
  per its own doc comment) against a fixture containing a deliberately-deadlocked pair (the
  Section 0 fake-task-B shape) and confirm the badge differs from a genuinely-open,
  ready bead.

### C7. cli.mjs: don't kill the dashboard on a designed-fatal error (Finding #13) -- MEDIUM, independent
- **What changes:** `bin/cli.mjs:594-597`'s `finally` block calls `server.close()` +
  `transport.stop()` + `process.exit()` unconditionally. Add a distinction between "the
  sprint threw a typed, expected-fatal error the dashboard should stay up to explain"
  (`StalledSprintError`, the pre-sprint validation `Error` at runner.js:1428/1436) vs. "the
  process is genuinely exiting for unrelated reasons" -- e.g. keep the dashboard server
  alive for N seconds (or until an explicit `/ack` from the viewer) after a typed fatal
  before tearing down, rather than exiting in the same tick the error is caught.
- **Why independent:** Self-contained to cli.mjs's shutdown sequence.
- **Verification:** trigger a `StalledSprintError` (or reuse Section 0's fake-cycle scenario
  to trigger the Phase C4 pre-sprint diagnostic) and confirm the dashboard remains reachable
  in a browser for long enough to read the failure before the process exits.

### C8. contracts.mjs: correct the stale "no live prose/schema divergence" comment (Finding #18) -- LOW, independent, do opportunistically
- **What changes:** contracts.mjs:355-371's comment claiming "no live prose/schema
  divergence to document here" plus runner.js:700-702's claim that reviewer.md "tells the
  reviewer to run `bd update` itself" are both stale relative to the current dist/agents
  files (verified: reviewer.md already correctly forbids self-mutation). Update or remove
  these comments; they actively mislead a future reader trying to understand the current
  contract.
- **Why lowest priority in Phase C:** Comment-only; zero behavioral effect.
- **Verification:** re-read the comment against the current `dist/agents/reviewer.md`;
  confirm no remaining contradiction.

### C9. planner.md/prompt vocabulary: `cheap-tier`/`standard-tier`/`premium-tier` vs `cheap`/`standard`/`premium` (Finding #19) -- LOW
- **What changes:** planner.md Step 3 (dist/agents/planner.md:76-81) uses the `-tier`
  suffixed forms in its bucket-name prose while the actual `--metadata` instruction
  (line 67) and runner.js's `buildPlannerPrompt` (contracts.mjs region, runner.js:533-534)
  both insist on the bare three-literal-string form. Fix by deleting the `-tier` suffix
  from the three bullet labels in Step 3 so there is exactly one spelling everywhere.
  Bundle with B1 since it's in the same file/section already being edited for the cycle
  fix.
- **Verification:** grep `dist/agents/planner.md` post-fix for `-tier` and confirm zero
  matches outside of prose describing "a model tier" generically (as opposed to a literal
  value name).

---

## 5. Phase D -- Upstream (surface D): report, do not block on

### D1. File an issue against `github.com/gastownhall/beads`

Now precisely scoped thanks to Section 0.2's source-level research -- this can be filed as
a concrete, actionable report rather than a black-box repro:

- **Primary ask:** extend the existing `checkChildParentDependenciesDB` /
  `ChildParentDependencies` (`--fix-child-parent`) machinery in `cmd/bd/doctor/validation.go`
  and `cmd/bd/doctor/fix/validation.go` to also detect the mirror-image shape. Today its SQL
  predicate is `d.issue_id LIKE CONCAT(d.depends_on_id, '.%') AND d.type IN ('blocks',
  'conditional-blocks', 'waits-for')` (child depends on parent). Ask for an additional
  predicate `d.depends_on_id LIKE CONCAT(d.issue_id, '.%') AND d.type IN ('blocks',
  'conditional-blocks', 'waits-for')` (parent depends on child) -- the exact shape produced
  live in Section 0's isolated repro (`bd dep add fake-task-B fake-task-B1`, no rejection,
  immediate deadlock). Frame this as "you already ship the fix for one direction of this
  anti-pattern; the other direction is just as real and currently invisible to both
  `bd dep add`'s pre-check and `bd dep cycles`." Attach the 3-command isolated repro from
  Section 0 verbatim (no proprietary data in it).
- **Secondary ask, framed as a question not a bug report** (since Section 0.2 confirmed this
  is deliberate): should `bd dep add`'s own pre-check (`isChildOf` in `cmd/bd/dep.go`) also
  cover the parent-depends-on-child direction at write time, the same way it already blocks
  child-depends-on-parent? This would stop the bad edge from ever being written, rather than
  requiring a separate `bd doctor` pass to find it after the fact -- strictly stronger than
  the primary ask, but a bigger behavior change (`AddDependencyInTx` currently only checks
  cross-type compatibility and the one `isChildOf` direction) so it's reasonable for
  upstream to prefer the doctor-based approach as the safer opt-in default.
- **Also worth reporting separately:** the `--parent a,b` comma-list silent-empty behavior
  (Finding #4) -- either reject the malformed multi-id input loudly, or actually support it
  (union semantics) since `bd list --parent` accepting a single string type strongly
  suggests comma-splitting was never implemented, not deliberately rejected.
- **Also worth reporting:** `bd epic status <non-epic-id>` silently ignoring its argument
  instead of erroring (`Finding #9`) -- surprising/silent-failure-prone API surface.
- **Also worth noting in the report (context, not a fix request):** `bd doctor` itself is
  unavailable in embedded-Dolt mode ("not yet supported in embedded mode," confirmed live
  against this repo's `.beads/`) -- so even once the primary ask lands, projects running
  embedded mode (this one included) cannot rely on `bd doctor` at all and need their own
  application-level guard regardless. Worth flagging so upstream understands embedded-mode
  users are currently unprotected by the ENTIRE `bd doctor` safety net, not just this one
  check.
- **This is a report only.** Per the user's explicit direction: do not make Phase A/B/C
  fixes conditional on any of these landing upstream. C4's application-level guard and
  C1's own comma-splitting are the permanent workarounds regardless of upstream's response
  timeline -- doubly so here, since even a prompt upstream fix would not help this repo
  while it stays on embedded mode.

---

## 6. Explicit triage: what NOT to fix right now (requirement #5)

- **Finding #10 (features unclosable when no deploy/integ environment exists):** real, but
  narrow -- only affects projects with no `deploy.md`/`integ-test-playbook.md`, which per
  the audit's own file listing is not this project's current situation (both files exist
  here). Worth a bead for later, not worth blocking this remediation pass.
- **Finding #15 (doer "blocked: missing secret" close leaves blocked work marked done in
  the graph):** genuinely low-frequency (only fires when a doer hits a missing-secret wall
  mid-streak) and the existing behavior (`bd close <id> --reason=...`) is at least
  observable via the reason string. Defer.
- **Finding #17 (`bd show` vs `bd list` JSON dependency-shape divergence):** annoying for a
  human reading raw JSON, but every place this project's OWN code (runner.js) actually
  parses these responses already knows which shape it asked for and handles it correctly;
  the risk is confined to an LLM agent context (reviewer reading `bd show --json` output
  and misinterpreting a parent listed there as a blocker) which the Phase B glossary
  section (3.2) already substantially mitigates by teaching the distinction explicitly.
  Revisit only if a reviewer is observed actually making this mistake in practice.
- **Finding #20 ("enhancement" used as if a real type):** per the user's direction this
  session, **drop from the glossary entirely rather than explain the alias** -- see the
  corrected canonical section in 3.2, which now states plainly "there is no `enhancement`
  type" instead of devoting a glossary entry to an alias that adds confusion for no
  benefit. The per-file prose currently saying "bug (or enhancement)" in
  integ-test-runner.md/planner.md/plan-reviewer.md should still be swept to say "bug or
  feature" while those files are open for Phase B edits, but this is not worth a
  standalone PR of its own -- bundle it into whichever Phase B file-touch happens to hit
  each occurrence.
- **Finding #21 (root-level `agents/*.md` vestigial files):** confirmed dead at runtime;
  the only live risk is the one doc reference in `skills/fleet/SKILL.md:151`'s example
  path. Fixing that one path reference is a 1-line change (swap the example to
  `dist/agents/doer.md` or `packages/apra-fleet-se/apra-pm/agents/doer.md`) and can be bundled with
  whichever Phase B PR is already touching doer.md -- but deleting or updating the stale
  root `agents/*.md` files themselves is out of scope for THIS plan (already tracked as its
  own bead, apra-fleet-xbu.3, and is a separate decision -- keep vs. delete vs. update --
  that doesn't block any of the above).
- **Finding #22, docs-only sub-items (plan.md teaching bare `bd ready`, auto-sprint-diagram.md
  silence on the topic):** cosmetic/documentation drift once the Phase B glossary section
  exists as the actual source of truth; update opportunistically, not urgently. The
  higher-value sub-item (A3, correcting the xbu manifest's stale self-description) is
  already captured in Phase A.

Everything else in the original 22 findings is addressed in Phases A-D above.

---

## 7. Summary dependency graph (all phases)

```
Phase A (live data, do now, no code/prose dependency):
  A1 (0pu cycle) --> A2 (revert any epic-retype; no other live-data change needed --
                          the actual double-dispatch fix is C5, structural, in code)
                  --> A3 (stale description, optional)

Phase B (prose, glossary-first):
  B0 (shared fragment + build mechanism)
    --> B1 (planner.md) --> B2 (plan-reviewer.md)
    --> B3 (doer.md)        [parallel to B1/B2]
    --> B4 (reviewer.md)    [parallel to B1/B2]
    --> B5 (harvester/deployer/ci-watcher glossary refs) [opportunistic, last]
  (B1 also carries C9's tier-vocab fix, same file/PR)

Phase C (code, mostly independent):
  C1 (comma-bug)              -- independent
  C2 (doer scope plumbing)    -- depends on B3 (ship together)
  C3 (integ-test scoping)     -- independent
  C4 (JS cycle-shape guard)   -- independent to build; recommend shipping alongside B1
  C5 (structural has-children exclusion + narrow epic-type backstop; the REAL fix for
      Finding #8's double-dispatch, supersedes the original A2 retype proposal) -- HIGH,
      independent, do EARLY (right after A1) since it's now load-bearing for the current
      live scope, not just a cleanup item
  C6 (viewer badge)           -- independent, lower priority
  C7 (cli.mjs shutdown)       -- independent
  C8 (stale comments)         -- independent, opportunistic

Phase D (upstream): report only, never a blocker for A/B/C.
```

**Recommended execution order for a single team working serially:**
A1 -> A2 (revert retype if applied) -> C5 (structural fix -- promoted earlier in the order
since, per the live retype experiment, it's the only thing that actually resolves Finding
#8 against the CURRENT live scope) -> (B0+B1+C4 together, since they're the actual
root-cause fix for future sprints) -> B2 -> C1 -> C3 -> B3+C2 (together) -> B4 -> C7 -> C6
-> B5/C8/C9 (cleanup pass) -> D1 (file upstream issue, can happen any time after Section
0/0.2's research is in hand -- does not need to wait for anything else).
