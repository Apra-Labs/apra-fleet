# DEGRADATION: what JSON Schema validation cannot check on this surface

Owner: T1.4.2 (the provider-parameterized round-trip validator,
`roundtrip-harness.mjs`). This file is the degradation list the T1 epic promises
T7 and that T1.6.1's handoff points at.

**How the list was produced.** Every entry below is a behaviour the harness
either had to assert OUTSIDE the schemas, or could not assert at all. It was
written WHILE building the harness, not reconstructed afterwards: each entry is
an assertion that could not be expressed as "validate this document against
`schemas/<tool>.<kind>.json`".

**What this file is NOT.** None of these is a gap to be closed by tightening a
schema. A JSON Schema constrains ONE document in isolation; every entry here is
about something else -- a cross-call ordering constraint, a filesystem side
effect, a provider-instance identity, or a value that never appears on the wire
at all. T7's behavioural suite is the owner of all of them.

Each entry names: the tool or provider method, the behaviour shape validation
cannot check, and why.

---

## D-1 -- `kb_export` / `kb_import`: `repo_path` is validated against the real filesystem

- **Tool / method:** `kb_export` (`X-1`, `src/tools/kb-export.ts:157`),
  `kb_import` (`P-2`, `src/tools/kb-import.ts:75`).
- **Unverifiable behaviour:** both refuse with `E-REPO-PATH-INVALID` when the
  supplied `repo_path` does not exist or is not a directory. The check runs
  BEFORE `getKbProviders`, so no provider is involved.
- **Why schema validation cannot check it:** `repo_path` is `type: "string"`.
  Whether that string names an existing directory ON THE HOST SERVING THE CALL
  is not a property of the document; it is a property of a filesystem the
  validator cannot see. A request that is schema-valid can still be refused, and
  a request that is refused today can succeed tomorrow with no document change.
- **Seed:** CONFIRMED KB finding, also recorded on T1.4.1.

## D-2 -- KB provider identity is keyed on the `(slug, repoPath)` PAIR

- **Tool / method:** every `kb_*` tool, via
  `getKbProviders` (`src/services/knowledge/kb-providers.ts`), whose `_providers`
  cache is a `Map` keyed by `providerKey(slug, repoPath)` (NUL-joined), not by
  slug.
- **Unverifiable behaviour:** two callers that resolve to the SAME project slug
  but pass different `repo_path` values get DISTINCT provider instances, each
  anchored at its own caller's `repoPath`. The anchor decides where relative
  `source_files` resolve, so the identical request document can be admitted
  under one anchor and refused with `E-BASIS-MISSING-FILES` under another.
- **Why schema validation cannot check it:** which provider instance a call
  lands on is invisible in both the request and the response document. Nothing
  in the envelope names the instance, the slug, or the anchor.
- **Consequence for this harness:** it takes the provider as a parameter and
  reports the `(slug, repoPath)` pair it exercised; the entry point asserts the
  pair is load-bearing with a case that would pass if keying were slug-only.
- **Seed:** CONFIRMED KB finding.

## D-3 -- Taxonomy error codes never appear on the wire

- **Tool / method:** every refusal path in `taxonomy.json` with
  `surfaced: thrown` (23 of the codes in the closed set), across all 16 `kb_*`
  tools.
- **Unverifiable behaviour:** a refusal is raised as a plain `Error` whose
  message is human prose. The stable machine code (`E-PROMOTE-SUPERSEDED`, ...)
  exists only in `taxonomy.json`; no handler stamps it onto anything a caller
  receives.
- **Why schema validation cannot check it:** there is no error document to
  validate. A thrown refusal produces no envelope at all, so no
  `<tool>.response.json` applies, and the code the caller "should" have seen is
  recoverable only by matching the message text. This harness therefore asserts
  a refusal by comparing the live message against the recorded fixture message
  (normalised for scratch paths and minted ids) -- prose matching, which is
  exactly the kind of assertion a contract is supposed to replace.
- **Note for T7 / T8:** an HTTP binding MUST project a code onto the wire (the
  RFC 9457 shape in `bindings/openapi/openapi.yaml`), so this degradation is
  local-transport-only. It does not shrink; it moves.

## D-4 -- `parsed` is a consumer-side decode, not a wire field

- **Tool / method:** all 23 inventoried tools, via `wrapTool`
  (`src/services/tool-registry.ts`).
