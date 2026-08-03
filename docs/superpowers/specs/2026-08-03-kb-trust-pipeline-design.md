# KB trust pipeline: make capture and promote deterministic, then rebuild the bible -- design

Date: 2026-08-03
Branch: chore/merge-main-into-code-intel
Status: design proposed, not approved, not implemented

## Problem

`.fleet/kb-canonical.json` (the bible) claims 97 CONFIRMED entries. The live
project KB holds 6 entries, all INFERRED, 0 CONFIRMED. The bible is entirely
disconnected from the KB it purports to be an export of: running `kb_export`
today would emit approximately 0 entries.

Rebuilding the file is not sufficient. The pipeline that produces it has three
independent failures, and any file rebuilt on top of them re-rots. This design
fixes the pipeline first and rebuilds the bible last.

## Evidence

### The bible does not describe this repository

```
entries                              97
confidence                           CONFIRMED: 97  (100%)
types                                knowledge 78, learning 14, runbook 3, context-cache 2
source_files cited                   209
source_files that do not exist       48
entries citing >= 1 missing file     29  (30%)
distinct missing paths               19
```

The 19 missing paths split into two causes:

- Moved by refactor: `src/kb/kb-server.ts` -> `src/commands/kb-server.ts`,
  `src/services/install.ts` -> `src/cli/install.ts`,
  `src/services/knowledge/kb-session-prime.ts` -> `src/tools/kb-session-prime.ts`
- Never in this repository: `PLAN.md`, `design.md`, `requirements.md`,
  `progress.json`, `feedback.md`, `templates/tpl-planner.md`,
  `templates/doer-reviewer-loop.md`

The second group cannot come from `kb_harvest`: its `FILE_PATH_RE`
(`kb-harvest.ts:30`) only matches paths prefixed `src|lib|test|doc`, so a bare
`PLAN.md` is unreachable by that path. Those entries were agent-authored via
`kb_capture` under a capture contract that never told an agent what not to
write down.

