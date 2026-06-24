# /pm kb-review

Surface all contradiction-flagged KB entries and resolve them interactively.

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

**A -- Keep original:**
- `kb_promote(original.id, reason="contradiction resolved: original kept")` -- upgrades its confidence.
- `kb_capture` a new entry with `title=challenger.title`, `content="Superseded: see <original.id>"`, `confidence=UNVERIFIED`. AUDN will update the challenger.

**B -- Keep challenger:**
- `kb_promote(challenger.id, reason="contradiction resolved: challenger kept")`.
- `kb_capture` a corrected entry that supersedes the original (same title, corrected content, higher confidence). AUDN updates the original.

**M -- Merge:**
- Ask the user to provide the merged content.
- `kb_capture` a new entry with merged content. AUDN supersedes whichever entry has the closest title match.
- `kb_promote` the newly captured entry id.

**D -- Delete both:**
- `kb_capture` a retraction entry: `title=<original title>`, `content="Retracted: both entries were incorrect."`, `confidence=UNVERIFIED`. AUDN supersedes the original.
- `kb_capture` same for the challenger.

**S -- Skip:**
- No action. Note it in the session summary.

### Step 5: Report

After all pairs are processed, report:

```
KB Review complete.
- Pairs resolved: N
- Pairs skipped: M
- Total flagged entries cleared: K
```