- **Unverifiable behaviour:** every handler `JSON.stringify`s its body into a
  text content block. The envelope carries `content` (and, for non-inventoried
  tools, `structuredContent`) -- never a `parsed` key. `schemas/*.response.json`
  models the envelope PLUS a `parsed` body (INVENTORY.md section 3), but
  `parsed` is declared OPTIONAL (my-beads-db-27m.47, `responseSchema()` in
  `response-schemas.mjs`), precisely because no handler ever puts it on the
  wire: a RAW envelope (`{content}` only, what every recorded fixture and
  every live response actually is) validates as-is, and a consumer that
  decodes the payload block into a `parsed` sibling (the harness's
  `decodeEnvelope`) gets a schema that ALSO still validates that richer
  object, `properties.parsed` staying fully typed either way. The schema
  cannot verify the decode itself (see below); it can only accept both the
  raw and the decoded shape without contradiction.
- **Why schema validation cannot check it:** the schema cannot express "this
  string is JSON, and the object it decodes to is this shape." It also cannot
  express WHICH block is the payload: `wrapTool` may emit up to three blocks,
  distinguishable only by the `annotations` stamped on the preamble/suffix.
  Choosing the payload block, and failing loudly when its text does not parse,
  are both harness responsibilities.
- **Verified statically too (my-beads-db-27m.47):** `tests/memory-contract-
  fixture-response-schema.test.ts` validates all 32 committed fixtures that
  carry a `response` two ways against `schemas/<tool>.response.json` -- (1)
  RAW, exactly as recorded, and (2) decoded via `decodeEnvelope` (this file's
  own function, already reused internally to read a recorded fixture's
  `parsed.id`) -- 0 failures either way. Before this bead, (1) failed 25 of 32
  fixtures with "must have required property 'parsed'"; `parsed` moving from
  required to optional is what fixed it, not a fixture edit (no fixture ever
  gained a `parsed` key) and not a widening of the `parsed` body's own shape
  (still `additionalProperties: false` per tool, checked by a dedicated
  regression test using a deliberately wrong-shaped `parsed` object).

## D-5 -- Cross-call ordering: ids must be minted by an earlier call

- **Tool / method:** `kb_promote`, `kb_feedback`, `kb_resolve_contradiction`
  (`id`, `winnerId`, `loserId`).
- **Unverifiable behaviour:** these fields must carry an id a PRIOR `kb_capture`
  minted in the SAME KB. `E-ENTRY-NOT-FOUND` and `E-RESOLVE-MISSING-ENTRY` are
  the refusals for ids that never existed.
- **Why schema validation cannot check it:** the schema constrains the field to
  a non-empty string. Referential integrity is a property of the KB's history,
  not of the request document. This is why the harness carries an explicit
  ordered scenario with named derivations rather than replaying fixtures in
  arbitrary order.

## D-6 -- State-dependent refusals: the same document is accepted, then refused

- **Tool / method:** `kb_promote` (`E-PROMOTE-SUPERSEDED`,
  `E-PROMOTE-BASIS-UNRESOLVED`), `kb_resolve_contradiction`
  (`E-RESOLVE-ALREADY-SUPERSEDED`, `E-RESOLVE-NOT-A-PAIR`).
- **Unverifiable behaviour:** `kb_promote/setup-first-promote-for-basis-unresolved`
  and `kb_promote/refusal-basis-unresolved` differ ONLY in when they are called
  -- the second runs after the cited basis file was deleted. Likewise a
  contradiction pair resolves once and refuses the second time with a byte-identical
  request.
- **Why schema validation cannot check it:** the outcome depends on KB state and
  worktree state at call time, neither of which the request document mentions. A
  schema that accepted the first call and rejected the second would have to be
  a function of time.

## D-7 -- Trust clamping is silent and invisible in the request

- **Tool / method:** `kb_capture` (`P-2`), authority group's non-error branch.
- **Unverifiable behaviour:** a capture asking for `confidence: "CONFIRMED"` is
  silently clamped to `INFERRED`; the ONLY signal is `confidence_clamped: true`
  in the response body. `taxonomy.json` deliberately gives this branch no error
  code.
- **Why schema validation cannot check it:** `confidence: "CONFIRMED"` is a
  schema-VALID request. That the server will not honour it is a policy, not a
  shape. The response's `confidence_clamped` field is schema-checkable as a
  boolean, but "it is `true` exactly when the request over-asked" is a
  cross-document relation no schema expresses.

## D-8 -- Directive quarantine is only observable through a LATER read

- **Tool / method:** `kb_capture` / `kb_harvest` / `kb_import` raise
  `E-DIRECTIVE-QUARANTINE` (governance, `surfaced: response-field`); the effect
  is observable only via `kb_list`.
