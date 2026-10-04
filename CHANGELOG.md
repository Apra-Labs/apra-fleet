# Changelog

## Unreleased

### Fixed - kb_export project scope no longer churns the team bible

`kb_export` (project scope) previously rewrote `.fleet/kb-canonical.json` from the
local database, so a branch could ship entries whose cited files had changed (or
never existed on that branch) and could drop curated entries. Project export now:

- admits an entry only if it is CONFIRMED, cites at least one file, and every cited
  file has a recorded per-file hash that equals the file's current hash (a missing
  file counts as a mismatch);
- merges additively: existing bible entries are kept as-is, the existing entry wins
  on an id clash, and when nothing new qualifies nothing is written or committed.

Global scope is unchanged. Bible format and request/response schemas are unchanged;
only tool description text moved (registry, contract generator, MCP binding,
INVENTORY). Side effect: the reconcile flow can no longer remove a superseded loser
or pending directive from the bible via export (documented in the knowledge-layer and
kb-reconcile docs).

Carried forward: dedupe the repeated "scope global" sentence in the kb_export
description; hashes are read from disk rather than HEAD blobs, so untracked files
could let an entry qualify.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $8.1075.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0606 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 20 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
