# Bible rebuild, 2026-08-04

Phase 3 of `docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md`.
`.fleet/kb-canonical.json` went from **97 entries to 17**. This file records the
disposition of all 97 so every drop is auditable; the pre-rebuild file remains in
git history at `629ea1b`.

## Why the old bible could not be repaired in place

It claimed 97 CONFIRMED entries while the live project KB held 6 entries, 0
CONFIRMED -- the file was never an export of this KB. Verification also turned up
**entries that contradict each other, both stamped CONFIRMED**, which is the
clearest possible proof that nothing had ever checked them:

- `9462ab04` said the confidence clamp lives in the `kb_capture` handler and NOT
  in `SqliteProvider.capture()`; `c5f1f415` said it had been relocated into the
  provider. The provider is correct, so `9462ab04` was dropped.
- `4cdf2a5d` said `hasOppositePolarity` uses `String.includes` and false-positives
  on substrings; `f782fa69` said it uses word-boundary regexes. The regexes are
  correct, so `4cdf2a5d` was dropped.

## Method

**Step 1, mechanical triage** (scripted, no judgment): classify all 97 against the
current tree. 58 candidate, 6 repointable, 33 mechanically droppable.

**Step 2, verification gate** (by hand): every survivor was checked against the
files it cites. An entry was promoted ONLY if its specific claim was read and
confirmed in the current source. Anything not verified was dropped rather than
carried -- an unverified entry is exactly what produced the old bible. Survivors
re-entered as candidates via `kb_capture` (clamped to INFERRED) and earned
CONFIRMED through `kb_promote` with the evidence recorded in the promote note.

**Step 3, gap-fill**: entries covering what this work created, which the old bible
had no coverage of at all.

**Step 4, export**: a single `kb_export` with `autoCommit` false, reviewed, then
this commit.

## Judgment drops (survived triage, failed verification)

These cite files that still exist, so no mechanical rule would have caught them.
Each was read against the current source and found false or obsolete.

- `34b9b7a6` "AUTO-COMMIT AT HARVEST in kb_export" -- says `autoCommit` defaults
  TRUE. It now defaults FALSE.
- `9462ab04` "HTTP /api/kb/capture bypasses general confidence clamp" -- describes
  a gap that the provider-level clamp closed.
- `89c3f703` "HTTP capture can forge source" -- provenance normalization now
  overwrites a caller-supplied `source` of `import`/`promotion`.
- `d036ab13` "CaptureSource union lacks 'import'" -- it has `import`.
- `61770438` "user-directive bypasses the clamp and is stamped author=user" --
  the directive gate forces UNVERIFIED pending proposals, and `author=user` is
  stamped only by CLI activation.
- `cf0ce11e` "kb_capture confidence gate ... exception: user-directive" -- the
  exception is inverted for the same reason.
- `4cdf2a5d` `hasOppositePolarity` substring claim -- contradicted by the source.
- `fdaf76cc` "/pm kb-reconcile full flow" -- the retired KB Agent lineage.
- `719b1c16` "Full suite: 2006 passed" -- a point-in-time test count, not durable
  knowledge.
- `768c3e62` -- describes a past state ("were declared but unused BEFORE ...").
- `b9df569a` "kb_export + cold-seed" -- true but silent on the v2 envelope;
  re-captured accurately in gap-fill instead.
- `e4dc6485` "Code intelligence routing in tool descriptions" -- none of its four
  claimed symbols appear in the files it cites.
- **Everything else that survived triage but was not individually verified.** The
  bulk of these are code-intelligence claims about gitnexus internals that this
  pass did not read. They may well be true; they were dropped because promoting
  an unread claim is precisely the failure being corrected.

## Two repointings that judgment rejected

Basename matching proposed both; neither is a real file move.

- `fdaf76cc` `docs/kb-reconcile.md` -> `skills/pm/kb-reconcile.md`: the design
  names this as the retired KB Agent lineage, so it is an obsolete-drop.
- `c35f1927` `.husky/pre-commit` -> `packages/.../apra-pm/.githooks/pre-commit`:
  a different hook in a different package.

