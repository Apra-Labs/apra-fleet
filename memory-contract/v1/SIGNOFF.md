# memory-contract/v1 -- T1 sign-off

Status: T1.6.1 self-review and close-out. Written against branch
`u1_contract_v1_skeleton`, HEAD at time of writing `1dfdeb0a`. This file is the
durable sign-off record; a PR description (where one exists for the target
remote) should copy it, not replace it -- some remotes never get a PR at all.

## 1. Four-layer checklist

| # | Layer | Verdict | Evidence |
|---|---|---|---|
| 1 | Prose spec (`memory-contract/v1/spec.md`) | **PASS for T1's scope; STUBBED for T2/T3 by design** | `spec.md` sections 1-3 (Envelope, Provider methods, Error model) are written and owned by T1.3.1/T1.3.2. Section 4 ("Invariants (T2, RESERVED)") holds six empty, titled subsections -- Scope resolution and repo aliasing, Capture provenance and confidence clamp, Directive quarantine, Superseding and AUDN matching, Freshness and content hashing, Query modes -- matching `tests/GENERATOR-DECISION.md` section 4's hand-off list verbatim (owner: T2). Section 5 ("Envelope extensions (T3, RESERVED)") is likewise an empty placeholder (owner: T3). Neither reserved section was filled in from this task, per `spec.md`'s own ownership note. |
| 2 | JSON Schema 2020-12 (`memory-contract/v1/schemas/*.json`) | **PASS** | `npm run contract:check` -> `contract:generate --check: OK -- 23 tools, 46 schema files, 23 binding files, 1 openapi file, 20 projectable taxonomy codes, all match and cross-reference cleanly.` (run 2026-08-24). Metaschema conformance for all 23 request schemas plus the hard-construct probes (discriminated union, closed enums, optional/nullable/nullish, recursive `$defs` ref, tuple `prefixItems`) are recorded in `tests/GENERATOR-DECISION.md` section 2, reproducible via `node memory-contract/v1/tests/probe-generator-2020-12.mjs`. `x-invariant` annotations are stamped on the emitted schemas (verified: `grep -rl x-invariant memory-contract/v1/schemas/` -> 28 files), each pointing at one of the six `spec.md` section 4 subsections per the `tests/GENERATOR-DECISION.md` section 4 table. |
| 3 | MCP + OpenAPI bindings | **PASS (MCP); PASS-AS-STUB (OpenAPI, by design)** | MCP: one `bindings/mcp/<tool>.json` per tool, 23 files, byte-identical-on-regenerate per `contract:check` above; `--check` asserts binding<->schema no-extras-no-gaps parity and the taxonomy-to-projection direction, but its roster is the hardcoded `KB_MODULES`/`CODE_EXPORTS` list (`generate-contract.mjs:142`, `EXPECTED_TOOL_COUNT = 23`), not an import of `src/services/tool-registry.ts` -- it can only notice a tool disappearing, not a newly-registered one going unrostered. The registered-tool <-> roster <-> emitted-schema-pair leg is asserted separately by `tests/memory-contract-roster-guard.test.ts` (my-beads-db-27m.39). Scheme documented in `tests/BINDING-SCHEME.md`. OpenAPI: `bindings/openapi/openapi.yaml` is the RFC 9457 Problem Details projection of `taxonomy.json`'s 20 projectable codes, declares zero paths (no route surface) -- this is the task's own stub scope, not a gap, per `tests/BINDING-SCHEME.md` section 1 ("out of this task's original scope... has since landed under T1.3.3" as a Problem-Details-only artifact). `--check` covers it byte-for-byte on the same "no extras, no gaps" basis as `schemas/` and `bindings/mcp/`. |
| 4 | Conformance-suite hook (fixtures + provider-parameterized harness) | **PASS** | `npx vitest run` over the 11 `tests/memory-contract-*.test.ts` files -- `11 passed (11 files), 75 passed (75 tests)` (re-run 2026-08-24 after the F-1 correction below; 74 at first sign-off), covering drift guard, fixture/response-schema round-trip (raw + decoded envelope), fixture sanitation, fixture volatility normalisation, openapi.yaml parse, roster/parity, postprocess-2020-12 determinism, response envelope shape, roster guard, the provider-parameterized round-trip harness itself, and taxonomy group/code invariants. Fixture corpus is recorded under `fixtures/` (T1.4.1, commit `f230c530`) and is explicitly NOT byte-reproducible (`README.md` item 5, `tests/memory-contract-fixture-volatility.test.ts`) -- this is documented as expected, not treated as drift. |

## 2. T11 (Friday sync) agenda item -- drafted

**Item: T1 close-out -- confirm T2/T3/T7 hand-off scope before those lanes start writing.**

- T1's four layers (prose spec skeleton, JSON Schema 2020-12, MCP+OpenAPI
  bindings, conformance-suite hook) are closed; see
  `memory-contract/v1/SIGNOFF.md` section 1 for the per-layer verdict and
  evidence.