Entry `04e578fa` ("KB-integrity sprint capstone: trust model made real across
15 tasks") is a sprint retrospective citing `feedback.md` and `PLAN.md`. It is
stamped CONFIRMED.

Entry `75ade624` ("code intelligence health section in check-status") has an
empty `source_files` array. Because `freshnessSweep()` keys staleness off
`source_files`, an entry with none can never go stale. It is permanently
CONFIRMED and structurally unfalsifiable.

### Nothing in the running system can mint CONFIRMED

The installed agent personas carry no KB wiring at all:

```
~/.claude/agents/  (written 2026-07-28 21:27, SEA build v0.4.0_502932)
  ci-watcher.md         kb_ refs = 0
  deployer.md           kb_ refs = 0
  doer.md               kb_ refs = 0
  harvester.md          kb_ refs = 0
  integ-test-runner.md  kb_ refs = 0
  planner.md            kb_ refs = 0
  plan-reviewer.md      kb_ refs = 0
  reviewer.md           kb_ refs = 0
```

Installed `reviewer.md` is 162 lines and its Step 5 is `## Step 5 -- Verdict`.
The repo copy (both dev and released) is 210 lines, where Step 0 is Knowledge
Bank and Step 5 is "Promote knowledge you verified". Installed `doer.md` has no
Step 0.

`kb_promote` is the only path that mints CONFIRMED (`kb-capture.ts:97-101`
clamps every incoming CONFIRMED to INFERRED). The installed reviewer has no
instruction to call it. This fully explains the 0 CONFIRMED entries: the 6
INFERRED entries were captured by hand in a prior session, not by the sprint
machinery.

Cause: `loadAgentAssets()` (`install.ts:1201`) reads
`packages/apra-fleet-se/apra-pm/agents/` directly in dev mode, but the installed
SEA binary carries frozen assets that predate the KB work.

This makes `apra-fleet-6w7` ("Step 0 missing from 4 of 8 roles") understated.
In the repo the gap is 4 of 8; on the running system it is 8 of 8.

### The automatic writer has no model in it

`kb_harvest` is the only fully automatic KB writer -- `execute-prompt.ts:808`
fires it after every `execute_prompt`. Its entire extraction logic is three
regexes (`kb-harvest.ts:24-28`):

```js
/(?:I found that|Note:|Warning:|Bug:|Gotcha:|This means)\s*[:\-]?\s*(.+?).../gis
/(?:The (?:issue|problem|fix|solution|root cause) (?:is|was))\s*[:\-]?\s*(.+?).../gis
/(?:Important:|Key insight:|Lesson learned:|TIL:)\s*(.+?).../gis
```

`title` is the first 80 characters, `summary` the first 200, both hard
truncated (`kb-harvest.ts:68-69`). Symbols are any backticked token of length
>= 2. Filters are: length >= 20, and exact-text dedupe.

`This means` and `Note:` are among the most common constructions in LLM prose.
Every explanatory aside in every session becomes a candidate KB entry. Entries
are written at `confidence: 'UNVERIFIED'` (`kb-harvest.ts:131`), so they cannot
reach the bible directly, but they are noise in every subsequent `kb_list` and
`kb_session_prime` result.

### The trust model's justification is circular

`kb-import.ts:13-20` preserves the bible's CONFIRMED confidence as the sole
exemption from the D1 clamp, justified in-code because "the bible is a
git-reviewed, human-merged artifact".

But `kb_export` auto-commits by default (`kb-export.ts:104-110`, default
`true`), as `pm-kb <kb@pm.local>` (`kb-export.ts:156`), mid-sprint, on a feature
branch. The human review that licenses the exemption is a bot commit nobody was
asked to look at.

### The bible round-trip is lossy

`kb_export` emits 8 fields (`kb-export.ts:176-188`): `id, type, title, summary,
symbols, source_files, confidence, updated_at`. It drops `content` and `tags`.
`kb_import` synthesizes `content = summary` and `tags = []`
(`kb-import.ts:88-94`, documented as LOW-2, deliberate for determinism).

An export -> import round-trip therefore permanently flattens every entry to its
summary and discards its tags. The bible is a summary index, not the knowledge.
This rules out "import the 97 and repair them in place" as a lossless option.

### Determinism is available and already used

`packages/apra-fleet-client/src/client/client.mjs` ships a tested
`McpClient.callTool(name, args, opts)`. `runner.js` already accepts an injected
`callTool` in its allowed-inputs set (`runner.js:270`) and uses it for real
work (`runner.js:1798`):

```js
const result = await callTool('member_reservation', { member_name: member, action, sprint_id: sprintId });
```

By contrast, `primeKB()` in `auto-sprint.js:1652` dispatches a Haiku agent with
`maxTurns: 10` whose entire job is to call one tool and parse its JSON, with a
silent-failure escape hatch ("If ToolSearch returns no KB tools, return
{entries:[], sessionWarm:false, imported:false}"). An LLM round-trip is being
spent on a call that has no judgment in it.

## Root cause

Three failures, independent, all upstream of the bible:

1. **Delivery.** The KB contracts are not present in what actually executes.
2. **Enforcement.** Capture and promote quality rests entirely on an agent
   choosing to follow prose. There is no invariant a bad entry cannot pass.
3. **Asymmetry.** The promote contract (`reviewer.md` Step 5, ~30 lines with 5
   hard limits) is rigorous. The capture contract (`doer.md:61-62`, 2 lines) has
   no negative space at all -- it never says what not to capture.

The bible is a symptom of all three.

## Design

Four phases, strictly ordered. Each is independently shippable and independently
verifiable.

### Phase 0 -- restore the executing contracts

Reinstall the agent personas so the 210-line contracts are what run.

- Dev-mode install (`loadAgentAssets()` already sources the repo), or rebuild
  the SEA so its embedded assets are current.
- Acceptance: `grep -c kb_ ~/.claude/agents/reviewer.md` > 0, installed
  `reviewer.md` is 210 lines, and its Step 5 heading is
  "Promote knowledge you verified".

Close the 4-of-8 Step 0 gap (`apra-fleet-6w7`) in the same pass: add Step 0 to
`plan-reviewer.md`, `deployer.md`, `integ-test-runner.md`, `ci-watcher.md`.

Also fix the install overlay footgun found during this audit (new bead): root
`skills/pm/` is copied over the apra-fleet-se PM skill with `fs.copyFileSync`
(`install.ts:411-422`, called at `install.ts:1039` and `install.ts:1051`). Both
directories contain `SKILL.md`, `doer-reviewer-loop.md` and `simple-sprint.md`,
so if that overlay ever runs, the root 4-role `SKILL.md` silently clobbers the
apra-fleet-se 8-role one. It did not run on the current machine, which is why
the installed PM skill is intact.

### Phase 1 -- push invariants into the provider choke point

**Enforcement belongs in `SqliteProvider.capture()`, not in `src/tools/kb-*.ts`.**
Four call sites reach `provider.capture()` independently, and only one of them is
the `kb_capture` tool:

```
src/tools/kb-capture.ts:122     the MCP tool
src/tools/kb-harvest.ts:134     the automatic writer
src/tools/kb-import.ts:172      bible import (importMode)
src/commands/kb-server.ts:139   HTTP POST /api/kb/capture
```

An invariant placed in the tool layer would be bypassed by three of the four.
The codebase already solved this for the D1 clamp and documents the reasoning at
`sqlite-provider.ts:666-671`:

> general confidence clamp -- the ENFORCEMENT copy. The kb_capture tool handler
> (kb-capture.ts) also clamps and returns a confidence_clamped UX flag to MCP
> callers, but the HTTP /api/kb/capture [path bypasses it]. This block is the
> single enforcement [point].

New invariants follow that established pattern -- enforcement in the provider,
optional UX flags in the handlers:

- **Capture fails closed on an uncheckable basis.** `SqliteProvider.capture()`
  rejects an entry with zero `source_files`, and rejects `source_files` that do
  not exist in the target repo. Decided 2026-08-03: a KB entry nobody can check
  has negative value, and `freshnessSweep()` can never stale it.
- `kb_promote` requires a non-trivial `reason`. Promotion without a recorded
  evidence string is refused.
- `kb_promote` refuses to promote an entry whose `source_files` no longer
  resolve.
- `kb_export` defaults `bible.autoCommit` to `false`. The trust exemption in
  `kb-import.ts` assumes human review; the default should make that possible
  rather than pre-empt it.

**Import is NOT exempt from the source_files rule.** `importMode` exempts the
confidence clamp only (`sqlite-provider.ts:710`). An unfalsifiable entry must
not enter through any path, including a legacy bible. This is deliberate: it
means re-importing today's `kb-canonical.json` drops its zero-`source_files`
entries, which is the intended outcome.

**Fail-closed must not break the batch.** `kb_harvest` loops over extracted
learnings calling `provider.capture()` per entry (`kb-harvest.ts:117-142`) and
is dispatched fire-and-forget with a bare `.catch()` at
`execute-prompt.ts:811`. If a rejection throws, the first bad entry aborts the
remaining ones and the whole harvest dies silently. Required behavior:

- each capture is isolated -- a rejected entry is counted and the loop continues
- the return payload gains a fourth counter alongside the existing three
  (`kb-harvest.ts:144`): `{entries_captured, entries_updated, entries_skipped,
  entries_rejected}`

Expect `entries_rejected` to dominate at first. That is the correct signal, not
a regression: harvest's regex extraction (`kb-harvest.ts:24-28`) frequently
yields no file paths at all, and those entries were never checkable.

### Phase 2 -- engine-executed capture and promote

Split plumbing from judgment.

Plumbing has no judgment in it and must not cost an LLM turn. The engines call
these directly through the injected `callTool`, exactly as
`member_reservation` already does:

```
kb_session_prime, kb_import, kb_export, kb_list
```

This replaces `primeKB()`'s Haiku dispatch in `auto-sprint.js` and gives
`fleet-sprint/runner.js` KB priming it currently lacks (`apra-fleet-e28`).

Judgment stays with the LLM, but the agent returns a decision rather than
making the call. Extend the structured-output schemas of every role that
captures today -- doer, reviewer, planner and harvester:

```
DOER_STATUS_SCHEMA += kb_captures:   [{ type, title, summary, source_files, symbols }]
REVIEW_SCHEMA      += kb_promotions: [{ id, reason }]
                   += kb_captures:   [ ... ]
HARVEST_SCHEMA     += kb_captures:   [ ... ]
PLANNER_SCHEMA     += kb_captures:   [ ... ]   (new schema -- see below)
```

The engine validates the payload and makes the `kb_capture` / `kb_promote`
calls itself. Three consequences:

- Promotion no longer depends on an agent remembering to call a tool.
- Every promotion is logged by the engine with its stated evidence.
- The engine can refuse a promotion before it is attempted.

`kb_promotions` stays reviewer-only. The reviewer remains the sole role that
mints CONFIRMED; widening capture does not widen promotion.

**The planner needs a new output schema.** Seven roles have generated output
contracts (`agents/schemas/<role>-output.json`): reviewer, plan-reviewer, doer,
deployer, integ-test-runner, ci-watcher, harvester. The planner has none -- its
dispatch (`auto-sprint.js:2377`) passes no `schema` and ends "Confirm with any
text when done." Adding planner capture therefore requires:

- a new `agents/schemas/planner-output.json`
- regenerating the inlined block via `scripts/gen-auto-sprint-schemas.mjs`
  (the region is marked `ROLE_SCHEMAS_GENERATED_BEGIN`, do not hand-edit)
- converting the planner dispatch to structured output

This is a larger change than the other three roles and should be its own task.
The harvester, by contrast, already has `HARVEST_SCHEMA` (`auto-sprint.js:1502`,
currently `{status, notes}`) and only needs the field added.

The change is additive. All new fields are optional; an engine that does not
populate them behaves exactly as it does today.

### Phase 3 -- rebuild the bible

Only after Phases 0-2. Approach: triage, then verify.

**Step 1: mechanical triage.** Classify all 97 entries offline against the
current tree. No tool calls, no writes.

| Bucket | Disposition |
|---|---|
| All `source_files` live, claim still plausible | candidate |
| Cites a path moved by refactor | candidate, path repointed |
| Cites a path never in this repo | drop (foreign-repo pollution) |
| Describes pre-refactor architecture | drop (obsolete) |
| Zero `source_files` | drop (unfalsifiable) |

Expected drops include every entry describing the retired KB Agent lineage,
since `docs/kb-review.md` and `docs/kb-reconcile.md` in the bible correspond to
`skills/pm/kb-review.md` and `skills/pm/kb-reconcile.md` -- an architecture that
no longer exists.

**Step 2: verification gate.** Survivors re-enter as candidates only. Each is
checked against the current tree and earns CONFIRMED through `kb_promote` with
a recorded reason, under the Phase 1 invariants. Anything that fails
verification is dropped, not patched.

**Step 3: gap-fill.** Capture entries for what the refactor created and the
bible has no coverage of: the `fleet-sprint` engine, the deterministic
auto-sprint workflow, the 8 role contracts, `getKbProviders` repo-scoping, and
the two-plane KB/code-intelligence split.

**Step 4: export.** A single `kb_export` with `autoCommit` false, followed by a
deliberate reviewed commit.

### Phase 3a -- the bible records its export commit

The bible must record the commit it was exported from, so a later audit can date
its entries against the tree they were verified on. Today the file carries no
provenance at all, which is why a bible harvested from other repositories was
indistinguishable from a real one.

This is a file-format change. `kb_export` currently writes a bare JSON array
(`kb-export.ts:198`) and `kb_import` throws on anything else
(`kb-import.ts:121-122`):

```js
if (!Array.isArray(parsed)) {
  throw new Error('kb_import: bible file is not a JSON array of entries: ' + biblePath);
}
```

New shape:

```json
{
  "version": 2,
  "provenance": { "commit": "<40-char sha>", "branch": "<name>", "entry_count": 97 },
  "entries": [ ... ]
}
```

Compatibility is a hard requirement in both directions:

- `kb_import` must accept BOTH shapes -- a bare array (legacy, version 1) and
  the object form -- selecting on `Array.isArray(parsed)`. An older bible must
  keep importing unchanged.
- A v2 bible fed to an older apra-fleet will throw the error above. That is
  acceptable and expected, but it means the import-side change must ship before
  or with the export-side change, never after.

**Record the commit, not a timestamp.** `kb_export` sorts entries by id
"so re-exports produce meaningful diffs" (`kb-export.ts:178`). An `exported_at`
timestamp would defeat that: every export would produce a diff even when no
entry changed, turning the git history into noise. The commit sha changes only
when the tree it was verified against changes, which is exactly the signal
worth recording. `entry_count` is derivable but cheap and makes truncation
visible in a diff -- which is precisely the failure mode of `apra-fleet-ong`.

Resolve the sha with `git rev-parse HEAD` in `repoPath`, degrading gracefully
when the repo has no commits or git is unavailable (write `null`, do not throw).
The existing `asciiSafeStringify` path still applies.

## Why this order

Phase 3 before Phase 0 would rebuild the file, then run sprints that capture and
promote nothing, and the file would drift from the first sprint onward.

Phase 3 before Phase 1 would produce a file whose entries were admitted under
the same loose rules that produced the current one.

Phase 3 before Phase 2 would work, but every subsequent maintenance cycle would
again depend on an agent remembering Step 5.

Phases 0 and 1 are independently valuable and can ship without Phase 3.

## Alternatives considered

**Curate the bible in place.** Import the 97, repoint moved paths, drop the
foreign entries, re-export. Rejected: the export -> import round-trip flattens
`content` to `summary` and drops `tags` (`kb-import.ts:88-94`), so this is not
lossless repair; and it re-blesses 97 entries under the same rules that admitted
them.

**Clean-room rebuild.** Empty the bible and re-derive everything. Rejected as
the primary approach because it discards entries that are still true, at
significant cost. Phase 3's triage is the cheaper first pass, and its Step 1
reveals how much is salvageable before any expensive verification is committed.

**Restore the KB Agent role** (`skills/pm/kb-agent.md`, `tpl-kb-agent.md`).
Rejected on its promotion basis. That model is verdict-gated: on APPROVED it
"promotes existing INFERRED entries touching approved symbols". That is
promotion by module, which the current contract forbids explicitly ("Never
blanket-promote ... do not promote by module, tag, or timestamp"), and it
conflates two different claims -- an APPROVED verdict means the code is correct,
not that a prose statement about the code is true. The structural idea (a
dedicated cheap agent for KB curation, so the reviewer is not doing two jobs) is
worth keeping and is compatible with Phase 2.

**Fix `apra-fleet-ong` first.** Not a prerequisite. The `autoCommit` off-switch
already exists (`kb-export.ts:104-110`) and de-fangs the destructive half of the
`kb_import` -> `kb_export` composition without a code change. Phase 1 makes
`false` the default. The underlying composition bug remains `ong`'s scope.

## Out of scope

- `apra-fleet-ong` (bible truncation on import -> export composition)
- `apra-fleet-rv0` (auto-reindex spawns `npx gitnexus analyze` at
  `code-intelligence-reindex.ts:83` while the default provider is
  `codebase-memory`, so nothing re-indexes on a default install)
- Replacing `kb_harvest`'s regex extraction with a model. Phase 1's invariants
  blunt its worst output; redesigning it is a separate piece of work.
- The retired root `skills/pm/` lineage beyond the overlay fix in Phase 0.

## Test impact

- Phase 0: assert installed contract parity -- a test that the installed
  persona set matches `packages/apra-fleet-se/apra-pm/agents/*.md`, so a stale
  SEA build fails loudly instead of silently disabling the KB.
- Phase 1: per-invariant rejection tests (zero `source_files`, non-existent
  path, missing promote reason, stale-basis promote). Each must fail before the
  fix and pass after. Because enforcement is in the provider, assert rejection
  through EVERY call site, not just the tool: `kb_capture`, `kb_harvest`,
  `kb_import`, and the HTTP `POST /api/kb/capture` path covered by
  `tests/knowledge/kb-server.test.ts`. Add a batch-isolation test: a harvest
  containing one rejectable and one valid entry must store the valid one and
  report `entries_rejected: 1`.
- Phase 2: engine-level tests that a schema payload results in the
  corresponding tool call, and that a malformed or unverifiable payload results
  in no call. Follow the two-repo pattern in
  `tests/knowledge/kb-repo-isolation.test.ts`. Include a test that a
  `kb_promotions` payload from a non-reviewer role is rejected.
- Phase 3a: round-trip tests for BOTH bible shapes -- a legacy bare array and a
  v2 object -- must import identically. A v2 export followed by a v2 import
  must preserve the entry set. Assert that two exports at the same commit with
  the same entries produce byte-identical files (the no-timestamp property).
- Baseline to hold: 244 files / 3285 tests, 0 failures.

## Decisions taken

- **Capture roles (2026-08-03).** `kb_captures` is accepted from doer,
  reviewer, planner and harvester. `kb_promotions` stays reviewer-only. The
  planner requires a new output schema; see Phase 2.
- **Bible provenance (2026-08-03).** The bible records the commit it was
  exported from. This is a v2 file-format change with dual-shape import; see
  Phase 3a.
- **Capture fails closed (2026-08-03).** No exemption for `source='harvest'`
  or for `importMode`. An entry with no checkable basis is rejected on every
  path. `kb_harvest` is expected to write materially fewer entries as a result;
  its precision, not its volume, is the thing worth preserving. See Phase 1.
- **Enforcement layer (2026-08-03).** Invariants go in
  `SqliteProvider.capture()`, not the tool handlers, because three of the four
  capture call sites bypass the tool layer. This follows the existing D1 clamp
  precedent at `sqlite-provider.ts:666`.

## Open questions

None blocking. All three questions raised during design are resolved above.