## Mechanical drops

### Dropped: no basis (10)

Zero `source_files`. `freshnessSweep()` builds its work set only from entries with a parsed basis, so these could never be staled and nothing could ever falsify them.

- `35899f07` isTestPath matcher: recognizing test files with critical negative cases (T4.3)
- `369fb127` Code intelligence surface: 7-tool ecosystem with telemetry + KB enrichment (Phase 4 sprint-capstone)
- `3dc9718e` LOW finding tracking: code_map/code_flow empty-string telemetry targets (yashr-h3v)
- `46e9af43` Top symbols reporting in fleet_status (T4.2: computeTopSymbols)
- `75ade624` code intelligence health section in check-status
- `b7bedf28` kb_import Phase 2 review findings
- `c1184f49` Code intelligence telemetry: handler-layer placement (D8 principle, T4.1)
- `c275ca15` code-intelligence-gitnexus module structure
- `dd85cf6e` code_tests tool: impact-based test discovery (T4.4)
- `ff1fc29f` Phase 1 kb-branch-reconcile review APPROVED reviewer role

### Dropped: foreign-repo pollution (22)

Cite files that were never in this repository (`PLAN.md`, `feedback.md`, `requirements.md`, `progress.json`, `index.ts`, `templates/`). These came from sprint scaffolding in other checkouts, captured under a contract that never said what not to write down.

- `04e578fa` KB-integrity sprint capstone: trust model made real across 15 tasks (Phase 1-3, APPROVED)
- `05480f94` CRITICAL BUG: call_graph tool does not exist in gitnexus 1.6.7
- `3587e7f4` SPRINT CAPSTONE: KB trust model holds through all 3 phases + measurement + reach
- `4b87fbce` kb_feedback downvote mechanism (T3.1, Phase 3)
- `5755825e` kb commit CLI added and closes Phase 2 LOW-1 (T3.7b, Phase 3)
- `5e97ea10` LOW-2: Theoretical HTTP provider edge case in kb_stats (Phase 2 T2.1)
- `648d7411` Cypher composition toolkit: parseMarkdownTable + asciiSanitizeLabel + extractCypherPayload (T2.1/T2.2)
- `7080bb26` Parameterized LIMIT binds on gitnexus 1.6.7 + LadybugDB (load-bearing risk CONFIRMED)
- `83726d75` FTS5 sanitization is now centralized in query()
- `8de251dc` DIRECTIVE GATE CLOSED: user-directive entries are PROPOSAL-ONLY (F1, D1, closes yashr-9ha)
- `a2781b82` Flagged pipeline e2e resolution: contradiction + feedback flags (T3.7, Phase 3)
- `c5a129ed` LOW-3: kb-session-prime graph-neighbor test failures are environmental (Phase 1 carryover)
- `cbc2e7ff` P4b graph-neighbor expansion design in kb-session-prime wrapper
- `d11067ac` kb-branch-reconcile: Sprint capstone -- team-knowledge story complete
- `d137252c` Embeddings LOCAL classification: --embeddings flag + local ONNX model
- `d9ba91ac` Code-intelligence-hardening sprint: 3-phase risk-frontload structure
- `deb2b048` Phase 2 verification: Cypher integration foundation proven under load (T2.1+T2.2 confirmed)
- `e67ee0d8` Tool descriptions as universal dispatch routing layer
- `ec1f0fa0` PM standing instructions flow: capture -> pending proposal -> CLI approval (T1.4, D1)
- `f173d00a` Global KB bible chain: export -> copy -> cold-seed (T3.3/T3.4/T3.5, Phase 3)
- `f28eaa21` Quantitative model assignment via kb_stats coverage (T3.6, Phase 3)
- `f68e41ae` LOW-1: Dangling command reference in KB drift anomaly message (Phase 2 T2.2)

### Dropped: cites a path absent and not repointable (1)

The cited path has no counterpart anywhere in the current tree.

- `3fa771af` gitnexus analyze injects non-ASCII blocks into AGENTS.md and CLAUDE.md (recurring gotcha)
