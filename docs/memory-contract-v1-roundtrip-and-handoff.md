# Memory Contract v1: Round-Trip Validation, Drift Guard, and the T1/T2/T3/T7 Boundary

This note captures the design of the pieces that close out the
memory-contract/v1 skeleton beyond schema generation itself: the
provider-parameterized round-trip harness, the CI drift guard, the error
taxonomy and its projection into the wire and into OpenAPI, and the explicit
boundary between "what a JSON Schema can prove" and "what a later
behavioural suite owns." See `docs/memory-contract-v1-generator-design.md`
for the schema-emission pipeline and `docs/memory-contract-v1-inventory-notes.md`
for inventory-level findings; this file is validation/handoff-level.

## The round-trip harness validates both directions, against a live provider

The harness drives every inventoried tool's real handler (not a mock) and
checks two things per call: the request document against
`schemas/<tool>.request.json` before dispatch, and the live response against
`schemas/<tool>.response.json` after dispatch. Both directions matter --
validating only the request would prove nothing about whether the published
response shape matches reality, which is exactly the gap a schema-generation
pipeline alone cannot close.

A response envelope is always decoded before response validation is
considered complete: the payload text block is parsed as JSON and attached
under a `parsed` key, and a non-JSON payload is a hard failure of the harness
itself, not a skipped check. This makes response validation non-vacuous even
though `parsed` is declared *optional* in the published schema -- the
optionality exists so that a raw, un-decoded envelope (exactly what every
handler actually emits on the wire: a `content` array with no `parsed`
sibling) still validates as committed, while a harness or consumer that does
decode the payload gets a schema that validates the richer, decoded shape
too. Making a field optional to accommodate a wire reality is not the same
as removing the check on it -- the decode step, and the requirement that it
succeed, still happens unconditionally in the harness.

## Cross-call state is a first-class part of the fixture corpus, not an afterthought

Several tools only produce their full range of documented outcomes when
called in a specific order against real prior state: an id referenced by one
call must have been minted by an earlier call in the same knowledge base: a
state-dependent refusal (accepted once, refused identically the second time)
depends on KB state at call time, not on anything in the request document.
The fixture corpus and the harness scenario are built around named, ordered
steps for exactly this reason -- replaying fixtures in arbitrary order would
silently drop this class of coverage. Provider identity is also part of this:
two callers resolving to the same logical scope but different repo anchors
get distinct provider instances, and the harness treats the (scope, anchor)
pair as load-bearing rather than collapsing it to just the scope.

## What JSON Schema structurally cannot prove, and where that gap goes

A JSON Schema constrains one document in isolation. A deliberate, explicit
list separates behaviours that fall outside that: cross-call ordering,
provider-instance identity, values that never appear on the wire at all
(stable machine error codes exist only in the taxonomy source of truth --
they are never stamped onto a thrown error, so a caller can only match on
human-readable message text locally), silent policy effects invisible in the
request (e.g. a requested confidence level being silently clamped, signaled
only by a boolean flag in the response), effects observable only through a
later, different call's response, states no live tool call can reach at all
(some transitions are deliberately CLI-only), filesystem side effects with no
representation in either document, and payload bodies that are intentionally
typed as opaque/unconstrained JSON because their shape is owned by a pluggable
backend rather than the contract layer.

