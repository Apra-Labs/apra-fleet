This is the T2a close-out report for section 4 of memory-contract/v1, written for human review (my-beads-db-2be, task my-beads-db-2be.6).

## 1. Section 4 contents (one line per subsection)

- **4.1** Scope resolution/repo aliasing: `repo ?? repo_path` precedence, `kb_setup`'s `repo_path` carries no KB-scope semantics, provider cache keyed (slug, repoPath).
- **4.2** Capture provenance/confidence clamp: CONFIRMED -> INFERRED except promotion/bible-import, closed Author enum, handler-derives-`source` vs provider-persists-verbatim split.
- **4.3** Directive quarantine: capture succeeds but is silently rewritten (UNVERIFIED, flagged, `directive:pending`, forced project scope); activation is CLI-only, absence not a guarded route.
- **4.4** Superseding/AUDN: `supersedes` only retires on independent AUDN match; ACTIVE-directive guard; both refusals silent.
- **4.5** Freshness/hashing: `content_hash` gated to context-cache+source_file; `source_file_hashes` computed unconditionally; bidirectional sweep; anchor-missing withholding vs no-anchor fallback.
- **4.6** Query modes: two mutually exclusive response shapes keyed on `flagged_only`; selector-required refusal; response shapes are observed, not schema-enforced.

## 2. State of INVARIANTS-UNHOMED-DRAFT.md

Four drafted guarantees exist there, verified against source and written to the same rule/proof/obligation/test-hook pattern as spec.md section 4:

- **U1** -- Falsifiability admission
- **U2** -- The v2 bible envelope
- **U3** -- Import trust tiers
- **U4** -- Contradiction-resolution refusal, and the absence of a demote

They are headed `U1`-`U4`, not `4.x`, precisely so nothing resolves against them: `taxonomy.json` `see_also` strings and `schemas/*.json` `x-invariant` ids point only at spec.md's frozen `### 4.x` titles. Placement is deliberately left as an OPEN human decision -- the live options recorded in that file are new `4.7`-`4.10` subsections, folding each into an existing `4.1`-`4.6` subsection (each draft names its candidate), or moving into section 3 prose. No placement call is made by this task or any prior one.

## 3. Epic-wide code-vs-plan discrepancy inventory (all seven, each re-verified against source)

