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
("[confidence clamped: CONFIRMED requires kb_promote]").

## kb_promote is the sole path to CONFIRMED

kb_promote is the only way an entry reaches CONFIRMED. It requires an entry id and
a reason (appended to the content as an evidence trail) and steps the entry up one
rung: UNVERIFIED -> INFERRED, or INFERRED -> CONFIRMED. The workflow is therefore:
capture at INFERRED, then promote to CONFIRMED after the reviewer approves.

## Forward-only enforcement (no migration)

The gate is forward-looking. The KB contains historical entries that were written
directly at CONFIRMED before the gate existed; these are NOT rewritten or migrated.
Enforcement applies only to captures made from the gate onward.

## Exceptions and low-trust paths

- user-directive (D6, Phase 3): a standing instruction the user gives during a
  sprint ("always do X", "never do Y", "we decided Z"). This is the single entry
  type captured at CONFIRMED directly -- the sole exemption from the clamp. It is
  implemented in Phase 3.
- Auto-harvest: entries produced by the kb_harvest autowire are regex-extracted
  from session transcripts, unreviewed, and always captured at UNVERIFIED. Harvest
  can never mint CONFIRMED -- the same gate covers it.
