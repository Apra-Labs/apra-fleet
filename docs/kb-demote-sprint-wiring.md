# kb_demote in the sprint reviewer loop

`docs/kb-trust-model.md` specifies the `kb_demote` tool contract (the ladder,
the refusals, the D6 re-offer rule, bible safety). This document covers the
other half: how the fleet-sprint engine's reviewer loop *sources* demotion
candidates, *vets* a reviewer's demotion decisions before any tool call is
attempted, and *executes* them -- the same judgment-belongs-to-the-role,
execution-belongs-to-the-engine split the promotion path already used.

## Two candidate blocks, two different shapes

A reviewer subagent has no KB tool access of its own, so an entry id it never
saw cannot appear in its structured output. The engine therefore reads both
candidate sets and hands them to the reviewer inside its dispatch prompt:

- **Promotion candidates** -- INFERRED entries, independent of what this round
  touched. "Something I captured earlier turned out to be worth trusting more."
- **Demotion candidates** -- CONFIRMED or INFERRED entries whose `source_files`
  intersect *this round's changed-file diff* specifically. A reviewer cannot
  usefully judge whether an entry it never read about is now wrong, so
  demotion candidates are scoped to what the round actually touched; offering
  the whole KB would swamp the prompt with irrelevant claims.

Both reads exclude `type='user-directive'` entries -- promote/demote both
refuse a directive outright (directive activation is CLI-only and
human-terminal), so offering one as a candidate can only produce a guaranteed
refusal.

## Bounded reads are an invariant, not an optimization

Both candidate reads are capped at a constant, independent of how large the KB
grows:

- The server-side `kb_list` query itself is asked for a `limit`.
- The *server* must still over-fetch a constant multiple of that limit
  (`DEMOTION_FILTER_OVERFETCH` on the provider side), because two of the
  filters that determine whether a row belongs in the result (tier check,
  directive exclusion) run on the engine side, strictly removing rows --
  asking the server for exactly the final count would under-fill the page
  whenever a filtered-out row sorts early. Dropping `LIMIT` from the SQL
  entirely to compensate turns the read into a full-KB scan that grows with
  KB size, defeating the point of a cap.
- The engine's own candidate read is separately capped
  (`KB_MAX_PROMOTION_CANDIDATES`, `KB_MAX_DEMOTION_CANDIDATES`), and that cap
  is re-applied by the engine regardless of what the server already enforced
  -- an older fleet server, or a hand-edited bible, is not trusted to have
  enforced it.

The invariant to preserve in any future change to this read path: bytes
crossing the MCP boundary for a candidate block are a function of the diff
and the constant caps above, never of total KB size.

## D6: the ping-pong guard

Demoting an entry and then re-offering the identical entry for promotion on
the very next round, with nothing having changed about it, would let
demote/promote loop forever. The guard: a demoted entry is excluded from the
promotion-candidate read unless at least one of its cited files now hashes
differently from the snapshot taken at demote time
(`demoted_basis_hashes`). The exclusion itself runs server-side (the provider
holds the repo anchor the re-hash needs); the candidate-read call only has to
ask for it (`exclude_unchanged_demotions: true`).

## The collision guard: one id cannot be promoted and demoted in the same round

Because promotion candidates are "INFERRED, KB-wide" and demotion candidates
are "CONFIRMED/INFERRED, this round's diff", a single INFERRED entry whose
`source_files` intersect the round's diff lands in **both** blocks. A
reviewer that names that id in both `kb_promotions` and `kb_demotions` would,
if both halves were honoured independently, see the engine call `kb_promote`
then `kb_demote` on the same id in one round: no net confidence change, two
audit notes appended, a demotion timestamp stamped for nothing.

The fix is a two-layer defense, and only one layer is authoritative:

1. **Prompt-side exclusion** (`kbDemotionBlock`) tries to stop the collision
   from ever being *offered* to the reviewer in the first place.
2. **The vetting gate** (`vetKbWork`) is the layer that actually matters: it
   runs after the reviewer has already answered, computes the intersection of
   the ids named in `kb_promotions` and `kb_demotions`, and refuses **both**
   halves for any colliding id -- not one arbitrarily chosen winner. A
   colliding pair is self-contradictory evidence about the same claim; picking
   a winner would record a trust decision the reviewer did not actually make.
   Non-colliding entries in both lists still proceed normally.

Layer 1 is best-effort UX; layer 2 is the one a future change must not
remove, because a reviewer can always name an id directly regardless of what
the prompt offered.

## Lockstep triplication: the same gate exists in three places, on purpose

`vetKbWork` (and the `KB_PROMOTER_ROLES` / `KB_MIN_PROMOTE_REASON` constants
it depends on) is intentionally duplicated across three runtimes rather than
imported from one shared module:

- the in-process fleet-sprint engine (`packages/apra-fleet-se/fleet-sprint/kb.mjs`),
- the apra-pm library used by its own review tooling
  (`packages/apra-fleet-se/apra-pm/lib/vet-kb-work.mjs`), and
- the Claude Workflow script (`packages/apra-fleet-se/apra-pm/.claude/workflows/auto-sprint.js`),
  which cannot import arbitrary repo files at all -- the Workflow tool runs it
  with no filesystem access, so it must hand its vetted payload to an executor
  subagent instead of calling KB tools directly the way the in-process engine
  does.

All three copies -- including the exact refusal string for a collision --
must stay byte-identical. A test that reads the real registry (not a copy of
the prose) is the mechanism that catches drift across the three; do not add a
fourth call site for this logic without first checking whether it can reuse
one of the three, and if it genuinely cannot (a new sandboxed runtime with no
shared-module access), add it as a FOURTH deliberate copy with the same
"mirrors X, keep in sync" comment the existing three carry.

## Why execution still happens only after validation, never before

Every `kb_promote`/`kb_demote` call in `apply()` is logged with its reviewer-
supplied evidence *before* the tool call is attempted, so the audit trail
exists even if the call itself is rejected by the server. Validation
(`vetKbWork`) always runs first and strips anything that would be refused
downstream, so a malformed or adversarial reviewer payload never reaches a KB
tool call at all -- the KB tool's own server-side refusals (not found,
superseded, directive, short reason, bad evidence path) are the second,
independent layer, not the only one.