- Confirm T2 is scoped to exactly the six `spec.md` section 4 subsections
  (Scope resolution and repo aliasing / Capture provenance and confidence
  clamp / Directive quarantine / Superseding and AUDN matching / Freshness and
  content hashing / Query modes) and the nine `x-invariant` ids already
  stamped on the schemas (INV-01..INV-09, table in
  `tests/GENERATOR-DECISION.md` section 4) -- no new invariant should be
  invented outside that list without a re-plan.
- Confirm T3 is scoped to `spec.md` section 1 ("Envelope") as
  current-fields-only plus section 5 ("Envelope extensions (T3, RESERVED)"),
  and that any new field lands as tolerant-read (old clients must not break)
  with OKF field-name alignment checked at that time, per the 2026-08-12
  decision referenced in this task's own description. That decision text is
  not yet anchored to any file in this tree as of this sign-off -- T3 should
  confirm where it lives (or record it) before writing the section.
- Hand fixtures (`memory-contract/v1/fixtures/`) plus the "schema cannot check
  this" list (`tests/DEGRADATION.md`, D-1..D-13) to T7. Table the exact split
  between T1's shape-only tests and T7's behavioural suite at this sync --
  T1's tests own schema/parity/determinism; T7's suite owns everything
  `DEGRADATION.md` names (state-dependent refusals, cross-call ordering,
  filesystem side effects, provider-instance identity, opaque `code_*`
  payloads).
- No open "tool contract violates a shipped invariant" finding from this
  self-review (section 4 below) -- flag if that changes before this sync.

## 3. Handoff notes

### T2 (week 2) -- reserved invariants sections + x-invariant list

- Writing queue is `spec.md` section 4's six empty subsections (4.1-4.6),
  listed above. Do not touch sections 1-3 (T1.3.1/T1.3.2 territory) or
  section 5 (T3 territory).
- The complete `x-invariant` id -> rule -> `spec.md` section mapping is
  `tests/GENERATOR-DECISION.md` section 4's table (INV-01..INV-09). It is
  marked "complete as-is" and is the authoritative input -- T2 writes the rule
  text into the named section, it does not re-derive which ids exist.
- The annotations are already stamped on the emitted schemas (`x-invariant`
  keys present in 28 committed schema files, verified this task) -- T2's job
  is prose, not schema changes.
- Reviewer: Akhil.

### T3 (week 3) -- envelope current-fields-only, tolerant-read, OKF alignment

- `spec.md` section 1 ("Envelope") is marked current-fields-only by T1 and
  section 5 ("Envelope extensions (T3, RESERVED)") is the reserved landing
  spot for anything new (e.g. `structuredContent` adoption, a provider-
  agnostic error envelope).
- New fields must land tolerant-read; existing consumers of the current
  envelope (`ToolTextResponse = { content: [ { type: "text", text: string } ] }`,
  `spec.md` section 1) must not break.
- OKF field-name alignment must be checked against the 2026-08-12 decision.
  This sign-off could not locate that decision anchored to any file in this
  tree (searched for "OKF" and "tolerant-read" across `memory-contract/v1` --
  no hits) -- T3 should either find/cite its source or flag that it needs to
  be recorded before section 5 is written.
- `D-4` in `tests/DEGRADATION.md` is directly relevant: `parsed` is a
  consumer-side decode, not a wire field, and is declared optional on every
  response schema for exactly that reason (my-beads-db-27m.47). Any envelope
  extension must preserve that raw-envelope-validates-as-is property.

### T7 (Disha) -- fixtures + "schema cannot check this" list

- Fixtures: `memory-contract/v1/fixtures/`, one directory per tool, recorded
  T1.4.1 (`f230c530`). Not byte-reproducible across recordings (entry ids,
  `created_at`, and result order all vary) -- see `README.md` item 5 and
  `memory-contract/v1/tests/roundtrip-harness.mjs`'s
  `normalizeVolatileFixtureFields` (defined there at line 506; exercised by
  `tests/memory-contract-fixture-volatility.test.ts`) for the normalisation
  T7 should reuse rather than re-deriving.
- The "schema cannot check this" list is `tests/DEGRADATION.md`, thirteen
  entries D-1..D-13, each naming the tool/method, the unverifiable behaviour,
  and why JSON Schema cannot express it (cross-call ordering, provider-
  instance identity keyed on `(slug, repoPath)`, taxonomy codes never
  appearing on the wire, state-dependent refusals, silent trust clamping,
  directive quarantine observable only via a later read, unreachable
  activation states, `code_*` filesystem side effects and opaque payloads,
  uncited `kb_context` result shapes).
- The split to table at T11: T1's tests own shape (schema validity, parity,
  determinism, fixture-vs-schema round-trip); T7's suite owns behaviour
  (everything in `DEGRADATION.md`). This split is not yet formally confirmed
  by T7 -- that confirmation is the T11 agenda item above.

