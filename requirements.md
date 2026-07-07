# Requirements -- KB Branch Reconcile

Sprint epic: yashr-ii1. Branch: feat/code-intelligence-abstraction (base: main).
Binding decisions in design.md (D1-D6) -- read before planning.

## Background

Two developers or two branches of one repo produce different learnings. The
bible (.fleet/kb-canonical.json, committed per branch) already merges through
git, but: a warm local KB never absorbs a merged-in bible (no kb_import; the
cold-seed fires only under COLD_KB_MAX=3); prime on branch B permanently stales
branch A's still-valid entries (stale is one-way, yashr-mwd); and when two
branches carry contradicting claims, nothing arbitrates them against the merged
code. The user's requirement (2026-07-07): when branches merge, learnings merge
too, and on contradiction "look into the code and fix."

Beads sources: yashr-mwd (stale poisoning), yashr-c5h (reconcile ladder,
consolidated design), yashr-bwc (KB test isolation), yashr-f3g (HTTP clamp),
plus the timezone test debt (yashr-302).

## Phase P1 -- Hygiene + trust + staleness core

**F1 Zero the allowed-failure list (yashr-bwc + yashr-302).** FIRST task of the
sprint so every later VERIFY requires a fully green suite:
- kb-session-prime tests must not read the machine's real KB or bible
  (4 leaking tests in the graph-neighbor/cold-seed blocks): isolate via temp
  dirs / mocked resolveRepoPath per test.
- tests/time-utils.test.ts: make the 2 timezone-dependent assertions
  TZ-independent (fixed offsets or forced TZ), so they pass on any machine.
- After F1, the allowed-failure list is EMPTY -- all later VERIFYs require
  0 failures.

**F2 Re-checkable staleness (yashr-mwd).** checkFreshness at prime currently
only sets stale=1. Make staleness bidirectional (design D2): when an entry's
stored per-file hash basis MATCHES the current worktree files again, clear
stale (stale=0) so switching back to branch A revives its still-valid entries.
Never un-stale entries staled for other reasons (superseded, feedback-flagged
-- see D2 for the discriminator). Fail-then-pass test: capture on A, modify
file (B state) -> stale; restore file (A state) -> primed again.

**F3 Relocate the general confidence clamp into the capture choke point
(yashr-f3g).** The INFERRED clamp lives in the kb-capture tool handler; the
HTTP /api/kb/capture route calls provider.capture() directly and can mint
CONFIRMED. Move/duplicate the clamp into SqliteProvider.capture() (where the
directive gate already lives) so every route is covered. The kb_import path
(F4) gets a controlled exemption -- see D3. Fail-then-pass test at the
provider level.

## Phase P2 -- Import

**F4 kb_import (design D3).** New tool: reads a bible file (explicit path or
<repo>/.fleet/kb-canonical.json via resolveRepoPath) and routes every entry
through provider.capture() so AUDN classifies each: duplicate -> skipped;
refinement -> supersedes; contradiction -> flagged. Trust rules (D3): imported
non-directive entries KEEP their bible confidence (the bible is a trusted,
git-reviewed artifact) via a controlled import path that bypasses the F3 clamp
with source='import' provenance; imported type='user-directive' entries are
FORCED to pending proposals (never active -- same property as cold-seed).
Import is idempotent (re-running on the same bible adds nothing). Report
{imported, skipped, superseded, flagged}. Registered as an MCP tool AND a CLI
subcommand (apra-fleet kb import) for post-merge use.

## Phase P3 -- Reconcile flow

**F5 /pm kb-reconcile (design D4, D5).** The post-merge flow, as a PM skill
command + docs + reconciler agent template:
1. kb_import the merged bible (F4).
2. Freshness sweep: re-hash ALL entries with a stored basis against the merged
   worktree -- un-stale matches (F2), stale mismatches. (A bounded full-KB
   sweep is acceptable here -- this is an explicit command, not per-prime.)
   Needs a provider/tool surface the PM can invoke (design D4 picks it).
3. Hash prefilter on flagged pairs: if exactly one side's basis matches the
   merged files, it wins mechanically -- promote/keep it, supersede the loser,
   clear the flag. No agent needed.
4. Reconciler agent (new tpl-kb-reconciler.md + kb-reconcile.md PM doc) for
   pairs the hashes cannot settle: reads the MERGED code via code intelligence
   (code_context/code_impact/code_query), decides which claim the code
   supports, kb_promote the winner citing evidence, supersede/feedback the
   loser. Trust-tier tiebreak when code is silent: active user-directive always
   survives (flag only); CONFIRMED > INFERRED > UNVERIFIED. Undecidable ->
   leave flagged for /pm kb-review. NEVER delete.
5. kb_export (auto-commits) so the merged branch's bible reflects merged truth.
- PM SKILL.md command table + lifecycle mention; hook documented into the
  /pm cleanup completion flow (post-merge) and as a standalone command.

**F6 E2E proof (design D6).** A test that simulates the two-branch scenario
end-to-end at the provider/tool level: seed KB with branch-A claims, import a
branch-B bible with one duplicate, one refinement, one contradiction; run the
freshness sweep + prefilter logic; assert the duplicate skipped, refinement
superseded, contradiction flagged then resolved by the hash prefilter (or
handed to the agent path); bible export reflects the reconciled state.

## Done criteria (sprint-wide)

- npm run build clean. After F1: npm test with ZERO failures (no allowlist).
- F2/F3 have fail-then-pass tests; F4 idempotency + directive-pending proven;
  F6 e2e green.
- ASCII only. Never push main. NO PR. No mass migration; forward-only.
