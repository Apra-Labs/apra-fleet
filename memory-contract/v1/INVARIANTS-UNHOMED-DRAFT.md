# memory-contract/v1 -- unhomed invariant drafts

Status: DRAFT. **NOT part of the normative contract.** Nothing in this file is
binding on an implementation yet.

These four guarantees were verified against source and written to the same
four-part pattern as `spec.md` section 4 (rule / proof / obligation / test
hook), but they have NO agreed home in that section. Placement is an OPEN
DECISION for a human, and deliberately not taken here. The live options are:

- new `4.7`-`4.10` subsections of their own;
- folded into an existing `4.1`-`4.6` subsection (each draft below names the
  candidate);
- moved into section 3 prose, where the error model already lives.

Creating the headings would BE the placement decision, so this file exists
instead and `spec.md` is untouched by the task that wrote it. The headings here
are deliberately `U1`-`U4`, not `4.x`, so nothing resolves against them:
`taxonomy.json` `see_also` strings and `schemas/*.json` `x-invariant` ids point
at `spec.md`'s frozen `### 4.x` titles only.

This file is expected to be FOLDED IN or DELETED once placement is decided. It
is not a permanent second home for invariant text -- `spec.md`'s own rule
stands: one sentence, one home.

## U1 -- Falsifiability admission

Placement candidate: a subsection of its own, or an extension of `4.2`.

**THE RULE.** A provider MUST refuse, at its capture entry point, an entry that
cites no source files at all (`E-NO-BASIS`), and MUST refuse an entry whose
cited files are CHECKABLE and absent from the tree the provider is anchored at
(`E-BASIS-MISSING-FILES`). A cited path is checkable when it is absolute, or
when the provider carries a repo anchor to resolve it against; a RELATIVE path
under a provider with NO anchor is not checkable and MUST NOT be reported
missing. Neither refusal MAY be exempted for a bulk writer: a harvest run and a
bible import are held to exactly the same admission gate as an interactive
capture. A `type='user-directive'` entry is exempt from the zero-files half
only -- `4.3` owns that exemption and this rule does not restate it -- and
stays subject to the missing-files half. A provider MUST apply the identical
checkable-and-absent predicate at its PROMOTION entry point as at capture.