## 4. Findings where a tool contract appears to violate a shipped invariant

**None found in this self-review.** All nine `x-invariant` ids (INV-01..INV-09)
were checked against `tests/GENERATOR-DECISION.md` section 4 and the schemas
they annotate; no contradiction was observed between the stamped annotation,
the cited source anchor, and current handler behaviour.

One adjacent item worth naming so it is not lost, though it is not an
invariant violation: `tests/DEGRADATION.md` D-10 records that all 7 `code_*`
tools write telemetry to `~/.apra-fleet/data/code-intelligence/usage.jsonl`
via `os.homedir()`, which `APRA_FLEET_DATA_DIR` cannot redirect. This is a
documented degradation (filesystem side effect outside the envelope), not a
violation of any of the nine invariants above -- carried here only so T11 can
decide whether it deserves its own line item.

If a future sign-off (T2, T3, or T7's work) finds an extracted tool contract
that DOES violate one of the nine invariants, it belongs on the T11 agenda,
not silently resolved in the schema -- per this task's own instructions.

## 5. Post-sign-off correction: E-DIRECTIVE-QUARANTINE reclassified (F-1)

An independent code-level review of PR #1 (2026-08-24) found one genuine
contract defect that every green check structurally could not catch, and it is
corrected in this branch rather than deferred.

**The defect.** `E-DIRECTIVE-QUARANTINE` was filed in `taxonomy.json` under
`groups.governance` with `surfaced: "response-field"`, and was therefore
projected onto the wire: into the `errors[]` of `bindings/mcp/kb_capture.json`,
`kb_harvest.json` and `kb_import.json`, and into `bindings/openapi/openapi.yaml`
with HTTP status 403. No response field reports it. `kb_capture` returns
`{id, audn_decision, confidence_clamped}`, and `confidence_clamped` is set only
by the CONFIRMED-to-INFERRED clamp at `src/tools/kb-capture.ts:102-105`,
independently of the directive path at
`src/services/knowledge/sqlite-provider.ts:806-818`, which mutates the input and
continues without throwing. `kb_import` surfaces only
`imported/skipped/linked/flagged/rejected/sweep`. The capture SUCCEEDS.

**Why it mattered.** An implementation built from that projection would REFUSE a
directive capture (403) that this kernel ACCEPTS and stores as a pending
proposal -- a kernel-semantics fork, which is the exact class of divergence the
conformance suite exists to prevent.

**Why the guards missed it.** The drift, parity and taxonomy guards verify
INTERNAL consistency, and the misclassification was internally consistent. It
was visible only against source behaviour.

**The correction.** `E-DIRECTIVE-QUARANTINE` moved out of `groups.governance`
and into `non_error_outcomes`, alongside `E-CLAMP`, which it structurally
matches: a successful write with a forced downward transformation, not a
refusal. `silent` was considered and rejected -- the two existing `silent` codes
describe requests with NO effect, whereas quarantine has a large effect (it
stores a transformed entry), so "silent refusal" would have been a second
misfiling. Consequences, all regenerated rather than hand-patched (the bindings
address codes by positional JSON pointer, so a hand-edit would have silently
renumbered `governance` refs in `kb_promote` and `kb_resolve_contradiction`):

- closed set 23 -> 22 codes; `governance` 5 -> 4; `non_error_outcomes` 10 -> 11
- projectable codes 21 -> 20; the code drops out of 3 bindings and the OpenAPI
  catalog
- `methods.json` P-2: moved from `error_codes` to `non_error_outcomes`, required
  by the split that `tests/memory-contract-taxonomy.test.ts` already enforced

**New falsifiability guard.** `surfaced: "response-field"` is the one value that
projects a refusal onto the wire WITHOUT the call having failed, so it now
carries an obligation: the code must name a `response_field`, and that property
must exist in the generated response schema of at least one raising tool
(`_meta.response_field_rule`, asserted by
`tests/memory-contract-taxonomy.test.ts`). After this correction
`E-IMPORT-ENTRY-REJECTED` is the only remaining `response-field` code and it
satisfies the rule (`kb_import` really does return `rejected`) -- so the guard
covers one subject today and exists to stop the next misclassification, not to
fix present breakage. Test count 74 -> 75.

Two consequential guards had to be widened, and both widenings are narrow:
`tests/memory-contract-drift-guard.test.ts` now baselines the count of DISPOSED
names (codes plus non-error outcomes, 33) so a name MOVING between the two
dispositions does not read as a silent deletion, while a real deletion still
trips it; and `tests/roundtrip-harness.mjs` now resolves a fixture's
`observed_via` against codes OR non-error outcomes, since observing a non-error
outcome is legitimate. `expected_error_code` remains codes-only: a fixture
asserting a refusal must still assert a real refusal.