- **Unverifiable behaviour:** a `user-directive` capture is forced to
  `UNVERIFIED` and parked as a pending proposal. `kb_capture`'s own response
  (`{id, audn_decision, confidence_clamped}`) never exposes the forced
  confidence, tag or scope.
- **Why schema validation cannot check it:** the durable effect lives in a
  DIFFERENT tool's response document. No single request/response pair contains
  both the cause and the evidence. (This is also why the corpus records it as a
  `kb_list` `non_error_outcome` with `observed_via`, and why `observed_via`
  fixtures are never cross-checked against the calling tool's own bindings.)

## D-9 -- Activation states no tool call can reach

- **Tool / method:** `E-RESOLVE-DIRECTIVE-PAIR`,
  `E-ACTIVE-DIRECTIVE-SUPERSEDE-GUARD` (both need an ACTIVE user-directive),
  `E-SUPERSEDE-CONSENT-MISSING` (`surfaced: silent`),
  `E-CODE-PROVIDER-UNCONFIGURED` (needs a mutated real-host config file).
- **Unverifiable behaviour:** directive activation is CLI-only by design
  (`apra-fleet kb approve-directive`), so no MCP tool call can produce the state
  these codes refuse from.
- **Why schema validation cannot check it:** unreachable-from-this-surface, so
  there is no document to validate in either direction. Carried here as the
  standing named-gap list, matching `record-fixtures.mjs`'s printed T7 gaps.

## D-10 -- `code_*` calls write to the real home directory

- **Tool / method:** all 7 `code_*` tools, via
  `recordUsage()` in `src/tools/code-intelligence-telemetry.ts`.
- **Unverifiable behaviour:** every call fire-and-forget appends one JSONL line
  to `~/.apra-fleet/data/code-intelligence/usage.jsonl`. That path is built from
  `os.homedir()`, NOT from `FLEET_DIR`, so `APRA_FLEET_DATA_DIR` cannot redirect
  it -- including when the round-trip harness runs in CI, which now dispatches
  all seven tools on every run.
- **Why schema validation cannot check it:** it is a filesystem side effect with
  no representation in the request or the response. The write is additive-only,
  swallows its own errors, and is the tool's own always-on behaviour rather than
  something the harness introduces -- flagged here rather than silently
  accepted.

## D-11 -- `code_*` response bodies are opaque by decision

- **Tool / method:** `code_graph`, `code_impact`, `code_query`, `code_context`,
  `code_map`, `code_flow`, `code_tests` (INVENTORY.md findings F-1..F-7).
- **Unverifiable behaviour:** each handler returns `Promise<unknown>` proxied
  from whichever `CodeIntelligenceProvider` is active (`codebase-memory`,
  `gitnexus`, `none`). The payload shape is owned by the provider and differs
  between them.
- **Why schema validation cannot check it:** `parsed` is typed as unconstrained
  JSON on purpose. The response schema for these seven tools checks the ENVELOPE
  only; anything inside is unvalidated, so a provider swap that changes the
  payload shape produces no schema failure at all.

## D-12 -- Request-level zod validation is bypassed by any handler-call harness

- **Tool / method:** all 23 tools, at the MCP SDK boundary.
- **Unverifiable behaviour:** the real zod input validation happens in
  `server.tool()` registration, BEFORE a handler is invoked. Both this harness
  and `record-fixtures.mjs` hold handler references directly (they need the
  handler, not SDK dispatch), so a schema-invalid input would never be rejected
  the way a real MCP client's would.
- **Why schema validation cannot check it:** the harness's own JSON Schema check
  substitutes for it, and the two are generated from the same zod source -- so a
  drift between the emitted schema and the SDK's runtime enforcement is
  structurally invisible from here. T7 needs an SDK-dispatch case per tool to
  cover it.

## D-13 -- `kb_context` result element shapes are observed but uncited

- **Tool / method:** `kb_context` (`P-4`), `fresh` and `stale`.
- **Unverifiable behaviour:** both carry provider result OBJECTS
  (`{file, status, reason, entry_id}`), not file names -- `src/tools/kb-context.ts`
  ships `results.filter(...)` whole and only maps `missing` down to names. The
  response schema was corrected here (T1.4.2) from `array of string` to
  `array of unknown`, because the string form contradicted both the
  implementation and the committed corpus.
- **Why schema validation cannot check it:** no zod schema for a context result
  exists anywhere in this repo to cite, and guessing one is exactly what
  produced the defect this harness caught. So the element shape stays
  unconstrained: the schema now checks arity and nothing inside. A provider
  change to the result shape produces no schema failure -- same class as D-11.
