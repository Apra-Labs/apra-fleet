# /pm kb-review

Surface all contradiction-flagged KB entries and resolve them interactively.

Note: `/pm kb-review` also surfaces pending `user-directive` proposals (via
`kb_query({ flagged_only: true })`) and instructs the human to run
`apra-fleet kb approve-directive <id>` or `reject-directive <id>` -- these are
CLI-only resolutions, never `kb_promote`.

## When to run

- After any sprint completes, as part of KB hygiene.
- When an agent reports a `flagged` audn_decision from `kb_capture`.
- Periodically, to keep the KB free of unresolved contradictions.

## Steps

### Step 1: Fetch flagged entries

Call `kb_query(flagged_only=true)`.

- If the response says "No flagged contradictions found -- KB is clean.", report that to the user and stop.
- Otherwise, collect all returned entries.

### Step 2: Group into contradiction pairs

For each entry with `contradiction_of` set, pair it with the entry whose `id` matches `contradiction_of`.
Entries with `flagged_for_review=true` and no `contradiction_of` are the original (challenged) entries.

Group: `{ original: entry_A, challenger: entry_B }` where `entry_B.contradiction_of = entry_A.id`.

### Step 3: Present each pair to the user

For each pair, show:

```
Contradiction pair (N of M):

[ORIGINAL]  id: <id>  confidence: <confidence>  created: <created_at>
Title:   <title>
Summary: <summary>
Content: <content>

[CHALLENGER]  id: <id>  confidence: <confidence>  created: <created_at>
Title:   <title>
Summary: <summary>
Content: <content>

Resolution options:
  A - Keep original, discard challenger
  B - Keep challenger, discard original
  M - Merge both into a new entry (you provide merged content)
  D - Delete both (neither is correct)
  S - Skip (defer to later)
```

Wait for the user's response before proceeding to the next pair.

### Step 4: Apply resolution

Supersede is OPT-IN: you must name the entry you are retiring via
`supersedes=<id>`. It is honored only when AUDN independently matches that same
entry (same type, overlapping symbols and source_files), so the corrective
capture must still carry the SAME title/symbols/source_files as its target --
otherwise nothing is retired and you get a second live entry instead. A capture
without `supersedes` never retires anything.

**A -- Keep original:**
- `kb_promote(original.id, reason="contradiction resolved: original kept")` -- upgrades its confidence.
- `kb_capture` a new entry with the SAME title/symbols/source_files as the challenger, corrected content that carries no contradiction keyword or polarity word (or AUDN will flag it again instead of updating), `confidence=UNVERIFIED`, and `supersedes=<challenger.id>`. That retires the challenger.

**B -- Keep challenger:**
- `kb_promote(challenger.id, reason="contradiction resolved: challenger kept")`.
- `kb_capture` a corrected entry with the SAME title/symbols/source_files as the original, corrected content free of contradiction/polarity words, and `supersedes=<original.id>`. That retires the original.

**M -- Merge:**
- Ask the user to provide the merged content.
- `kb_capture` a new entry with merged content and `supersedes=<id of whichever entry it replaces>`. Repeat for the second entry if both must be retired -- `supersedes` names ONE entry, so retiring both takes two captures.
- `kb_promote` the newly captured entry id.

**D -- Delete both:**
- `kb_capture` a retraction entry: `title=<original title>`, `content="Retracted: both entries were incorrect."`, `confidence=UNVERIFIED`, `supersedes=<original.id>`.
- `kb_capture` same for the challenger, with `supersedes=<challenger.id>`.

**S -- Skip:**
- No action. Note it in the session summary.

**Verified actual behavior (T3.7, F11 e2e proof) -- read this before reporting "resolved":**
- Superseding an entry (via the corrective `kb_capture` above with `supersedes` set, AUDN decision `update`) sets its `superseded_at` and `stale=1`. That entry then drops out of every future `kb_query({flagged_only:true})` listing -- the tool always excludes superseded entries.
- `kb_promote` does **NOT** clear `flagged_for_review` and does **NOT** clear `contradiction_of`. This means the entry you KEPT (promoted, not superseded) stays visible in `kb_query({flagged_only:true})` forever -- it is not automatically delisted just because it was resolved. Do not expect the pair to fully disappear from the flagged list; expect only the superseded side to disappear. Recognize an already-resolved pair by its counterpart's absence (or by checking `promoted_at`/`confidence` on the id you kept), not by the pair vanishing entirely.
- A `kb_feedback`-downvoted entry (`stale=1` + `flagged_for_review=1`, never superseded) stays listed under `flagged_only` until it is separately resolved the same way -- superseded via a corrective capture, or otherwise retired. Simply promoting a *different* entry never clears it.

### Step 5: Report

After all pairs are processed, report:

```
KB Review complete.
- Pairs resolved: N
- Pairs skipped: M
- Total flagged entries cleared: K
```

"Cleared" here means the SUPERSEDED side of each resolved pair (the one whose
`superseded_at` got set) -- per the verified behavior in Step 4, the kept/
promoted side of a resolved pair remains in `kb_query({flagged_only:true})`
indefinitely, so K is normally N, not 2N. Do not report a pair as fully gone
from the flagged list; report it as resolved (one side superseded, the other
promoted).
