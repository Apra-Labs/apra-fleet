# Bible reconcile, 2026-08-21

A `/pm kb-reconcile` run of the ladder in
[kb-reconcile-architecture.md](kb-reconcile-architecture.md) against merged
`main`. `.fleet/kb-canonical.json` went from **36 entries to 24**. This file
records the disposition of every drop; the pre-reconcile file remains in git
history at `08ad5f15`.

Companion to [kb-bible-rebuild-2026-08-04.md](kb-bible-rebuild-2026-08-04.md),
which rebuilt the bible from scratch. This pass did not rebuild -- it ran the
reconcile ladder and applied the same verification gate to what came out.

## Why a reconcile was due

The bible's own provenance recorded
`commit aef342816f5c232202c0679e98dc814f11e0076f`, branch
`chore/persistent-memory-disambiguation-rule`. **That commit does not exist in
this repository.** The branch was squashed away, so the bible on `main` recorded
a basis nobody could check. The v2 envelope exists precisely to make that
checkable, and it was pointing at nothing.

Verification also turned up **two CONFIRMED entries that contradict each other**,
the same failure the 2026-08-04 rebuild was written to correct:

- `256b2dc0` said 15 of the 16 `src/tools/kb-*.ts` tools spread
  `...kbScopeFields`; `70077fb7` said only 3 of ~16 did. Main has 15 (only
  `kb-setup` is excluded, by design), so `70077fb7` was retired.

## The mass-stale trap, and why the sweep did not decide this pass

Simulating `freshnessSweep` against `main` before touching anything showed only
**10 of 61** live entries still had a matching hash basis. A by-the-book ladder
run would therefore have exported a bible of ~10 and read as mass knowledge
deletion.

Most of those 51 were not false. `.gitignore`, `.claude/settings.json` and
`deploy.md` had merely *changed content* since capture, and
`src/services/knowledge/repo-config.ts` is branch-only, unmerged. Hash staleness
means "re-verify", not "wrong" -- but `kb_export` treats stale as retired, so the
two collapse into the same outcome unless a human intervenes.

So the sweep ran (its verdict is honest and worth having), but it was not allowed
to be the arbiter. Every entry it staled was read against main's source by hand,
and the ones that survived that reading were re-captured onto a main-based basis
rather than left to rot.

## Method

**Step 1, `kb_import` with `skip_sweep`.** Absorbed the merged bible:
`{imported: 7, skipped: 19, linked: 9, flagged: 1, rejected: 0}`. The 7 were
entries present only in the bible (they came from another machine's KB via the
global-bible chain). The 9 "linked" were bible copies of live entries that AUDN
admitted as refinements -- note these were **re-hashed against main at capture
time**, which is why they survived the later sweep while their originals did not.

**Step 2, `kb_freshness_sweep`.** `{checked: 100, staled: 49, unstaled: 0}`.

**Step 3, `kb_reconcile_prefilter`.** `{pairs: 6, resolved: 0, left_for_agent: 6}`.
Zero mechanical wins, exactly as the simulation predicted: with almost no basis
matching main, the hashes could not settle anything.

**Step 4, arbitration by hand.** Each pair was decided by reading the merged
source, then written through `kb_resolve_contradiction`. Two pairs were left
flagged (below).

**Step 5, verification gate.** Every entry that would ship was read against the
file it cites. Three were found false and two structurally duplicated. Survivors
whose claim held but whose basis had drifted were re-captured via `kb_capture`
(clamped to INFERRED) and earned CONFIRMED through `kb_promote` with the
verification recorded in the promote note -- the same gate the 2026-08-04 rebuild
used.

**Step 6, `kb_export`.** 24 entries, auto-committed as `pm-kb`.

## Contradictions resolved (7)

| Winner | Loser | Arbitrated by |
|---|---|---|
| `0fb5edbf` | `cada27c9` | `project-slug.ts:5-8` -- `remoteUrl` short-circuits before any git shell-out; the loser described the shell-out as the sole mechanism |
| `857d775e` | `155fbca9` | `check-sandbox-sync-remote.mjs:375-377` maps literal `null` to `[]`; the loser said the branch was absent |
| `89906789` | `5062c062` | Four `resolveRepoPath` helpers exist, not three; the loser omits `kb-import` |
| `494a1ec0` | `a640a45f` | Not a real contradiction -- `a640a45f` was a byte-identical row this run's own import created. AUDN's `hasOppositePolarity` fired on the entry's own phrase "not a vacuous test" |
| `0e10e4ea` | `10e15056` | `src/types.ts:4` + `src/providers/index.ts:10-17` register **six** adapters; the loser claimed seven including a `gemini` that does not exist |
| `4406ee08` | `d1d891d8` | `check-sandbox-sync-remote.test.ts:461-463` now branches on bd availability, closing the vacuous-pass hole the loser reports as open |
| `96a63862` | `ec8b983b` | Same rule, corrected basis: `knownRepoRemoteUrl` moved to `src/services/member-remote-url.ts`; `execute-prompt.ts:253` only re-exports it |

## Contradictions deliberately left flagged (2)

