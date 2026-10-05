# KB Trust Model

The Knowledge Bank assigns every entry a confidence level. Trust is a two-way
ladder: one tool moves an entry up it, and a separate tool moves an entry back
down when it turns out to be less certain than recorded.

## The trust ladder

```
UNVERIFIED  ->  INFERRED  ->  CONFIRMED
```

- UNVERIFIED -- extracted but not checked (e.g. auto-harvested from a transcript,
  or a raw session insight). Lowest trust.
- INFERRED -- verified by reading source, or captured deliberately by an agent.
  This is the default and the ceiling for kb_capture.
- CONFIRMED -- the reviewer approved the code the entry describes. Highest trust.

## kb_capture caps at INFERRED

kb_capture clamps any incoming confidence to a maximum of INFERRED. UNVERIFIED and
INFERRED pass through unchanged; a CONFIRMED passed to kb_capture is downgraded to
INFERRED. The clamp is enforced at two layers so no caller can bypass it: the
kb_capture tool handler (which surfaces the user-facing flag) AND
SqliteProvider.capture(), the choke point the HTTP route also passes through.
The downgrade is never silent: the result carries `confidence_clamped: true`
and a short note is appended to the entry content
("[confidence clamped: CONFIRMED requires kb_promote]"). The flag is derived
from stored-vs-requested confidence, so a user-directive -- stored UNVERIFIED
as a pending proposal -- also reports `confidence_clamped: true` (without the
note, since kb_promote is not its remedy).

## kb_promote is the sole path to CONFIRMED

kb_promote is the only way an entry reaches CONFIRMED. It requires an entry id and
a reason (appended to the content as an evidence trail) and steps the entry up one
rung: UNVERIFIED -> INFERRED, or INFERRED -> CONFIRMED. The workflow is therefore:
capture at INFERRED, then promote to CONFIRMED after the reviewer approves.

## kb_demote is the down rung

kb_demote moves an entry down one rung: CONFIRMED -> INFERRED, or INFERRED ->
UNVERIFIED. UNVERIFIED is the floor -- demoting an already-UNVERIFIED entry is
a no-op (before == after, nothing written, not even a timestamp). This is the
"I am now LESS certain about this" path, not the "this claim is wrong" path:
a claim that turns out to be false goes through `kb_feedback` (a durable
downvote) or `kb_resolve_contradiction`, never `kb_demote`, and never
`kb_invalidate` (which only marks a file's context-cache rows stale and has no
confidence semantics at all).

kb_demote requires:

- `id` -- the entry to demote.
- `reason` -- why the entry is now less certain, at least 20 trimmed
  characters, stating what you checked. A trivial reason is refused.
- `evidence_files` -- optional. Omit it or send `[]` when the demotion has
  nothing new to cite (e.g. "the basis simply vanished"). When files ARE
  given, each one is checked by the same resolver kb_promote uses for its
  basis check: a path that does not resolve, or that tries to traverse
  outside the repo, is refused.

Every refusal is checked before any write, so a refused demote leaves the
entry byte-identical:

- Entry not found.
- The entry was superseded.
- The entry is a `user-directive`. Directive state is human-terminal only --
  demoting one through this tool would deactivate it through a side door, so
  the whole type is refused. Discard a directive with the CLI's
  `reject-directive <id>` instead.
- `reason` is missing or too short.
- An `evidence_files` entry does not resolve, or traverses outside the repo.

On success, the entry's confidence steps down one rung, a `[Demoted: ...]`
note is appended to its content, and a snapshot of its current basis
(source-file hashes) is stored alongside the demotion timestamp.

**D6 re-offer rule.** A demoted entry is not re-offered for promotion on the
very next round with nothing having changed -- that would make demote/promote
ping-pong forever. It becomes a promotion candidate again only once its basis
has changed since the demotion: at least one of the files it cites now hashes
differently from the snapshot taken at demote time.

**Bible safety.** Two places treat a locally demoted entry specially so a
demotion is never invisible:

- Cold-seeding a session from the committed bible (`.fleet/kb-canonical.json`)
  skips any bible entry whose id has a local row that was demoted and still
  sits below CONFIRMED. Without this, a bible entry defaults to CONFIRMED
  seeding and would keep re-injecting a doubted claim into every session
  regardless of the local demotion.
- Exporting the bible normally refuses to auto-commit a SHRINK (fewer entries
  than the bible it is replacing) -- that shrink is written to disk but left
  as an uncommitted diff for a human to review. The one exception is a
  demotion-only shrink: if every id that disappeared from the bible was
  explicitly demoted locally (not merely stale, not merely missing), the
  export auto-commits the shrink as the intentional outcome of kb_demote
  that it is.

## Forward-only enforcement (no migration)

The gate is forward-looking. The KB may contain historical entries that were written
directly at CONFIRMED before the gate existed; these are NOT rewritten or migrated.
Enforcement applies only to captures made from the gate onward.

## Exceptions and low-trust paths

- user-directive: a standing instruction the user gives during a
  sprint ("always do X", "never do Y", "we decided Z"). Capturing one does NOT
  mint CONFIRMED directly: it is stored as a PENDING PROPOSAL at UNVERIFIED,
  flagged for review. It gains no trust semantics and is not an active
  directive until a human approves it from their own terminal via
  `apra-fleet kb approve-directive <id>` (or discards it with
  `reject-directive <id>`) -- MCP cannot mint or demote an active directive by
  itself, which is why both kb_promote and kb_demote refuse any
  `user-directive` entry outright.
- Auto-harvest: entries produced by the kb_harvest autowire are regex-extracted
  from session transcripts, unreviewed, and always captured at UNVERIFIED. Harvest
  can never mint CONFIRMED -- the same gate covers it.

## When to demote versus feedback versus resolve

These three tools all react to a KB entry you no longer fully trust, but they
answer different questions and are not interchangeable:

- **Less certain, not necessarily wrong** -> `kb_demote`. You checked
  something and the entry's claim is shakier than its current confidence
  implies (e.g. its cited basis has drifted, or you could not re-confirm it
  the way the previous confidence level implies). This steps the entry down
  one rung; it does not flag it stale or contradicted.
- **Proven wrong** -> `kb_feedback` (a durable downvote) or
  `kb_resolve_contradiction` (when a new finding directly contradicts an
  existing entry). These record that the claim is false and route it to
  review; they do not merely lower confidence.
- **Never** `kb_invalidate` for either case -- it only marks a file's
  context-cache rows stale on a file-content change and carries no confidence
  or correctness judgment at all.

## Demotion inside the sprint reviewer loop

The rules above are the tool contract. For how the fleet-sprint engine sources
demotion candidates for a reviewer, bounds those reads so they cannot grow
with KB size, guards against a demote/promote ping-pong (D6) and a same-round
promote/demote collision on one id, and why that vetting logic is
deliberately triplicated across three runtimes, see
[kb-demote-sprint-wiring.md](kb-demote-sprint-wiring.md).
