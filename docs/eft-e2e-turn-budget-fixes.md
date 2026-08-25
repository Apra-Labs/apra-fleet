# E2E turn-budget fixes (apra-fleet-eft P0 follow-up)

Context: after fixing the s1.1/s1.2 P0 blockers (MCP registration going missing
before the sprint phase, an ungated smoke-test line, `fleet_status` ignoring
`format=json` when empty), a passing s1.1 run still burned 81 of its 80
allotted turns. Analyzing the orchestrator's and alice's real transcripts
(not presumption -- see the run-30180827741 analysis) found three concrete,
fixable turn sinks. This doc records the three fixes, their design, and status.

## Background: what the transcripts showed

- The orchestrator's own first ~9 turns are already-done work being *read*,
  not performed -- `T1`/`T2` (member registration, echo/roundtrip) happen in
  the deterministic `fleet-setup.mjs setup` step, a plain Node script with
  zero LLM involvement, before the orchestrator's Claude session even starts.
- The real orchestrator burn: `execute_prompt` to alice hit a transport drop
  mid-call (right as alice's own session hung on `git push`), triggering
  execute_prompt's own automatic retry-with-fresh-session behavior. That
  spawned a **second full alice session** that had no idea the first one had
  already finished the task -- it re-verified build/lint/test from scratch
  and re-fought the same git-push problem independently. The orchestrator
  *also* independently diagnosed the identical git-push/auth problem via its
  own `execute_command` calls, in parallel with alice's second session doing
  the same thing.
- Both alice and bella hit "no beads database found" on their fresh toy-repo
  clones, each independently running a full `bd init` that pulled the toy
  repo's entire accumulated Dolt history from GitHub's `refs/dolt/data`
  (7,006 chunks) -- twice, once per member, every single run.
- The final straw: after all T3 checkpoints were already satisfied, the
  orchestrator's own script instructions had it "collect session logs"
  (alice/bella's session IDs) as a wrap-up step -- pure diagnostic
  bookkeeping, unrelated to the acceptance criteria, and what actually tipped
  the run from ~78 turns to 81 (`error_max_turns`).

## Fix 1: deterministic toy-repo + beads bootstrap

**Status: implemented** (`.github/e2e/fleet-setup.mjs`, new `T2-toy-bootstrap`
checkpoint in `runSetup()`).

Original plan was "initialize once on alice, replicate to bella via
send_files/receive_files" -- avoiding a second slow `bd init`. That became
unnecessary after a separate, bigger fix: the toy repo's Dolt history itself
was flattened (`bd flatten`, 10 commits -> 1, plus `dolt gc`) and
force-pushed to `refs/dolt/data` on `Apra-Labs/fleet-e2e-toy`. Verified with a
fully fresh clone: `bd init` now completes in ~25s with **no chunk-download
progress at all** (previously 7,006 chunks), and the issue data was diffed
byte-identical before/after the flatten (no data loss).

With `bd init` now cheap, the simpler fix is to just run it independently and
deterministically on **both** members during the existing `fleet-setup.mjs
setup` step (a plain Node script, provider/OS-agnostic via `execute_command`
-- works identically for local members (s1.x) and remote members (s1/s2/etc,
dispatched over SSH), which matters since other suites use remote devices):

1. `cloneAndInitCommand(toyUrl, toyPath, os)` builds an OS-appropriate
   (PowerShell / bash) command that clones the toy repo if not already
   present, then runs `bd init` if the Dolt DB isn't already there (`bd init`
   is **not** idempotent -- it errors "already initialized" on a second run,
   so both steps guard first).
2. `bootstrapToyRepo()` runs that command via `execute_command` against each
   member's registered work folder.
3. A new `T2-toy-bootstrap` checkpoint records the result.

Net effect: the orchestrator's own T3-repo-setup work shrinks to "verify
state already present" (a `bd show`/`git status` check that immediately
succeeds) instead of doing the clone + slow init itself -- no prompt-template
change was needed for that, since the orchestrator's existing instructions
already check state before acting.

## Fix 2: fix git push authentication on the 3 runners

**Status: not yet implemented -- needs a decision.**

Alice's session (and independently, the orchestrator) both hit
`git push` hangs/failures against `origin` on fleet-win11, root-caused live:

- `credential.helper` was configured as `manager` (Windows Git Credential
  Manager, can't prompt headlessly) then `store` (plain-text
  `~/.git-credentials`).
- The PAT `provision_vcs_auth` deploys into `~/.git-credentials` (the
  `e2e_gh_token` credential) was rejected by GitHub even when forced through
  `store` alone: `remote: Invalid username or token. Password authentication
  is not supported for Git operations.` -- the token itself looks bad, not
  just a helper-priority conflict.
- `gh auth setup-git` (delegating git's credential helper to the machine's
  already-authenticated `gh` CLI OAuth session, a completely separate
  identity) fixed it immediately.

This is a real fork in the road, not yet resolved:

- **(a) Standardize on `gh auth setup-git`** as the sole git-auth mechanism
  on all 3 runners (fleet-win11, fleet-lin2404, the Mac box at
  192.168.1.13/fleet-rev), and retire PAT-based `provision_vcs_auth` for
  github mode entirely -- matches what we directly observed working.
- **(b) Keep PAT as the mechanism**, which requires rotating `e2e_gh_token`
  to an actually-valid token (needs a human to generate one -- an agent
  can't create GitHub PATs) and then locking `credential.helper` down to
  `store`-only so GCM never intercepts.

Whichever is chosen, the fix needs to land on all 3 physical runner machines
(not just fleet-win11, where it was diagnosed), since fleet-lin2404 and the
Mac box are equally likely to hit the same class of problem.

## Fix 3: make log collection deterministic, not LLM-driven

**Status: not yet implemented.**

The orchestrator's own sprint-script instructions currently have it fetch
alice/bella's session IDs and transcripts as a wrap-up step, driven by the
LLM. Two independent reasons to move this to a plain script instead:

1. **It's pure mechanical file I/O** -- apra-fleet-client already exposes
   everything needed (`member_detail` for session IDs/work folders,
   `receive_files`/direct filesystem access for local members) with no
   reasoning required. Spending LLM turns on it is waste, and in this run it
   was literally the step that tipped the orchestrator over its turn budget.
2. **Log collection needs to work even when the LLM fails completely** --
   if the sprint-phase session crashes, hits max-turns early, or the
   provider itself errors out, we still want the artifacts for post-mortem
   analysis. Making it deterministic means it runs unconditionally as part
   of an `if: always()` CI step, not contingent on the orchestrator getting
   far enough in its own turn budget to reach that instruction.

Planned implementation: extend the existing "Collect fleet daemon logs"
workflow step (already `if: always()`, and runs *before* T6 teardown removes
alice/bella, so they're still reachable) to also pull each member's most
recent Claude Code session transcript file into the run's artifact directory,
scoped to the `claude` provider for now (matching the suites currently
exercising this P0 investigation; agy/opencode store sessions
differently and would need separate handling if/when that's needed).