None of these are gaps to be closed by tightening a schema -- tightening
would either be impossible (the property genuinely isn't in the document) or
would encode an implementation detail of one backend as if it were a
contract guarantee. The correct owner for asserting all of them is a
behavioural conformance suite that can drive real call sequences and inspect
real side effects, not the schema layer. Keeping this list explicit and
maintained alongside the harness (rather than reconstructed after the fact)
is what makes the handoff to that later suite concrete instead of "trust the
schemas cover everything."

## The taxonomy is the single source for machine error codes; wire projection is a deliberate subset

Machine-stable error codes live in one taxonomy document, tagged by how each
is surfaced (thrown as a plain error, returned as a response field, or never
observable from this transport at all -- e.g. a consent-gate refusal that is
silently absorbed, or a code that needs a state only a CLI action can put the
system into). Only codes that are actually reachable and meant for wire
consumers are projected into a machine-readable error binding (an RFC 9457
Problem Details-shaped document) -- codes that only ever appear as thrown
Node errors, or that are structurally unreachable through the tool surface,
are deliberately excluded from that projection rather than forced into it.
An absence check specifically confirms that excluded codes do *not* leak into
the projection; this check is only meaningful when it actually runs (see the
generator note below), and its role is to prevent silently widening the wire
surface to codes nothing was designed to expose.

## Generator has a write mode and a stricter check mode; some scans exist only in the latter

The schema/binding generator supports both "write the files" and "check
whether committed files match freshly generated output" modes. Not every
validation the generator is capable of is guaranteed to run on every
invocation of the write path -- some scans (for instance, the guard that
excluded-from-projection error codes never leak into a binding) are wired
only into the stricter check-mode branch. This means a plain generate-and-
write invocation, on its own, is not sufficient evidence that such a scan
ran; CI enforcement of that class of guarantee has to come from whatever
wraps the check-mode invocation (e.g. a dedicated test or CI step that
explicitly requests check mode), not from the generate step running at all.
Anyone adding a new absence/never-happens guard to the generator should
decide deliberately whether it belongs in write mode too, rather than
assuming "the generator ran" implies "this guard ran."

## The roster guard closes the "who verifies the verifier" gap for tool count

Any generator-side "expected tool count" is necessarily a hardcoded list
inside the generator itself -- by construction it can notice a previously
known tool disappearing, but it cannot notice a newly registered tool that
was never added to that list, because the generator has no independent view
of the real registration surface. Closing that gap requires a separate,
three-way check done outside the generator: the real tool registration entry
point (exercised against a fake server so registration is observed directly,
not re-derived from source text), the generator's own expected-roster
constants, and the schema files actually present on disk. Set-equality
across all three, run as its own test, is what makes "the contract roster
matches the real surface" a checked property rather than an assumption
carried by the generator's internal constant.

## Response schemas model the general wrapper envelope, not a single-block idealization

An earlier design modeled every tool's response as exactly one text content
block, which does not match the real response-wrapping behavior: a wrapper
can attach an onboarding preamble and/or a nudge suffix as additional content
blocks around the actual payload, each block able to carry its own optional
annotations, plus an optional top-level field for tools that also return
structured (non-text) data. The response schemas were widened to allow one
to three content blocks, optional per-block annotations, and an optional
structured-data field, while keeping the *payload* block's own decoded shape
exactly as strict as before (`additionalProperties: false`, verified by a
dedicated regression test that a wrong-shaped decoded payload is still
rejected). Widening the envelope to match reality and keeping the payload
shape strict are independent decisions -- doing one does not imply the other,
and a future schema change should treat them separately.

## Determinism is a checked property of the whole pipeline, not just the postprocess step

The generation pipeline -- from the zod source of truth, through generation,
through the deterministic postprocess, through binding and OpenAPI
projection -- has no non-deterministic inputs (no timestamps, no random ids,
no environment-dependent branching in the emitted content). Re-running the
full generate step against an unchanged source is expected to produce a
byte-for-byte-identical output tree. This is what makes a generate-then-diff
CI step a meaningful drift guard rather than a source of false-positive
noise: a real content difference after a clean regenerate means the
committed artifacts and the source of truth have diverged, not that the
generator is merely unstable run-to-run.

## Fixtures are recorded, not authored, and are explicitly not byte-reproducible

The fixture corpus is captured by recording real calls against a live
provider rather than hand-written by a person guessing shapes. Because of
that, several fields are expected to differ between recordings of the "same"
scenario -- minted ids, generated timestamps, and result ordering are all
volatile by nature of being recorded from a live system, not defects in the
corpus. Anything that compares a freshly recorded fixture against a
previously committed one for drift must normalize these volatile fields
first; comparing them raw is expected to always show noise. Treating this as
"expected volatility, normalize before compare" rather than "make recording
deterministic" avoids fighting the nature of the data.

## The handoff boundary between contract-skeleton work and downstream work is explicit, not implied

A four-layer contract skeleton (prose spec, JSON Schema, wire bindings,
conformance-suite hook) can be considered complete for its own scope even
when some sections are deliberately left as named, empty placeholders for
later owners -- as long as each placeholder names who owns filling it in and
what exactly they are scoped to write. Downstream owners should treat the
already-stamped structural markers (annotation ids pointing at specific
placeholder sections, a fixed list of reserved section topics) as the
authoritative input describing what exists and what doesn't yet -- re-deriving
that list independently, rather than trusting the stamped markers, is the
mistake this handoff style is designed to avoid. A directory existing under a
contract root is not by itself evidence that its layer is "done" -- an empty,
unowned directory and a populated, owned one are both technically "present,"
and only the latter should count toward a completeness verdict.
