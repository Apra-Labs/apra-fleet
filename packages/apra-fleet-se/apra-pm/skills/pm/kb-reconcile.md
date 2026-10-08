# /pm kb-reconcile

Reconcile a warm local KB against a merged bible after two or more branches
land -- absorb the incoming knowledge, revive entries whose basis matches
the merged worktree again, mechanically settle contradictions a file hash
can decide, and dispatch a reconciler agent for the rest. Ends with the
canonical bible re-exported: confirmed entries whose cited files still match
their hash basis are added, so the merged branch's bible gains the merged truth.

## When to run

- After merging branches (including this sprint's own PR merging into its
  base) -- as a standalone command, or as the post-merge hook inside
  `/pm cleanup` (see SKILL.md's completion flow).
- Any time a local KB needs to catch up with a `.fleet/kb-canonical.json`
  bible produced elsewhere (a teammate's branch, a different worktree) --
  whether or not a formal merge just happened.
- Periodically, alongside `/pm kb-review`, as KB hygiene.

## Trust boundary (state honestly, do not skip)

Step 1 (`kb_import`) reads a bible file. Importing the repo-resolved
`.fleet/kb-canonical.json` is the git-reviewed, human-merged trusted channel
-- non-directive entries there keep their bible confidence. An explicit
`--path` bible is CALLER-ASSERTED trust: equivalent in power to the
already-exposed `kb_promote` surface (which can walk any entry
`INFERRED -> CONFIRMED` one call at a time), not a new privilege class.
`type: 'user-directive'` entries are quarantined to pending proposals either
way -- a bible can never smuggle an active directive; activation stays
CLI-only (`apra-fleet kb approve-directive`).

## Steps

### Step 1: Import the merged bible

```
kb_import({ path: "<merged worktree path>/.fleet/kb-canonical.json" })
```

or the CLI equivalent, `apra-fleet kb import --path <file>`, for a human
running this post-merge by hand. `path` names the bible FILE only: kb tools
take no repo/scope argument and always write the calling session's own KB (a
member session uses its registered work folder; any other session the fleet
server's working folder). Omitting `path` resolves
`<own folder>/.fleet/kb-canonical.json` (the trusted channel); a bible from
anywhere else is caller-asserted trust (see above).

Report: `{ imported, skipped, linked, flagged, sweep }`. `kb_import`
already runs a freshness sweep internally at the end of its own run, scoped
to the imported entries' impact -- Step 2 below is still worth running
explicitly (see its note).

### Step 2: Freshness sweep

```
kb_freshness_sweep()
```

Re-hashes EVERY entry in the KB that carries a stored basis against the
CURRENT (merged) worktree -- not just the entries `kb_import` just touched.
Un-stales matches (the D2 predicate still excludes superseded, downvoted, and
invalidated entries from revival), stales mismatches. This is what actually
performs branch-switch revival: `kb_session_prime`'s candidate set excludes
stale entries by definition, so priming alone can never revive anything.

Idempotent, and worth running explicitly even right after `kb_import` (whose
internal sweep covers the same ground) because it also covers the
reconcile-WITHOUT-import path -- e.g. re-running `/pm kb-reconcile` after
just switching worktree state with no new bible to import.

No sweep is needed AFTER Step 3 or Step 4 below: `kb_resolve_contradiction`
sets each winner's final stale state itself, including the predicate-guarded
un-stale check, as part of resolving the pair (hardened D4) -- a
post-resolution sweep would be redundant.

### Step 3: Hash prefilter

```
kb_reconcile_prefilter()
```

For every remaining flagged contradiction pair (`flaggedPairs()` -- this
INCLUDES stale members; the imported side of a pair is typically stale
right after Step 1/2, and that is exactly the case this step exists to
resolve), re-hashes both sides' full source-file bases against the CURRENT
worktree. Exactly one side fully matching wins mechanically, via the same
`kb_resolve_contradiction` write path the reconciler agent uses (evidence:
`"hash-basis match on merged worktree"`). Pairs where both sides match, both
mismatch, either has an empty/missing basis, or either side is an ACTIVE
user-directive are left untouched for Step 4.

Report: `{ pairs, resolved, left_for_agent, skipped_directive }`.

### Step 4: Reconciler agent

If `left_for_agent` is non-empty, dispatch the `kb-reconciler` agent
(`agents/kb-reconciler.md`, model tier cheap/standard)
with that array, as a subagent of THIS session -- never on a fleet member: a
member session is not served `kb_resolve_contradiction` or `kb_export`, so the
agent would stop at its tool check. It reads the MERGED code via `code_context`/`code_impact`/
`code_query` (never Glob/Grep) for each remaining pair, resolves what the
code decides via `kb_resolve_contradiction`, falls back to a trust-tier
tiebreak (`CONFIRMED > INFERRED > UNVERIFIED`) when the code is silent, and
leaves genuinely undecidable pairs flagged for `/pm kb-review`. Any `kb_query`/`kb_list` lookup of a pair's entries must pass an explicit `confidence: ["CONFIRMED", "INFERRED", "UNVERIFIED"]` list: the read tools default to CONFIRMED undisputed entries only, and a disputed or unpromoted side would otherwise be invisible (`kb_query({ flagged_only: true })` is exempt). Active
user-directives are NEVER auto-retired. See `agents/kb-reconciler.md` for the
full process and the single-write-path rule.

If `left_for_agent` is empty, skip straight to Step 5.

### Step 5: Export

```
kb_export()
```

ADDS to `.fleet/kb-canonical.json` every live `CONFIRMED` project entry not
already in it whose cited files still match its recorded hash basis -- which
includes the mechanical and agent-resolved winners -- and auto-commits it
(pathspec-only, identity `pm-kb`, non-fatal on any git failure). This is
existing `kb_export` machinery; no new commit step is needed here. Push is
not automatic; it rides the normal sprint push cadence.

The export never removes or rewrites an entry already in the bible: a
superseded loser, or an entry later retired, stays there after re-export and
must be removed by hand.

## Report

After all steps:

```
/pm kb-reconcile complete.
Import:     imported=<n> skipped=<n> linked=<n> flagged=<n>
Sweep:      checked=<n> staled=<n> unstaled=<n>
Prefilter:  pairs=<n> resolved=<n> left_for_agent=<n> skipped_directive=<n>
Reconciler: codeDecided=<n> tierDecided=<n> deferred=<n>  (omitted if Step 4 was skipped)
Export:     exported=<n> committed=<true|false>
```

Any `deferred` pairs from the reconciler, and any pair `kb_reconcile_prefilter`
skipped for an active directive, are handled the same way as any other
flagged entry going forward: surface them next time `/pm kb-review` runs.
