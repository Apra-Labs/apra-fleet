# Decision: runSprintCycle's closure prelude stays; the "~700-line runner.js" target is restated

Status: DECIDED. **Option (1) -- KEEP the prelude as composition-root wiring, and
restate the epic's roughly 700-line aspiration for `runner.js`.**

This note records a decision only. **No code was moved, no module was created or
deleted, and no behaviour changed by the task that wrote it.** If a later change
makes the reasoning below false, reopen the question (see "What would reopen
this") rather than quietly extracting.

Scope of the question: `runSprintCycle()` in
`packages/apra-fleet-se/fleet-sprint/runner.js` is a closure. Everything declared
inside it captures the per-cycle context, so slicing it is not the move-only
mechanical operation the twelve `phases/*` extractions were -- it is a design
change about what the per-cycle context IS and who owns it. The prelude here
means everything from the `runSprintCycle` function header down to the FIRST
phase invocation (the `runEnsureSprintBranchPhase` call).

## How the figures below were measured

Anchored by symbol, never by line number: the script locates the header, the
closing brace and the first `run*Phase(` call itself. Run from
`packages/apra-fleet-se`:

```sh
F=fleet-sprint/runner.js
S=$(grep -n '^async function runSprintCycle' $F | cut -d: -f1)
E=$(awk -v s="$S" 'NR>s && /^}/ {print NR; exit}' $F)
P=$(awk -v s="$S" -v e="$E" 'NR>s && NR<e && /await run[A-Za-z]*Phase\(/ {print NR; exit}' $F)
body() { sed -n "$1,$2p" $F; }

echo "runSprintCycle total=$(body $S $E | wc -l)"
echo "prelude total=$(body $S $((P-1)) | wc -l)" \
     "comment=$(body $S $((P-1)) | grep -cE '^\s*(//|/\*|\*)')" \
     "blank=$(body $S $((P-1)) | grep -cE '^\s*$')"
echo "runner.js total=$(wc -l < $F) comment=$(grep -cE '^\s*(//|/\*|\*)' $F)" \
     "imports=$(grep -cE '^import ' $F) exports=$(grep -cE '^export ' $F)"

# named inner closures of runSprintCycle
body $S $E | grep -nE '^    (async )?function [A-Za-z_$]+|^    const [A-Za-z_$]+ = (async )?\(|^    const dispatchCtx = \{' \
  | awk -F: -v s="$S" '{print "  line "($1+s-1)": "$2}'
```

## The measurement (observations at the HEAD this note was written against)

These are observations of one tree, not targets and not literals to assert
against. Re-run the script above before relying on any of them.

```
runSprintCycle  769..2934   total=2166
first phase invocation at 1780:  await runEnsureSprintBranchPhase({
prelude         769..1779   total=1011 comment=630 blank=41
runner.js total=3097 comment=1862 imports=49 exports=28
```

Derived: the prelude is 1011 lines of which **630 are comment lines and 41 are
blank, leaving roughly 340 lines that are actually code**. Across the whole file,
1862 of 3097 lines are comments -- `runner.js` is about 60% prose. The part of
`runSprintCycle` after the first phase invocation is 1155 lines, of which 605 are
comments and 72 blank, leaving roughly 478 code lines. `main()` is 142 lines.

### The named inner closures

Sizes are the declaration's own span. "Captures mutable" lists which of
`runSprintCycle`'s fourteen `let` bindings the body references -- the property
that decides whether a helper can be lifted at all.

| Closure | Lines | Captures per-cycle MUTABLE state | Cycle-scope bindings captured |
|---|---|---|---|
| `agent` | 12 | none | dispatch wrapper over `context.agent` |
| `unmappedRoleFallbackPool` | 12 | none | few |
| `getMemberForRole` | 6 | none | few |
| `getMembersForRole` | 12 | none | few |
| `withGitSync` | 1 | none | alias onto `gitSync.withGitSync` |
| `dispatchCtx` (dispatchRole engine context) | 112 | none | 15 |
| `decomposedParentIds` | 4 | none | 1 (`bdListScoped`) |
| `readyLeafBeads` | 7 | none | 1 (`bdListScoped`) |
| `reclaimStaleInProgress` | 32 | `sprintLaunchTime` | 6 |
| `dispatchReview` | 109 | `cycle` | 8 |
| `reEnsureBranchOnMembers` | 13 | none | 3 |
| `updateDashboard` | 63 | none | 5 |
| `probeFileExists` | 11 | none | 3 |
| `recordReopen` | 3 | none | `reopenCounts` |
| `thrashingBeadIds` | 5 | none | `reopenCounts` |

Summed declaration bodies: **401 lines**; including each one's leading doc
comment block (which would move with it): **537 lines**.

## The decision, and the arithmetic that forces it

**Extracting the prelude cannot deliver the stated goal, so it is not worth its
cost.** If every one of the fourteen closures above were extracted -- the
maximal, most aggressive version of option (2) -- `runner.js` would fall from
3097 lines to roughly **2560**. That is still about 3.6x the roughly 700-line
aspiration, and it is an *over*-estimate of the saving: each extracted helper
must be re-injected at its call sites, which adds lines back. No amount of
prelude extraction reaches ~700. The target was never going to be met this way,
so choosing between "extract" and "keep" on the basis of that number is choosing
between two ways of missing it.

### Why the prelude is composition-root wiring rather than implementation

The concrete, checkable property: **essentially every code-bearing statement in
the prelude either resolves an injectable seam or constructs a collaborator, and
almost none of them compute anything about the sprint.** The dominant shapes are

```js
const X = context.X ?? createX({ ...wiring });   // injectable seam with a default
const { a, b, c } = createY({ ...wiring });      // collaborator construction
```

covering `createSyncBrackets`, `createBeadsScope`, `createSprintState`,
`createMemberSessionGuard`, `createRoundSessionRegistry`, `createKbPrimingClient`,
`createKbWorkClient`, `createGitSync`, the dolt-push mutex, the child-id
allocator, and the `dispatchCtx` engine context. That is the definition of a
composition root: the one place that knows how the object graph is assembled and
is therefore allowed to depend on everything. Pushing it into a "context module"
does not remove the wiring, it renames its file -- and it breaks the one property
a composition root exists to provide, that there is exactly ONE place to look to
see how a sprint is assembled.

The second property: **the prelude is mostly prose.** 630 of its 1011 lines are
comments, and they are not decoration -- they record why each seam has the
precedence order it has (the four-source ladders for the push mutex and the id
allocator), why the `agent` wrapper is the single place `sprint_id` and the
knowledge-bank block are attached, and why the pause guard is registered before
any dispatch can occur. A line count that treats those lines as debt is measuring
the wrong thing; deleting them to hit a number would be a strict loss.

### Why option (2) -- a per-cycle context module -- is rejected

Beyond the arithmetic above: it trades closure capture for parameter passing at
a bad exchange rate. `dispatchCtx` alone captures 15 cycle-scope bindings and
`dispatchReview` captures 8. Converting those to explicit parameters widens every
signature and every call site, and the resulting module would still have to be
constructed from the same wiring, in the same place, in the same order. The
`phases/*` slices were worth their widened signatures because each one removed a
self-contained *phase body* -- a unit with a name in the sprint's vocabulary. A
"per-cycle context" module is not such a unit; it is the composition root with an
extra import hop.

### Why option (3) -- extract only the non-capturing subset -- is rejected

The measurement makes option (3) look more attractive than it is: only two of the
fourteen closures capture mutable state (`reclaimStaleInProgress` ->
`sprintLaunchTime`, `dispatchReview` -> `cycle`), so a naive reading says the
other twelve are liftable. But mutable capture is not the real cost -- immutable
capture is. The twelve non-mutating closures still capture between 1 and 15
cycle-scope bindings each, and the two largest (`dispatchCtx` at 112 lines,
`updateDashboard` at 63) are among the heaviest capturers. What is left after
excluding them is genuinely tiny: `decomposedParentIds` (4 lines),
`readyLeafBeads` (7), `recordReopen` (3), `thrashingBeadIds` (5),
`getMemberForRole` (6) -- roughly 25 lines of body. Creating a module to hold
25 lines of one-liners, each of which then needs to be threaded back in, makes
the codebase harder to read to save nothing. Option (3) is a real option; it is
rejected on measured size, not on principle.

`dispatchReview` deserves a specific note because it is the largest genuinely
shared helper. It is injected into `phases/review.mjs` and `phases/re-review.mjs`
(both name it in their "WHY SOME HELPERS ARE INJECTED RATHER THAN IMPORTED"
headers). Being shared by two phases is exactly why it sits at cycle scope rather
than in either phase module, and it captures `cycle`, so it is the single worst
candidate for a mechanical lift.

## The roughly 700-line target is restated

The `~700-line` figure originated in the Phase 0 epic description, derived
against a tree where `phases/*` did not exist and `runner.js` was 11,678 lines.
It was an aspiration attached to an estimate, never a computed budget, and the
work since has shown it is unreachable: the composition root plus the facade plus
their documentation costs more than 700 lines on their own, and the floor
computed above puts even a maximal extraction at roughly 2560.

**Stop quoting ~700.** It is replaced by two properties that are already
mechanically enforced, and which say what the refactor was actually for:

1. **`runner.js` hosts no phase body.** Pinned by
   `test/phase-sequence-order.test.mjs`, which asserts a zero-match shape scan
   over `runner.js` with a `>= 12` count across `phases/*` as its non-vacuity
   control.
2. **`runner.js` is a complete facade.** Every previously-exported symbol is
   still importable from it, so no importer or mock-sprint file changes.

Size becomes an *observation* reported alongside those gates, not a gate itself.
For context, `runner.js` at 3097 lines is not an outlier in its own package:
`dolt-sync.mjs` is 2325, and `dolt-settle.mjs`, `role-policies.mjs`,
`contracts.mjs`, `dispatch-role.mjs` and `vcs-auth.mjs` are all around 1000+.

## What would reopen this

Any one of these makes the reasoning above false and the question worth asking
again:

- A **third** consumer appears for `dispatchReview`, or `dispatchReview` stops
  capturing `cycle`. It would then be a shared service rather than cycle-scoped
  glue, and `phases/`-adjacent placement becomes defensible.
- The prelude starts doing **sprint computation** rather than wiring -- i.e. new
  statements that are not `context.X ?? createX(...)`-shaped and that derive
  decisions about beads, members or scheduling. That is implementation, and it
  belongs in a module.
- `updateDashboard` or `probeFileExists` grows materially, or acquires a second
  caller outside `runSprintCycle`.
- The comment-to-code ratio inverts: if the prelude's code lines exceed its
  comment lines, the "it is mostly prose" argument no longer holds and the raw
  code size should be re-weighed.

## Correction to an inherited claim

The planning note for this decision stated that "Review, Re-Review and Final
Review all share `dispatchReview`". **That is not true at this HEAD.** Only
`phases/review.mjs` and `phases/re-review.mjs` receive it;
`phases/final-review.mjs` merely cites it in a comment ("No duplicate log() dump
-- see dispatchReview() for why") and runs its own dispatch. The conclusion is
unaffected -- two sharers is still more than one, which is still the reason the
helper is cycle-scoped -- but the count is two, not three.
