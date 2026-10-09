# KB Trust Model

The Knowledge Bank assigns every entry a confidence level. Trust is a one-way
ladder, and only one tool can move an entry up it.

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

## Forward-only enforcement (no migration)

The gate is forward-looking. The KB may contain historical entries that were written
directly at CONFIRMED before the gate existed; these are NOT rewritten or migrated.
Enforcement applies only to captures made from the gate onward.

## Exceptions and low-trust paths

- user-directive: a standing instruction the user gives during a
  sprint ("always do X", "never do Y", "we decided Z"). This is the single entry
  type captured at CONFIRMED directly -- the sole exemption from the clamp.
- Auto-harvest: entries produced by the kb_harvest autowire are regex-extracted
  from session transcripts, unreviewed, and always captured at UNVERIFIED. Harvest
  can never mint CONFIRMED -- the same gate covers it.

## The kb_maintainer grant protects CONFIRMED entries from member sessions

A member session (one without the kb_maintainer grant) can neither mint nor
retire CONFIRMED entries:

- `kb_reconcile_prefilter` is a maintainer-only tool (it sits in the maintainer
  tool set of the member tool allowlist), and the reconciler tag profile grants
  no write tools.
- `kb_import` with an explicit `path` other than the session's own bible is
  refused with `E-KB-MAINTAINER-REQUIRED` unless the session holds the grant.
- `kb_invalidate` (by `ids` or by `files`) keeps CONFIRMED entries live and
  reports them in `refused`; the underlying provider `discard` and `invalidate`
  take a keep-CONFIRMED flag, so the guarantee holds below the tool layer.
- `kb_capture` with `supersedes` never retires a CONFIRMED target (whoever
  owns it): the capture links to it (`refines`, both live) and lists it in
  `refused`. A non-CONFIRMED target is still retired. Over a remote KB
  provider the grant cannot be conveyed, so `supersedes` is dropped entirely.
- `kb_import` with no path, or with the own path, reads the bible as committed
  at `HEAD`, never the member-writable work-tree file; with no committed copy
  it imports nothing (`E-KB-MAINTAINER-REQUIRED`).

### Remaining exposure

A member that can commit can still put a hand-made bible at `HEAD` and import
it. That change is visible in the branch history and the PR diff, which is the
review the bible channel relies on.