1. **Two-layer confidence clamp with importMode/user-directive exemptions at the provider choke point; `confidence_clamped` is handler-only.** Handler: `src/tools/kb-capture.ts:99-107` -- unconditional downgrade + `confidence_clamped: true` for every `type`, only on the `kb_capture` handler path. Provider choke point: `src/services/knowledge/sqlite-provider.ts:889` -- `if (!opts?.importMode && input.type !== 'user-directive' && input.confidence === 'CONFIRMED')`, re-enforced for every route reaching `capture()` (`kb_capture`, `kb_harvest`, `kb_import`, HTTP `/api/kb/capture`), but `kb_harvest`/`kb_import`/HTTP never set `confidence_clamped` -- verified by inspection of those three call sites, none of which populate that response field.
2. **`content_hash` is caller-settable over the HTTP `/api/kb/capture` route.** `src/commands/kb-server.ts:138-142` parses the request body straight into `KBEntryInput` and calls `provider.capture(input)` unfiltered, bypassing the `kb-capture.ts:58` hashing gate entirely -- an HTTP caller's own `content_hash` field is persisted verbatim.
3. **`source` is persisted verbatim at the provider except `'import'`/`'promotion'` forced to `'unknown'` outside import mode.** `src/services/knowledge/sqlite-provider.ts:873-875` (comment block `858-876`): `insertEntry()` persists `input.source` verbatim; the only normalization is overwriting a caller-supplied `'import'` or `'promotion'` with `'unknown'` when `!opts?.importMode`, because those two values mark trusted-channel provenance that a forged value would let an audit wrongly trust.
4. **`INVENTORY.md` section 2.1 is wrong that `kbScopeFields` supplies `repo_path`.** `src/services/knowledge/kb-scope-input.ts:8-11` -- `kbScopeFields` exports only `repo_remote_url`; `repo_path` is declared individually per tool (e.g. `src/tools/kb-list.ts:12`, `kb-context.ts:8`, `kb-invalidate.ts:10`), not by the shared spread. `INVENTORY.md`'s line describing `kbScopeFields` as where both names "come from" (section 2.1) is imprecise on this point.
5. **Provider cache keyed on slug plus repoPath, not slug alone.** `src/services/knowledge/kb-providers.ts` -- `providerKey(slug, repoPath)` joins the pair with NUL and uses it as the map key, deliberately not slug alone, so two callers resolving to the same project slug but different repo paths get distinct anchors rather than sharing the first caller's.
6. **`anchorIsMissing` withholds a verdict only on an explicitly-resolved-but-absent anchor.** `src/services/knowledge/sqlite-provider.ts:325-327` -- `anchor !== undefined && !fs.existsSync(anchor)`. It only withholds when an anchor IS resolved (an explicit `root` argument, or the provider's own configured `repoPath`) and that path does not exist on disk; when no anchor is configured at all, it returns `false` and the sweep proceeds, resolving relative basis paths against the process's own working directory.
7. **Legacy `decayConceptEntries()` is a real downward-confidence write, narrowing U4's "no demote" claim in the DRAFT -- not spec.md section 4, which makes no no-demote claim to narrow.** `src/services/knowledge/sqlite-provider.ts:746-765` -- `SET confidence = 'UNVERIFIED' WHERE confidence = 'INFERRED'` over unsuperseded, untouched-since-cutoff, non-directive rows citing NO source files. This is the sole downward-confidence write in the provider. It is legacy-only by construction: its predicate matches only zero-basis rows, and U1's admission gate (in the unhomed draft) now refuses to create one, so the ladder cannot fire for anything captured after that gate landed. This finding belongs to the U4 draft in INVARIANTS-UNHOMED-DRAFT.md, which explicitly documents it under "THE DEMOTE THAT IS NOT ONE" -- spec.md section 4 itself contains no no-demote assertion for this to contradict, so the discrepancy narrows a claim in the unhomed draft, not a published contract rule. That distinction is preserved here deliberately because it is more precise than treating this as a section-4 conflict.

## 4. Citations that had drifted and were corrected during the epic

- `:1514-1521` -> `:1513-1521` (corrected in the earlier unhomed-draft task, U1's proof section, `sqlite-provider.ts`).
- `:1647-1654` -> `:1646-1654` (corrected in the earlier unhomed-draft task, U4's proof section, `reconcilePrefilter` directive-pair exclusion, `sqlite-provider.ts`).

This close-out task itself (my-beads-db-2be.6, spec.md preamble/heading edit) introduced no new citations -- it only edited the file-header status/ownership prose and the section 4 umbrella paragraph, neither of which carries a file:line citation.

## 5. Branch tip SHA

All citations above and in spec.md section 4 were verified against commit `63070ffa` (the close-out commit that removed the RESERVED/placeholder framing). This report file itself lands in a later commit on top of `63070ffa`, since it is a new file addition and cannot be part of the commit it verifies against.

## 6. Explicitly NOT done -- belongs to a human or a later task

- **Placement of U1-U4** into section 4 (new `4.7`-`4.10` subsections, folding into an existing `4.1`-`4.6` subsection, or moving into section 3 prose) -- deliberately left open, not decided by this task or any prior one.
- **Section 5 (T3, envelope extensions)** -- untouched, still RESERVED, out of this lane's scope.
- **Whether the file-header ownership note needs a fuller restatement than the minimal fix made in my-beads-db-2be.6** -- that task scoped the "two writers" claim to sections 1-3 and added a status-line note that T2 authored section 4, rather than restructuring the governance model. Whether a more thorough rewrite of the ownership note is warranted is left for a human call.

## 7. Gate output (pasted verbatim, this session)

```
$ npm run build

> @apralabs/apra-fleet@0.4.2 build
> npm run build:contract && tsc


> @apralabs/apra-fleet@0.4.2 build:contract
> npm run build --workspace=@apralabs/fleet-api-contract


> @apralabs/fleet-api-contract@0.1.0 build
> tsc -p tsconfig.json
```

```
$ npm run contract:check

> @apralabs/apra-fleet@0.4.2 contract:check
> node memory-contract/v1/generate-contract.mjs --check

contract:generate --check: OK -- 23 tools, 46 schema files, 23 binding files, 1 openapi file, 20 projectable taxonomy codes, all match and cross-reference cleanly.
(node:33396) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
```

```
$ npx vitest run tests/memory-contract-*.test.ts

 Test Files  11 passed (11)
      Tests  75 passed (75)
```

```
$ grep -n "RESERVED" memory-contract/v1/spec.md
9:a re-plan. The RESERVED section 5 is a placeholder for a later task (T3) and
60:extensions (T3, RESERVED)" below.
680:## 5. Envelope extensions (T3, RESERVED)
```

All three remaining `RESERVED` hits refer to section 5 / T3 only; zero hits reference section 4.