The design's tiebreak says an undecidable pair stays flagged for `/pm kb-review`
rather than being forced. Both of these are undecidable *on main*:

- `f100e93f` vs `5a621658` -- **not actually a contradiction**. Both claims are
  true on main: the confidence clamp really is enforced in
  `SqliteProvider.capture` (`sqlite-provider.ts:889`), and capture really does
  fail closed for a remote work folder, because `assertCheckableBasis` resolves
  `source_files` against `this.repoPath` without consulting `anchorIsMissing()`.
  AUDN paired them on polarity alone. Forcing a winner would supersede a true
  claim.
- `31acc2d6` vs `40132768` -- the code is **silent**:
  `src/services/knowledge/repo-config.ts` does not exist on main. Resolving
  would mint a CONFIRMED, non-stale entry citing a file that is not there,
  because `resolveContradiction` clears stale but never sets it.

## Judgment drops (verified false on main)

Each of these cites files that still exist, so no mechanical rule would have
caught them. Each was read against the current source.

- `70077fb7` + `feb51d86` "only 3 of ~16 kb_* tools spread `repo_remote_url`" --
  15 of 16 do. `70077fb7` is the more dangerous of the two: it is an **import
  copy re-based onto main's hashes**, so it looked fresh while carrying a
  pre-fix claim. The trusted-channel import keeps bible confidence, and a fresh
  basis makes a false entry unfalsifiable by sweep.
- `10e15056` "seven LLM providers ... gemini" -- six, and no `gemini.ts` exists.
- `735f21d3` `{{secure.NAME}}` -- describes real behaviour but cites
  `resolveSecurePlaceholders`, a symbol that appears **nowhere in `src/`**.
- `40b95472` "the provider cache is still keyed by slug alone" -- `kb-providers.ts:88`
  keys on `providerKey(slug, repoPath)`. Directly contradicted two entries that
  are in the bible.
- `0b2b63b1` "kb_export auto-commit is opt-in and defaults to off" --
  `kb-export.ts` records `USER DIRECTIVE 2026-08-11: the default is TRUE`. This
  entry preserved the setting that directive reversed.
- `a2a0e499` "this repo's tracked settings.json now encodes the `--hook-json`
  split" -- `.claude/settings.json` uses plain `bd prime` for both SessionStart
  and PreCompact, and has no `permissions` block at all.
- `229c96ee` + `d1d891d8` embeddeddolt vacuous pass -- closed on main.

## Point-in-time sprint narration (dropped)

Entries that record what happened during one sprint rather than what is true of
the code:

- `494a1ec0` "mutation test confirms b4g.2.2 pins the b4g.2.1 fix" -- records
  that one sprint's mutation check found one test non-vacuous. It also cites
  bead ids in LLM-facing text, which `CLAUDE.md` forbids. The durable claim
  underneath it (`130bc73b`) is in the bible.
- `254b18e2` "passes on both pre-fix and post-fix trees" -- a verdict about a
  tree that no longer exists, carrying no claim about main.

## Structural duplicates (dropped)

Created by this run's own import, which AUDN admitted as refinements rather than
deduping (AUDN needs symbol AND file overlap; these differed in neither, but
arrived under new ids):

- `6ef4939d` -- byte-identical to `f92f896f`
- `17f8a922` -- byte-identical to `c2d3fa00`
- `c9047868`, `eb1611af`, `857d775e` -- three rows for one `parseDoltRemoteList`
  fact, consolidated into `1be49eaa`

## Consolidations (re-captured against main)

Five entries about the same `sprint-logs/` hazard were folded into `22e52be3`,
which also records that **`.gitignore` now carries the prohibition inline** --
so the lesson no longer depends on the KB to survive: `1ae4ce00`, `66075242`,
`daf6fb22`, `bd281bfb`, `b368ad28`.

## Dormant, not dropped: knowledge that needs the branch to land

`fix/codeintel-optout-and-kb-repo-scope` is **13 commits unmerged**. Entries
about it cite files absent from main (`src/services/knowledge/repo-config.ts`,
`tests/knowledge/kb-session-prime-repo-optout.test.ts`) and are stale, not
retired: `7df80206`, `f9f941be`, `31acc2d6`, `7b37d64d`, `27b1f487`, `e23e8d4e`.

**They will not revive by themselves.** `freshnessRevivable` needs a FULL basis
match, and these bases were hashed on the branch. When that branch merges, run
the ladder again; the entries need re-capture, not just a sweep.

The same caveat applies to entries staled by ordinary churn and not re-captured
in this pass -- among them `0633ac36`, `2ff14a5c`, `62a26c94`, `696d42bc`,
`c996a17a`. Their claims were not judged false; they were not individually
re-verified, and promoting an unread claim is the failure this gate exists to
prevent.

## Note for whoever runs this next

`kb_feedback` is a **permanent** retirement, not a pause: the `[feedback ...]`
content marker is a durable exclusion from `freshnessRevivable`, so a downvoted
entry never revives. Use it only for "wrong or valueless forever". For knowledge
that is merely branch-only, let the sweep stale it and leave it alone.