**THE PROOF.** One gate does both halves: `assertCheckableBasis`,
`src/services/knowledge/sqlite-provider.ts:334-356`, called unconditionally
from `capture()` at `:843`. The zero-files branch is `:337-345` (the directive
early return at `:338`, nested inside it, is `4.3`'s); the checkable-and-absent
branch is `:347-355` and carries no type exemption. Checkability is decided by
`unresolvableBasisFiles` (`:294-299`), whose first line
(`:296`, `if (this.repoPath === undefined && !path.isAbsolute(f)) return false`)
is what makes the second half anchor-conditional: under the shared global KB,
which has no `repoPath`, a relative cited path is not reported missing and the
entry is admitted. The comment at `:288-293` states that `capture()` and
`promote()` MUST apply that identical rule, "or an entry that was legitimately
capturable would be permanently un-promotable"; `promote()` honors it by calling
the same helper at `:1377`. There is no bulk-writer exemption: the rationale
comment at `:833-835` says so in terms ("NO exemption for `source='harvest'`
or for `importMode`. Import is exempt from the confidence clamp only"), and both
bulk writers prove it by COUNTING their rejections instead of avoiding them --
`src/tools/kb-harvest.ts:147-153` and `src/tools/kb-import.ts:228-234` each
catch the rejection per entry and continue. The stated reason the zero-files
half exists at all (`:827-831`) is that the freshness sweep builds its work set
only from entries with a parsed basis, so a basis-less entry is never checked
and can never be staled; `4.5` owns how that basis is computed and how it
resolves when no anchor is configured.

**THE OBLIGATION.** A second implementation MUST enforce both halves at the
provider-level capture entry point, not in a request handler -- three of the
four capture routes never reach `src/tools/kb-capture.ts` (`4.3` names them).
It MUST NOT enforce the missing-files half unconditionally: refusing a relative
cited path under an unanchored provider refuses captures this kernel accepts,
which is a behavior change dressed as strictness. It MUST use ONE shared
predicate for capture and promotion; two predicates that drift produce an entry
that can be written and can never be promoted. And it MUST NOT add a
high-volume exemption for convenience: harvest is the highest-volume writer and
the one whose extraction most often yields no file paths, which is precisely
why it is not exempt.

**THE RATIONALE.** This rule is expected to evolve by WIDENING what counts as a
checkable basis -- admitting new classes of evidence a claim can be held
against -- and never by WEAKENING it into admitting evidence-free claims. The
asymmetry is not stylistic. An unfalsifiable entry is the memory-poisoning
vector: a claim with nothing to check cannot be disproved, so it never stales,
never loses standing, and compounds -- it keeps being retrieved and keeps
shaping later work, and each retrieval looks like corroboration. Every other
trust mechanism in this contract is downstream of a basis existing: freshness
staling reads it, promotion re-checks it, contradiction prefiltering re-hashes
it. Admit one entry with no basis and none of those mechanisms can reach it
again. So future flexibility comes from NEW EVIDENCE KINDS only, and a proposal
to relax admission is a proposal to reintroduce the vector.

**THE TEST HOOK.** `no-basis rejection` -- assert a zero-`source_files` capture
is refused on every non-directive type, assert a capture citing a file absent
from an ANCHORED tree is refused, and assert a bible carrying such an entry
reports it in `rejected` rather than importing it (fixtures
`fixtures/kb_capture/refusal-no-basis.json`,
`fixtures/kb_capture/refusal-basis-missing-files.json`,
`fixtures/kb_import/refusal-import-entry-rejected.json`). The anchor-conditional
half of the predicate has no fixture: it needs a provider with no `repoPath`,
which the harness does not construct.

## U2 -- The v2 bible envelope

Placement candidate: a subsection of its own, possibly merged with `U3` as one
"import channel" subsection.

**THE RULE.** An implementation that exports a shareable bible MUST record its
provenance as exactly ONE FILE-LEVEL block, `{commit, branch, entry_count}`,
and MUST NOT anchor entries individually: no per-entry commit, sha, or anchor
field exists in the exported entry shape, and a reader MUST NOT expect one.
`commit` and `branch` MUST each degrade to `null` rather than failing the
export when git is absent or the repo has no commits; the BLOCK itself is
always present in a v2 file, while a legacy v1 bible (a bare JSON array) has no
provenance at all, and an importer MUST accept both shapes. Change detection
MUST compare the ENTRIES and MUST ignore the provenance block. An importer MUST
report `skipped` and `rejected` as DIFFERENT outcomes: `skipped` covers a
malformed entry, an id already present, and an AUDN dedup no-op; `rejected`
covers an admission failure (`E-IMPORT-ENTRY-REJECTED`, surfaced in the
response's `rejected` field, not thrown).

**THE PROOF.** The exported entry shape is `CanonicalEntry`,
`src/tools/kb-export.ts:48-57` -- `{id, type, title, summary, symbols,
source_files, confidence, updated_at}`, eight fields, no commit among them.
Provenance is the sibling block on the envelope: `CanonicalBible`
(`src/tools/kb-export.ts:64-73`), populated once at `:385-393` from
`resolveHeadCommit` (`:80-82`) and `resolveBranch` (`:84-86`), both of which
route through `gitOrNull` (`:109-119`) and return `null` on a non-repo, a
missing git binary, or a repo with no commits. The committed artifact agrees:
`.fleet/kb-canonical.json` is a v2 envelope whose 24 entries have a UNION of
exactly those same eight keys -- there is no per-entry commit or anchor field
in it. Change detection is `entriesUnchanged` (`:95-107`), which parses the
existing file, takes `parsed.entries` or the bare array (`:99-101`), and
compares only that against the next entries JSON (`:103`); the early return at
`:381-383` means a moved HEAD alone never rewrites the file. The comment at
`:373-379` records why: the export auto-commits, so re-reading HEAD on the next
export would record a different commit, rewrite, and commit again -- an export
that never converges. Leaving the file alone also keeps the recorded commit
honest, naming the tree those entries were last verified against rather than
the commit that stored them. On the import side, `isValidBibleEntry`
(`src/tools/kb-import.ts:98-109`) type-checks `id`, `type`, `title`, `summary`,
`confidence` and the two optional arrays and NOTHING else -- it does not look
for a commit field, so a per-entry anchor could not be honored even if a file
carried one. The two-shape selection is `:161-169`. The counters are
`KbImportReport` (`:120-133`) and increment at four distinct sites:
`skipped` at `:184-187` (malformed), `:193-196` (`hasEntry(entry.id)`, checked
BEFORE capture so a re-import is exact even for entries AUDN can never dedupe)
and `:237` (`audn_decision === 'none'`); `rejected` only at `:228-234`, when
`capture()` throws the admission rejection (U1). The remaining decisions have
their own counters -- `imported` for `add` (`:236`), `linked` for `update`
(`:243`), `flagged` for `flagged` (`:244`) -- and the comment at `:238-242`
records that counting `update` as a supersession "reported a retirement that
never happened."

**THE OBLIGATION.** A second implementation MUST NOT introduce a per-entry
commit field to "strengthen" provenance: the guarantee is file-level, callers
and audits are written against a file-level block, and per-entry anchors would
change the diff shape of a committed artifact that is reviewed by humans. It
MUST keep change detection entries-only -- including provenance in the
comparison produces an export that rewrites and re-commits on every HEAD move,
which is the non-convergence the design explicitly avoids. It MUST keep the two
counters distinct and MUST NOT sum them into "not imported": that is the trap,
because the two mean opposite things. A `skipped` entry is fine -- it is already
here, or it is not an entry at all -- while a `rejected` entry was DROPPED for
being unfalsifiable, and a bible re-imported into a different worktree can lose
entries that way. An implementation that reports one number silently miscounts
exactly the case an operator needs to see.

**THE TEST HOOK.** No assertion in the conformance list matches this; checked by
the round-trip harness, which exercises `kb_export` and `kb_import` happy-path
fixtures plus `fixtures/kb_import/refusal-import-entry-rejected.json`
(`tests/roundtrip-harness.mjs`). The envelope-vs-entry provenance split and the
skipped/rejected distinction are both response-body facts, so they inherit
`tests/DEGRADATION.md` D-4: `parsed` is a consumer-side decode, never a
schema-checked wire field.

## U3 -- Import trust tiers

Placement candidate: fold into `4.2`, where the `importMode` clamp exemption
already lives -- or merge with `U2` as one "import channel" subsection.

**THE RULE.** Trust MUST derive from the CHANNEL an entry arrived through, never
from anything the content asserts about itself. Two tiers exist here: a
repo-resolved bible is the git-reviewed trusted channel, and an import from a
caller-supplied explicit path is CALLER-ASSERTED trust, equivalent in weight to
a promotion claim, not to a review. A provider MUST NOT honor a trust
assertion carried IN the imported document -- frontmatter, a self-declared
tier, a provenance field naming itself trusted, or any future equivalent -- as
authority for anything; it MAY read such a field only as data. An import MUST
NOT be able to introduce an ACTIVE directive: an imported `user-directive` lands
quarantined under `4.3` on every import channel, whatever the file says.

**THE PROOF.** The two tiers are stated at the tool boundary itself
(`src/tools/kb-import.ts:25-33`, and in the `path` field's own description at
`:37-38`): the git-reviewed rationale "only holds for the repo-resolved
`.fleet/kb-canonical.json`; an explicit `--path` bible is CALLER-ASSERTED
trust," equivalent in power to the already-exposed promotion surface rather than
a new privilege class. Path selection is `:138` -- the caller's `path` when
given, else `<repo>/.fleet/kb-canonical.json`. The defense against
self-asserted trust is STRUCTURAL, not a filter: the provider input is
constructed field by field at `:198-214`, so a field the loop does not name
cannot reach storage at all. `author` is hard-coded `'unknown'` (`:210`, with
the comment "bible entries carry no author; the trusted channel is the
provenance"), `source` is hard-coded `'import'` (`:211`), `scope` is hard-coded
`'project'` (`:213`, matching the `z.literal('project')` at `:50-51`), `tags`
is `[]` (`:205`), `flagged_for_review` is `false` (`:208`), and `content` is
synthesized deterministically from the summary (`:202`, `:116-118`) because a
bible entry has no content field. Exactly TWO values are taken from the file --
its `confidence` (`:212`) and its `id` (as `preferredId`, `:224-227`) -- and
both are honored because the CHANNEL was trusted enough to run the import, not
because the file claimed them. `isValidBibleEntry` (`:98-109`) reinforces this:
unknown keys are neither validated nor copied. The directive floor holds on both
tiers because the quarantine is provider-side, inside `capture()`
(`src/services/knowledge/sqlite-provider.ts:806-818`), and `importMode` does not
reach it: import mode exempts only the confidence clamp (`:889`) and the
privileged-`source` normalization (`:873`), both of which sit AFTER the
directive gate. That is exactly why channel trust has to be structural rather
than declared. `4.2` records the clamp exemption as reachable only through a
non-serializable second parameter of `capture()`; an explicit-path bible is
still permitted to carry `CONFIRMED` through it, so the only thing standing
between a hand-authored file and minted trust is which channel invoked the
import -- a property of the call, which cannot be forged from inside the
document.

**THE OBLIGATION.** A second implementation MUST decide trust from the arrival
channel and MUST NOT add a content-readable field that raises it. Any FUTURE
import channel MUST be classified explicitly into one of the two tiers before
it is wired to a trust exemption -- an unclassified channel defaults to
caller-asserted, never to reviewed. It MUST construct its provider input from
an explicit field list rather than spreading a parsed document, so an
unrecognized key cannot become provenance; a permissive spread is the trap,
because it makes the exemption in `4.2` reachable by anything a file cares to
declare. And it MUST route imported directives through the same quarantine as
an interactive capture: an import path that bypasses the directive gate makes
a hand-written file an activation route, which `4.3` guarantees does not exist.

**THE TEST HOOK.** `directive-smuggling-impossible` covers the directive half --
capture a `user-directive` through the import path and read it back
UNVERIFIED, flagged, `directive:pending`, project scope. The channel-trust half
has no matching assertion and no `tests/DEGRADATION.md` entry: the two tiers
differ only in which argument the caller supplied, and both produce an
identical, valid request document, so nothing in a request/response pair
distinguishes them.

## U4 -- Contradiction-resolution refusal, and the absence of a demote

Placement candidate: a subsection of its own; the absence half follows the
precedent of `4.3`'s `**THE POLICY.**` block, which documents a capability that
does not exist.

**THE RULE.** Contradiction detection at capture time MUST FLAG and MUST NOT
resolve: both entries stay live, the newer one recording that it disputes the
older. Resolution MUST be a single explicit operation, and it MUST REFUSE,
writing NOTHING, when the two ids do not form a genuine contradiction pair
(`E-RESOLVE-NOT-A-PAIR`), when either is already superseded
(`E-RESOLVE-ALREADY-SUPERSEDED`), when either does not exist
(`E-RESOLVE-MISSING-ENTRY`), or when either side is an ACTIVE user-directive
(`E-RESOLVE-DIRECTIVE-PAIR`). Feedback on an entry MAY flag it and MAY stale it
but MUST NOT alter its confidence. And no operation in this surface, given an
entry id, MAY lower that entry's stored confidence: there is NO demote. An
entry leaves circulation through a validity transition -- superseded, stale,
disputed -- never through losing confidence.

**THE PROOF.** The flag-only path is `src/services/knowledge/audn.ts:196-206`:
a contradiction signal returns `decision: 'flagged'` with
`contradiction_of: candidate.id` and `confidence: 'UNVERIFIED'` on the NEW
entry; the provider acts on it at `sqlite-provider.ts:693-698` by setting
`flagged_for_review = 1` on the existing row and inserting the new one. Nothing
is retired. Resolution is `resolveContradiction`
(`sqlite-provider.ts:1545-1615`), and all four refusals precede the first write
at `:1583-1585`: missing entry `:1554-1556`, already-superseded `:1560-1562`,
not-a-pair `:1564-1566` (`loser.contradiction_of === winner.id ||
winner.contradiction_of === loser.id`, either direction, because the pair is
asymmetric), active directive `:1569-1571`. The stated reason for the pair check
(`:1513-1521`) is that without it "any caller could mint CONFIRMED from any
tier in ONE call and permanently retire an arbitrary unrelated entry." The
mechanical prefilter does not weaken this: `reconcilePrefilter`
(`:1631-1690`) re-hashes both sides of each flagged pair and, when exactly one
side fully matches, calls `resolveContradiction` (`:1679`, `:1682`) rather than
writing directly -- so every refusal above applies to it too -- while
ambiguous pairs are pushed to `left_for_agent` (`:1685`) untouched, and
directive pairs are excluded twice over (`:1646-1654` and again inside the
resolution). Feedback: `src/tools/kb-feedback.ts:39-48` delegates to
`sqlite-provider.ts:1428-1453`, whose two UPDATE statements set
`flagged_for_review` and `content` for an active directive (`:1444-1446`) or
`stale`, `flagged_for_review` and `content` otherwise (`:1447-1449`). Neither
names `confidence`; the response echoes it back (`kb-feedback.ts:47`) so a
caller can observe it unchanged, and a downvoted CONFIRMED entry stays
CONFIRMED-but-stale-flagged. On the absence: the provider writes `confidence`
after insertion at exactly four sites, and no one of them is addressable as a
demote -- `:1412` (`promote()`, a one-step upward ladder, `:1389-1396`, where
CONFIRMED is a no-op), `:1584` (the resolution winner, always up to CONFIRMED),
`:1732` (directive activation, up to CONFIRMED), and `:757`
(`decayConceptEntries`). Retirement never touches the tier: the resolution loser
gets `superseded_at`, `stale` and a cleared flag (`:1612-1614`) and keeps its
confidence, and a rejected directive likewise gets only `superseded_at` and
`stale` (`:1752`) even when it was ACTIVE.

**THE DEMOTE THAT IS NOT ONE.** `decayConceptEntries`
(`sqlite-provider.ts:746-765`) is the sole downward confidence write in the
provider: `SET confidence = 'UNVERIFIED' WHERE confidence = 'INFERRED'` (`:757`)
over rows that are unsuperseded, untouched since a cutoff, exempt if an ACTIVE
directive, AND cite NO source files. It is not a demote in the sense this rule
forbids -- it takes no entry id, it is a time-and-predicate sweep, and it runs
as a side effect of `prime()` (`:1200`), not as an operation a caller asks for
by name. It is also LEGACY-ONLY BY CONSTRUCTION, and that is the interlock worth
recording: its predicate matches only zero-basis rows, and `U1`'s admission gate
now refuses to create one, so the ladder cannot fire for anything captured after
that gate landed. The code says as much itself (`:735-745`), including that the
modern mechanism is a stale FLAG, not a confidence downgrade (`:742-744`). One
precision an implementer needs: the decay window is not caller-settable on the
MCP tool -- `src/tools/kb-session-prime.ts:11-27` does not declare it and the
`prime()` call at `:204-208` passes only the three hint fields -- but
`PrimeOptions` does carry `decay_after_days`
(`src/services/knowledge/types.ts:156`) and the HTTP prime route parses a
request body straight into it (`src/commands/kb-server.ts:184-191`), so on that
route the cutoff IS caller-supplied. Still not addressable to an entry, but not
purely internal either.

**THE OBLIGATION.** A second implementation MUST make resolution refuse before
writing anything -- a partial resolution that retires a loser and then fails
the pair check leaves an entry retired with no winner, which no later call can
undo. It MUST route every resolution write, including mechanically-decided ones,
through that single refusing operation rather than reimplementing the UPDATE
pair next to a prefilter. It MUST NOT let feedback touch confidence. And it MUST
NOT invent a demote route to "fix" a bad entry, however natural that reads: the
sanctioned move is a VALIDITY TRANSITION -- supersede it, stale it, or flag it
as disputed -- and a demote would break the interlock above by manufacturing
exactly the low-tier, low-attention rows the freshness and admission mechanisms
were built to make impossible. That is the trap in this whole subsection: the
surface looks like it is missing an obvious operation, and the missing operation
is the guarantee.

**THE TEST HOOK.** `resolution refusal` -- drive each of the three
tool-reachable refusals and assert nothing was written, reading BOTH entries
back unchanged (fixtures
`fixtures/kb_resolve_contradiction/refusal-not-a-pair.json`,
`refusal-already-superseded.json`, `refusal-resolve-missing-entry.json`; the
already-superseded case is state-dependent, `tests/DEGRADATION.md` D-6). The
active-directive branch is not reachable from this surface at all --
`tests/DEGRADATION.md` D-9 lists `E-RESOLVE-DIRECTIVE-PAIR` among the states no
tool call can construct. `feedback-never-touches-confidence` covers the feedback
half: downvote a CONFIRMED entry and assert the response reports CONFIRMED with
`stale` and `flagged_for_review` set. The absence of a demote is not
mechanically checkable by a conformance assertion -- an absent operation has no
call to make -- and no `tests/DEGRADATION.md` entry currently records it; the
nearest observable proxy is asserting that no declared tool accepts a
confidence-lowering argument.
